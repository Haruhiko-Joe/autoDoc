# 外部服务集成与环境配置命令集（IntegrationCommands）

## 概述与职责

IntegrationCommands 是 Claude Code 命令系统（CommandSystem）中负责**外部服务集成与环境配置**的命令集合，包含 18 个斜杠命令，覆盖 IDE 对接、平台扩展安装、认证管理、远程桥接、插件市场等场景。这些命令位于 `src/commands/` 下的各自子目录中，每个命令遵循统一的 `Command` 接口规范——通过 `index.ts` 导出命令定义对象，通过 `load` 函数懒加载实现模块。

在整体架构中，IntegrationCommands 属于 **CoreEngine → CommandSystem** 层级。CommandSystem 是中央命令注册表，聚合 80+ 内置命令并按特性门控/认证状态过滤可用性。IntegrationCommands 中的命令主要依赖 Services 层（OAuth、API、MCP 客户端）和 TerminalUI 层（React/Ink 渲染交互界面），同时与 SkillsAndPlugins 系统有紧密协作。

## 命令总览

| 命令 | 类型 | 说明 | 可用性限制 |
|------|------|------|-----------|
| `/mcp` | local-jsx | MCP 服务器管理（添加、启用/禁用、重连） | 无 |
| `/ide` | local-jsx | IDE 扩展检测与安装 | 无 |
| `/desktop` | local-jsx | 桌面应用会话移交 | claude-ai，仅 macOS/Windows |
| `/mobile` | local-jsx | 移动端下载二维码 | 无 |
| `/install-github-app` | local-jsx | GitHub Actions 安装向导 | claude-ai/console，特性门控 |
| `/install-slack-app` | local | Slack 应用安装 | claude-ai |
| `/login` | local-jsx | 登录/切换账户 | 特性门控 |
| `/logout` | local | 登出 | 特性门控 |
| `/chrome` | local-jsx | Chrome 扩展管理 | 需交互式会话 |
| `/remote-control` | local-jsx | 远程控制桥接 | 特性门控（`BRIDGE_MODE`） |
| `/web-setup` | local-jsx | 远程环境配置（CCR） | claude-ai，特性门控 |
| `/voice` | local | 语音输入切换 | 特性门控 |
| `/upgrade` | local-jsx | 订阅升级 | claude-ai，非企业版 |
| `/agents` | local-jsx | Agent 管理 | 无 |
| `/terminal-setup` | local-jsx | 终端键位配置 | 无（原生 CSI u 终端隐藏） |
| `/onboarding` | — | 新手引导（已禁用） | `isEnabled: false` |
| `/plugin` | local-jsx | 插件市场浏览与管理 | 无 |
| `/reload-plugins` | local | 重载插件 | 无 |

## 命令架构模式

所有命令遵循相同的模块结构：

```
src/commands/<command-name>/
├── index.ts          // Command 定义对象（name、type、description、可用性、load 函数）
├── <command-name>.tsx // 主实现（JSX 组件或 call() 函数）
└── ...               // 辅助文件（步骤组件、API 封装、工具函数等）
```

命令类型分为两种：
- **`local-jsx`**：返回 React/Ink 组件，渲染交互式终端 UI（如 `/mcp`、`/plugin`）
- **`local`**：返回纯文本结果的异步函数（如 `/voice`、`/reload-plugins`）

所有命令通过 `load: () => import('./xxx.js')` 实现**懒加载**，避免启动时引入不必要的依赖。

## 关键流程 Walkthrough

### 1. MCP 服务器管理（`/mcp`）

MCP 命令支持多个子命令，核心是 CLI 的 `mcp add` 子命令（`src/commands/mcp/addCommand.ts`）：

1. 解析传入参数：服务器名称、命令/URL、传输类型（stdio/sse/http）
2. 解析环境变量（`-e KEY=value`）和请求头（`-H "Authorization: Bearer ..."`）
3. 处理 OAuth 客户端配置（`--client-id`、`--client-secret`）
4. 如果启用 XAA（SEP-990），验证 IdP 配置并从 keychain 读取客户端密钥
5. 调用 `addMcpConfig()` 将服务器配置写入指定 scope（local/user/project）
6. 记录分析事件并返回成功消息

交互式模式下（`/mcp` 无参数），渲染 `MCPSettings` 组件，提供 enable/disable/reconnect 操作。

> 源码位置：`src/commands/mcp/addCommand.ts:33-80`

### 2. GitHub App 安装向导（`/install-github-app`）

这是最复杂的命令，包含 14 步状态机流程（`src/commands/install-github-app/install-github-app.tsx`）：

```
check-gh → api-key → oauth/existing-key → choose-repo → check-secret
→ install-app → existing-workflow → creating → warnings → success/error
```

关键步骤：
1. **CheckGitHubStep**：验证 `gh` CLI 已安装且已认证，检查 `repo` 和 `workflow` scope
2. **ApiKeyStep**：收集 Anthropic API Key（支持使用已有 Key、新建、或 OAuth）
3. **OAuthFlowStep**：处理 OAuth 认证流（组件体积 39KB，是最复杂的子步骤）
4. **ChooseRepoStep**：仓库选择界面，默认使用当前 git 仓库
5. **CheckExistingSecretStep**：检查 GitHub 仓库中是否已有 `ANTHROPIC_API_KEY` secret
6. **CreatingStep**：调用 `setupGitHubActions()` 创建/更新工作流文件和环境密钥
7. **SuccessStep/ErrorStep**：显示结果

初始状态定义（`src/commands/install-github-app/install-github-app.tsx:28-45`）：

```typescript
const INITIAL_STATE: State = {
  step: 'check-gh',
  selectedRepoName: '',
  selectedWorkflows: ['claude', 'claude-review'] as Workflow[],
  authType: 'api_key',
  // ...
}
```

### 3. 认证管理（`/login` 与 `/logout`）

**登录流程**（`src/commands/login/login.tsx`）：
1. 启动 `ConsoleOAuthFlow` 进行 OAuth 认证
2. 认证成功后执行一系列后处理：
   - 重置费用追踪状态
   - 刷新 GrowthBook 特性开关
   - 刷新策略限制
   - 重置用户缓存
   - 注册受信设备（用于 Remote Control）
   - 更新 auth 版本号触发依赖刷新

**登出流程**（`src/commands/logout/logout.tsx:16-48`）：

```typescript
export async function performLogout({ clearOnboarding = false }): Promise<void> {
  // 1. 先刷新遥测数据（防止凭据清除后组织数据泄露）
  await flushTelemetry()
  // 2. 移除 API Key
  await removeApiKey()
  // 3. 清除安全存储
  secureStorage.delete()
  // 4. 清除所有认证相关缓存
  await clearAuthRelatedCaches()
  // 5. 更新全局配置
  saveGlobalConfig(...)
}
```

`clearAuthRelatedCaches()` 系统地清理 8 类缓存：OAuth token、受信设备 token、betas、工具 schema、用户数据、GrowthBook、Grove 配置、远程托管设置、策略限制。

### 4. 插件系统（`/plugin` 与 `/reload-plugins`）

`/plugin` 命令（别名 `/plugins`、`/marketplace`）是一个功能丰富的插件管理入口。

**参数解析**（`src/commands/plugin/parseArgs.ts:17-103`）支持以下子命令：

| 子命令 | 语法 | 说明 |
|--------|------|------|
| `install` | `/plugin install <name>@<marketplace>` | 安装插件 |
| `manage` | `/plugin manage` | 管理已安装插件 |
| `uninstall` | `/plugin uninstall <name>` | 卸载插件 |
| `enable/disable` | `/plugin enable <name>` | 启用/禁用插件 |
| `validate` | `/plugin validate [path]` | 验证插件 |
| `marketplace` | `/plugin marketplace add/remove/list` | 管理自定义市场源 |

安装语法支持三种格式：
- `plugin@marketplace`：指定市场源的插件
- URL/路径格式：视为市场源 URL
- 纯名称：视为插件名

**插件重载**（`src/commands/reload-plugins/reload-plugins.ts:10-57`）：

1. 如果在远程模式（CCR），先重新下载用户设置（`redownloadUserSettings()`）
2. 调用 `refreshActivePlugins()` 刷新所有活跃插件
3. 汇总并返回统计信息（插件数、技能数、Agent 数、Hook 数、MCP 服务器数、LSP 服务器数）
4. 如有加载错误，提示用户运行 `/doctor` 查看详情

### 5. 远程桥接（`/remote-control`）

Remote Control 命令管理 CLI 与 claude.ai 之间的双向桥接连接（`src/commands/bridge/bridge.tsx:27-37`）：

1. 检查桥接先决条件（版本兼容性、环境支持）
2. 设置 `replBridgeEnabled` 状态，触发 REPL 层的 `useReplBridge` hook 初始化连接
3. 桥接注册本地环境、创建会话、轮询工作、建立 WebSocket 双向通信
4. 生成 QR 码和会话 URL 供用户在浏览器端扫码/访问
5. 已连接时显示断开对话框

### 6. 远程环境配置（`/web-setup`）

Web Setup 命令配置 Claude Code Remote（CCR）环境（`src/commands/remote-setup/`）：

1. 检查登录状态
2. 收集 GitHub Token，通过 `RedactedGithubToken` 类包装以防止日志泄露（`src/commands/remote-setup/api.ts:16-33`）
3. 调用 `importGithubToken()` 将 Token 加密上传到 CCR 后端（Fernet 加密存储）
4. 调用 `createDefaultEnvironment()` 创建默认云环境（Python 3.11 + Node 20，受信网络访问）
5. 打开 `claude.ai/code` 页面

### 7. 语音模式（`/voice`）

语音切换是一个纯函数式命令（`src/commands/voice/voice.ts:16-150`），执行以下预检：

1. 检查认证状态和特性开关（kill-switch）
2. 如果当前已启用则直接关闭
3. 启用前检查：
   - 语音流 API 可用性（`isVoiceStreamAvailable()`）
   - 录音工具可用性（SoX 等音频依赖）
   - 麦克风权限（触发 OS 权限对话框）
4. 所有检查通过后启用语音，显示按键提示（如 `Hold Space to record`）
5. 处理语音语言配置和提示信息

## 工具函数与辅助模块

### `createMovedToPluginCommand()`

工厂函数，为已迁移到插件系统的内置命令创建占位命令（`src/commands/createMovedToPluginCommand.ts:22-65`）：

```typescript
export function createMovedToPluginCommand({
  name, description, progressMessage,
  pluginName, pluginCommand,
  getPromptWhileMarketplaceIsPrivate,
}: Options): Command
```

- 对内部用户（`USER_TYPE === 'ant'`）：显示插件安装指引和 marketplace 链接
- 对外部用户：回退到 `getPromptWhileMarketplaceIsPrivate` 提供的原始行为

这是 Claude Code 从内置命令向插件生态迁移的过渡机制。

### `Install` 组件

原生安装器组件（`src/commands/install.tsx`），状态机流程：

```
checking → cleaning-npm → installing → setting-up → success/error
```

关键功能：
- 支持频道选择（latest/stable/指定版本）
- 清理旧的 npm 安装残留
- 安装路径：`~/.local/bin/claude`（macOS/Linux）或 `%USERPROFILE%\.local\bin\claude.exe`（Windows）
- 设置 launcher 和 shell 集成
- 处理并发安装锁冲突

## 接口/类型定义

### `Command` 接口（公共约定）

每个命令导出的对象需满足 `Command` 类型，核心字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'local-jsx' \| 'local' \| 'prompt'` | 命令类型 |
| `name` | `string` | 命令名称（斜杠后的标识符） |
| `description` | `string` | 简短描述 |
| `aliases` | `string[]` | 别名列表 |
| `immediate` | `boolean` | 是否立即执行（不等待 Enter） |
| `availability` | `string[]` | 可用的认证提供者 |
| `isEnabled` | `() => boolean` | 动态启用/禁用 |
| `isHidden` | `boolean` | 是否在命令列表中隐藏 |
| `load` | `() => Promise<...>` | 懒加载实现 |

### `ParsedCommand` 类型（插件参数解析）

```typescript
export type ParsedCommand =
  | { type: 'menu' }
  | { type: 'help' }
  | { type: 'install'; marketplace?: string; plugin?: string }
  | { type: 'manage' }
  | { type: 'uninstall'; plugin?: string }
  | { type: 'enable'; plugin?: string }
  | { type: 'disable'; plugin?: string }
  | { type: 'validate'; path?: string }
  | { type: 'marketplace'; action?: 'add' | 'remove' | 'update' | 'list'; target?: string }
```

> 源码位置：`src/commands/plugin/parseArgs.ts:2-15`

### `RedactedGithubToken` 类

```typescript
export class RedactedGithubToken {
  constructor(raw: string)
  reveal(): string          // 仅在 HTTP 请求体中调用
  toString(): string         // 返回 '[REDACTED:gh-token]'
  toJSON(): string           // 返回 '[REDACTED:gh-token]'
}
```

所有序列化路径（`String()`、模板字符串、`JSON.stringify()`、`util.inspect()`）均输出脱敏值，防止 Token 意外泄露到日志中。

> 源码位置：`src/commands/remote-setup/api.ts:16-33`

### `ImportTokenError` 类型

```typescript
export type ImportTokenError =
  | { kind: 'not_signed_in' }
  | { kind: 'invalid_token' }
  | { kind: 'server'; status: number }
  | { kind: 'network' }
```

## 配置项与特性门控

命令的可用性由以下机制控制：

| 机制 | 影响的命令 | 说明 |
|------|-----------|------|
| `availability: ['claude-ai']` | desktop, install-slack-app, web-setup, upgrade | 仅 Claude.ai 认证用户可见 |
| `isEnvTruthy(DISABLE_*)` | install-github-app, login, logout, upgrade | 环境变量禁用 |
| GrowthBook 特性开关 | bridge (`BRIDGE_MODE`)、voice、web-setup (`tengu_cobalt_lantern`) | 服务端特性门控 |
| 策略限制 | web-setup (`allow_remote_sessions`) | 组织级策略控制 |
| 平台检测 | desktop (macOS/Windows)、terminal-setup (隐藏原生 CSI u 终端) | 运行时平台判断 |

## 边界 Case 与注意事项

- **登出时的遥测刷新顺序**：`performLogout()` 必须在清除凭据**之前**刷新遥测数据，否则会导致组织数据泄露到匿名遥测流中（`src/commands/logout/logout.tsx:19-23`）

- **插件重载的远程模式处理**：CCR 环境下 `/reload-plugins` 会先重新下载用户设置，但不会重新拉取 Managed Settings（后者有独立的小时级轮询机制，属于最终一致性设计）

- **MCP 的 XAA 支持**：`mcp add --xaa` 需要先运行 `claude mcp xaa setup` 配置 IdP，且要求 HTTPS（回环地址除外）

- **GitHub App 安装的 scope 检查**：`CheckGitHubStep` 会验证 `gh` 的 Token 是否包含 `repo` 和 `workflow` scope，缺少任一 scope 会直接终止流程

- **`createMovedToPluginCommand` 的过渡性**：该工厂函数包含对内部/外部用户的分支逻辑。一旦 marketplace 公开发布，`getPromptWhileMarketplaceIsPrivate` 参数和回退逻辑应被移除

- **Voice 模式的平台差异**：麦克风权限引导信息按平台区分——macOS 指向 System Settings → Privacy & Security → Microphone，Windows 指向 Settings → Privacy → Microphone，Linux 指向系统音频设置

- **Install 组件的锁机制**：如果另一个进程正在安装 Claude，`installLatest()` 会返回 `lockFailed: true`，避免并发安装冲突

- **`/onboarding` 已禁用**：该命令的 `isEnabled` 返回 `false` 且标记为 `isHidden`，是一个空壳存根