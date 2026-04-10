# 消息类型渲染器集合（MessageTypeRenderers）

## 概述与职责

消息类型渲染器集合是 Claude Code 终端 UI 中的核心展示层，位于 `src/components/messages/` 目录下，约 6000 行代码。它负责将对话中各种角色（助手、用户、系统）的消息以及工具调用结果，转化为终端中可视化的 React/Ink 组件。

在整体架构中，该模块隶属于 **TerminalUI → UIComponents → MessageRendering** 层级。上游的 `Message.tsx` 路由组件根据消息类型分发到此处 30+ 种具体渲染器，`Messages.tsx` 负责消息列表的编排（分组、折叠、虚拟滚动）。渲染器依赖 DesignSystem 提供的 `Markdown`、`HighlightedCode`、`ThemedText` 等基础展示组件，以及 Ink 框架的 `Box`、`Text`、`Link` 等原语。

同级兄弟模块包括：PermissionUI（权限审批）、DesignSystem（设计令牌）、PromptInput（输入框）、DialogCollection（对话框）等。

## 渲染器分类总览

渲染器按角色分为四大类，加上一个工具结果子系统：

| 分类 | 渲染器数量 | 核心职责 |
|------|-----------|---------|
| 助手消息 | 4 | 文本输出、思考过程、工具调用预览 |
| 用户消息 | 13+ | 用户输入、Bash 交互、命令、队友消息等 |
| 系统消息 | 4 | 错误展示、速率限制、关闭通知、通用系统消息 |
| 特殊组件 | 8 | 附件、折叠组、分组工具调用、建议、计划审批等 |
| 工具结果 | 7+1 | 成功/错误/拒绝/取消等状态的工具结果展示 |

## 关键流程

### 消息分发与渲染流程

1. `Message.tsx` 接收一条规范化消息（`NormalizedMessage`），根据 `message.type` 和 `message.role` 分发到对应渲染器
2. 每个渲染器接收 `param`（消息内容块）、`addMargin`（是否添加上边距）、`verbose`（详细模式）等通用 props
3. 渲染器内部通过 XML tag 解析（`extractTag`）、正则匹配、JSON 解析等方式提取结构化数据
4. 使用 Ink 的 `Box`/`Text` 布局，配合主题色彩系统生成终端输出

### UserTextMessage 路由分发流程

`UserTextMessage` 是用户消息的"二级路由"，它检查 `param.text` 的内容特征，依次分发到具体的子渲染器（`src/components/messages/UserTextMessage.tsx:29-200`）：

1. `NO_CONTENT_MESSAGE` → 返回 null
2. 含 `planContent` → `UserPlanMessage`
3. 含 `<tick>` 标签 → 返回 null（内部计时标记）
4. 以 `<bash-stdout`/`<bash-stderr` 开头 → `UserBashOutputMessage`
5. 以 `<local-command-stdout` 开头 → `UserLocalCommandOutputMessage`
6. 等于中断消息 → `InterruptedByUser`
7. 含 `<bash-input>` → `UserBashInputMessage`
8. 含 `<command-message>` → `UserCommandMessage`
9. 含 `<user-memory-input>` → `UserMemoryInputMessage`
10. 含 `<teammate-message` → `UserTeammateMessage`
11. 含 `<task-notification` → `UserAgentNotificationMessage`
12. 含 `<mcp-resource-update`/`<mcp-polling-update` → `UserResourceUpdateMessage`
13. 其余 → `UserPromptMessage`（普通用户输入）

### SystemTextMessage 子类型分发

`SystemTextMessage` 根据 `message.subtype` 分发到不同展示逻辑（`src/components/messages/SystemTextMessage.tsx:36-249`）：

- `turn_duration` → 回合耗时显示
- `memory_saved` → 记忆保存通知
- `away_summary` → 离开摘要
- `agents_killed` → 后台 Agent 终止通知
- `thinking` → 返回 null（由 AssistantThinkingMessage 处理）
- `bridge_status` → 远程桥接状态
- `scheduled_task_fire` → 计划任务触发
- `permission_retry` → 权限重试通知
- `api_error` → 委托给 `SystemAPIErrorMessage`
- `stop_hook_summary` → Hook 停止摘要
- 默认 → 带圆点和颜色的通用系统消息

## 助手消息渲染器

### `AssistantTextMessage`

**文件**：`src/components/messages/AssistantTextMessage.tsx`（~220 行编译产物）

核心的助手文本输出渲染器。接收 `TextBlockParam` 并通过 `Markdown` 组件流式渲染内容。

**关键逻辑**：
- 检测空消息、速率限制消息，提前返回
- 对特殊错误消息（`PROMPT_TOO_LONG`、`CREDIT_BALANCE_TOO_LOW`、`INVALID_API_KEY` 等 10+ 种）做精准匹配，展示对应的错误提示
- 以 `API_ERROR_MESSAGE_PREFIX` 开头的通用 API 错误会截断到 `MAX_API_ERROR_CHARS`（1000 字符），可通过 verbose 模式查看完整内容
- 普通文本通过 `<Markdown>` 渲染，支持 `shouldShowDot` 控制是否显示 `●` 前缀标记

```typescript
type Props = {
  param: TextBlockParam;
  addMargin: boolean;
  shouldShowDot: boolean;
  verbose: boolean;
  width?: number | string;
  onOpenRateLimitOptions?: () => void;
};
```

### `AssistantThinkingMessage`

**文件**：`src/components/messages/AssistantThinkingMessage.tsx`

展示模型的思考过程。默认折叠显示 `∴ Thinking`，用户可通过 Ctrl+O 展开。

- 接受 `ThinkingBlock | ThinkingBlockParam` 或最小形状 `{ type: 'thinking'; thinking: string }`
- `isTranscriptMode || verbose` 时展开显示完整思考内容，使用 `<Markdown dimColor>` 渲染并缩进 2 格
- `hideInTranscript` 为 true 时完全隐藏（用于转录模式中的历史思考块）

### `AssistantRedactedThinkingMessage`

**文件**：`src/components/messages/AssistantRedactedThinkingMessage.tsx`（30 行）

最简单的渲染器之一。当模型的思考内容被编辑/脱敏后，显示 `✻ Thinking…`（斜体、暗色）。仅接收 `addMargin: boolean` 一个 prop。

### `AssistantToolUseMessage`

**文件**：`src/components/messages/AssistantToolUseMessage.tsx`（~330 行编译产物）

工具调用预览渲染器，是最复杂的助手消息组件之一。

```typescript
type Props = {
  param: ToolUseBlockParam;
  addMargin: boolean;
  tools: Tools;
  commands: Command[];
  verbose: boolean;
  inProgressToolUseIDs: Set<string>;
  progressMessagesForMessage: ProgressMessage[];
  shouldAnimate: boolean;
  shouldShowDot: boolean;
  inProgressToolCallCount?: number;
  lookups: ReturnType<typeof buildMessageLookups>;
  isTranscriptMode?: boolean;
};
```

**核心流程**（`src/components/messages/AssistantToolUseMessage.tsx:35-100`）：
1. 通过 `findToolByName` 查找对应工具定义
2. 使用 `tool.inputSchema.safeParse` 验证输入参数
3. 获取 `userFacingToolName`（用户可见的工具名称）和可选的背景色
4. 检查 `isTransparentWrapper`（透明包装器工具不显示工具名称头部）
5. 通过 `tool.renderToolUseMessage` 委托工具自身渲染预览内容
6. 展示 `ToolUseLoader`（加载动画）和 `HookProgressMessage`（Hook 进度）

## 用户消息渲染器

### `UserPromptMessage`

**文件**：`src/components/messages/UserPromptMessage.tsx`（~110 行）

渲染用户在 REPL 中输入的普通文本消息。

- **性能优化**：对超长输入（如管道输入 `cat file | claude`）做截断，`MAX_DISPLAY_CHARS = 10000`，头部保留 2500 字符 + 尾部保留 2500 字符
- 使用 `HighlightedThinkingText` 组件渲染，支持思考触发位置的彩虹色高亮
- Brief 模式下使用紧凑标签布局（`You` + 时间戳）

### `UserImageMessage`

**文件**：`src/components/messages/UserImageMessage.tsx`（58 行）

渲染用户消息中的图片附件。显示为 `[Image #N]` 标签，如果终端支持超链接且图片已存储，则渲染为可点击的 `file://` 链接。

- `addMargin` 为 true 时使用 `Box marginTop`，否则使用 `MessageResponse` 样式连接到上方消息

### `UserCommandMessage`

**文件**：`src/components/messages/UserCommandMessage.tsx`（107 行）

渲染斜杠命令（如 `/commit`、`/help`）和技能调用。

- 通过 `extractTag` 从 XML 中提取命令名和参数
- 技能格式显示为 `❯ Skill(name)`
- 普通命令显示为 `❯ /command args`
- 使用 `userMessageBackground` 背景色

### `UserBashInputMessage`

**文件**：`src/components/messages/UserBashInputMessage.tsx`（57 行）

渲染用户通过 Bash 交互输入的命令。从 `<bash-input>` XML 标签提取内容，以 `! ` 前缀（`bashBorder` 颜色）+ `bashMessageBackgroundColor` 背景展示。

### `UserBashOutputMessage`

**文件**：`src/components/messages/UserBashOutputMessage.tsx`（53 行）

渲染 Bash 命令的输出结果。从 XML 提取 `<bash-stdout>` 和 `<bash-stderr>`，解包 `<persisted-output>` 标签后委托给 `BashToolResultMessage` 渲染。

### `UserChannelMessage`

**文件**：`src/components/messages/UserChannelMessage.tsx`（136 行）

渲染来自频道（Channel，如 Slack 集成）的消息。

- 使用正则解析 `<channel source="..." user="..." chat_id="...">content</channel>` 格式
- 显示格式：`↵ server · user: truncated-content`（内容截断到 60 字符）
- 插件服务器名仅显示叶子部分（`plugin:slack-channel:slack` → `slack`）

### `UserTeammateMessage`

**文件**：`src/components/messages/UserTeammateMessage.tsx`（~130 行）

渲染来自队友 Agent 的消息。解析 `<teammate-message teammate_id="..." color="..." summary="...">` XML 格式。

- 过滤掉关闭确认消息和 `teammate_terminated` 通知
- 尝试渲染为计划审批消息、关闭请求消息或任务分配消息
- 普通文本以 `TeammateMessageContent` 展示（带颜色标识的发送者名称 + chevron + 内容）

### `UserMemoryInputMessage`

**文件**：`src/components/messages/UserMemoryInputMessage.tsx`（74 行）

渲染用户的记忆保存输入。从 `<user-memory-input>` 标签提取内容。

- 显示格式：`#` 标记（`remember` 颜色）+ 记忆内容（`memoryBackgroundColor` 背景）
- 下方显示随机确认文本（从 `['Got it.', 'Good to know.', 'Noted.']` 中选取）

### `UserAgentNotificationMessage`

**文件**：`src/components/messages/UserAgentNotificationMessage.tsx`（82 行）

渲染 Agent 任务通知。从 XML 提取 `<summary>` 和 `<status>` 标签。

- 状态颜色映射：`completed` → `success`（绿色），`failed` → `error`（红色），`killed` → `warning`（黄色）
- 显示格式：`● summary`（圆点颜色随状态变化）

### `UserResourceUpdateMessage`

**文件**：`src/components/messages/UserResourceUpdateMessage.tsx`（120 行）

渲染 MCP 资源更新和轮询更新通知。

- 解析两种 XML 格式：`<mcp-resource-update>` 和 `<mcp-polling-update>`
- 每条更新显示为：`↻ server: target · reason`
- `file://` URI 仅显示文件名，其他 URI 截断到 40 字符

### `UserPlanMessage`

**文件**：`src/components/messages/UserPlanMessage.tsx`（41 行）

渲染用户的计划内容。使用圆角边框（`planMode` 颜色）包裹，标题为 "Plan to implement"（粗体），内容通过 `<Markdown>` 渲染。

### `UserLocalCommandOutputMessage`

**文件**：`src/components/messages/UserLocalCommandOutputMessage.tsx`（~80 行）

渲染本地命令的输出（如 Cloud Launch 等内部工具）。从 `<local-command-stdout>` 和 `<local-command-stderr>` 提取内容，支持钻石符号（`◇`/`◆`）前缀的特殊 CloudLaunch 格式。

## 系统消息渲染器

### `SystemTextMessage`

**文件**：`src/components/messages/SystemTextMessage.tsx`（~250 行编译产物）

最大的系统消息渲染器，处理 10+ 种 subtype。内部包含多个私有子组件：

- `TurnDurationMessage`：显示回合耗时（如 "⎿ 2.3s, 1.2k tokens"）
- `MemorySavedMessage`：显示记忆保存通知（含团队记忆支持）
- `BridgeStatusMessage`：显示远程桥接连接状态
- `StopHookSummaryMessage`：显示 stop hook 执行摘要
- `SystemTextMessageInner`：通用系统消息内部渲染（带圆点 + 颜色）

**key imports**：引入 `formatDuration`、`formatNumber`、`formatSecondsShort` 等格式化工具，`getPillLabel` 获取任务标签，`isBackgroundTask` 判断后台任务类型。

### `SystemAPIErrorMessage`

**文件**：`src/components/messages/SystemAPIErrorMessage.tsx`（~80 行可见）

渲染 API 错误消息，支持自动重试倒计时。

- 接收 `retryAttempt`、`error`、`retryInMs`、`maxRetries`
- 前 4 次重试（`retryAttempt < 4`）默认隐藏
- 使用 `useInterval` 实现倒计时动画
- 错误信息通过 `formatAPIError` 格式化，超过 1000 字符时截断

### `RateLimitMessage`

**文件**：`src/components/messages/RateLimitMessage.tsx`（~80 行可见）

渲染速率限制消息，包含倒计时和升级引导。

- `getUpsellMessage()` 根据订阅类型（Team/Enterprise/Max20x）返回不同的升级建议
- 使用 `useClaudeAiLimits` Hook 获取实时限制信息
- 支持 `/extra-usage`、`/upgrade`、`/login` 等操作引导
- 自动打开速率限制选项菜单（`shouldAutoOpenRateLimitOptionsMenu`）

### `ShutdownMessage`

**文件**：`src/components/messages/ShutdownMessage.tsx`（~80 行可见）

渲染关闭请求和关闭拒绝消息（用于多 Agent 协作场景）。

- `ShutdownRequestDisplay`：警告色边框，显示请求来源和原因
- `ShutdownRejectedDisplay`：灰色边框，显示拒绝来源、原因和提示 "Teammate is continuing to work"

## 特殊组件

### `AttachmentMessage`

**文件**：`src/components/messages/AttachmentMessage.tsx`（535 行）

附件展示的主路由组件，处理 40+ 种附件类型。通过 `attachment.type` 进行 switch 分发。

**关键附件类型处理**：
- `teammate_mailbox`：渲染团队邮箱消息（过滤不可见消息，支持任务分配、计划审批、关闭请求等子类型）
- `text`/`image`/`file`/`directory`：文件类附件展示
- `diagnostics`：诊断信息展示
- `hook_error`：Hook 错误展示

**辅助文件 `nullRenderingAttachments.ts`**：定义了 30+ 种无需可视化渲染的附件类型（如 `hook_success`、`plan_mode`、`token_usage` 等），这些类型在 `Messages.tsx` 中被过滤掉以节省渲染预算。

### `CollapsedReadSearchContent`

**文件**：`src/components/messages/CollapsedReadSearchContent.tsx`（483 行）

折叠的读取/搜索操作组渲染器。将连续的 Read/Glob/Grep 等工具调用折叠为一行摘要。

- `MIN_HINT_DISPLAY_MS = 700`：每个提示至少显示 700ms，避免快速完成的操作闪烁
- Verbose 模式下展开每个工具调用的详细信息（`VerboseToolUse` 私有组件）
- 支持团队记忆操作计数（通过 feature flag `TEAMMEM` 条件加载 `teamMemCollapsed.tsx`）
- 显示格式：`⤿ Read N files, searched M patterns`（活跃时使用进行时态，完成后使用过去时态）

### `GroupedToolUseContent`

**文件**：`src/components/messages/GroupedToolUseContent.tsx`（57 行）

分组工具调用渲染器。当同一工具连续调用多次时，委托工具自身的 `renderGroupedToolUse` 方法批量渲染。

- 构建 `toolUseId → result` 映射
- 为每个调用计算 `isResolved`、`isError`、`isInProgress` 状态
- 传递 `shouldAnimate` 控制加载动画（仅在有进行中调用时启用）

### `AdvisorMessage`

**文件**：`src/components/messages/AdvisorMessage.tsx`（~100 行可见）

渲染 Advisor 模型的建议消息。

- 对 `server_tool_use` 类型显示"Advising"标签 + 模型名称 + 输入参数
- 使用 `ToolUseLoader` 展示加载状态
- 支持 verbose 模式显示完整输入 JSON

### `PlanApprovalMessage`

**文件**：`src/components/messages/PlanApprovalMessage.tsx`（~100 行可见）

渲染计划审批消息（请求和响应）。

- `PlanApprovalRequestDisplay`：`planMode` 颜色圆角边框，显示计划内容（`Markdown` 渲染）+ 计划文件路径
- `PlanApprovalResponseDisplay`：批准用绿色 `✓ Plan Approved by X`，拒绝用红色边框 + 反馈内容
- `tryRenderPlanApprovalMessage()` 工具函数供其他组件调用

### `HookProgressMessage`

**文件**：`src/components/messages/HookProgressMessage.tsx`（~80 行可见）

渲染 Hook（PreToolUse/PostToolUse 等事件钩子）的执行进度。

- 跟踪进行中和已完成的 Hook 数量
- 转录模式下显示 "N PreToolUse hooks ran"
- 正常模式下 PreToolUse/PostToolUse 类型隐藏，其他类型显示进度

### `TaskAssignmentMessage`

**文件**：`src/components/messages/TaskAssignmentMessage.tsx`（75 行）

渲染任务分配消息（多 Agent 协作场景）。

- `TaskAssignmentDisplay`：青色边框，显示任务 ID、分配者、主题和可选描述
- `tryRenderTaskAssignmentMessage()`/`getTaskAssignmentSummary()` 工具函数

### `HighlightedThinkingText`

**文件**：`src/components/messages/HighlightedThinkingText.tsx`（~80 行可见）

渲染带高亮的用户输入文本，支持思考触发位置的彩虹色效果。

- Brief 模式：紧凑布局（`You` 标签 + 时间戳 + 文本）
- 正常模式：`❯` 指针前缀 + 文本内容
- 排队消息使用 `subtle` 颜色

### `CompactBoundaryMessage`

**文件**：`src/components/messages/CompactBoundaryMessage.tsx`（17 行）

渲染对话压缩边界标记。显示 `✻ Conversation compacted (ctrl+o for history)`，使用 `useShortcutDisplay` 获取实际快捷键文本。

## 工具结果子系统

位于 `src/components/messages/UserToolResultMessage/` 目录下。

### `UserToolResultMessage`（路由组件）

**文件**：`UserToolResultMessage/UserToolResultMessage.tsx`（~80 行可见）

工具结果的总路由。通过 `useGetToolFromMessages` Hook 查找对应工具，然后根据结果内容分发：

1. 以 `CANCEL_MESSAGE` 开头 → `UserToolCanceledMessage`
2. 以 `REJECT_MESSAGE` 开头或等于中断消息 → `UserToolRejectMessage`
3. `param.is_error` 为 true → `UserToolErrorMessage`
4. 其余 → `UserToolSuccessMessage`

### `UserToolSuccessMessage`

**文件**：`UserToolResultMessage/UserToolSuccessMessage.tsx`（~80 行可见）

渲染工具执行成功的结果。委托工具自身的 `tool.renderToolResultMessage()` 方法渲染具体内容。

- 使用 `tool.outputSchema?.safeParse` 验证结果数据格式
- 捕获分类器审批信息（`getClassifierApproval`），挂载后删除以防止内存泄漏
- 支持 `isBriefOnly` 模式和转录模式

### `UserToolErrorMessage`

**文件**：`UserToolResultMessage/UserToolErrorMessage.tsx`（~80 行可见）

渲染工具执行错误的结果。处理多种错误子类型：

1. 含中断消息 → `InterruptedByUser`
2. 以 `PLAN_REJECTION_PREFIX` 开头 → `RejectedPlanMessage`
3. 以 `REJECT_MESSAGE_WITH_REASON_PREFIX` 开头 → `RejectedToolUseMessage`
4. 分类器拒绝 → "Denied by auto mode classifier · /feedback if incorrect"
5. 其余 → 委托工具自身的 `renderToolResultMessage` 或 `FallbackToolUseErrorMessage`

### `UserToolRejectMessage`

**文件**：`UserToolResultMessage/UserToolRejectMessage.tsx`（~80 行可见）

渲染用户拒绝工具调用的结果。委托工具的 `renderToolUseRejectedMessage()` 方法，使用 `tool.inputSchema.safeParse` 验证输入，解析失败时回退到 `FallbackToolUseRejectedMessage`。

### `UserToolCanceledMessage`

**文件**：`UserToolResultMessage/UserToolCanceledMessage.tsx`（15 行）

最简单的工具结果渲染器。渲染 `<MessageResponse><InterruptedByUser /></MessageResponse>`。

### `RejectedToolUseMessage`

**文件**：`UserToolResultMessage/RejectedToolUseMessage.tsx`（15 行）

渲染 "Tool use rejected"（暗色文本，包裹在 `MessageResponse` 中）。

### `RejectedPlanMessage`

**文件**：`UserToolResultMessage/RejectedPlanMessage.tsx`（30 行）

渲染被拒绝的计划。显示 "User rejected Claude's plan:" + 圆角边框内的计划内容（`Markdown` 渲染）。

### `utils.tsx`（Hook 工具）

**文件**：`UserToolResultMessage/utils.tsx`（43 行）

提供 `useGetToolFromMessages` Hook——根据 `toolUseID` 从 `lookups.toolUseByToolUseID` 中查找工具调用参数，再通过 `findToolByName` 查找工具定义，返回 `{ tool, toolUse }` 或 null。

## 辅助模块

### `nullRenderingAttachments.ts`

定义了 30+ 种不产生可视输出的附件类型集合（`NULL_RENDERING_TYPES`）。`isNullRenderingAttachment()` 函数用于 `Messages.tsx` 在渲染前过滤这些消息，避免浪费 200 条消息的渲染预算。

TypeScript 的 `satisfies` 约束确保新增附件类型时必须在 switch 中处理或加入此列表。

### `teamMemCollapsed.tsx` / `teamMemSaved.ts`

团队记忆相关的条件加载模块（通过 `feature('TEAMMEM')` 编译时开关控制）：

- `teamMemCollapsed.tsx`：为折叠的读取/搜索组提供团队记忆操作计数展示
- `teamMemSaved.ts`：为记忆保存通知提供团队记忆计数段落

## 共通设计模式

### React Compiler 优化

所有组件均已经过 React Compiler 编译优化，使用 `_c()` 缓存数组和 `Symbol.for("react.memo_cache_sentinel")` 进行细粒度记忆化，避免不必要的重渲染。

### XML Tag 协议

用户消息大量使用 XML 标签传递结构化数据（如 `<bash-input>`、`<channel>`、`<teammate-message>` 等），渲染器通过 `extractTag()` 工具函数或正则表达式解析。

### 工具委托渲染

工具调用和工具结果的渲染大量委托给 `Tool` 接口的方法（`renderToolUseMessage`、`renderToolResultMessage`、`renderToolUseRejectedMessage`、`renderGroupedToolUse`），保持渲染逻辑与工具定义的内聚性。

### MessageResponse 连接样式

`MessageResponse` 组件提供消息间的视觉连接效果，当消息是对上一条消息的响应时使用（如图片附件跟随文本、工具结果跟随工具调用）。

### 边界 Case 与注意事项

- `UserPromptMessage` 对超长输入做头尾截断（10000 字符），防止终端渲染性能问题
- `CollapsedReadSearchContent` 设置 700ms 最小显示时间，避免快速工具调用的闪烁
- `SystemAPIErrorMessage` 默认隐藏前 4 次重试，减少视觉噪音
- `nullRenderingAttachments.ts` 过滤不可见附件以节省渲染预算（200 条消息限制）
- 恢复的转录会话中工具结果可能格式不完整，`UserToolSuccessMessage` 使用 `outputSchema.safeParse` 验证后才渲染