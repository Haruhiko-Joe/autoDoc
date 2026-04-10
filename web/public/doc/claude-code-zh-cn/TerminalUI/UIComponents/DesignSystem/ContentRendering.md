# 内容渲染组件（ContentRendering）

## 概述与职责

ContentRendering 是 Claude Code 终端 UI 的**内容渲染核心**，负责将 Markdown 文本和代码片段转化为终端中带有样式的可视化输出。它位于 TerminalUI → UIComponents → DesignSystem 层级中，作为设计系统的渲染原语，被上层的消息渲染（MessageRendering）、差异展示（StructuredDiff）等组件广泛依赖。

模块由四个文件组成，各司其职：

| 文件 | 职责 |
|------|------|
| `HighlightedCode.tsx` | 代码语法高亮（NAPI 加速路径） |
| `HighlightedCode/Fallback.tsx` | 代码语法高亮（纯文本回退路径） |
| `Markdown.tsx` | Markdown 解析与终端渲染 |
| `MarkdownTable.tsx` | Markdown 表格的列宽计算与终端对齐渲染 |

## 关键流程

### 1. Markdown 渲染流程

**入口**：`Markdown` 组件（`src/components/Markdown.tsx:78`）

整体渲染采用**混合策略**——表格由 React 组件渲染（利用 Ink 的 flexbox 布局），其余内容通过 `formatToken` 转换为 ANSI 字符串。

1. 检查用户设置 `syntaxHighlightingDisabled`：
   - 若禁用，直接渲染 `MarkdownBody`，`highlight` 传 `null`
   - 若启用，通过 `Suspense` 异步加载语法高亮器（`getCliHighlightPromise()`），加载期间显示无高亮的回退内容

2. `MarkdownBody`（`Markdown.tsx:123`）执行实际渲染：
   - 调用 `stripPromptXMLTags()` 清理系统注入的 XML 标签
   - 调用 `cachedLexer()` 将 Markdown 文本解析为 token 数组
   - 遍历 token：遇到 `table` 类型时交给 `MarkdownTable` 组件渲染；其余 token 通过 `formatToken()` 转为 ANSI 字符串，积累后包裹在 `<Ansi>` 组件中
   - 最终以 `<Box flexDirection="column" gap={1}>` 布局所有元素

3. **Token 缓存机制**（`Markdown.tsx:22-71`）：
   - 模块级 LRU 缓存（容量 500），键为内容哈希（避免保留完整字符串导致内存膨胀，参考 #24180）
   - **快速路径**：通过正则 `MD_SYNTAX_RE` 检测前 500 字符是否包含 Markdown 语法标记，若无则跳过 `marked.lexer`（约省 3ms），直接构造单个 paragraph token
   - 缓存采用 "delete + re-set" 实现 LRU 提升，避免 FIFO 驱逐策略在虚拟滚动场景下的缓存失效

### 2. 流式 Markdown 渲染

**入口**：`StreamingMarkdown` 组件（`Markdown.tsx:186`）

流式渲染用于模型响应的逐步输出场景，核心优化是**增量解析**：

1. 维护 `stablePrefixRef` 追踪已稳定的文本前缀
2. 每次增量到达时，只对 `stablePrefixRef` 之后的新增内容调用 `marked.lexer()`
3. 将 token 序列中最后一个非空白 token 视为"不稳定块"（仍在增长），其前所有 token 的原始文本合并到稳定前缀
4. 渲染时拆分为两个 `<Markdown>`：稳定前缀（被 useMemo 缓存，不会重复解析）和不稳定后缀
5. 稳定边界只单调递增，保证 StrictMode 双渲染下 ref 修改是幂等的

> 源码位置：`src/components/Markdown.tsx:186-235`

### 3. 代码语法高亮流程

**入口**：`HighlightedCode` 组件（`src/components/HighlightedCode.tsx:18`）

采用**双层渲染策略**，优先使用 NAPI 加速，失败时降级到纯文本高亮：

**主路径（NAPI 加速）**：
1. 通过 `expectColorFile()` 获取原生 `ColorFile` 类（来自 `StructuredDiff/colorDiff.js`）
2. 用 `new ColorFile(code, filePath)` 创建着色文件实例
3. 调用 `colorFile.render(theme, measuredWidth, dim)` 生成带 ANSI 样式的行数组
4. 在全屏模式下计算行号槽宽度（`gutterWidth`），每行拆分为行号（`<NoSelect>` 不可选中）和代码内容

**回退路径**（`src/components/HighlightedCode/Fallback.tsx:39`）：
1. 当 `ColorFile` 不可用或语法高亮被禁用时触发
2. `skipColoring` 为 true 时直接渲染纯文本
3. 否则通过 `Suspense` 异步加载 `cli-highlight` 库
4. `Highlighted` 内部组件（`Fallback.tsx:124`）从文件扩展名推断语言，调用 `hl.highlight()` 生成 ANSI 输出
5. 不支持的语言自动降级到 markdown 高亮
6. 同样使用模块级 LRU 缓存（`hlCache`，容量 500），键为 `hashPair(language, code)`

**宽度测量**：组件先用默认 80 列渲染，挂载后通过 `measureElement()` 获取实际宽度并更新（`HighlightedCode.tsx:65-82`）。

### 4. 表格渲染流程

**入口**：`MarkdownTable` 组件（`src/components/MarkdownTable.tsx:72`）

表格渲染需要解决终端宽度限制下的列宽分配和内容换行问题，采用**三级布局策略**：

**列宽计算**（`MarkdownTable.tsx:108-156`）：
1. 计算每列的**最小宽度**（最长单词宽度）和**理想宽度**（完整内容宽度）
2. 减去边框开销（`1 + numCols * 3`）和安全边距（4 字符）得到可用宽度
3. 三种分配策略：
   - 理想宽度总和 ≤ 可用宽度：使用理想宽度，无需换行
   - 最小宽度总和 ≤ 可用宽度 < 理想宽度总和：给每列最小宽度后，按溢出量比例分配剩余空间
   - 最小宽度总和 > 可用宽度：按比例缩小所有列，启用硬换行（断词）

**格式选择**（`MarkdownTable.tsx:183-184`）：
- 计算各单元格换行后的最大行数，超过 `MAX_ROW_LINES`（4 行）时切换到**纵向格式**（键值对展示）
- 渲染完成后再做安全检查：若任何行宽超过 `terminalWidth - SAFETY_MARGIN`，也降级为纵向格式

**横向格式渲染**（`MarkdownTable.tsx:188-320`）：
- 使用 Unicode box-drawing 字符（`┌─┬┐│├─┼┤└─┴┘`）绘制表格边框
- 多行单元格垂直居中对齐
- 表头始终居中，数据列遵循 Markdown 的 `align` 声明（left/center/right）
- 通过 `padAligned()` 函数实现 ANSI 感知的对齐填充

**纵向格式渲染**（`MarkdownTable.tsx:241-288`）：
- 每行数据展示为键值对列表，行间用水平线分隔
- 第一行标签和值在同一行，后续换行内容缩进 2 空格
- 标签加粗显示（ANSI bold）

## 函数签名与参数说明

### `Markdown({ children, dimColor? })`

渲染 Markdown 内容到终端。

| 参数 | 类型 | 说明 |
|------|------|------|
| `children` | `string` | Markdown 文本内容 |
| `dimColor` | `boolean?` | 为 true 时所有文本以暗色渲染 |

> 源码位置：`src/components/Markdown.tsx:78-101`

### `StreamingMarkdown({ children })`

流式 Markdown 渲染，用于模型响应的逐步输出。通过增量解析和稳定前缀分割，只重新解析最后一个不稳定块。

| 参数 | 类型 | 说明 |
|------|------|------|
| `children` | `string` | 当前累积的 Markdown 文本 |

> 源码位置：`src/components/Markdown.tsx:186-235`

### `HighlightedCode({ code, filePath, width?, dim? })`

代码语法高亮组件（`memo` 包裹）。优先使用 NAPI `ColorFile`，不可用时降级到 `HighlightedCodeFallback`。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `code` | `string` | - | 代码内容 |
| `filePath` | `string` | - | 文件路径，用于推断语言和着色 |
| `width` | `number?` | 80 | 渲染宽度，未指定时自动测量 |
| `dim` | `boolean?` | `false` | 暗色渲染 |

> 源码位置：`src/components/HighlightedCode.tsx:18-136`

### `HighlightedCodeFallback({ code, filePath, dim?, skipColoring? })`

纯文本代码高亮回退组件，通过 `cli-highlight` 库实现语法高亮。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `code` | `string` | - | 代码内容 |
| `filePath` | `string` | - | 文件路径，扩展名用于语言推断 |
| `dim` | `boolean?` | `false` | 暗色渲染 |
| `skipColoring` | `boolean?` | `false` | 跳过着色，直接渲染纯文本 |

> 源码位置：`src/components/HighlightedCode/Fallback.tsx:39-123`

### `MarkdownTable({ token, highlight, forceWidth? })`

Markdown 表格渲染组件，支持横向表格和纵向键值对两种格式。

| 参数 | 类型 | 说明 |
|------|------|------|
| `token` | `Tokens.Table` | marked 解析器输出的表格 token |
| `highlight` | `CliHighlight \| null` | 语法高亮器实例 |
| `forceWidth` | `number?` | 覆盖终端宽度（用于测试） |

> 源码位置：`src/components/MarkdownTable.tsx:72-321`

## 配置项与默认值

| 配置 | 来源 | 默认值 | 说明 |
|------|------|--------|------|
| `syntaxHighlightingDisabled` | `useSettings()` | `false` | 禁用语法高亮，所有代码和 Markdown 内代码块以纯文本渲染 |
| `TOKEN_CACHE_MAX` | 常量 | 500 | Markdown token 缓存最大条目数 |
| `HL_CACHE_MAX` | 常量 | 500 | 代码高亮结果缓存最大条目数 |
| `DEFAULT_WIDTH` | 常量 | 80 | 代码组件默认渲染宽度 |
| `SAFETY_MARGIN` | 常量 | 4 | 表格布局安全边距，防止终端 resize 竞态导致闪烁 |
| `MIN_COLUMN_WIDTH` | 常量 | 3 | 表格列最小宽度 |
| `MAX_ROW_LINES` | 常量 | 4 | 超过此行数的行切换为纵向格式 |

## 边界 Case 与注意事项

- **React Compiler 缓存**：所有组件均使用 React Compiler 的 `_c()` 缓存运行时进行手动 memo 优化。`StreamingMarkdown` 通过 `'use no memo'` 指令退出编译器优化，因为其 ref 读写模式无法被编译器静态验证安全性。

- **虚拟滚动兼容**：Token 缓存和高亮缓存均在模块级（非组件级）维护，因为 `useMemo` 不会在 unmount→remount 间保留。虚拟滚动中消息频繁挂载/卸载，模块级缓存避免了重复解析。

- **内存管理**：缓存键使用内容哈希（`hashContent`/`hashPair`）而非完整字符串，避免在 raw/text 等字段上重复保留内容引起 RSS 膨胀（修复 #24180）。

- **终端 resize 竞态**：`MarkdownTable` 的 `SAFETY_MARGIN` 和渲染后安全检查专门处理终端窗口大小变化与 Ink 渲染周期不同步的问题。宽度不足时自动降级为纵向格式，而非截断内容。

- **语言降级链**：`HighlightedCodeFallback` 中，不支持的语言 → 尝试 markdown 高亮 → 捕获异常后返回纯文本。确保任何语言输入都不会导致渲染失败。

- **流式渲染的前缀重置**：`StreamingMarkdown` 中，`stripPromptXMLTags` 可能导致 stripped 文本不再以旧前缀开头（如闭合标签到达时），此时前缀重置为空字符串并重新计算（`Markdown.tsx:206-208`）。