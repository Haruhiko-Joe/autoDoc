# 消息列表编排与虚拟滚动

## 概述与职责

本模块由 `Messages.tsx`（833 行）和 `VirtualMessageList.tsx`（1081 行）两个文件组成，共同构成 Claude Code 终端 UI 中消息列表的核心运行时。在整体架构中，它属于 **TerminalUI → UIComponents → MessageRendering** 层级，是 REPL 主屏幕中消息展示区域的引擎。

- **Messages.tsx** 负责消息列表的高层编排——接收原始消息数组，经过规范化、过滤、重排序、分组、折叠等一系列变换后，决定最终渲染哪些消息、以什么顺序渲染，并在顶部渲染 Logo 和状态通知。
- **VirtualMessageList.tsx** 负责虚拟化滚动引擎——在全屏模式下，仅渲染视口内及附近的消息条目，实现高性能的大规模消息列表渲染，同时提供增量搜索、粘性提示（sticky prompt）、消息导航等交互能力。

同级模块包括 PermissionUI（权限审批 UI）、DesignSystem（设计系统组件）、PromptInput（用户输入区域）等。

## 关键流程

### Messages.tsx 消息处理管线

`MessagesImpl` 组件接收原始消息数组后，通过一系列 `useMemo` 阶段性地将其变换为最终的 `renderableMessages`：

1. **规范化**：调用 `normalizeMessages(messages).filter(isNotEmptyMessage)` 将原始消息拆分为逐块的标准化消息（`src/components/Messages.tsx:379`）

2. **压缩边界裁剪**：在非全屏模式下，通过 `getMessagesAfterCompactBoundary()` 过滤掉压缩点之前的历史消息；全屏模式保留全部消息以支持 ScrollBox 回滚（`src/components/Messages.tsx:496-498`）

3. **重排序与过滤**：`reorderMessagesInUI()` 调整消息的 UI 展示顺序（例如将 tool_result 放到其对应 tool_use 之后），同时过滤掉空渲染的附件消息和 progress 消息（`src/components/Messages.tsx:499-504`）

4. **Brief 模式过滤**：在 Kairos/Proactive 特性下，`filterForBriefTool()` 仅保留 Brief 工具输出和用户输入；`dropTextInBriefTurns()` 在非 brief-only 模式下去除与 Brief 输出重复的助手文本（`src/components/Messages.tsx:509-514`）

5. **分组**：`applyGrouping()` 将连续的同类工具调用合并为 `grouped_tool_use` 消息，减少视觉噪声（`src/components/Messages.tsx:519`）

6. **折叠**：依次应用四层折叠变换（`src/components/Messages.tsx:520`）：
   - `collapseReadSearchGroups()` — 将连续的读取/搜索工具调用折叠为摘要
   - `collapseTeammateShutdowns()` — 折叠队友关闭通知
   - `collapseHookSummaries()` — 合并 hook 执行摘要
   - `collapseBackgroundBashNotifications()` — 折叠后台 Bash 通知

7. **构建查找表**：`buildMessageLookups()` 构建 `toolUseByToolUseID`、`resolvedToolUseIDs` 等 Map，供后续渲染和搜索使用（`src/components/Messages.tsx:521`）

8. **渲染上限裁切**：非虚拟滚动模式下，通过 UUID 锚点机制的 `computeSliceStart()` 限制最多渲染 200 条消息，防止内存膨胀和 GC 风暴（`src/components/Messages.tsx:307-340, 541-542`）

### VirtualMessageList.tsx 虚拟化滚动

`VirtualMessageList` 组件基于 `useVirtualScroll` hook 实现窗口化渲染：

1. **增量 key 数组**：流式追加消息时，仅 push 新 key 而非重建整个数组，降低 O(n) 分配开销（`src/components/VirtualMessageList.tsx:312-323`）

2. **虚拟化渲染**：`useVirtualScroll` 返回 `[start, end]` 可见范围和 spacer 高度，仅 mount 该范围内的消息条目（`src/components/VirtualMessageList.tsx:325-337, 857-869`）

3. **稳定事件处理器**：通过 ref 存储回调 + `useCallback([])` 模式避免每帧创建 1800+ 闭包导致的 GC 压力（`src/components/VirtualMessageList.tsx:839-856`）

### 增量搜索引擎（JumpHandle）

`VirtualMessageList` 通过 `useImperativeHandle(jumpRef)` 暴露搜索接口（`src/components/VirtualMessageList.tsx:696-821`）：

1. **setSearchQuery(q)**：在所有消息上执行 `indexOf` 匹配（利用预缓存的小写文本），构建匹配索引数组 `matches[]` 和前缀和 `prefixSum[]`，找到距当前滚动位置最近的匹配消息，跳转并扫描（`src/components/VirtualMessageList.tsx:702-779`）

2. **nextMatch()/prevMatch()**：先在当前消息的多个匹配位置间移动（`screenOrd`），耗尽后推进到下一/上一匹配消息，触发 `jump()` + 两阶段 seek 效果（`src/components/VirtualMessageList.tsx:650-694`）

3. **两阶段 seek**：`jump()` 设置 `scanRequestRef` 并调用 `scrollToIndex` 触发 mount → React paint 后被动 effect 获取 DOM 元素 → `scanElement()` 扫描屏幕级匹配位置 → `highlight()` 设置高亮覆盖层（`src/components/VirtualMessageList.tsx:538-604, 609-643`）

4. **warmSearchIndex()**：分块（500 条/批）预提取所有消息的搜索文本，yield 让出线程以保持 UI 响应（`src/components/VirtualMessageList.tsx:797-816`）

5. **setAnchor()/disarmSearch()**：`setAnchor` 记录当前滚动位置作为搜索锚点（0 匹配时回弹）；`disarmSearch` 清除位置高亮但保留反向高亮（`src/components/VirtualMessageList.tsx:783-796`）

### 粘性提示（Sticky Prompt）

`StickyTracker` 是一个独立的效果组件，渲染为 null，通过细粒度滚动订阅追踪最后一条滚过视口顶部的用户提示文本（`src/components/VirtualMessageList.tsx:892-1081`）：

1. 通过 `useSyncExternalStore` 订阅 ScrollBox 的每次滚动事件（不受虚拟化量子化限制）
2. 反向遍历已挂载消息，找到视口顶部以上最近的用户提示
3. 提取提示文本的第一段落，设置到 `ScrollChromeContext` 中供 FullscreenLayout 渲染为粘性头
4. 点击粘性头时跳转到原始提示位置，支持未挂载项的两阶段修正

## 函数签名与参数说明

### `Messages`（导出组件）

`React.memo(MessagesImpl, customComparator)` — 顶层消息列表组件（`src/components/Messages.tsx:741`）

关键 Props：

| 参数 | 类型 | 说明 |
|------|------|------|
| `messages` | `MessageType[]` | 原始消息数组 |
| `tools` | `Tools` | 已注册工具列表，用于分组和搜索文本提取 |
| `verbose` | `boolean` | 是否展示详细输出 |
| `screen` | `Screen` | 当前屏幕模式（`'prompt'` / `'transcript'`） |
| `scrollRef` | `RefObject<ScrollBoxHandle>` | 全屏模式下的 ScrollBox 引用，存在时启用虚拟滚动 |
| `jumpRef` | `RefObject<JumpHandle>` | 搜索导航命令式句柄 |
| `isBriefOnly` | `boolean` | 是否仅显示 Brief 工具输出 |
| `cursor` | `MessageActionsState \| null` | 当前选中消息的游标状态 |
| `renderRange` | `[start, end]` | 分块导出时的渲染切片范围 |
| `unseenDivider` | `UnseenDivider` | 全屏模式的"N new messages"分割线 |

### `VirtualMessageList`（导出组件）

虚拟化滚动容器（`src/components/VirtualMessageList.tsx:289`）

关键 Props：

| 参数 | 类型 | 说明 |
|------|------|------|
| `messages` | `RenderableMessage[]` | 已处理的可渲染消息列表 |
| `scrollRef` | `RefObject<ScrollBoxHandle>` | ScrollBox 引用 |
| `columns` | `number` | 终端宽度，宽度变化时失效高度缓存 |
| `itemKey` | `(msg) => string` | 消息的 React key 提取函数 |
| `renderItem` | `(msg, index) => ReactNode` | 单条消息的渲染函数 |
| `extractSearchText` | `(msg) => string` | 预小写化的搜索文本提取器 |
| `trackStickyPrompt` | `boolean` | 是否启用粘性提示追踪 |

### `JumpHandle`（导出类型）

搜索导航接口（`src/components/VirtualMessageList.tsx:48-68`）：

| 方法 | 说明 |
|------|------|
| `jumpToIndex(i)` | 跳转到指定消息索引 |
| `setSearchQuery(q)` | 设置搜索关键词，立即跳转到最近匹配 |
| `nextMatch()` | 跳转到下一个匹配 |
| `prevMatch()` | 跳转到上一个匹配 |
| `setAnchor()` | 记录当前滚动位置为搜索锚点 |
| `warmSearchIndex()` | 异步预热搜索文本缓存，返回耗时 ms |
| `disarmSearch()` | 清除搜索位置高亮 |

### `filterForBriefTool(messages, briefToolNames)`

导出函数（`src/components/Messages.tsx:93-158`）。在 brief-only 模式下过滤消息，仅保留 Brief 工具调用块、其 tool_result、真实用户输入和系统消息（排除 `api_metrics`）。

### `dropTextInBriefTurns(messages, briefToolNames)`

导出函数（`src/components/Messages.tsx:169-205`）。在非 brief-only 模式下，按轮次检测是否调用了 Brief 工具，若是则删除该轮次的助手文本块（避免与 Brief 输出重复）。

### `computeSliceStart(collapsed, anchorRef, cap?, step?)`

导出函数（`src/components/Messages.tsx:315-340`）。计算非虚拟化模式下的渲染起始索引。使用 UUID 锚点而非计数，避免消息折叠/压缩导致的索引跳变。

### `shouldRenderStatically(message, ...)`

导出函数（`src/components/Messages.tsx:779-833`）。判断消息是否可以静态渲染（不需要动态更新），用于优化 Ink 渲染性能。转录模式下全部静态；提示模式下根据工具执行状态、hook 解析状态等判断。

## 类型定义

### `StickyPrompt`

```typescript
export type StickyPrompt = {
  text: string;       // 粘性提示的显示文本
  scrollTo: () => void; // 点击后跳转到原始提示位置
} | 'clicked';         // 点击后的瞬态状态，隐藏头部但保持填充折叠
```

> 源码位置：`src/components/VirtualMessageList.tsx:32-39`

### `SliceAnchor`

```typescript
export type SliceAnchor = {
  uuid: string;  // 锚定消息的 UUID
  idx: number;   // 锚定消息的索引（UUID 丢失时的 fallback）
} | null;
```

> 源码位置：`src/components/Messages.tsx:309-312`

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|------|------|
| `MAX_MESSAGES_WITHOUT_VIRTUALIZATION` | 200 | 非虚拟化模式的最大渲染消息数 |
| `MESSAGE_CAP_STEP` | 50 | 渲染上限推进的步长 |
| `MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE` | 30 | 转录模式默认显示的消息数 |
| `HEADROOM` | 3 | scrollTo 目标上方的留白行数 |
| `STICKY_TEXT_CAP` | 500 | 粘性提示文本的最大字符数 |

环境变量：
- `CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL`：设为 truthy 值可禁用虚拟滚动

## 边界 Case 与注意事项

### 性能优化设计

- **React Compiler 缓存**：两个文件都使用 `react/compiler-runtime` 的 `_c()` 缓存槽位，减少不必要的重新计算。`LogoHeader` 通过 `React.memo` + `OffscreenFreeze` 防止 2800+ 消息会话中每帧 150K+ 写入（`src/components/Messages.tsx:47-76`）

- **消息处理与渲染分离**：`collapsed` 计算和 `renderableMessages` 切片分为两个 `useMemo`，避免滚动时重新运行 O(n) 的 Map 构建（27k 消息场景下从 ~50ms/scroll 降至接近 0）（`src/components/Messages.tsx:476-543`）

- **GC 压力控制**：`VirtualItem` 的事件处理器通过 ref 稳定化，将快速滚动时每秒 1800 个短命闭包降至接近 0（`src/components/VirtualMessageList.tsx:184-196`）

### UUID 锚点机制

非虚拟化渲染上限使用 UUID 锚点而非索引切片，原因是：count-based slicing 在每次 append 时移位导致全终端重置（CC-941）；即使量化到 50 步，压缩和折叠重分组也会改变 `collapsed.length`（CC-1174）。锚点同时存储 uuid 和 idx，当 uuid 因 hook 摘要合并而消失时，fallback 到 idx 避免重置为 0（`src/components/Messages.tsx:288-340`）。

### 搜索的"幻影"消息处理

搜索引擎（indexOf）与渲染扫描（scanElement）之间可能存在不一致——引擎匹配但渲染层找不到匹配位置的"幻影"消息。两阶段 seek 效果中，幻影消息会自动跳过（`step()` 前进到下一个匹配），并通过 `phantomBurstRef` 防止无限循环（20 次后停止）（`src/components/VirtualMessageList.tsx:586-593`）。

### 自定义 memo 比较器

`Messages` 组件使用自定义比较器，跳过稳定的回调 props（`onOpenRateLimitOptions`、`scrollRef` 等），对 `streamingToolUses` 按 `contentBlock` 引用比较而非数组引用，对 `inProgressToolUseIDs` 使用集合相等比较，避免流式更新期间的无效重渲染（`src/components/Messages.tsx:741-778`）。

### 粘性提示的 1 行间隙

用户提示的 Box 有 `marginTop=1`，导致 Box.top 已滚过视口但 `❯` 提示符仍可见的 1 行间隙。`StickyTracker` 通过 `top + 1 >= target` 检查跳过这种情况，避免重复显示（`src/components/VirtualMessageList.tsx:950-958`）。