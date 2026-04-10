# TerminalIO —— 终端 IO 层

## 概述与职责

TerminalIO 是 InkFramework 的底层终端通信模块，封装了所有与终端交互的基础设施。它位于 TerminalUI → InkFramework 层级之下，为上层的渲染引擎、事件系统和 UI 组件提供原子级的终端控制能力。同级模块（UIComponents、Hooks、Screens 等）均通过 InkFramework 间接依赖此模块。

该模块由三个部分组成：

1. **termio/ 目录**（9 个文件）：完整的 ANSI/VT 转义序列库 + 流式解析器
2. **terminal.ts**：终端能力检测与 diff 写入
3. **辅助模块**：终端查询（terminal-querier.ts）、焦点状态（terminal-focus-state.ts）、屏幕清除（clearTerminal.ts）、超链接检测（supports-hyperlinks.ts）

---

## 模块结构

```
termio/
├── ansi.ts          # C0 控制字符与 ESC 序列类型常量
├── csi.ts           # CSI 序列生成与解析辅助
├── dec.ts           # DEC 私有模式（DECSET/DECRESET）
├── osc.ts           # OSC 序列（超链接、剪贴板、Tab 状态等）
├── sgr.ts           # SGR 样式解析（颜色、修饰符）
├── esc.ts           # 简单 ESC 序列解析（RIS、光标保存/恢复等）
├── tokenize.ts      # 转义序列边界检测 tokenizer
├── parser.ts        # 语义解析器，将 token 流转为结构化 Action
└── types.ts         # 所有语义类型定义

terminal.ts              # 终端写入与能力检测
terminal-querier.ts      # 终端类型查询（DA1/DA2/XTVERSION）
terminal-focus-state.ts  # 焦点状态信号
termio.ts                # 对外统一导出口
clearTerminal.ts         # 跨平台终端清屏
supports-hyperlinks.ts   # OSC 8 超链接能力检测
```

---

## 关键流程

### 1. ANSI 输出解析流程（Parser pipeline）

这是 TerminalIO 最核心的流程——将终端输出字节流解析为结构化的语义 Action。

```
原始字符串 → Tokenizer（边界检测）→ Parser（语义解析）→ Action[]
```

**Step 1: Tokenizer 切分**（`src/ink/termio/tokenize.ts:57-92`）

`createTokenizer()` 创建一个流式状态机，维护 7 种状态（`ground`、`escape`、`csi`、`osc`、`dcs`、`apc`、`ss3`、`escapeIntermediate`）。输入被切分为两类 Token：
- `text`: 普通文本段
- `sequence`: 完整的转义序列

Tokenizer 支持增量输入——不完整的序列会被缓冲到下一次 `feed()` 调用。

**Step 2: Parser 语义解析**（`src/ink/termio/parser.ts:272-394`）

`Parser` 类包装 Tokenizer，对每个 Token 进行语义解释：
- **text token** → 通过 `Intl.Segmenter` 分割为 Grapheme 数组（正确处理 emoji 和 CJK 宽字符），附加当前 `TextStyle`
- **CSI sequence** → 调用 `parseCSI()` 解析光标移动、擦除、滚动、DEC 模式切换等
- **OSC sequence** → 调用 `parseOSC()` 解析超链接、标题、Tab 状态等
- **ESC sequence** → 调用 `parseEsc()` 解析 RIS 重置、光标保存/恢复等
- **SGR sequence** → 调用 `applySGR()` 更新 Parser 内部的 `TextStyle` 状态（不产生 Action）

Parser 维护两个关键内部状态：
- `style: TextStyle` —— 当前文本样式，跨 `feed()` 调用持久
- `inLink / linkUrl` —— 当前超链接状态

### 2. Diff 写入流程

上层渲染引擎产出 `Diff`（patch 数组）后，通过 `writeDiffToTerminal()` 一次性写入终端（`src/ink/terminal.ts:190-248`）。

```typescript
writeDiffToTerminal(terminal, diff, skipSyncMarkers?)
```

关键设计：
1. **单次 buffer 写入**——所有 patch 拼接为一个字符串后一次性 `stdout.write()`，避免多次 I/O
2. **同步输出包装**——默认用 BSU/ESU（DEC 2026）包裹整个 buffer，防止终端在渲染中间刷新导致闪烁
3. 支持 11 种 patch 类型：`stdout`、`clear`、`clearTerminal`、`cursorHide/Show`、`cursorMove/To`、`carriageReturn`、`hyperlink`、`styleStr`

### 3. 终端查询流程（Terminal Querier）

`TerminalQuerier`（`src/ink/terminal-querier.ts:128-212`）实现了一套无超时的终端能力探测机制。

**核心思路**：每批查询以 DA1（CSI c）作为哨兵——因为所有 VT100+ 终端都会响应 DA1，且终端按序回复。如果某个查询的响应在 DA1 之前到达，说明终端支持它；如果 DA1 先到达，说明终端忽略了该查询。

```typescript
const [sync, grapheme] = await Promise.all([
  querier.send(decrqm(2026)),   // 查询 DEC 2026 支持
  querier.send(decrqm(2027)),   // 查询 grapheme 集群支持
  querier.flush(),               // 发送 DA1 哨兵
])
```

提供的查询构造器：
- `decrqm(mode)` —— DECRQM，查询 DEC 私有模式状态
- `da1()` / `da2()` —— Primary/Secondary Device Attributes
- `kittyKeyboard()` —— 查询 Kitty 键盘协议标志
- `cursorPosition()` —— DECXCPR，查询光标位置（使用 `?` 标记避免与 Shift+F3 歧义）
- `oscColor(code)` —— 查询动态颜色（前景/背景）
- `xtversion()` —— 查询终端名称/版本（可穿透 SSH）

---

## 转义序列库详解

### CSI 序列（`src/ink/termio/csi.ts`）

CSI（Control Sequence Introducer，`ESC [`）是最常用的转义序列族。

**生成函数**：

```typescript
function csi(...args: (string | number)[]): string
```

单参数视为原始 body（如 `csi('31m')` → `ESC[31m`），多参数则最后一个为 final byte、其余用 `;` 连接。

**预定义光标操作**：

| 函数 | 序列 | 说明 |
|------|------|------|
| `cursorUp(n)` | CSI n A | 光标上移 n 行 |
| `cursorDown(n)` | CSI n B | 光标下移 n 行 |
| `cursorForward(n)` | CSI n C | 光标右移 n 列 |
| `cursorBack(n)` | CSI n D | 光标左移 n 列 |
| `cursorTo(col)` | CSI col G | 光标移到指定列 |
| `cursorPosition(row, col)` | CSI row;col H | 光标移到指定位置 |
| `cursorMove(x, y)` | 组合序列 | 相对移动（正 x=右，正 y=下）|

**擦除操作**：

| 函数/常量 | 序列 | 说明 |
|-----------|------|------|
| `eraseLines(n)` | 循环 CSI 2K + CSI A | 从当前行向上擦除 n 行 |
| `ERASE_SCREEN` | CSI 2J | 擦除整个屏幕 |
| `ERASE_SCROLLBACK` | CSI 3J | 擦除滚动缓冲区 |

**滚动与区域**：

| 函数 | 序列 | 说明 |
|------|------|------|
| `scrollUp(n)` | CSI n S | 向上滚动 n 行 |
| `scrollDown(n)` | CSI n T | 向下滚动 n 行 |
| `setScrollRegion(top, bottom)` | CSI top;bottom r | 设置滚动区域（DECSTBM）|

**Kitty 键盘协议**（`src/ink/termio/csi.ts:293-319`）：

- `ENABLE_KITTY_KEYBOARD`（CSI >1u）—— 推入模式栈，启用键码消歧
- `DISABLE_KITTY_KEYBOARD`（CSI <u）—— 弹出模式栈
- `ENABLE_MODIFY_OTHER_KEYS`（CSI >4;2m）—— xterm modifyOtherKeys level 2，tmux 兼容路径

### DEC 私有模式（`src/ink/termio/dec.ts`）

通过 `decset(mode)` / `decreset(mode)` 生成 `CSI ? N h` / `CSI ? N l` 序列。

| 常量 | 模式号 | 说明 |
|------|--------|------|
| `SHOW_CURSOR` / `HIDE_CURSOR` | 25 | 光标显隐 |
| `ENTER_ALT_SCREEN` / `EXIT_ALT_SCREEN` | 1049 | 备用屏幕（带清除和光标保存）|
| `BSU` / `ESU` | 2026 | 同步输出（Begin/End Synchronized Update）|
| `EBP` / `DBP` | 2004 | 粘贴括号模式 |
| `EFE` / `DFE` | 1004 | 焦点事件上报 |
| `ENABLE_MOUSE_TRACKING` | 1000+1002+1003+1006 | 全功能鼠标追踪（SGR 格式）|

鼠标追踪通过叠加 4 个模式实现：普通按键（1000）+ 按钮拖拽（1002）+ 任意移动（1003）+ SGR 编码（1006），配对的 `DISABLE_MOUSE_TRACKING` 按逆序关闭。

### OSC 序列（`src/ink/termio/osc.ts`）

OSC（Operating System Command，`ESC ]`）用于终端与应用间的高级通信。

**生成函数**：

```typescript
function osc(...parts: (string | number)[]): string
```

终止符选择：kitty 使用 ST（`ESC \`）避免 BEL 蜂鸣，其他终端使用 BEL（`\x07`）。

**超链接（OSC 8）**（`src/ink/termio/osc.ts:403-420`）：

`link(url, params?)` 生成超链接开始序列，自动基于 URL 哈希计算 `id=` 参数——这确保终端在折行时能正确合并同一链接的多行。空 URL 表示链接结束。

**剪贴板（OSC 52）**（`src/ink/termio/osc.ts:138-158`）：

`setClipboard(text)` 实现了三层递进的剪贴板写入策略：

1. **Native 优先**（本地非 SSH）：立即 fire-and-forget 调用 `pbcopy`/`wl-copy`/`xclip`/`xsel`/`clip.exe`
2. **tmux buffer**（在 tmux 内）：`tmux load-buffer -w -` 写入 tmux 缓冲区，`-w` 同时传播到外层终端。iTerm2 跳过 `-w` 避免崩溃（#22432）
3. **OSC 52 序列**（兜底）：Base64 编码后写入 stdout

`getClipboardPath()` 可同步预判将使用哪条路径（`'native'` | `'tmux-buffer'` | `'osc52'`），供 UI 层显示准确的 toast 提示。

**tmux/screen 穿透**（`src/ink/termio/osc.ts:35-44`）：

`wrapForMultiplexer(sequence)` 将转义序列包装为 DCS passthrough，穿透 tmux/screen 到达外层终端。tmux 需要用户配置 `allow-passthrough on`。

**Tab 状态（OSC 21337）**（`src/ink/termio/osc.ts:476-493`）：

`tabStatus(fields)` 生成 Tab 指示器序列，支持 `indicator`（颜色指示点）、`status`（状态文本）、`statusColor`（文本颜色）三个字段。值中的 `;` 和 `\` 按规范转义。目前限 Anthropic 内部使用（`supportsTabStatus()` 检查 `USER_TYPE=ant`）。

**iTerm2 扩展（OSC 9）**：

定义了 `ITERM2.NOTIFY`（0）、`ITERM2.BADGE`（2）、`ITERM2.PROGRESS`（4）子命令常量和进度操作码（`PROGRESS.CLEAR/SET/ERROR/INDETERMINATE`）。

### SGR 样式（`src/ink/termio/sgr.ts`）

`applySGR(paramStr, style)` 解析 SGR 参数字符串并更新 `TextStyle` 对象（`src/ink/termio/sgr.ts:127-308`）。

支持的样式属性：

| 代码 | 效果 | 重置代码 |
|------|------|----------|
| 1 | 粗体 | 22 |
| 2 | 暗淡 | 22 |
| 3 | 斜体 | 23 |
| 4 | 下划线（支持 colon 子参数：single/double/curly/dotted/dashed）| 24 |
| 5/6 | 闪烁 | 25 |
| 7 | 反色 | 27 |
| 8 | 隐藏 | 28 |
| 9 | 删除线 | 29 |
| 53 | 上划线 | 55 |

**颜色系统**：

- **16 色**（代码 30-37/40-47/90-97/100-107）→ `NamedColor`
- **256 色**（38;5;N / 48;5;N）→ `{ type: 'indexed', index }`
- **RGB 真彩色**（38;2;R;G;B / 48;2;R;G;B）→ `{ type: 'rgb', r, g, b }`
- **下划线颜色**（58;5;N / 58;2;R;G;B）→ `underlineColor`

参数解析同时支持分号（`;`）和冒号（`:`）分隔符——冒号形式（如 `38:2::R:G:B`）是较新的标准，通过 subparams 机制处理（`src/ink/termio/sgr.ts:79-125`）。

### ESC 序列（`src/ink/termio/esc.ts`）

处理 `ESC` + 1-2 字符的简单序列：

| 序列 | 含义 |
|------|------|
| ESC c | RIS 全局重置 |
| ESC 7 / ESC 8 | DECSC/DECRC 光标保存/恢复 |
| ESC D | IND 索引（光标下移一行）|
| ESC M | RI 反向索引（光标上移一行）|
| ESC E | NEL 下一行 |
| ESC ( X | 字符集选择（静默忽略）|

### 基础常量（`src/ink/termio/ansi.ts`）

定义了完整的 C0 控制字符表（NUL 到 DEL）和 6 种转义序列引入符类型：

```typescript
ESC_TYPE = { CSI: 0x5B, OSC: 0x5D, DCS: 0x50, APC: 0x5F, PM: 0x5E, SOS: 0x58, ST: 0x5C }
```

---

## 类型定义

### `Action`（`src/ink/termio/types.ts:224-236`）

Parser 输出的核心联合类型，表示所有可能的终端操作：

```typescript
type Action =
  | { type: 'text'; graphemes: Grapheme[]; style: TextStyle }
  | { type: 'cursor'; action: CursorAction }
  | { type: 'erase'; action: EraseAction }
  | { type: 'scroll'; action: ScrollAction }
  | { type: 'mode'; action: ModeAction }
  | { type: 'link'; action: LinkAction }
  | { type: 'title'; action: TitleAction }
  | { type: 'tabStatus'; action: TabStatusAction }
  | { type: 'sgr'; params: string }
  | { type: 'bell' }
  | { type: 'reset' }
  | { type: 'unknown'; sequence: string }
```

### `TextStyle`（`src/ink/termio/types.ts:52-65`）

文本样式的完整状态：包含 9 个布尔修饰符 + 前景色/背景色/下划线颜色。

### `Color`（`src/ink/termio/types.ts:32-36`）

四种颜色表示：`named`（16 色）、`indexed`（256 色）、`rgb`（真彩色）、`default`。

### `TerminalQuery<T>`（`src/ink/terminal-querier.ts:30-35`）

查询构造器的返回类型，包含要发送的 `request` 序列和识别响应的 `match` 函数。

---

## 终端能力检测

### 同步输出（DEC 2026）

`isSynchronizedOutputSupported()`（`src/ink/terminal.ts:70-118`）通过环境变量检测终端是否支持同步输出。结果在模块加载时计算一次并缓存为 `SYNC_OUTPUT_SUPPORTED`。

支持的终端：iTerm2、WezTerm、Warp、Ghostty、Contour、VS Code、Alacritty、Kitty、foot、Zed、Windows Terminal、VTE 0.68+。明确排除 tmux（BSU/ESU 穿透后原子性被 tmux 分块破坏）。

### 进度上报（OSC 9;4）

`isProgressReportingAvailable()`（`src/ink/terminal.ts:25-64`）检测 ConEmu（全版本）、Ghostty 1.2.0+、iTerm2 3.6.6+ 的进度条支持。明确排除 Windows Terminal（将 OSC 9;4 误解为通知而非进度）。

### 扩展按键（Kitty/modifyOtherKeys）

`supportsExtendedKeys()`（`src/ink/terminal.ts:167-169`）基于允许列表判断：iTerm.app、kitty、WezTerm、Ghostty、tmux、windows-terminal。其他终端可能错误启用该协议后产生解析器无法处理的键码。

### XTVERSION 探测

`setXtversionName()` / `isXtermJs()`（`src/ink/terminal.ts:130-146`）解决 SSH 场景下 `TERM_PROGRAM` 不被转发的问题——XTVERSION 查询穿过 pty 到达客户端终端并返回名称字符串（如 `"xterm.js(5.5.0)"`）。用于识别 VS Code/Cursor/Windsurf 集成终端。

### 超链接检测

`supportsHyperlinks()`（`src/ink/supports-hyperlinks.ts:26-57`）扩展了 `supports-hyperlinks` 库，额外检测 Ghostty、Hyper、Kitty、Alacritty、iTerm2。同时检查 `LC_TERMINAL`（在 tmux 内 `TERM_PROGRAM` 被覆盖时保留）和 `TERM` 变量（kitty 设置 `TERM=xterm-kitty`）。

---

## 焦点状态管理

`terminal-focus-state.ts`（`src/ink/terminal-focus-state.ts`）维护终端焦点的全局信号，三态：`'focused'` | `'blurred'` | `'unknown'`（默认，不支持焦点上报的终端）。

- `setTerminalFocused(v)` —— 由输入解析器在收到 CSI I/O（焦点事件）时调用
- `getTerminalFocused()` —— 返回 `boolean`，`'unknown'` 视同 `'focused'`
- `subscribeTerminalFocus(cb)` —— 供 `useSyncExternalStore` 订阅，React 组件可响应焦点变化
- `resetTerminalFocusState()` —— 重置为 `'unknown'`

---

## 屏幕清除

`getClearTerminalSequence()`（`src/ink/clearTerminal.ts:59-69`）返回跨平台的清屏序列：

- **Unix / 现代 Windows**（Windows Terminal、VS Code、mintty）：`ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME`
- **传统 Windows 控制台**：`ERASE_SCREEN + HVP(0,0)`（不支持清除滚动缓冲区）

---

## 边界 Case 与注意事项

1. **X10 鼠标与 CSI DL 歧义**（`src/ink/termio/tokenize.ts:205-245`）：`CSI M` 同时表示 X10 鼠标事件前缀和 Delete Lines 命令。Tokenizer 通过 `x10Mouse` 选项区分——仅 stdin 输入启用，输出解析不启用。另有详细的边界检查防止 PASTE_END 序列被误吞。

2. **UTF-8 编码下 X10 坐标折叠**：当终端列数 ≥162 时，X10 编码的两个坐标字节可能构成合法 UTF-8 双字节序列而被 Node.js 合并为一个字符。这是 X10 编码的固有限制，SGR 鼠标编码（1006）不受此影响。

3. **tmux 中的 BEL**（`src/ink/termio/osc.ts:33`）：不要在 `wrapForMultiplexer` 中包装 BEL——原始 BEL 会触发 tmux 的 bell-action 窗口标记，而包装后的 BEL 作为 DCS 负载对 tmux 不可见。

4. **iTerm2 OSC 52 崩溃**（`src/ink/termio/osc.ts:86-101`）：tmux 自身的 OSC 52 发射（空选择参数形式）会导致 iTerm2 在 SSH 下崩溃，因此 `tmuxLoadBuffer` 对 iTerm2 跳过 `-w` 标志。

5. **Windows 光标上移 bug**（`src/ink/terminal.ts:176-179`）：Windows conhost 的 `SetConsoleCursorPosition` 在光标上移超出可见区域时会滚动视口到缓冲区顶部。`hasCursorUpViewportYankBug()` 检测此情况。

6. **OSC 终止符选择**：kitty 使用 ST（`ESC \`）而非 BEL 作为 OSC 终止符，因为 BEL 在 kitty 中会触发蜂鸣。