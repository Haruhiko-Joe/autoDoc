# 文本输入原语层（TextInputPrimitives）

## 概述与职责

文本输入原语层是 Claude Code 终端 UI 的基础输入组件集，位于 **TerminalUI → UIComponents → DesignSystem** 层级下。它提供了四个递进式的文本输入组件，形成一个继承式分层架构：

```
BaseTextInput（底层渲染 + 光标 + 粘贴处理）
  ├── TextInput（增加语音波形可视化 + useTextInput）
  ├── VimTextInput（增加 Vim 编辑模式 + useVimInput）
  └── SearchBox（独立的轻量搜索输入框）
```

上层组件（如 `PromptInput`）根据用户是否启用 Vim 模式选择 `TextInput` 或 `VimTextInput`；`SearchBox` 则用于全局搜索、历史搜索等场景。四个文件共约 470 行。

同级兄弟模块包括 `Spinner`（加载动画）、`StructuredDiff`（差异对比）、`HighlightedCode`（语法高亮）、`Markdown` 渲染器等设计系统组件。

## 关键流程

### 分层架构的数据流

1. **`TextInput` / `VimTextInput`** 作为入口组件被上层使用，各自调用不同的 input hook（`useTextInput` / `useVimInput`）来获取 `inputState`
2. 两者都将 `inputState` 传递给 **`BaseTextInput`**，由它统一负责文本渲染和光标定位
3. `BaseTextInput` 内部使用 `usePasteHandler` 处理粘贴事件，使用 `useDeclaredCursor` 注册光标位置

### BaseTextInput 渲染流程

1. 从 `inputState` 中解构出 `onInput`、`renderedValue`、`cursorLine`、`cursorColumn`
2. 通过 `useDeclaredCursor` 向 Ink 框架声明光标位置（行/列/是否激活）（`BaseTextInput.tsx:38-53`）
3. 通过 `usePasteHandler` 包装输入处理函数，支持大文本粘贴和图片粘贴（`BaseTextInput.tsx:54-66`）
4. 调用 `renderPlaceholder` 决定是否显示占位文本（`BaseTextInput.tsx:76-87`）
5. 通过 `useInput` 将包装后的输入处理器注册到 Ink 输入系统（`BaseTextInput.tsx:88-90`）
6. 渲染逻辑分两条路径：
   - **有高亮（highlights）时**：使用 `HighlightedInput` 组件渲染，同时过滤光标位置与视口范围内的高亮区域（`BaseTextInput.tsx:93-106`）
   - **无高亮时**：使用 `Text` + `Ansi` 组件渲染纯文本，支持 placeholder 和 argument hint（`BaseTextInput.tsx:107-134`）

### TextInput 语音波形光标

`TextInput` 在标准输入能力之上增加了语音录制时的波形可视化光标：

1. 检测语音状态 `voiceState === 'recording'`，读取 `voiceAudioLevels` 音频电平数据（`TextInput.tsx:44-50`）
2. 使用 `useAnimationFrame(50)` 以 50ms 间隔驱动动画刷新（`TextInput.tsx:53-55`）
3. 构建自定义 `invert` 函数替代标准的 `chalk.inverse`（`TextInput.tsx:66-91`）：
   - **非聚焦或无障碍模式**：`invert` 为恒等函数（不变换）
   - **语音录制中**：使用 Unicode block 字符（`▁▂▃▄▅▆▇█`）和 EMA 平滑算法渲染单字符波形柱，颜色随时间做 HSL 色相旋转；低于 `SILENCE_THRESHOLD` (0.15) 时显示灰色
   - **其他情况**：使用标准 `chalk.inverse` 反色光标

### VimTextInput 模式切换

1. 使用 `useVimInput` hook 获取包含 Vim 模式状态的 `vimInputState`（`VimTextInput.tsx:101`）
2. 从状态中解构 `mode`（`'INSERT'` | `'NORMAL'`）和 `setMode`
3. 通过 `useEffect` 监听 `props.initialMode`，允许外部强制切换模式（`VimTextInput.tsx:108-124`）
4. 当终端未聚焦时，`invert` 退化为恒等函数（不显示光标）（`VimTextInput.tsx:32`）
5. 将 `vimInputState` 传递给 `BaseTextInput` 完成渲染（`VimTextInput.tsx:127`）

### SearchBox 渲染逻辑

`SearchBox` 是独立的轻量组件，不复用 `BaseTextInput`，自行实现光标渲染：

1. 根据 `isFocused` 和 `isTerminalFocused` 两个布尔值决定显示模式（`SearchBox.tsx:36-46`）：
   - **聚焦 + 终端聚焦 + 有查询文本**：在光标位置用 `<Text inverse>` 渲染反色字符
   - **聚焦 + 终端聚焦 + 无查询文本**：在 placeholder 首字符上显示反色光标
   - **聚焦但终端未聚焦**：直接显示查询文本
   - **未聚焦**：显示查询文本或 placeholder
2. 包裹在带圆角边框的 `Box` 中，聚焦时边框颜色为 `suggestion`，未聚焦时 dim

## 函数签名与参数说明

### `BaseTextInput(props: BaseTextInputComponentProps): React.ReactNode`

底层渲染组件，不直接处理键盘事件的语义（由上层 hook 处理），只负责将输入状态映射为终端渲染输出。

| 参数 | 类型 | 说明 |
|------|------|------|
| `inputState` | `BaseInputState` | 由 `useTextInput` 或 `useVimInput` 返回的状态对象 |
| `terminalFocus` | `boolean` | 终端窗口是否获得操作系统焦点 |
| `highlights` | `TextHighlight[]` | 可选的文本高亮区域（搜索结果等） |
| `invert` | `(text: string) => string` | 光标位置的文本变换函数 |
| `hidePlaceholderText` | `boolean` | 是否隐藏 placeholder 文本（语音录制时使用） |
| `children` | `React.ReactNode` | 追加在输入文本后的子元素 |
| `...props` | `BaseTextInputProps` | 透传的基础输入属性（value、onChange、placeholder 等） |

> 源码位置：`src/components/BaseTextInput.tsx:10-17`

### `TextInput(props: Props): React.ReactNode`（默认导出）

标准文本输入组件，增加语音波形可视化。

| 参数 | 类型 | 说明 |
|------|------|------|
| `highlights` | `TextHighlight[]` | 可选的文本高亮 |
| `...BaseTextInputProps` | — | 所有基础输入属性 |

> 源码位置：`src/components/TextInput.tsx:37`

### `VimTextInput(props: Props): React.ReactNode`（默认导出）

Vim 模式文本输入组件。

| 参数 | 类型 | 说明 |
|------|------|------|
| `initialMode` | `VimMode` | 初始 Vim 模式（`'INSERT'` 或 `'NORMAL'`） |
| `onModeChange` | `(mode: VimMode) => void` | 模式切换回调 |
| `onUndo` | `() => void` | 撤销操作回调 |
| `highlights` | `TextHighlight[]` | 可选的文本高亮 |
| `...BaseTextInputProps` | — | 所有基础输入属性 |

> 源码位置：`src/components/VimTextInput.tsx:13`

### `SearchBox(props: Props): React.ReactNode`

搜索专用输入框。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `query` | `string` | — | 搜索查询文本 |
| `placeholder` | `string` | `"Search…"` | 占位提示文本 |
| `isFocused` | `boolean` | — | 组件是否获得焦点 |
| `isTerminalFocused` | `boolean` | — | 终端是否获得焦点 |
| `prefix` | `string` | `"⌕"` | 搜索图标前缀 |
| `width` | `number \| string` | — | 组件宽度 |
| `cursorOffset` | `number` | `query.length` | 光标偏移位置 |
| `borderless` | `boolean` | `false` | 是否无边框模式 |

> 源码位置：`src/components/SearchBox.tsx:4-13`

## 接口/类型定义

### `BaseInputState`

由输入 hook 返回的状态对象，是 `BaseTextInput` 的核心输入：

| 字段 | 类型 | 说明 |
|------|------|------|
| `onInput` | `(input: string, key: Key) => void` | 按键输入处理函数 |
| `renderedValue` | `string` | 经过处理后用于渲染的文本（含换行、掩码等） |
| `offset` | `number` | 光标在原始文本中的字符偏移 |
| `setOffset` | `(offset: number) => void` | 设置光标偏移 |
| `cursorLine` | `number` | 光标所在行（0-indexed，考虑换行） |
| `cursorColumn` | `number` | 光标所在列（显示宽度） |
| `viewportCharOffset` | `number` | 视口起始字符偏移（无窗口化时为 0） |
| `viewportCharEnd` | `number` | 视口结束字符偏移（无窗口化时为 text.length） |

> 源码位置：`src/types/textInputTypes.ts:227-247`

### `VimInputState`

在 `BaseInputState` 基础上增加 Vim 模式：

| 字段 | 类型 | 说明 |
|------|------|------|
| `mode` | `VimMode` | 当前模式：`'INSERT'` 或 `'NORMAL'` |
| `setMode` | `(mode: VimMode) => void` | 切换模式 |

> 源码位置：`src/types/textInputTypes.ts:257-260`

### `BaseTextInputProps`

基础输入属性类型，约 30 个字段，核心字段包括：

- `value` / `onChange` / `onSubmit`：基本输入值控制
- `focus` / `showCursor` / `cursorOffset` / `onChangeCursorOffset`：焦点与光标管理
- `placeholder` / `placeholderElement` / `argumentHint`：提示文本
- `multiline` / `mask` / `columns` / `maxVisibleLines`：布局控制
- `onHistoryUp` / `onHistoryDown` / `onHistoryReset`：历史导航
- `onPaste` / `onImagePaste` / `onIsPastingChange` / `highlightPastedText`：粘贴处理
- `highlights` / `inlineGhostText` / `inputFilter`：高亮与过滤

> 源码位置：`src/types/textInputTypes.ts:27-202`

## 配置项与默认值

### TextInput 语音波形参数

以下常量定义在 `TextInput.tsx:16-33`，控制波形可视化行为：

| 常量 | 值 | 说明 |
|------|-----|------|
| `BARS` | `' ▁▂▃▄▅▆▇█'` | 波形柱使用的 Unicode block 字符（9 级） |
| `CURSOR_WAVEFORM_WIDTH` | `1` | 波形光标宽度（单字符） |
| `SMOOTH` | `0.7` | EMA 平滑因子（0=瞬时响应，1=不动） |
| `LEVEL_BOOST` | `1.8` | 音频电平增益系数 |
| `SILENCE_THRESHOLD` | `0.15` | 静音阈值（低于此值显示灰色） |

### 环境变量

- `CLAUDE_CODE_ACCESSIBILITY`：当设为 truthy 值时，`TextInput` 禁用光标反色渲染，改用无变换模式，以支持无障碍访问（`TextInput.tsx:41`）

### 特性开关

- `VOICE_MODE`（`bun:bundle` 编译时常量）：控制语音相关功能的编译包含。未启用时，语音状态默认为 `'idle'`，音频电平为空数组（`TextInput.tsx:44-55`）

## 边界 Case 与注意事项

- **React Compiler 优化**：`BaseTextInput`、`VimTextInput`、`SearchBox` 的编译产物使用了 React Compiler 的 `_c()` 缓存机制（细粒度 memoization），这是因为这些组件在每次按键时都会重新渲染，性能敏感。`TextInput` 未使用此优化（可能因为动画帧已经在驱动重渲染）。

- **粘贴时忽略回车**：`BaseTextInput` 在粘贴状态下会忽略 `key.return` 事件（`BaseTextInput.tsx:60-62`），防止粘贴多行文本时触发提交。

- **高亮视口过滤**：当输入内容有水平滚动（`viewportCharOffset > 0`）时，`BaseTextInput` 会将高亮区域裁剪到可见视口范围内，并重新计算偏移（`BaseTextInput.tsx:98-102`）。

- **光标位置冲突**：当光标落在高亮区域内时，该高亮区域会被过滤掉（`BaseTextInput.tsx:93`），避免视觉冲突。

- **VimTextInput 的 `_temp` 函数**：当终端未聚焦时，`invert` 使用一个恒等函数 `_temp`（`VimTextInput.tsx:137-138`），这是 React Compiler 提取的辅助函数。

- **SearchBox 不复用 BaseTextInput**：`SearchBox` 自行实现了简化的光标渲染和文本显示逻辑，不依赖 `useTextInput` 等 hook。它适用于不需要完整编辑能力的场景（如搜索过滤）。

- **动画帧控制**：语音波形的动画帧间隔为 50ms（约 20fps）。当 `prefersReducedMotion` 设置开启时，波形动画完全禁用（`TextInput.tsx:43, 52`）。