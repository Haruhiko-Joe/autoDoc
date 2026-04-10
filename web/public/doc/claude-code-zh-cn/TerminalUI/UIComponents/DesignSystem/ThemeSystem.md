# ThemeSystem — 主题与展示原语核心层

## 概述与职责

ThemeSystem 是 Claude Code 终端 UI 的**视觉基石**，位于 `src/components/design-system/` 目录下，包含 16 个基础组件。它在架构层级中属于 `TerminalUI → UIComponents → DesignSystem`，被几乎所有上层 UI 模块依赖——DialogCollection、PermissionUI、SettingsAndConfig、TaskAndTeamPanels、AppChrome 等均构建在这些原语之上。

该模块解决两个核心问题：
1. **主题感知**：通过 ThemeProvider 和 color 工具函数，让所有组件能用语义化的主题键（如 `"permission"`、`"success"`）而非硬编码颜色值，自动适配亮色/暗色/系统主题
2. **可复用的 UI 原语**：提供 Dialog、Pane、Tabs、FuzzyPicker 等通用组件，统一整个应用的交互模式和视觉语言

## 关键流程

### 主题解析流程

1. `ThemeProvider` 在应用顶层挂载，从全局配置读取用户的主题偏好（`ThemeSetting`：`'light'` | `'dark'` | `'auto'`）（`ThemeProvider.tsx:48`）
2. 当设置为 `'auto'` 时，通过 `getSystemThemeName()` 获取系统主题，并启动 OSC 11 终端主题监听器（`watchSystemTheme`）实时跟踪终端颜色方案变化（`ThemeProvider.tsx:64-80`）
3. 解析出最终的 `currentTheme`（`ThemeName`，始终是 `'light'` 或 `'dark'`，不会是 `'auto'`）（`ThemeProvider.tsx:81`）
4. 下游组件通过 `useTheme()` hook 获取解析后的主题名，再通过 `getTheme(themeName)` 获取具体颜色映射表
5. `ThemedText` / `ThemedBox` 接收语义化的主题键（如 `color="permission"`），内部调用 `resolveColor()` 将其解析为实际颜色值后传给底层 Ink 原语

### 主题预览流程

ThemeProvider 支持"预览模式"供 ThemePicker 使用：
1. `setPreviewTheme()` 临时切换渲染主题，但不持久化
2. `savePreview()` 将预览主题写入配置文件
3. `cancelPreview()` 回滚到原主题

> 源码位置：`ThemeProvider.tsx:95-113`

### 颜色解析路径

`resolveColor()` 函数（`ThemedText.tsx:66-74`、`ThemedBox.tsx:42-50`）判断传入的颜色值：
- 以 `rgb(`、`#`、`ansi256(`、`ansi:` 开头 → 直接作为原始颜色值透传
- 否则 → 作为主题键在 `Theme` 对象中查找对应颜色

`color.ts` 提供了一个柯里化的工具函数 `color()`（`color.ts:9-30`），将上述逻辑封装为 `(text: string) => string` 的字符串着色函数，供非 JSX 场景（如纯文本染色）使用。

## 组件 API 一览

### 主题基础设施

#### `ThemeProvider`

主题上下文提供者，包裹整个应用树。

```typescript
type Props = {
  children: React.ReactNode
  initialState?: ThemeSetting        // 'light' | 'dark' | 'auto'
  onThemeSave?: (setting: ThemeSetting) => void
}
```

> 源码位置：`ThemeProvider.tsx:43-116`

#### `useTheme(): [ThemeName, (setting: ThemeSetting) => void]`

获取当前解析后的主题名（永远不是 `'auto'`）和主题设置函数。

> 源码位置：`ThemeProvider.tsx:122-138`

#### `useThemeSetting(): ThemeSetting`

获取用户保存的原始主题设置（可能是 `'auto'`），用于 ThemePicker 等需要显示 auto 选项的 UI。

> 源码位置：`ThemeProvider.tsx:144-146`

#### `usePreviewTheme(): { setPreviewTheme, savePreview, cancelPreview }`

主题预览 API，供 ThemePicker 在切换前实时预览效果。

> 源码位置：`ThemeProvider.tsx:147-169`

#### `color(c, theme, type?): (text: string) => string`

柯里化的颜色工具函数，接受主题键或原始颜色值，返回字符串着色函数。

```typescript
function color(
  c: keyof Theme | Color | undefined,
  theme: ThemeName,
  type: ColorType = 'foreground'
): (text: string) => string
```

> 源码位置：`color.ts:9-30`

### 主题感知原语

#### `ThemedText`

主题感知的文本组件，包裹 Ink 的 `Text`，自动将主题键解析为实际颜色。

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| color | `keyof Theme \| Color` | - | 文本颜色，支持主题键或原始色值 |
| backgroundColor | `keyof Theme` | - | 背景颜色，仅支持主题键 |
| dimColor | boolean | false | 使用主题的 `inactive` 颜色（与 bold 兼容，不同于 ANSI dim） |
| bold / italic / underline / strikethrough / inverse | boolean | false | 文本样式 |
| wrap | Styles['textWrap'] | 'wrap' | 文本换行/截断策略 |

额外提供 `TextHoverColorContext`：通过 React Context 为子树中未着色的 ThemedText 设置默认颜色，能跨越 Box 边界（Ink 原生的样式级联做不到）。优先级：显式 `color` > `TextHoverColorContext` > `dimColor`。

> 源码位置：`ThemedText.tsx:80-123`

#### `ThemedBox`

主题感知的容器组件，包裹 Ink 的 `Box`，对所有边框颜色和背景颜色属性进行主题键解析。

支持的主题化属性：`borderColor`、`borderTopColor`、`borderBottomColor`、`borderLeftColor`、`borderRightColor`、`backgroundColor`——均接受 `keyof Theme | Color`。

> 源码位置：`ThemedBox.tsx:56-100+`

### 布局容器

#### `Dialog`

模态对话框壳，用于确认/取消类交互。内置 Esc 取消和 Ctrl+C/D 退出的快捷键绑定。

```typescript
type DialogProps = {
  title: React.ReactNode
  subtitle?: React.ReactNode
  children: React.ReactNode
  onCancel: () => void
  color?: keyof Theme              // 默认 'permission'
  hideInputGuide?: boolean         // 隐藏底部操作提示
  hideBorder?: boolean             // 隐藏 Pane 边框（嵌套在 Pane 中时使用）
  inputGuide?: (exitState: ExitState) => React.ReactNode  // 自定义操作提示
  isCancelActive?: boolean         // 控制取消快捷键是否激活，默认 true
}
```

渲染结构：标题（加粗着色）→ 可选副标题 → 内容区 → 操作提示（"Enter to confirm · Esc to cancel"）。当 `hideBorder` 为 false 时，外层包裹 `<Pane>`。

> 源码位置：`Dialog.tsx:30-137`

#### `Pane`

面板容器，在 REPL 提示符下方渲染一个带顶部彩色分隔线的区域。被 `/config`、`/help`、`/plugins`、`/sandbox`、`/stats`、`/permissions` 等斜杠命令屏幕使用。

```typescript
type PaneProps = {
  children: React.ReactNode
  color?: keyof Theme              // 顶部分隔线颜色
}
```

**自适应行为**：当检测到自身在模态框（FullscreenLayout）内部时，自动跳过 Divider 和顶部 padding，避免双重边框。

> 源码位置：`Pane.tsx:33-76`

#### `Tabs`

键盘导航标签页组件，支持左/右箭头或 Tab/Shift+Tab 切换。

```typescript
type TabsProps = {
  children: Array<React.ReactElement<TabProps>>
  title?: string
  color?: keyof Theme
  defaultTab?: string
  hidden?: boolean
  useFullWidth?: boolean
  selectedTab?: string             // 受控模式
  onTabChange?: (tabId: string) => void
  banner?: React.ReactNode         // 标签栏下方的横幅
  disableNavigation?: boolean
  initialHeaderFocused?: boolean   // 默认 true
  contentHeight?: number           // 固定内容高度，防布局抖动
  navFromContent?: boolean         // 允许从内容区切换标签
}
```

支持**受控模式**（外部管理选中状态）和**非受控模式**（内部管理）。标签头部和内容区有独立的焦点状态，可通过 `focusHeader()` / `blurHeader()` 切换。

> 源码位置：`Tabs.tsx:66-150+`

### 交互组件

#### `FuzzyPicker<T>`

通用的模糊搜索选择器，带搜索框、列表、预览区和快捷键提示。

```typescript
type Props<T> = {
  title: string
  placeholder?: string             // 默认 'Type to search…'
  items: readonly T[]
  getKey: (item: T) => string
  renderItem: (item: T, isFocused: boolean) => React.ReactNode
  renderPreview?: (item: T) => React.ReactNode
  previewPosition?: 'bottom' | 'right'  // 默认 'bottom'
  visibleCount?: number            // 默认 8
  direction?: 'down' | 'up'       // 默认 'down'，'up' 为 atuin 风格
  onQueryChange: (query: string) => void
  onSelect: (item: T) => void     // Enter 键
  onTab?: PickerAction<T>         // Tab 键
  onShiftTab?: PickerAction<T>    // Shift+Tab 键
  onFocus?: (item: T | undefined) => void
  onCancel: () => void
  emptyMessage?: string | ((query: string) => string)
  matchLabel?: string             // 如 "500+ matches"
  selectAction?: string           // 默认 'select'
  extraHints?: React.ReactNode
}
```

**终端自适应**：`visibleCount` 会被终端行数限制（`rows - CHROME_ROWS`），防止溢出导致渲染错位。当终端宽度 < 120 列时，进入紧凑模式，简化快捷键提示。

键盘导航：↑/↓（或 Ctrl+P/N）移动焦点，Enter 选择，Tab/Shift+Tab 执行附加操作，Esc 取消。

> 源码位置：`FuzzyPicker.tsx:68-150+`

#### `ListItem`

可选中列表项组件，用于下拉菜单、多选列表等选择 UI。

```typescript
type ListItemProps = {
  isFocused: boolean               // 显示指针 ❯
  isSelected?: boolean             // 显示勾选 ✓
  children: ReactNode
  description?: string             // 项目下方的描述文本
  showScrollDown?: boolean         // 显示 ↓ 滚动提示
  showScrollUp?: boolean           // 显示 ↑ 滚动提示
  styled?: boolean                 // 默认 true，自动根据状态着色
  disabled?: boolean               // 禁用状态
  declareCursor?: boolean          // 默认 true，声明终端光标位置
}
```

> 源码位置：`ListItem.tsx:1-100+`

### 展示组件

#### `Divider`

水平分隔线，支持主题着色和居中标题。

```typescript
type DividerProps = {
  width?: number                   // 默认终端宽度
  color?: keyof Theme              // 未提供时使用 dimColor
  char?: string                    // 默认 '─'
  padding?: number                 // 从宽度中减去的内边距
  title?: string                   // 居中标题，支持 ANSI 转义码
}
```

> 源码位置：`Divider.tsx:66-148`

#### `ProgressBar`

基于 Unicode 方块字符的进度条，支持 1/8 精度的子字符渲染。

```typescript
type Props = {
  ratio: number                    // [0, 1]
  width: number                    // 字符宽度
  fillColor?: keyof Theme          // 填充色
  emptyColor?: keyof Theme         // 空白色（背景）
}
```

内部使用 `BLOCKS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']` 实现平滑渐进填充。

> 源码位置：`ProgressBar.tsx:27-85`

#### `StatusIcon`

状态指示图标，根据状态类型显示对应图标和颜色。

| 状态 | 图标 | 颜色 |
|------|------|------|
| success | ✓ (tick) | success (绿) |
| error | ✗ (cross) | error (红) |
| warning | ⚠ (warning) | warning (黄) |
| info | ℹ (info) | suggestion (蓝) |
| pending | ○ (circle) | dimColor |
| loading | … | dimColor |

可选 `withSpace` 属性在图标后添加空格，方便与文本拼接。

> 源码位置：`StatusIcon.tsx:24-94`

#### `Byline`

元信息行组件，用中间点 ` · ` 连接子元素。自动过滤 null/undefined/false 子节点。

```tsx
<Byline>
  <KeyboardShortcutHint shortcut="Enter" action="confirm" />
  <KeyboardShortcutHint shortcut="Esc" action="cancel" />
</Byline>
// 输出: "Enter to confirm · Esc to cancel"
```

> 源码位置：`Byline.tsx:37-76`

#### `KeyboardShortcutHint`

快捷键提示组件，渲染 `"{shortcut} to {action}"` 格式的文本。

```typescript
type Props = {
  shortcut: string                 // 如 "ctrl+o"、"Enter"、"↑/↓"
  action: string                   // 如 "expand"、"confirm"
  parens?: boolean                 // 加括号: "(ctrl+o to expand)"
  bold?: boolean                   // 快捷键部分加粗
}
```

通常与 `<Text dimColor>` 和 `<Byline>` 配合使用。

> 源码位置：`KeyboardShortcutHint.tsx:38-80`

#### `LoadingState`

加载态组件，显示 Spinner + 消息文本 + 可选副标题。

```typescript
type LoadingStateProps = {
  message: string
  bold?: boolean                   // 默认 false
  dimColor?: boolean               // 默认 false
  subtitle?: string                // 副标题，dimColor 显示
}
```

> 源码位置：`LoadingState.tsx:48-93`

#### `Ratchet`

终端尺寸响应式组件，记录子内容的最大高度，防止内容缩小时布局跳动。

```typescript
type Props = {
  children: React.ReactNode
  lock?: 'always' | 'offscreen'   // 默认 'always'
}
```

- `lock='always'`：始终保持最大高度
- `lock='offscreen'`：仅当内容在屏幕外不可见时锁定高度

内部通过 `useLayoutEffect` 测量子元素高度，配合 `useTerminalViewport` 检测可见性，通过 `minHeight` 防止布局收缩。高度上限为终端行数。

> 源码位置：`Ratchet.tsx:10-79`

## 接口与类型定义

### 核心类型

- **`ThemeSetting`**：`'light' | 'dark' | 'auto'` — 用户保存的主题偏好
- **`ThemeName`**：`'light' | 'dark'` — 解析后的实际主题名（不含 auto）
- **`Theme`**：主题颜色映射对象，键为语义化名称（如 `permission`、`success`、`error`、`warning`、`suggestion`、`inactive` 等），值为具体颜色
- **`Color`**：Ink 支持的颜色值（`rgb()`、`#hex`、`ansi256()`、`ansi:` 前缀格式）

### Context

- **`ThemeContext`**：内部 Context，默认主题为 `'dark'`，确保在无 Provider 时（测试、工具场景）也能正常工作
- **`TextHoverColorContext`**：跨 Box 边界传递默认文本颜色的 Context
- **`TabsContext`**：Tabs 内部的选中状态和焦点管理 Context

## 边界 Case 与注意事项

- **无 Provider 场景**：`ThemeContext` 和 `useTheme()` 提供了默认值（`'dark'`），在测试和独立工具使用时不会崩溃（`ThemeProvider.tsx:20-28`）
- **ThemedText 颜色优先级**：显式 `color` > `TextHoverColorContext` > `dimColor`。`dimColor` 使用主题的 `inactive` 颜色实现，与 `bold` 兼容（不同于 ANSI 的 dim 属性）
- **Pane 模态框适配**：Pane 通过 `useIsInsideModal()` 检测是否在模态框内，避免双重边框。在模态框内时使用 `flexShrink={0}` 防止高度塌陷（修复 #23592）
- **FuzzyPicker 溢出保护**：`visibleCount` 被 `rows - CHROME_ROWS` 限制，防止列表超出终端高度导致光标错位
- **Dialog 的 `isCancelActive`**：当 Dialog 内嵌文本输入框时应设为 `false`，否则 Esc 和 'n' 键会被 Dialog 拦截而无法到达输入框
- **auto 主题的 OSC 11 监听**：仅在 `feature('AUTO_THEME')` 启用时加载 `systemThemeWatcher`，外部构建中会被 dead-code-elimination 移除
- **ProgressBar 精度**：使用 9 级 Unicode 方块字符（空格到 █），每个字符位置有 1/8 的子像素精度
- **Ratchet 高度锁定**：`maxHeight` 上限为 `rows`（终端行数），防止测量到的高度超出屏幕