# V2 数据模型

## 概述与职责

`v2.rs` 是 Codex app-server 协议层的**核心数据模型文件**，定义了 v2 API 所使用的全部请求参数（Params）、响应（Response）、通知（Notification）结构体和枚举类型，共约 8300 行。它位于 `AppServer > Protocol` 层级中，是 Protocol crate 的最大单文件，被 Transport、RequestProcessing、ServerAPIs、ClientLib、DevTools 等所有 AppServer 子模块依赖。

本模块的核心设计思路是：**将内部 Core 层的 Rust 类型（通常使用 snake_case/kebab-case）转换为面向 JSON 线协议的 camelCase 类型**，同时通过 `serde`、`schemars`（JSON Schema）和 `ts-rs`（TypeScript 类型导出）的 derive 宏，使每个类型同时服务于序列化、Schema 校验和客户端 SDK 生成。

辅助文件 `serde_helpers.rs` 提供了 `Option<Option<T>>` 的序列化/反序列化支持（区分"字段缺失"和"显式设为 null"），用于 `service_tier` 等可显式清空的字段。

## 关键流程

### Core 类型到 Wire 类型的转换

整个文件的主要职责是建立 Core ↔ v2 的双向映射。有三种转换模式：

1. **`v2_enum_from_core!` 宏**（`v2.rs:100-127`）：用于简单枚举的批量映射。宏自动生成 `#[serde(rename_all = "camelCase")]` 的 v2 枚举，并实现 `to_core()` 方法和 `From<CoreType>` trait。例如：
   ```rust
   v2_enum_from_core!(
       pub enum HookEventName from CoreHookEventName {
           PreToolUse, PostToolUse, SessionStart, UserPromptSubmit, Stop
       }
   );
   ```

2. **手动 `From` 实现**：用于带字段的枚举或结构体复杂映射，如 `CodexErrorInfo`（`v2.rs:186-216`）、`AskForApproval`（`v2.rs:252-292`）。

3. **直接定义**：部分类型仅在 v2 层存在（如 `CommandExecParams`），不需要 Core 映射。

### 请求-响应数据流

客户端通过 JSON-RPC 发送请求，RequestProcessing 层使用本模块的 Params 类型反序列化入参，调用 Core/ServerAPIs 处理后，再使用 Response 类型序列化返回。以线程启动为例：

1. 客户端发送 `thread/start` → 反序列化为 `ThreadStartParams`（`v2.rs:2546-2600`）
2. 服务端处理后返回 `ThreadStartResponse`（`v2.rs:2622-2634`），包含 `Thread` 对象和生效的配置
3. 后续事件通过 Notification 类型（如 `TurnStartedNotification`）流式推送

## 类型分组总览

本文件的类型可按功能域分为以下几组：

### 1. 错误类型

| 类型 | 说明 |
|------|------|
| `CodexErrorInfo` | 错误分类枚举，含 `ContextWindowExceeded`、`HttpConnectionFailed`（带 HTTP 状态码）等 13 种变体（`v2.rs:144-184`） |
| `NonSteerableTurnKind` | 不可转向的 turn 类型：`Review`、`Compact` |
| `TurnError` | Turn 错误详情，含 message + 可选 `CodexErrorInfo` + 附加详情（`v2.rs:3734-3743`） |

### 2. 审批与权限

| 类型 | 说明 |
|------|------|
| `AskForApproval` | 审批策略枚举：`UnlessTrusted`/`OnFailure`/`OnRequest`/`Granular`/`Never`（`v2.rs:233-250`） |
| `ApprovalsReviewer` | 审批审核者：`User` 或 `GuardianSubagent`（`v2.rs:302-305`） |
| `CommandExecutionApprovalDecision` | 命令审批决策：`Accept`/`AcceptForSession`/`AcceptWithExecpolicyAmendment`/`Decline`/`Cancel` 等（`v2.rs:1018-1037`） |
| `FileChangeApprovalDecision` | 文件变更审批决策（`v2.rs:1212-1221`） |
| `ExecPolicyAmendment` | 执行策略修正，透明包装命令向量（`v2.rs:1391-1396`） |
| `NetworkPolicyAmendment` | 网络策略修正，含主机名和 allow/deny 动作（`v2.rs:1418-1424`） |
| `SandboxPolicy` | 沙箱策略枚举：`DangerFullAccess`/`ReadOnly`/`ExternalSandbox`/`WorkspaceWrite`（`v2.rs:1283-1313`） |
| `PermissionProfile` 系列 | `RequestPermissionProfile`、`AdditionalPermissionProfile`、`GrantedPermissionProfile`：权限请求/附加/授予三层抽象 |
| `GuardianApprovalReview` | Guardian 自动审批审核负载：风险等级、评分、理由（`v2.rs:4447-4456`） |

### 3. 线程管理

| 类型 | 说明 |
|------|------|
| `ThreadStartParams` | 启动线程参数：model、cwd、approval_policy、sandbox、dynamic_tools 等（`v2.rs:2546-2600`） |
| `ThreadResumeParams` | 恢复线程：支持 thread_id/history/path 三种方式，优先级 history > path > thread_id（`v2.rs:2650-2703`） |
| `ThreadForkParams` | 分叉线程：从已有线程创建新线程（`v2.rs:2734-2780`） |
| `Thread` | 线程完整描述：id、preview、status、source、git_info、turns 等（`v2.rs:3575-3614`） |
| `ThreadStatus` | 线程状态：`NotLoaded`/`Idle`/`SystemError`/`Active`（含 `ThreadActiveFlag`） |
| `ThreadListParams` | 列表查询参数：分页、排序、按 provider/source/cwd/搜索词过滤 |

### 4. Turn 管理

| 类型 | 说明 |
|------|------|
| `TurnStartParams` | 启动 turn：input、cwd、model、effort、sandbox_policy、collaboration_mode 等覆盖项（`v2.rs:3941-3992`） |
| `TurnSteerParams` | 同 turn 转向：注入新输入到进行中的 turn（`v2.rs:4054-4063`） |
| `TurnInterruptParams` | 中断 turn |
| `Turn` | Turn 描述：id、items、status、error（`v2.rs:3685-3694`） |
| `TurnStatus` | `Completed`/`Interrupted`/`Failed`/`InProgress` |
| `ThreadItem` | **核心枚举**——turn 内所有内容项的联合类型，共 16 种变体（`v2.rs:4234-4380`） |

### 5. ThreadItem 变体详解

`ThreadItem` 是面向客户端最重要的枚举，每个变体代表一种可呈现的内容：

| 变体 | 说明 |
|------|------|
| `UserMessage` | 用户消息 |
| `HookPrompt` | Hook 注入的提示 |
| `AgentMessage` | Agent 回复文本，含 phase 和 memory_citation |
| `Plan` | 计划项内容 |
| `Reasoning` | 推理过程，含 summary 和 content |
| `CommandExecution` | 命令执行：command、cwd、status、exit_code、duration_ms 等 |
| `FileChange` | 文件变更：changes 列表 + patch apply 状态 |
| `McpToolCall` | MCP 工具调用：server、tool、arguments、result/error |
| `DynamicToolCall` | 动态工具调用 |
| `CollabAgentToolCall` | 协作 Agent 工具调用：SpawnAgent/SendInput/Wait 等 |
| `WebSearch` | Web 搜索：query + action（Search/OpenPage/FindInPage） |
| `ImageView` / `ImageGeneration` | 图片查看/生成 |
| `EnteredReviewMode` / `ExitedReviewMode` | 进入/退出审查模式 |
| `ContextCompaction` | 上下文压缩事件 |

### 6. 用户输入

| 类型 | 说明 |
|------|------|
| `UserInput` | 输入联合类型：`Text`（含 `TextElement` spans）、`Image`、`LocalImage`、`Skill`、`Mention`（`v2.rs:4158-4179`） |
| `TextElement` | 文本中的特殊元素标注，含 `ByteRange` 和可选 placeholder |
| `ByteRange` | 字节范围，用于定位 `TextElement` 在文本中的位置 |

### 7. 配置读写

| 类型 | 说明 |
|------|------|
| `Config` | 完整配置结构体：model、approval_policy、sandbox_mode、profiles、instructions 等（`v2.rs:719-754`） |
| `ConfigLayerSource` | 配置层来源枚举：`Mdm`/`System`/`User`/`Project`/`SessionFlags`，含优先级排序（`v2.rs:471-539`） |
| `ConfigReadParams`/`ConfigReadResponse` | 配置读取，支持 include_layers 展开和 cwd 过滤 |
| `ConfigValueWriteParams`/`ConfigBatchWriteParams` | 配置写入：单值或批量，含 merge_strategy 和 expected_version 乐观锁 |
| `ConfigRequirements` | 需求约束：allowed approval policies/sandbox modes/web search modes、feature_requirements、residency |
| `ProfileV2` | 配置 profile 结构体：model、approval_policy、service_tier 等 |

### 8. 命令执行

| 类型 | 说明 |
|------|------|
| `CommandExecParams` | 独立命令执行（非 turn 内）：argv、process_id、tty、stream_stdin/stdout_stderr、timeout、sandbox_policy 等（`v2.rs:2381-2452`） |
| `CommandExecResponse` | 命令结果：exit_code、stdout、stderr |
| `CommandExecWriteParams` | 向运行中进程写入 stdin |
| `CommandExecTerminateParams` / `CommandExecResizeParams` | 终止/调整 PTY 大小 |
| `CommandExecOutputStream` | 输出流标签：`Stdout`/`Stderr` |
| `CommandAction` | 命令动作解析：`Read`/`ListFiles`/`Search`/`Unknown` |

### 9. 文件系统操作

| 类型 | 说明 |
|------|------|
| `FsReadFileParams`/`FsReadFileResponse` | 读取文件（base64 编码） |
| `FsWriteFileParams`/`FsWriteFileResponse` | 写入文件 |
| `FsCreateDirectoryParams` | 创建目录 |
| `FsGetMetadataParams`/`FsGetMetadataResponse` | 获取元数据（is_directory/is_file/created_at_ms/modified_at_ms） |
| `FsReadDirectoryParams`/`FsReadDirectoryResponse` | 读取目录条目 |
| `FsRemoveParams` / `FsCopyParams` | 删除/复制文件或目录 |
| `FsWatchParams`/`FsUnwatchParams`/`FsChangedNotification` | 文件系统监听与变更通知 |

### 10. 账号与认证

| 类型 | 说明 |
|------|------|
| `Account` | 账号类型：`ApiKey` 或 `Chatgpt`（含 email、plan_type） |
| `LoginAccountParams` | 登录参数：API Key、ChatGPT OAuth、ChatGPT Device Code、ChatGPT Auth Tokens（`v2.rs:1583-1615`） |
| `LoginAccountResponse` | 登录响应：各流程返回 login_id + auth_url 或 user_code |
| `ChatgptAuthTokensRefreshParams`/`Response` | ChatGPT token 刷新 |
| `GetAccountResponse` | 获取账号信息 |
| `GetAccountRateLimitsResponse` | 获取速率限制：含 `RateLimitSnapshot`（primary/secondary window + credits） |

### 11. 模型与协作模式

| 类型 | 说明 |
|------|------|
| `Model` | 模型描述：id、display_name、supported_reasoning_efforts、input_modalities 等（`v2.rs:1775-1792`） |
| `ModelListParams`/`ModelListResponse` | 模型列表：分页 + include_hidden 选项 |
| `CollaborationModeMask` | 协作模式预设：name + mode + model + reasoning_effort |

### 12. MCP 工具调用

| 类型 | 说明 |
|------|------|
| `McpServerStatus` | MCP 服务器状态：tools、resources、auth_status |
| `McpServerElicitationRequest` | MCP elicitation 请求：支持 `Form`（含 `McpElicitationSchema`）和 `Url` 两种模式 |
| `McpElicitationSchema` | 表单 schema：properties 包含 String/Number/Boolean/Enum 等原始类型 |
| `McpToolCallResult`/`McpToolCallError` | MCP 工具调用结果/错误 |

### 13. Hook 摘要

| 类型 | 说明 |
|------|------|
| `HookRunSummary` | Hook 执行摘要：event_name、handler_type、execution_mode、scope、status、entries 等（`v2.rs:431-445`） |
| `HookOutputEntry` | Hook 输出条目：kind（Warning/Stop/Feedback/Context/Error）+ text |
| 相关枚举 | `HookEventName`、`HookHandlerType`、`HookExecutionMode`、`HookScope`、`HookRunStatus` |

### 14. 实时音频（Experimental）

| 类型 | 说明 |
|------|------|
| `ThreadRealtimeStartParams`/`ThreadRealtimeStopParams` | 启动/停止实时会话 |
| `ThreadRealtimeAppendAudioParams`/`ThreadRealtimeAppendTextParams` | 追加音频/文本输入 |
| `ThreadRealtimeAudioChunk` | 音频块：base64 data、sample_rate、num_channels |
| 相关通知 | `ThreadRealtimeStartedNotification`、`ThreadRealtimeOutputAudioDeltaNotification` 等 |

### 15. 通知类型

服务端向客户端推送的通知约 30 种，主要包括：

- **线程生命周期**：`ThreadStartedNotification`、`ThreadStatusChangedNotification`、`ThreadClosedNotification`、`ThreadArchivedNotification`
- **Turn 生命周期**：`TurnStartedNotification`、`TurnCompletedNotification`
- **Item 进度**：`ItemStartedNotification`、`ItemCompletedNotification`
- **流式增量**：`AgentMessageDeltaNotification`、`CommandExecutionOutputDeltaNotification`、`FileChangeOutputDeltaNotification`、`ReasoningSummaryTextDeltaNotification`
- **审批请求**（server → client 反向调用）：`CommandExecutionRequestApprovalParams`、`FileChangeRequestApprovalParams`、`McpServerElicitationRequestParams`、`PermissionsRequestApprovalParams`
- **系统事件**：`AccountRateLimitsUpdatedNotification`、`AccountLoginCompletedNotification`、`ConfigWarningNotification`、`DeprecationNoticeNotification`

### 16. 插件与技能系统

| 类型 | 说明 |
|------|------|
| `SkillMetadata` | 技能元数据：name、description、interface、dependencies、path、scope、enabled |
| `SkillsListParams`/`SkillsListResponse` | 技能列表 |
| `PluginSummary`/`PluginDetail` | 插件概要/详情 |
| `PluginMarketplaceEntry` | 插件市场条目 |
| `PluginInstallParams`/`PluginUninstallParams` | 安装/卸载插件 |
| `DynamicToolSpec` | 动态工具定义：name、description、input_schema、defer_loading |

### 17. Apps 系统（Experimental）

| 类型 | 说明 |
|------|------|
| `AppInfo` | App 完整信息：id、name、branding、metadata、labels 等 |
| `AppsListParams`/`AppsListResponse` | App 列表 |
| `AppsConfig`/`AppConfig`/`AppToolConfig` | App 配置层级 |

## 辅助文件：`serde_helpers.rs`

`serde_helpers.rs`（`serde_helpers.rs:1-23`）提供两个函数：

- `deserialize_double_option<T>` / `serialize_double_option<T>`：对 `Option<Option<T>>` 类型的序列化支持

这解决了 JSON 中"字段缺失"（`Option` 外层为 `None`）与"字段显式为 null"（内层 `None`）的语义区分。在 `ThreadStartParams`、`ThreadResumeParams` 等类型的 `service_tier` 字段上使用，允许客户端显式清空 service tier 设置。

## `v2_enum_from_core!` 宏

> 源码位置：`v2.rs:100-127`

```rust
macro_rules! v2_enum_from_core {
    ( pub enum $Name:ident from $Src:path { $( $Variant:ident ),+ } ) => {
        #[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
        #[serde(rename_all = "camelCase")]
        #[ts(export_to = "v2/")]
        pub enum $Name { $( $Variant ),+ }
        // 自动生成 to_core() 方法和 From<CoreType> impl
    };
}
```

该宏在文件中被使用约 15 次，覆盖 `HookEventName`、`HookHandlerType`、`HookExecutionMode`、`HookScope`、`HookRunStatus`、`HookOutputEntryKind`、`ReviewDelivery`、`McpAuthStatus`、`ModelRerouteReason`、`NetworkApprovalProtocol`、`NetworkPolicyRuleAction`、`CommandExecutionSource`、`PermissionGrantScope` 等枚举。它确保所有简单枚举在 wire 协议上统一使用 camelCase，同时保持与 Core 层 snake_case/kebab-case 枚举的双向转换。

## 边界 Case 与注意事项

- **实验性 API 标注**：许多类型和字段通过 `#[experimental("...")]` 或 `#[experimental(nested)]` 标注为不稳定，运行时由 `ExperimentalApi` derive 宏控制是否在响应中包含这些字段。客户端不应依赖标记为 experimental 的字段稳定性。

- **`Thread.turns` 选择性填充**：`Thread` 结构体的 `turns` 字段仅在 `thread/resume`、`thread/rollback`、`thread/fork`、`thread/read`（且 `includeTurns=true`）时填充，其他场景为空列表（`v2.rs:3609-3613`）。

- **`DynamicToolSpec` 的向后兼容反序列化**：`expose_to_context`（已废弃）会被自动映射为 `defer_loading = !expose_to_context`（`v2.rs:592-613`）。

- **`ConfigLayerSource` 优先级排序**：配置层通过 `precedence()` 方法定义合并优先级（Mdm=0 < System=10 < User=20 < Project=25 < SessionFlags=30），高优先级层的设置覆盖低优先级（`v2.rs:528-538`）。

- **`ThreadResumeParams` 的三种恢复方式**：history > path > thread_id 的优先级确保 Codex Cloud 等场景可以绕过磁盘加载（`v2.rs:2641-2648`）。

- **`SandboxPolicy.WorkspaceWrite` 的 `exclude_tmpdir_env_var` 和 `exclude_slash_tmp`**：精细控制沙箱是否允许访问临时目录，防止沙箱逃逸。

- **审批请求是双向调用**：`CommandExecutionRequestApprovalParams` 等类型既是 server→client 的请求参数，也需要 client 通过对应的 Response 类型回复。这实现了 JSON-RPC 中的"server request"模式。