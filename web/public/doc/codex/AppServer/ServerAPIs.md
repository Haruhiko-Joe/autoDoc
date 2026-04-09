# ServerAPIs — 辅助服务模块

## 概述与职责

ServerAPIs 是 AppServer 内部的一组辅助服务模块，为 IDE 扩展（VS Code、Cursor、Windsurf）和桌面应用提供通过 JSON-RPC 暴露的专用功能。这些模块覆盖了配置读写、文件系统操作、模糊文件搜索、Shell 命令执行、动态工具注册、模型列表、外部 Agent 配置迁移，以及消息来源过滤等能力。

在整体架构中，ServerAPIs 位于 **AppServer** 子系统内部，AppServer 由 CLI 的 `codex app` 子命令启动，依赖 Core（创建和管理 agent 会话）、Auth（JWT 验证）、Config（读取配置）和 Observability（上报指标）。ServerAPIs 中的各模块被 AppServer 的 JSON-RPC 路由层调用，将具体业务逻辑委托给 `codex-core`、`codex-exec-server`、`codex-file-search` 等底层 crate。

---

## 模块一览

| 模块文件 | 核心结构体/函数 | 职责 |
|---|---|---|
| `config_api.rs` | `ConfigApi` | 配置的 CRUD、实验特性开关、云端 requirements 读取 |
| `fs_api.rs` | `FsApi` | 文件读/写/删除/复制/目录创建/元数据查询 |
| `fs_watch.rs` | `FsWatchManager` | 文件变更监听，带去抖通知 |
| `fuzzy_file_search.rs` | `run_fuzzy_file_search` / `FuzzyFileSearchSession` | 一次性模糊搜索和持久会话搜索 |
| `command_exec.rs` | `CommandExecManager` | Shell 命令执行，支持 PTY、stdin 流式写入、resize/terminate |
| `dynamic_tools.rs` | `on_call_response` | 动态工具调用结果回传给 agent 会话 |
| `models.rs` | `supported_models` | 列出可用 LLM 模型及其元数据 |
| `external_agent_config_api.rs` | `ExternalAgentConfigApi` | 检测和导入外部 Agent 配置（如迁移自其他工具） |
| `filters.rs` | `compute_source_filters` / `source_kind_matches` | 按消息来源类型过滤线程 |

---

## 关键流程

### 1. 配置读写流程（ConfigApi）

`ConfigApi` 封装了整个配置生命周期：读取、单值写入、批量写入、实验特性开关设置，以及 requirements 查询。

**读取配置** (`read`)：
1. 接收 `ConfigReadParams`（包含可选的 `cwd`）
2. 委托 `ConfigService::read()` 从分层配置文件读取数据（`codex-rs/app-server/src/config_api.rs:161-165`）
3. 调用 `load_latest_config()` 构建最新 `Config` 对象
4. 遍历 `SUPPORTED_EXPERIMENTAL_FEATURE_ENABLEMENT`（apps、plugins、tool_search、tool_suggest、tool_call_mcp_elicitation），将各实验特性的启用状态注入到响应的 `features` 字段（`codex-rs/app-server/src/config_api.rs:167-186`）

**批量写入** (`batch_write`)：
1. 收集插件开关变更事件候选（`collect_plugin_enabled_candidates`）
2. 委托 `ConfigService::batch_write()` 执行写入
3. 触发插件 toggle 分析事件
4. 若 `reload_user_config` 为 true，通过 `UserConfigReloader` 通知所有活跃线程重新加载配置（`codex-rs/app-server/src/config_api.rs:217-238`）

**运行时特性覆盖优先级**：
`apply_runtime_feature_enablement()` 在应用运行时特性开关时，会跳过"受保护特性"——即在配置文件栈或云端 requirements 中已声明的 key。这确保了 **云端要求 > CLI 覆盖 > 运行时开关** 的优先级顺序（`codex-rs/app-server/src/config_api.rs:339-359`）。

### 2. 文件系统操作（FsApi）

`FsApi` 通过 `codex_exec_server::ExecutorFileSystem` trait 对象提供统一的文件系统抽象，默认使用 `Environment::default()` 获取文件系统实现。

支持的操作：
- **read_file**：读取文件内容，返回 base64 编码的 `data_base64`
- **write_file**：接受 base64 编码的数据写入文件
- **create_directory**：创建目录，`recursive` 默认为 `true`
- **get_metadata**：获取文件/目录元数据（是否为目录/文件、创建时间、修改时间）
- **read_directory**：列出目录内容
- **remove**：删除文件/目录，`recursive` 和 `force` 均默认为 `true`
- **copy**：复制文件或目录

所有 I/O 错误统一通过 `map_fs_error()` 映射：`InvalidInput` 映射为 `INVALID_REQUEST_ERROR_CODE`，其余为 `INTERNAL_ERROR_CODE`（`codex-rs/app-server/src/fs_api.rs:170-180`）。

### 3. 文件变更监听（FsWatchManager）

`FsWatchManager` 管理每个 WebSocket 连接的文件监听注册。

**watch 流程**：
1. 生成 UUID v7 作为 `watch_id`
2. 向底层 `FileWatcher` 注册监听路径
3. 启动 tokio 异步任务，使用 `DebouncedReceiver`（200ms 去抖间隔）合并文件变更事件
4. 变更路径经过规范化后，作为 `FsChanged` 通知发送给特定连接（`codex-rs/app-server/src/fs_watch.rs:118-188`）

**unwatch 流程**：
1. 通过 `(connection_id, watch_id)` 定位注册项
2. 发送终止信号并等待任务确认退出，确保 unwatch 响应后不再有通知发出（`codex-rs/app-server/src/fs_watch.rs:196-214`）

**连接关闭**：自动清理该连接所有 watch 注册项。

**去抖机制** (`DebouncedReceiver`)：首次收到事件后等待 `FS_CHANGED_NOTIFICATION_DEBOUNCE`（200ms），期间收到的所有事件合并为一批发出（`codex-rs/app-server/src/fs_watch.rs:33-69`）。

### 4. 模糊文件搜索（fuzzy_file_search）

提供两种搜索模式：

**一次性搜索** (`run_fuzzy_file_search`)：
1. 在 `spawn_blocking` 线程池中运行 `file_search::run()`
2. 限制最多 50 条结果（`MATCH_LIMIT`），最多使用 12 个线程
3. 结果按分数降序、路径升序排序

**会话式搜索** (`start_fuzzy_file_search_session` / `FuzzyFileSearchSession`)：
1. 创建 `file_search::create_session`，附带 `SessionReporterImpl` 回调
2. 调用 `update_query()` 可实时更新搜索词
3. Reporter 通过 `ServerNotification::FuzzyFileSearchSessionUpdated` 推送增量结果
4. 搜索完成时发送 `FuzzyFileSearchSessionCompleted` 通知
5. Session drop 时设置 `canceled` 标志终止后台搜索（`codex-rs/app-server/src/fuzzy_file_search.rs:112-116`）

Reporter 内部检查 `latest_query` 是否与快照的 query 一致，防止推送过时结果（`codex-rs/app-server/src/fuzzy_file_search.rs:178-184`）。

### 5. Shell 命令执行（CommandExecManager）

`CommandExecManager` 是最复杂的模块，管理所有正在运行的子进程。

**启动流程** (`start`)：
1. 若客户端未提供 `process_id`，自动生成递增整数 ID
2. TTY 或流式模式要求客户端提供 `process_id`
3. Windows 沙箱模式走特殊路径：不支持流式交互，直接通过 `codex_core::sandboxing::execute_env()` 同步执行
4. 非 Windows 路径根据参数决定 spawn 方式：
   - `tty=true`：`spawn_pty_process()`，创建伪终端
   - `stream_stdin=true`：`spawn_pipe_process()`，通过管道连接 stdin
   - 否则：`spawn_pipe_process_no_stdin()`
5. 启动后台 tokio 任务运行 `run_command()`（`codex-rs/app-server/src/command_exec.rs:143-306`）

**run_command 主循环**：
在 `tokio::select!` 中同时监听三个事件源：
- **control_rx**：接收来自客户端的 write/resize/terminate 控制消息
- **expiration**：超时（默认超时或 `CancellationToken`）触发时终止进程
- **exit_rx**：进程退出后收集 stdout/stderr 并发送最终 `CommandExecResponse`

超时退出码固定为 124（与 Unix `timeout` 命令行为一致）。

**输出流处理** (`spawn_process_output`)：
- 每个 stdout/stderr 流独立一个 tokio 任务
- 小块（≤8KiB）合并到 `OUTPUT_CHUNK_SIZE_HINT`（64KiB）后发送
- 支持 `output_bytes_cap` 限制总输出大小
- 流式模式下通过 `CommandExecOutputDelta` 通知实时推送 base64 编码的数据
- 进程退出后设定 `IO_DRAIN_TIMEOUT_MS` 超时收集残余输出

**控制操作**：
- `write`：向进程 stdin 写入数据或关闭 stdin
- `resize`：调整 PTY 终端大小（行×列必须 > 0）
- `terminate`：发送终止信号
- `connection_closed`：清理该连接的所有进程（发送 Terminate）

### 6. 动态工具注册（dynamic_tools）

`on_call_response()` 处理客户端对动态工具调用的响应：

1. 等待 `oneshot::Receiver<ClientRequestResult>` 收到客户端回复
2. 反序列化为 `DynamicToolCallResponse`
3. 转换为 `CoreDynamicToolResponse` 并通过 `Op::DynamicToolResponse` 提交给 agent 会话
4. 失败时使用 fallback 响应（`success: false`，包含错误文本）（`codex-rs/app-server/src/dynamic_tools.rs:14-53`）

特殊处理：若错误属于 turn transition（`is_turn_transition_server_request_error`），静默忽略不提交。

### 7. 模型列表（models）

`supported_models()` 通过 `ThreadManager::list_models()` 获取模型列表（使用 `OnlineIfUncached` 刷新策略），然后将每个 `ModelPreset` 转换为面向客户端的 `Model` 结构体，包含：
- `id`/`model`/`display_name`/`description`
- `upgrade`/`upgrade_info`：升级提示信息
- `supported_reasoning_efforts`：支持的推理力度选项
- `hidden`：是否在选择器中隐藏（由 `include_hidden` 参数控制过滤）
- `input_modalities`/`supports_personality`/`is_default`

> 源码位置：`codex-rs/app-server/src/models.rs:11-47`

### 8. 外部 Agent 配置迁移（ExternalAgentConfigApi）

提供两个操作帮助用户从其他 Agent 工具迁移配置：

- **detect**：扫描指定的工作目录（和可选的 home 目录），返回可迁移项列表
- **import**：执行选定的迁移项导入

迁移项类型（`ExternalAgentConfigMigrationItemType`）：
- `Config`：配置文件
- `Skills`：技能定义
- `AgentsMd`：AGENTS.md 指令文件
- `McpServerConfig`：MCP 服务器配置

底层委托给 `codex_core::external_agent_config::ExternalAgentConfigService`（`codex-rs/app-server/src/external_agent_config_api.rs:21-98`）。

### 9. 消息来源过滤（filters）

`compute_source_filters()` 根据客户端请求的 `ThreadSourceKind` 列表，决定查询策略：

- **纯交互源**（Cli、VsCode）：直接映射为 `CoreSessionSource` 枚举，无需后过滤
- **包含非交互源**（Exec、SubAgent 及其变体、Unknown 等）：返回空的 `allowed_sources`（即不做前置过滤），标记需要后过滤
- **无过滤条件或空列表**：默认返回 `INTERACTIVE_SESSION_SOURCES`

`source_kind_matches()` 用于后过滤阶段，逐一匹配 `CoreSessionSource` 与过滤条件，支持细粒度的 SubAgent 变体区分（Review、Compact、ThreadSpawn、Other）。

> 源码位置：`codex-rs/app-server/src/filters.rs:6-82`

---

## 函数签名与参数说明

### ConfigApi

```rust
pub(crate) async fn read(&self, params: ConfigReadParams) -> Result<ConfigReadResponse, JSONRPCErrorError>
pub(crate) async fn write_value(&self, params: ConfigValueWriteParams) -> Result<ConfigWriteResponse, JSONRPCErrorError>
pub(crate) async fn batch_write(&self, params: ConfigBatchWriteParams) -> Result<ConfigWriteResponse, JSONRPCErrorError>
pub(crate) async fn set_experimental_feature_enablement(&self, params: ExperimentalFeatureEnablementSetParams) -> Result<ExperimentalFeatureEnablementSetResponse, JSONRPCErrorError>
pub(crate) async fn config_requirements_read(&self) -> Result<ConfigRequirementsReadResponse, JSONRPCErrorError>
pub(crate) async fn load_latest_config(&self, fallback_cwd: Option<PathBuf>) -> Result<Config, JSONRPCErrorError>
```

### FsApi

```rust
pub(crate) async fn read_file(&self, params: FsReadFileParams) -> Result<FsReadFileResponse, JSONRPCErrorError>
pub(crate) async fn write_file(&self, params: FsWriteFileParams) -> Result<FsWriteFileResponse, JSONRPCErrorError>
pub(crate) async fn create_directory(&self, params: FsCreateDirectoryParams) -> Result<FsCreateDirectoryResponse, JSONRPCErrorError>
pub(crate) async fn get_metadata(&self, params: FsGetMetadataParams) -> Result<FsGetMetadataResponse, JSONRPCErrorError>
pub(crate) async fn read_directory(&self, params: FsReadDirectoryParams) -> Result<FsReadDirectoryResponse, JSONRPCErrorError>
pub(crate) async fn remove(&self, params: FsRemoveParams) -> Result<FsRemoveResponse, JSONRPCErrorError>
pub(crate) async fn copy(&self, params: FsCopyParams) -> Result<FsCopyResponse, JSONRPCErrorError>
```

### CommandExecManager

```rust
pub(crate) async fn start(&self, params: StartCommandExecParams) -> Result<(), JSONRPCErrorError>
pub(crate) async fn write(&self, request_id: ConnectionRequestId, params: CommandExecWriteParams) -> Result<CommandExecWriteResponse, JSONRPCErrorError>
pub(crate) async fn terminate(&self, request_id: ConnectionRequestId, params: CommandExecTerminateParams) -> Result<CommandExecTerminateResponse, JSONRPCErrorError>
pub(crate) async fn resize(&self, request_id: ConnectionRequestId, params: CommandExecResizeParams) -> Result<CommandExecResizeResponse, JSONRPCErrorError>
pub(crate) async fn connection_closed(&self, connection_id: ConnectionId)
```

### FsWatchManager

```rust
pub(crate) async fn watch(&self, connection_id: ConnectionId, params: FsWatchParams) -> Result<FsWatchResponse, JSONRPCErrorError>
pub(crate) async fn unwatch(&self, connection_id: ConnectionId, params: FsUnwatchParams) -> Result<FsUnwatchResponse, JSONRPCErrorError>
pub(crate) async fn connection_closed(&self, connection_id: ConnectionId)
```

---

## 接口/类型定义

### StartCommandExecParams

| 字段 | 类型 | 说明 |
|------|------|------|
| `outgoing` | `Arc<OutgoingMessageSender>` | 用于向客户端发送响应和通知 |
| `request_id` | `ConnectionRequestId` | 连接 ID + 请求 ID |
| `process_id` | `Option<String>` | 客户端指定的进程 ID（TTY/流式必填） |
| `exec_request` | `ExecRequest` | 命令、工作目录、环境变量、沙箱类型等 |
| `tty` | `bool` | 是否使用伪终端 |
| `stream_stdin` | `bool` | 是否开启 stdin 流式写入 |
| `stream_stdout_stderr` | `bool` | 是否流式推送 stdout/stderr |
| `output_bytes_cap` | `Option<usize>` | 输出字节数上限 |
| `size` | `Option<TerminalSize>` | 初始终端大小 |

### WatchKey（内部）

由 `(connection_id, watch_id)` 组成的复合键，确保 unwatch 操作仅对创建者连接生效。

### InternalProcessId（内部）

```rust
enum InternalProcessId {
    Generated(i64),   // 服务端自动生成
    Client(String),   // 客户端指定
}
```

---

## 配置项与默认值

| 常量 | 值 | 位置 | 说明 |
|------|-----|------|------|
| `MATCH_LIMIT` | 50 | `fuzzy_file_search.rs:18` | 模糊搜索最大返回结果数 |
| `MAX_THREADS` | 12 | `fuzzy_file_search.rs:19` | 搜索最大并行线程数 |
| `FS_CHANGED_NOTIFICATION_DEBOUNCE` | 200ms | `fs_watch.rs:31` | 文件变更通知去抖间隔 |
| `EXEC_TIMEOUT_EXIT_CODE` | 124 | `command_exec.rs:44` | 命令超时的退出码 |
| `OUTPUT_CHUNK_SIZE_HINT` | 64 KiB | `command_exec.rs:45` | 输出流块合并大小提示 |
| `SUPPORTED_EXPERIMENTAL_FEATURE_ENABLEMENT` | apps, plugins, tool_search, tool_suggest, tool_call_mcp_elicitation | `config_api.rs:45-51` | 可通过 API 动态开关的实验特性 |

FsApi 的 `remove` 和 `create_directory` 操作中，`recursive` 和 `force` 参数默认均为 `true`。

---

## 边界 Case 与注意事项

- **Windows 沙箱限制**：`CommandExecManager` 在 Windows 沙箱模式下不支持 TTY、流式 stdin/stdout/stderr 以及自定义 `outputBytesCap`，这些请求会被直接拒绝。
- **进程 ID 唯一性**：同一连接内不允许重复的 `process_id`，重复会返回 `INVALID_REQUEST_ERROR_CODE`。
- **watch 作用域**：`unwatch` 操作仅对创建该 watch 的连接生效，其他连接调用 unwatch 是无操作。
- **模糊搜索空查询**：会话模式下如果 query 为空字符串，reporter 返回空结果数组而非执行搜索。
- **特性覆盖优先级**：云端 requirements 中声明的特性不会被运行时开关覆盖，CLI 覆盖中声明的也不会被运行时开关覆盖。`set_experimental_feature_enablement` 仅接受 `SUPPORTED_EXPERIMENTAL_FEATURE_ENABLEMENT` 列表中的 key，其他会返回错误。
- **动态工具 turn transition**：如果客户端响应的错误属于 turn transition，`on_call_response` 会静默忽略而不向 agent 提交失败响应。
- **FsWatchManager 降级**：若底层 `FileWatcher::new()` 失败（如操作系统不支持），自动降级为 noop watcher 并记录警告。
- **base64 编解码**：`FsApi` 的 read/write 和 `CommandExecManager` 的 stdin write/stdout delta 均使用标准 base64 编码传输二进制数据。