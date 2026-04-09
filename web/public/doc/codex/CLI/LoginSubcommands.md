# LoginSubcommands — 登录/登出 CLI 子命令

## 概述与职责

`LoginSubcommands` 模块（`codex-rs/cli/src/login.rs`）实现了 `codex login` 和 `codex logout` CLI 子命令的全部逻辑。它是 **CLI** 层的一部分，负责用户身份认证的入口管理，支持多种认证流程并统一处理登录状态查询与登出操作。

在整体架构中，CLI 层是 `codex` 二进制的主入口，`LoginSubcommands` 是其中专门处理认证相关子命令的模块。它依赖 `codex_login` crate 提供底层认证实现（OAuth 服务器、设备码流程、API key 存储），依赖 `codex_core::config::Config` 读取配置（包括强制登录方式限制），并通过 `codex_app_server_protocol::AuthMode` 区分认证类型。

## 支持的认证流程

本模块提供 **四种** 登录方式，适配不同的使用场景：

| 流程 | 入口函数 | 适用场景 |
|------|----------|----------|
| ChatGPT 浏览器 OAuth | `run_login_with_chatgpt()` | 有桌面浏览器的交互式环境 |
| API Key 管道输入 | `run_login_with_api_key()` | CI/CD、脚本化环境 |
| OAuth 设备码 | `run_login_with_device_code()` | 无浏览器的远程/headless 机器 |
| 设备码 + 浏览器回退 | `run_login_with_device_code_fallback_to_browser()` | 默认登录（自动选择最佳方式） |

此外还有：
- `run_login_status()` — 查询当前登录状态
- `run_logout()` — 执行登出

## 关键流程 Walkthrough

### 统一的初始化模式

所有登录/登出函数遵循相同的初始化模式：

1. 调用 `load_config_or_exit()` 加载配置（`codex-rs/cli/src/login.rs:366-382`），它先解析 CLI `-c` 覆盖项，再通过 `Config::load_with_cli_overrides()` 加载完整配置。任何阶段失败都直接 `exit(1)`
2. 登录流程额外调用 `init_login_file_logging()` 初始化文件日志
3. 检查 `config.forced_login_method` 是否禁止了当前登录方式（见下文"强制登录限制"）
4. 委托给 `codex_login` crate 执行实际认证
5. 根据结果输出消息并以对应退出码退出

### ChatGPT 浏览器 OAuth 登录

`run_login_with_chatgpt()` (`codex-rs/cli/src/login.rs:131-159`)：

1. 检查是否被强制使用 API 登录（`ForcedLoginMethod::Api`），若是则拒绝并退出
2. 构造 `ServerOptions`，包含 `codex_home`、`CLIENT_ID`、可选的 `forced_chatgpt_workspace_id` 和凭证存储模式
3. 调用 `login_with_chatgpt()` 启动本地 OAuth 回调服务器
4. `print_login_server_start()` 输出本地服务器地址和浏览器认证 URL，并提示远程机器可用 `--device-auth`

### API Key 登录

`run_login_with_api_key()` (`codex-rs/cli/src/login.rs:161-188`)：

1. 检查是否被强制使用 ChatGPT 登录，若是则拒绝
2. 调用 `codex_login::login_with_api_key()` 存储 API key

API key 通过 `read_api_key_from_stdin()` (`codex-rs/cli/src/login.rs:190-215`) 读取：
- 检测 stdin 是否为终端——如果是，说明用户没有通过管道传入 key，打印用法提示并退出
- 从 stdin 读取全部内容，trim 后返回
- 典型用法：`printenv OPENAI_API_KEY | codex login --with-api-key`

### 设备码 + 浏览器回退登录（默认流程）

`run_login_with_device_code_fallback_to_browser()` (`codex-rs/cli/src/login.rs:256-314`) 是最复杂的流程：

1. 构造 `ServerOptions`，设置 `open_browser = false`（不自动打开浏览器）
2. 先尝试设备码流程 `run_device_code_login()`
3. 如果设备码返回 `ErrorKind::NotFound`（表示服务端未启用设备码功能），回退到浏览器登录：启动本地 `run_login_server()` 并等待完成
4. 其他错误则直接报错退出

这个设计确保了：即使设备码功能被 feature gate 限制，`codex login` 仍能正常工作。

### 登录状态查询

`run_login_status()` (`codex-rs/cli/src/login.rs:316-345`)：

1. 调用 `CodexAuth::from_auth_storage()` 从持久化存储读取认证信息
2. 根据 `AuthMode` 分支：
   - `ApiKey` — 显示脱敏后的 API key（通过 `safe_format_key()`）
   - `Chatgpt` / `ChatgptAuthTokens` — 显示 "Logged in using ChatGPT"
   - 未登录 — 显示 "Not logged in"，退出码为 1

### 登出

`run_logout()` (`codex-rs/cli/src/login.rs:347-364`)：

调用 `codex_login::logout()`，返回 `Ok(true)` 表示成功登出，`Ok(false)` 表示本来就没登录。

## 函数签名与参数说明

### `run_login_with_chatgpt(cli_config_overrides: CliConfigOverrides) -> !`

启动 ChatGPT 浏览器 OAuth 登录流程。函数不返回（`-> !`），以 `process::exit()` 终止。

### `run_login_with_api_key(cli_config_overrides: CliConfigOverrides, api_key: String) -> !`

使用提供的 API key 登录。

### `read_api_key_from_stdin() -> String`

从 stdin 读取 API key。若 stdin 是终端（未通过管道）或内容为空，打印错误并退出。

### `run_login_with_device_code(cli_config_overrides: CliConfigOverrides, issuer_base_url: Option<String>, client_id: Option<String>) -> !`

纯设备码登录流程。`issuer_base_url` 和 `client_id` 可选覆盖默认值。

### `run_login_with_device_code_fallback_to_browser(cli_config_overrides: CliConfigOverrides, issuer_base_url: Option<String>, client_id: Option<String>) -> !`

设备码优先、浏览器回退的复合登录流程。

### `run_login_status(cli_config_overrides: CliConfigOverrides) -> !`

查询并打印当前登录状态。已登录退出码为 0，未登录为 1。

### `run_logout(cli_config_overrides: CliConfigOverrides) -> !`

执行登出操作。

### `login_with_chatgpt(codex_home: PathBuf, forced_chatgpt_workspace_id: Option<String>, cli_auth_credentials_store_mode: AuthCredentialsStoreMode) -> std::io::Result<()>`

内部函数，启动本地 OAuth 服务器并阻塞等待认证完成。

## 强制登录方式限制

配置项 `forced_login_method`（类型 `ForcedLoginMethod`）可限制允许的登录方式：

| 配置值 | 效果 |
|--------|------|
| `ForcedLoginMethod::Api` | 禁用所有 ChatGPT/OAuth 相关登录，仅允许 API key |
| `ForcedLoginMethod::Chatgpt` | 禁用 API key 登录，仅允许 ChatGPT OAuth |
| `None` | 不限制，所有方式可用 |

被禁止时输出对应提示消息（`CHATGPT_LOGIN_DISABLED_MESSAGE` 或 `API_KEY_LOGIN_DISABLED_MESSAGE`）并以退出码 1 退出。

## 文件日志诊断机制

`init_login_file_logging()` (`codex-rs/cli/src/login.rs:46-105`) 为登录命令提供独立的文件日志：

- 日志写入 `<log_dir>/codex-login.log`，使用 append 模式
- Unix 系统上文件权限设为 `0o600`（仅所有者可读写），保护敏感认证信息
- 默认日志级别为 `codex_cli=info,codex_core=info,codex_login=info`，可通过 `RUST_LOG` 环境变量覆盖
- 使用 `tracing_appender::non_blocking` 异步写入，返回 `WorkerGuard` 保证刷新
- 初始化失败不会阻断登录流程，仅输出 warning 到 stderr

这个设计是刻意与 TUI 的完整日志栈分离的——TUI 包含 OpenTelemetry、反馈等会话级日志层，对一次性的 login 命令来说过重。独立的文件日志让技术支持可以要求用户提供 `codex-login.log` 来诊断认证问题。

## API Key 脱敏显示

`safe_format_key()` (`codex-rs/cli/src/login.rs:384-391`) 用于在状态查询中安全显示 API key：

- key 长度 ≤ 13 时，返回 `"***"`（完全隐藏）
- 否则显示前 8 位 + `***` + 后 5 位，如 `sk-proj-***ABCDE`

该函数有单元测试覆盖（`codex-rs/cli/src/login.rs:393-408`）。

## 边界 Case 与注意事项

- **所有公开函数返回类型为 `!`**（never type）：它们通过 `process::exit()` 终止进程，不会返回给调用者。这是 CLI 子命令的典型模式
- **设备码回退判断**：仅当错误类型为 `ErrorKind::NotFound` 时回退到浏览器，其他错误（网络故障、认证失败等）直接报错退出
- **stdin 终端检测**：`read_api_key_from_stdin()` 通过 `IsTerminal` trait 防止用户在交互式终端下误用 `--with-api-key`
- **日志守卫（`WorkerGuard`）**：各函数以 `_login_log_guard` 绑定守卫，确保其生命周期覆盖整个登录流程。若提前 drop 会导致日志丢失
- **`ServerOptions` 的 `clone()`**：在回退流程中，`opts` 被 clone 后分别用于设备码和浏览器流程（`codex-rs/cli/src/login.rs:281,289`）