# HookRuntime — 生命周期钩子执行运行时

## 概述与职责

HookRuntime 是 Codex 核心引擎中的**生命周期钩子执行运行时**，负责在会话的关键时刻（session 启动、用户提交 prompt、工具调用前后）协调执行用户配置的钩子脚本。它位于 **Core > CoreConfig** 层级中，是配置与策略执行子系统的一部分。

在整体架构中，Core 是 Codex 的代理编排引擎，CoreConfig 负责配置加载与策略执行。HookRuntime 作为 CoreConfig 的组成部分，将用户通过配置文件注册的钩子与 SessionEngine 的运行流程桥接起来——SessionEngine 在适当时机调用 HookRuntime 的公开函数，HookRuntime 委托底层 `codex_hooks` crate 实际执行钩子脚本，然后将执行结果转化为会话层面的决策（停止会话、注入上下文、阻止工具调用等）。

同级模块包括 Protocol（类型定义）、SessionEngine（主编排循环）、ToolsOrchestration（工具调度）等。

**源码位置**：`codex-rs/core/src/hook_runtime.rs`

## 关键流程

### 四种钩子生命周期

HookRuntime 支持四类钩子，对应会话中的四个关键时刻：

1. **Session Start** — 会话启动时触发
2. **User Prompt Submit** — 用户提交 prompt 时触发
3. **Pre Tool Use** — 工具调用执行前触发
4. **Post Tool Use** — 工具调用执行后触发

每种钩子遵循相同的执行模式：**构建请求 → 预览（preview）并发出 HookStarted 事件 → 执行钩子 → 发出 HookCompleted 事件 → 处理结果**。

### 通用执行流程（以 Session Start 为例）

1. 检查是否有待处理的 session start 来源，没有则直接返回（`codex-rs/core/src/hook_runtime.rs:93-95`）
2. 构建 `SessionStartRequest`，包含 session_id、cwd、transcript_path、model、permission_mode、source 等上下文信息（`codex-rs/core/src/hook_runtime.rs:97-104`）
3. 调用 `sess.hooks().preview_session_start()` 获取预计要执行的钩子列表
4. 通过 `run_context_injecting_hook()` 泛型辅助函数：
   - 发出 `HookStarted` 事件（UI 可以展示"钩子正在运行"）
   - 等待钩子实际执行完成
   - 发出 `HookCompleted` 事件
   - 返回 `HookRuntimeOutcome`（包含 `should_stop` 和 `additional_contexts`）
5. 如果钩子产生了额外上下文，将其作为 `DeveloperInstructions` 消息注入到会话历史中

### Pre Tool Use 钩子流程

与通用流程略有不同——Pre Tool Use 钩子可以**阻止（block）**工具调用的执行：

1. 构建 `PreToolUseRequest`，tool_name 固定为 `"Bash"`（`codex-rs/core/src/hook_runtime.rs:124-134`）
2. 发出 HookStarted 事件
3. 执行钩子，获取 `PreToolUseOutcome`
4. 发出 HookCompleted 事件
5. 如果 `should_block` 为 true，返回 `block_reason`（`Option<String>`），调用方据此取消工具执行

### Post Tool Use 钩子流程

Post Tool Use 钩子在工具执行完成后运行，可以获取到工具的实际响应（`tool_response: Value`）。执行流程与 Pre Tool Use 类似，但返回完整的 `PostToolUseOutcome` 供调用方进一步处理（`codex-rs/core/src/hook_runtime.rs:148-173`）。

### 待处理输入检查（Pending Input Inspection）

`inspect_pending_input()` 函数负责在输入项被正式录入会话之前进行钩子校验（`codex-rs/core/src/hook_runtime.rs:199-224`）：

1. 将 `ResponseInputItem` 转为 `ResponseItem`
2. 尝试解析为用户消息（`TurnItem::UserMessage`）
3. 如果是用户消息：
   - 运行 `user_prompt_submit` 钩子
   - 如果钩子要求停止 → 返回 `Blocked`（携带额外上下文）
   - 否则 → 返回 `Accepted`，携带原始内容、response_item 和额外上下文
4. 如果不是用户消息 → 直接返回 `Accepted`（不运行钩子）

后续 `record_pending_input()` 函数负责将已接受的输入实际写入会话记录。

## 核心类型定义

### `HookRuntimeOutcome`

钩子执行的通用返回结构：

```rust
pub(crate) struct HookRuntimeOutcome {
    pub should_stop: bool,           // 是否应终止当前流程
    pub additional_contexts: Vec<String>, // 需注入到对话中的额外上下文
}
```

> 源码位置：`codex-rs/core/src/hook_runtime.rs:27-30`

### `PendingInputHookDisposition`

待处理输入的钩子裁决结果：

```rust
pub(crate) enum PendingInputHookDisposition {
    Accepted(Box<PendingInputRecord>),         // 输入被接受，可继续处理
    Blocked { additional_contexts: Vec<String> }, // 输入被阻止
}
```

> 源码位置：`codex-rs/core/src/hook_runtime.rs:32-35`

### `PendingInputRecord`

被接受的待处理输入的具体记录：

```rust
pub(crate) enum PendingInputRecord {
    UserMessage {
        content: Vec<UserInput>,
        response_item: ResponseItem,
        additional_contexts: Vec<String>,
    },
    ConversationItem {
        response_item: ResponseItem,
    },
}
```

- `UserMessage` — 用户消息类型，携带原始内容和钩子产生的额外上下文
- `ConversationItem` — 非用户消息类型（如系统消息），不经过 prompt submit 钩子

> 源码位置：`codex-rs/core/src/hook_runtime.rs:37-46`

### `ContextInjectingHookOutcome`（内部类型）

内部辅助类型，统一 `SessionStartOutcome` 和 `UserPromptSubmitOutcome` 的转换（`codex-rs/core/src/hook_runtime.rs:48-51`）。通过两个 `From` trait 实现，将 `codex_hooks` crate 的返回类型统一映射为 `HookRuntimeOutcome`，使 `run_context_injecting_hook()` 可以用泛型方式处理两种钩子。

## 函数签名与参数说明

### `run_pending_session_start_hooks(sess, turn_context) -> bool`

运行会话启动钩子。返回值为 `should_stop`——如果为 true，调用方应终止会话。

> 源码位置：`codex-rs/core/src/hook_runtime.rs:89-116`

### `run_pre_tool_use_hooks(sess, turn_context, tool_use_id, command) -> Option<String>`

运行工具调用前钩子。返回 `Some(reason)` 表示工具调用应被阻止，`None` 表示放行。

- **tool_use_id**：工具调用的唯一标识
- **command**：即将执行的命令内容

> 源码位置：`codex-rs/core/src/hook_runtime.rs:118-146`

### `run_post_tool_use_hooks(sess, turn_context, tool_use_id, command, tool_response) -> PostToolUseOutcome`

运行工具调用后钩子。额外接收 `tool_response`（工具执行的 JSON 结果）。

> 源码位置：`codex-rs/core/src/hook_runtime.rs:148-173`

### `run_user_prompt_submit_hooks(sess, turn_context, prompt) -> HookRuntimeOutcome`

运行用户 prompt 提交钩子。`prompt` 为用户输入的文本内容。

> 源码位置：`codex-rs/core/src/hook_runtime.rs:175-197`

### `inspect_pending_input(sess, turn_context, pending_input_item) -> PendingInputHookDisposition`

检查待处理输入项。如果是用户消息，运行 prompt submit 钩子来决定接受或阻止。

> 源码位置：`codex-rs/core/src/hook_runtime.rs:199-224`

### `record_pending_input(sess, turn_context, pending_input) -> ()`

将已接受的待处理输入写入会话记录。对于 `UserMessage`，会同时记录额外上下文。

> 源码位置：`codex-rs/core/src/hook_runtime.rs:226-250`

### `record_additional_contexts(sess, turn_context, additional_contexts) -> ()`

将额外上下文字符串列表转换为 `DeveloperInstructions` 消息并注入到会话历史中。

> 源码位置：`codex-rs/core/src/hook_runtime.rs:281-293`

## 配置项与默认值

### 权限模式映射

`hook_permission_mode()` 函数（`codex-rs/core/src/hook_runtime.rs:330-339`）将 `AskForApproval` 枚举映射为钩子可识别的权限模式字符串：

| `AskForApproval` 值 | 映射结果 |
|---|---|
| `Never` | `"bypassPermissions"` |
| `UnlessTrusted` / `OnFailure` / `OnRequest` / `Granular(_)` | `"default"` |

该字符串会作为 `permission_mode` 字段传递给所有钩子请求，钩子脚本可据此调整自身行为（例如在 bypass 模式下跳过某些检查）。

## 边界 Case 与注意事项

- **tool_name 硬编码为 "Bash"**：Pre Tool Use 和 Post Tool Use 钩子的请求中，`tool_name` 固定为 `"Bash"`（`codex-rs/core/src/hook_runtime.rs:131, 162`）。这意味着当前钩子系统仅针对 shell 命令执行触发，其他工具类型（如 apply-patch、MCP 工具等）不会触发这两类钩子。

- **额外上下文以 `DeveloperInstructions` 角色注入**：钩子产生的 `additional_contexts` 被包装为 `developer` 角色消息注入到会话中（`codex-rs/core/src/hook_runtime.rs:295-300`），这意味着它们对模型可见，但会以开发者指令的身份出现，不会与用户消息混淆。

- **顺序保证**：`additional_context_messages()` 保持上下文列表的原始顺序——每条上下文独立生成一条 `DeveloperInstructions` 消息，不会合并（单元测试 `additional_context_messages_stay_separate_and_ordered` 验证了这一点，`codex-rs/core/src/hook_runtime.rs:349-380`）。

- **Post Tool Use 结果需要 clone**：由于 `hook_events` 需要同时传递给事件发射和返回给调用方，`PostToolUseOutcome` 的 `hook_events` 被 clone 了一份（`codex-rs/core/src/hook_runtime.rs:171`），这是当前实现中唯一的数据复制开销。

- **Session Start 钩子仅执行一次**：`take_pending_session_start_source()` 使用 take 语义，确保 session start 钩子在整个会话生命周期中只执行一次（`codex-rs/core/src/hook_runtime.rs:93`）。

- **HookStarted / HookCompleted 事件流**：所有钩子执行前后都会发出对应的 `EventMsg::HookStarted` 和 `EventMsg::HookCompleted` 事件（`codex-rs/core/src/hook_runtime.rs:302-328`），供 TUI 或其他消费者展示钩子执行状态。每个预览的钩子运行（`HookRunSummary`）都会独立发出一个 started 事件。