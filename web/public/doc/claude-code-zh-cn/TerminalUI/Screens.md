# Screens — REPL 主屏幕与应用启动编排

## 概述与职责

Screens 模块是 Claude Code 终端 UI 的**顶层屏幕层**，负责定义用户与应用交互的主界面和启动流程。它隶属于 **TerminalUI** 层级，位于 Ink 框架和 UI 组件之上，CoreEngine 查询引擎之下——接收用户输入、驱动查询引擎、渲染对话流。

该模块由 7 个文件组成，分为三类职责：

- **核心屏幕**（`src/screens/`）：REPL 主交互界面、Doctor 诊断屏幕、会话恢复选择器
- **启动编排**（`replLauncher.tsx`、`interactiveHelpers.tsx`）：应用初始化流程、setup 对话框序列、Ink 渲染入口
- **辅助启动器**（`dialogLaunchers.tsx`、`ink.ts`）：一次性对话框的延迟加载封装、Ink 渲染引擎包装

同级兄弟模块包括 Entrypoints（CLI/SDK 入口层）、CoreEngine（查询引擎）、ToolSystem（工具框架）等，Screens 作为 TerminalUI 的组成部分，向下驱动 CoreEngine 处理用户输入，向上接收流式响应并渲染。

## 文件概览

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/screens/REPL.tsx` | ~5005 | 核心交互界面，消息列表+输入框+权限弹窗+对话框的完整组装 |
| `src/screens/ResumeConversation.tsx` | ~370 | 会话恢复：加载历史日志、选择会话、恢复状态后挂载 REPL |
| `src/screens/Doctor.tsx` | ~350 | 诊断屏幕：版本、环境、配置、Agent、锁信息检查 |
| `src/interactiveHelpers.tsx` | ~360 | setup 流程编排：onboarding、trust dialog、权限确认等序列 |
| `src/replLauncher.tsx` | ~22 | 动态加载 App+REPL 并挂载到 Ink Root |
| `src/dialogLaunchers.tsx` | ~170 | 7 个一次性对话框的延迟加载启动器 |
| `src/ink.ts` | ~86 | Ink 渲染入口：包装 ThemeProvider，re-export Ink 组件 |

## 关键流程

### 1. 应用启动流程（interactiveHelpers.tsx → replLauncher.tsx）

应用从 CLI 入口启动后，经过以下编排序列到达 REPL：

1. **`getRenderContext()`** 创建渲染上下文——配置 FPS 追踪器、统计收集器、帧性能日志（`src/interactiveHelpers.tsx:299-360`）
2. **`showSetupScreens()`** 按顺序展示 setup 对话框序列（`src/interactiveHelpers.tsx:104-298`）：
   - Onboarding 首次引导（未完成时必显）
   - TrustDialog 工作区信任确认（所有交互式会话必经）
   - GrowthBook 初始化与 MCP 服务器审批
   - CLAUDE.md 外部引用审批
   - API Key 信任确认、BypassPermissions 确认、AutoMode Opt-in
   - Chrome/Channel 等附加 onboarding
3. **`launchRepl()`** 动态 `import()` App 和 REPL 组件，通过 `renderAndRun()` 挂载到 Ink Root（`src/replLauncher.tsx:12-22`）
4. **`renderAndRun()`** 渲染根元素、启动延迟预取、等待退出、执行优雅关闭（`src/interactiveHelpers.tsx:98-103`）

每个 setup 对话框通过 **`showSetupDialog()`** 统一包装——它用 `AppStateProvider` + `KeybindingSetup` 包裹渲染器，返回 Promise 等待用户完成操作（`src/interactiveHelpers.tsx:86-92`）。

### 2. REPL 主循环（REPL.tsx）

REPL 是整个应用最核心的组件，~5000 行代码承载了完整的交互循环：

**用户输入 → 消息处理 → API 查询 → 流式渲染 → 权限确认 → 结果展示**

#### 2.1 输入处理（onSubmit）

用户在 `PromptInput` 中输入文本或斜杠命令后触发 `onSubmit`（`src/screens/REPL.tsx:3142`）：

1. **即时命令检测**：如果输入是 `/` 开头且匹配 `immediate: true` 的命令（如 `/btw`），直接执行不入队
2. **普通命令/文本**：调用 `handlePromptSubmit()` 处理——解析引用、构建消息、展开技能 prompt
3. **消息入队**：若当前有查询运行中，新消息通过 `enqueue()` 排队等待

#### 2.2 查询执行（onQuery → onQueryImpl）

`onQuery`（`src/screens/REPL.tsx:2855`）是查询的入口：

1. **并发守卫**：`queryGuard.tryStart()` 原子性检查是否已有查询运行，避免并发
2. **消息追加**：将新消息同步追加到 `messagesRef`（Zustand 模式：ref 为 truth，React state 为投影）
3. **调用 `query()`**：委托 CoreEngine 执行 API 调用，传入系统提示词、工具列表、thinking 配置等
4. **流式事件处理**：`onQueryEvent` 处理模型响应流——更新 streaming text、工具调用进度、thinking 状态
5. **收尾**：记录成本、生成会话标题、重置加载状态、处理自动恢复

#### 2.3 UI 渲染层次

REPL 的 JSX 返回值组装了整个屏幕（`src/screens/REPL.tsx:4548-`）：

```
KeybindingSetup
├── AnimatedTerminalTitle（终端标签页标题+动画）
├── GlobalKeybindingHandlers / CommandKeybindingHandlers
├── ScrollKeybindingHandler（全屏模式键盘滚动）
├── CancelRequestHandler（Ctrl+C 取消）
├── MCPConnectionManager
│   └── FullscreenLayout
│       ├── scrollable:
│       │   ├── TeammateViewHeader
│       │   ├── Messages（消息列表）
│       │   ├── 用户输入占位符
│       │   ├── toolJSX（斜杠命令渲染区）
│       │   └── SpinnerWithVerb（加载指示器）
│       ├── bottom:
│       │   ├── permissionStickyFooter
│       │   ├── 权限/沙箱/Prompt 对话框
│       │   ├── TaskListV2
│       │   ├── 各类 Callout（Effort、Remote、Desktop Upsell）
│       │   ├── PromptInput（输入框）
│       │   └── CompanionSprite
│       ├── overlay: PermissionRequest
│       └── modal: 居中的本地 JSX 命令
```

屏幕有两种模式（`Screen = 'prompt' | 'transcript'`）：
- **prompt**：正常交互模式，显示消息+输入框
- **transcript**：只读转录模式（Ctrl+O 切换），支持虚拟滚动、`/` 搜索、`v` 导出到编辑器

### 3. 会话恢复流程（ResumeConversation.tsx）

`ResumeConversation` 组件处理 `claude --resume` 的交互流程（`src/screens/ResumeConversation.tsx:67`）：

1. **加载日志**：`loadSameRepoMessageLogsProgressive()` 渐进式加载同仓库的会话日志
2. **展示选择器**：渲染 `LogSelector` 让用户选择要恢复的会话，支持搜索、分页加载、全项目切换
3. **恢复会话**：`onSelect` 中调用 `loadConversationForResume()` 加载完整消息历史
4. **状态重建**：恢复 session ID、成本状态、Agent 定义、worktree、文件历史快照、内容替换记录
5. **挂载 REPL**：将恢复的消息和状态作为 `initialMessages` 等 props 传入 REPL 组件

跨项目恢复时，会复制命令到剪贴板并显示提示，引导用户在正确的目录下执行。

### 4. Doctor 诊断屏幕（Doctor.tsx）

`Doctor` 组件（`src/screens/Doctor.tsx:100`）提供系统诊断信息：

- 当前版本与最新版本对比（npm/GCS dist tags）
- 环境变量验证（`BASH_MAX_OUTPUT_LENGTH` 等有界整数）
- 模型最大输出 token 数
- MCP 工具连接状态
- Agent 定义（用户级/项目级目录、加载失败文件）
- 沙箱状态
- 设置验证错误
- 版本锁信息（PID-based locking）
- 上下文警告（CLAUDE.md 配置问题等）

## 函数签名

### interactiveHelpers.tsx

#### `showSetupScreens(root, permissionMode, allowDangerouslySkipPermissions, commands?, claudeInChrome?, devChannels?): Promise<boolean>`

启动前 setup 对话框序列。返回是否显示了 onboarding。

- **root**：Ink Root 实例
- **permissionMode**：`PermissionMode`——当前权限模式
- **返回值**：`true` 表示展示了 onboarding 界面

> 源码位置：`src/interactiveHelpers.tsx:104`

#### `showDialog<T>(root, renderer): Promise<T>`

通用对话框展示——将 renderer 回调渲染到 root，返回 Promise 在 `done()` 被调用时 resolve。

> 源码位置：`src/interactiveHelpers.tsx:39-44`

#### `showSetupDialog<T>(root, renderer, options?): Promise<T>`

对 `showDialog` 的增强包装，自动添加 `AppStateProvider` + `KeybindingSetup`。

> 源码位置：`src/interactiveHelpers.tsx:86-92`

#### `renderAndRun(root, element): Promise<void>`

渲染元素到 root → 启动延迟预取 → 等待退出 → 优雅关闭。

> 源码位置：`src/interactiveHelpers.tsx:98-103`

#### `exitWithError(root, message, beforeExit?): Promise<never>`

通过 Ink 渲染错误消息后退出进程。因为 Ink 的 `patchConsole` 会吞掉 `console.error`，必须通过 React 树渲染。

> 源码位置：`src/interactiveHelpers.tsx:52-57`

#### `getRenderContext(exitOnCtrlC): { renderOptions, getFpsMetrics, stats }`

创建渲染上下文，包含 FPS 追踪器、帧性能统计、闪烁检测。

> 源码位置：`src/interactiveHelpers.tsx:299`

### replLauncher.tsx

#### `launchRepl(root, appProps, replProps, renderAndRun): Promise<void>`

动态 import `App` 和 `REPL`，组装为 `<App><REPL /></App>` 并渲染。动态导入确保这些重量级组件的代码不在初始加载包中。

> 源码位置：`src/replLauncher.tsx:12-22`

### dialogLaunchers.tsx

提供 7 个延迟加载的对话框启动器，每个都通过 `showSetupDialog` + 动态 `import()` 实现：

| 函数 | 用途 |
|------|------|
| `launchSnapshotUpdateDialog` | Agent 记忆快照更新提示（merge/keep/replace） |
| `launchInvalidSettingsDialog` | 设置验证错误对话框 |
| `launchAssistantSessionChooser` | Bridge 会话选择器 |
| `launchAssistantInstallWizard` | Assistant 安装向导 |
| `launchTeleportResumeWrapper` | Teleport 会话恢复选择器 |
| `launchTeleportRepoMismatchDialog` | Teleport 仓库不匹配确认 |
| `launchResumeChooser` | 通用会话恢复选择器（包装 ResumeConversation） |

> 源码位置：`src/dialogLaunchers.tsx:29-170`

## 类型定义

### REPL Props

```typescript
type Props = {
  commands: Command[];
  debug: boolean;
  initialTools: Tool[];
  initialMessages?: MessageType[];           // 恢复会话时的初始消息
  pendingHookMessages?: Promise<HookResultMessage[]>; // 延迟注入的 hook 消息
  initialFileHistorySnapshots?: FileHistorySnapshot[];
  initialContentReplacements?: ContentReplacementRecord[];
  initialAgentName?: string;
  initialAgentColor?: AgentColorName;
  mcpClients?: MCPServerConnection[];
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  onBeforeQuery?: (input: string, newMessages: MessageType[]) => Promise<boolean>;
  onTurnComplete?: (messages: MessageType[]) => void | Promise<void>;
  disabled?: boolean;
  mainThreadAgentDefinition?: AgentDefinition;
  remoteSessionConfig?: RemoteSessionConfig;  // --remote 模式
  directConnectConfig?: DirectConnectConfig;  // claude connect 模式
  sshSession?: SSHSession;                    // claude ssh 模式
  thinkingConfig: ThinkingConfig;
  // ...更多可选配置
};
```

> 源码位置：`src/screens/REPL.tsx:526-570`

### Screen 类型

```typescript
type Screen = 'prompt' | 'transcript';
```

REPL 的两种显示模式——普通交互 vs 只读转录查看。

> 源码位置：`src/screens/REPL.tsx:571`

### ink.ts 导出

`ink.ts` 是 Ink 渲染层的统一入口，自动包装 `ThemeProvider`，并 re-export 了大量 Ink 组件和 hooks：

- **渲染函数**：`render(node, options)`、`createRoot(options)` —— 自动注入 ThemeProvider
- **组件**：`Box`、`Text`（主题包装版）、`Button`、`Link`、`Newline`、`Spacer` 等
- **Hooks**：`useApp`、`useInput`、`useStdin`、`useSelection`、`useTerminalViewport` 等
- **事件**：`ClickEvent`、`InputEvent`、`TerminalFocusEvent`、`EventEmitter`

> 源码位置：`src/ink.ts:1-86`

## 配置项与环境变量

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` | false | 禁用终端标签页标题更新 |
| `CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL` | false | 禁用虚拟滚动（转录模式） |
| `CLAUDE_CODE_DISABLE_MESSAGE_ACTIONS` | false | 禁用消息操作功能 |
| `CLAUDE_CODE_FRAME_TIMING_LOG` | - | 帧性能日志路径（bench 模式） |
| `CLAUDE_MORERIGHT` | false | 启用 MoreRight 功能（Anthropic 内部） |

## 边界 Case 与注意事项

- **并发查询保护**：`QueryGuard` 使用状态机（idle → dispatching → running）原子性防止并发 `onQuery` 调用。若重复触发，新消息会入队等待而非丢弃（`src/screens/REPL.tsx:2866-2886`）
- **消息 ref 同步模式**：`setMessages` 采用 Zustand 模式——`messagesRef` 同步更新为 source of truth，React state 仅作渲染投影，避免函数式 updater 读到过期数据（`src/screens/REPL.tsx:1190-1199`）
- **滚动重定位窗口**：用户手动滚动后 3 秒内，输入不会自动重定位到底部，防止阅读中被打断（`RECENT_SCROLL_REPIN_WINDOW_MS = 3000`）
- **条件加载门控**：Voice 模式、Frustration 检测、Coordinator 模式、Proactive 模式等通过 `feature()` 编译时常量门控，外部构建中完全消除（dead code elimination）
- **setup 序列阻塞**：`showSetupScreens` 中每个对话框是串行 await 的 Promise，用户必须逐个完成。Trust Dialog 是安全边界——所有后续操作（插件安装、环境变量应用）必须在 trust 确认后执行
- **动态导入策略**：`replLauncher.tsx` 和 `dialogLaunchers.tsx` 均使用动态 `import()` 延迟加载重量级组件，减小初始包体积和启动时间
- **Ink 渲染包装**：`ink.ts` 的 `render()` 和 `createRoot()` 自动注入 `ThemeProvider`，调用方无需手动包裹主题上下文