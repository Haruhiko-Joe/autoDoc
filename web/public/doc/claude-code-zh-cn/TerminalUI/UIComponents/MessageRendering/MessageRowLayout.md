# 单条消息布局与元信息显示（MessageRowLayout）

## 概述与职责

MessageRowLayout 模块负责**单条消息的外层布局编排**，处理时间戳、模型标签等元信息的显示，以及消息渲染的静态/动态判断和性能优化。它位于 TerminalUI → UIComponents → MessageRendering 层级下，是消息渲染系统中连接消息列表（`Messages.tsx`）和具体消息内容（`Message.tsx`）的中间布局层。

该模块由 4 个文件组成：
- **`MessageRow.tsx`**：核心布局组件，决定单条消息的展示形态（是否有元信息行、是否静态渲染、是否显示动画）
- **`MessageTimestamp.tsx`**：格式化并渲染消息时间戳
- **`MessageModel.tsx`**：显示生成消息的 AI 模型标签
- **`MessageResponse.tsx`**：封装助手响应的缩进容器，渲染 `⎿` 缩进符号

同级模块包括 PermissionUI（权限审批）、DesignSystem（设计系统）、PromptInput（输入区域）等。

---

## 关键流程

### MessageRow 渲染流程

`MessageRow` 是一个 `React.memo` 包装的组件（`src/components/MessageRow.tsx:382`），内部实现为 `MessageRowImpl`。核心渲染逻辑如下：

1. **判断消息类型**：区分普通消息、`grouped_tool_use`（分组工具调用）、`collapsed_read_search`（折叠的读取/搜索组）三种情况（`MessageRow.tsx:114-115`）

2. **计算折叠组活跃状态**：对于 `collapsed_read_search` 类型，检查是否有工具仍在执行或查询仍在加载且后续无其他内容（`MessageRow.tsx:118`）：
   ```
   isActiveCollapsedGroup = isCollapsed && (hasAnyToolInProgress(msg, inProgressToolUseIDs) || isLoading && !hasContentAfter)
   ```

3. **提取展示消息**：分组消息使用 `displayMessage`，折叠消息通过 `getDisplayMessageFromCollapsed()` 获取，普通消息直接使用（`MessageRow.tsx:131`）

4. **判断静态渲染**：调用 `shouldRenderStatically()` 决定消息是否可以静态渲染（不再变化），这影响是否启用 `OffscreenFreeze` 优化（`MessageRow.tsx:155`）

5. **判断是否需要动画**：根据消息类型和 `inProgressToolUseIDs` 决定 `shouldAnimate`（`MessageRow.tsx:168-218`）

6. **元信息显示判断**：仅在 transcript 模式下、助手消息含文本内容、且有时间戳或模型信息时显示元信息行（`MessageRow.tsx:221`）

7. **布局组装**：
   - **无元信息**：直接渲染 `<Message>` 并包裹 `<OffscreenFreeze>`（`MessageRow.tsx:256-265`）
   - **有元信息**：在消息上方添加右对齐的时间戳+模型标签行，整体限定 `columns` 宽度（`MessageRow.tsx:267-286`）

### hasContentAfterIndex 前向扫描

`hasContentAfterIndex`（`MessageRow.tsx:50-92`）从当前消息位置向后扫描，判断是否存在"真正的内容"。该函数的设计目的是避免将完整的 `renderableMessages` 数组传入每个 MessageRow——这会被 React Compiler 固定在 fiber 的 memoCache 中，在 7 轮对话后累积约 1-2MB 内存。

扫描时跳过以下类型：
- `thinking` / `redacted_thinking` 内容块
- 可折叠的 `tool_use`（通过 `getToolSearchOrReadInfo` 判断）
- 正在流式传输的工具调用（`streamingToolUseIDs`）
- `system` 和 `attachment` 消息
- `tool_result` 类型的用户消息
- 可折叠的 `grouped_tool_use` 消息

### areMessageRowPropsEqual 记忆化比较

自定义的 `React.memo` 比较函数（`MessageRow.tsx:342-381`），采用**保守策略**——仅在确定消息不会变化时跳过重渲染：

- 消息引用变化 → 重渲染
- 屏幕模式变化 → 重渲染
- `verbose` 切换 → 重渲染（影响 thinking block 可见性）
- `collapsed_read_search` 在非 transcript 模式永远重渲染
- 终端宽度变化 → 重渲染
- Bash 输出 UUID 匹配状态变化 → 重渲染（影响完整/截断输出）
- `lastThinkingBlockId` 变化且消息含 thinking 内容 → 重渲染
- 消息仍在流式传输或工具未解析 → 重渲染
- 以上均不满足 → 跳过重渲染

---

## 函数签名与参数说明

### `MessageRow`（导出组件）

```typescript
export const MessageRow = React.memo(MessageRowImpl, areMessageRowPropsEqual)
```

Props 类型定义（`MessageRow.tsx:15-38`）：

| 参数 | 类型 | 说明 |
|------|------|------|
| `message` | `RenderableMessage` | 当前消息对象 |
| `isUserContinuation` | `boolean` | 上一条消息是否也是用户消息 |
| `hasContentAfter` | `boolean` | 后续是否有非可跳过内容（仅对 collapsed 组有意义） |
| `tools` | `Tools` | 工具注册表 |
| `commands` | `Command[]` | 命令列表 |
| `verbose` | `boolean` | 是否显示详细信息 |
| `inProgressToolUseIDs` | `Set<string>` | 正在执行的工具 ID 集合 |
| `streamingToolUseIDs` | `Set<string>` | 正在流式传输的工具 ID 集合 |
| `screen` | `Screen` | 当前屏幕模式（如 `"transcript"`） |
| `canAnimate` | `boolean` | 是否允许动画 |
| `onOpenRateLimitOptions` | `() => void` | 打开速率限制选项的回调（可选） |
| `lastThinkingBlockId` | `string \| null` | 最新 thinking block 的 ID |
| `latestBashOutputUUID` | `string \| null` | 最新 Bash 输出的 UUID |
| `columns` | `number` | 终端列宽 |
| `isLoading` | `boolean` | 查询是否仍在加载 |
| `lookups` | `ReturnType<typeof buildMessageLookups>` | 消息查找表（进度消息、兄弟工具等） |

### `hasContentAfterIndex(messages, index, tools, streamingToolUseIDs): boolean`

> 源码位置：`src/components/MessageRow.tsx:50-92`

从 `index+1` 向后扫描，判断后续是否有实质内容。由 `Messages.tsx` 预计算并作为 `hasContentAfter` prop 传入，避免内存泄漏。

### `isMessageStreaming(msg, streamingToolUseIDs): boolean`

> 源码位置：`src/components/MessageRow.tsx:296-309`

判断消息是否仍在流式传输。分别处理 `grouped_tool_use`、`collapsed_read_search` 和普通消息三种情况。

### `allToolsResolved(msg, resolvedToolUseIDs): boolean`

> 源码位置：`src/components/MessageRow.tsx:315-334`

判断消息中的所有工具调用是否已完成。处理 `grouped_tool_use`、`collapsed_read_search`、`server_tool_use` 和普通工具调用。

### `MessageTimestamp({ message, isTranscriptMode })`

> 源码位置：`src/components/MessageTimestamp.tsx:10-59`

仅在 transcript 模式下、助手消息含文本内容且有时间戳时渲染。格式化为 12 小时制（`HH:MM AM/PM`），使用 `dimColor` 样式，`Box` 的 `minWidth` 设置为格式化字符串的视觉宽度。

### `MessageModel({ message, isTranscriptMode })`

> 源码位置：`src/components/MessageModel.tsx:10-39`

仅在 transcript 模式下、助手消息含文本内容且有 `model` 字段时渲染。`minWidth` 为模型名宽度 + 8，使用 `dimColor` 样式。

### `MessageResponse({ children, height? })`

> 源码位置：`src/components/MessageResponse.tsx:10-57`

封装助手响应的缩进容器。渲染 `⎿` 缩进前缀符号，内容区域使用 `flexGrow=1`。

---

## 接口/类型定义

### `RenderableMessage`

消息组件消费的规范化消息类型（从 `../types/message.js` 导入），可以是普通消息、`grouped_tool_use`（分组工具调用）或 `collapsed_read_search`（折叠的读取/搜索组）。

### `MessageResponseContext`

> 源码位置：`src/components/MessageResponse.tsx:62`

内部 React Context（`React.createContext(false)`），用于检测嵌套的 `MessageResponse`。当已处于 `MessageResponse` 内部时，子级 `MessageResponse` 直接返回 `children`，避免渲染嵌套的 `⎿` 符号。

---

## 边界 Case 与注意事项

1. **Transcript 模式专属元信息**：时间戳和模型标签仅在 `screen === "transcript"` 时显示。在普通 REPL 模式下，元信息行不会渲染，消息直接使用终端全宽。

2. **内存优化设计**：`hasContentAfterIndex` 被设计为在 `Messages.tsx` 层预计算并传递布尔值，而非将完整消息数组传入 MessageRow。注释明确说明这是为了避免 React Compiler 将数组固定在 memoCache 中导致的内存累积问题。

3. **折叠组的流式状态判断**：`collapsed_read_search` 类型在非 transcript 模式下永远被视为需要重渲染（`areMessageRowPropsEqual` 中返回 `false`），因为其内容可能随时变化。

4. **嵌套 MessageResponse 去重**：`MessageResponse` 通过 Context 检测嵌套，避免在已有 `⎿` 前缀的子树中重复渲染缩进符号。

5. **Ratchet 锁定**：当 `height` 未指定时，`MessageResponse` 使用 `<Ratchet lock="offscreen">` 包裹内容，防止离屏内容在尺寸变化时产生布局抖动。

6. **OffscreenFreeze 优化**：所有消息都被 `<OffscreenFreeze>` 包裹，配合 `areMessageRowPropsEqual` 的保守比较策略，确保静态消息不会被不必要地重渲染。

7. **shouldAnimate 的三路判断**：动画状态根据消息类型不同有不同的判断逻辑——分组消息检查任意子消息是否在执行，折叠组检查 `hasAnyToolInProgress`，普通消息检查单个 `toolUseID`。