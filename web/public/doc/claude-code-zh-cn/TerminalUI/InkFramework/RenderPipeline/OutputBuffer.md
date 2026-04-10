# OutputBuffer — 渲染操作收集器与 Screen 合成层

## 概述与职责

OutputBuffer 模块是 Ink 终端渲染管线（RenderPipeline）的核心合成阶段，位于 DOM 树遍历（`render-node-to-output.ts`）与终端增量更新（`log-update.ts`）之间。它的职责是：

1. **收集渲染操作**：在 DOM 树遍历过程中，各节点将自己的渲染意图以 operation 形式提交给 Output 实例
2. **合成到 Screen buffer**：在 `get()` 方法中按序执行所有操作，将最终画面写入 Screen —— 之后由 diff 算法对比前后帧，生成终端增量更新

在整体架构中，本模块属于 **TerminalUI → InkFramework → RenderPipeline** 层级。同级兄弟模块包括 `screen.ts`（Screen buffer 实现）、`render-node-to-output.ts`（DOM 遍历产生操作）、`log-update.ts`（终端增量写入）。

本模块由两个文件组成：
- **`src/ink/output.ts`**（797 行）：`Output` 类及字符处理管线
- **`src/ink/line-width-cache.ts`**（25 行）：行宽度缓存工具

---

## 关键流程

### 渲染帧的完整生命周期

```
DOM 遍历阶段                    合成阶段                    输出阶段
render-node-to-output.ts  →   Output.get()            →   log-update.ts
  ↓                              ↓                          ↓
  调用 write/blit/clip/...       按序应用所有 operation       diff(prevScreen, screen)
  收集 operation 队列            写入 Screen buffer          生成终端 ANSI 补丁
```

### `get()` 方法的两阶段执行

`get()` 是 Output 类的核心方法（`src/ink/output.ts:268-531`），将所有收集到的操作合成到 Screen buffer，分为两个阶段：

**Pass 1 — 伤害区域扩展（Damage Expansion）**

遍历所有 `clear` 操作，计算需要重新检查的屏幕区域（damage rect）。这确保 diff 算法会检查这些区域是否与前帧不同。同时收集来自绝对定位节点的 clear 区域（`absoluteClears`），供后续 blit 时排除"幽灵"残留。

**Pass 2 — 操作顺序执行**

按 operation 入队顺序依次处理六种操作类型：

1. **clip** → 将新裁剪区域与栈顶父级裁剪区域取交集后入栈
2. **unclip** → 弹出栈顶裁剪区域
3. **blit** → 从源 Screen 批量拷贝 cell（受当前 clip 约束，跳过 absoluteClears 覆盖的行）
4. **shift** → 在指定行范围内上移/下移行数据（用于纯滚动优化）
5. **write** → 最复杂的操作，进入字符处理管线（见下节）
6. **clear** → 已在 Pass 1 处理，跳过

**Post-pass — noSelect 标记**

所有 `noSelect` 操作在最后统一执行，确保标记优先级高于 blit 和 write（`src/ink/output.ts:514-520`）。

### write 操作的字符处理管线

write 是最核心的操作类型。对每个 write operation，处理流程如下：

```
原始 ANSI 文本
  ↓ split('\n') 按行拆分
  ↓ 裁剪（clip 水平/垂直方向）
  ↓ 逐行进入 writeLineToScreen()
      ↓ 查询 charCache（命中则跳过以下步骤）
      ↓ tokenize()          — ANSI 序列词法分析
      ↓ styledCharsFromTokens() — 提取带样式的字符
      ↓ styledCharsWithGraphemeClustering() — grapheme 聚簇 + 样式/超链接预计算
      ↓ reorderBidi()       — 双向文本重排
      ↓ 缓存结果到 charCache
  ↓ 逐字符 setCellAt() 写入 Screen buffer
```

> 源码位置：`src/ink/output.ts:633-797`（`writeLineToScreen` 函数）

### 裁剪栈（Clip Stack）机制

Output 维护一个 `clips` 数组作为裁剪栈，支持嵌套的 `overflow:hidden` 容器。关键设计：

- **push 时取交集**：新 clip 与栈顶 clip 通过 `intersectClip()` 取交集（`src/ink/output.ts:104-112`），子容器不可能超出父容器的裁剪范围
- **每个轴独立处理**：`undefined` 表示该方向无约束，另一侧的约束直接生效
- **空区域检测**：当 x1 ≥ x2 或 y1 ≥ y2 时区域为空，write/blit 操作被整体跳过

---

## 类型定义

### `Operation`（联合类型）

```typescript
export type Operation =
  | WriteOperation    // 写入文本到指定坐标
  | ClipOperation     // 推入裁剪区域
  | UnclipOperation   // 弹出裁剪区域
  | BlitOperation     // 从另一个 Screen 批量拷贝
  | ClearOperation    // 标记清除区域（damage only）
  | NoSelectOperation // 标记不可选中区域
  | ShiftOperation    // 行移位（滚动优化）
```

> 源码位置：`src/ink/output.ts:62-69`

### `Clip`

```typescript
export type Clip = {
  x1: number | undefined  // 左边界（含），undefined = 无约束
  x2: number | undefined  // 右边界（不含）
  y1: number | undefined  // 上边界（含）
  y2: number | undefined  // 下边界（不含）
}
```

### `ClusteredChar`（内部类型）

```typescript
type ClusteredChar = {
  value: string              // grapheme 聚簇后的字符串
  width: number              // 预计算的终端显示宽度
  styleId: number            // StylePool 中的 intern ID（可安全缓存）
  hyperlink: string | undefined  // 超链接 URL（未 intern，因 hyperlinkPool 会重置）
}
```

> 源码位置：`src/ink/output.ts:38-43`

---

## 函数签名与参数说明

### `Output` 类

#### `constructor(options: Options)`

创建 Output 实例并重置 Screen buffer。

| 参数 | 类型 | 说明 |
|------|------|------|
| `width` | `number` | 屏幕宽度（列数） |
| `height` | `number` | 屏幕高度（行数） |
| `stylePool` | `StylePool` | 样式池，用于 intern 样式 ID |
| `screen` | `Screen` | 目标 Screen buffer，支持双缓冲复用 |

#### `reset(width, height, screen): void`

复用 Output 实例用于新一帧。清零 Screen buffer 和操作队列，但**保留 charCache** 以跨帧复用。当 charCache 超过 16384 条时整体清除（`src/ink/output.ts:204`）。

#### `write(x, y, text, softWrap?): void`

提交文本写入操作。`softWrap` 数组标记哪些行是自动换行产生的（非原始换行符），用于终端文本选择时正确拼接。

#### `blit(src, x, y, width, height): void`

提交块拷贝操作（Block Image Transfer），从 `src` Screen 的对应区域拷贝 cell 数据。用于 clean subtree 优化——未变化的子树直接从 prevScreen 拷贝，跳过整个 DOM 遍历。

#### `shift(top, bottom, n): void`

提交行移位操作，在 `[top, bottom]` 范围内将行上移 `n` 行（n > 0 = 上移）。对应终端的 DECSTBM + SU/SD 滚动区域能力，与 blit 配合实现纯滚动场景的高效渲染。

#### `clear(region, fromAbsolute?): void`

提交区域清除操作。仅标记 damage 区域，不实际写入 cell（Screen 在 `resetScreen` 时已全部清零）。`fromAbsolute` 标志用于绝对定位节点的特殊处理——防止 blit 恢复绝对定位节点的陈旧内容。

#### `clip(clip: Clip)` / `unclip()`

推入/弹出裁剪区域。clip 和 unclip 必须配对使用，形成裁剪栈。

#### `noSelect(region: Rectangle): void`

标记区域为不可选中（如行号槽、diff 符号列），排除于全屏文本选择。

#### `get(): Screen`

执行所有操作，返回合成后的 Screen buffer。

### 独立函数

#### `writeLineToScreen(screen, line, x, y, screenWidth, stylePool, charCache): number`

将单行文本写入 Screen buffer 的高性能核心函数（`src/ink/output.ts:633-797`）。独立提取为顶层函数以便 JS 引擎优化（更好的寄存器分配、内联、类型反馈）。

返回值为写入结束的列位置，供调用方记录 softWrap 信息而无需重新计算行宽。

内部处理逻辑包括：
- **charCache 查询/填充**：缓存命中时直接复用 `ClusteredChar[]`，命中率极高（大部分行跨帧不变）
- **Tab 展开**：遇到 `\t`（0x09）时按 8 列制表位填充空格
- **转义序列跳过**：未被 ansi-tokenize 识别的 ESC 序列（CSI、OSC、DCS、字符集选择等）逐字符跳过
- **零宽字符跳过**：combining marks、ZWNJ、ZWS 等不占终端列宽的字符
- **宽字符末列处理**：CJK/emoji 双宽字符在最后一列放不下时，放置 SpacerHead 占位符

#### `styledCharsWithGraphemeClustering(chars, stylePool): ClusteredChar[]`

将 ansi-tokenize 产出的 `StyledChar[]` 进行 grapheme 聚簇（修复 emoji 家庭序列等被拆散的问题），并**按样式运行批量预计算** `styleId` 和 `hyperlink`——一个 80 列、3 段样式的行只做 3 次 intern 调用，而非 80 次（`src/ink/output.ts:553-584`）。

#### `intersectClip(parent, child): Clip`

计算两个 Clip 的交集。对每个轴取更紧的约束（min 取 max、max 取 min），`undefined` 视为无约束（`src/ink/output.ts:104-112`）。

---

## 缓存机制

### charCache（行级字符缓存）

- **存储位置**：`Output` 实例的 `charCache` 字段，类型为 `Map<string, ClusteredChar[]>`
- **Key**：原始 ANSI 行字符串
- **Value**：完整处理后的 `ClusteredChar[]`（tokenize + grapheme 聚簇 + bidi 重排 + 样式预计算）
- **生命周期**：跨帧保留（`reset()` 不清除），超过 16384 条时整体清除
- **安全性说明**：`styleId` 可安全缓存因为 StylePool 是 session 级别不会重置；`hyperlink` 存为原始字符串而非 intern ID，因为 hyperlinkPool 每 5 分钟重置一次

### lineWidth 缓存（`line-width-cache.ts`）

- **用途**：缓存 `stringWidth()` 的计算结果，避免流式输出中对未变行重复度量
- **存储**：模块级 `Map<string, number>`，最大 4096 条，超限时整体清除
- **接口**：`lineWidth(line: string): number`

> 源码位置：`src/ink/line-width-cache.ts:1-25`

---

## 配置项与默认值

| 配置 | 值 | 说明 |
|------|-----|------|
| charCache 上限 | 16384 | 超出后整体清除（`src/ink/output.ts:204`） |
| lineWidth 缓存上限 | 4096 | 超出后整体清除（`src/ink/line-width-cache.ts:8`） |
| Tab 宽度 | 8 列 | Tab 展开的制表位间距（`src/ink/output.ts:665`） |
| 高写入比率日志阈值 | totalCells > 1000 且 writeCells > blitCells | 触发调试日志（`src/ink/output.ts:524`） |

---

## 边界 Case 与注意事项

- **绝对定位节点的"幽灵"问题**：绝对定位节点覆盖在普通流兄弟节点之上。当绝对节点缩小时，其 clear 操作在 DOM 顺序上排在兄弟节点的 blit 之后，导致 blit 从 prevScreen 恢复了绝对节点的陈旧内容。解决方案是在 Pass 1 收集 `absoluteClears`，Pass 2 的 blit 阶段跳过这些行（`src/ink/output.ts:277-304`, `365-388`）

- **宽字符裁剪溢出**：CJK/emoji 等双宽字符在水平裁剪边界处可能导致 `sliceAnsi` 多包含一个 cell。代码通过检测宽度溢出并重新切片（`to - 1`）来修复（`src/ink/output.ts:442-445`）

- **宽字符末列换行**：双宽字符在屏幕最后一列放不下时，放置 `SpacerHead` 占位空格而非让终端自动换行，保持虚拟光标与真实光标同步（`src/ink/output.ts:773-781`）

- **嵌套 clip 交集**：子容器的 clip 必须与父容器取交集，否则 ScrollBox 底部的 `overflow:hidden` 消息可能将内容写到 ScrollBox 视口之外（`src/ink/output.ts:316-323`）

- **softWrap 裁剪连续性**：垂直裁剪切掉的首行如果是 soft-wrap 续行，仍需要记录前一行（已被裁掉）的 `contentEnd`，以确保 `screen.softWrap` 位图正确（`src/ink/output.ts:462-465`）

- **noSelect 优先级**：noSelect 标记在所有其他操作之后执行，确保即使 blit 从 prevScreen 拷贝了旧的 noSelect 状态，新的标记也能正确覆盖（`src/ink/output.ts:514-520`）

---

## 关键代码片段

### charCache 查询与填充管线

```typescript
// src/ink/output.ts:642-651
let characters = charCache.get(line)
if (!characters) {
  characters = reorderBidi(
    styledCharsWithGraphemeClustering(
      styledCharsFromTokens(tokenize(line)),
      stylePool,
    ),
  )
  charCache.set(line, characters)
}
```

未命中时执行完整管线：`tokenize → styledCharsFromTokens → grapheme 聚簇 + 样式预计算 → bidi 重排`；命中时直接进入逐字符写入循环，是跨帧性能的核心优化。

### 裁剪交集计算

```typescript
// src/ink/output.ts:104-112
function intersectClip(parent: Clip | undefined, child: Clip): Clip {
  if (!parent) return child
  return {
    x1: maxDefined(parent.x1, child.x1),
    x2: minDefined(parent.x2, child.x2),
    y1: maxDefined(parent.y1, child.y1),
    y2: minDefined(parent.y2, child.y2),
  }
}
```

每个轴独立处理，`undefined` 表示无约束。`maxDefined` 取较大的下界（更紧的左/上约束），`minDefined` 取较小的上界（更紧的右/下约束）。