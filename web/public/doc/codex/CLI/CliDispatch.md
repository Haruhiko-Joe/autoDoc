# CliDispatch — 命令行入口与子命令分发

## 概述与职责

CliDispatch 是整个 Codex 系统的**命令行入口**，即用户运行 `codex` 二进制时最先执行的代码。它位于系统架构的 **CLI** 层，向上对接用户的终端输入，向下将请求分发到 TUI（交互模式）、codex-exec（非交互模式）、AppServer、MCP Server、Cloud Tasks 等各个子系统。

在同级兄弟模块中，**Core** 负责 agent 编排引擎，**TUI** 负责终端交互界面，而 CLI 则是将两者串联的"路由器"——解析用户意图后把控制权交给正确的处理器。

该模块的核心职责包括：

1. **定义顶层 clap 解析器**（`MultitoolCli`），声明约 17 个子命令
2. **中央 dispatch match**：根据解析出的子命令路由到对应的 handler crate
3. **配置覆盖传播**：将根级 `-c key=value` 和 `--enable`/`--disable` feature flag 向下传递给各子命令
4. **远程模式管理**：处理 `--remote` WebSocket 连接选项，并在不支持远程的子命令中拒绝该模式
5. **退出与更新处理**：TUI 退出后打印 token 用量、session 恢复命令，并执行自动更新

## 关键流程

### 1. 启动入口与 arg0 分发

程序从 `main()` 函数开始（`codex-rs/cli/src/main.rs:613`），调用 `arg0_dispatch_or_else()` —— 这是一个多工具二进制分发机制，根据可执行文件名（argv[0]）决定是否直接转发到子工具。如果 arg0 没有匹配任何特殊名称，则进入 `cli_main()`。

```rust
// codex-rs/cli/src/main.rs:613-618
fn main() -> anyhow::Result<()> {
    arg0_dispatch_or_else(|arg0_paths: Arg0DispatchPaths| async move {
        cli_main(arg0_paths).await?;
        Ok(())
    })
}
```

### 2. CLI 解析与子命令路由

`cli_main()` 使用 `clap::Parser` 解析 `MultitoolCli` 结构体（`codex-rs/cli/src/main.rs:73-88`）。该结构体包含：

- `config_overrides`：根级 `-c key=value` 配置覆盖
- `feature_toggles`：`--enable` / `--disable` feature flag
- `remote`：`--remote` WebSocket 地址和认证 token 环境变量
- `interactive`：TUI 相关的所有参数（model、prompt、sandbox-mode 等）
- `subcommand`：可选的子命令枚举

解析完成后，feature toggle 被折叠成 `features.<name>=true/false` 格式并合入 `config_overrides`（`codex-rs/cli/src/main.rs:630-631`），然后进入 `match subcommand` 中央分发逻辑（`codex-rs/cli/src/main.rs:635`）。

### 3. 默认路径——交互式 TUI

当没有子命令时（`subcommand: None`），CLI 启动交互式 TUI：

1. 合并配置覆盖到 `interactive.config_overrides`
2. 调用 `run_interactive_tui()` 启动 TUI 主循环（`codex-rs/cli/src/main.rs:1298-1350`）
3. TUI 启动前会检测终端类型——如果 `TERM=dumb` 且 stdin/stderr 不是 TTY，直接拒绝启动
4. 处理 `--remote` 选项：规范化 WebSocket 地址、从环境变量读取认证 token
5. TUI 退出后调用 `handle_app_exit()` 处理退出信息和可选的自动更新

### 4. 配置覆盖传播机制

每个子命令在分发前都会调用 `prepend_config_flags()`（`codex-rs/cli/src/main.rs:1235-1242`），将根级配置覆盖插入到子命令自身覆盖列表的**前面**。这确保了子命令级的覆盖优先级高于根级：

```rust
fn prepend_config_flags(
    subcommand_config_overrides: &mut CliConfigOverrides,
    cli_config_overrides: CliConfigOverrides,
) {
    subcommand_config_overrides
        .raw_overrides
        .splice(0..0, cli_config_overrides.raw_overrides);
}
```

### 5. 远程模式校验

`--remote` 参数仅支持交互式 TUI 命令（默认模式、resume、fork）。所有其他子命令在分发前都会调用 `reject_remote_mode_for_subcommand()`（`codex-rs/cli/src/main.rs:1244-1260`），如果检测到 `--remote` 或 `--remote-auth-token-env` 则直接报错退出。

## 子命令清单

`Subcommand` 枚举（`codex-rs/cli/src/main.rs:90-155`）定义了以下子命令：

| 子命令 | 别名 | 说明 | 分发目标 |
|--------|------|------|----------|
| `exec` | `e` | 非交互式运行 agent | `codex_exec::run_main` |
| `review` | - | 非交互式代码审查 | `codex_exec::run_main`（包装为 `ExecCommand::Review`） |
| `login` | - | 管理登录认证 | `codex_cli::login` 模块 |
| `logout` | - | 清除认证凭据 | `codex_cli::login::run_logout` |
| `mcp` | - | 管理外部 MCP 服务器 | `mcp_cli.run()` |
| `mcp-server` | - | 以 MCP 服务器模式启动 | `codex_mcp_server::run_main` |
| `app-server` | - | 运行/管理 app server | `codex_app_server::run_main_with_transport` |
| `app` | - | 启动桌面应用（仅 macOS） | `app_cmd::run_app` |
| `completion` | - | 生成 shell 补全脚本 | `clap_complete::generate` |
| `sandbox` | - | 在沙箱中运行命令 | `codex_cli::debug_sandbox` |
| `debug` | - | 调试工具 | 内部子命令分发 |
| `execpolicy` | - | 执行策略检查（隐藏） | `codex_execpolicy` |
| `apply` | `a` | 应用 agent 生成的 diff | `codex_chatgpt::run_apply_command` |
| `resume` | - | 恢复之前的会话 | TUI（通过 `finalize_resume_interactive`） |
| `fork` | - | 分叉之前的会话 | TUI（通过 `finalize_fork_interactive`） |
| `cloud` | `cloud-tasks` | 浏览/管理 Codex Cloud 任务 | `codex_cloud_tasks::run_main` |
| `features` | - | 查看/切换 feature flag | 内部实现 |
| `responses-api-proxy` | - | 运行 responses API 代理（隐藏） | `codex_responses_api_proxy::run_main` |
| `stdio-to-uds` | - | stdio 到 Unix socket 中继（隐藏） | `codex_stdio_to_uds::run` |

## 函数签名与参数说明

### `MultitoolCli`（顶层 CLI 结构体）

```
codex [OPTIONS] [PROMPT]
codex [OPTIONS] <COMMAND> [ARGS]
```

全局选项（通过 `CliConfigOverrides`）：
- `-c key=value`：任意配置覆盖（可重复）
- `--enable <FEATURE>`：启用指定 feature flag（可重复）
- `--disable <FEATURE>`：禁用指定 feature flag（可重复）
- `--remote <ADDR>`：连接到远程 app server WebSocket（`ws://` 或 `wss://`）
- `--remote-auth-token-env <ENV_VAR>`：指定包含 bearer token 的环境变量名

> 源码位置：`codex-rs/cli/src/main.rs:73-88`

### `FeatureToggles`

运行时 feature flag 开关。`--enable foo` 等价于 `-c features.foo=true`。会通过 `is_known_feature_key()` 校验 feature 名称合法性，未知的 feature 名称会导致立即报错。

> 源码位置：`codex-rs/cli/src/main.rs:533-579`

### `handle_app_exit(exit_info: AppExitInfo) -> anyhow::Result<()>`

处理 TUI 退出后的收尾工作：
1. 如果 `ExitReason::Fatal`，打印错误并 `exit(1)`
2. 打印 token 用量统计
3. 如果有 `thread_id`，打印恢复会话的命令（`codex resume <id>`）
4. 如果 TUI 触发了更新操作，执行 `run_update_action()`

> 源码位置：`codex-rs/cli/src/main.rs:465-483`

### `run_update_action(action: UpdateAction) -> anyhow::Result<()>`

执行二进制更新。在 Windows 上通过 `cmd.exe /C` 运行，在 Unix/WSL 上通过 `wsl_paths::normalize_for_wsl()` 规范化路径后直接执行。

> 源码位置：`codex-rs/cli/src/main.rs:486-517`

## 接口/类型定义

### `SeatbeltCommand` / `LandlockCommand` / `WindowsCommand`

在 `codex-rs/cli/src/lib.rs` 中定义的沙箱命令结构体，分别对应 macOS Seatbelt、Linux Landlock/Bubblewrap、Windows 受限 Token 三种沙箱后端。共同参数：

- `--full-auto`：低摩擦自动执行模式（禁用网络、允许写入 cwd 和 TMPDIR）
- `command: Vec<String>`：要在沙箱中运行的命令及参数

### `InteractiveRemoteOptions`

控制 TUI 连接到远程 app server 的选项：

| 字段 | 类型 | 说明 |
|------|------|------|
| `remote` | `Option<String>` | WebSocket 端点（`ws://` 或 `wss://`） |
| `remote_auth_token_env` | `Option<String>` | 包含 bearer token 的环境变量名 |

> 源码位置：`codex-rs/cli/src/main.rs:544-556`

### `LoginCommand`

登录子命令，支持多种认证方式：
- 默认：ChatGPT 浏览器 OAuth 登录
- `--with-api-key`：从 stdin 读取 API key
- `--device-auth`：设备码认证流程
- `--api-key`（已废弃）：直接传入 API key，现在会报错并引导用户使用 `--with-api-key`

> 源码位置：`codex-rs/cli/src/main.rs:293-328`

## 辅助模块

### `exit_status`（`codex-rs/cli/src/exit_status.rs`）

跨平台的进程退出码处理。在 Unix 上，如果子进程被信号终止，退出码为 `128 + signal`；在 Windows 上直接使用进程退出码，无信号时回退到 1。

### `wsl_paths`（`codex-rs/cli/src/wsl_paths.rs`）

WSL（Windows Subsystem for Linux）路径转换工具。将 Windows 风格路径（`C:\foo\bar`）转换为 WSL 挂载路径（`/mnt/c/foo/bar`）。`normalize_for_wsl()` 在非 WSL 环境下是 no-op。主要用于自动更新时规范化包管理器路径。

### `app_cmd` + `desktop_app`（仅 macOS）

`codex app` 子命令的实现。先在 `/Applications/Codex.app` 和 `~/Applications/Codex.app` 中查找已安装的桌面应用；如果未找到，则通过 `curl` 下载 DMG、`hdiutil` 挂载、`ditto` 拷贝 `.app` bundle 的方式自动安装，然后用 `open -a` 打开指定工作区。

> 源码位置：`codex-rs/cli/src/desktop_app/mac.rs:7-29`

## 配置项与默认值

- `DEFAULT_CODEX_DMG_URL`：macOS 桌面应用的默认 DMG 下载地址（`codex-rs/cli/src/app_cmd.rs:4`）
- AppServer 默认监听地址：`stdio://`（通过 `AppServerTransport::DEFAULT_LISTEN_URL`）
- AppServer 默认 analytics：关闭（除非传入 `--analytics-default-enabled`，如 VS Code 插件场景）
- Shell 补全默认 shell：`Bash`

## 边界 Case 与注意事项

- **TERM=dumb 检测**：当 `TERM` 设为 `dumb` 时，如果 stdin/stderr 不是 TTY 则拒绝启动 TUI；如果是 TTY 则弹出确认提示（`codex-rs/cli/src/main.rs:1310-1325`）
- **`--remote-auth-token-env` 必须搭配 `--remote`**：单独使用会报错
- **`--api-key` 已废弃**：直接传入 API key 的旧用法会打印错误信息并 `exit(1)`，引导用户改用管道方式
- **Resume/Fork 的 flag 合并**：`codex resume --model gpt-4` 中子命令级别的 flag 会覆盖根级同名 flag，通过 `merge_interactive_cli_flags()` 实现（`codex-rs/cli/src/main.rs:1418-1461`）
- **CRLF 归一化**：所有从 CLI 参数传入的 prompt 文本都会将 `\r\n` 和 `\r` 转换为 `\n`，防止回车符泄入 TUI 状态
- **平台条件编译**：`app` 子命令仅在 macOS 上可用（`#[cfg(target_os = "macos")]`），`wsl_paths` 在 Windows 上不编译（`#[cfg(not(windows))]`）