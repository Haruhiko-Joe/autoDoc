# 通知与状态提示 Hooks

## 概述与职责

通知与状态提示模块是 Claude Code 终端 UI 中的**用户感知层**，负责在适当时机向用户展示系统状态变化、警告信息和操作建议。该模块位于 `TerminalUI > Hooks` 层级下，与 `StateAndContext` 中的 `NotificationsContext` 紧密协作。

整个模块由两部分组成：
- **`src/hooks/notifs/` 子目录**：16 个专用通知 Hook，覆盖速率限制、快速模式、IDE 集成、LSP、插件、模型迁移、配置错误等场景
- **顶层 Hooks**（`src/hooks/` 下）：6 个独立通知 Hook，处理 Chrome 扩展、市场推荐、版本更新、问题标记等

所有通知 Hook 遵循统一的架构模式：通过 `useNotifications()` Context 获取 `addNotification` / `removeNotification` 方法，在特定条件满足时推送通知。每个通知携带 `key`（去重标识）、`priority`（显示优先级）、`text` 或 `jsx`（内容）等属性。

## 关键流程

### 通知触发的通用模式

几乎所有通知 Hook 都遵循以下流程：

1. 调用 `useNotifications()` 获取通知 API
2. 通过 `useEffect` 监听某个状态源（AppState、外部事件订阅、轮询等）
3. 判断 `getIsRemoteMode()` —— **远程模式下跳过所有通知**（这是全局守卫）
4. 满足触发条件时调用 `addNotification({ key, text/jsx, priority, ... })`
5. 使用 `useRef` 防止重复显示（一次性通知）

### `useStartupNotification` 基础设施

`useStartupNotification`（`src/hooks/notifs/useStartupNotification.ts:19-41`）是多个通知 Hook 的**基础抽象**，封装了一次性启动通知的常见模式：

1. 接收一个 `compute` 函数（同步或异步），返回 `Notification | Notification[] | null`
2. 使用 `hasRunRef` 确保 compute 只执行一次
3. 自动处理远程模式守卫和错误捕获（`catch(logError)`）

依赖此基础设施的 Hook 包括：`useModelMigrationNotifications`、`useCanSwitchToExistingSubscription`、`useInstallMessages`、`useNpmDeprecationNotification`、`useChromeExtensionNotification`、`useOfficialMarketplaceNotification`。

### 通知优先级体系

通知使用四级优先级机制，决定展示顺序和方式：

| 优先级 | 典型场景 |
|--------|---------|
| `immediate` | 超额使用、Chrome 扩展错误、marketplace 安装结果 |
| `high` | 速率限制警告、设置错误、NPM 废弃、模型迁移 |
| `medium` | 插件安装失败、MCP 连接失败、IDE 断连、auto 模式不可用 |
| `low` | 插件自动更新、Chrome 默认启用提示、订阅切换建议、Agent 生命周期 |

## 各 Hook 详解

### notifs/ 子目录

#### `useRateLimitWarningNotification(model: string)`

> `src/hooks/notifs/useRateLimitWarningNotification.tsx:11-113`

监听 Claude AI 的用量限制状态，触发两类通知：

- **超额使用通知**（key: `limit-reached`，priority: `immediate`）：当 `claudeAiLimits.isUsingOverage` 变为 true 时触发，对 team/enterprise 用户需要额外的计费权限检查（`hasClaudeAiBillingAccess`）
- **速率接近限制警告**（key: `rate-limit-warning`，priority: `high`）：使用 `shownWarningRef` 确保同一条警告只展示一次

#### `useFastModeNotification()`

> `src/hooks/notifs/useFastModeNotification.tsx:12-160`

管理快速模式的完整生命周期通知，包含三个独立的 `useEffect`：

1. **组织级开关变化**：订阅 `onOrgFastModeChanged`，组织启用时提示 `/fast to turn on`，组织禁用时自动关闭快速模式并警告
2. **超额拒绝**：订阅 `onFastModeOverageRejection`，自动关闭快速模式并展示拒绝原因
3. **冷却周期**：订阅 `onCooldownTriggered` 和 `onCooldownExpired`，展示冷却计时（通过 `formatDuration` 格式化），使用 `invalidates` 机制互相替换（冷却开始通知替换冷却结束通知，反之亦然）

冷却消息根据 `CooldownReason` 分为 `overloaded`（过载）和 `rate_limit`（频率限制）两种。

#### `useIDEStatusIndicator({ ideSelection, mcpClients, ideInstallationStatus })`

> `src/hooks/notifs/useIDEStatusIndicator.tsx:17-179`

管理 IDE 连接状态的多层通知，包含四个 `useEffect`：

1. **IDE 发现提示**（key: `ide-status-hint`）：检测到 IDE 且未在支持的终端中时，延迟 3 秒提示 `/ide` 命令，使用 `ideHintShownCount` 限制最多展示 5 次
2. **断连通知**（key: `ide-status-disconnected`）：IDE 已连接过但断开时展示
3. **JetBrains 特殊提示**（key: `ide-status-jetbrains-disconnected`）：JetBrains IDE 插件未连接时展示
4. **安装错误**（key: `ide-status-install-error`）：IDE 扩展安装失败时展示

所有通知都通过 `removeNotification` 在条件不再满足时主动移除。

#### `useLspInitializationNotification()`

> `src/hooks/notifs/useLspInitializationNotification.tsx:22-130`

通过轮询（每 5 秒，使用 `useInterval`）监控 LSP 服务器状态。仅在 `ENABLE_LSP_TOOL` 环境变量启用时激活。

1. 检查 LSP Manager 初始化状态，失败时添加错误并停止轮询
2. 遍历所有 LSP 服务器实例，将进入 `error` 状态的服务器报告为通知
3. 同时将错误写入 `appState.plugins.errors`，供 `/doctor` 命令展示
4. 使用 `notifiedErrorsRef`（Set）防止同一错误重复通知

#### `usePluginInstallationStatus()`

> `src/hooks/notifs/usePluginInstallationStatus.tsx:10-127`

从 `AppState.plugins.installationStatus` 读取安装状态，统计失败的 marketplace 和 plugin 数量。失败数 > 0 时展示 `"N plugin(s) failed to install · /plugin for details"` 通知（priority: `medium`）。

#### `usePluginAutoupdateNotification()`

> `src/hooks/notifs/usePluginAutoupdateNotification.tsx:14-78`

订阅 `onPluginsAutoUpdated` 事件，当插件自动更新完成时：
- 从插件 ID 中提取名称（去掉 `@marketplace` 后缀）
- 展示更新的插件列表，提示用户执行 `/reload-plugins`
- 通知在 10 秒后自动消失（`timeoutMs: 10000`）

#### `useModelMigrationNotifications()`

> `src/hooks/notifs/useModelMigrationNotifications.tsx:9-51`

基于 `useStartupNotification` 的一次性通知。维护一个 `MIGRATIONS` 数组，目前包含两个迁移：

- **Sonnet 4.5 → 4.6**：检查 `config.sonnet45To46MigrationTimestamp`
- **Opus Pro → Opus 4.6**：检查 `legacyOpusMigrationTimestamp` 或 `opusProMigrationTimestamp`，legacy 迁移额外提示可通过 `CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP=1` 退出

使用 `recent()` 函数判断时间戳是否在 3 秒内（即当次启动触发的迁移）。

#### `useSettingsErrors()`

> `src/hooks/notifs/useSettingsErrors.tsx:9-68`

监听配置文件变化（通过 `useSettingsChange`），调用 `getSettingsWithAllErrors()` 获取校验错误：
- 有错误时展示 `"Found N settings issue(s) · /doctor for details"`（priority: `high`，60 秒超时）
- 错误清除时主动移除通知
- 返回当前错误列表供调用方使用（**唯一一个有返回值的通知 Hook**）

#### `useAutoModeUnavailableNotification()`

> `src/hooks/notifs/useAutoModeUnavailableNotification.ts:19-56`

一次性通知，当用户通过 Shift+Tab 轮切权限模式、跳过了 auto 模式位置时触发。需要满足以下条件：
- `TRANSCRIPT_CLASSIFIER` 特性门控已启用
- 当前模式为 `default`，且前一模式不是 `default` / `auto`
- auto 模式不可用且用户已 opt-in
- 根据具体原因（settings / circuit-breaker / org-allowlist）展示对应消息

#### `useCanSwitchToExistingSubscription()`

> `src/hooks/notifs/useCanSwitchToExistingSubscription.tsx:13-59`

启动时异步检查用户是否拥有未激活的 Claude 订阅（Pro 或 Max）。如果检测到：
- 展示 `"Use your existing Claude {Pro/Max} plan with Claude Code · /login to activate"`
- 使用 `subscriptionNoticeCount` 限制最多展示 3 次
- 记录分析事件 `tengu_switch_to_subscription_notice_shown`

#### `useDeprecationWarningNotification(model: string)`

> `src/hooks/notifs/useDeprecationWarningNotification.tsx:6-43`

当模型已废弃时展示警告（priority: `high`），通过 `getModelDeprecationWarning(model)` 获取警告文本，使用 `lastWarningRef` 避免重复。模型切换到非废弃模型时自动重置跟踪。

#### `useInstallMessages()`

> `src/hooks/notifs/useInstallMessages.tsx:3-25`

启动时调用 `checkInstall()` 检查安装状态，将返回的消息映射为通知：
- `error` 类型或需要用户操作 → `high` 优先级，`error` 颜色
- `path` / `alias` 类型 → `medium` 优先级
- 其他 → `low` 优先级

#### `useNpmDeprecationNotification()`

> `src/hooks/notifs/useNpmDeprecationNotification.tsx:6-24`

提示用户从 npm 安装方式迁移到原生安装器。在 bundled 模式或开发模式下跳过。通知持续 15 秒（priority: `high`）。

#### `useMcpConnectivityStatus({ mcpClients })`

> `src/hooks/notifs/useMcpConnectivityStatus.tsx:13-75`

分析 MCP 服务器连接列表，分四种情况展示通知：

| 状态 | 通知 key | 描述 |
|------|---------|------|
| 本地服务器失败 | `mcp-failed` | "N MCP server(s) failed · /mcp" |
| claude.ai 连接器失败 | `mcp-claudeai-failed` | "N claude.ai connector(s) unavailable · /mcp" |
| 本地服务器需要认证 | `mcp-needs-auth` | "N MCP server(s) need auth · /mcp" |
| claude.ai 需要认证 | `mcp-claudeai-needs-auth` | 仅在之前连接过时展示（`hasClaudeAiMcpEverConnected`） |

#### `useStartupNotification(compute)`

> `src/hooks/notifs/useStartupNotification.ts:19-41`

通用的一次性启动通知基础设施（已在关键流程中详述）。

#### `useTeammateLifecycleNotification()`

> `src/hooks/notifs/useTeammateShutdownNotification.ts:54-78`

监听 AppState 中的 tasks 变化，跟踪 `InProcessTeammateTask` 的生命周期：
- 新任务进入 `running` 状态 → 发送 spawn 通知
- 任务进入 `completed` 状态 → 发送 shutdown 通知
- 使用 `fold` 机制合并重复通知（如 "3 agents spawned"），通知 5 秒后消失

### 顶层通知 Hooks

#### `useChromeExtensionNotification()`

> `src/hooks/useChromeExtensionNotification.tsx:16-49`

管理 Chrome 扩展相关通知，依次检查：
1. Chrome 功能是否应该启用（受 `--chrome` / `--no-chrome` 命令行参数控制）
2. 非订阅用户 → 错误提示（priority: `immediate`）
3. 扩展未安装 → 安装提示（非 Homespace 环境）
4. 默认启用时 → 低优先级提示 `"Claude in Chrome enabled · /chrome"`

#### `useClaudeCodeHintRecommendation()`

> `src/hooks/useClaudeCodeHintRecommendation.tsx:24-80`

处理通过 `<claude-code-hint />` 标签驱动的插件安装推荐：
- 使用 `useSyncExternalStore` 订阅待处理的 hint
- 每个插件最多提示一次（记录到配置中）
- 用户可选择 yes（安装）/ no（跳过）/ disable（禁用推荐）
- 记录分析事件 `tengu_plugin_hint_response`

#### `useOfficialMarketplaceNotification()`

> `src/hooks/useOfficialMarketplaceNotification.tsx:12-47`

启动时检查并自动安装 Anthropic 官方 marketplace：
- 安装成功 → `"✓ Anthropic marketplace installed · /plugin to see available plugins"`
- 配置保存失败 → 错误提示检查 `~/.claude.json` 权限
- 未知原因跳过 → `"Failed to install... · Will retry on next startup"`
- 已安装 / 策略阻止 / 已尝试 / git 不可用 → 静默跳过

#### `useUpdateNotification(updatedVersion, initialVersion)`

> `src/hooks/useUpdateNotification.ts:16-34`

比较当前版本与最新版本的 semver 主版本号：
- 使用 `getSemverPart()` 提取 `major.minor.patch`
- 版本变化时返回新版本字符串（触发更新提示），否则返回 null
- 通过 `lastNotifiedSemver` 状态避免同一版本重复提示

#### `useIssueFlagBanner(messages, submitCount)`

> `src/hooks/useIssueFlagBanner.ts:92-133`

仅对内部用户（`USER_TYPE === 'ant'`）生效的问题标记横幅。触发条件：
- 至少 3 次提交（`MIN_SUBMIT_COUNT`）
- 30 分钟冷却期（`COOLDOWN_MS`）
- 会话兼容容器检查（`isSessionContainerCompatible`）：排除使用 MCP 工具或外部命令的会话
- 摩擦信号检测（`hasFrictionSignal`）：检测用户纠正性语言（如 "that's wrong"、"try again"、"why did you" 等）

#### `usePromptsFromClaudeInChrome(mcpClients, toolPermissionMode)`

> `src/hooks/usePromptsFromClaudeInChrome.tsx:31-66`

监听来自 Chrome 中 Claude 扩展的提示通知：
- 通过 MCP 协议的 `notifications/message` 方法接收
- 验证 Chrome 扩展 Tab ID 是否在跟踪列表中
- 支持文本和图片（base64 编码）两种内容类型
- 同步当前权限模式到 Chrome 扩展（`bypassPermissions` → `skip_all_permission_checks`，其他 → `ask`）

## 接口/类型定义

### 通知对象结构

所有 Hook 使用的 `Notification` 类型定义在 `src/context/notifications.js`，关键字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `key` | `string` | 唯一标识，用于去重和移除 |
| `text` | `string` | 纯文本通知内容 |
| `jsx` | `ReactElement` | 富文本通知内容（与 text 二选一） |
| `priority` | `'immediate' \| 'high' \| 'medium' \| 'low'` | 显示优先级 |
| `color` | `string` | 通知颜色主题 |
| `timeoutMs` | `number` | 自动消失时间（毫秒） |
| `invalidates` | `string[]` | 该通知出现时应移除的其他通知 key |
| `fold` | `(acc, incoming) => Notification` | 合并重复通知的函数 |

## 边界 Case 与注意事项

- **远程模式全局守卫**：几乎所有通知 Hook 的第一步都是检查 `getIsRemoteMode()`。在远程模式下，通知完全被抑制，避免在无交互的远程执行环境中产生噪音

- **React Compiler 优化**：大部分编译后代码包含 `_c()` 缓存机制（React Compiler runtime），通过 `$[n]` 数组做细粒度的记忆化。这些是编译产物，源码中使用的是标准的 `useMemo` / `useCallback`

- **一次性 vs 持续性通知**：基于 `useStartupNotification` 的 Hook 都是一次性的（mount 时执行一次）；而 `useRateLimitWarningNotification`、`useFastModeNotification` 等则持续监听状态变化

- **通知去重**：`key` 字段用于防止同一类通知重复展示；部分 Hook 还使用 `useRef` 额外跟踪已展示状态

- **`useIssueFlagBanner` 仅限内部用户**：通过编译时常量 `process.env.USER_TYPE !== 'ant'` 提前返回，外部用户完全不执行该逻辑

- **`fold` 合并机制**：`useTeammateLifecycleNotification` 使用 `fold` 函数将多个 spawn/shutdown 事件合并为单条通知（如 "3 agents spawned"），避免通知洪泛