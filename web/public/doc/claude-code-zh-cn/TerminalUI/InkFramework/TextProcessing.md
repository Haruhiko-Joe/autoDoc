# 文本处理工具集（TextProcessing）

## 概述与职责

TextProcessing 是 InkFramework 中的底层文本处理工具集，为终端 UI 渲染提供**文本度量、变换和渲染**三大类基础能力。它位于 `TerminalUI > InkFramework` 层级中，被布局引擎、渲染管线和 UI 组件广泛依赖。

同级的兄弟模块包括 UIComponents（业务组件库）、Hooks（行为逻辑）、Screens（主屏幕）等——它们都直接或间接消费 TextProcessing 提供的文本能力。

本模块涵盖 12 个文件，按功能可分为：

| 类别 | 文件 | 职责 |
|------|------|------|
| 度量 | `stringWidth.ts`, `measure-text.ts`, `widest-line.ts`, `get-max-width.ts` | 计算文本终端显示宽度与尺寸 |
| 变换 | `wrap-text.ts`, `wrapAnsi.ts`, `tabstops.ts`, `bidi.ts` | 文本换行、制表符展开、双向文本重排 |
| 渲染 | `Ansi.tsx`, `colorize.ts`, `searchHighlight.ts`, `squash-text-nodes.ts` | ANSI 解析、着色、搜索高亮、节点合并 |

---

## 关键流程

### 文本度量流程

终端中一个字符的"显示宽度"并非总是 1——CJK 字符占 2 列、emoji 占 2 列、零宽字符占 0 列。度量流程是整个布局系统的基石：

1. **`stringWidth(str)`** 是核心入口（`src/ink/stringWidth.ts:220-222`）。它优先使用 `Bun.stringWidth`（原生实现，性能更高），不可用时回退到 JS 实现
2. JS 实现中有三层快速路径：
   - **纯 ASCII**：直接计数可打印字符（跳过控制字符），`O(n)` 无额外分配（`stringWidth.ts:26-45`）
   - **简单 Unicode（无 emoji）**：逐字符调用 `eastAsianWidth()` 计算宽度（`stringWidth.ts:56-65`）
   - **含 emoji/复杂字形**：使用 `Intl.Segmenter` 进行字形簇分割，再逐簇计算宽度（`stringWidth.ts:69-87`）
3. `isZeroWidth()` 函数（`stringWidth.ts:129-203`）判断零宽字符，覆盖范围包括：控制字符、ZWJ/ZWNBSP、变体选择符、组合变音符号、印度语系/泰语/老挝语组合标记、阿拉伯语格式字符等
4. **`measureText(text, maxWidth)`**（`src/ink/measure-text.ts:11-45`）在单次遍历中同时计算文本的宽度和高度（考虑换行），避免了两次遍历的开销
5. **`widestLine(text)`**（`src/ink/widest-line.ts:3-19`）遍历所有行返回最大行宽，使用 `lineWidth` 缓存加速
6. **`getMaxWidth(yogaNode)`**（`src/ink/get-max-width.ts:17-27`）从 Yoga 布局节点获取内容区宽度（总宽度减去 padding 和 border）

### ANSI 解析与渲染流程

当外部工具（如语法高亮器）产出包含 ANSI 转义序列的字符串时，需要将其转换为 React 组件树：

1. **`<Ansi>` 组件**（`src/ink/Ansi.tsx:32-109`）接收 ANSI 字符串作为 `children`
2. 调用 `parseToSpans()` 使用 termio Parser 解析 ANSI 序列，产出 `Span[]`——每个 Span 包含纯文本和样式属性（`Ansi.tsx:118-153`）
3. 相邻且样式相同的 Span 会被合并（`propsEqual` 比较，`Ansi.tsx:212-214`），减少 React 节点数
4. 每个 Span 渲染为 `<Text>` 或 `<Link>` 组件，样式通过 props 传递
5. 支持 `dimColor` prop 强制所有文本变暗
6. 使用 `React.memo` + React Compiler 的缓存机制避免不必要的重渲染

### 着色流程

`colorize.ts` 负责将颜色值应用到文本上，是样式系统的出口：

1. **`colorize(str, color, type)`**（`src/ink/colorize.ts:69-169`）根据颜色格式分发：
   - `ansi:*` → chalk 命名颜色（16 色）
   - `#hex` → chalk.hex / chalk.bgHex
   - `ansi256(N)` → chalk.ansi256
   - `rgb(r,g,b)` → chalk.rgb
2. **`applyTextStyles(text, styles)`**（`colorize.ts:176-220`）按特定顺序应用完整样式栈：text modifiers → foreground → background（由内到外嵌套）
3. **终端兼容性处理**（模块加载时执行）：
   - VS Code 终端（xterm.js）：chalk level 从 2 提升到 3（truecolor），因为 xterm.js 支持但环境变量未正确设置（`colorize.ts:20-26`）
   - tmux 环境：chalk level 从 3 降到 2（256 色），因为默认 tmux 配置不能正确透传 truecolor（`colorize.ts:47-57`）

### 文本换行流程

1. **`wrapAnsi`**（`src/ink/wrapAnsi.ts`）是 ANSI 感知换行的底层接口，优先使用 `Bun.wrapAnsi`，回退到 `wrap-ansi` npm 包
2. **`wrapText(text, maxWidth, wrapType)`**（`src/ink/wrap-text.ts:40-74`）是上层 API，支持多种换行模式：
   - `wrap`：硬换行，不裁剪空白
   - `wrap-trim`：硬换行，裁剪行首空白
   - `truncate` / `truncate-middle` / `truncate-start`：用省略号（`…`）截断
3. 截断处理通过 `sliceFit()` 确保 CJK 宽字符不会在边界处溢出（`wrap-text.ts:10-13`）

### 搜索高亮流程

`applySearchHighlight`（`src/ink/searchHighlight.ts:27-93`）直接操作屏幕缓冲区：

1. 逐行构建小写文本 + code-unit → cell 索引映射，跳过 SpacerTail/SpacerHead/noSelect 单元格
2. 用 `indexOf` 在行文本中查找匹配，非重叠推进
3. 对匹配区域的每个 cell 调用 `stylePool.withInverse()` 反转样式（SGR 7）
4. 返回是否有匹配（用于触发全帧 damage）

---

## 函数签名与参数说明

### `stringWidth(str: string): number`

计算字符串在终端中的显示宽度（列数）。处理 ANSI 转义序列剥离、CJK 全角字符（宽度 2）、emoji（宽度 2）、零宽字符（宽度 0）。

> 源码位置：`src/ink/stringWidth.ts:220-222`

### `measureText(text: string, maxWidth: number): { width: number; height: number }`

单次遍历计算文本的显示宽度和视觉高度。`maxWidth` 用于计算换行后的行数；`maxWidth <= 0` 或 `Infinity` 表示不换行。

> 源码位置：`src/ink/measure-text.ts:11-45`

### `widestLine(string: string): number`

返回多行文本中最宽行的显示宽度。

> 源码位置：`src/ink/widest-line.ts:3-19`

### `getMaxWidth(yogaNode: LayoutNode): number`

从 Yoga 布局节点获取内容区可用宽度（计算宽度 - padding - border）。

> 源码位置：`src/ink/get-max-width.ts:17-27`

### `wrapText(text: string, maxWidth: number, wrapType: Styles['textWrap']): string`

根据换行策略处理文本。支持 `'wrap'`、`'wrap-trim'`、`'truncate'`、`'truncate-middle'`、`'truncate-start'`。

> 源码位置：`src/ink/wrap-text.ts:40-74`

### `colorize(str: string, color: string | undefined, type: ColorType): string`

将颜色应用到字符串。`type` 为 `'foreground'` 或 `'background'`。颜色格式支持 `ansi:*`、`#hex`、`ansi256(N)`、`rgb(r,g,b)`。

> 源码位置：`src/ink/colorize.ts:69-169`

### `applyTextStyles(text: string, styles: TextStyles): string`

将完整的 TextStyles（颜色、粗体、斜体、下划线等）应用到文本，返回包含 ANSI 转义序列的字符串。

> 源码位置：`src/ink/colorize.ts:176-220`

### `reorderBidi(characters: ClusteredChar[]): ClusteredChar[]`

对 ClusteredChar 数组执行 Unicode 双向算法重排序（逻辑序→视觉序）。仅在 Windows / Windows Terminal / VS Code 终端中激活，macOS 终端原生支持 bidi。

> 源码位置：`src/ink/bidi.ts:53-105`

### `expandTabs(text: string, interval?: number): string`

将制表符展开为空格，默认 8 列间隔（POSIX 标准）。使用 termio tokenizer 确保 ANSI 转义序列不被破坏。

> 源码位置：`src/ink/tabstops.ts:9-46`

### `applySearchHighlight(screen: Screen, query: string, stylePool: StylePool): boolean`

在屏幕缓冲区中高亮所有匹配搜索词的位置（大小写不敏感，反转样式）。返回是否有匹配。

> 源码位置：`src/ink/searchHighlight.ts:27-93`

### `squashTextNodes(node: DOMElement): string`

将 DOM 树中的文本节点递归合并为纯文本字符串，用于布局度量。

> 源码位置：`src/ink/squash-text-nodes.ts:69-92`

### `squashTextNodesToSegments(node: DOMElement, ...): StyledSegment[]`

将 DOM 树中的文本节点递归合并为带样式的段落数组（`StyledSegment[]`），样式沿树向下继承。支持 `ink-text`、`ink-virtual-text`、`ink-link` 节点。

> 源码位置：`src/ink/squash-text-nodes.ts:18-63`

---

## 类型定义

### `StyledSegment`

```typescript
type StyledSegment = {
  text: string
  styles: TextStyles
  hyperlink?: string
}
```

表示一段带样式的文本，由 `squashTextNodesToSegments` 产出，用于结构化渲染。

### `SpanProps`（Ansi.tsx 内部）

```typescript
type SpanProps = {
  color?: Color
  backgroundColor?: Color
  dim?: boolean
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  inverse?: boolean
  hyperlink?: string
}
```

ANSI 解析后每个 Span 的样式属性，映射到 `<Text>` 组件 props。

### `ColorType`

```typescript
type ColorType = 'foreground' | 'background'
```

指示颜色应用于前景还是背景。

---

## 配置项与默认值

| 配置 | 默认值 | 说明 |
|------|--------|------|
| Tab 间隔 | 8 列 | `expandTabs` 的 `interval` 参数，POSIX 标准默认值 |
| `ambiguousAsWide` | `false` | `stringWidth` 中 East Asian 模糊宽度字符按窄处理（Unicode 标准推荐） |
| `CLAUDE_CODE_TMUX_TRUECOLOR` | 未设置 | 环境变量，设置后跳过 tmux 的 chalk level 降级 |

chalk level 自动调整逻辑：
- VS Code 终端 + chalk level 2 → 提升到 3（truecolor）
- tmux 环境 + chalk level > 2 → 降到 2（256 色），除非设置了 `CLAUDE_CODE_TMUX_TRUECOLOR`

---

## 边界 Case 与注意事项

- **Bun vs JS 实现差异**：`stringWidth` 和 `wrapAnsi` 都有 Bun 原生实现和 JS 回退。对于复杂字形（如梵文连字 क्ष），Bun 返回 2（匹配终端实际列分配），JS 回退返回 1（按字形簇计算）——这可能导致布局不一致（`stringWidth.ts:205-212`）
- **tmux truecolor 降级**：默认 tmux 配置下 truecolor 被降到 256 色。已正确配置 `terminal-overrides ,*:Tc` 的用户会受到不必要的降级，但视觉差异极小
- **搜索高亮排除区域**：`applySearchHighlight` 跳过 `noSelect` 标记的单元格（如行号装饰列），确保搜索只匹配内容区域
- **bidi 仅限非 macOS**：双向文本重排仅在 Windows/WSL/VS Code 终端激活，macOS 终端原生处理 RTL 文本
- **`getMaxWidth` 可能超出父容器**：在 column-direction flex 布局中，cross axis 的 align-items:stretch 不会收缩子节点，因此返回值可能大于实际可用空间——调用方应自行 clamp（`get-max-width.ts:7-16`）
- **宽字符截断安全**：`sliceFit` 处理了 CJK 字符在切片边界溢出的情况，会自动重试更紧的边界（`wrap-text.ts:10-13`）