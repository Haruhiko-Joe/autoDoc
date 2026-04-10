# 差异对比展示系统（DiffDisplay）

## 概述与职责

DiffDisplay 是 Claude Code 终端 UI 中的**差异对比展示系统**，负责将代码变更以结构化、语法高亮的方式渲染到终端界面中。它位于 `TerminalUI > UIComponents > DesignSystem` 层级下，是设计系统的一部分，被消息渲染（MessageRendering）、权限审批 UI（PermissionUI）等上层组件广泛消费。

该系统由三个层次组成：

1. **底层渲染引擎**：`StructuredDiff.tsx` + `StructuredDiff/` 子目录，提供单个 hunk 的语法高亮渲染能力
2. **高层差异对话框**：`diff/` 子目录，提供完整的差异查看器界面（文件列表导航 + 单文件详情）
3. **工具专用视图**：`FileEditToolDiff.tsx`，为文件编辑工具提供异步加载的差异预览

## 关键流程

### 1. 结构化差异渲染流程（StructuredDiff）

这是整个系统的核心渲染路径，入口为 `StructuredDiff` 组件（`src/components/StructuredDiff.tsx:95-189`）：

1. 接收一个 `StructuredPatchHunk`（来自 `diff` 库）和文件路径、宽度等参数
2. 检查语法高亮是否启用（`settings.syntaxHighlightingDisabled` 和 `skipHighlighting` prop）
3. **优先尝试 NAPI 原生语法高亮**：调用 `renderColorDiff()` 使用 `color-diff-napi` 模块进行高性能渲染
4. **若 NAPI 不可用则降级**：渲染 `StructuredDiffFallback` 组件，使用纯 JS 实现的 word-level diff

渲染结果会被缓存在模块级 `WeakMap<StructuredPatchHunk, Map<string, CachedRender>>` 中（`src/components/StructuredDiff.tsx:41`），避免在 React 树重挂载时重复计算。缓存 key 包含 `theme|width|dim|gutterWidth|firstLine|filePath`，每个 hunk 最多保留 4 个变体（防止终端缩放时缓存膨胀）。

#### 全屏模式下的双列分割

当启用全屏模式时（`isFullscreenEnvEnabled()`），渲染结果会被 `sliceAnsi()` 切分为 gutter 列（行号+符号）和 content 列。gutter 列包裹在 `<NoSelect>` 中，使终端文本选择时只复制代码内容而不包含行号（`src/components/StructuredDiff.tsx:148-177`）。

### 2. Fallback 纯 JS 差异渲染流程

当 NAPI 模块不可用时，`StructuredDiffFallback`（`src/components/StructuredDiff/Fallback.tsx:81-119`）接管渲染：

1. **行转换**：`transformLinesToObjects()` 将 diff 行字符串解析为带类型标记（`add`/`remove`/`nochange`）的 `LineObject`（`Fallback.tsx:125-150`）
2. **相邻行配对**：`processAdjacentLines()` 将连续的 remove + add 行配对，标记 `wordDiff=true` 并互相引用 `matchedLine`（`Fallback.tsx:153-224`）
3. **行号编排**：`numberDiffLines()` 为每行分配行号（add 行递增，remove 行不递增）（`Fallback.tsx:423+`）
4. **Word-level 差异高亮**：对配对行调用 `calculateWordDiffs()`（基于 `diffWordsWithSpace`），如果变更比例 ≤ 40%（`CHANGE_THRESHOLD = 0.4`），则对变更的单词施加 `diffAddedWord`/`diffRemovedWord` 背景色（`Fallback.tsx:237-348`）
5. **渲染输出**：每行渲染为 `<Box flexDirection="row">`，包含 NoSelect 的 gutter（行号+符号）和着色的代码内容，背景色填满整个终端宽度（`Fallback.tsx:395-421`）

### 3. 差异对话框流程（DiffDialog）

`DiffDialog`（`src/components/diff/DiffDialog.tsx:55+`）是差异查看器的主界面，通常由 `/diff` 命令触发：

1. **数据源切换**：支持两种数据源——当前未提交的 git diff（`useDiffData()`）和按 turn 拆分的历史差异（`useTurnDiffs(messages)`）。用户可通过 ←/→ 切换数据源
2. **双视图模式**：`ViewMode = 'list' | 'detail'`
   - **列表模式**：渲染 `DiffFileList`，展示所有变更文件及增删行数统计
   - **详情模式**：渲染 `DiffDetailView`，展示单个文件的完整差异内容
3. **快捷键绑定**：通过 `useKeybindings` 注册 `diff:previousSource`、`diff:nextSource`、`diff:back`、`diff:viewDetails`、`diff:previousFile`、`diff:nextFile` 等操作

### 4. 文件编辑工具差异预览流程（FileEditToolDiff）

`FileEditToolDiff`（`src/components/FileEditToolDiff.tsx:23-52`）为文件编辑工具的权限审批界面提供差异预览：

1. 使用 `React.Suspense` + `use()` 实现异步加载，加载时显示 `…` 占位符
2. `loadDiffData()` 根据编辑内容计算差异（`FileEditToolDiff.tsx:106+`）：
   - **大字符串优化**：若 `old_string` ≥ `CHUNK_SIZE`，直接对比输入而不读文件
   - **单编辑优化**：使用 `scanForContext()` 流式扫描文件，只读取变更附近的上下文窗口
   - **多编辑/空字符串**：读取完整文件内容后批量替换
3. 最终通过 `StructuredDiffList` 渲染所有 hunk

## 函数签名与参数说明

### `StructuredDiff`（memo 组件）

```typescript
type Props = {
  patch: StructuredPatchHunk;   // 单个差异 hunk
  dim: boolean;                  // 是否使用暗淡色调（如非最新消息）
  filePath: string;              // 文件路径，用于语言检测和语法高亮
  firstLine: string | null;      // 文件首行，用于 shebang 检测
  fileContent?: string;          // 完整文件内容，用于多行字符串等语法上下文
  width: number;                 // 渲染宽度（终端列数）
  skipHighlighting?: boolean;    // 是否跳过语法高亮（默认 false）
}
```

> 源码位置：`src/components/StructuredDiff.tsx:11-19`

### `StructuredDiffList`

```typescript
type Props = {
  hunks: StructuredPatchHunk[];  // 多个差异 hunk
  dim: boolean;
  width: number;
  filePath: string;
  firstLine: string | null;
  fileContent?: string;
}
```

在 hunk 之间插入 `...` 省略号分隔符。

> 源码位置：`src/components/StructuredDiffList.tsx:6-13`

### `DiffDialog`

```typescript
type Props = {
  messages: Message[];           // 当前会话消息列表（用于提取 turn 差异）
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void;
}
```

> 源码位置：`src/components/diff/DiffDialog.tsx:17-22`

### `DiffDetailView`

```typescript
type Props = {
  filePath: string;
  hunks: StructuredPatchHunk[];
  isLargeFile?: boolean;         // 超过 1MB 限制
  isBinary?: boolean;            // 二进制文件
  isTruncated?: boolean;         // 超过 400 行限制
  isUntracked?: boolean;         // 未追踪的新文件
}
```

> 源码位置：`src/components/diff/DiffDetailView.tsx:11-18`

### `DiffFileList`

```typescript
type Props = {
  files: DiffFile[];             // 变更文件列表
  selectedIndex: number;         // 当前选中索引
}
```

最多显示 `MAX_VISIBLE_FILES = 5` 个文件，超出部分显示 `↑/↓ N more files` 分页提示。

> 源码位置：`src/components/diff/DiffFileList.tsx:10-13`

### `FileEditToolDiff`

```typescript
type Props = {
  file_path: string;             // 被编辑的文件路径
  edits: FileEdit[];             // 编辑操作列表（old_string → new_string）
}
```

> 源码位置：`src/components/FileEditToolDiff.tsx:14-17`

## 接口/类型定义

### `CachedRender`（StructuredDiff 内部缓存结构）

| 字段 | 类型 | 说明 |
|------|------|------|
| lines | `string[]` | NAPI 渲染输出的 ANSI 字符串行 |
| gutterWidth | `number` | gutter 列宽度（marker + 行号 + padding） |
| gutters | `string[] \| null` | 切分后的 gutter 列（全屏模式） |
| contents | `string[] \| null` | 切分后的内容列（全屏模式） |

> 源码位置：`src/components/StructuredDiff.tsx:32-40`

### `DiffLine` / `LineObject`（Fallback 内部类型）

| 字段 | 类型 | 说明 |
|------|------|------|
| code | `string` | 去掉前缀符号后的代码内容 |
| type | `'add' \| 'remove' \| 'nochange'` | 行类型 |
| i | `number` | 行号 |
| originalCode | `string` | 原始代码文本 |
| wordDiff? | `boolean` | 是否启用了 word-level diff |
| matchedLine? | `DiffLine` | 配对的增/删行 |

> 源码位置：`src/components/StructuredDiff/Fallback.tsx:48-65`

### `ViewMode`（DiffDialog 视图模式）

```typescript
type ViewMode = 'list' | 'detail'
```

### `DiffSource`（DiffDialog 数据源）

```typescript
type DiffSource = 
  | { type: 'current' }          // 当前未提交的 git diff
  | { type: 'turn'; turn: TurnDiff }  // 按对话 turn 拆分的历史差异
```

> 源码位置：`src/components/diff/DiffDialog.tsx:23-29`

## 配置项与默认值

| 配置项 | 来源 | 默认值 | 说明 |
|--------|------|--------|------|
| `syntaxHighlightingDisabled` | `useSettings()` | `false` | 全局禁用语法高亮 |
| `CLAUDE_CODE_SYNTAX_HIGHLIGHT` | 环境变量 | 启用 | 设为 falsy 值可禁用 `color-diff-napi` 模块 |
| `CHANGE_THRESHOLD` | 常量 | `0.4` | word-level diff 的变更比例阈值，超过时退化为整行差异 |
| `MAX_VISIBLE_FILES` | 常量 | `5` | DiffFileList 单页显示的最大文件数 |
| `CHUNK_SIZE` | 来自 `readEditContext` | - | FileEditToolDiff 流式扫描的阈值 |
| `CONTEXT_LINES` | 来自 `diff.js` | - | 差异上下文行数 |

## 边界 Case 与注意事项

- **极窄终端**：当 gutter 宽度 ≥ 渲染宽度时，自动跳过双列分割，退化为单列渲染。`safeWidth` 确保最小为 1（`StructuredDiff.tsx:56-60`, `Fallback.tsx:351`）
- **缓存驱逐策略**：每个 hunk 的内部缓存 Map 超过 4 个条目时会 `clear()` 全部清空。这是因为 width 作为缓存 key 的一部分，终端缩放时会积累多个宽度变体（`StructuredDiff.tsx:91`）
- **React 树重挂载**：REPL 在 ctrl+o 切换全屏时会卸载/重挂载整个消息树，模块级 `WeakMap` 缓存确保 NAPI 结果不会丢失（`StructuredDiff.tsx:21-27`）
- **二进制文件和大文件**：`DiffDetailView` 对二进制文件显示 "Binary file - cannot display diff"，大文件（>1MB）显示 "Large file - diff exceeds 1 MB limit"，截断文件在底部显示 "diff truncated (exceeded 400 line limit)"
- **未追踪文件**：显示 "New file not yet staged" 提示和 `git add` 建议
- **FileEditToolDiff 大字符串**：当 `old_string` 长度 ≥ `CHUNK_SIZE` 时跳过文件读取，直接对比输入参数，避免 O(n) 的 overlap buffer 分配（`FileEditToolDiff.tsx:113-114`）
- **Word diff 退化**：当两行的变更比例超过 40% 或处于 dim 模式时，word-level diff 退化为标准整行差异显示（`Fallback.tsx:256-258`）

## 关键代码片段

### NAPI 渲染与缓存核心逻辑

```typescript
// src/components/StructuredDiff.tsx:50-94
function renderColorDiff(patch, firstLine, filePath, fileContent, theme, width, dim, splitGutter): CachedRender | null {
  const ColorDiff = expectColorDiff();
  if (!ColorDiff) return null;
  
  const rawGutterWidth = splitGutter ? computeGutterWidth(patch) : 0;
  const gutterWidth = rawGutterWidth > 0 && rawGutterWidth < width ? rawGutterWidth : 0;
  const key = `${theme}|${width}|${dim ? 1 : 0}|${gutterWidth}|${firstLine ?? ''}|${filePath}`;
  
  let perHunk = RENDER_CACHE.get(patch);
  const hit = perHunk?.get(key);
  if (hit) return hit;
  
  const lines = new ColorDiff(patch, firstLine, filePath, fileContent).render(theme, width, dim);
  // ... gutter 分割和缓存存储
}
```

### colorDiff.ts 语法着色门控

```typescript
// src/components/StructuredDiff/colorDiff.ts:18-27
export function getColorModuleUnavailableReason(): ColorModuleUnavailableReason | null {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT)) {
    return 'env'
  }
  return null
}

export function expectColorDiff(): typeof ColorDiff | null {
  return getColorModuleUnavailableReason() === null ? ColorDiff : null
}
```

### Word-level diff 配对算法

```typescript
// src/components/StructuredDiff/Fallback.tsx:153-224
export function processAdjacentLines(lineObjects: LineObject[]): LineObject[] {
  // 扫描连续的 remove 行，然后收集紧随其后的 add 行
  // 按 min(removeCount, addCount) 配对，标记 wordDiff=true 并互设 matchedLine
  // 未配对的行保持原样（整行差异显示）
}
```