# MessageRouter（消息类型路由分发组件）

## 概述与职责

`Message.tsx` 是整个消息渲染系统的**核心路由枢纽**，位于 `TerminalUI > UIComponents > MessageRendering` 层级中。它接收一个规范化的消息对象，根据 `message.type` 将其分发到 `messages/` 目录下 30+ 种具体渲染器组件。

在架构中，`Message` 组件被上层的 `Messages.tsx`（消息列表编排）和 `VirtualMessageList`（虚拟化滚动）调用，是连接消息数据模型与视觉渲染器之间的桥梁。同级模块包括 `PermissionUI`（权限审批界面）、`DesignSystem`（设计系统原语）、`PromptInput`（用户输入区域）等。

该文件共 626 行，采用 React Compiler 运行时（`react/compiler-runtime`）进行细粒度缓存优化，导出一个经 `React.memo` 包裹的 `Message` 组件和辅助工具函数。

## 关键流程

### 顶层路由：`MessageImpl` 按 `message.type` 分发

`MessageImpl` 函数（`src/components/Message.tsx:58-355`）是核心路由入口，通过 `switch (message.type)` 将消息分发为 6 大类：

1. **`"attachment"`** → `AttachmentMessage`：渲染附件消息（图片、文件等）
2. **`"assistant"`** → 遍历 `message.message.content` 数组，每个 content block 交由 `AssistantMessageBlock` 处理
3. **`"user"`** → 先检查 `isCompactSummary` 标志，若为压缩摘要则渲染 `CompactSummary`；否则遍历 content 数组交由 `UserMessage` 处理
4. **`"system"`** → 按 `message.subtype` 细分为 `compact_boundary`、`microcompact_boundary`、`local_command`、`snip_boundary` 等子类型
5. **`"grouped_tool_use"`** → `GroupedToolUseContent`：渲染分组工具调用
6. **`"collapsed_read_search"`** → `CollapsedReadSearchContent`，外层包裹 `OffscreenFreeze` 进行性能优化

### User 消息的二级路由：`UserMessage` 按 content block 类型分发

`UserMessage` 函数（`src/components/Message.tsx:356-432`）根据 `param.type` 进一步分发：

| Content Block 类型 | 渲染器 | 说明 |
|---|---|---|
| `"text"` | `UserTextMessage` | 用户文本消息，支持 `planContent` 和时间戳 |
| `"image"` | `UserImageMessage` | 用户粘贴的图片，通过 `imagePasteIds` 追踪图片索引 |
| `"tool_result"` | `UserToolResultMessage` | 工具执行结果（成功/拒绝/取消等） |

对于 user 消息，还有一个重要逻辑：当该消息是**最新的 bash 输出**（`latestBashOutputUUID === message.uuid`）时，会用 `ExpandShellOutputProvider` 包裹内容，注入 Shell 输出展开/折叠的上下文（`src/components/Message.tsx:220-229`）。

### Assistant 消息的二级路由：`AssistantMessageBlock` 按 content block 类型分发

`AssistantMessageBlock` 函数（`src/components/Message.tsx:433-589`）处理助手消息的每个 content block：

| Content Block 类型 | 渲染器 | 说明 |
|---|---|---|
| `"tool_use"` | `AssistantToolUseMessage` | 工具调用请求 |
| `"text"` | `AssistantTextMessage` | 助手文本回复 |
| `"redacted_thinking"` | `AssistantRedactedThinkingMessage` | 脱敏的思考过程（仅 verbose/transcript 模式显示） |
| `"thinking"` | `AssistantThinkingMessage` | 思考过程，支持 `lastThinkingBlockId` 控制历史思考块的隐藏 |
| `"server_tool_use"` / `"advisor_tool_result"` | `AdvisorMessage`（若为 AdvisorBlock）| Advisor 模型的工具调用/结果 |
| ConnectorTextBlock（feature flag） | `AssistantTextMessage` | 连接器文本，仅在 `CONNECTOR_TEXT` 特性开启时生效 |

### System 消息的细分处理

System 消息的路由逻辑较为复杂（`src/components/Message.tsx:231-318`），按 `subtype` 细分：

- **`"compact_boundary"`**：渲染 `CompactBoundaryMessage`（全屏环境下返回 `null`）
- **`"microcompact_boundary"`**：直接返回 `null`（不渲染）
- **Snip 相关**（feature flag `HISTORY_SNIP`）：通过 `isSnipBoundaryMessage` / `isSnipMarkerMessage` 判断，分别渲染 `SnipBoundaryMessage` 或返回 `null`
- **`"local_command"`**：将 `message.content` 包装为 text block，用 `UserTextMessage` 渲染
- **其他**：兜底使用 `SystemTextMessage`

## 函数签名与参数说明

### `Message`（导出组件）

```typescript
export const Message = React.memo(MessageImpl, areMessagePropsEqual)
```

经 `React.memo` 包裹的核心组件，使用自定义比较函数 `areMessagePropsEqual` 控制重渲染。

#### Props 类型定义（`src/components/Message.tsx:32-57`）

| 参数 | 类型 | 说明 |
|---|---|---|
| `message` | `NormalizedUserMessage \| AssistantMessage \| AttachmentMessageType \| SystemMessage \| GroupedToolUseMessageType \| CollapsedReadSearchGroupType` | 规范化消息对象，`type` 字段决定路由分支 |
| `lookups` | `ReturnType<typeof buildMessageLookups>` | 消息查找表（包含 `resolvedToolUseIDs`、`erroredToolUseIDs` 等） |
| `containerWidth` | `number?` | 容器绝对宽度，设置后可省去调用方的包装 Box |
| `addMargin` | `boolean` | 是否添加外边距 |
| `tools` | `Tools` | 工具注册表 |
| `commands` | `Command[]` | 命令列表 |
| `verbose` | `boolean` | 详细模式（影响 thinking 块的显示） |
| `inProgressToolUseIDs` | `Set<string>` | 进行中的工具调用 ID 集合 |
| `progressMessagesForMessage` | `ProgressMessage[]` | 关联的进度消息 |
| `shouldAnimate` | `boolean` | 是否启用动画 |
| `shouldShowDot` | `boolean` | 是否显示流式输出的闪烁点 |
| `style` | `'condensed'?` | 紧凑样式 |
| `width` | `number \| string?` | 宽度 |
| `isTranscriptMode` | `boolean` | 是否为转录模式 |
| `isStatic` | `boolean` | 是否为静态消息（已完成渲染） |
| `onOpenRateLimitOptions` | `() => void?` | 打开速率限制选项的回调 |
| `isActiveCollapsedGroup` | `boolean?` | 是否为当前活跃的折叠分组 |
| `isUserContinuation` | `boolean?` | 是否为用户连续消息（默认 `false`） |
| `lastThinkingBlockId` | `string \| null?` | 最后一个 thinking block 的 ID（用于 transcript 模式隐藏历史思考） |
| `latestBashOutputUUID` | `string \| null?` | 最新 bash 输出消息的 UUID（用于自动展开） |

### `hasThinkingContent(m)`（导出函数）

```typescript
export function hasThinkingContent(m: {
  type: string;
  message?: { content: Array<{ type: string }> };
}): boolean
```

判断消息是否包含 thinking 或 redacted_thinking 内容块。仅对 `type === 'assistant'` 的消息返回 `true`（`src/components/Message.tsx:591-601`）。

### `areMessagePropsEqual(prev, next)`（导出函数）

```typescript
export function areMessagePropsEqual(prev: Props, next: Props): boolean
```

`React.memo` 的自定义比较函数（`src/components/Message.tsx:604-625`），精细控制重渲染条件。

## 性能优化机制

### React Compiler 缓存

整个文件使用 React Compiler 运行时（`react/compiler-runtime`），通过 `_c(n)` 分配缓存槽位，对每一段 JSX 输出进行细粒度的依赖追踪和缓存。例如 `MessageImpl` 使用 94 个缓存槽位（`_c(94)`），`AssistantMessageBlock` 使用 45 个（`_c(45)`）。这确保只有当相关 props 实际变化时才重新创建 JSX 元素。

### `areMessagePropsEqual` 自定义比较

这是一个经过精心设计的比较函数，避免不必要的重渲染：

1. **UUID 不变即可能跳过**：首先比较 `message.uuid`
2. **thinking 变化的定向检测**：仅当消息*实际包含* thinking 内容时，才因 `lastThinkingBlockId` 变化触发重渲染——解决了 CC-941 问题（避免所有历史消息因 thinking 流式输出而重渲染）
3. **bash 输出的局部更新**：只关心当前消息是否为"最新 bash 输出"的状态变化，而非全局 UUID 值的变化
4. **静态消息短路**：两个都是 static 的消息直接返回 `true`（不重渲染）

### `OffscreenFreeze`

`collapsed_read_search` 类型的消息被 `OffscreenFreeze` 组件包裹（`src/components/Message.tsx:340`），当消息不在可视区域时冻结渲染，减少虚拟化滚动列表中不可见消息的渲染开销。

### `ExpandShellOutputProvider` 上下文注入

仅当用户消息是最新的 bash 输出时，才注入 `ExpandShellOutputProvider`（`src/components/Message.tsx:222`），避免为所有消息创建不必要的 Context Provider。

## 依赖的渲染器组件一览

以下是 `Message.tsx` 直接引用的所有渲染器组件：

| 组件 | 导入路径 | 用途 |
|---|---|---|
| `AttachmentMessage` | `./messages/AttachmentMessage` | 附件消息 |
| `AssistantTextMessage` | `./messages/AssistantTextMessage` | 助手文本 |
| `AssistantThinkingMessage` | `./messages/AssistantThinkingMessage` | 助手思考过程 |
| `AssistantRedactedThinkingMessage` | `./messages/AssistantRedactedThinkingMessage` | 脱敏思考 |
| `AssistantToolUseMessage` | `./messages/AssistantToolUseMessage` | 工具调用请求 |
| `AdvisorMessage` | `./messages/AdvisorMessage` | Advisor 模型消息 |
| `UserTextMessage` | `./messages/UserTextMessage` | 用户文本 |
| `UserImageMessage` | `./messages/UserImageMessage` | 用户图片 |
| `UserToolResultMessage` | `./messages/UserToolResultMessage/UserToolResultMessage` | 工具结果 |
| `SystemTextMessage` | `./messages/SystemTextMessage` | 系统文本 |
| `CompactBoundaryMessage` | `./messages/CompactBoundaryMessage` | 压缩边界标记 |
| `SnipBoundaryMessage` | `./messages/SnipBoundaryMessage`（动态 require） | Snip 边界标记 |
| `GroupedToolUseContent` | `./messages/GroupedToolUseContent` | 分组工具调用 |
| `CollapsedReadSearchContent` | `./messages/CollapsedReadSearchContent` | 折叠的读取/搜索结果 |
| `CompactSummary` | `./CompactSummary` | 压缩摘要 |
| `OffscreenFreeze` | `./OffscreenFreeze` | 离屏冻结优化 |
| `ExpandShellOutputProvider` | `./shell/ExpandShellOutputContext` | Shell 输出展开上下文 |

## 边界 Case 与注意事项

- **Feature Flag 守卫**：`CONNECTOR_TEXT` 和 `HISTORY_SNIP` 两个 feature flag 通过 `bun:bundle` 的 `feature()` 函数控制。`CONNECTOR_TEXT` 在 assistant 消息路由的最前面拦截 ConnectorTextBlock；`HISTORY_SNIP` 控制 snip 边界和标记消息的处理。相关渲染器使用动态 `require()` 延迟加载
- **thinking 块仅在特定模式显示**：`redacted_thinking` 和 `thinking` 类型的 content block 在非 verbose 且非 transcript 模式下直接返回 `null`（`src/components/Message.tsx:526-527, 541-542`）
- **全屏环境下 compact_boundary 不渲染**：当 `isFullscreenEnvEnabled()` 为 `true` 时，`compact_boundary` 系统消息返回 `null`（`src/components/Message.tsx:234-236`）
- **未知 block 类型的错误处理**：`AssistantMessageBlock` 的 `default` 分支和 `server_tool_use` 非 AdvisorBlock 的情况都会调用 `logError()` 记录错误并返回 `null`，不会导致渲染崩溃（`src/components/Message.tsx:581-588`）
- **图片索引追踪**：user 消息中的图片通过 `imagePasteIds` 数组追踪每张图片的 paste ID，若 ID 不存在则回退到基于位置的自增索引（`src/components/Message.tsx:172-190`）