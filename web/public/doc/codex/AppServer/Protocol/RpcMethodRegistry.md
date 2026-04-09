# RPC 方法注册表（RpcMethodRegistry）

## 概述与职责

RPC 方法注册表是 `codex-app-server-protocol` crate 的核心模块，定义了 Codex AppServer 客户端与服务端之间 **所有** JSON-RPC 通信的消息类型。它位于 AppServer 架构的 **Protocol** 层，被 Transport、RequestProcessing、ServerAPIs、ClientLib、DevTools 等几乎所有 AppServer 子模块依赖。

该模块通过四个声明式宏（`client_request_definitions!`、`server_request_definitions!`、`server_notification_definitions!`、`client_notification_definitions!`）批量生成枚举及其关联类型，覆盖了线程生命周期、Turn 管理、文件系统操作、配置读写、认证鉴权、模型列表、插件管理、命令执行等 **60+ 种 RPC 方法变体**。同时定义了 `AuthMode`、`FuzzyFileSearch` 系列类型，以及 crate 的公开 API 表面（`lib.rs` 的 re-export）。

## 关键流程

### 宏驱动的枚举生成机制

整个注册表的核心设计是用声明式宏将"方法定义"与"枚举 + trait impl + 导出函数"的样板代码分离。开发者只需在宏调用中添加一行变体声明，即可自动获得序列化/反序列化、TypeScript 导出、JSON Schema 导出、实验性 API 网关等全套能力。

1. **定义阶段**：在 `common.rs` 中调用四个宏，传入变体名称、wire 名称（如 `"thread/start"`）、params 类型和 response 类型
2. **展开阶段**：宏自动生成带 `#[serde(tag = "method")]` 标签的枚举，每个变体持有 `request_id` 和 `params` 字段
3. **配套生成**：同时生成 `id()`/`method()` 访问器、`ExperimentalApi` trait 实现、TypeScript 导出函数、JSON Schema 导出函数

### 消息分发路径

```
客户端 JSON-RPC 消息
  → serde 反序列化为 ClientRequest 枚举（按 "method" 字段标签分派）
  → RequestProcessing 层对枚举 match 分支处理
  → 构造对应的 response 类型
  → 序列化为 JSON-RPC 响应返回
```

服务端主动请求（`ServerRequest`）和通知（`ServerNotification`）遵循类似的反向路径。

## 四大宏定义详解

### `client_request_definitions!`

> 源码位置：`codex-rs/app-server-protocol/src/protocol/common.rs:75-228`

生成以下类型和函数：

| 生成物 | 说明 |
|--------|------|
| `enum ClientRequest` | 客户端→服务端的请求枚举，按 `method` JSON 标签分派 |
| `enum ClientResponse` | 对应的响应枚举，同样按 `method` 标签分派 |
| `ClientRequest::id()` | 获取请求 ID |
| `ClientRequest::method()` | 通过序列化获取方法名字符串 |
| `impl ExperimentalApi for ClientRequest` | 实验性 API 网关支持 |
| `export_client_responses()` | 将所有响应类型导出为 TypeScript |
| `export_client_response_schemas()` / `export_client_param_schemas()` | JSON Schema 导出 |
| `EXPERIMENTAL_CLIENT_METHODS` | 编译期常量，记录所有标记为实验性的方法名 |

每个变体支持以下可选注解：
- `#[experimental("reason")]`：标记为实验性方法，需要客户端显式 opt-in
- `=> "wire/name"`：自定义 JSON wire 名称（如 `"thread/start"`）
- `inspect_params: true`：方法本身稳定，但 params 中有字段级实验性标记

### `server_request_definitions!`

> 源码位置：`codex-rs/app-server-protocol/src/protocol/common.rs:584-674`

生成 `enum ServerRequest`（服务端→客户端的请求）及 `ServerRequestPayload` 辅助枚举。`ServerRequestPayload` 提供 `request_with_id()` 方法，用于在服务端构造请求时附加 ID。

### `server_notification_definitions!`

> 源码位置：`codex-rs/app-server-protocol/src/protocol/common.rs:679-732`

生成 `enum ServerNotification`，使用 `#[serde(tag = "method", content = "params")]` 的标签+内容模式序列化。额外 derive 了 `Display`（通过 `strum_macros`）和 `ExperimentalApi`（通过自定义 derive 宏）。提供 `to_params()` 方法将通知转为 JSON Value，以及从 `JSONRPCNotification` 的 `TryFrom` 转换。

### `client_notification_definitions!`

> 源码位置：`codex-rs/app-server-protocol/src/protocol/common.rs:734-759`

生成 `enum ClientNotification`。当前仅有一个变体 `Initialized`（无 payload），用于客户端完成初始化后通知服务端。

## 注册的方法变体总览

### ClientRequest（客户端→服务端请求）

**线程生命周期**（`thread/*`）：
- `ThreadStart`、`ThreadResume`、`ThreadFork`、`ThreadArchive`、`ThreadUnarchive`、`ThreadUnsubscribe`
- `ThreadSetName`、`ThreadMetadataUpdate`、`ThreadCompactStart`、`ThreadRollback`
- `ThreadList`、`ThreadLoadedList`、`ThreadRead`
- `ThreadShellCommand`、`ThreadBackgroundTerminalsClean`（实验性）
- `ThreadIncrementElicitation` / `ThreadDecrementElicitation`（实验性，管理超时计时暂停）

**Turn 管理**（`turn/*`）：
- `TurnStart`、`TurnSteer`、`TurnInterrupt`

**实时语音**（`thread/realtime/*`，均为实验性）：
- `ThreadRealtimeStart`、`ThreadRealtimeAppendAudio`、`ThreadRealtimeAppendText`、`ThreadRealtimeStop`

**文件系统操作**（`fs/*`）：
- `FsReadFile`、`FsWriteFile`、`FsCreateDirectory`、`FsGetMetadata`
- `FsReadDirectory`、`FsRemove`、`FsCopy`、`FsWatch`、`FsUnwatch`

**配置**（`config/*`）：
- `ConfigRead`、`ConfigValueWrite`、`ConfigBatchWrite`、`ConfigRequirementsRead`

**认证与账户**（`account/*`）：
- `LoginAccount`、`CancelLoginAccount`、`LogoutAccount`、`GetAccount`、`GetAccountRateLimits`

**命令执行**（`command/exec/*`）：
- `OneOffCommandExec`、`CommandExecWrite`、`CommandExecTerminate`、`CommandExecResize`

**其他**：
- `Initialize`、`ModelList`、`ReviewStart`、`FeedbackUpload`
- `SkillsList`、`SkillsConfigWrite`、`PluginList`、`PluginRead`、`PluginInstall`、`PluginUninstall`、`AppsList`
- `ExperimentalFeatureList`、`ExperimentalFeatureEnablementSet`、`CollaborationModeList`（实验性）
- `McpServerOauthLogin`、`McpServerRefresh`、`McpServerStatusList`
- `ExternalAgentConfigDetect`、`ExternalAgentConfigImport`
- `WindowsSandboxSetupStart`

**已废弃的 v1 方法**：`GetConversationSummary`、`GitDiffToRemote`、`GetAuthStatus`、`FuzzyFileSearch`

### ServerRequest（服务端→客户端请求）

> 源码位置：`codex-rs/app-server-protocol/src/protocol/common.rs:769-827`

- `CommandExecutionRequestApproval`：请求用户批准命令执行
- `FileChangeRequestApproval`：请求用户批准文件变更
- `ToolRequestUserInput`：请求用户为工具调用提供输入（实验性）
- `McpServerElicitationRequest`：MCP 服务器 elicitation 请求
- `PermissionsRequestApproval`：请求额外权限批准
- `DynamicToolCall`：在客户端执行动态工具调用
- `ChatgptAuthTokensRefresh`：请求刷新 ChatGPT 认证 token
- `ApplyPatchApproval`、`ExecCommandApproval`（已废弃 v1 API）

### ServerNotification（服务端→客户端通知）

> 源码位置：`codex-rs/app-server-protocol/src/protocol/common.rs:911-982`

涵盖 **40+ 种通知**，按功能域分类：

- **线程事件**：`ThreadStarted`、`ThreadStatusChanged`、`ThreadArchived`/`ThreadUnarchived`、`ThreadClosed`、`ThreadNameUpdated`、`ThreadTokenUsageUpdated`
- **Turn 事件**：`TurnStarted`、`TurnCompleted`、`TurnDiffUpdated`、`TurnPlanUpdated`
- **Item 事件**：`ItemStarted`、`ItemCompleted`、流式增量（`AgentMessageDelta`、`PlanDelta`）
- **审批审核**：`ItemGuardianApprovalReviewStarted`/`Completed`
- **命令与文件**：`CommandExecOutputDelta`、`CommandExecutionOutputDelta`、`TerminalInteraction`、`FileChangeOutputDelta`
- **推理可见性**：`ReasoningSummaryTextDelta`、`ReasoningSummaryPartAdded`、`ReasoningTextDelta`
- **账户与配置**：`AccountUpdated`、`AccountRateLimitsUpdated`、`AccountLoginCompleted`、`ConfigWarning`、`DeprecationNotice`
- **MCP**：`McpToolCallProgress`、`McpServerOauthLoginCompleted`、`McpServerStatusUpdated`
- **文件搜索**：`FuzzyFileSearchSessionUpdated`/`Completed`
- **文件系统**：`FsChanged`
- **实时语音**（实验性）：`ThreadRealtimeStarted`、`ThreadRealtimeItemAdded`、`ThreadRealtimeTranscriptUpdated`、`ThreadRealtimeOutputAudioDelta`、`ThreadRealtimeError`、`ThreadRealtimeClosed`
- **平台特定**：`WindowsWorldWritableWarning`、`WindowsSandboxSetupCompleted`
- **其他**：`Error`、`ServerRequestResolved`、`ContextCompacted`（已废弃）、`ModelRerouted`、`SkillsChanged`、`AppListUpdated`

### ClientNotification（客户端→服务端通知）

仅 `Initialized` 一个变体，无 payload（`codex-rs/app-server-protocol/src/protocol/common.rs:984-986`）。

## 接口/类型定义

### `AuthMode`

> 源码位置：`codex-rs/app-server-protocol/src/protocol/common.rs:18-33`

OpenAI 后端的认证模式枚举：

| 变体 | wire 名称 | 说明 |
|------|-----------|------|
| `ApiKey` | `"apiKey"` | 调用方提供 API key，由 Codex 存储管理 |
| `Chatgpt` | `"chatgpt"` | Codex 管理的 ChatGPT OAuth 流程，token 持久化并自动刷新 |
| `ChatgptAuthTokens` | `"chatgptAuthTokens"` | **不稳定，仅限 OpenAI 内部使用**。外部宿主应用提供 token，仅存于内存 |

### `FuzzyFileSearchParams` / `FuzzyFileSearchResponse`

> 源码位置：`codex-rs/app-server-protocol/src/protocol/common.rs:829-861`

传统单次模糊文件搜索的参数和响应类型。

```rust
pub struct FuzzyFileSearchParams {
    pub query: String,           // 搜索关键字
    pub roots: Vec<String>,      // 搜索根目录列表
    pub cancellation_token: Option<String>, // 去重取消令牌
}

pub struct FuzzyFileSearchResult {
    pub root: String,
    pub path: String,
    pub match_type: FuzzyFileSearchMatchType, // File | Directory
    pub file_name: String,
    pub score: u32,
    pub indices: Option<Vec<u32>>,  // 匹配字符位置
}
```

### `FuzzyFileSearchSession*` 类型族

> 源码位置：`codex-rs/app-server-protocol/src/protocol/common.rs:863-909`

实验性的会话式模糊搜索 API，支持增量更新：
- `FuzzyFileSearchSessionStartParams`：创建搜索会话（`session_id` + `roots`）
- `FuzzyFileSearchSessionUpdateParams`：更新查询条件
- `FuzzyFileSearchSessionStopParams`：终止会话
- `FuzzyFileSearchSessionUpdatedNotification`：服务端推送搜索结果增量
- `FuzzyFileSearchSessionCompletedNotification`：搜索完成通知

## Crate 公开 API 表面（lib.rs）

> 源码位置：`codex-rs/app-server-protocol/src/lib.rs:1-49`

`lib.rs` 作为 crate 入口，通过 `pub use` 将内部模块的类型汇聚为扁平的公开 API：

- `protocol::common::*`：本文档描述的所有枚举和类型（`ClientRequest`、`ServerRequest`、`ServerNotification`、`ClientNotification`、`AuthMode`、`FuzzyFileSearch*` 等）
- `protocol::v2::*`：v2 API 的所有 params/response 类型
- `protocol::v1::*`：精选 re-export 的 v1 类型（`InitializeParams`、`ApplyPatchApprovalParams` 等）
- `protocol::thread_history::*`：线程历史构造相关类型
- `jsonrpc_lite::*`：底层 JSON-RPC 消息类型（`JSONRPCRequest`、`JSONRPCNotification`、`RequestId` 等）
- `experimental_api::*`：实验性 API 网关机制
- `export::*`：TypeScript/JSON Schema 导出工具函数
- `schema_fixtures::*`：测试用 schema fixture 工具
- `codex_git_utils::GitSha`：Git SHA re-export

## 实验性 API 网关机制

> 源码位置：`codex-rs/app-server-protocol/src/protocol/common.rs:35-69`

三个辅助宏（`experimental_reason_expr!`、`experimental_method_entry!`、`experimental_type_entry!`）与 `ExperimentalApi` trait 配合，实现编译期+运行时的实验性 API 网关：

1. 变体级别标记 `#[experimental("reason")]`：整个方法为实验性
2. 参数级别标记 `inspect_params: true`：方法稳定但部分字段实验性，运行时检查 params 的 `experimental_reason()`
3. 编译期生成 `EXPERIMENTAL_CLIENT_METHODS` 常量数组，用于导出时过滤实验性方法

## 依赖与序列化约定

**关键依赖**（`Cargo.toml`）：
- `serde` + `serde_json`：JSON 序列化，使用 `tag = "method"` 的内部标签策略
- `schemars`：JSON Schema 自动生成
- `ts-rs`：TypeScript 类型定义自动导出
- `strum_macros`：枚举的 `Display` trait 自动实现
- `codex-experimental-api-macros`：自定义 derive 宏 `ExperimentalApi`
- `codex-protocol`：共享的核心协议类型（`ThreadId` 等）

**序列化约定**：
- 请求/响应枚举使用 `#[serde(tag = "method", rename_all = "camelCase")]` —— 以 `method` 字段作为类型标签
- 通知枚举使用 `#[serde(tag = "method", content = "params")]` —— 标签 + 内容分离
- 自定义 wire 名称通过 `=> "thread/start"` 语法同时应用于 serde 和 ts-rs

## 边界 Case 与注意事项

- **v1 与 v2 共存**：`ClientRequest` 枚举中混合了 v1（无 wire 名称，使用 camelCase 默认）和 v2（显式 `=> "slash/separated"` wire 名称）的方法。v1 方法标注了 `DEPRECATED` 注释但仍然存在以保持向后兼容
- **空 params 处理**：部分方法（如 `LogoutAccount`、`McpServerRefresh`）使用 `Option<()>` 作为 params 类型，配合 `#[serde(skip_serializing_if = "Option::is_none")]` 和 `#[ts(type = "undefined")]` 实现可省略的 params
- **`ClientNotification` 极简**：目前仅有 `Initialized` 一个变体，这意味着客户端到服务端的无需响应通信几乎不存在——绝大多数客户端→服务端的通信走请求-响应模式
- **宏展开的隐含约束**：所有 params 类型必须实现 `Serialize + Deserialize + Debug + Clone + PartialEq + JsonSchema + TS`，所有 response 类型必须实现 `Serialize + Deserialize + Debug + Clone`。新增方法变体时需确保相关类型满足这些 trait bound