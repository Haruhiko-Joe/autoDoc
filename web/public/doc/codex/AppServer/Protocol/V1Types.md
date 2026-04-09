# V1Types — 旧版 v1 API 类型定义

## 概述与职责

V1Types 是 AppServer Protocol 中**旧版 v1 API 的参数与响应类型集合**，定义在 `codex-rs/app-server-protocol/src/protocol/v1.rs` 中。它位于 **AppServer → Protocol** 层级下，与同级的 v2 类型模块并存，为尚未迁移到 v2 协议的 IDE 客户端（VS Code、Cursor 等）提供向后兼容支持。

配套的 `mappers.rs` 文件提供了 `From<v1> → v2` 的类型转换实现，使得服务端内部可以统一使用 v2 类型处理请求，而对外仍接受 v1 格式的调用。

所有类型均派生了 `Serialize`、`Deserialize`、`JsonSchema`、`TS`，支持 JSON-RPC 序列化和 TypeScript 类型导出。

---

## 关键流程

### 初始化握手

1. 客户端发送 `InitializeParams`，携带 `ClientInfo`（客户端名称、标题、版本号）和可选的 `InitializeCapabilities`
2. `InitializeCapabilities` 允许客户端声明是否接受实验性 API（`experimental_api`），以及需要屏蔽的通知方法列表（`opt_out_notification_methods`）
3. 服务端返回 `InitializeResponse`，包含 user agent 字符串、`codex_home` 绝对路径、平台信息（`platform_family` 和 `platform_os`）

### 审批流程

当 Agent 执行需要用户确认的操作时，服务端通过两种审批类型向客户端发起确认请求：

- **ApplyPatchApprovalParams**：补丁审批，携带 `conversation_id`、`call_id`（与 `PatchApplyBeginEvent`/`PatchApplyEndEvent` 关联）、`file_changes` 文件变更映射、可选的 `reason` 和 `grant_root`（请求对某目录的持久写权限）
- **ExecCommandApprovalParams**：命令执行审批，携带 `conversation_id`、`call_id`（与 `ExecCommandBeginEvent`/`ExecCommandEndEvent` 关联）、`command` 命令数组、`cwd` 工作目录、`parsed_cmd` 解析后的命令结构

两者的响应均通过 `ReviewDecision` 枚举表达用户的批准/拒绝决策。

### v1 → v2 类型映射

`mappers.rs` 实现了 `From<v1::ExecOneOffCommandParams> for v2::CommandExecParams`（`codex-rs/app-server-protocol/src/protocol/mappers.rs:3-23`），将旧版一次性命令执行参数转换为 v2 格式：

- `command`、`cwd`、`sandbox_policy` 直接映射
- `timeout_ms` 从 `u64` 转换为 `i64`（溢出时回退到 60000）
- v2 新增的字段（`tty`、`stream_stdin`、`stream_stdout_stderr`、`env` 等）使用安全默认值（`false` / `None`）

---

## 类型定义

### 初始化相关

#### `InitializeParams`

| 字段 | 类型 | 说明 |
|------|------|------|
| `client_info` | `ClientInfo` | 客户端基本信息 |
| `capabilities` | `Option<InitializeCapabilities>` | 客户端能力声明 |

#### `ClientInfo`

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `String` | 客户端名称 |
| `title` | `Option<String>` | 可选的显示标题 |
| `version` | `String` | 客户端版本号 |

#### `InitializeCapabilities`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `experimental_api` | `bool` | `false` | 是否接收实验性 API |
| `opt_out_notification_methods` | `Option<Vec<String>>` | `None` | 需要屏蔽的通知方法名列表 |

#### `InitializeResponse`

| 字段 | 类型 | 说明 |
|------|------|------|
| `user_agent` | `String` | 服务端 UA 字符串 |
| `codex_home` | `AbsolutePathBuf` | `$CODEX_HOME` 绝对路径 |
| `platform_family` | `String` | 平台族（如 `"unix"`、`"windows"`） |
| `platform_os` | `String` | 操作系统（如 `"macos"`、`"linux"`） |

### 会话摘要相关

#### `GetConversationSummaryParams`

使用 `#[serde(untagged)]` 枚举，支持两种查询方式：

- **`RolloutPath`**：通过 `rolloutPath`（`PathBuf`）查询
- **`ThreadId`**：通过 `conversationId`（`ThreadId`）查询

#### `ConversationSummary`

| 字段 | 类型 | 说明 |
|------|------|------|
| `conversation_id` | `ThreadId` | 会话唯一标识 |
| `path` | `PathBuf` | 会话存储路径 |
| `preview` | `String` | 会话内容预览 |
| `timestamp` | `Option<String>` | 创建时间 |
| `updated_at` | `Option<String>` | 最后更新时间 |
| `model_provider` | `String` | 使用的模型提供商 |
| `cwd` | `PathBuf` | 会话工作目录 |
| `cli_version` | `String` | CLI 版本号 |
| `source` | `SessionSource` | 会话来源 |
| `git_info` | `Option<ConversationGitInfo>` | Git 仓库信息 |

#### `ConversationGitInfo`

| 字段 | 类型 | 说明 |
|------|------|------|
| `sha` | `Option<String>` | 当前 commit SHA |
| `branch` | `Option<String>` | 当前分支名 |
| `origin_url` | `Option<String>` | 远程仓库 URL |

> 注意：此结构使用 `#[serde(rename_all = "snake_case")]` 而非其他类型的 `camelCase`。

### 认证相关

#### `GetAuthStatusParams`

| 字段 | 类型 | 说明 |
|------|------|------|
| `include_token` | `Option<bool>` | 是否在响应中包含 token |
| `refresh_token` | `Option<bool>` | 是否刷新 token |

#### `GetAuthStatusResponse`

| 字段 | 类型 | 说明 |
|------|------|------|
| `auth_method` | `Option<AuthMode>` | 当前认证方式 |
| `auth_token` | `Option<String>` | 认证 token（仅 `include_token=true` 时返回） |
| `requires_openai_auth` | `Option<bool>` | 是否需要 OpenAI 认证 |

#### `LoginApiKeyParams`

| 字段 | 类型 | 说明 |
|------|------|------|
| `api_key` | `String` | API 密钥 |

### 审批相关

#### `ApplyPatchApprovalParams`

| 字段 | 类型 | 说明 |
|------|------|------|
| `conversation_id` | `ThreadId` | 所属会话 ID |
| `call_id` | `String` | 关联的工具调用 ID |
| `file_changes` | `HashMap<PathBuf, FileChange>` | 文件路径到变更内容的映射 |
| `reason` | `Option<String>` | 审批原因说明 |
| `grant_root` | `Option<PathBuf>` | 请求持久化写权限的目录根 |

#### `ExecCommandApprovalParams`

| 字段 | 类型 | 说明 |
|------|------|------|
| `conversation_id` | `ThreadId` | 所属会话 ID |
| `call_id` | `String` | 关联的工具调用 ID |
| `approval_id` | `Option<String>` | 审批回调标识符 |
| `command` | `Vec<String>` | 待执行的命令 |
| `cwd` | `PathBuf` | 命令工作目录 |
| `reason` | `Option<String>` | 审批原因 |
| `parsed_cmd` | `Vec<ParsedCommand>` | 解析后的命令结构 |

两个审批响应类型（`ApplyPatchApprovalResponse` 和 `ExecCommandApprovalResponse`）均只包含一个 `decision: ReviewDecision` 字段。

### 命令执行

#### `ExecOneOffCommandParams`

| 字段 | 类型 | 说明 |
|------|------|------|
| `command` | `Vec<String>` | 命令参数数组 |
| `timeout_ms` | `Option<u64>` | 超时时间（毫秒） |
| `cwd` | `Option<PathBuf>` | 工作目录 |
| `sandbox_policy` | `Option<SandboxPolicy>` | 沙箱策略 |

### Git Diff

#### `GitDiffToRemoteParams`

| 字段 | 类型 | 说明 |
|------|------|------|
| `cwd` | `PathBuf` | 工作目录 |

#### `GitDiffToRemoteResponse`

| 字段 | 类型 | 说明 |
|------|------|------|
| `sha` | `GitSha` | 远程 commit SHA |
| `diff` | `String` | diff 内容 |

### 用户配置

#### `UserSavedConfig`

| 字段 | 类型 | 说明 |
|------|------|------|
| `approval_policy` | `Option<AskForApproval>` | 审批策略 |
| `sandbox_mode` | `Option<SandboxMode>` | 沙箱模式 |
| `sandbox_settings` | `Option<SandboxSettings>` | 沙箱详细设置 |
| `forced_chatgpt_workspace_id` | `Option<String>` | 强制指定的 ChatGPT workspace |
| `forced_login_method` | `Option<ForcedLoginMethod>` | 强制登录方式 |
| `model` | `Option<String>` | 模型名称 |
| `model_reasoning_effort` | `Option<ReasoningEffort>` | 推理努力程度 |
| `model_reasoning_summary` | `Option<ReasoningSummary>` | 推理摘要模式 |
| `model_verbosity` | `Option<Verbosity>` | 模型输出详细度 |
| `tools` | `Option<Tools>` | 工具开关 |
| `profile` | `Option<String>` | 当前激活的 profile 名称 |
| `profiles` | `HashMap<String, Profile>` | 命名 profile 集合 |

#### `Profile`

Profile 允许用户保存不同的模型/策略预设，通过 `UserSavedConfig.profile` 切换。

| 字段 | 类型 | 说明 |
|------|------|------|
| `model` | `Option<String>` | 模型名称 |
| `model_provider` | `Option<String>` | 模型提供商 |
| `approval_policy` | `Option<AskForApproval>` | 审批策略 |
| `model_reasoning_effort` | `Option<ReasoningEffort>` | 推理努力程度 |
| `model_reasoning_summary` | `Option<ReasoningSummary>` | 推理摘要 |
| `model_verbosity` | `Option<Verbosity>` | 输出详细度 |
| `chatgpt_base_url` | `Option<String>` | ChatGPT 基础 URL |

#### `SandboxSettings`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `writable_roots` | `Vec<AbsolutePathBuf>` | `[]` | 沙箱内可写根目录列表 |
| `network_access` | `Option<bool>` | `None` | 是否允许网络访问 |
| `exclude_tmpdir_env_var` | `Option<bool>` | `None` | 是否排除 `$TMPDIR` 环境变量 |
| `exclude_slash_tmp` | `Option<bool>` | `None` | 是否排除 `/tmp` 目录 |

#### `Tools`

| 字段 | 类型 | 说明 |
|------|------|------|
| `web_search` | `Option<bool>` | 是否启用 web 搜索工具 |
| `view_image` | `Option<bool>` | 是否启用图片查看工具 |

### 其他

#### `InterruptConversationResponse`

| 字段 | 类型 | 说明 |
|------|------|------|
| `abort_reason` | `TurnAbortReason` | 中断原因 |

---

## v1 → v2 Mapper

`mappers.rs`（`codex-rs/app-server-protocol/src/protocol/mappers.rs:3-23`）实现了唯一的映射：

```rust
impl From<v1::ExecOneOffCommandParams> for v2::CommandExecParams
```

映射策略：
- **直接传递**：`command`、`cwd`（从 `Option` 直接传入）、`sandbox_policy`（通过 `.into()` 转换）
- **类型转换**：`timeout_ms` 从 `Option<u64>` 转为 `Option<i64>`，使用 `i64::try_from()` 并在溢出时回退到 `60_000`
- **安全默认值**：v2 新增的 `process_id`、`tty`、`stream_stdin`、`stream_stdout_stderr`、`output_bytes_cap`、`disable_output_cap`、`disable_timeout`、`env`、`size` 均设为 `None` 或 `false`

这确保了旧版客户端发送的一次性命令执行请求能被无缝转发到 v2 处理管线。

---

## 边界 Case 与注意事项

- **`ConversationGitInfo` 使用 `snake_case` 序列化**：与本文件其他所有类型的 `camelCase` 约定不同，`ConversationGitInfo` 使用 `#[serde(rename_all = "snake_case")]`，客户端需注意字段格式差异
- **`GetConversationSummaryParams` 是 untagged 枚举**：反序列化时 serde 会按枚举变体顺序依次尝试，先尝试 `RolloutPath`，再尝试 `ThreadId`
- **`grant_root` 语义不明确**：代码注释标注 "unclear if this is honored today"，表明该字段可能未完全实现
- **mapper 中的 timeout 溢出处理**：`u64` 超过 `i64::MAX` 时静默回退到 60 秒，不会报错
- **所有类型均为公开（`pub`）**：作为协议定义 crate，所有结构体和字段都是公开的，供 transport 层和 request processing 层直接使用