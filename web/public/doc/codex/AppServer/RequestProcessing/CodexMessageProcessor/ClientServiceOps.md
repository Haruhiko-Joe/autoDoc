# 客户端服务操作（ClientServiceOps）

## 概述与职责

`ClientServiceOps` 是 `CodexMessageProcessor`（位于 `codex-rs/app-server/src/codex_message_processor.rs`）中面向客户端的杂项服务操作集合。它涵盖了不属于线程/会话核心生命周期管理的各类 JSON-RPC 方法实现，包括：

- **命令执行**：在沙箱环境中生成一次性 shell 命令，支持 PTY、输出流式传输和动态工具注册
- **模糊文件搜索**：一次性搜索和持久会话式增量搜索两种模式
- **反馈上传**：收集 rollout 日志、SQLite 反馈日志和附件，通过 `CodexFeedback` 上传
- **平台设置**：Windows 沙箱权限配置（elevated/unelevated 模式）
- **Git 操作**：计算本地与远程的 diff
- **共享工具函数**：错误响应构建、输入校验、配置派生等

在系统层级中，此模块属于 **AppServer → RequestProcessing → CodexMessageProcessor** 路径下，与 MessageProcessor（请求路由）、BespokeEventHandling（事件翻译）和 ThreadStateManagement（线程状态跟踪）同级。`CodexMessageProcessor` 是整个 RPC 方法的实现体，本文档聚焦于其中非核心线程管理的服务操作部分。

## 关键流程

### 一次性命令执行流程（`exec_one_off_command`）

这是最复杂的服务操作，完整流程如下：

1. **参数校验**：检查 `command` 不为空、`size` 需要 `tty: true`、`disable_output_cap` 与 `output_bytes_cap` 互斥、`disable_timeout` 与 `timeout_ms` 互斥（`codex_message_processor.rs:1770-1825`）

2. **环境准备**：
   - 使用 `create_env()` 根据 shell 环境策略创建基础环境变量
   - 合并客户端传入的 `env_overrides`（支持设置和删除变量）
   - 确定工作目录（优先使用 `params.cwd`，否则回退到 `self.config.cwd`）

3. **网络代理启动**：如果配置了网络代理（`config.permissions.network`），在命令执行前启动受管网络代理（`codex_message_processor.rs:1861-1886`）

4. **沙箱策略计算**：
   - 若客户端指定了 `sandbox_policy`，验证其与服务端策略兼容（`can_set` 检查）
   - 从策略派生 `FileSystemSandboxPolicy` 和 `NetworkSandboxPolicy`
   - 未指定则使用服务端默认策略

5. **执行参数组装**：构建 `ExecParams`（包含 command、cwd、expiration、capture_policy、env、sandbox 等），调用 `build_exec_request` 生成最终的执行请求

6. **启动执行**：通过 `command_exec_manager.start()` 启动命令，传入 PTY 配置、流式 stdin/stdout 选项、输出字节上限等（`codex_message_processor.rs:1981-1998`）

### PTY 交互操作

启动后的命令通过三个简单委托方法与客户端交互：

- **`command_exec_write`**（`codex_message_processor.rs:2011-2024`）：向运行中的命令 PTY 写入数据
- **`command_exec_resize`**（`codex_message_processor.rs:2026-2039`）：调整 PTY 终端尺寸
- **`command_exec_terminate`**（`codex_message_processor.rs:2041-2054`）：终止运行中的命令

这三个方法均委托给 `CommandExecManager`，模式一致：成功时发送响应，失败时发送错误。

### 模糊文件搜索

提供两种搜索模式：

**一次性搜索**（`fuzzy_file_search`，`codex_message_processor.rs:7398-7440`）：
1. 如果提供了 `cancellation_token`，检查并取消同 token 的前一个搜索
2. 为当前搜索创建一个 `AtomicBool` 标志并注册到 `pending_fuzzy_searches`
3. 空查询直接返回空结果，否则调用 `run_fuzzy_file_search`
4. 搜索完成后清理 token 映射（仅在 flag 仍是当前请求的 flag 时删除，避免误删后续请求）

**会话式增量搜索**（三个方法协作）：
- `fuzzy_file_search_session_start`（`codex_message_processor.rs:7442-7477`）：校验 `session_id` 非空，调用 `start_fuzzy_file_search_session` 创建会话并存入 `fuzzy_search_sessions`
- `fuzzy_file_search_session_update`（`codex_message_processor.rs:7479-7507`）：查找会话并调用 `session.update_query()` 更新搜索词
- `fuzzy_file_search_session_stop`（`codex_message_processor.rs:7509-7523`）：从 map 中移除会话（`FuzzyFileSearchSession` 的 drop 自动清理资源）

### 反馈上传流程（`upload_feedback`）

`codex_message_processor.rs:7525-7648`

1. **前置检查**：`config.feedback_enabled` 为 false 时直接拒绝
2. **参数解析**：提取 `classification`、`reason`、`thread_id`、`include_logs`、`extra_log_files`
3. **日志收集**（当 `include_logs` 为 true 时）：
   - 先 flush `LogDbLayer`
   - 从 SQLite StateDb 查询该 thread 的反馈日志
   - 解析 rollout 路径作为附件
4. **合并附件**：rollout 文件 + `extra_log_files`
5. **上传**：通过 `spawn_blocking` 调用 `CodexFeedback.upload_feedback()`（阻塞 I/O 在独立线程执行）
6. **响应**：成功时返回 `FeedbackUploadResponse { thread_id }`

### Windows 沙箱设置（`windows_sandbox_setup_start`）

`codex_message_processor.rs:7650-7721`

1. **立即响应**：先发送 `WindowsSandboxSetupStartResponse { started: true }` 给客户端
2. **异步执行**：在 `tokio::spawn` 中：
   - 调用 `derive_config_for_cwd` 为目标 cwd 加载配置
   - 构建 `WindowsSandboxSetupRequest`（包含 mode、policy、cwd、env_map、codex_home 等）
   - 调用 `run_windows_sandbox_setup` 执行实际设置
3. **通知结果**：通过 `WindowsSandboxSetupCompletedNotification` 通知客户端成功或失败

支持两种模式：`Elevated`（需要管理员权限）和 `Unelevated`（无需提权）。

### Git Diff（`git_diff_to_origin`）

`codex_message_processor.rs:7377-7396`

简单封装 `codex_git_utils::git_diff_to_remote`：传入 cwd，返回 `{ sha, diff }`。失败时返回 `INVALID_REQUEST_ERROR_CODE`。

## 函数签名与参数说明

### 命令执行

#### `async fn exec_one_off_command(&self, request_id: ConnectionRequestId, params: CommandExecParams)`

生成一次性沙箱化 shell 命令。`CommandExecParams` 包含：

| 参数 | 类型 | 说明 |
|------|------|------|
| `command` | `String` | 要执行的 shell 命令，不可为空 |
| `process_id` | `Option<String>` | 客户端指定的进程标识 |
| `tty` | `bool` | 是否使用 PTY |
| `stream_stdin` | `bool` | 是否流式传输 stdin |
| `stream_stdout_stderr` | `bool` | 是否流式传输 stdout/stderr |
| `output_bytes_cap` | `Option<usize>` | 输出字节上限（与 `disable_output_cap` 互斥） |
| `disable_output_cap` | `bool` | 是否禁用输出上限 |
| `disable_timeout` | `bool` | 是否禁用超时（与 `timeout_ms` 互斥） |
| `timeout_ms` | `Option<i64>` | 超时毫秒数，必须非负 |
| `cwd` | `Option<PathBuf>` | 工作目录，默认为服务端 cwd |
| `env` | `Option<HashMap<String, Option<String>>>` | 环境变量覆盖（值为 None 表示删除） |
| `size` | `Option<TerminalSize>` | 终端尺寸（需 `tty: true`） |
| `sandbox_policy` | `Option<SandboxPolicy>` | 可选的沙箱策略覆盖 |

#### `async fn command_exec_write(&self, request_id, params: CommandExecWriteParams)`
向运行中命令的 PTY 写入数据。

#### `async fn command_exec_resize(&self, request_id, params: CommandExecResizeParams)`
调整运行中命令的 PTY 终端尺寸。

#### `async fn command_exec_terminate(&self, request_id, params: CommandExecTerminateParams)`
终止运行中的命令。

### 模糊文件搜索

#### `async fn fuzzy_file_search(&mut self, request_id, params: FuzzyFileSearchParams)`
一次性模糊搜索。参数：`query`（搜索词）、`roots`（搜索根目录列表）、`cancellation_token`（可选取消令牌）。

#### `async fn fuzzy_file_search_session_start(&mut self, request_id, params: FuzzyFileSearchSessionStartParams)`
启动持久搜索会话。参数：`session_id`（非空）、`roots`。

#### `async fn fuzzy_file_search_session_update(&mut self, request_id, params: FuzzyFileSearchSessionUpdateParams)`
更新会话搜索词。参数：`session_id`、`query`。

#### `async fn fuzzy_file_search_session_stop(&mut self, request_id, params: FuzzyFileSearchSessionStopParams)`
停止并清理搜索会话。参数：`session_id`。

### 反馈与平台

#### `async fn upload_feedback(&self, request_id, params: FeedbackUploadParams)`
上传用户反馈。参数：`classification`、`reason`（可选）、`thread_id`（可选）、`include_logs`、`extra_log_files`（可选额外日志文件路径列表）。

#### `async fn windows_sandbox_setup_start(&mut self, request_id, params: WindowsSandboxSetupStartParams)`
启动 Windows 沙箱配置。参数：`mode`（`Elevated`/`Unelevated`）、`cwd`（可选工作目录）。

#### `async fn git_diff_to_origin(&self, request_id, cwd: PathBuf)`
计算 cwd 相对远程的 git diff，返回 `{ sha, diff }`。

## 共享工具函数

### 错误响应构建器

| 函数 | 位置 | 说明 |
|------|------|------|
| `send_invalid_request_error` | `:5278` | 发送 `INVALID_REQUEST_ERROR_CODE` 错误 |
| `send_internal_error` | `:5309` | 发送 `INTERNAL_ERROR_CODE` 错误 |
| `send_marketplace_error` | `:5318` | 根据 `MarketplaceError` 变体映射到对应错误码 |
| `input_too_large_error` | `:5287` | 构建输入过大错误（含 `data` 字段：`max_chars`、`actual_chars`） |

### 输入校验

- **`validate_v2_input_limit(items: &[V2UserInput]) -> Result<(), JSONRPCErrorError>`**（`:5301`）：计算所有输入项的文本字符总数，超过 `MAX_USER_INPUT_TEXT_CHARS` 时返回 `input_too_large_error`
- **`validate_dynamic_tools(tools: &[ApiDynamicToolSpec]) -> Result<(), String>`**（`:8288`）：校验动态工具列表——名称非空无空白、不使用保留前缀 `mcp`/`mcp__`、无重复名、`input_schema` 可被解析

### 配置派生

- **`derive_config_from_params`**（`:8363`）：从三层覆盖源（`cli_overrides` < `request_overrides` < `typesafe_overrides`）构建有效配置。将 JSON 格式的 request overrides 转换为 TOML 后与 CLI overrides 合并
- **`derive_config_for_cwd`**（`:8393`）：在 `derive_config_from_params` 基础上额外支持 `fallback_cwd` 参数，用于按工作目录加载特定配置
- **`config_load_error`**（`:8265`）：将 `io::Error` 转换为 `JSONRPCErrorError`，特别处理 `CloudRequirementsLoadError`——提取 `errorCode`、`statusCode`，对认证错误添加 `"action": "relogin"` 提示
- **`cloud_requirements_load_error`**（`:8252`）：遍历错误链查找 `CloudRequirementsLoadError`

## 接口/类型定义

### `CodexMessageProcessor`（`:407-427`）

核心处理器结构体，持有所有服务操作所需的共享状态：

```rust
pub(crate) struct CodexMessageProcessor {
    auth_manager: Arc<AuthManager>,
    thread_manager: Arc<ThreadManager>,
    outgoing: Arc<OutgoingMessageSender>,
    config: Arc<Config>,
    cli_overrides: Arc<RwLock<Vec<(String, TomlValue)>>>,
    runtime_feature_enablement: Arc<RwLock<BTreeMap<String, bool>>>,
    cloud_requirements: Arc<RwLock<CloudRequirementsLoader>>,
    command_exec_manager: CommandExecManager,
    pending_fuzzy_searches: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    fuzzy_search_sessions: Arc<Mutex<HashMap<String, FuzzyFileSearchSession>>>,
    feedback: CodexFeedback,
    log_db: Option<LogDbLayer>,
    // ... 及其他字段
}
```

### `ApiVersion`（`:429-435`）

```rust
enum ApiVersion { V1, V2 }
```

默认为 `V2`，`V1` 标记为 `dead_code`。

## 边界 Case 与注意事项

- **参数互斥校验**：`exec_one_off_command` 严格检查 `disable_output_cap`/`output_bytes_cap` 和 `disable_timeout`/`timeout_ms` 不可同时设置；`size` 要求 `tty: true`
- **取消令牌的安全清理**：`fuzzy_file_search` 使用 `Arc::ptr_eq` 确保只清理自己注册的 flag，避免竞争条件下误删后续请求的 flag
- **反馈配置开关**：`upload_feedback` 在 `config.feedback_enabled` 为 false 时立即拒绝，不做任何日志收集
- **Windows 沙箱异步通知模式**：`windows_sandbox_setup_start` 先同步返回 `{ started: true }`，实际结果通过后续 `WindowsSandboxSetupCompletedNotification` 异步通知——客户端需要监听此通知
- **沙箱策略降级保护**：`exec_one_off_command` 中客户端请求的 `sandbox_policy` 必须通过 `can_set` 校验，防止提升权限
- **动态工具名称限制**：`validate_dynamic_tools` 禁止使用 `mcp` 和 `mcp__` 前缀，避免与 MCP 工具命名空间冲突
- **配置加载错误的认证重试提示**：`config_load_error` 会识别 `CloudRequirementsLoadError` 中的 `Auth` 错误码，在响应 data 中添加 `"action": "relogin"`，提示客户端重新登录