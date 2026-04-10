# 设置与配置管理 UI（SettingsAndConfig）

## 概述与职责

SettingsAndConfig 是 Claude Code 终端 UI 中负责**所有用户偏好设置和配置管理**的组件集合。它隶属于 TerminalUI > UIComponents 层，为用户提供了从全局设置、沙盒配置、Hooks 管理、帮助面板到各种选择器（主题、模型、语言、输出样式、日志）的完整配置界面。

在 TerminalUI 架构中，它与 InkFramework 提供的基础 UI 原语（Box、Text、Select、Dialog、Tabs 等）紧密协作，通过 StateAndContext 层（AppState、Settings Context）读写全局状态，并依赖 Keybindings 系统注册快捷键响应。

同级兄弟模块包括消息渲染、权限请求 UI、设计系统基础组件、PromptInput 输入框等业务 UI 组件。

## 模块组成

本模块由以下子系统组成：

| 子系统 | 目录/文件 | 核心组件 |
|--------|-----------|----------|
| 设置面板 | `Settings/` | `Settings`, `Config`, `Usage`, `Status` |
| 沙盒配置 | `sandbox/` | `SandboxSettings`, `SandboxConfigTab`, `SandboxDependenciesTab`, `SandboxOverridesTab`, `SandboxDoctorSection` |
| Hooks 配置 | `hooks/` | `HooksConfigMenu`, `SelectEventMode`, `SelectHookMode`, `SelectMatcherMode`, `ViewHookMode`, `PromptDialog` |
| 帮助面板 | `HelpV2/` | `HelpV2`, `General`, `Commands` |
| 选择器 | 根目录文件 | `ThemePicker`, `ModelPicker`, `LanguagePicker`, `OutputStylePicker`, `LogSelector` |
| 警告组件 | 根目录文件 | `KeybindingWarnings` |

## 关键流程

### 1. Settings 主面板打开与导航流程

1. 用户触发 `/settings` 命令，`Settings` 组件被渲染（`src/components/Settings/Settings.tsx:22`）
2. `Settings` 接收 `defaultTab` 参数（`'Status' | 'Config' | 'Usage' | 'Gates'`），初始化选中标签
3. 使用 `Tabs` + `Tab` 设计系统组件渲染 3 个标签页：**Status**、**Config**、**Usage**
4. 根据终端高度和是否在 Modal 内计算 `contentHeight`，传递给各标签页保持布局一致
5. `Config` 标签通过 `Suspense` 异步加载，`Status` 标签在挂载时立即触发 `buildDiagnostics()` 异步构建诊断信息
6. ESC 键退出由 `useKeybinding('confirm:no')` 处理，当 Config 子菜单激活时，Config 接管 ESC 处理权

### 2. Config 配置页的设置管理流程

`Config` 组件（`src/components/Settings/Config.tsx:85`）是最复杂的配置页面：

1. 挂载时快照当前配置状态（`globalConfig`、`settingsData`、`initialAppState`），用于 ESC 取消时回滚
2. 渲染一个可搜索的设置列表，每个设置项有三种类型：
   - `boolean`：开关类配置（如 verbose、thinking、notifications 等）
   - `enum`：枚举选择（如 permission mode、default view）
   - `managedEnum`：由独立子组件管理的选择（如 theme、model、language、output style）
3. 用户通过搜索框过滤设置项，上下方向键选择，Enter 切换/进入子菜单
4. 选择 `managedEnum` 类型时，`setShowSubmenu` 切换到对应子组件（`ThemePicker`、`ModelPicker` 等），同时通过 `setTabsHidden(true)` 隐藏标签栏
5. 配置变更实时写入（`saveGlobalConfig`、`updateSettingsForSource`），同时更新 AppState
6. ESC 退出时调用 `revertChanges()`（`Config.tsx:1179`），将所有未保存的变更回滚到初始快照

#### 支持的子菜单（SubMenu）类型

```typescript
type SubMenu = 'Theme' | 'Model' | 'TeammateModel' | 'ExternalIncludes' 
             | 'OutputStyle' | 'ChannelDowngrade' | 'Language' | 'EnableAutoUpdates'
```

### 3. Status 状态页的信息展示流程

`Status` 组件（`src/components/Settings/Status.tsx:102`）展示系统诊断信息：

1. 构建 **Primary Section**：版本号、会话名称、Session ID、当前工作目录、账户信息、API 提供商
2. 构建 **Secondary Section**：当前模型、IDE 集成状态、MCP 客户端列表、沙盒状态、设置来源
3. 异步加载 **Diagnostics**：安装诊断、健康检查、记忆系统诊断（通过 `buildDiagnostics()` at `Status.tsx:54`）
4. 使用 `Suspense` 显示诊断加载状态

### 4. Usage 用量统计页的数据获取流程

`Usage` 组件（`src/components/Settings/Usage.tsx:174`）展示 API 使用量：

1. 挂载时调用 `fetchUtilization()` 从 API 获取使用率数据（`Utilization` 和 `ExtraUsage`）
2. 使用 `LimitBar` 子组件（`Usage.tsx:25`）渲染进度条：
   - 显示使用百分比、重置时间
   - 宽终端（≥62列）横向布局，窄终端纵向布局
3. 支持 Extra Usage 额度展示和费用统计
4. 集成 `OverageCreditUpsell` 组件进行超额用量购买引导

### 5. 沙盒配置管理流程

`SandboxSettings`（`src/components/sandbox/SandboxSettings.tsx:22`）提供沙盒模式选择：

1. 提供三种模式：`auto-allow`（自动允许沙盒内 Bash）、`regular`（常规权限）、`disabled`（禁用）
2. 使用 `Tabs` 组件渲染三个标签页：
   - **Config**（`SandboxConfigTab`）：展示沙盒配置详情，包括网络、文件系统、进程策略
   - **Dependencies**（`SandboxDependenciesTab`）：检查并展示依赖状态（ripgrep、bubblewrap、socat、seccomp）
   - **Overrides**（`SandboxOverridesTab`）：配置是否允许未沙盒化的命令回退

`SandboxDoctorSection`（`src/components/sandbox/SandboxDoctorSection.tsx:5`）用于 Doctor 诊断屏，仅在平台支持且沙盒启用时显示依赖检查结果。

### 6. Hooks 配置菜单浏览流程

`HooksConfigMenu`（`src/components/hooks/HooksConfigMenu.tsx:51`）是一个**只读**的 Hooks 配置浏览器，采用多级钻取模式：

1. **选择事件**（`SelectEventMode`）：列出所有 Hook 事件（如 `PreToolUse`、`PostToolUse`），显示每个事件已配置的 Hook 数量
2. **选择匹配器**（`SelectMatcherMode`）：对于支持匹配器的事件，展示该事件下的所有匹配器及其来源
3. **选择 Hook**（`SelectHookMode`）：展示特定事件+匹配器下的所有 Hook 列表
4. **查看详情**（`ViewHookMode`）：只读展示单个 Hook 的事件、匹配器、类型、来源、插件等详情

状态机定义（`HooksConfigMenu.tsx:37-50`）：
```typescript
type ModeState = 
  | { mode: 'select-event' }
  | { mode: 'select-matcher'; event: HookEvent }
  | { mode: 'select-hook'; event: HookEvent; matcher: string }
  | { mode: 'view-hook'; event: HookEvent; hook: IndividualHookConfig }
```

菜单通过 `groupHooksByEventAndMatcher()` 将 AppState 中的 Hooks 按事件和匹配器分组。修改 Hooks 需直接编辑 `settings.json` 或通过 Claude 操作。

`PromptDialog`（`src/components/hooks/PromptDialog.tsx:15`）是 Hook 提示型交互的 UI，当 Hook 需要用户选择响应选项时显示。

### 7. HelpV2 帮助面板流程

`HelpV2`（`src/components/HelpV2/HelpV2.tsx:20`）提供帮助信息：

1. 渲染为带标签页的 `Pane`，包含 **general** 和 **commands** 标签
2. `General` 组件展示 Claude Code 简介和快捷键列表（通过 `PromptInputHelpMenu`）
3. `Commands` 组件（`src/components/HelpV2/Commands.tsx:17`）展示可用斜杠命令列表：
   - 按名称去重和排序
   - 使用 `Select` 组件以 `compact-vertical` 布局展示
   - 区分内置命令、自定义命令

## 函数签名与关键 Props

### `Settings`
```typescript
function Settings(props: {
  onClose: (result?: string, options?: { display?: CommandResultDisplay }) => void;
  context: LocalJSXCommandContext;
  defaultTab: 'Status' | 'Config' | 'Usage' | 'Gates';
}): React.ReactNode
```

### `Config`
```typescript
function Config(props: {
  onClose: (result?: string, options?: { display?: CommandResultDisplay }) => void;
  context: LocalJSXCommandContext;
  setTabsHidden: (hidden: boolean) => void;
  onIsSearchModeChange?: (inSearchMode: boolean) => void;
  contentHeight?: number;
}): React.ReactNode
```

### `ThemePicker`
```typescript
function ThemePicker(props: {
  onThemeSelect: (setting: ThemeSetting) => void;
  showIntroText?: boolean;      // 默认 false
  helpText?: string;            // 默认 ""
  showHelpTextBelow?: boolean;  // 默认 false
  hideEscToCancel?: boolean;    // 默认 false
  skipExitHandling?: boolean;   // 默认 false
  onCancel?: () => void;
}): React.ReactNode
```
支持的主题选项：Auto（match terminal）、Dark/Light（标准、色盲友好、ANSI-only 三种变体）。可通过 `ctrl+t` 切换语法高亮开关。

### `ModelPicker`
```typescript
function ModelPicker(props: {
  initial: string | null;
  sessionModel?: ModelSetting;
  onSelect: (model: string | null, effort: EffortLevel | undefined) => void;
  onCancel?: () => void;
  isStandaloneCommand?: boolean;
  showFastModeNotice?: boolean;
  headerText?: string;
  skipSettingsWrite?: boolean;  // 跳过写入 userSettings（用于 assistant 安装向导）
}): React.ReactNode
```
列出可用模型选项（通过 `getModelOptions()`），支持 effort level 调节和 Fast Mode 显示。

### `LogSelector`
```typescript
function LogSelector(props: {
  logs: LogOption[];
  maxHeight?: number;          // 默认 Infinity
  forceWidth?: number;
  onCancel?: () => void;
  onSelect: (log: LogOption) => void;
  onLogsChanged?: () => void;
  onLoadMore?: (count: number) => void;
  initialSearchQuery?: string;
  showAllProjects?: boolean;   // 默认 false
  onToggleAllProjects?: () => void;
  onAgenticSearch?: (query: string, logs: LogOption[], signal?: AbortSignal) => Promise<LogOption[]>;
}): React.ReactNode
```
功能最丰富的选择器（约 1574 行），支持模糊搜索（Fuse.js）、会话分组树形展示（`TreeSelect`）、会话预览、会话重命名、标签过滤、深度搜索等。

### `LanguagePicker`
```typescript
function LanguagePicker(props: {
  initialLanguage: string | undefined;
  onComplete: (language: string | undefined) => void;
  onCancel: () => void;
}): React.ReactNode
```
自由文本输入，留空使用默认英语。

### `OutputStylePicker`
```typescript
function OutputStylePicker(props: {
  initialStyle: OutputStyle;
  onComplete: (style: OutputStyle) => void;
  onCancel: () => void;
  isStandaloneCommand?: boolean;
}): React.ReactNode
```
异步加载所有输出样式（包括自定义样式目录），失败时回退到内置样式。

## 类型定义

### Config 设置项类型
```typescript
type SettingBase = 
  | { id: string; label: string }
  | { id: string; label: React.ReactNode; searchText: string }

type Setting = 
  | (SettingBase & { value: boolean; onChange(value: boolean): void; type: 'boolean' })
  | (SettingBase & { value: string; options: string[]; onChange(value: string): void; type: 'enum' })
  | (SettingBase & { value: string; onChange(value: string): void; type: 'managedEnum' })
```
> 源码位置：`src/components/Settings/Config.tsx:60-83`

### 沙盒模式
```typescript
type SandboxMode = 'auto-allow' | 'regular' | 'disabled'
```
> 源码位置：`src/components/sandbox/SandboxSettings.tsx:21`

### Hooks 状态机
```typescript
type ModeState = 
  | { mode: 'select-event' }
  | { mode: 'select-matcher'; event: HookEvent }
  | { mode: 'select-hook'; event: HookEvent; matcher: string }
  | { mode: 'view-hook'; event: HookEvent; hook: IndividualHookConfig }
```
> 源码位置：`src/components/hooks/HooksConfigMenu.tsx:37-50`

## 边界 Case 与注意事项

- **Config ESC 回滚机制**：Config 在挂载时快照所有配置状态（globalConfig、settingsData、AppState、userMsgOptIn），ESC 退出时通过 `revertChanges()` 回滚。`isDirty` ref 防止无修改时触发多余的磁盘写入。
- **Hooks 菜单只读**：`/hooks` 菜单不支持直接编辑。历史上支持添加/删除 command 类型 Hook，但因 Hook 类型扩展为 4 种（command、prompt、agent、http），编辑 UI 维护成本过高而改为只读浏览，引导用户通过 `settings.json` 或 Claude 修改。
- **沙盒平台限制**：`SandboxDoctorSection` 和 `SandboxSettings` 在不支持沙盒的平台上自动隐藏（`SandboxManager.isSupportedPlatform()`）。
- **沙盒策略锁定**：当沙盒设置被更高优先级的策略锁定时（`areSandboxSettingsLockedByPolicy()`），`SandboxOverridesTab` 仅显示当前设置值，不允许修改。
- **KeybindingWarnings 条件显示**：仅在快捷键自定义功能启用时（`isKeybindingCustomizationEnabled()`）才渲染，区分 error 和 warning 两种严重级别。
- **OutputStylePicker 异步加载**：样式列表通过 `getAllOutputStyles()` 异步加载（包含自定义目录扫描），加载失败时回退到 `OUTPUT_STYLE_CONFIG` 内置样式。
- **Config 搜索模式所有权**：Config 通过 `onIsSearchModeChange` 回调通知 Settings 当前是否处于搜索模式，搜索模式下 Config 接管 ESC 按键（退出搜索而非关闭面板）。
- **LogSelector 复杂度**：LogSelector 是本模块中最大的单文件组件（~1574 行），整合了模糊搜索引擎（Fuse.js）、树形展示（`TreeSelect`）、会话预览（`SessionPreview`）、标签过滤（`TagTabs`）等多个子系统。