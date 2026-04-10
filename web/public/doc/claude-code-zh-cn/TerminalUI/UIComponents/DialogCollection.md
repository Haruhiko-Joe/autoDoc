# 独立对话框集合（DialogCollection）

## 概述与职责

DialogCollection 是 Claude Code 终端 UI 中的**独立对话框组件库**，包含 25+ 个覆盖不同业务场景的对话框。这些对话框在应用的关键交互节点弹出，用于获取用户确认、展示警告、收集输入或执行特定流程。它们位于 **TerminalUI → UIComponents** 层级中，是 REPL 主屏幕和启动流程中按需挂载的 UI 单元。

同级模块包括消息渲染组件、权限请求 UI、设计系统基础组件等；上级模块 UIComponents 包含 144 个组件，对话框集合是其中的重要子集。

### 架构特征

- **统一基础组件**：绝大多数对话框基于 `design-system/Dialog` 组件构建，获得一致的边框、标题、颜色主题和输入引导
- **选项式交互**：大多数对话框使用 `CustomSelect/Select` 组件提供选项列表，用户通过键盘上下选择后确认
- **事件分析埋点**：关键对话框（如 AutoMode、BypassPermissions、Trust）在展示和用户选择时通过 `logEvent` 发送遥测事件
- **配置持久化**：多个对话框会将用户的选择写入 `globalConfig` 或 `userSettings`，避免重复弹出

## 对话框分类与详解

### 1. 安全与权限类

#### AutoModeOptInDialog

**文件**：`src/components/AutoModeOptInDialog.tsx`

Auto 模式的启用确认对话框。Auto 模式允许 Claude 自动处理权限提示——Claude 会在执行前检查每个工具调用是否存在风险或 prompt injection。

**Props**：
| 字段 | 类型 | 说明 |
|------|------|------|
| onAccept | `() => void` | 用户接受后的回调 |
| onDecline | `() => void` | 用户拒绝后的回调 |
| declineExits | `boolean?` | 若为 true，拒绝按钮显示"No, exit"而非"No, go back" |

**用户选项**：
- "Yes, and make it my default mode" — 启用并将 auto 设为默认模式（写入 `permissions.defaultMode: "auto"`）
- "Yes, enable auto mode" — 仅本次启用
- "No, go back" / "No, exit" — 拒绝

> 注意：`AUTO_MODE_DESCRIPTION` 常量经过法律审核，修改需法律团队批准（`src/components/AutoModeOptInDialog.tsx:9`）。

#### BypassPermissionsModeDialog

**文件**：`src/components/BypassPermissionsModeDialog.tsx`

危险模式确认——Bypass Permissions 模式下 Claude Code 不会请求任何操作审批。对话框以 `color="error"` 红色警告样式展示。

**关键行为**：
- 接受后写入 `skipDangerousModePermissionPrompt: true` 到 userSettings
- 拒绝或按 Escape 均触发 `gracefulShutdownSync(1)` 立即退出进程
- 明确告知用户"只应在沙盒容器/VM 中使用"

#### TrustDialog

**文件**：`src/components/TrustDialog/TrustDialog.tsx`，`src/components/TrustDialog/utils.ts`

项目信任确认对话框。当用户首次在某个项目目录运行 Claude Code 时弹出，检查项目配置中是否存在需要信任的危险设置。

**检查项**（通过 `utils.ts` 中的辅助函数获取）：
- **Bash 权限**：项目 settings 中是否有 `BashTool` 的 allow 规则（`getBashPermissionSources`）
- **Hooks**：是否配置了 hooks、statusLine、fileSuggestion（`getHooksSources`）
- **MCP 服务器**：项目级 MCP 服务器配置
- **API Key Helper**：是否配置了 `apiKeyHelper`（`getApiKeyHelperSources`）
- **AWS/GCP 命令**：是否配置了 `awsAuthRefresh`/`awsCredentialExport`/`gcpAuthRefresh`
- **OTEL Headers Helper**：是否配置了 `otelHeadersHelper`
- **危险环境变量**：不在 `SAFE_ENV_VARS` 白名单内的 env 变量（`getDangerousEnvVarsSources`）

接受后调用 `saveCurrentProjectConfig` 和 `setSessionTrustAccepted` 标记信任。

#### ManagedSettingsSecurityDialog

**文件**：`src/components/ManagedSettingsSecurityDialog/ManagedSettingsSecurityDialog.tsx`，`utils.ts`

组织托管设置的安全审批对话框。当组织通过托管设置配置了可能执行任意代码或拦截提示/响应的设置时弹出。

**核心逻辑**（`utils.ts`）：
- `extractDangerousSettings()` — 从 settings 中提取危险的 shell 设置、不安全环境变量、hooks
- `hasDangerousSettingsChanged()` — 对比新旧设置判断是否需要重新提示
- `formatDangerousSettingsList()` — 格式化危险设置名称列表供 UI 展示

使用 `PermissionDialog` 组件渲染，提供 "accept" 和 "exit" 两个选项。

#### ApproveApiKey

**文件**：`src/components/ApproveApiKey.tsx`

检测到环境中存在自定义 `ANTHROPIC_API_KEY` 时的审批对话框。显示 key 的截断形式（`sk-ant-...{truncated}`）。

**关键行为**：
- 默认选中 "No (recommended)"，推荐不使用自定义 key
- 选择结果持久化到 `globalConfig.customApiKeyResponses.approved/rejected` 数组
- Escape 和 Cancel 均等同于拒绝

#### ClaudeMdExternalIncludesDialog

**文件**：`src/components/ClaudeMdExternalIncludesDialog.tsx`

当项目的 CLAUDE.md 文件引用了工作目录外部的文件时弹出。明确警告"永远不要对第三方仓库允许此操作"。

**Props**：
| 字段 | 类型 | 说明 |
|------|------|------|
| onDone | `() => void` | 完成回调 |
| isStandaloneDialog | `boolean?` | 独立弹出时显示边框和输入引导 |
| externalIncludes | `ExternalClaudeMdInclude[]?` | 外部引用路径列表 |

选择结果写入 `projectConfig.hasClaudeMdExternalIncludesApproved` 和 `hasClaudeMdExternalIncludesWarningShown`。

### 2. 成本与会话管理类

#### CostThresholdDialog

**文件**：`src/components/CostThresholdDialog.tsx`

当会话 API 消费达到 $5 阈值时弹出的提醒对话框。仅包含一个"Got it, thanks!"确认按钮，并提供费用监控文档链接。

#### IdleReturnDialog

**文件**：`src/components/IdleReturnDialog.tsx`

用户离开后返回时的对话框。显示离开时长和当前对话 token 数，建议用户决策。

**Props**：`idleMinutes: number`、`totalInputTokens: number`、`onDone: (action) => void`

**选项**：
- "Continue this conversation" — 继续当前对话
- "Send message as a new conversation" — 清除上下文重新开始
- "Don't ask me again" — 永久关闭此提醒

内部辅助函数 `formatIdleDuration()` 将分钟数格式化为 `< 1m`、`42m`、`2h 15m` 等形式。

### 3. 远程连接与环境类

#### BridgeDialog

**文件**：`src/components/BridgeDialog.tsx`

Bridge 远程连接的状态对话框。这是一个复杂的状态管理组件，从 AppState 中读取 bridge 连接状态（connected、sessionActive、reconnecting、error 等）。

**功能**：
- 显示连接 URL 和 QR 码（可切换显示）
- 显示当前仓库名和分支名
- 支持 verbose 模式展示 environmentId 和 sessionId
- 使用 `useInput` 监听 'd' 键断开连接
- 注册为 overlay：`"bridge-dialog"`

#### RemoteEnvironmentDialog

**文件**：`src/components/RemoteEnvironmentDialog.tsx`

远程环境选择对话框。异步加载可用的远程环境列表，允许用户选择、切换或取消选择。

**状态机**：`'loading' | 'updating' | null`

**关键流程**：
1. 组件挂载时调用 `getEnvironmentSelectionInfo()` 获取可用环境
2. 展示环境列表（标记当前选中的环境和来源）
3. 用户选择后调用 `updateSettingsForSource()` 更新设置
4. 提供"Clear selection"和"Cancel"选项

#### TeleportRepoMismatchDialog

**文件**：`src/components/TeleportRepoMismatchDialog.tsx`

Teleport 功能中仓库路径不匹配时的对话框。当用户 teleport 到某个 repo 但本地有多个可能的路径时，允许选择正确路径。

**关键行为**：
- 选择路径后调用 `validateRepoAtPath()` 异步验证仓库正确性
- 验证失败时调用 `removePathFromRepo()` 从配置中移除无效路径，并更新可选列表
- 验证期间显示 Spinner 加载状态
- 所有路径失效时提示用户从正确的 checkout 运行 `claude --teleport`

### 4. 搜索与导航类

#### GlobalSearchDialog

**文件**：`src/components/GlobalSearchDialog.tsx`

全局代码搜索对话框（`Ctrl+Shift+F` / `Cmd+Shift+F`）。基于 ripgrep 实现跨工作区的实时搜索。

**核心常量**：
- `VISIBLE_RESULTS = 12` — 可见结果数
- `DEBOUNCE_MS = 100` — 搜索防抖
- `MAX_MATCHES_PER_FILE = 10`，`MAX_TOTAL_MATCHES = 500` — 结果上限
- `PREVIEW_CONTEXT_LINES = 4` — 预览上下文行数

**功能**：
- 使用 `ripGrepStream` 流式搜索
- 基于 `FuzzyPicker` 组件展示结果
- 支持右侧预览（终端宽度 ≥ 140 列时启用）
- 支持在外部编辑器中打开文件（`openFileInExternalEditor`）
- 注册为 overlay：`"global-search"`

#### HistorySearchDialog

**文件**：`src/components/HistorySearchDialog.tsx`

历史对话搜索对话框。加载并搜索用户的对话历史记录。

**搜索策略**：
- 精确匹配优先（`item.lower.includes(q)`）
- 子序列模糊匹配作为补充（`isSubsequence`）
- 支持右侧预览（终端宽度 ≥ 100 列时）
- 显示每条记录的相对时间（如"2h ago"）

**数据来源**：`getTimestampedHistory()` 异步迭代器

#### QuickOpenDialog

**文件**：`src/components/QuickOpenDialog.tsx`

快速打开文件对话框（`Ctrl+Shift+P` / `Cmd+Shift+P`）。模糊文件查找器，带语法高亮的文件预览。

**功能**：
- 使用 `generateFileSuggestions()` 生成文件建议
- 基于 `FuzzyPicker` 组件
- 支持右侧预览（终端宽度 ≥ 120 列时），展示文件前 20 行内容
- 使用 generation counter 避免竞态条件
- 注册为 overlay：`"quick-open"`

#### ExportDialog

**文件**：`src/components/ExportDialog.tsx`

对话导出对话框。提供两种导出方式：

**Props**：`content: string`、`defaultFilename: string`、`onDone: (result) => void`

**导出选项**：
- **剪贴板** — 调用 `setClipboard(content)` 通过 OSC 终端协议复制
- **文件** — 进入文件名输入子界面，使用 `TextInput` 编辑文件名，最终写入 `.txt` 文件

**交互细节**：在文件名输入子界面按 Escape 返回选项列表而非关闭对话框。

### 5. IDE 集成类

#### IdeAutoConnectDialog

**文件**：`src/components/IdeAutoConnectDialog.tsx`

IDE 自动连接设置对话框。在非受支持终端（`!isSupportedTerminal()`）且未设置过自动连接时弹出。

**导出函数**：
- `IdeAutoConnectDialog` — 启用自动连接的对话框
- `IdeDisableAutoConnectDialog` — 禁用自动连接的对话框
- `shouldShowAutoConnectDialog()` — 判断是否需要展示启用对话框
- `shouldShowDisableAutoConnectDialog()` — 判断是否需要展示禁用对话框

配置写入 `globalConfig.autoConnectIde` 和 `hasIdeAutoConnectDialogBeenShown`。

#### IdeOnboardingDialog

**文件**：`src/components/IdeOnboardingDialog.tsx`

IDE 首次连接的引导对话框。展示 IDE 类型特定的欢迎信息。

**关键逻辑**：
- 检测 IDE 类型（VS Code、JetBrains 等），通过 `getTerminalIdeType()` 获取
- JetBrains IDE 使用"plugin"术语，VS Code 使用"extension"
- 显示平台特定的 mention 快捷键（macOS: `Cmd+Option+K`，其他: `Ctrl+Alt+K`）
- 组件挂载时调用 `markDialogAsShown()` 标记已展示

### 6. 频道与版本管理类

#### ChannelDowngradeDialog

**文件**：`src/components/ChannelDowngradeDialog.tsx`

从 latest 切换到 stable 频道时的降级确认对话框。

**Props**：`currentVersion: string`、`onChoice: (choice: ChannelDowngradeChoice) => void`

**选项类型** `ChannelDowngradeChoice`：`'downgrade' | 'stay' | 'cancel'`
- "Allow possible downgrade to stable version"
- "Stay on current version (x.x.x) until stable catches up"

#### DevChannelsDialog

**文件**：`src/components/DevChannelsDialog.tsx`

开发频道加载警告。使用 `--dangerously-load-development-channels` 标志时弹出，以 `color="error"` 红色警告展示。

**关键行为**：
- 显示即将加载的频道列表（格式：`plugin:name@marketplace` 或 `server:name`）
- 拒绝或 Escape 触发 `gracefulShutdownSync(0)` 退出

### 7. 配置与校验类

#### InvalidConfigDialog

**文件**：`src/components/InvalidConfigDialog.tsx`

配置文件 JSON 解析失败时的对话框。显示文件路径和错误描述。

**选项**：
- "Exit and fix the config file" — 退出修复
- "Reset to empty config ({})" — 重置为空配置（调用 `writeFileSync_DEPRECATED` 写入 `{}`）

特殊之处：该组件导出 `handleInvalidConfig()` 函数，独立渲染对话框（使用 `render()` 直接挂载），不依赖 REPL 上下文。

#### InvalidSettingsDialog

**文件**：`src/components/InvalidSettingsDialog.tsx`

settings 文件校验错误对话框。使用 `ValidationErrorsList` 组件展示错误详情。

**Props**：`settingsErrors: ValidationError[]`、`onContinue: () => void`、`onExit: () => void`

**选项**：
- "Exit and fix manually"
- "Continue without these settings"（跳过含错误的整个文件）

### 8. 认证与登录类

#### ConsoleOAuthFlow

**文件**：`src/components/ConsoleOAuthFlow.tsx`

OAuth 认证流程的完整 UI。这是最复杂的对话框之一，实现了完整的状态机。

**状态机** `OAuthStatus`：
- `idle` — 初始状态，等待选择登录方式
- `platform_setup` — 显示平台设置信息（Bedrock/Vertex/Foundry）
- `ready_to_start` — 准备开始 OAuth 流程
- `waiting_for_login` — 浏览器已打开，等待用户登录（显示 URL）
- `creating_api_key` — 获取到 access token，正在创建 API key
- `about_to_retry` — 即将重试
- `success` — 认证成功
- `error` — 认证失败（可重试）

**Props**：
| 字段 | 类型 | 说明 |
|------|------|------|
| onDone | `() => void` | 完成回调 |
| startingMessage | `string?` | 初始提示消息 |
| mode | `'login' \| 'setup-token'` | 工作模式 |
| forceLoginMethod | `'claudeai' \| 'console'?` | 强制登录方式 |

**功能**：支持代码粘贴输入（`TextInput`）、剪贴板复制 URL、终端通知、SSL 错误提示。

### 9. 工作区管理类

#### WorktreeExitDialog

**文件**：`src/components/WorktreeExitDialog.tsx`

退出 Git worktree 时的对话框。检查 worktree 中的未提交更改和新 commit。

**状态机**：`'loading' | 'asking' | 'keeping' | 'removing' | 'done'`

**关键流程**：
1. 加载阶段：执行 `git status --porcelain` 检查变更，`git rev-list --count` 检查新 commit
2. 无变更时静默清理 worktree 并恢复原始工作目录
3. 有变更时提供选项："Keep worktree branch"（保留）或 "Remove worktree"（删除）
4. 清理时调用 `cleanupWorktree()`，恢复 `originalCwd`，记录退出状态

#### WorkflowMultiselectDialog

**文件**：`src/components/WorkflowMultiselectDialog.tsx`

GitHub 工作流多选对话框。用于 GitHub App 安装流程中选择要启用的工作流。

**可选工作流**：
- `claude` — "@Claude Code - Tag @claude in issues and PR comments"
- `claude-review` — "Claude Code Review - Automated code review on new PRs"

使用 `SelectMulti` 组件（非标准 Select），支持 Space 切换选中、至少需选择一个工作流。

## 通用设计模式

### Dialog 组件接口

所有对话框使用的 `Dialog` 组件接受以下关键属性：
- `title` — 标题文本
- `color` — 主题色（`"warning"` | `"error"` | `"permission"` | `"ide"` | `"background"` 等）
- `onCancel` — Escape 键回调
- `hideBorder` — 隐藏边框（嵌入式使用时）
- `hideInputGuide` — 隐藏底部操作提示

### React Compiler 优化

所有编译后的 `.tsx` 文件使用 React Compiler 的 memo cache 模式（`_c()` 函数和 `Symbol.for("react.memo_cache_sentinel")`），自动实现细粒度的渲染优化。这是编译产物的特征，源码中为标准 React 组件写法。

### Overlay 注册

搜索类对话框（GlobalSearch、HistorySearch、QuickOpen）通过 `useRegisterOverlay()` 注册为 overlay 层，确保在覆盖层管理系统中正确处理层叠和焦点。

## 边界 Case 与注意事项

- **BypassPermissionsMode**：拒绝即退出进程，没有"返回"选项——这是有意为之的安全设计
- **AutoModeOptIn** 的描述文本受法律审核保护，不可随意修改
- **ConsoleOAuthFlow** 的状态机包含递归结构（`about_to_retry.nextState` 可指向任意状态）
- **WorktreeExitDialog** 使用 lazy require 打破循环依赖：`sessionStorage → commands → exit → ExitFlow → WorktreeExitDialog`
- **TeleportRepoMismatchDialog** 会动态移除验证失败的路径，可能导致选项列表变空
- **GlobalSearchDialog** 的搜索结果有硬上限（500 条），超出时显示截断提示