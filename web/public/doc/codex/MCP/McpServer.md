# MCP Server（codex-mcp-server）

## 概述与职责

`codex-mcp-server` 是 Codex 项目中的 **MCP（Model Context Protocol）服务端** 实现，作为独立二进制可执行文件运行。它的核心职责是将 Codex agent 暴露为一个 MCP 兼容的工具提供者，使任何 MCP 客户端（如 IDE 插件、其他 AI agent）都能通过标准协议调用 Codex 的能力。

在整体架构中，MCP Server 属于 **MCP** 模块，与 MCP Client（发现和调用外部 MCP 工具）互为对偶。CLI 模块通过 `codex mcp` 子命令启动本服务。MCP Server 接收客户端请求后，将工具调用委托给 **Core** 模块的 `ThreadManager` 执行实际的 agent 会话。

同级模块包括 Core（agent 引擎）、TUI（终端界面）、CLI（命令行入口）、AppServer（HTTP/WebSocket 服务）等。

## 关键流程

### 1. 启动与初始化

入口函数 `run_main()`（`src/lib.rs:56-179`）完成以下步骤：

1. 解析 CLI 配置覆盖项，加载 `Config`
2. 初始化 OpenTelemetry（日志、追踪、指标）
3. 创建三个并发任务，通过 channel 连接：
   - **stdin reader**：逐行读取 stdin，反序列化为 `JsonRpcMessage`，推入 `incoming_tx`
   - **message processor**：从 `incoming_rx` 接收消息，路由到 `MessageProcessor` 对应的处理函数
   - **stdout writer**：从 `outgoing_rx` 接收响应，序列化为 JSON 写入 stdout

退出路径：stdin EOF → `incoming_tx` 关闭 → processor 退出 → `outgoing_tx` 关闭 → writer 退出。

```
stdin ──→ [stdin_reader] ──incoming_tx──→ [MessageProcessor] ──outgoing_tx──→ [stdout_writer] ──→ stdout
```

### 2. MCP 协议握手（initialize）

客户端发送 `initialize` 请求后，`MessageProcessor::handle_initialize()`（`src/message_processor.rs:193-279`）执行：

1. 检查是否已初始化（防止重复调用）
2. 从客户端信息中提取 `name` 和 `version` 设置 User-Agent 后缀
3. 返回 `InitializeResult`，声明服务器能力：仅支持 **tools**（`ToolsCapability { list_changed: true }`）
4. 设置 `self.initialized = true`

### 3. 工具发现（tools/list）

`handle_list_tools()`（`src/message_processor.rs:314-330`）返回两个工具定义：

- **`codex`**：启动一个新的 Codex agent 会话
- **`codex-reply`**：在已有会话中继续对话

工具的 JSON Schema 由 `schemars` 从 Rust 类型 `CodexToolCallParam` / `CodexToolCallReplyParam` 自动生成。

### 4. 工具调用——`codex` 新建会话

当客户端调用 `tools/call` 且 `name = "codex"` 时（`src/message_processor.rs:356-425`）：

1. 解析参数为 `CodexToolCallParam`
2. 调用 `into_config()` 将工具参数转换为 `Config`（支持 model、cwd、approval_policy、sandbox 等覆盖）
3. **spawn 异步任务**，调用 `run_codex_tool_session()`（`src/codex_tool_runner.rs:59-142`）
4. 在异步任务中：
   - 通过 `ThreadManager::start_thread()` 创建新的 Codex 线程
   - 发送 `SessionConfigured` 事件作为 `codex/event` 通知
   - 以 `UserInput` 形式提交初始 prompt
   - 进入事件循环（`run_codex_tool_session_inner`）

### 5. 事件循环（核心调度）

`run_codex_tool_session_inner()`（`src/codex_tool_runner.rs:192-413`）是会话运行的核心循环：

```
loop {
    event = thread.next_event().await
    ├─ 发送 codex/event 通知给客户端
    ├─ ExecApprovalRequest  → 发起 elicitation/create 请求征求用户审批
    ├─ PatchApprovalRequest → 发起 elicitation/create 请求征求补丁审批
    ├─ TurnComplete         → 构造 CallToolResult 作为最终响应，退出循环
    ├─ Error                → 构造错误 CallToolResult，退出循环
    └─ 其他事件             → 已通过通知转发，继续循环
}
```

所有事件都通过 `send_event_as_notification()` 以 `codex/event` 方法名作为 JSON-RPC 通知发送给客户端，通知的 `_meta` 中携带 `requestId` 和 `threadId` 用于关联。

### 6. 工具调用——`codex-reply` 继续会话

当 `name = "codex-reply"` 时（`src/message_processor.rs:427-523`）：

1. 解析参数获取 `thread_id`（兼容旧版 `conversationId` 字段）和 `prompt`
2. 通过 `ThreadManager::get_thread()` 获取已有线程
3. spawn 异步任务，调用 `run_codex_tool_session_reply()`，提交新的用户输入后进入同一事件循环

### 7. 审批转发机制（Exec & Patch Approval）

当 Codex agent 需要执行 shell 命令或应用代码补丁时，需要客户端授权：

**Exec Approval**（`src/exec_approval.rs:51-110`）：
1. 构造 `ExecApprovalElicitRequestParams`，包含命令、工作目录、解析后的命令信息
2. 通过 `outgoing.send_request("elicitation/create", ...)` 发送 MCP elicitation 请求
3. 在独立 task 中等待客户端响应
4. 收到 `ExecApprovalResponse` 后，将审批决策（`Approved` / `Denied`）提交给 Codex 线程

**Patch Approval**（`src/patch_approval.rs:44-101`）：流程类似，但携带的是文件变更（`HashMap<PathBuf, FileChange>`）信息。如果客户端响应失败或反序列化失败，默认**拒绝**请求（保守策略）。

### 8. 取消通知处理

客户端发送 `cancelled` 通知时（`src/message_processor.rs:550-594`）：
1. 通过 `running_requests_id_to_codex_uuid` 映射找到对应的 `ThreadId`
2. 向 Codex 线程提交 `Op::Interrupt`
3. 从映射中移除该请求

## 函数签名与参数说明

### `run_main(arg0_paths: Arg0DispatchPaths, cli_config_overrides: CliConfigOverrides) -> IoResult<()>`

服务启动入口。初始化配置、遥测、channel，启动三个并发任务并等待它们完成。

> 源码位置：`src/lib.rs:56-179`

### `MessageProcessor::new(outgoing, arg0_paths, config, environment_manager) -> Self`

创建消息处理器，内部初始化 `AuthManager` 和 `ThreadManager`。会话来源标记为 `SessionSource::Mcp`。

> 源码位置：`src/message_processor.rs:52-82`

### `MessageProcessor::process_request(request: JsonRpcRequest<ClientRequest>)`

请求路由入口，根据 `ClientRequest` 变体分派到具体 handler。

> 源码位置：`src/message_processor.rs:84-158`

## 接口/类型定义

### `CodexToolCallParam`（`codex` 工具输入参数）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | `String` | 是 | 初始用户 prompt |
| `model` | `Option<String>` | 否 | 模型名称覆盖 |
| `profile` | `Option<String>` | 否 | config.toml 中的配置 profile |
| `cwd` | `Option<String>` | 否 | 工作目录 |
| `approval-policy` | `Option<CodexToolCallApprovalPolicy>` | 否 | 审批策略：`untrusted` / `on-failure` / `on-request` / `never` |
| `sandbox` | `Option<CodexToolCallSandboxMode>` | 否 | 沙箱模式：`read-only` / `workspace-write` / `danger-full-access` |
| `config` | `Option<HashMap<String, Value>>` | 否 | 逐项覆盖 config.toml 配置 |
| `base-instructions` | `Option<String>` | 否 | 替换默认 instructions |
| `developer-instructions` | `Option<String>` | 否 | developer role 指令注入 |
| `compact-prompt` | `Option<String>` | 否 | 会话压缩时使用的 prompt |

> 源码位置：`src/codex_tool_config.rs:21-65`

### `CodexToolCallReplyParam`（`codex-reply` 工具输入参数）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `threadId` | `Option<String>` | 是* | 会话线程 ID |
| `conversationId` | `Option<String>` | 否 | 已废弃，向后兼容 |
| `prompt` | `String` | 是 | 继续对话的用户 prompt |

> \* `threadId` 和 `conversationId` 至少提供一个。源码位置：`src/codex_tool_config.rs:201-232`

### 工具输出 Schema

两个工具共享同一输出 schema（`src/codex_tool_config.rs:137-150`）：

```json
{
  "type": "object",
  "properties": {
    "threadId": { "type": "string" },
    "content": { "type": "string" }
  },
  "required": ["threadId", "content"]
}
```

`threadId` 在 `structured_content` 中返回，供客户端用于后续 `codex-reply` 调用。

### `OutgoingMessage` 枚举

```rust
enum OutgoingMessage {
    Request(OutgoingRequest),      // 发送给客户端的请求（如 elicitation/create）
    Notification(OutgoingNotification), // 发送给客户端的通知（如 codex/event）
    Response(OutgoingResponse),    // tools/call 等请求的响应
    Error(OutgoingError),          // JSON-RPC 错误
}
```

> 源码位置：`src/outgoing_message.rs:139-144`

### `ExecApprovalElicitRequestParams` / `PatchApprovalElicitRequestParams`

遵循 MCP elicitation 请求格式，附加 Codex 特定的关联字段（`threadId`、`codex_call_id`、`codex_command` 等），以便客户端能展示审批 UI 并关联到具体的工具调用。

> 源码位置：`src/exec_approval.rs:20-39`、`src/patch_approval.rs:20-36`

## 配置项与默认值

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `CHANNEL_CAPACITY` | 128 | incoming message channel 的缓冲区大小 |
| `DEFAULT_ANALYTICS_ENABLED` | `true` | 遥测分析默认开启 |
| `OTEL_SERVICE_NAME` | `"codex_mcp_server"` | OpenTelemetry 服务名标识 |

日志输出到 stderr（不干扰 stdin/stdout 上的 JSON-RPC 通信），日志级别通过 `RUST_LOG` 环境变量控制。

## 边界 Case 与注意事项

- **重复 initialize**：如果客户端多次发送 `initialize`，服务器返回 `InvalidRequest` 错误（`src/message_processor.rs:200-208`）
- **审批失败默认拒绝**：exec/patch approval 的客户端响应反序列化失败时，服务器保守地以 `Denied` 决策提交，避免未经授权的操作执行
- **多线程复用**：多个 Codex 会话可复用同一 MCP 连接，通过 `running_requests_id_to_codex_uuid`（`HashMap<RequestId, ThreadId>`）维护映射关系
- **未实现的 MCP 能力**：resources、prompts、subscriptions、tasks 等 MCP 方法仅记录日志，不返回实际数据。tasks 相关方法（`tasks/get_info`、`tasks/list` 等）返回 `METHOD_NOT_FOUND`
- **`tool_handlers/` 目录**：声明了 `create_conversation` 和 `send_message` 子模块但尚无实现文件，属于预留结构
- **事件透传**：所有 Codex 事件在分派处理前都已作为 `codex/event` 通知转发给客户端，部分事件（如 `AgentMessageDelta`、`ElicitationRequest`）标注了 TODO 待未来增强