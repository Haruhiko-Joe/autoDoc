# ToolEvents — 工具生命周期事件发射

## 概述与职责

ToolEvents 模块是 Core > ToolsOrchestration 层的事件发射中心，负责在工具调用的各个生命周期阶段向会话事件流（session event stream）发送结构化事件。它是连接"工具执行"与"外部观察者（TUI、AppServer、IDE 插件等）"的桥梁——当一个 shell 命令开始执行、一个 patch 被应用、或者一个 turn 中的文件变更需要汇总时，都由这个模块负责构造并发射对应的 `EventMsg`。

本模块同时包含一个辅助文件 `web_search.rs`，提供 Web 搜索动作的展示信息提取工具函数。

**在架构中的位置**：位于 Core > ToolsOrchestration 子系统内，被 shell 执行器、apply-patch 处理器、unified-exec 处理器等工具 handler 调用。它依赖 `codex_protocol` 中定义的事件类型（`EventMsg`、`ExecCommandBeginEvent` 等），并通过 `Session::send_event()` 将事件推入会话的事件流。

**同级模块**包括工具路由器（router）、并行执行器（parallel）、各种 handler（shell、apply_patch 等）、以及工具上下文（context）。

## 关键流程

### Shell/UnifiedExec 命令事件流

1. 工具 handler 创建 `ToolEmitter::Shell` 或 `ToolEmitter::UnifiedExec` 实例，携带命令、工作目录、来源等信息
2. 调用 `emitter.begin(ctx)` 发射 `ExecCommandBegin` 事件，包含 `call_id`、`turn_id`、完整命令、cwd、解析后的命令结构
3. 命令执行完成后，调用 `emitter.finish(ctx, result)` 处理执行结果：
   - **成功**（exit_code == 0）：格式化输出并发射 `ExecCommandEnd`（status = `Completed`），返回 `Ok(content)`
   - **非零退出码**：发射 `ExecCommandEnd`（status = `Failed`），返回 `Err(RespondToModel(content))`
   - **沙箱超时/拒绝**：从 `ToolError` 中提取输出，发射失败事件
   - **执行错误**：构造错误消息，以空 stdout 和 exit_code = -1 发射
   - **用户拒绝**：规范化拒绝消息（如 `"exec command rejected by user"`），发射 `Declined` 状态事件

> 核心分发逻辑见 `emit_exec_stage()`（`codex-rs/core/src/tools/events.rs:405-467`），它根据 `ToolEventStage` 枚举值分支到 begin 或各种 end 路径。

### ApplyPatch 事件流

1. 工具 handler 创建 `ToolEmitter::ApplyPatch` 实例，携带文件变更映射 (`HashMap<PathBuf, FileChange>`) 和是否自动审批的标记
2. **Begin 阶段**（`events.rs:183-200`）：
   - 如果存在 `turn_diff_tracker`，先调用 `tracker.on_patch_begin(changes)` 对变更文件做基线快照
   - 发射 `PatchApplyBegin` 事件
3. **End 阶段**（`events.rs:201-261`）：
   - 根据成功/失败/拒绝，映射到对应的 `PatchApplyStatus`（`Completed` / `Failed` / `Declined`）
   - 调用 `emit_patch_end()` 发射 `PatchApplyEnd` 事件
4. **TurnDiff 发射**（`events.rs:521-531`）：patch 结束后，如果存在 diff tracker，计算累积的 unified diff 并发射 `TurnDiff` 事件——这使得 UI 层可以展示一个 turn 内所有文件变更的汇总视图

### 用户拒绝消息规范化

`finish()` 方法中对 `ToolError::Rejected` 进行了统一的消息规范化（`events.rs:346-355`）：
- Shell / UnifiedExec → `"exec command rejected by user"`
- ApplyPatch → `"patch rejected by user"`

这保证了测试和用户界面看到一致的拒绝消息。代码中的 TODO 注释指出，当前 `ToolError::Rejected` 同时用于用户主动拒绝和某些运行时拒绝场景，未来应该拆分为不同的错误变体。

## 函数签名与核心类型

### `ToolEventCtx<'a>`

```rust
pub(crate) struct ToolEventCtx<'a> {
    pub session: &'a Session,
    pub turn: &'a TurnContext,
    pub call_id: &'a str,
    pub turn_diff_tracker: Option<&'a SharedTurnDiffTracker>,
}
```

将一次工具调用绑定到具体的会话、turn 和 call_id 上下文。所有事件发射函数都以此作为第一个参数。`turn_diff_tracker` 为可选——并非所有工具调用都需要跟踪文件变更（如只读命令）。

> 源码位置：`codex-rs/core/src/tools/events.rs:28-50`

### `ToolEmitter` 枚举

```rust
pub(crate) enum ToolEmitter {
    Shell { command, cwd, source, parsed_cmd, freeform },
    ApplyPatch { changes, auto_approved },
    UnifiedExec { command, cwd, source, parsed_cmd, process_id },
}
```

具体的、无分配开销（allocation-free）的事件发射器。每个变体对应一种工具类型，避免使用 trait 对象和 boxed futures。

**工厂方法**：
- `ToolEmitter::shell(command, cwd, source, freeform)` — 自动调用 `parse_command()` 解析命令
- `ToolEmitter::apply_patch(changes, auto_approved)` — 用于 patch 操作
- `ToolEmitter::unified_exec(command, cwd, source, process_id)` — 用于 unified exec 工具

**核心方法**：

| 方法 | 说明 |
|------|------|
| `begin(&self, ctx)` | 发射 Begin 事件 |
| `finish(&self, ctx, Result<ExecToolCallOutput, ToolError>)` → `Result<String, FunctionCallError>` | 处理执行结果，发射 End 事件，返回格式化后的模型可读输出或错误 |
| `emit(&self, ctx, ToolEventStage)` | 底层分发，`begin` 和 `finish` 都委托给它 |

> 源码位置：`codex-rs/core/src/tools/events.rs:90-363`

### `ToolEventStage` / `ToolEventFailure`

```rust
pub(crate) enum ToolEventStage {
    Begin,
    Success(ExecToolCallOutput),
    Failure(ToolEventFailure),
}

pub(crate) enum ToolEventFailure {
    Output(ExecToolCallOutput),   // 超时/拒绝但有输出
    Message(String),              // 纯错误消息
    Rejected(String),             // 用户/策略拒绝
}
```

> 源码位置：`codex-rs/core/src/tools/events.rs:52-62`

### `emit_exec_command_begin()`

```rust
pub(crate) async fn emit_exec_command_begin(
    ctx: ToolEventCtx<'_>,
    command: &[String],
    cwd: &Path,
    parsed_cmd: &[ParsedCommand],
    source: ExecCommandSource,
    interaction_input: Option<String>,
    process_id: Option<&str>,
)
```

独立的 Begin 事件发射函数，直接构造 `ExecCommandBeginEvent` 并通过 `session.send_event()` 发送。主要供 `ToolEmitter` 内部以及需要手动发射 begin 事件的场景使用。

> 源码位置：`codex-rs/core/src/tools/events.rs:64-88`

## SharedTurnDiffTracker 与 TurnDiff 机制

`SharedTurnDiffTracker` 是 `Arc<Mutex<TurnDiffTracker>>` 的类型别名（定义于 `codex-rs/core/src/tools/context.rs:27`），在一个 turn 的多次工具调用之间共享，用于跨调用累积跟踪文件变更。

工作机制：
1. 每次 `ApplyPatch` 的 Begin 阶段，调用 `tracker.on_patch_begin(changes)` 为尚未追踪的文件创建内存基线快照（读取当前磁盘内容和 git blob OID）
2. 每次 `ApplyPatch` 的 End 阶段，调用 `tracker.get_unified_diff()` 对比基线与当前磁盘状态，使用 `similar` crate 生成聚合的 unified diff
3. 如果 diff 非空，发射 `TurnDiff` 事件，包含整个 turn 到目前为止的累积 diff

这使得 UI 层可以在每次 patch 应用后立即展示最新的整体变更视图，而不仅仅是单次 patch 的变更。

> TurnDiffTracker 实现详见 `codex-rs/core/src/turn_diff_tracker.rs`

## Web 搜索辅助函数

`web_search.rs` 提供了从 `WebSearchAction` 枚举提取展示信息的工具函数：

### `web_search_action_detail(action: &WebSearchAction) -> String`

根据搜索动作类型返回人类可读的描述：
- `Search` → 返回 query 或第一个 queries 项（多项时追加 `...`）
- `OpenPage` → 返回 URL
- `FindInPage` → 返回 `'pattern' in url` 格式
- `Other` → 空字符串

### `web_search_detail(action: Option<&WebSearchAction>, query: &str) -> String`

高层包装：优先使用 action 的 detail，若为空则回退到 `query` 参数。

> 源码位置：`codex-rs/core/src/web_search.rs:1-39`

## 输出格式化

`ToolEmitter` 的 `format_exec_output_for_model()` 方法（`events.rs:293-304`）根据工具类型选择不同的格式化策略：
- `Shell { freeform: true }` 使用 `format_exec_output_for_model_freeform()`——适用于自由格式命令
- 其他所有变体使用 `format_exec_output_for_model_structured()`——结构化输出

两者都接受 `truncation_policy` 参数控制输出截断行为，确保返回给模型的文本不超过上下文窗口限制。

## 边界 Case 与注意事项

- **exit_code 语义**：`finish()` 以 exit_code == 0 判断成功。非零退出码的命令输出仍然会格式化并返回给模型（作为 `FunctionCallError::RespondToModel`），模型可以据此决定下一步
- **exit_code = -1**：用于表示根本没有执行的情况（错误消息、用户拒绝），duration 为 `Duration::ZERO`
- **`ToolError::Rejected` 的双重语义**：当前既用于用户拒绝审批，也用于某些运行时拒绝（如 setup 失败），导致部分非用户拒绝的失败也被标记为 `Declined`。代码中有 TODO 标记此问题
- **TurnDiff 仅在 ApplyPatch 后发射**：Shell 和 UnifiedExec 的 end 路径不触发 TurnDiff，因为它们的文件变更无法被 tracker 预先捕获基线
- **`turn_diff_tracker` 为 `None` 时的行为**：ApplyPatch Begin 阶段跳过基线快照，End 阶段跳过 diff 计算和 TurnDiff 发射，不影响其他事件的正常发射