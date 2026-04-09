# StreamingPipeline — 流式转录管道

## 概述与职责

StreamingPipeline 是 TUI 内容渲染层（ContentRendering）的核心子模块，负责将 LLM 返回的原始文本增量（delta）转化为最终显示在终端中的渲染行。它位于模型提供商的流式输出与 ChatSurface 的聊天记录视图之间，解决了"流式文本到逐行渲染"这一关键问题。

在整体架构中，TUI 通过 Core 向 LLM 发送请求并接收流式事件。StreamingPipeline 接收这些事件中的文本 delta，经过 Markdown 解析、换行门控、队列缓冲和自适应分块策略，最终输出 `HistoryCell` 对象供 ChatSurface 插入聊天记录。同级模块包括 Markdown 解析器、Diff 渲染器、HistoryCell 数据模型等。

模块由四个核心组件协作完成：

| 组件 | 文件 | 职责 |
|------|------|------|
| `MarkdownStreamCollector` | `markdown_stream.rs` | 累积文本 delta，换行门控，输出已完成的渲染行 |
| `StreamState` | `streaming/mod.rs` | 持有 FIFO 队列，管理已提交行的入队、出队和时间戳 |
| `StreamController` / `PlanStreamController` | `streaming/controller.rs` | 驱动 collector，将出队行转为 `HistoryCell` 发射 |
| `AdaptiveChunkingPolicy` | `streaming/chunking.rs` | 两档自适应策略（Smooth/CatchUp），平衡显示节奏与队列积压 |
| `CommitTick` | `streaming/commit_tick.rs` | 每 tick 编排：采集快照、决策分块、执行 drain |

## 关键流程

### 端到端数据流

```
LLM delta → push_delta() → MarkdownStreamCollector (缓冲区)
                                    │
                            遇到 '\n' 时触发
                                    ↓
                          commit_complete_lines()
                                    │
                            新完成行入队到
                                    ↓
                          StreamState (FIFO 队列)
                                    │
                          每个 commit tick 触发
                                    ↓
                          AdaptiveChunkingPolicy.decide()
                                    │
                            DrainPlan::Single 或 Batch
                                    ↓
                          StreamController 出队并包装为
                                    ↓
                            HistoryCell → 插入聊天记录
```

### 1. 换行门控收集（MarkdownStreamCollector）

LLM 的流式输出是不规则的文本碎片。`MarkdownStreamCollector` 将这些碎片累积到内部 `buffer` 中，并仅在检测到换行符时才提交已完成的行。

核心流程：

1. `push_delta(delta)` 将文本追加到 `buffer`（`markdown_stream.rs:37-39`）
2. 调用方检测到 delta 中包含 `'\n'` 时，调用 `commit_complete_lines()`
3. `commit_complete_lines()` 找到 buffer 中最后一个换行符的位置，截取到该位置的文本交给 `markdown::append_markdown()` 渲染为 `Line<'static>`（`markdown_stream.rs:45-73`）
4. 通过 `committed_line_count` 差分追踪，仅返回**自上次提交以来新增**的行
5. 如果 buffer 末尾没有换行符（即最后一行不完整），该行不会被发射——这就是"换行门控"

**流结束处理**：`finalize_and_drain()` 在流结束时被调用，对于末尾没有换行的不完整行，会临时追加一个换行符以确保渲染，然后输出所有剩余行并重置状态（`markdown_stream.rs:79-106`）。

> 关键设计决策：尾部空行过滤。如果渲染后的最后一行是纯空格空行，`commit_complete_lines()` 会跳过它（`markdown_stream.rs:56-62`），避免 Markdown 段落间距在流式过程中引入多余空行。

### 2. FIFO 队列管理（StreamState）

`StreamState` 是连接 collector 和 controller 的中间缓冲层，维护一个 `VecDeque<QueuedLine>` 队列。

```rust
struct QueuedLine {
    line: Line<'static>,
    enqueued_at: Instant,  // 入队时间戳，供策略判断队列年龄
}
```

关键操作（`streaming/mod.rs:36-103`）：

- `enqueue(lines)`: 批量入队，所有行共享同一时间戳
- `step()`: 从队头弹出一行（Smooth 模式使用）
- `drain_n(max_lines)`: 从队头弹出最多 N 行（CatchUp 模式使用），自动 clamp 到实际长度
- `drain_all()`: 一次性清空（finalize 时使用）
- `oldest_queued_age(now)`: 返回队头元素的等待时长，用于策略决策
- `is_idle()`: 队列是否为空

### 3. 控制器驱动（StreamController / PlanStreamController）

两个控制器共享相同的架构模式，但输出不同类型的 `HistoryCell`：

**`StreamController`**（消息流）：
- `push(delta)`: 将 delta 推入内部 `StreamState` 的 collector，检测换行后提交完成行到队列（`controller.rs:35-49`）
- `on_commit_tick()`: 出队一行，包装为 `AgentMessageCell`（`controller.rs:76-79`）
- `on_commit_tick_batch(max_lines)`: 出队多行，用于 CatchUp 模式（`controller.rs:85-91`）
- `finalize()`: 调用 collector 的 `finalize_and_drain()`，一次性输出所有剩余内容（`controller.rs:52-73`）
- `emit()` 内部方法：首次发射时标记 `header_emitted = true`，第一个 cell 携带 header 标志（`controller.rs:103-112`）

**`PlanStreamController`**（计划流）：
- 结构与 `StreamController` 类似，额外管理 `top_padding_emitted` 状态
- `emit()` 方法在首次发射时插入 "• Proposed Plan" 标题行，并对内容行应用 `proposed_plan_style()` 样式和 `"  "` 缩进前缀（`controller.rs:207-245`）
- finalize 时额外插入底部 padding 行

### 4. 自适应分块策略（AdaptiveChunkingPolicy）

这是一个两档（gear）系统，通过迟滞（hysteresis）机制在平滑显示和追赶积压之间切换（`streaming/chunking.rs`）。

**两种模式**：

| 模式 | 行为 | 触发条件 |
|------|------|----------|
| `Smooth`（默认） | 每 tick 出队 1 行（`DrainPlan::Single`） | 初始状态 / 队列压力降低后 |
| `CatchUp` | 每 tick 出队全部积压（`DrainPlan::Batch(N)`） | 队列深度或年龄超过阈值 |

**阈值常量**（`chunking.rs:85-116`）：

| 常量 | 值 | 用途 |
|------|------|------|
| `ENTER_QUEUE_DEPTH_LINES` | 8 | 进入 CatchUp 的队列深度阈值 |
| `ENTER_OLDEST_AGE` | 120ms | 进入 CatchUp 的队列年龄阈值 |
| `EXIT_QUEUE_DEPTH_LINES` | 2 | 退出 CatchUp 的队列深度阈值 |
| `EXIT_OLDEST_AGE` | 40ms | 退出 CatchUp 的队列年龄阈值 |
| `EXIT_HOLD` | 250ms | 退出 CatchUp 前需保持低压力的持续时间 |
| `REENTER_CATCH_UP_HOLD` | 250ms | 退出 CatchUp 后抑制立即重入的冷却期 |
| `SEVERE_QUEUE_DEPTH_LINES` | 64 | 严重积压的队列深度（可绕过重入冷却） |
| `SEVERE_OLDEST_AGE` | 300ms | 严重积压的队列年龄（可绕过重入冷却） |

**决策流程**（`decide()` 方法，`chunking.rs:180-209`）：

1. 若队列为空 → 重置为 Smooth，记录 CatchUp 退出时间
2. 若当前 Smooth → 检查是否应进入 CatchUp（`maybe_enter_catch_up`）
3. 若当前 CatchUp → 检查是否应退出 CatchUp（`maybe_exit_catch_up`）
4. 根据最终模式构建 `DrainPlan`

**迟滞防抖机制**：
- **进入 CatchUp**：队列深度 ≥ 8 **或** 最老行年龄 ≥ 120ms 即触发。但如果刚退出 CatchUp（冷却期内），需要严重积压才能重入（`chunking.rs:216-227`）
- **退出 CatchUp**：队列深度 ≤ 2 **且** 最老行年龄 ≤ 40ms，并需**持续 250ms** 才真正退出（`chunking.rs:233-249`）
- 这种不对称设计避免了在阈值边界附近的快速振荡（gear-flapping）

### 5. CommitTick 编排（run_commit_tick）

`run_commit_tick()` 是每 tick 的入口函数，串联所有组件（`commit_tick.rs:69-91`）：

1. **采集快照**：`stream_queue_snapshot()` 汇总两个控制器的队列深度（求和）和最老行年龄（取最大值）（`commit_tick.rs:97-118`）
2. **策略决策**：`resolve_chunking_plan()` 调用 `AdaptiveChunkingPolicy::decide()`，并在模式切换时输出 trace 日志（`commit_tick.rs:124-142`）
3. **作用域过滤**：如果 `scope` 是 `CatchUpOnly` 但当前不在 CatchUp 模式，跳过本次 tick
4. **执行 drain**：`apply_commit_tick_plan()` 根据 `DrainPlan` 对两个控制器分别执行 `on_commit_tick()` 或 `on_commit_tick_batch()`（`commit_tick.rs:148-173`）
5. **返回结果**：`CommitTickOutput` 包含产生的 `HistoryCell` 列表、是否存在控制器、是否所有控制器已空闲

`CommitTickScope` 枚举允许调用方区分两类 tick：
- `AnyMode`：始终执行（基线 tick）
- `CatchUpOnly`：仅在 CatchUp 模式下执行（用于在基线 tick 间隙加速 drain）

## 接口/类型定义

### MarkdownStreamCollector

```rust
pub(crate) struct MarkdownStreamCollector {
    buffer: String,              // 累积的原始文本
    committed_line_count: usize, // 已提交行数（差分追踪游标）
    width: Option<usize>,        // 渲染宽度限制
    cwd: PathBuf,                // 文件链接的基准路径
}
```

### StreamState

```rust
pub(crate) struct StreamState {
    pub(crate) collector: MarkdownStreamCollector,
    queued_lines: VecDeque<QueuedLine>,  // FIFO 队列
    pub(crate) has_seen_delta: bool,     // 是否收到过非空 delta
}
```

### ChunkingDecision

```rust
pub(crate) struct ChunkingDecision {
    pub(crate) mode: ChunkingMode,          // 决策后的模式
    pub(crate) entered_catch_up: bool,      // 本次是否刚进入 CatchUp
    pub(crate) drain_plan: DrainPlan,       // Single 或 Batch(N)
}
```

### CommitTickOutput

```rust
pub(crate) struct CommitTickOutput {
    pub(crate) cells: Vec<Box<dyn HistoryCell>>,  // 产生的历史单元格
    pub(crate) has_controller: bool,               // 是否有控制器参与
    pub(crate) all_idle: bool,                     // 所有控制器是否空闲
}
```

## 配置项与默认值

所有策略参数目前以常量形式硬编码在 `streaming/chunking.rs` 中，无外部配置。源码中的注释提供了详细的调优指南（`chunking.rs:46-60`）：

- **延迟感知过晚**：降低进入阈值（`ENTER_QUEUE_DEPTH_LINES` / `ENTER_OLDEST_AGE`）
- **Smooth/CatchUp 频繁切换**：增大迟滞窗口（`EXIT_HOLD` / `REENTER_CATCH_UP_HOLD`）
- **CatchUp 退出后过快重入**：增大 `REENTER_CATCH_UP_HOLD`

## 边界 Case 与注意事项

- **空 delta 处理**：空字符串 delta 不会触发 `has_seen_delta` 标记，也不会触发换行检测（`controller.rs:37-39`）
- **不完整行保护**：未以换行结尾的 buffer 在 `commit_complete_lines()` 中返回空 Vec，避免提交渲染不稳定的中间状态
- **尾部空行过滤**：渲染输出的最后一行如果是纯空格行会被跳过，防止 Markdown 段落分隔符引起显示跳动（`markdown_stream.rs:56-62`）
- **CWD 快照**：`MarkdownStreamCollector` 在构造时快照 `cwd` 路径，整个流生命周期内不应变更，否则文件链接渲染前缀可能不一致（`markdown_stream.rs:17-22`）
- **严重积压绕过冷却**：当队列深度 ≥ 64 或最老行 ≥ 300ms 时，即使在重入冷却期内也允许进入 CatchUp，避免无界队列增长（`chunking.rs:289-294`）
- **Batch drain clamp**：`drain_n()` 自动 clamp 到实际队列长度，传入极大值不会 panic（`streaming/mod.rs:66-72`）
- **scope 为 CatchUpOnly 时的快速返回**：如果策略未进入 CatchUp，`run_commit_tick` 直接返回默认空输出，不执行任何 drain（`commit_tick.rs:82-84`）