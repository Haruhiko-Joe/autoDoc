# ScreenBuffer — 高性能终端屏幕缓冲区

## 概述与职责

ScreenBuffer 是整个 Ink 渲染管线的**中央数据交换格式**，位于 `TerminalUI → InkFramework → RenderPipeline` 层级中。它定义了一个基于 TypedArray 的二维 cell 矩阵，每个 cell 存储字符、样式、超链接和宽度信息，并通过三大字符串池化机制（CharPool、StylePool、HyperlinkPool）将字符串操作转化为整数 ID 比对，从而在 diff、渲染等高频路径上实现零字符串分配。

在 RenderPipeline 中，`render-node-to-output.ts` 将 DOM 树写入 Screen buffer，`log-update.ts` 从 Screen buffer 读取并生成终端增量更新。Screen 是连接这两个阶段的唯一数据结构。同级模块包括 `render-node-to-output.ts`（DOM→Screen 写入）、`output.ts`（渲染操作收集）、`log-update.ts`（Screen→终端输出）等。

## 核心数据结构

### Cell 的紧凑存储布局

每个 cell 占用 **2 个 Int32**（8 字节），存储在一个连续的 `Int32Array` 中，避免为每个 cell 分配 JS 对象（对于 200×120 的屏幕，这避免了 24,000 个对象的 GC 压力）：

```
word0 (cells[ci]):     charId（完整 32 位，CharPool 索引）
word1 (cells[ci+1]):   styleId[31:17] | hyperlinkId[16:2] | width[1:0]
```

> 源码位置：`src/ink/screen.ts:332-348`

其中 `packWord1()` 函数将三个字段打包为一个 Int32：

```typescript
function packWord1(styleId: number, hyperlinkId: number, width: number): number {
  return (styleId << STYLE_SHIFT) | (hyperlinkId << HYPERLINK_SHIFT) | width
}
```

同一个 `ArrayBuffer` 同时拥有 `Int32Array` 和 `BigInt64Array` 两个视图——前者用于逐 word 读写，后者用于 `fill(0n)` 批量清零（`resetScreen`、`clearRegion`）。

### `Screen` 类型

`Screen` 扩展自 `Size`（包含 `width` 和 `height`），核心字段如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `cells` | `Int32Array` | 紧凑 cell 数组，每 cell 2 个 Int32 |
| `cells64` | `BigInt64Array` | 同一 ArrayBuffer 的 BigInt64 视图，用于批量 fill |
| `charPool` | `CharPool` | 字符池（跨 Screen 共享） |
| `hyperlinkPool` | `HyperlinkPool` | 超链接池（跨 Screen 共享） |
| `emptyStyleId` | `number` | 空样式 ID，用于比较 |
| `damage` | `Rectangle \| undefined` | 本帧写入区域的脏区包围盒 |
| `noSelect` | `Uint8Array` | 每 cell 1 字节，标记是否排除文本选区 |
| `softWrap` | `Int32Array` | 每行 1 个 Int32，标记软换行延续关系 |

> 源码位置：`src/ink/screen.ts:366-415`

### `CellWidth` 枚举

使用 `const enum` 在编译时内联，分类宽窄字符和占位符：

| 值 | 名称 | 说明 |
|----|------|------|
| 0 | `Narrow` | 普通窄字符，占 1 列 |
| 1 | `Wide` | 宽字符（CJK/emoji），占 2 列，实际字符在此 cell |
| 2 | `SpacerTail` | 宽字符的第二列占位符，不渲染 |
| 3 | `SpacerHead` | 软换行时行尾占位符，表示宽字符延续到下一行 |

> 源码位置：`src/ink/screen.ts:289-300`

## 三大字符串池化机制

### CharPool — 字符池

将字符串映射为整数 ID，所有 Screen 共享同一个 CharPool，使得 `blitRegion` 可以直接拷贝 ID（无需重新 intern），`diffEach` 可以通过整数比较替代字符串比较。

**关键优化——ASCII 快速路径**：对于单字节 ASCII 字符（charCode < 128），使用一个 128 长度的 `Int32Array` 做直接下标查找，绕过 `Map.get()` 的哈希开销。

- 索引 0 = 空格 `' '`（未写入 cell 的默认值）
- 索引 1 = 空字符串 `''`（SpacerTail 占位符）

> 源码位置：`src/ink/screen.ts:21-53`

### StylePool — SGR 样式池

将 `AnsiCode[]` 样式数组 intern 为整数 ID。**关键设计**：ID 的 bit 0 编码该样式是否对空格字符有可见效果（背景色、反色、下划线等），使渲染器可以通过单个位掩码检查跳过不可见空格。

```
实际数组索引 = id >>> 1（右移一位去掉标志位）
bit 0 = 1 → 该样式在空格上可见（有背景色/反色/下划线等）
```

核心方法：

| 方法 | 说明 |
|------|------|
| `intern(styles)` | 将样式数组 intern 为 ID，bit 0 编码可见性 |
| `get(id)` | 通过 ID 获取原始 `AnsiCode[]` |
| `transition(fromId, toId)` | 返回从一个样式过渡到另一个样式的 ANSI 字符串，结果被缓存 |
| `withInverse(baseId)` | 叠加 SGR 7 反色，用于文本选区高亮 |
| `withCurrentMatch(baseId)` | 叠加黄色背景+粗体+下划线，用于当前搜索匹配项高亮 |
| `withSelectionBg(baseId)` | 替换为选区背景色（通过 `setSelectionBg` 设置），保留前景样式 |

**`transition()` 的缓存策略**：用 `fromId * 0x100000 + toId` 作为键，首次调用时计算 diff 并序列化，后续零分配返回。

> 源码位置：`src/ink/screen.ts:112-260`

### HyperlinkPool — 超链接池

将超链接 URL 字符串 intern 为整数 ID。索引 0 表示无超链接（`intern(undefined)` 返回 0）。与 CharPool 类似的 Map 结构，但没有 ASCII 快速路径（超链接都是长字符串）。

> 源码位置：`src/ink/screen.ts:57-75`

## 关键流程 Walkthrough

### 1. 创建与重置 Screen

**`createScreen(width, height, styles, charPool, hyperlinkPool)`**：工厂函数。分配一个 `width * height * 8` 字节的 `ArrayBuffer`，创建 Int32Array 和 BigInt64Array 两个视图。`ArrayBuffer` 自动零填充，恰好对应空 cell 值（charId=0 即空格，word1=0 即无样式/无链接/窄字符）。

> 源码位置：`src/ink/screen.ts:451-492`

**`resetScreen(screen, width, height)`**：复用已有 Screen 对象。仅在新尺寸超过当前缓冲区容量时才重新分配（只增长不缩小），然后用 `cells64.fill(0n)` 批量清零。这是双缓冲渲染（front/back buffer 交替使用）的关键——避免每帧分配新 Screen。

> 源码位置：`src/ink/screen.ts:501-544`

### 2. Cell 写入流程（`setCellAt`）

`setCellAt` 是渲染管线向 Screen 写入内容的核心入口，处理了宽字符的复杂边界情况：

1. **边界检查**：超出屏幕范围直接返回
2. **清理旧的宽字符残留**：
   - 如果当前位置原来是 Wide 字符，且新写入的是 Narrow → 清除右侧的 SpacerTail
   - 如果当前位置原来是 SpacerTail，且新写入的不是 SpacerTail → 清除左侧的 orphaned Wide 字符
3. **写入 cell 数据**：intern 字符和超链接，打包为两个 Int32
4. **更新 damage 脏区**：就地扩展包围盒，避免分配新对象
5. **自动创建 SpacerTail**：如果写入 Wide 字符，在 x+1 处创建占位 cell；如果 x+1 处原来也是 Wide，级联清除其 SpacerTail

> 源码位置：`src/ink/screen.ts:693-809`

### 3. 行级 Diff 算法（`diffEach`）

`diffEach` 是增量更新的核心——比较前后两帧 Screen，仅报告发生变化的 cell。

**关键优化**：
- **damage 区域限制**：只扫描两个 Screen 的 damage 区域的并集，跳过未修改区域
- **整数比较**：由于 char/style/hyperlink 都是池化 ID，直接比较两个 Int32 即可判断 cell 是否变化
- **`findNextDiff` 跳跃扫描**：逐 cell 比较两个 word，找到第一个差异后才解包为 Cell 对象
- **对象复用**：预分配两个 Cell 对象，每次回调时覆写内容而非新建
- **宽度变化分派**：当两个 Screen 宽度相同时走 `diffSameWidth`（单步长遍历），宽度不同时走 `diffDifferentWidth`（双步长遍历）

回调签名为 `(x, y, removed, added) => boolean | void`，返回 `true` 可提前终止扫描。

> 源码位置：`src/ink/screen.ts:1156-1463`

### 4. 区域拷贝（`blitRegion`）

将源 Screen 的矩形区域批量拷贝到目标 Screen。

**快速路径**：当拷贝整行且两个 Screen 宽度相同时，使用单次 `TypedArray.set()` 拷贝整个连续内存块（cells + noSelect + softWrap）。

**慢速路径**：逐行 `subarray` + `set` 拷贝。

**宽字符边界处理**：如果拷贝区域右边缘的 cell 是 Wide 字符，其 SpacerTail 可能在区域外——额外逐行检查并补写。

> 源码位置：`src/ink/screen.ts:858-952`

### 5. 行移位（`shiftRows`）

模拟终端滚动操作：`n > 0` 向上移位（对应 CSI n S），`n < 0` 向下移位（CSI n T）。使用 `copyWithin` 就地移动数据（cells、noSelect、softWrap），然后 `fill` 清空腾出的行。当移位量超过区域高度时，直接全部清零。

> 源码位置：`src/ink/screen.ts:1057-1092`

## 其他公开 API

### Cell 读取

| 函数 | 说明 |
|------|------|
| `cellAt(screen, x, y)` | 按坐标读取 Cell，返回新对象，越界返回 `undefined` |
| `cellAtIndex(screen, index)` | 按线性索引读取 Cell，跳过边界检查 |
| `visibleCellAtIndex(...)` | 读取"可见" Cell——跳过 spacer、空白无样式空格、前景样式与前一 cell 相同的空格 |
| `charInCellAt(screen, x, y)` | 只读取字符，不解包完整 Cell |
| `isEmptyCellAt(screen, x, y)` | 判断 cell 是否为空（两个 word 都为 0） |
| `isCellEmpty(screen, cell)` | 判断 Cell 对象是否表示空 cell |

### 样式与超链接操作

| 函数 | 说明 |
|------|------|
| `setCellStyleId(screen, x, y, styleId)` | 就地替换 cell 的 styleId，不影响字符和超链接。跳过 spacer cell |
| `extractHyperlinkFromStyles(styles)` | 从 `AnsiCode[]` 中提取 OSC 8 超链接 URL |
| `filterOutHyperlinkStyles(styles)` | 过滤掉 `AnsiCode[]` 中的超链接样式，只保留 SGR |

### 区域操作

| 函数 | 说明 |
|------|------|
| `clearRegion(screen, x, y, w, h)` | 批量清空矩形区域，处理宽字符边界清理 |
| `markNoSelectRegion(screen, x, y, w, h)` | 标记矩形区域为"不可选"，用于行号、diff 符号等 gutter 区域 |
| `migrateScreenPools(screen, charPool, hyperlinkPool)` | 将 Screen 中的所有 char/hyperlink ID 重新 intern 到新的池中（O(width×height)），用于代际池重置 |

### Diff 相关

| 函数 | 说明 |
|------|------|
| `diff(prev, next)` | 返回变更数组（仅测试用） |
| `diffEach(prev, next, cb)` | 回调式 diff，零分配，生产环境使用 |

## 配置项与常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `EMPTY_CHAR_INDEX` | 0 | 空格字符在 CharPool 中的索引 |
| `SPACER_CHAR_INDEX` | 1 | 空字符串（spacer）在 CharPool 中的索引 |
| `STYLE_SHIFT` | 17 | styleId 在 word1 中的位偏移 |
| `HYPERLINK_SHIFT` | 2 | hyperlinkId 在 word1 中的位偏移 |
| `HYPERLINK_MASK` | 0x7FFF（15 位） | hyperlinkId 的位掩码 |
| `WIDTH_MASK` | 3（2 位） | CellWidth 的位掩码 |
| `EMPTY_CELL_VALUE` | `0n` | BigInt64 表示的空 cell 值 |

## 边界 Case 与注意事项

- **宽字符覆写级联**：`setCellAt` 在覆写 Wide→Narrow 或 SpacerTail→非 Spacer 时，会自动清理相邻的 orphan cell。如果 Wide 字符的 SpacerTail 位置又被另一个 Wide 字符占据，会进一步级联清除（三级联动，见 `src/ink/screen.ts:772-808`）。
- **StylePool ID 的 bit 0 语义**：`styleId` 的最低位不是数组索引的一部分，而是"空格可见性"标志。读取实际样式时必须 `id >>> 1`。这意味着 `styleId` 的值域是偶数（前景样式）和奇数（可见空格样式）交替的。
- **`visibleCellAtIndex` 的跳过逻辑**：空格 cell 如果没有超链接且样式的 bit 0 为 0（仅前景色），当其前景色与上一个已渲染 cell 相同时，直接返回 `undefined`——渲染器可以用光标前移替代实际输出，减少终端写入量。
- **`resetScreen` 只增长不缩小**：缓冲区只在新尺寸超过当前容量时才重新分配，避免终端 resize 时的频繁内存分配。
- **Pool 跨 Screen 共享**：CharPool 和 HyperlinkPool 在所有 Screen 实例间共享，因此池中的 ID 在任何 Screen 上都有效。池只增长不收缩，依赖 `migrateScreenPools` 在适当时机（如对话轮次之间）进行代际回收。
- **damage 脏区追踪**：`setCellAt` 和 `blitRegion` 会维护 damage 包围盒，但 `shiftRows` 和 `markNoSelectRegion` 不更新 damage——前者由调用方负责，后者不影响终端输出。
- **`softWrap` 的编码约定**：`softWrap[r] = N > 0` 表示第 r 行是第 r-1 行的软换行延续，且第 r-1 行的内容在绝对列 N 处结束。这个设计使得 `shiftRows` 移位后语义仍然正确——行的"是否为延续"标记跟随行数据一起移动。