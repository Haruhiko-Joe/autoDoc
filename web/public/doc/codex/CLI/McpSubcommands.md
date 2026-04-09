# MCP 子命令模块

## 概述与职责

`mcp_cmd` 模块实现了 `codex mcp` 子命令组，是 CLI 层中管理外部 MCP（Model Context Protocol）服务器配置的入口。它位于 CLI 组件下，与 Core 和 MCP 组件协作，提供对全局 MCP 服务器注册表（`~/.codex/config.toml`）的完整 CRUD 操作以及 OAuth 认证管理。

在整体架构中，CLI 组件负责解析命令行参数并分发到各子命令。`mcp_cmd` 是其中专门处理 MCP 服务器管理的分支，同级的还有 TUI 交互模式、headless exec 模式、app-server 启动等子命令流程。

## 子命令总览

模块提供 6 个子命令，通过 `McpSubcommand` 枚举定义（`mcp_cmd.rs:47-54`）：

| 子命令 | 功能 | 关键参数 |
|--------|------|----------|
| `list` | 列出所有已配置的 MCP 服务器 | `--json` 以 JSON 格式输出 |
| `get` | 查看单个服务器的详细配置 | `<name>`, `--json` |
| `add` | 添加新的 MCP 服务器配置 | `<name>`, `--url` 或 `-- <COMMAND>...` |
| `remove` | 删除指定的服务器配置 | `<name>` |
| `login` | 对 MCP 服务器执行 OAuth 登录 | `<name>`, `--scopes` |
| `logout` | 删除 MCP 服务器的 OAuth 凭据 | `<name>` |

所有子命令都接受 `CliConfigOverrides`（`mcp_cmd.rs:39-40`），允许通过命令行标志覆盖默认配置。

## 关键流程

### add 流程（添加服务器）

`run_add` 是最复杂的子命令（`mcp_cmd.rs:238-351`），执行以下步骤：

1. 加载并验证配置覆盖项，调用 `Config::load_with_cli_overrides()` 获取完整配置
2. 通过 `validate_server_name()` 校验服务器名称（仅允许字母、数字、`-`、`_`）
3. 从 `~/.codex` 目录加载现有的全局 MCP 服务器列表
4. 根据传入参数构造传输配置：
   - **Stdio 模式**：解析命令行和参数，可选地附加环境变量（`--env KEY=VALUE`）
   - **Streamable HTTP 模式**：使用 `--url` 指定端点，可选 `--bearer-token-env-var` 指定 Bearer Token 环境变量
5. 构造 `McpServerConfig` 并插入服务器列表，通过 `ConfigEditsBuilder` 写回配置文件
6. **自动 OAuth 检测**：添加完成后，调用 `oauth_login_support()` 检测新服务器是否支持 OAuth：
   - 若支持，自动触发 OAuth 登录流程（包含 scope 发现和重试逻辑）
   - 若不确定，提示用户可手动执行 `codex mcp login`

### login 流程（OAuth 认证）

`run_login`（`mcp_cmd.rs:386-435`）处理 OAuth 登录：

1. 加载配置并通过 `McpManager` 获取有效的服务器列表
2. 校验目标服务器存在且为 `StreamableHttp` 传输类型（stdio 不支持 OAuth）
3. **Scope 解析**三级优先级（`mcp_cmd.rs:412-419`）：
   - 用户通过 `--scopes` 显式指定的 scope（最高优先级）
   - 服务器配置中预设的 `scopes` 字段
   - 通过 `discover_supported_scopes()` 自动发现的 scope（仅在前两者都为空时触发）
4. 调用 `perform_oauth_login_retry_without_scopes()` 执行实际登录

### OAuth 重试逻辑

`perform_oauth_login_retry_without_scopes`（`mcp_cmd.rs:194-236`）是一个兼容性适配层：

1. 首先使用解析后的 scope 列表尝试 OAuth 登录
2. 如果 OAuth provider 拒绝了发现的 scope（通过 `should_retry_without_scopes()` 判断），则以**空 scope 列表**重试一次
3. 这是为了兼容仍然期望旧式空 scope 请求的 OAuth 服务器

### list 流程（列表输出）

`run_list`（`mcp_cmd.rs:467-714`）支持两种输出格式：

- **JSON 模式**（`--json`）：输出包含完整传输配置、超时设置、认证状态的 JSON 数组
- **表格模式**（默认）：将服务器按传输类型分为两组，分别以对齐的文本表格显示：
  - Stdio 表格列：Name、Command、Args、Env、Cwd、Status、Auth
  - HTTP 表格列：Name、Url、Bearer Token Env Var、Status、Auth

两种模式都会调用 `compute_auth_statuses()` 异步计算每个服务器的认证状态。

### get 流程（详情查看）

`run_get`（`mcp_cmd.rs:716-875`）同样支持 JSON 和文本两种输出：

- JSON 模式额外输出 `enabled_tools` 和 `disabled_tools` 字段
- 文本模式以缩进的 key-value 形式逐行展示配置项，末尾提示删除命令
- 对于被禁用的服务器，直接显示禁用状态和原因后返回
- HTTP 传输的 `http_headers` 值会被遮蔽为 `*****`，而 `env_http_headers` 显示环境变量名（不暴露实际值）

## 数据结构

### `McpCli`（`mcp_cmd.rs:38-44`）

顶层命令结构，包含配置覆盖项和子命令枚举。`run()` 方法（`mcp_cmd.rs:159-188`）是入口，按子命令分发到对应的 `run_*` 异步函数。

### `AddMcpTransportArgs`（`mcp_cmd.rs:83-98`）

使用 clap 的 `ArgGroup` 实现互斥参数组：`--url` 和 `-- <COMMAND>` 必须二选一且仅选一。这保证了每个服务器配置只有一种传输类型。

- `AddMcpStdioArgs`：`command`（trailing_var_arg）+ `--env KEY=VALUE`（可重复）
- `AddMcpStreamableHttpArgs`：`--url` + 可选的 `--bearer-token-env-var`

### `LoginArgs`（`mcp_cmd.rs:142-150`）

`--scopes` 参数支持逗号分隔的多个 OAuth scope，通过 clap 的 `value_delimiter` 自动拆分。

## 辅助函数

### `validate_server_name(name: &str) -> Result<()>`

> 源码位置：`mcp_cmd.rs:892-903`

校验服务器名称：非空，且仅包含 ASCII 字母、数字、`-`、`_`。在 `add` 和 `remove` 子命令中调用。

### `parse_env_pair(raw: &str) -> Result<(String, String), String>`

> 源码位置：`mcp_cmd.rs:877-890`

解析 `KEY=VALUE` 格式的环境变量字符串，用于 `--env` 参数的 `value_parser`。key 会被 trim，value 保留原始值。

### `format_mcp_status(config: &McpServerConfig) -> String`

> 源码位置：`mcp_cmd.rs:905-913`

将服务器启用状态格式化为人类可读字符串：`"enabled"`、`"disabled"` 或 `"disabled: <reason>"`。

## 边界 Case 与注意事项

- **OAuth 仅限 Streamable HTTP**：`login` 和 `logout` 子命令对 stdio 传输类型会直接报错（`mcp_cmd.rs:409`, `mcp_cmd.rs:455`），因为 OAuth 依赖 HTTP 端点
- **add 时自动 OAuth**：添加 HTTP 类型服务器时，会自动尝试 OAuth 检测和登录。如果 OAuth 检测结果不确定（`McpOAuthLoginSupport::Unknown`），仅打印提示而不报错
- **scope 发现降级**：如果 OAuth provider 拒绝了自动发现的 scope，会自动以空 scope 重试一次，保证与旧版 provider 的兼容性
- **remove 的幂等性**：删除不存在的服务器不会报错，只会打印 "No MCP server named '...' found."
- **logout 的返回语义**：`delete_oauth_tokens` 返回 `Ok(false)` 表示没有凭据可删除，不视为错误
- **list 空列表**：无服务器配置时输出引导信息 `"No MCP servers configured yet. Try codex mcp add my-tool -- my-command."`
- **HTTP headers 安全**：`get` 命令的文本输出中，`http_headers` 的值被替换为 `*****`，避免泄露敏感的 header 值；而 `env_http_headers` 只显示环境变量名不显示实际值