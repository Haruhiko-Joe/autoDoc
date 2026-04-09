# 入口点与 CLI 参数解析

## 概述与职责

本模块是 `codex-tui` crate 的入口点，负责三件事：

1. **二进制入口**（`main.rs`）：定义 `main()` 函数，解析命令行参数并调用 `run_main()`
2. **CLI 参数定义**（`cli.rs`）：通过 `Cli` 结构体声明所有 TUI 模式下的命令行标志
3. **启动引导**（`lib.rs` 中的 `run_main()`）：从 CLI 参数出发，完成配置加载、日志初始化、app-server 启动、onboarding 流程、会话恢复/fork 处理，最终启动 `App` 事件循环

在整体架构中，本模块属于 **TUI → AppOrchestrator** 层级。TUI 是终端交互界面的顶层 crate，而 AppOrchestrator 是其内部的应用状态机。本模块与同级的 ChatSurface、BottomPane、TerminalRuntime、Onboarding 等模块协作——它负责"把一切准备好"，然后把控制权交给 `App::run()` 进入主事件循环。

---

## 关键流程

### 1. 二进制启动流程（main.rs）

入口 `main()` 的执行路径非常简洁：

1. 通过 `arg0_dispatch_or_else()` 处理 argv[0] 分发（支持 symlink 多入口模式）
2. 使用 `clap` 解析 `TopCli` 结构体——它将通用的 `CliConfigOverrides`（`-c key=value` 覆盖）和 TUI 专用的 `Cli` 展平在一起
3. 将顶层 config_overrides 合并到 `Cli.config_overrides` 中（`splice` 插入到头部，保证优先级）
4. 调用 `run_main()`，传入 `Cli`、`arg0_paths`、默认 `LoaderOverrides`、无远程连接
5. 打印 token 使用统计（如果非零）

> 源码位置：`codex-rs/tui/src/main.rs:17-42`

### 2. run_main() 启动引导流程（lib.rs）

`run_main()` 是整个 TUI 应用的核心启动函数，签名如下：

```rust
pub async fn run_main(
    mut cli: Cli,
    arg0_paths: Arg0DispatchPaths,
    loader_overrides: LoaderOverrides,
    remote: Option<String>,
    remote_auth_token: Option<String>,
) -> std::io::Result<AppExitInfo>
```

其执行分为以下阶段：

#### 阶段一：解析策略标志

根据 CLI 标志组合确定 `sandbox_mode` 和 `approval_policy`（`lib.rs:638-653`）：

- `--full-auto`：设置 `SandboxMode::WorkspaceWrite` + `AskForApproval::OnRequest`
- `--dangerously-bypass-approvals-and-sandbox`（别名 `--yolo`）：设置 `SandboxMode::DangerFullAccess` + `AskForApproval::Never`
- 否则从 `--sandbox` 和 `--ask-for-approval` 独立取值

`--search` 标志会被映射为 `-c web_search="live"` 配置覆盖。

#### 阶段二：加载配置

1. 找到 `codex_home` 目录
2. 根据 `--cd` 参数（或当前目录）确定 `config_cwd`
3. 调用 `load_config_as_toml_with_cli_overrides()` 加载 `config.toml`，合并 `-c` 覆盖
4. 处理 `--oss` 模式：解析 provider 选择（LM Studio / Ollama），确定默认模型
5. 构建 `ConfigOverrides` 并调用 `load_config_or_exit()` 生成最终 `Config`
6. 检查 exec policy 警告，验证 login 限制，校验 `--add-dir` 合法性

#### 阶段三：初始化日志系统

在 `lib.rs:835-935` 配置多层 tracing 订阅器：

- **文件日志**：写入 `<log_dir>/codex-tui.log`，Unix 下权限 `0o600`，使用非阻塞 writer
- **反馈层**：`codex_feedback::CodexFeedback` 提供的 logger 和 metadata 层
- **State DB 层**：通过 `log_db::start()` 将日志写入状态数据库
- **OpenTelemetry 层**：可选的 tracing 和 logger 层，用于分布式追踪和分析

默认日志过滤器：`codex_core=info,codex_tui=info,codex_rmcp_client=info`，可通过 `RUST_LOG` 环境变量覆盖。

#### 阶段四：终端初始化与 Onboarding

进入 `run_ratatui_app()` 后（`lib.rs:956-1408`）：

1. 初始化 ratatui 终端（`tui::init()`），清屏
2. 创建 `TerminalRestoreGuard`（RAII 模式，确保退出时恢复终端）
3. 非 debug 构建下检查是否需要更新提示
4. 初始化会话日志
5. 如需 onboarding（首次运行或未登录），启动临时 app-server 并运行 onboarding 屏幕
6. onboarding 完成后根据结果重新加载 config

#### 阶段五：会话恢复 / Fork

当用户通过 `codex resume` 或 `codex fork` 启动时（`lib.rs:1130-1280`）：

1. 启动临时 app-server 用于会话查找
2. 根据 `resume_session_id`/`fork_session_id`（UUID 或名称）、`resume_last`/`fork_last`、`resume_picker`/`fork_picker` 三种模式查找目标会话
3. 如果恢复/fork 的会话 cwd 与当前不同，弹出 cwd 选择提示
4. 用选定的 cwd 重新加载配置

#### 阶段六：启动 App 事件循环

1. 根据 `--no-alt-screen` 和 `tui.alternate_screen` 配置决定是否使用 alternate screen buffer
2. 启动最终的 app-server（嵌入式或远程）
3. 调用 `App::run()`，传入 tui、app-server session、config、会话选择等全部上下文
4. 事件循环结束后恢复终端、记录会话结束、返回 `AppExitInfo`

---

## 函数签名与参数说明

### `run_main(cli, arg0_paths, loader_overrides, remote, remote_auth_token) -> std::io::Result<AppExitInfo>`

TUI 应用的公开入口函数。

| 参数 | 类型 | 说明 |
|------|------|------|
| `cli` | `Cli` | 解析后的 CLI 参数 |
| `arg0_paths` | `Arg0DispatchPaths` | argv[0] 分发路径（二进制位置信息） |
| `loader_overrides` | `LoaderOverrides` | 配置加载器的额外覆盖 |
| `remote` | `Option<String>` | 远程 app-server 的 WebSocket URL |
| `remote_auth_token` | `Option<String>` | 远程连接的认证 token |

返回 `AppExitInfo`，包含 token 使用统计、thread ID、退出原因等。

> 源码位置：`codex-rs/tui/src/lib.rs:616-953`

### `normalize_remote_addr(addr: &str) -> color_eyre::Result<String>`

验证并规范化远程 app-server 地址。要求格式为 `ws://host:port` 或 `wss://host:port`，不允许带 path、query 或 fragment，且端口必须显式指定。

> 源码位置：`codex-rs/tui/src/lib.rs:297-319`

### `determine_alt_screen_mode(no_alt_screen: bool, tui_alternate_screen: AltScreenMode) -> bool`

决定是否使用 alternate screen buffer。当 `--no-alt-screen` 显式传入时返回 `false`；否则根据配置的 `AltScreenMode`（`Always`/`Never`/`Auto`）决定——`Auto` 模式下检测 Zellij 终端复用器并自动禁用。

> 源码位置：`codex-rs/tui/src/lib.rs:1593-1606`

---

## 接口 / 类型定义

### `Cli` 结构体

使用 `clap::Parser` 派生的 CLI 参数定义，所有字段均为 `pub`。

| 字段 | 类型 | CLI 标志 | 说明 |
|------|------|----------|------|
| `prompt` | `Option<String>` | 位置参数 | 可选的初始 prompt |
| `images` | `Vec<PathBuf>` | `--image` / `-i` | 初始 prompt 附带的图片 |
| `model` | `Option<String>` | `--model` / `-m` | 指定模型名称 |
| `oss` | `bool` | `--oss` | 使用本地开源模型 provider |
| `oss_provider` | `Option<String>` | `--local-provider` | 指定本地 provider（lmstudio / ollama） |
| `config_profile` | `Option<String>` | `--profile` / `-p` | 配置文件 profile |
| `sandbox_mode` | `Option<SandboxModeCliArg>` | `--sandbox` / `-s` | 沙箱策略 |
| `approval_policy` | `Option<ApprovalModeCliArg>` | `--ask-for-approval` / `-a` | 审批策略 |
| `full_auto` | `bool` | `--full-auto` | 低摩擦自动执行模式 |
| `dangerously_bypass_approvals_and_sandbox` | `bool` | `--dangerously-bypass-approvals-and-sandbox` / `--yolo` | 跳过所有安全检查（极度危险） |
| `cwd` | `Option<PathBuf>` | `--cd` / `-C` | 指定工作目录 |
| `web_search` | `bool` | `--search` | 启用实时 web 搜索 |
| `add_dir` | `Vec<PathBuf>` | `--add-dir` | 额外可写目录 |
| `no_alt_screen` | `bool` | `--no-alt-screen` | 禁用 alternate screen（适用于 Zellij 等） |
| `resume_*` | 多个字段 | `#[clap(skip)]` | 内部字段，由顶层 `codex resume` 子命令设置 |
| `fork_*` | 多个字段 | `#[clap(skip)]` | 内部字段，由顶层 `codex fork` 子命令设置 |
| `config_overrides` | `CliConfigOverrides` | `#[clap(skip)]` | 从 `-c` 参数合并的配置覆盖 |

> 源码位置：`codex-rs/tui/src/cli.rs:7-120`

### `AppServerTarget` 枚举

```rust
pub(crate) enum AppServerTarget {
    Embedded,
    Remote { websocket_url: String, auth_token: Option<String> },
}
```

描述 app-server 的连接目标——嵌入式（进程内启动）或远程（WebSocket 连接）。

> 源码位置：`codex-rs/tui/src/lib.rs:249-256`

### `LoginStatus` 枚举

```rust
pub enum LoginStatus {
    AuthMode(AppServerAuthMode),
    NotAuthenticated,
}
```

表示当前用户的登录状态，决定是否需要展示 onboarding 登录屏幕。

> 源码位置：`codex-rs/tui/src/lib.rs:1608-1612`

### `AppExitInfo`（re-exported from `app` module）

`run_main()` 的返回值，包含 `token_usage`、`thread_id`、`thread_name`、`update_action` 和 `exit_reason` 等字段。

### `TerminalRestoreGuard`

RAII guard，确保在任何退出路径（包括 panic）下都能恢复终端状态。实现了 `Drop` trait，在析构时自动调用 `tui::restore()`。

> 源码位置：`codex-rs/tui/src/lib.rs:1545-1575`

---

## 配置项与默认值

| 配置项 | 来源 | 默认值 | 说明 |
|--------|------|--------|------|
| `--full-auto` | CLI | `false` | 等效于 `-a on-request --sandbox workspace-write` |
| `--yolo` | CLI | `false` | 等效于 `-a never --sandbox danger-full-access`，与 `--full-auto` / `-a` 互斥 |
| `--oss` | CLI | `false` | 使用本地模型 provider，默认模型由 provider 决定（如 `gpt-oss:20b`） |
| `--no-alt-screen` | CLI | `false` | 禁用 alternate screen buffer |
| `tui.alternate_screen` | config.toml | `Auto` | `Always` / `Never` / `Auto`（Auto 在 Zellij 中禁用） |
| `RUST_LOG` | 环境变量 | `codex_core=info,codex_tui=info,codex_rmcp_client=info` | 日志过滤器 |
| 日志文件权限 | 硬编码 | `0o600`（Unix） | 仅当前用户可读写 |

---

## 边界 Case 与注意事项

- **`--dangerously-bypass-approvals-and-sandbox`** 与 `--approval_policy` 和 `--full-auto` 互斥（`clap` 层面 `conflicts_with_all`），不可同时使用。
- **远程模式下的 auth token 安全**：`validate_remote_auth_token_transport()` 强制要求 auth token 只能通过 `wss://` 或本地回环 `ws://localhost` 传输，防止明文传输凭证。
- **resume/fork 的内部字段**（`resume_picker`、`fork_session_id` 等）使用 `#[clap(skip)]` 标注，不暴露为用户可见的 CLI 标志，仅由顶层 `codex resume`/`codex fork` 子命令内部设置。
- **OSS provider 选择取消**：当用户在 OSS provider 选择界面按取消时，返回 `"__CANCELLED__"` 哨兵值，`run_main()` 检测到后返回错误退出。
- **配置可能多次加载**：在 onboarding 完成（trust decision 或 login）后以及 resume/fork cwd 变更后，都会重新加载 config 以反映最新的持久化状态。
- **Zellij 兼容**：`determine_alt_screen_mode()` 在 `Auto` 模式下自动检测 Zellij 终端复用器，禁用 alternate screen 以保留 scrollback 功能。这是因为 Zellij 严格遵循 xterm 规范，在 alternate screen 中禁用 scrollback。
- **panic 处理**：`run_ratatui_app()` 在 panic hook 中先通过 `tracing::error!` 记录 panic 信息（便于在 UI 状态栏显示），再调用原有 hook 保留完整的 backtrace 报告。