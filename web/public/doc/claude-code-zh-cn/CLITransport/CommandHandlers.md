# CommandHandlers — CLI 子命令处理器集合

## 概述与职责

CommandHandlers 是 Claude Code CLI 的子命令处理器模块，位于 `src/cli/handlers/` 目录下。它为 `claude <subcommand>` 提供**延迟加载**的命令实现——每个处理器文件仅在对应子命令被执行时才被动态 `import()`，以减少启动开销。

在系统架构中，CommandHandlers 属于 **CLITransport** 层，被入口层（Entrypoints）中的命令注册系统调用。它向下依赖 Services 层（OAuth、MCP 客户端、分析埋点、插件服务等）和 Infrastructure 层（配置管理、工具函数），同时部分处理器（`util.tsx`、`mcp.tsx`）使用了 TerminalUI 层的 React/Ink 组件来渲染交互式界面。

该模块包含 6 个文件，分别对应 6 个子命令域：

| 文件 | 子命令前缀 | 职责 |
|------|-----------|------|
| `auth.ts` | `claude auth` | OAuth 登录/登出/状态查询 |
| `agents.ts` | `claude agents` | 已配置 Agent 列表展示 |
| `mcp.tsx` | `claude mcp` | MCP 服务器 CRUD 与健康检查 |
| `plugins.ts` | `claude plugin` / `claude plugin marketplace` | 插件与市场的安装/卸载/启用/禁用/更新/校验 |
| `autoMode.ts` | `claude auto-mode` | 自动模式规则导出、合并与 AI 审查 |
| `util.tsx` | `claude setup-token` / `claude doctor` / `claude install` | 通用工具命令 |

## 关键流程

### auth 子命令 — OAuth 登录流程

`authLogin()` 支持两条登录路径：

1. **环境变量快速路径**（`src/cli/handlers/auth.ts:140-186`）：若设置了 `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`，直接调用 `refreshOAuthToken()` 交换 token，跳过浏览器流程。要求同时设置 `CLAUDE_CODE_OAUTH_SCOPES`。

2. **浏览器 OAuth 流程**（`src/cli/handlers/auth.ts:190-229`）：创建 `OAuthService` 实例，调用 `startOAuthFlow()` 打开浏览器让用户登录。支持 `--console` / `--claudeai` / `--sso` 标志选择登录方式，并遵守企业级 `forceLoginMethod` 设置。

两条路径获取 token 后都调用 `installOAuthTokens()`（`src/cli/handlers/auth.ts:50-110`），执行统一的后处理：
1. 先调用 `performLogout()` 清除旧认证状态
2. 获取用户 Profile 并存储账户信息
3. 保存 OAuth token
4. 拉取用户角色（`fetchAndStoreUserRoles`）
5. 根据认证类型，创建 API Key（Console 用户）或记录 first-token-date（claude.ai 用户）
6. 清除认证相关缓存

### mcp 子命令 — 服务器配置管理

MCP 处理器提供了完整的 CRUD 操作：

- **`mcpAddJsonHandler()`**（`src/cli/handlers/mcp.tsx:286-314`）：解析 JSON 配置，支持 OAuth `--client-secret` 选项。先读取密钥再写配置，防止取消时留下不完整状态。
- **`mcpRemoveHandler()`**（`src/cli/handlers/mcp.tsx:74-141`）：智能删除——若未指定 scope，自动检查 server 存在于哪些 scope（local/project/user）。单 scope 直接删除，多 scope 提示用户选择。同时清理安全存储中的 token。
- **`mcpListHandler()`**（`src/cli/handlers/mcp.tsx:144-190`）：列出所有配置的 MCP 服务器并**并发检查健康状态**（通过 `pMap` + `connectToServer`），最后调用 `gracefulShutdown()` 清理连接。
- **`mcpGetHandler()`**（`src/cli/handlers/mcp.tsx:193-283`）：查看单个服务器详情（类型、URL/命令、参数、OAuth 配置等）。
- **`mcpAddFromDesktopHandler()`**（`src/cli/handlers/mcp.tsx:317-349`）：从 Claude Desktop 配置中导入 MCP 服务器，使用 React/Ink 渲染交互式导入对话框。

### plugins 子命令 — 插件生命周期管理

插件系统支持三层 scope（`user` / `project` / `local`）和 `--cowork` 模式：

- **安装/卸载/更新**（`pluginInstallHandler` / `pluginUninstallHandler` / `pluginUpdateHandler`）：解析插件标识符（`name@marketplace` 格式），校验 scope 合法性后委托给 `pluginCliCommands` 服务层执行。
- **启用/禁用**（`pluginEnableHandler` / `pluginDisableHandler`）：`disable` 支持 `--all` 批量禁用所有插件。
- **列表**（`pluginListHandler`，`src/cli/handlers/plugins.ts:157-444`）：最复杂的处理器之一。它同时加载已安装插件（V2 bookkeeping）和会话级 inline 插件（`--plugin-dir`），处理加载错误的归因，支持 `--json` 输出和 `--available` 展示市场可用插件。
- **校验**（`pluginValidateHandler`，`src/cli/handlers/plugins.ts:101-154`）：校验插件清单文件，若位于 `.claude-plugin` 目录则还会递归校验技能、Agent、命令、钩子等内容文件。
- **市场管理**（`marketplaceAddHandler` / `marketplaceRemoveHandler` / `marketplaceUpdateHandler` / `marketplaceListHandler`）：支持 GitHub repo、Git URL、本地目录/文件等多种来源，`--sparse` 用于 GitHub/Git 的稀疏检出。

### autoMode 子命令 — 分类器规则管理

自动模式允许用户自定义工具调用的自动批准/拒绝规则：

- **`autoModeDefaultsHandler()`**：输出内置默认规则（JSON 格式）
- **`autoModeConfigHandler()`**（`src/cli/handlers/autoMode.ts:35-47`）：输出**生效规则**——用户设置覆盖默认值，按节替换语义（非合并），未配置的节回退到默认值
- **`autoModeCritiqueHandler()`**（`src/cli/handlers/autoMode.ts:73-149`）：使用 AI（通过 `sideQuery`）审查用户自定义规则的质量。将分类器系统提示词、用户规则和被替换的默认规则一并提交，从清晰性、完整性、冲突和可操作性四个维度评估

### util 子命令 — 通用工具

- **`setupTokenHandler()`**（`src/cli/handlers/util.tsx:20-49`）：引导用户完成长期 OAuth token 设置（1 年有效期），使用 Ink 渲染 `ConsoleOAuthFlow` 组件
- **`doctorHandler()`**（`src/cli/handlers/util.tsx:72-87`）：启动诊断界面，渲染 `Doctor` 屏幕和 MCP 连接管理器，检查系统健康状况
- **`installHandler()`**（`src/cli/handlers/util.tsx:90-109`）：安装 Claude Code 到指定位置，支持 `--force` 选项

## 函数签名

### auth.ts

#### `installOAuthTokens(tokens: OAuthTokens): Promise<void>`
共享的 token 安装后处理。保存 token、获取 Profile 和角色、创建 API Key。被 `authLogin` 和外部模块复用。

#### `authLogin(opts: { email?: string; sso?: boolean; console?: boolean; claudeai?: boolean }): Promise<void>`
执行 OAuth 登录。`--console` 和 `--claudeai` 互斥。

#### `authStatus(opts: { json?: boolean; text?: boolean }): Promise<void>`
输出认证状态。`--json` 返回结构化 JSON（含 `loggedIn`、`authMethod`、`apiProvider` 等），`--text` 返回人类可读格式。退出码：已登录 → 0，未登录 → 1。

#### `authLogout(): Promise<void>`
执行登出，清除本地凭据。

### agents.ts

#### `agentsHandler(): Promise<void>`
加载所有 Agent 定义（含覆盖解析），按来源分组展示。被更高优先级来源覆盖的 Agent 标记为 `(shadowed by ...)`。

### mcp.tsx

#### `mcpServeHandler(opts: { debug?: boolean; verbose?: boolean }): Promise<void>`
启动 Claude Code 作为 MCP 服务器。

#### `mcpAddJsonHandler(name: string, json: string, opts: { scope?: string; clientSecret?: true }): Promise<void>`
通过 JSON 配置添加 MCP 服务器。支持 OAuth `clientSecret` 安全输入。

#### `mcpRemoveHandler(name: string, opts: { scope?: string }): Promise<void>`
删除 MCP 服务器配置，自动清理安全存储。

#### `mcpListHandler(): Promise<void>`
列出所有 MCP 服务器并并发检查连接状态。

#### `mcpGetHandler(name: string): Promise<void>`
查看单个服务器的详细配置和健康状态。

#### `mcpAddFromDesktopHandler(opts: { scope?: string }): Promise<void>`
从 Claude Desktop 导入 MCP 服务器配置。

#### `mcpResetChoicesHandler(): Promise<void>`
重置所有项目级 `.mcp.json` 服务器的审批/拒绝选择。

### plugins.ts

#### `pluginInstallHandler(plugin: string, opts: { scope?: string; cowork?: boolean }): Promise<void>`
安装插件。`plugin` 格式为 `name` 或 `name@marketplace`。`scope` 可选 `user`（默认）、`project`、`local`。

#### `pluginUninstallHandler(plugin: string, opts: { scope?: string; cowork?: boolean; keepData?: boolean }): Promise<void>`
卸载插件。`--keepData` 保留插件数据。

#### `pluginEnableHandler(plugin: string, opts: { scope?: string; cowork?: boolean }): Promise<void>`
启用已安装的插件。

#### `pluginDisableHandler(plugin: string | undefined, opts: { scope?: string; cowork?: boolean; all?: boolean }): Promise<void>`
禁用插件。`--all` 禁用所有插件（不可与具体插件名或 `--scope` 同时使用）。

#### `pluginListHandler(opts: { json?: boolean; available?: boolean; cowork?: boolean }): Promise<void>`
列出已安装插件。`--available` 额外展示市场可用插件。`--json` 输出结构化 JSON。

#### `pluginValidateHandler(manifestPath: string, opts: { cowork?: boolean }): Promise<void>`
校验插件清单和内容文件。

#### `pluginUpdateHandler(plugin: string, opts: { scope?: string; cowork?: boolean }): Promise<void>`
更新已安装插件到最新版本。

#### 市场相关处理器
- `marketplaceAddHandler(source: string, opts: { cowork?: boolean; sparse?: string[]; scope?: string })`
- `marketplaceListHandler(opts: { json?: boolean; cowork?: boolean })`
- `marketplaceRemoveHandler(name: string, opts: { cowork?: boolean })`
- `marketplaceUpdateHandler(name?: string, opts: { cowork?: boolean })`

### autoMode.ts

#### `autoModeDefaultsHandler(): void`
同步输出默认分类器规则 JSON。

#### `autoModeConfigHandler(): void`
输出合并后的生效规则（用户设置 + 默认回退）。

#### `autoModeCritiqueHandler(opts: { model?: string }): Promise<void>`
使用 AI 审查用户自定义规则。可通过 `--model` 指定模型。

### util.tsx

#### `setupTokenHandler(root: Root): Promise<void>`
交互式长期 token 设置向导。

#### `doctorHandler(root: Root): Promise<void>`
交互式系统诊断工具。

#### `installHandler(target?: string, opts: { force?: boolean }): Promise<void>`
安装 Claude Code 到指定目标。

## 配置项与环境变量

| 变量 | 用于 | 说明 |
|------|------|------|
| `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` | `authLogin` | 提供 refresh token 跳过浏览器登录 |
| `CLAUDE_CODE_OAUTH_SCOPES` | `authLogin` | 与上述变量配合，空格分隔的 scope 列表 |
| `ANTHROPIC_API_KEY` | `authStatus` | 直接 API Key 认证 |
| `NODE_ENV` | 间接 | 影响认证行为（如 mock 用户） |

设置文件中的相关配置：
- `forceLoginMethod`：企业级强制登录方式（`claudeai` 或其他）
- `forceLoginOrgUUID`：强制登录组织 UUID
- `autoMode.allow / soft_deny / environment`：自动模式自定义规则

## 边界 Case 与注意事项

- **`--console` 与 `--claudeai` 互斥**（`auth.ts:123-128`）：同时传入直接退出并报错
- **插件 scope 为 `--cowork` 时只允许 `user` scope**（`plugins.ts:674-676`）：`--cowork` 强制操作在用户级别
- **MCP 删除的多 scope 场景**（`mcp.tsx:126-137`）：若同名服务器存在于多个 scope，不会删除任何一个，而是提示用户使用 `-s <scope>` 明确指定
- **`pluginListHandler` 的 inline 插件归因问题**（`plugins.ts:190-193`）：`--plugin-dir` 加载的插件目录名可能与 manifest 中的 name 不一致，处理器对此做了双重匹配（按 `source` 和 `plugin` 名称）
- **`mcpListHandler` 使用 `gracefulShutdown` 而非 `process.exit`**（`mcp.tsx:189`）：确保 MCP 子进程连接被正确清理，不会留下孤儿进程
- **`autoModeCritiqueHandler` 无自定义规则时提前返回**（`autoMode.ts:82-89`）：不会浪费 API 调用
- **所有处理器通过 `logEvent` 记录遥测事件**：事件名以 `tengu_` 为前缀，插件相关事件中的用户输入通过 `_PROTO_` 前缀路由到 PII 保护列