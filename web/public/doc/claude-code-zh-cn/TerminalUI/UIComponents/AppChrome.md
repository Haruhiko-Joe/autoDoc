# AppChrome — 应用外壳与杂项组件

## 概述与职责

AppChrome 是 Claude Code 终端 UI 中的**应用外壳层**，涵盖了除核心对话流和权限弹窗之外的几乎所有"周边" UI 组件。它在架构层级中属于 `TerminalUI > UIComponents` 的一个叶子模块，与同层的对话系统、权限系统、设计系统等组件共同组成完整的 UI 体验。

AppChrome 的职责可概括为六大类：

1. **欢迎界面**（LogoV2/）：启动时的 Clawd 动画、信息流、通知提示
2. **生命周期管理**：App 根组件、自动更新、退出流程、错误边界
3. **状态指示器**：状态栏、通知栏、Token 警告、各类图标指示器
4. **引导与反馈**：新手引导、反馈调查、桌面版推广
5. **远程会话**：Teleport 系列组件（传送到远程会话的完整 UI 流程）
6. **杂项工具**：诊断显示、记忆管理 UI、LSP 推荐、通行证系统等

---

## 关键流程

### 1. 应用启动流程

应用启动时，`App.tsx` 作为根组件建立三层 Context 嵌套：

1. `FpsMetricsProvider` — FPS 性能监控上下文（最外层）
2. `StatsProvider` — 统计追踪上下文
3. `AppStateProvider` — 全局应用状态（最内层，使用 `onChangeAppState` 回调）

> 源码位置：`src/components/App.tsx`

启动后，`LogoV2.tsx` 渲染欢迎界面，包含 Clawd 动画吉祥物、版本信息、最近活动、更新日志、项目引导等信息流。同时会加载各种条件通知（EmergencyTip、VoiceModeNotice、Opus1mMergeNotice、ChannelsNotice）。

### 2. 自动更新流程

`AutoUpdaterWrapper` 是更新系统的路由入口，它在挂载时检测安装类型，然后分发到三种更新器之一：

```
AutoUpdaterWrapper（检测安装类型）
  ├─→ NativeAutoUpdater    （原生二进制安装，调用 Tengu 更新器）
  ├─→ PackageManagerAutoUpdater （Homebrew/Winget/APK，仅展示提示命令）
  └─→ AutoUpdater          （npm/全局安装，执行 JS 层更新）
```

所有更新器共享相同的 Props 接口（`isUpdating`、`onAutoUpdaterResult` 等），每 30 分钟通过 `useInterval` 检查一次更新。关键逻辑包括：

- 服务端 `maxVersion` 杀开关检查
- 跳过版本逻辑（用户选择跳过某版本）
- 锁竞争处理（多进程同时更新时的优雅降级）
- NativeAutoUpdater 提供最详细的错误分类和漏斗分析埋点

> 源码位置：`src/components/AutoUpdaterWrapper.tsx`、`src/components/NativeAutoUpdater.tsx`

### 3. Teleport 远程会话流程

Teleport 系列组件实现了"传送"到远程会话的完整 UI 流程：

1. **TeleportError** — 前置检查：是否需要登录 Claude.ai、是否需要 stash 未提交的 git 变更
2. **TeleportStash** — 显示待 stash 的文件列表，执行 `stashToCleanState('Teleport auto-stash')`
3. **TeleportProgress** — 四步进度动画：验证 → 获取日志 → 获取分支 → 检出代码
4. **TeleportResumeWrapper** — 管理会话恢复流程，包含会话选择、加载和错误处理

> 源码位置：`src/components/TeleportError.tsx:1-188`

### 4. 反馈调查系统

反馈系统由多个 Hook 和组件协作，实现了节制且智能的调查展示：

- **useFeedbackSurvey** — 核心 Hook，实现时间门控（首次 10 分钟、间隔 1 小时）和概率抽样
- **useMemorySurvey** — 针对自动记忆功能的专项调查，检测会话中是否读取了记忆文件
- **usePostCompactSurvey** — 上下文压缩后的调查（20% 概率触发）
- **FeedbackSurveyView** — 数字选择 UI（0=关闭、1=差、2=一般、3=好）
- **TranscriptSharePrompt** — 调查后可选的会话记录分享请求
- **submitTranscriptShare** — 提交会话记录，包含消息脱敏和子 Agent 记录提取

所有调查使用 `useDebouncedDigitInput` Hook 处理数字输入，400ms 防抖避免误触。

> 源码位置：`src/components/FeedbackSurvey/useFeedbackSurvey.tsx`

---

## 函数签名与参数说明

### App

```tsx
function App(props: {
  getFpsMetrics: () => FpsMetrics | undefined
  stats?: StatsStore
  initialState: AppState
  children: React.ReactNode
}): JSX.Element
```

建立 FpsMetrics → Stats → AppState 三层 Provider 嵌套。

### statusLineShouldDisplay / buildStatusLineCommandInput

```tsx
function statusLineShouldDisplay(settings: Settings): boolean
function buildStatusLineCommandInput(): StatusLineCommandInput
```

`buildStatusLineCommandInput` 聚合多个数据源（模型信息、工作区路径、费用追踪、上下文窗口使用率、速率限制），构建状态栏所需的完整输入对象。

> 源码位置：`src/components/StatusLine.tsx`

### getTeleportErrors

```tsx
async function getTeleportErrors(
  errorsToIgnore?: ReadonlySet<TeleportLocalErrorType>
): Promise<{ needsLogin: boolean; needsGitStash: boolean }>
```

检查 Teleport 前置条件：Claude.ai 登录状态和 git 工作区清洁度。

### submitTranscriptShare

```tsx
async function submitTranscriptShare(
  messages: Message[],
  trigger: string,
  appearanceId: string
): Promise<TranscriptShareResult>
```

提交脱敏后的会话记录，支持从后台任务中提取子 Agent 记录，包含文件大小守卫防止 OOM。

> 源码位置：`src/components/FeedbackSurvey/submitTranscriptShare.ts`

---

## 接口/类型定义

### AutoUpdater 共享 Props

| 字段 | 类型 | 说明 |
|------|------|------|
| isUpdating | boolean | 是否正在更新 |
| onChangeIsUpdating | (v: boolean) => void | 更新状态变更回调 |
| onAutoUpdaterResult | (r: AutoUpdaterResult) => void | 更新结果回调 |
| autoUpdaterResult | AutoUpdaterResult \| null | 最新更新结果 |
| showSuccessMessage | boolean | 是否显示成功消息 |
| verbose | boolean | 详细日志模式 |

### TeleportLocalErrorType

```typescript
type TeleportLocalErrorType = 'needsLogin' | 'needsGitStash'
```

### EffortCalloutSelection

```typescript
type EffortCalloutSelection = EffortLevel | undefined | 'dismiss'
```

### FeedConfig / FeedLine（LogoV2 信息流）

```typescript
type FeedLine = { text: string; timestamp?: string }
type FeedConfig = {
  title: string
  lines: FeedLine[]
  footer?: string
  emptyMessage?: string
  customContent?: React.ReactNode
}
```

### ClawdPose

```typescript
type ClawdPose = 'default' | 'arms-up' | 'look-left' | 'look-right'
```

---

## 组件分类速览

### 欢迎界面（LogoV2/）

| 组件 | 职责 |
|------|------|
| **LogoV2** | 完整欢迎屏幕主组件，编排信息流和通知 |
| **WelcomeV2** | ASCII 艺术标题渲染，支持亮/暗主题和 Apple Terminal 兼容 |
| **CondensedLogo** | 紧凑版 Logo，含模型、版本、计费类型和推广信息 |
| **AnimatedClawd** | 可交互的 Clawd 吉祥物，支持点击触发跳跃/左右看动画 |
| **AnimatedAsterisk** | 色相扫描动画星号，1500ms 周期循环两次后停留灰色 |
| **Feed / FeedColumn** | 信息流面板和多列布局容器 |
| **feedConfigs** | 工厂函数：创建最近活动、更新日志、项目引导、通行证信息流配置 |
| **EmergencyTip** | 从 Growthbook 动态配置加载的紧急提示，自动去重 |
| **VoiceModeNotice** | 语音模式可用通知（功能门控，≤3 次展示） |
| **Opus1mMergeNotice** | Opus 1M 上下文升级推广（≤6 次展示） |
| **ChannelsNotice** | MCP Channels 功能通知（KAIROS 功能门控） |
| **GuestPassesUpsell** | 邀请通行证推广（≤3 次展示，刷新后重置计数） |
| **OverageCreditUpsell** | 超额额度推广（后端判定资格，双行格式） |

### 状态指示器

| 组件 | 职责 |
|------|------|
| **StatusLine** | 底部状态栏：聚合模型、费用、上下文窗口、速率限制信息 |
| **StatusNotices** | 启动时的警告/通知渲染器 |
| **Stats** | 完整使用统计面板，含 ASCII 图表、热力图、标签页导航 |
| **DevBar** | 开发者专用：显示最近 3 个慢同步操作（≥500ms 轮询） |
| **TokenWarning** | Token 用量预警，含上下文折叠状态标签 |
| **EffortIndicator** | 努力级别到符号的映射工具（◔ low / ◐ medium / ◕ high / ● max） |
| **EffortCallout** | 努力级别选择弹窗（30 秒自动关闭） |
| **FastIcon** | 快速模式闪电图标，支持冷却状态变暗 |
| **IdeStatusIndicator** | IDE 连接状态：显示当前文件/选区（⧉ N lines selected） |
| **BashModeProgress** | Bash 命令执行进度显示 |
| **PrBadge** | GitHub PR 徽章，按审核状态着色（绿/红/黄/紫） |
| **MemoryUsageIndicator** | 堆内存用量预警（仅内部构建） |
| **ThinkingToggle** | 扩展思考开关弹窗，含对话中切换确认 |
| **AwsAuthStatusBox** | AWS 认证进度和错误显示，含 URL 自动链接化 |

### 引导与反馈

| 组件 | 职责 |
|------|------|
| **Onboarding** | 多步新手引导：预检 → 主题 → OAuth → API Key → 安全设置 → 终端设置 |
| **ClaudeInChromeOnboarding** | Chrome 扩展集成引导对话框 |
| **DesktopHandoff** | CLI 到桌面应用的会话迁移，含下载检测和平台 URL |
| **DesktopUpsellStartup** | 桌面应用推广提示 |
| **Feedback** | 完整反馈/Bug 报告表单，集成 Claude API 格式化和 GitHub Issue 创建 |
| **FeedbackSurvey** | 会话质量调查系统（数字选择 + 时间门控 + 概率抽样） |
| **SkillImprovementSurvey** | 技能执行后的改善调查 |
| **RemoteCallout** | Remote Control 功能首次启用弹窗（仅展示一次） |
| **ShowInIDEPrompt** | 在 IDE 中打开文件编辑的权限确认对话框 |

### 远程会话（Teleport 系列）

| 组件 | 职责 |
|------|------|
| **TeleportError** | 前置错误检查（登录 + git 状态），优先处理登录错误 |
| **TeleportStash** | Git stash 确认对话框，列出待 stash 文件 |
| **TeleportProgress** | 四步旋转动画进度条（◐◓◑◒） |
| **TeleportResumeWrapper** | 会话恢复流程编排（选择 → 加载 → 错误处理） |

### 其他工具组件

| 组件 | 职责 |
|------|------|
| **SentryErrorBoundary** | React 错误边界，捕获后静默返回 null 防止崩溃 |
| **DiagnosticsDisplay** | 诊断信息显示（详细/摘要两种模式），支持多种 URI scheme |
| **MemoryFileSelector** | 记忆文件管理 UI，支持自动记忆和团队记忆路径 |
| **MemoryUpdateNotification** | 记忆更新确认通知，智能显示相对路径 |
| **PluginHintMenu** | 插件安装推荐菜单（30 秒自动关闭） |
| **LspRecommendationMenu** | LSP 插件推荐（按文件扩展名触发） |
| **Passes** | 邀请通行证管理：ASCII 票券、推荐链接、剪贴板复制 |
| **SessionBackgroundHint** | Ctrl+B 双击后台化提示（tmux 环境显示 ctrl+b ctrl+b） |
| **SessionPreview** | 历史会话预览模式，加载完整记录并渲染 |

---

## 配置项与默认值

| 配置/常量 | 值 | 说明 |
|-----------|-----|------|
| 更新检查间隔 | 30 分钟 (1800000ms) | 所有三种更新器共用 |
| 反馈首次展示延迟 | 10 分钟 | 启动后至少 10 分钟才展示调查 |
| 反馈展示间隔 | 1 小时 | 两次调查之间的最小间隔 |
| 反馈最少用户轮次 | 5 次（首次）/ 10 次（后续） | 展示前需要的最低用户交互次数 |
| 数字输入防抖 | 400ms | `useDebouncedDigitInput` 默认防抖时间 |
| 推广展示上限 | 3 次 | GuestPasses / OverageCredit / VoiceMode 共用 |
| Opus1mMerge 展示上限 | 6 次 | 独立的展示次数上限 |
| PluginHint 自动关闭 | 30 秒 | PluginHintMenu / LspRecommendation 共用 |
| EffortCallout 自动关闭 | 30 秒 | 无操作自动关闭 |
| WELCOME_V2_WIDTH | 58 | 欢迎界面的标准宽度 |
| CLAWD_HEIGHT | 3 行 | Clawd 动画容器高度 |
| Asterisk 动画周期 | 1500ms × 2 = 3000ms | 色相扫描两轮后停在灰色 |
| SessionBackgroundHint 双击窗口 | 800ms | 两次 Ctrl+B 按键的最大间隔 |

---

## 边界 Case 与注意事项

- **SentryErrorBoundary 静默吞错**：该错误边界捕获后直接返回 `null`，不向任何服务上报。这意味着被包裹组件的渲染错误会导致整块 UI 静默消失，调试时需注意。

- **AutoUpdater 锁竞争**：NativeAutoUpdater 在多个 Claude Code 进程同时运行时可能遭遇更新锁竞争，此时会记录 `tengu_native_auto_updater_lock_contention` 事件并静默跳过。

- **PackageManagerAutoUpdater 不执行更新**：与其他两种更新器不同，它只显示对应包管理器的更新命令（如 `brew upgrade claude-code`），实际更新由用户手动执行。

- **Apple Terminal 兼容**：`WelcomeV2` 和 `Clawd` 对 Apple Terminal 有特殊渲染路径——使用不同的 Unicode 字符和背景填充技巧，因为 Apple Terminal 对某些 Unicode 块字符的渲染行为不同。

- **动画尊重减弱动效偏好**：`AnimatedAsterisk` 和 `AnimatedClawd` 在挂载时读取 `prefersReducedMotion` 设置，为 `true` 时跳过动画。但注意这是挂载时的一次性读取，不响应运行时变更。

- **Feedback 组件的 URL 长度限制**：生成 GitHub Issue 链接时，URL 长度限制为 7250 字符，超出部分的会话记录会被截断。

- **ChannelsNotice 使用动态 require**：通过 `require()` 模式实现条件加载，在 KAIROS 功能标志关闭时可被 tree-shake 移除。

- **ExitFlow 的条件渲染**：仅在 `showWorktree` 为 `true` 时才渲染退出对话框（`WorktreeExitDialog`），否则返回 `null`。退出消息从预设列表中随机选取。

- **TeleportError 错误优先级**：登录错误优先于 git stash 错误处理——必须先解决登录问题才会检查 git 状态。