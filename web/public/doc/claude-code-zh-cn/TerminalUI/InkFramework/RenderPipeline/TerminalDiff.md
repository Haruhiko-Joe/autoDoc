# 终端增量更新引擎（TerminalDiff）

## 概述与职责

终端增量更新引擎是 Ink 渲染管线（RenderPipeline）的最后一环，负责将前后两帧的 Screen buffer 差异转换为最小化的终端控制序列，高效刷新终端显示。它位于 `TerminalUI → InkFramework → RenderPipeline` 层级下，与同级的 `screen.ts`（Screen buffer）、`render-node-to-output.ts`（DOM→Screen 转换）、`output.ts`（渲染操作收集）等模块协作。

核心由两个文件组成：
- **`log-update.ts`**（773 行）：`LogUpdate` 类，实现帧间 diff 算法，生成 Patch 操作序列
- **`optimizer.ts`**（93 行）：单遍后处理优化器，合并、去重、消除冗余 Patch

## 关键类型

在深入流程前，先了解核心数据类型（定义于 `src/ink/frame.ts`）：

**`Patch`** 是 diff 序列的基本单元，共 9 种类型：

| 类型 | 含义 |
|------|------|
| `stdout` | 直接输出字符内容 |
| `clear` | 清除指定行数 |
| `clearTerminal` | 全屏重置（含闪烁原因追踪） |
| `cursorHide` / `cursorShow` | 光标显隐 |
| `cursorMove` | 相对光标移动（dx, dy） |
| `cursorTo` | 绝对列定位（CHA 序列） |
| `carriageReturn` | 回车符 `\r` |
| `hyperlink` | OSC 8 超链接切换 |
| `styleStr` | 预序列化的 SGR 样式转换字符串 |

**`Diff`** 即 `Patch[]`，是一帧渲染的完整操作序列。

**`Frame`** 包含 `screen`（Screen buffer）、`viewport`（终端尺寸）、`cursor`（光标位置和可见性）、`scrollHint`（滚动优化提示）。

## 关键流程

### LogUpdate.render() — 核心 diff 主流程

这是整个引擎的核心方法（`src/ink/log-update.ts:123-467`），接收前一帧 `prev` 和当前帧 `next`，生成最小 Patch 序列。流程分为 6 个阶段：

**阶段 1：非 TTY 快速路径**

非 TTY 环境（如管道输出）不支持增量更新，直接调用 `renderFullFrame()` 逐行逐 cell 渲染完整帧内容。

**阶段 2：视口变化检测**

当终端高度缩小或宽度发生变化时，由于文本重排的不可预测性，直接触发 `fullResetSequence_CAUSES_FLICKER()` 全屏重绘（`src/ink/log-update.ts:142-147`）。

**阶段 3：DECSTBM 硬件滚动优化**

当满足三个条件——处于 alt-screen 模式、存在 `scrollHint`、`decstbmSafe` 为 true 时，利用终端硬件滚动避免全量重绘（`src/ink/log-update.ts:166-185`）：

1. 调用 `shiftRows()` 对 `prev.screen` 做模拟位移，使后续 diff 只发现新滚入的行
2. 生成 CSI 滚动区域指令：`setScrollRegion(top, bottom)` + `scrollUp/scrollDown(delta)` + `RESET_SCROLL_REGION` + `CURSOR_HOME`

`decstbmSafe` 参数由调用方控制——当终端不支持 DEC 2026（同步更新协议）时传 `false`，因为非原子执行会导致中间状态可见（滚动后、边缘行未绘制前的"垂直跳动"）。

**阶段 4：滚动回退区域检测**

这是最复杂的边界处理逻辑（`src/ink/log-update.ts:199-248`），处理内容超出视口导致部分行进入 scrollback 的场景：

- 当光标在屏幕底部（`cursorAtBottom`）且内容高度 ≥ 视口高度时，光标恢复操作会额外推 1 行进入 scrollback
- 如果 diff 发现 scrollback 区域的行有变化（`y < scrollbackRows`），由于光标无法移动到 scrollback 区域，必须触发全屏重置
- 从超出视口缩小到不超出视口时（`prevHadScrollback && nextFitsViewport && isShrinking`），同样需要全屏重置

**阶段 5：逐 cell diff 比较**

创建 `VirtualScreen` 追踪虚拟光标位置，然后通过 `diffEach()` 遍历前后帧差异（`src/ink/log-update.ts:308-381`）：

```
diffEach(prev.screen, next.screen, (x, y, removed, added) => { ... })
```

`diffEach` 使用整数 ID 快速比较 cell（利用 Screen 的 TypedArray 存储和 pool 化的 styleId/charId），避免字符串比较开销。对每个差异 cell：

- 跳过 `SpacerTail`/`SpacerHead`（宽字符占位符，终端自动处理）
- 跳过空 cell 对空 cell 的无意义覆写
- 如果差异 cell 在 scrollback 区域（`y < viewportY`），标记需要全屏重置
- 调用 `moveCursorTo()` 定位光标，使用 `transitionHyperlink()` 和 `stylePool.transition()` 生成最小样式/超链接切换
- 对于新增 cell 调用 `writeCellWithStyleStr()` 输出内容，对于删除的 cell 输出空格清除

**阶段 6：光标恢复**

diff 完成后恢复光标位置（`src/ink/log-update.ts:423-451`）：
- Alt-screen 模式：跳过（下一帧以 CSI H 重置）
- 光标在内容之后（`cursor.y >= screen.height`）：用 `\r` + `\n` 创建新行
- 其他情况：用 `moveCursorTo()` 相对移动

### 宽字符（emoji）补偿机制

`writeCellWithStyleStr()`（`src/ink/log-update.ts:638-691`）和 `needsWidthCompensation()`（`src/ink/log-update.ts:733-750`）处理终端 wcwidth 表不一致的问题：

1. 检测需要补偿的字符：Unicode 12.0+ 新 emoji（U+1FA70-U+1FBFF）和带 VS16（U+FE0F）的文本默认 emoji
2. 补偿策略：先在 `x+1` 列写一个带样式的空格作为垫底，再回到 `x` 列写 emoji，最后用 CHA 强制定位到正确列。在正确终端上 emoji 宽度为 2 自然覆盖垫底空格；在旧终端上垫底空格填补了宽度差。

### optimize() — Patch 后处理优化

`optimize()`（`src/ink/optimizer.ts:16-93`）在 diff 生成后做单遍扫描，应用 7 条优化规则：

| 规则 | 说明 |
|------|------|
| 空 stdout 移除 | `content === ''` 的输出 patch 直接跳过 |
| 零移动移除 | `cursorMove(0, 0)` 跳过 |
| 空 clear 移除 | `clear(0)` 跳过 |
| cursorMove 合并 | 连续两个 `cursorMove` 合并为 `(x1+x2, y1+y2)` |
| cursorTo 折叠 | 连续 `cursorTo` 只保留最后一个 |
| styleStr 拼接 | 连续样式转换字符串拼接（注意：不能丢弃前一个，因为 undo-codes 不保证被后者包含，如 `\e[49m` 背景重置会影响 BCE 行为） |
| hyperlink 去重 | 连续相同 URI 的超链接只保留一个 |
| cursorHide/Show 消除 | 相邻的 hide + show（或 show + hide）互相抵消 |

## 函数签名

### `LogUpdate` 类（`src/ink/log-update.ts:43`）

```typescript
class LogUpdate {
  constructor(options: { isTTY: boolean; stylePool: StylePool })
  render(prev: Frame, next: Frame, altScreen?: boolean, decstbmSafe?: boolean): Diff
  renderPreviousOutput_DEPRECATED(prevFrame: Frame): Diff
  reset(): void
}
```

- **`render(prev, next, altScreen, decstbmSafe)`**：核心方法，生成帧间 diff
  - `altScreen`：是否处于 alt-screen 模式，影响滚动优化和光标恢复策略
  - `decstbmSafe`：DECSTBM 滚动是否安全（取决于终端是否支持同步更新）
- **`reset()`**：进程从挂起恢复（SIGCONT）后调用，清空之前的输出状态
- **`renderPreviousOutput_DEPRECATED()`**：渲染完成时的收尾操作（恢复光标显示）

### `optimize(diff: Diff): Diff`（`src/ink/optimizer.ts:16`）

单遍后处理优化，返回优化后的 Patch 数组。输入长度 ≤ 1 时直接返回原数组。

## 内部辅助

### `VirtualScreen`（`src/ink/log-update.ts:752-773`）

文件内部类，追踪虚拟光标位置和已生成的 diff 序列。核心方法 `txn()` 接收一个回调函数，回调返回 `[patches, delta]` 元组——patches 被追加到 `diff` 数组，delta 用于更新虚拟光标。这种设计将"生成 patch"和"更新光标"原子化绑定，避免状态不一致。

### `moveCursorTo(screen, targetX, targetY)`（`src/ink/log-update.ts:693-721`）

使用纯相对操作移动虚拟光标。特殊处理两种情况：
- **pending wrap 状态**（`cursor.x >= viewportWidth`）：先发 `\r` 回列首再移动
- **跨行移动**：同样先发 `\r` 再移动，避免列偏移累积

### `transitionHyperlink(diff, current, target)`（`src/ink/log-update.ts:470-480`）

当超链接状态变化时推入 `hyperlink` patch。返回新的当前超链接状态。

### `fullResetSequence_CAUSES_FLICKER()`（`src/ink/log-update.ts:503-513`）

全屏重置回退：发出 `clearTerminal` patch 后从零开始渲染整帧。函数名中的 `CAUSES_FLICKER` 是有意为之的命名约定，提醒调用方此操作会导致可见闪烁。支持携带 debug 信息（触发行号、前后行内容），供上层归因闪烁来源。

## 配置项与默认值

| 配置 | 类型 | 说明 |
|------|------|------|
| `isTTY` | `boolean` | 是否为 TTY 环境，非 TTY 跳过增量更新直接全量渲染 |
| `stylePool` | `StylePool` | 样式池，提供 `transition(fromId, toId)` 零分配样式切换 |
| `altScreen` | `boolean`（默认 `false`） | 是否处于 alt-screen 模式 |
| `decstbmSafe` | `boolean`（默认 `true`） | DECSTBM 硬件滚动是否安全 |

## 边界 Case 与注意事项

- **全屏重置触发条件**：视口缩小/宽度变化、scrollback 区域有变化、shrink 跨越视口边界、需清除行数超过视口高度——这些场景都会回退到全屏重绘，产生可见闪烁
- **光标位置追踪**：整个 diff 算法使用纯相对定位（无法知道光标绝对位置），这是设计约束——终端不提供光标位置查询的同步 API
- **`writeCellWithStyleStr` 返回值必须检查**：当宽字符在视口边缘被跳过时返回 `false`，调用方不得更新 `currentStyleId`，否则虚拟样式状态与终端实际状态脱同步
- **`shiftRows` 直接修改 `prev.screen`**：DECSTBM 优化中对前一帧 screen 的原地修改是安全的，因为 prev 帧即将被丢弃
- **性能监控**：`render()` 方法内置计时，超过 50ms 会通过 `logForDebugging` 记录慢渲染事件
- **optimizer 中 styleStr 只做拼接不做丢弃**：因为样式转换是差分编码的（`diffAnsiCodes(from, to)`），前一个 patch 的 undo-codes 可能影响 BCE（Background Color Erase）行为，丢弃会导致样式泄漏