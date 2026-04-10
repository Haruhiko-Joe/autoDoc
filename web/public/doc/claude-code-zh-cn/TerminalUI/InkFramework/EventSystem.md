# 终端事件系统 (EventSystem)

## 概述与职责

EventSystem 是 InkFramework 的事件基础设施，在终端环境中实现了一套**类浏览器的事件模型**。它解决了终端应用的核心交互问题：如何将原始 stdin 字节流转化为结构化事件，如何在自定义 DOM 树中分发这些事件，以及如何实现终端级别的鼠标交互（点击、悬停、文本选择）。

在整体架构中，EventSystem 属于 **TerminalUI → InkFramework** 层。它向上为 UIComponents 和 Hooks 提供事件订阅能力（通过 `onKeyDown`、`onClick`、`onFocus` 等 props），向下依赖 termio 层的 tokenizer 进行 stdin 字节流切分。它是连接底层终端 IO 和上层 React 组件交互的桥梁。

同级模块包括 UIComponents（144 个业务组件）、Hooks（80+ 自定义 Hooks）、Screens（REPL 主屏幕）、Keybindings（快捷键系统）等。

## 子系统总览

EventSystem 由四个子系统组成：

1. **事件类型层次**（`events/` 目录）：定义 Event 基类和 6 种具体事件类型
2. **事件分发器**（`events/dispatcher.ts`）：W3C 风格的 capture/bubble 两阶段分发
3. **输入解析器**（`parse-keypress.ts`）：将 stdin 字节流解析为结构化按键/鼠标/终端响应事件
4. **鼠标交互**（`hit-test.ts` + `selection.ts`）：坐标命中测试、点击/悬停分发、文本选择

---

## 事件类型层次

### 继承关系

```
Event（基类，stopImmediatePropagation）
├── TerminalEvent（DOM 风格传播：target/currentTarget/eventPhase/stopPropagation/preventDefault）
│   ├── KeyboardEvent（键盘按下事件，type="keydown"）
│   └── FocusEvent（焦点变化，type="focus"|"blur"）
├── InputEvent（旧式输入事件，兼容 Ink 原有 useInput 接口）
├── ClickEvent（鼠标点击，含屏幕坐标和局部坐标）
└── TerminalFocusEvent（终端窗口获焦/失焦，DECSET 1004）
```

### Event 基类

最底层的事件类，仅提供 `stopImmediatePropagation()` 能力。`ClickEvent`、`InputEvent`、`TerminalFocusEvent` 直接继承此类。

> 源码位置：`src/ink/events/event.ts:1-11`

### TerminalEvent

浏览器 Event API 的终端实现，是新事件模型的核心基类。提供：

- **传播控制**：`stopPropagation()`、`stopImmediatePropagation()`、`preventDefault()`
- **目标追踪**：`target`（事件原始目标）、`currentTarget`（当前处理节点）
- **阶段感知**：`eventPhase` 可为 `'none' | 'capturing' | 'at_target' | 'bubbling'`
- **时间戳**：`timeStamp`（`performance.now()`）
- **可配置特性**：`bubbles`（默认 true）、`cancelable`（默认 true）

内部方法（以 `_` 前缀标记）供 Dispatcher 在分发过程中设置 target、phase 等属性。`_prepareForTarget()` 是钩子方法，子类可在每个节点处理前做额外设置。

`EventTarget` 类型定义了事件分发所需的最小接口：`parentNode`（构成冒泡链）和 `_eventHandlers`（存储事件处理函数）。

> 源码位置：`src/ink/events/terminal-event.ts:19-107`

### KeyboardEvent

键盘事件，继承 TerminalEvent，type 固定为 `"keydown"`，`bubbles=true`、`cancelable=true`。

从 `ParsedKey` 构造，提供修饰键布尔值：`ctrl`、`shift`、`meta`（Alt/Option）、`superKey`（Cmd/Win）、`fn`。

`key` 属性遵循浏览器语义：可打印字符为字面值（`'a'`、`'3'`、`' '`），特殊键为名称（`'down'`、`'return'`、`'escape'`、`'f1'`）。判断可打印字符的惯用法是 `e.key.length === 1`。

> 源码位置：`src/ink/events/keyboard-event.ts:12-30`

### InputEvent

兼容 Ink 原有 `useInput` 接口的旧式事件（直接继承 Event 而非 TerminalEvent）。`key` 属性是布尔标志集合（`upArrow`、`ctrl`、`return` 等），`input` 是处理后的可打印字符串。

内部 `parseKey()` 函数处理了大量边界情况：CSI u 序列、modifyOtherKeys 序列、应用小键盘模式序列、SGR 鼠标尾部碎片泄漏等。这些处理确保各种终端协议的输入不会作为垃圾文本泄漏到用户输入框。

> 源码位置：`src/ink/events/input-event.ts:27-190`

### ClickEvent

鼠标点击事件（左键释放且无拖拽时触发）。提供：

- `col`/`row`：0-indexed 屏幕坐标
- `localCol`/`localRow`：相对于当前处理节点的局部坐标（由 `dispatchClick` 在每个处理节点前重新计算）
- `cellIsBlank`：点击位置是否为空白单元格（无可见内容），用于忽略文本右侧空白区域的点击

> 源码位置：`src/ink/events/click-event.ts:10-38`

### FocusEvent

组件焦点变化事件，继承 TerminalEvent。type 为 `'focus'`（获焦）或 `'blur'`（失焦）。`bubbles=true`、`cancelable=false`（与 react-dom 的 focusin/focusout 语义一致，使父组件能观察到后代的焦点变化）。`relatedTarget` 指向焦点转移的另一方。

> 源码位置：`src/ink/events/focus-event.ts:11-21`

### TerminalFocusEvent

终端窗口级别的获焦/失焦事件（非组件焦点），基于 DECSET 1004 焦点报告协议。终端发送 `CSI I`（获焦）和 `CSI O`（失焦）。直接继承 Event。

> 源码位置：`src/ink/events/terminal-focus-event.ts:12-19`

---

## 事件分发器 (Dispatcher)

### 事件处理函数注册

`event-handlers.ts` 定义了事件处理函数的 React props 约定，遵循 React/DOM 命名规范：

| 事件类型 | 冒泡阶段 | 捕获阶段 |
|---------|---------|---------|
| keydown | `onKeyDown` | `onKeyDownCapture` |
| focus | `onFocus` | `onFocusCapture` |
| blur | `onBlur` | `onBlurCapture` |
| paste | `onPaste` | `onPasteCapture` |
| resize | `onResize` | — |
| click | `onClick` | — |
| hover | `onMouseEnter` / `onMouseLeave` | — |

`HANDLER_FOR_EVENT` 是反向查找表（事件类型字符串 → handler prop 名称），供 Dispatcher 实现 O(1) 的处理函数查找。`EVENT_HANDLER_PROPS` 集合供 reconciler 识别事件 props 并存储到 `_eventHandlers` 而非普通属性。

> 源码位置：`src/ink/events/event-handlers.ts:44-73`

### Capture/Bubble 两阶段分发

`Dispatcher` 类实现了完整的 W3C 事件分发模型：

**监听器收集**（`collectListeners`，`src/ink/events/dispatcher.ts:46-79`）：

1. 从 target 节点沿 `parentNode` 向上遍历到根节点
2. 捕获阶段处理函数通过 `unshift` 插入列表前端（根 → target 方向）
3. 冒泡阶段处理函数通过 `push` 追加到列表末尾（target → 根方向）
4. 最终列表顺序为：`[root-cap, ..., parent-cap, target-cap, target-bub, parent-bub, ..., root-bub]`
5. 非冒泡事件仅在 target 节点本身触发冒泡处理函数

**分发执行**（`processDispatchQueue`，`src/ink/events/dispatcher.ts:87-114`）：

遍历监听器列表，逐个执行。每次执行前：
- 检查 `_isImmediatePropagationStopped()`（立即终止）
- 检查 `_isPropagationStopped()` 且节点变化（传播终止，同节点的多个监听器仍会执行）
- 设置 `eventPhase` 和 `currentTarget`
- 调用 `_prepareForTarget()` 钩子
- 处理函数内的异常被 `logError` 捕获，不中断分发

### 事件优先级

`Dispatcher` 与 React reconciler 的调度系统集成，通过 `getEventPriority()` 映射事件类型到 React 调度优先级：

- **DiscreteEventPriority**（同步）：`keydown`、`keyup`、`click`、`focus`、`blur`、`paste`
- **ContinuousEventPriority**：`resize`、`scroll`、`mousemove`
- **DefaultEventPriority**：其他事件

三种分发方法：

- `dispatch()`：基础分发，返回 `!event.defaultPrevented`
- `dispatchDiscrete()`：通过 reconciler 的 `discreteUpdates` 以同步优先级执行，用于用户交互事件
- `dispatchContinuous()`：设置 ContinuousEventPriority 后分发，用于高频事件

`discreteUpdates` 由 InkReconciler 在构造后注入，打破循环依赖。reconciler 的 host config 通过读取 `currentEvent` 和 `currentUpdatePriority` 来推断更新优先级，与 react-dom 读取 `window.event` 的模式一致。

> 源码位置：`src/ink/events/dispatcher.ts:161-233`

### EventEmitter

扩展 Node.js 的 `EventEmitter`，增加对 `Event.stopImmediatePropagation()` 的支持。当 emit 的第一个参数是 `Event` 实例时，每个监听器执行后检查是否调用了 `stopImmediatePropagation()`，若是则停止后续监听器执行。`maxListeners` 设为 0（无限制），因为 React 组件中多个 `useInput` hook 合法地监听同一事件。

> 源码位置：`src/ink/events/emitter.ts:1-39`

---

## 输入解析器 (parse-keypress.ts)

### 核心职责

将原始 stdin 字节流解析为三种结构化事件：`ParsedKey`（键盘/粘贴）、`ParsedMouse`（鼠标）、`ParsedResponse`（终端响应）。统一输出类型为 `ParsedInput`。

### 解析入口

`parseMultipleKeypresses(prevState, input)` 是唯一的公开解析接口（`src/ink/parse-keypress.ts:213-302`）：

1. **tokenize**：将原始输入交给 termio 层的 tokenizer 切分为 `sequence`（转义序列）和 `text`（可打印文本）token
2. **粘贴模式**：检测 `PASTE_START`/`PASTE_END` 标记，中间内容作为 `createPasteKey()` 输出（即使空粘贴也会产出事件，供 macOS 剪贴板图片处理使用）
3. **终端响应**：`parseTerminalResponse()` 识别 DECRPM、DA1/DA2、Kitty keyboard flags、光标位置、OSC 响应、XTVERSION 等终端应答
4. **鼠标事件**：`parseMouseEvent()` 解析 SGR 格式鼠标事件（点击/拖拽/释放，wheel 事件除外——wheel 保持为 ParsedKey 以便快捷键系统路由）
5. **键盘事件**：`parseKeypress()` 处理所有键盘输入

解析器是**有状态的**：`KeyParseState` 跟踪粘贴模式（`NORMAL` / `IN_PASTE`）、未完成的序列、粘贴缓冲区和内部 tokenizer 实例。`input=null` 表示 flush（超时后将缓冲的不完整序列作为普通按键释放）。

### 键盘协议支持

`parseKeypress()` 函数（`src/ink/parse-keypress.ts:611-785`）按优先级依次尝试：

1. **CSI u（Kitty 键盘协议）**：`ESC [ codepoint [; modifier] u`，通过 `keycodeToName()` 映射 codepoint 到键名，`decodeModifier()` 解码修饰键位掩码（bit 0=shift, 1=alt, 2=ctrl, 3=super）
2. **modifyOtherKeys（xterm）**：`ESC [ 27 ; modifier ; keycode ~`，与 CSI u 相似但参数顺序相反（modifier 在前，keycode 在后）
3. **SGR 鼠标**：解析 wheel 事件（`button & 0x43` 检查 wheel 标志和方向）和 X10 遗留鼠标编码
4. **特殊控制字符**：`\r`→return、`\n`→enter、`\t`→tab、`\x7f`/`\b`→backspace、`\x1b`→escape
5. **Ctrl 组合键**：字节值 `<= 0x1a` 映射为 `ctrl + 对应字母`
6. **Meta 键码**：`ESC + 字母/数字` 识别为 meta 修饰
7. **功能键序列**（FN_KEY_RE）：覆盖 xterm、gnome、rxvt、Cygwin 等终端的 F1-F12、方向键、Home/End/Insert/Delete/PageUp/PageDown 编码
8. **应用小键盘模式**：`ESC O letter` 映射为数字键和运算符

`keyName` 映射表（约 100 项）覆盖了主流终端模拟器的转义序列差异。

### 修饰键解码

`decodeModifier(modifier)` 将 xterm 风格的修饰值解码为独立标志（`src/ink/parse-keypress.ts:465-478`）：

```
modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0) + (super ? 8 : 0)
```

注意 `meta` 对应 Alt/Option（bit 2），`super` 对应 Cmd/Win（bit 8），两者是不同的修饰键。super 仅通过 Kitty 键盘协议或 modifyOtherKeys 到达。

### 终端响应解析

`parseTerminalResponse()` 识别以下终端应答（`src/ink/parse-keypress.ts:122-175`）：

| 类型 | 模式 | 说明 |
|------|------|------|
| `decrpm` | `CSI ? Ps ; Pm $ y` | DECRQM 模式查询响应 |
| `da1` | `CSI ? Ps ; ... c` | 主设备属性（通用哨兵） |
| `da2` | `CSI > Ps ; ... c` | 二级设备属性（终端版本） |
| `kittyKeyboard` | `CSI ? flags u` | Kitty 键盘协议当前标志 |
| `cursorPosition` | `CSI ? row ; col R` | 光标位置报告（DECXCPR） |
| `osc` | `OSC code ; data BEL/ST` | 操作系统命令响应（如背景色查询） |
| `xtversion` | `DCS > \| name ST` | 终端名称/版本（存活于 SSH 会话） |

### 孤立鼠标序列修复

解析器处理了一种微妙的竞态：当 React 渲染阻塞事件循环超过 50ms flush 超时时，跨 stdin chunk 的 CSI 序列会被拆分——ESC 前缀作为独立的 Escape 键 flush，后续部分 `[<btn;col;rowM` 作为文本到达。解析器检测这种模式并重新合成完整的鼠标序列，确保滚动事件正常工作而不是泄漏为垃圾文本。

> 源码位置：`src/ink/parse-keypress.ts:262-282`

---

## 鼠标交互

### 命中测试 (hit-test.ts)

#### hitTest()

递归查找包含 `(col, row)` 坐标的最深 DOM 元素（`src/ink/hit-test.ts:18-41`）：

1. 从 `nodeCache` 获取节点的屏幕矩形（由 `renderNodeToOutput` 填充，已包含滚动偏移）
2. 检查坐标是否在矩形内
3. **逆序遍历子节点**（后绘制的兄弟节点在上层）
4. 递归找到最深的命中节点
5. 未渲染或无 yogaNode 的节点（不在 nodeCache 中）连同其子树被跳过

#### dispatchClick()

点击事件分发（`src/ink/hit-test.ts:49-89`）：

1. `hitTest` 找到最深命中节点
2. **点击聚焦**：沿 parentNode 向上找到最近的 `tabIndex` 节点，通过 `focusManager.handleClickFocus()` 聚焦
3. 创建 `ClickEvent`，从命中节点向上冒泡
4. 在每个有 `onClick` 处理函数的节点前，计算 `localCol`/`localRow`（相对于该节点的矩形）
5. `stopImmediatePropagation()` 终止冒泡

#### dispatchHover()

悬停事件分发（`src/ink/hit-test.ts:102-130`）：

实现类 DOM 的 `mouseenter`/`mouseleave` 语义（**不冒泡**）。维护一个 `hovered: Set<DOMElement>`：
1. 从当前命中节点向上收集所有有悬停处理函数的祖先
2. 与上次 hovered 集合做 diff
3. 对离开的节点触发 `onMouseLeave`（跳过已 detach 的节点）
4. 对进入的节点触发 `onMouseEnter`

### 文本选择 (selection.ts)

selection.ts（917 行）实现了完整的终端文本选择系统，行为与 macOS 原生终端一致。

#### SelectionState

选区状态核心数据结构（`src/ink/selection.ts:19-63`）：

- `anchor`/`focus`：选区的锚点（鼠标按下处）和焦点（当前拖拽位置）
- `isDragging`：鼠标按下到释放之间为 true
- `anchorSpan`：双击选词/三击选行时的初始范围，包含 `kind: 'word' | 'line'`
- `scrolledOffAbove`/`scrolledOffBelow`：拖拽滚动时滚出视口的已选文本行（因为屏幕缓冲区只保存当前视口）
- `scrolledOffAboveSW`/`scrolledOffBelowSW`：并行的软换行标记
- `virtualAnchorRow`/`virtualFocusRow`：预夹紧的虚拟行号，用于键盘滚动的正确往返

#### 选择操作

**基本流程**：
- `startSelection(col, row)`：设置 anchor，focus 置 null（纯点击不高亮）
- `updateSelection(col, row)`：拖拽时更新 focus（首次移动需离开 anchor 所在单元格，防止亚像素抖动触发 1 格选区）
- `finishSelection()`：标记 isDragging=false，保留选区高亮
- `clearSelection()`：重置所有状态

**双击选词**（`selectWordAt`，`src/ink/selection.ts:240-254`）：

通过 `wordBoundsAt()` 在屏幕缓冲区中查找同类字符串的边界。字符分三类：空白（class 0）、单词字符（class 1，匹配 `[\p{L}\p{N}_/.\-+~\\]`）、其他标点（class 2）。单词字符集匹配 iTerm2 默认设置，使双击路径如 `/usr/bin/bash` 可以整体选中。宽字符（SpacerTail）在边界扩展时被正确跨越。

**三击选行**（`selectLineAt`，`src/ink/selection.ts:368-380`）：设置 anchor=行首、focus=行末。

**拖拽扩展选区**（`extendSelection`，`src/ink/selection.ts:389-421`）：在双击/三击后拖拽时，以初始 anchorSpan 为基准，按词/行粒度扩展。鼠标位置在 anchorSpan 前方→向前扩展，后方→向后扩展，重叠→仅选 anchorSpan。

**Shift 扩展**（`moveFocus`，`src/ink/selection.ts:442-450`）：键盘 shift+方向键扩展选区。切换到字符模式（清除 anchorSpan），anchor 不变、focus 移动。

#### 滚动跟随

选区必须跟随内容滚动，这涉及三种场景：

1. **拖拽滚动**（`shiftAnchor`）：鼠标拖到视口边缘触发 ScrollBox 滚动，anchor 跟随内容移动，focus 留在鼠标位置
2. **自动跟随滚动**（`shiftSelectionForFollow`）：流式输出时 ScrollBox 自动滚动，anchor 和 focus 都跟随。如果两端都滚出视口则清除选区
3. **键盘滚动**（`shiftSelection`）：PgUp/PgDn 等操作，整个选区偏移 dRow。使用虚拟行号追踪预夹紧位置，确保反向滚动能正确恢复

`captureScrolledRows()`（`src/ink/selection.ts:813-875`）在滚动发生前捕获即将滚出视口的行文本到 `scrolledOffAbove`/`scrolledOffBelow` 累积器，确保最终 `getSelectedText()` 能包含完整的已选内容。

#### 文本提取

`getSelectedText()`（`src/ink/selection.ts:773-795`）从屏幕缓冲区提取选中文本：

1. 先拼接 `scrolledOffAbove` 中的离屏行
2. 遍历视口内选区范围的行，通过 `extractRowText()` 逐行提取
3. 再拼接 `scrolledOffBelow`
4. 软换行行（`screen.softWrap` 标记）拼接到前一行而非另起新行，使复制文本反映逻辑行而非视觉折行
5. 跳过 `noSelect` 标记的单元格（gutters、行号等）
6. 跳过宽字符的 SpacerTail/SpacerHead
7. 非软换行行的末尾空白被修剪

#### 选区渲染

`applySelectionOverlay()`（`src/ink/selection.ts:893-917`）直接修改屏幕缓冲区中选区范围内单元格的样式：使用主题提供的固定选区背景色替换每个单元格的 bg，保留其 fg。这避免了早期 SGR-7 反色方案在语法高亮文本上产生的条纹碎片化问题。通过 `StylePool` 缓存优化性能，拖拽时每个单元格只需一次 Map 查找 + packed-int 写入。

#### URL 检测

`findPlainTextUrlAt()`（`src/ink/selection.ts:272-359`）在屏幕缓冲区中检测纯文本 URL。处理逻辑：

1. 在 ASCII 可打印字符范围内扩展左右边界
2. 寻找 `https?://` 或 `file://` scheme
3. 当点击位置前有多个 URL 时，选择最近的一个
4. 智能剥离尾部标点：逗号、句号等直接剥离；闭合括号仅在不平衡时剥离（保持 `/wiki/Foo_(bar)` 中的 `)`）

---

## 边界 Case 与注意事项

- **CSI u vs X10 鼠标歧义**：`CSI_U_RE` 要求 `[` 后紧跟数字（`/^\[\d/`），避免 X10 鼠标序列中 Cy=85（ASCII `'u'`）被误识别为 CSI u，导致 `"mouse"` 文字泄漏到输入框
- **孤立鼠标碎片**：X10 wheel 范围匹配被限制在 `[\x60-\x7f]`（wheel + modifiers），避免误匹配如 `[MAX]` 这样的合法输入
- **Kitty 未映射功能键**：Caps Lock（57358）、F13-F35 等无 keyName 映射的 codepoint 被静默吞噬，防止原始序列泄漏
- **点击抖动保护**：`updateSelection()` 忽略停留在 anchor 同一单元格的首次拖拽事件，防止亚像素抖动产生意外选区
- **Detach 节点安全**：`dispatchHover()` 在触发 `onMouseLeave` 前检查节点是否仍有 `parentNode`，避免在两次鼠标事件之间被移除的节点上调用处理函数
- **分发异常隔离**：`processDispatchQueue` 中每个处理函数调用被 try/catch 包裹，单个处理函数抛异常不影响后续分发