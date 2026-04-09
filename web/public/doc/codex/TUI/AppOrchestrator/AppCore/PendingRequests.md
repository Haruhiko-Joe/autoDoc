# PendingRequests — 待处理的 App-Server 请求追踪与解析

## 概述与职责

`PendingAppServerRequests` 是 TUI 层 `AppCore` 的一个内部组件，负责**追踪并解析来自 app-server 的各类待处理请求**。当 app-server 发送需要用户交互的请求（命令执行审批、文件变更审批、权限申请、用户输入、MCP 引出表单）时，该模块将请求注册到内部映射表；当用户通过 TUI 做出决策后，核心协议产生的 `Op` 通过此模块关联回 app-server 的请求 ID，并序列化为对应的响应类型发送回去。

在整体架构中，该模块位于 **TUI → AppOrchestrator → AppCore** 层级下，是 AppCore 状态机中处理"请求-响应"关联的桥梁——它解耦了 app-server 协议层的请求 ID 管理与 TUI 内部的审批决策流程。

## 关键数据结构

### `PendingAppServerRequests`

核心结构体，维护五个 `HashMap`，分别追踪不同类型的待处理请求：

| 字段 | 键类型 | 说明 |
|------|--------|------|
| `exec_approvals` | `String`（approval_id 或 item_id） | 命令执行审批请求 |
| `file_change_approvals` | `String`（item_id） | 文件变更审批请求 |
| `permissions_approvals` | `String`（item_id） | 权限申请请求 |
| `user_inputs` | `String`（turn_id） | 用户输入请求 |
| `mcp_requests` | `McpLegacyRequestKey`（server_name + request_id） | MCP 引出请求 |

所有映射的值均为 `AppServerRequestId`，即 app-server 协议层的请求标识。

> 源码位置：`codex-rs/tui/src/app/app_server_requests.rs:30-37`

### `AppServerRequestResolution`

解析成功时的返回值，包含 `request_id`（关联回 app-server）和 `result`（序列化后的 JSON 响应体）。

### `UnsupportedAppServerRequest`

当收到 TUI 尚不支持的请求类型时返回，携带 `request_id` 和错误消息。

### `McpLegacyRequestKey`

MCP 请求的复合键，由 `server_name` 和 `McpRequestId` 组成，用于在 `mcp_requests` 映射中唯一标识一个 MCP 引出请求。

> 源码位置：`codex-rs/tui/src/app/app_server_requests.rs:243-247`

## 关键流程

### 请求注册流程（`note_server_request`）

当 app-server 推送 `ServerRequest` 时，调用此方法将其注册到对应的 HashMap 中：

1. **`CommandExecutionRequestApproval`**：使用 `approval_id`（如果存在）或 `item_id` 作为键，存入 `exec_approvals`
2. **`FileChangeRequestApproval`**：使用 `item_id` 作为键，存入 `file_change_approvals`
3. **`PermissionsRequestApproval`**：使用 `item_id` 作为键，存入 `permissions_approvals`
4. **`ToolRequestUserInput`**：使用 `turn_id` 作为键，存入 `user_inputs`
5. **`McpServerElicitationRequest`**：构造 `McpLegacyRequestKey`（通过 `app_server_request_id_to_mcp_request_id` 转换请求 ID 类型），存入 `mcp_requests`
6. **`DynamicToolCall`** / **`ApplyPatchApproval`** / **`ExecCommandApproval`**：返回 `UnsupportedAppServerRequest`，表示 TUI 暂不支持
7. **`ChatgptAuthTokensRefresh`**：静默忽略（返回 `None`），不注册也不报错

> 源码位置：`codex-rs/tui/src/app/app_server_requests.rs:48-108`

### 决策解析流程（`take_resolution`）

当用户在 TUI 中做出审批决策后，核心协议生成 `Op`（如 `ExecApproval`、`PatchApproval` 等），通过此方法关联回 app-server 请求 ID 并序列化响应：

1. 将传入的 `Op` 转为 `AppCommand`，再通过 `view()` 方法获取类型化视图
2. 根据视图类型，从对应的 HashMap 中 **remove** 出 `AppServerRequestId`
3. 构造对应的 app-server 协议响应类型并序列化为 JSON

各分支的具体行为：

| AppCommandView 变体 | 来源 HashMap | 响应类型 | 类型转换 |
|---------------------|-------------|---------|---------|
| `ExecApproval` | `exec_approvals` | `CommandExecutionRequestApprovalResponse` | `decision.into()` |
| `PatchApproval` | `file_change_approvals` | `FileChangeRequestApprovalResponse` | 通过 `file_change_decision()` 转换 |
| `RequestPermissionsResponse` | `permissions_approvals` | `PermissionsRequestApprovalResponse` | 通过 `granted_permission_profile_from_request()` 转换 |
| `UserInputAnswer` | `user_inputs` | `ToolRequestUserInputResponse` | 序列化→反序列化桥接 |
| `ResolveElicitation` | `mcp_requests` | `McpServerElicitationRequestResponse` | `ElicitationAction` → `McpServerElicitationAction` |

如果 HashMap 中找不到对应的请求 ID（已被解析或从未注册），返回 `Ok(None)`。

> 源码位置：`codex-rs/tui/src/app/app_server_requests.rs:110-230`

### 通知解析（`resolve_notification`）

给定一个 `AppServerRequestId`，从**所有五个** HashMap 中移除与之关联的条目。这用于处理 app-server 主动取消或超时的情况。

> 源码位置：`codex-rs/tui/src/app/app_server_requests.rs:232-240`

## 类型转换桥接

### `ReviewDecision` → `FileChangeApprovalDecision`

`file_change_decision()` 函数将核心协议的审批决策映射到 app-server 协议的文件变更决策：

| ReviewDecision | FileChangeApprovalDecision |
|---------------|---------------------------|
| `Approved` | `Accept` |
| `ApprovedForSession` | `AcceptForSession` |
| `Denied` | `Decline` |
| `Abort` | `Cancel` |
| `ApprovedExecpolicyAmendment` | **错误**（不适用于文件变更） |
| `NetworkPolicyAmendment` | **错误**（不适用于文件变更） |

> 源码位置：`codex-rs/tui/src/app/app_server_requests.rs:256-269`

### `ElicitationAction` → `McpServerElicitationAction`

在 `take_resolution` 的 `ResolveElicitation` 分支中内联转换，三个变体一一对应：`Accept`、`Decline`、`Cancel`。

> 源码位置：`codex-rs/tui/src/app/app_server_requests.rs:207-216`

### `AppServerRequestId` → `McpRequestId`

`app_server_request_id_to_mcp_request_id()` 在 `String` 和 `Integer` 两种变体之间做同构转换，用于在 MCP 请求注册时统一键类型。

> 源码位置：`codex-rs/tui/src/app/app_server_requests.rs:249-254`

## 边界 Case 与注意事项

- **`exec_approvals` 的键选择逻辑**：优先使用 `approval_id`，仅在 `approval_id` 为 `None` 时回退到 `item_id`。这意味着 `take_resolution` 中的 `ExecApproval` 必须使用与注册时一致的 ID（即 `approval_id` 或 `item_id`），否则无法关联
- **`UserInputAnswer` 的序列化桥接**：先序列化为 JSON 再反序列化为 `ToolRequestUserInputResponse`，这是因为核心协议和 app-server 协议的用户输入响应类型结构相同但属于不同 crate，需要通过 serde 进行类型转换
- **`take_resolution` 是消耗性操作**：使用 `remove` 而非 `get`，每个请求只能被解析一次
- **`clear()` 方法**：清空所有待处理请求，通常在会话重置或线程切换时调用
- **不合法的文件变更决策**：`ApprovedExecpolicyAmendment` 和 `NetworkPolicyAmendment` 不是有效的文件变更审批决策，`file_change_decision()` 会返回明确的错误信息
- **三种不受支持的请求类型**：`DynamicToolCall`、`ApplyPatchApproval`（旧版补丁审批）、`ExecCommandApproval`（旧版命令审批）在 TUI 中均返回 `UnsupportedAppServerRequest`