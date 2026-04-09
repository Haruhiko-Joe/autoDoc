# ServerSession

## 概述与职责

ServerSession 模块是 TUI 层（AppOrchestrator 子系统）中与 App Server 通信的核心桥梁。它封装了对 `AppServerClient`（可以是进程内嵌入的，也可以是远程连接的）的所有 RPC 调用，为 TUI 提供了类型安全的异步 API，涵盖会话启动（bootstrap）、线程生命周期管理、对话轮次控制、实时语音交互、配置写入、模型和技能列表查询等能力。

在整体架构中，该模块位于 **TUI → AppOrchestrator** 层，是 TUI 事件循环与底层 Core 引擎之间的通信适配层。同级的兄弟模块包括 ChatSurface（聊天视窗）、BottomPane（输入与弹窗）、TerminalRuntime（终端基础设施）等。

本模块由两个源文件组成：
- `app_server_session.rs`：主体会话管理逻辑
- `app_server_approval_conversions.rs`：App Server 协议类型与 Core 协议类型之间的审批/权限转换

## 关键流程

### 1. Bootstrap 流程

Bootstrap 是 TUI 启动时的初始化序列，负责获取账户信息、可用模型列表和速率限制，返回 `AppServerBootstrap` 结构体供上层使用。

1. 调用 `GetAccount` RPC 获取当前账户信息（API Key 或 ChatGPT 账户）（`app_server_session.rs:171-182`）
2. 调用 `ModelList` RPC 获取所有可用模型（含隐藏模型），将 `ApiModel` 转换为内部 `ModelPreset`（`app_server_session.rs:183-200`）
3. 确定默认模型：优先使用配置中指定的模型 → 模型列表中标记为 `is_default` 的 → 列表中第一个模型（`app_server_session.rs:201-211`）
4. 根据账户类型解析认证模式、邮箱、状态显示、反馈受众等信息；OpenAI 员工邮箱会被识别为内部反馈受众（`app_server_session.rs:213-259`）
5. 如果账户需要 OpenAI 认证且拥有 ChatGPT 账户，额外获取速率限制快照（`app_server_session.rs:260-278`）

### 2. 线程生命周期管理

线程（Thread）是 Agent 对话的载体。模块提供三种创建线程的方式：

- **`start_thread`**：创建全新线程（`app_server_session.rs:298-313`）
- **`resume_thread`**：恢复已有线程，加载历史对话轮次（`app_server_session.rs:315-335`）
- **`fork_thread`**：从已有线程分支出新线程，用于回溯场景（`app_server_session.rs:337-357`）

三者都返回 `AppServerStartedThread`，内含 `ThreadSessionState`（运行时状态）和历史 `Turn` 列表。参数构造由一组 `*_params_from_config` 辅助函数完成，它们从 `Config` 中提取模型、审批策略、沙箱策略等配置。

**Embedded vs Remote 模式**：通过 `ThreadParamsMode` 枚举区分。Embedded 模式（进程内 App Server）会传递本地 `cwd` 和 `model_provider`；Remote 模式仅在显式设置了 `remote_cwd_override` 时传递 `cwd`，且不传递 `model_provider`，由远端服务自行决定。（`app_server_session.rs:129-142`, `916-927`）

### 3. 对话轮次控制

- **`turn_start`**：提交一轮用户输入，携带完整的策略参数（审批策略、沙箱策略、模型、推理力度、协作模式等）（`app_server_session.rs:414-452`）
- **`turn_interrupt`**：中断正在执行的轮次（`app_server_session.rs:454-472`）
- **`turn_steer`**：在轮次执行中注入额外用户输入进行引导（`app_server_session.rs:474-491`）

### 4. 协议类型转换（Approval Conversions）

`app_server_approval_conversions.rs` 提供两个转换函数，桥接 App Server 协议与 Core 协议的类型差异：

1. **`network_approval_context_to_core`**：将 `AppServerNetworkApprovalContext` 转换为 Core 的 `NetworkApprovalContext`，映射 Http/Https/Socks5Tcp/Socks5Udp 四种协议枚举（`app_server_approval_conversions.rs:9-29`）
2. **`granted_permission_profile_from_request`**：将 Core 的 `RequestPermissionProfile` 转换为 App Server 的 `GrantedPermissionProfile`，包含网络权限（enabled）和文件系统权限（read/write 路径列表）（`app_server_approval_conversions.rs:31-45`）

## 核心类型定义

### `AppServerSession`

会话主体，持有 App Server 客户端和请求 ID 分配器。

| 字段 | 类型 | 说明 |
|------|------|------|
| `client` | `AppServerClient` | 底层客户端，`InProcess` 或 `Remote` 变体 |
| `next_request_id` | `i64` | 单调递增的请求 ID 计数器 |
| `remote_cwd_override` | `Option<PathBuf>` | 远程模式下的工作目录覆盖 |

> 源码位置：`app_server_session.rs:104-108`

### `ThreadSessionState`

每个线程的运行时状态快照，在线程启动/恢复/分支时从服务端响应中构建。

| 字段 | 类型 | 说明 |
|------|------|------|
| `thread_id` | `ThreadId` | 线程唯一标识 |
| `forked_from_id` | `Option<ThreadId>` | 若为 fork 线程，记录源线程 ID |
| `thread_name` | `Option<String>` | 用户可见的线程名称 |
| `model` | `String` | 当前使用的模型标识 |
| `model_provider_id` | `String` | 模型提供商标识 |
| `service_tier` | `Option<ServiceTier>` | 服务层级 |
| `approval_policy` | `AskForApproval` | 工具调用审批策略 |
| `approvals_reviewer` | `ApprovalsReviewer` | 审批审阅者（User 或其他） |
| `sandbox_policy` | `SandboxPolicy` | 沙箱执行策略 |
| `cwd` | `PathBuf` | 工作目录 |
| `reasoning_effort` | `Option<ReasoningEffort>` | 推理力度 |
| `history_log_id` | `u64` | 消息历史日志 ID |
| `history_entry_count` | `u64` | 历史条目数量 |
| `network_proxy` | `Option<SessionNetworkProxyRuntime>` | 网络代理运行时 |
| `rollout_path` | `Option<PathBuf>` | 灰度发布路径 |

> 源码位置：`app_server_session.rs:110-127`

### `AppServerBootstrap`

Bootstrap 阶段的返回结果，包含认证信息、默认模型、可用模型列表、速率限制等。

| 字段 | 类型 | 说明 |
|------|------|------|
| `account_auth_mode` | `Option<AuthMode>` | 账户认证模式（ApiKey / Chatgpt） |
| `account_email` | `Option<String>` | ChatGPT 账户邮箱 |
| `default_model` | `String` | 默认选用的模型 |
| `available_models` | `Vec<ModelPreset>` | 可用模型列表 |
| `rate_limit_snapshots` | `Vec<RateLimitSnapshot>` | 速率限制快照 |
| `has_chatgpt_account` | `bool` | 是否拥有 ChatGPT 账户 |
| `feedback_audience` | `FeedbackAudience` | 反馈受众（External / OpenAiEmployee） |

> 源码位置：`app_server_session.rs:91-102`

### `AppServerStartedThread`

线程启动/恢复/分支操作的返回结果。

| 字段 | 类型 | 说明 |
|------|------|------|
| `session` | `ThreadSessionState` | 线程运行时状态 |
| `turns` | `Vec<Turn>` | 历史对话轮次 |

> 源码位置：`app_server_session.rs:144-147`

## 函数签名

### `AppServerSession` 方法

#### `new(client: AppServerClient) -> Self`
创建新会话，请求 ID 从 1 开始。

#### `with_remote_cwd_override(self, remote_cwd_override: Option<PathBuf>) -> Self`
Builder 风格方法，设置远程工作目录覆盖。

#### `is_remote() -> bool`
判断底层客户端是否为远程连接。

#### `bootstrap(&mut self, config: &Config) -> Result<AppServerBootstrap>`
执行完整的 TUI 初始化流程，获取账户、模型列表和速率限制。

#### `next_event(&mut self) -> Option<AppServerEvent>`
从客户端接收下一个服务端推送事件（通知/流式更新）。

#### `start_thread / resume_thread / fork_thread`
创建、恢复或分支线程，返回 `AppServerStartedThread`。

#### `turn_start(...) -> Result<TurnStartResponse>`
提交一轮用户输入。参数众多（14 个），涵盖线程 ID、输入内容、工作目录、审批策略、沙箱策略、模型、推理力度、协作模式、人格、输出 schema 等。

#### `turn_interrupt(thread_id, turn_id) -> Result<()>`
中断指定轮次的执行。

#### `turn_steer(thread_id, turn_id, items) -> Result<TurnSteerResponse>`
向正在执行的轮次注入新输入。注意此方法返回 `TypedRequestError` 而非通用 `Result`。

#### `thread_list / thread_loaded_list / thread_read`
线程查询：列表、已加载列表（用于发现子 Agent 线程）、读取单个线程详情。

#### `thread_set_name / thread_unsubscribe / thread_compact_start / thread_shell_command / thread_background_terminals_clean / thread_rollback`
线程操作：重命名、取消订阅、压缩、执行 shell 命令、清理后台终端、回滚轮次。

#### `review_start(thread_id, review_request) -> Result<ReviewStartResponse>`
启动代码审查，支持 UncommittedChanges / BaseBranch / Commit / Custom 四种目标。

#### `skills_list(params) -> Result<SkillsListResponse>`
查询可用技能列表。

#### `reload_user_config() -> Result<()>`
通过发送空的 `ConfigBatchWrite`（`reload_user_config: true`）触发服务端重新加载用户配置。

#### `thread_realtime_start / thread_realtime_audio / thread_realtime_text / thread_realtime_stop`
实时语音会话管理：启动、发送音频帧、发送文本、停止。

#### `reject_server_request / resolve_server_request`
响应服务端发起的请求（如审批请求）：拒绝或解决。

#### `shutdown(self) -> io::Result<()>`
关闭底层客户端连接。

### 模块级辅助函数

#### `status_account_display_from_auth_mode(auth_mode, plan_type) -> Option<StatusAccountDisplay>`
根据认证模式和计划类型生成状态栏显示信息。（`app_server_session.rs:754-768`）

#### `model_preset_from_api_model(model: ApiModel) -> ModelPreset`
将 API 模型对象转换为 TUI 内部的 `ModelPreset`，处理模型升级信息、推理力度预设等。（`app_server_session.rs:780-822`）

#### `app_server_rate_limit_snapshots_to_core(response) -> Vec<RateLimitSnapshot>`
将 App Server 的速率限制响应转换为 Core 协议格式，合并主限制和按 `limit_id` 索引的附加限制。（`app_server_session.rs:1101-1114`）

## 配置项与默认值

- 请求 ID 从 `1` 开始，每次调用单调递增（`app_server_session.rs:747-751`）
- `thread_start_params_from_config` 会设置 `persist_extended_history: true` 和 `ephemeral` 标志（来自 `config.ephemeral`）（`app_server_session.rs:856-873`）
- 模型列表查询默认 `include_hidden: Some(true)`，获取所有模型包括隐藏模型（`app_server_session.rs:189`）
- Review 请求的交付方式固定为 `ReviewDelivery::Inline`（`app_server_session.rs:611`）
- `reload_user_config` 通过发送空编辑列表 + `reload_user_config: true` 的 `ConfigBatchWrite` 实现（`app_server_session.rs:635-639`）

## 边界 Case 与注意事项

- **Embedded vs Remote 行为差异**：Remote 模式下不传递 `model_provider`（由远端决定），`cwd` 仅在显式设置 `remote_cwd_override` 时传递。这意味着远程会话如果未设置 cwd 覆盖，将使用服务端默认工作目录。
- **速率限制获取失败不阻断启动**：Bootstrap 中如果 `GetAccountRateLimits` 调用失败，仅打印 warn 日志并返回空列表，不影响整个 bootstrap 流程（`app_server_session.rs:271-274`）
- **`turn_steer` 的错误类型不同**：与其他方法返回 `color_eyre::Result` 不同，`turn_steer` 返回 `Result<_, TypedRequestError>`，调用方需要单独处理（`app_server_session.rs:479`）
- **`network_proxy` 初始化为 `None`**：`ThreadSessionState` 创建时 `network_proxy` 字段始终为 `None`，由上层后续设置（`app_server_session.rs:1096`）
- **历史记录元数据**：线程状态创建时会异步查询 `message_history::history_metadata`，获取日志 ID 和条目数，条目数超过 `u64::MAX` 时取最大值（`app_server_session.rs:1079-1080`）
- **OpenAI 员工检测**：通过邮箱后缀 `@openai.com` 判断，影响反馈受众类型（`app_server_session.rs:232-233`）