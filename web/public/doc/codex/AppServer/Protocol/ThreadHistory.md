# ThreadHistory — 线程历史重建

## 概述与职责

`thread_history` 模块是 **AppServer → Protocol** 层的核心组件，负责将持久化的 rollout 事件序列（`RolloutItem` / `EventMsg`）重建为 v2 协议数据模型中的 `Vec<Turn>`（每个 `Turn` 包含一组 `ThreadItem`）。

在整体架构中，AppServer 作为 IDE 扩展和桌面应用的本地服务，需要在会话恢复（resume/rejoin）时将磁盘上保存的事件流还原为客户端可直接渲染的线程结构。`thread_history` 正是完成这个"事件流 → 结构化对话历史"转换的模块。它与同属 Protocol 层的 v2 类型定义紧密配合，被 RequestProcessing 和 ClientLib 等上层模块调用。

> 源码位置：`codex-rs/app-server-protocol/src/protocol/thread_history.rs`

## 关键流程

### 整体重建流程

1. 调用方通过 `build_turns_from_rollout_items(items)` 传入持久化的 `RolloutItem` 数组
2. 内部创建 `ThreadHistoryBuilder`，逐条调用 `handle_rollout_item()` 处理每个条目
3. `handle_rollout_item()` 根据条目类型分发：
   - `RolloutItem::EventMsg` → 委托给 `handle_event()` 进行事件级分发
   - `RolloutItem::Compacted` → 标记当前 turn 包含压缩标记
   - `RolloutItem::ResponseItem` → 提取 hook prompt 消息（仅处理 `role="user"` 的条目）
   - `RolloutItem::TurnContext` / `RolloutItem::SessionMeta` → 忽略
4. 处理完毕后调用 `finish()` 关闭最后一个活跃 turn，返回完整的 `Vec<Turn>`

> 源码位置：`thread_history.rs:65-71`（`build_turns_from_rollout_items`）

### Turn 生命周期管理

Turn 的创建和关闭是整个状态机的核心：

1. **显式开启**：收到 `TurnStarted` 事件时，先关闭当前 turn，再创建一个新的 `PendingTurn`，标记为 `opened_explicitly = true`，状态设为 `InProgress`（`thread_history.rs:913-920`）
2. **隐式开启**：当需要添加 item 但没有活跃 turn 时，`ensure_turn()` 会自动创建一个隐式 turn（`thread_history.rs:1000-1011`）
3. **显式关闭**：收到 `TurnComplete` 事件时，优先按 `turn_id` 匹配活跃 turn 或已完成 turn，将状态标记为 `Completed`（`thread_history.rs:922-954`）
4. **丢弃空 turn**：`finish_current_turn()` 会丢弃既未显式开启、又无 item、也无压缩标记的空 turn（`thread_history.rs:979-986`）

### 用户消息处理与 Turn 边界

当收到 `UserMessage` 事件时，模块会检查当前 turn 是否为隐式开启的。如果是，且 turn 已有内容（非空且非仅含压缩标记），则先关闭当前 turn 再开启新 turn。这保证了向后兼容——老版本事件流没有显式 turn 边界时，用户消息自然成为 turn 分界线（`thread_history.rs:238-256`）。

### 事件分发机制（handle_event）

`handle_event()` 是核心的事件路由器，通过 match 将约 30 种 `EventMsg` 变体映射到对应的处理方法（`thread_history.rs:136-199`）。处理的事件类别包括：

| 事件类别 | 代表事件 | 对应 ThreadItem |
|---------|---------|----------------|
| 用户输入 | `UserMessage` | `ThreadItem::UserMessage` |
| Agent 回复 | `AgentMessage` | `ThreadItem::AgentMessage` |
| 推理过程 | `AgentReasoning`, `AgentReasoningRawContent` | `ThreadItem::Reasoning` |
| 命令执行 | `ExecCommandBegin/End` | `ThreadItem::CommandExecution` |
| 文件变更 | `PatchApplyBegin/End`, `ApplyPatchApprovalRequest` | `ThreadItem::FileChange` |
| MCP 工具调用 | `McpToolCallBegin/End` | `ThreadItem::McpToolCall` |
| 动态工具调用 | `DynamicToolCallRequest/Response` | `ThreadItem::DynamicToolCall` |
| Web 搜索 | `WebSearchBegin/End` | `ThreadItem::WebSearch` |
| 图像操作 | `ViewImageToolCall`, `ImageGenerationBegin/End` | `ThreadItem::ImageView`, `ThreadItem::ImageGeneration` |
| 协作 Agent | `CollabAgent*Begin/End` 系列（6 对） | `ThreadItem::CollabAgentToolCall` |
| 上下文压缩 | `ContextCompacted` | `ThreadItem::ContextCompaction` |
| Review 模式 | `EnteredReviewMode`, `ExitedReviewMode` | `ThreadItem::EnteredReviewMode`, `ThreadItem::ExitedReviewMode` |
| Turn 控制 | `TurnStarted`, `TurnComplete`, `TurnAborted` | 修改 turn 状态，不产生 item |
| 线程回滚 | `ThreadRolledBack` | 截断已有 turns |
| 错误 | `Error` | 设置 turn 的 `Failed` 状态和错误信息 |
| 忽略的事件 | `HookStarted/Completed`, `TokenCount`, `UndoCompleted` | 无操作 |

### Item 的 Upsert 策略

工具调用类事件采用 Begin/End 配对模式。Begin 事件创建一个 `InProgress` 状态的 item，End 事件通过 `upsert_turn_item()` 按 `item.id()` 匹配并**覆盖更新**已有 item（`thread_history.rs:1138-1147`）。这保证了一个工具调用在 UI 中始终只有一个条目，从"进行中"平滑过渡到"已完成/失败"。

路由上有两种策略：
- `upsert_item_in_turn_id(turn_id, item)`：优先按 `turn_id` 精确匹配活跃 turn 或已完成 turn，找不到时打印警告并丢弃（`thread_history.rs:1013-1030`）。命令执行等可能跨 turn 到达的事件使用此方式。
- `upsert_item_in_current_turn(item)`：始终插入到当前活跃 turn（`thread_history.rs:1032-1035`）。MCP 工具调用等使用此方式。

## 函数签名

### `build_turns_from_rollout_items(items: &[RolloutItem]) -> Vec<Turn>`

模块的主入口函数。接收持久化的 rollout 条目数组，返回重建的 turn 列表。内部创建 `ThreadHistoryBuilder`，逐条处理后调用 `finish()`。

> 源码位置：`thread_history.rs:65-71`

### `ThreadHistoryBuilder::new() -> Self`

创建一个新的构建器实例。初始状态：无活跃 turn，item 索引从 1 开始，rollout 索引从 0 开始。

### `ThreadHistoryBuilder::handle_event(&mut self, event: &EventMsg)`

共享的事件处理入口，同时用于持久化 rollout 回放和运行中线程的实时状态跟踪。处理所有可被持久化的 `EventMsg` 变体。

> 源码位置：`thread_history.rs:136-199`

### `ThreadHistoryBuilder::handle_rollout_item(&mut self, item: &RolloutItem)`

处理单个 rollout 条目，维护 rollout 索引计数，然后根据条目类型分发到 `handle_event()`、`handle_compacted()` 或 `handle_response_item()`。

> 源码位置：`thread_history.rs:201-210`

### `ThreadHistoryBuilder::finish(self) -> Vec<Turn>`

消费构建器，关闭最后一个活跃 turn 并返回全部 turn。

### `ThreadHistoryBuilder::active_turn_snapshot(&self) -> Option<Turn>`

返回当前活跃 turn 的快照（克隆），若无活跃 turn 则返回最近一个已完成的 turn。用于实时 UI 更新。

### `ThreadHistoryBuilder::active_turn_id_if_explicit(&self) -> Option<String>`

仅当活跃 turn 是显式开启的（来自 `TurnStarted` 事件）时返回其 ID。

### `ThreadHistoryBuilder::reset(&mut self)`

将构建器重置为初始状态，等价于 `*self = Self::new()`。

## 类型定义

### `PendingTurn`（内部类型）

构建过程中的临时 turn 表示，包含额外的构建器状态字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `String` | Turn ID，显式开启时取事件的 `turn_id`，否则生成 UUIDv7 |
| `items` | `Vec<ThreadItem>` | 该 turn 中的所有条目 |
| `error` | `Option<TurnError>` | 错误信息（Error 事件触发） |
| `status` | `TurnStatus` | 当前状态：`InProgress` / `Completed` / `Failed` / `Interrupted` |
| `opened_explicitly` | `bool` | 是否由 `TurnStarted` 事件显式开启 |
| `saw_compaction` | `bool` | 是否包含 `RolloutItem::Compacted` 标记 |
| `rollout_start_index` | `usize` | 该 turn 在 rollout 事件流中的起始索引 |

`PendingTurn` 实现了 `Into<Turn>` 和 `From<&PendingTurn> for Turn`，转换时丢弃构建器专用字段。

> 源码位置：`thread_history.rs:1149-1196`

## 辅助函数

### `convert_patch_changes(changes) -> Vec<FileUpdateChange>`

将核心协议的 `HashMap<PathBuf, FileChange>` 转为按路径排序的 `Vec<FileUpdateChange>`，每个条目包含路径、变更类型（Add/Delete/Update）和 diff 文本。

> 源码位置：`thread_history.rs:1079-1092`

### `upsert_turn_item(items, item)`

在 item 列表中按 ID 查找已有条目并覆盖，找不到则追加。是 Begin/End 配对模式的基础。

> 源码位置：`thread_history.rs:1138-1147`

### `render_review_output_text(output) -> String`

提取 `ReviewOutputEvent` 中的 `overall_explanation` 文本，为空时返回 fallback 消息 `"Reviewer failed to output a response."`。

> 源码位置：`thread_history.rs:1070-1077`

## 边界 Case 与注意事项

- **命令完成事件的乱序到达**：`ExecCommandEnd` 可能在新的用户 turn 已经开始后才到达（例如统一执行的 PTY 后台退出监听器延迟上报），因此使用 `upsert_item_in_turn_id()` 按事件携带的 `turn_id` 路由到原始 turn，而非盲目写入当前 turn（`thread_history.rs:429-434`）。

- **向后兼容旧事件流**：老版本的事件流不包含显式 `TurnStarted`/`TurnComplete` 边界。此时用户消息到达会触发隐式 turn 切换——如果当前 turn 是隐式创建且已有内容，则先关闭再开新 turn（`thread_history.rs:242-247`）。

- **推理事件的合并**：连续的 `AgentReasoning` 或 `AgentReasoningRawContent` 事件不会创建新的 `ThreadItem::Reasoning`，而是将文本追加到最后一个推理 item 的 `summary` 或 `content` 数组中（`thread_history.rs:277-315`）。

- **空 turn 的清理**：`finish_current_turn()` 会丢弃没有任何 item 且既非显式开启、也无压缩标记的 turn，避免产生空的 UI 气泡（`thread_history.rs:979-986`）。

- **线程回滚**：`ThreadRolledBack` 事件会截断已有 turn 列表并重置 item 索引计数器，确保后续添加的 item ID 不会与被回滚的 item 冲突（`thread_history.rs:965-977`）。

- **Turn 中断的 ID 匹配**：`TurnAborted` 事件优先按 `turn_id` 精确匹配活跃 turn 或已完成 turn，找不到时才回退到修改当前活跃 turn 的状态。这防止了中断信号误伤错误的 turn（`thread_history.rs:893-911`）。

- **空消息过滤**：空文本的 `AgentMessage`、空文本的推理事件、以及不影响 turn 状态的 `Error` 事件都会被静默忽略，不产生 ThreadItem。

- **协作 Agent 状态机**：6 对 Collab 事件（Spawn/Interaction/Waiting/Close/Resume 的 Begin/End）全部映射到同一种 `ThreadItem::CollabAgentToolCall`，通过 `CollabAgentTool` 枚举（`SpawnAgent`/`SendInput`/`Wait`/`CloseAgent`/`ResumeAgent`）区分操作类型，通过 `agents_states: HashMap<String, CollabAgentState>` 追踪每个子 Agent 的状态。