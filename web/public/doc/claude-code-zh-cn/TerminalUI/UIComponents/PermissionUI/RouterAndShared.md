# 权限请求路由与共享基础设施

## 概述与职责

本模块是 Claude Code 权限 UI 系统的**路由层和共享基础设施层**，位于 `TerminalUI > UIComponents > PermissionUI` 层级下。它解决的核心问题是：当 AI 助手需要执行敏感操作（执行 Shell 命令、编辑文件、访问网络等）时，如何向用户展示清晰的权限审批界面。

模块由两部分组成：
1. **路由层**：`PermissionRequest.tsx` 作为总入口，根据工具类型将权限请求分发到 15+ 种专用审批组件
2. **共享层**：提供所有权限审批组件复用的通用 UI 容器、交互控件、解释说明、调试信息和分析日志

同级模块包括 `MessageRendering`（消息渲染）、`DesignSystem`（设计系统）、`PromptInput`（输入区域）等，本模块依赖 `DesignSystem` 的 `Dialog`、`ThemedText` 等基础组件构建权限界面。

## 关键流程

### 权限请求路由分发流程

1. REPL 主屏幕检测到工具需要用户审批时，渲染 `PermissionRequest` 组件，传入 `ToolUseConfirm` 对象
2. `PermissionRequest` 注册 `app:interrupt` 快捷键（Ctrl+C），允许用户随时拒绝请求（`PermissionRequest.tsx:180`）
3. 调用 `useNotifyAfterTimeout` 发送系统通知，提醒用户有待审批的权限请求（`PermissionRequest.tsx:190`）
4. 核心路由函数 `permissionComponentForTool()` 根据 `tool` 引用进行 switch 匹配，返回对应的专用权限组件（`PermissionRequest.tsx:48-82`）
5. 渲染匹配到的 `PermissionComponent`，传入 `toolUseConfirm`、`workerBadge`、`setStickyFooter` 等 props

路由映射关系如下：

| 工具 | 权限组件 |
|------|----------|
| `FileEditTool` | `FileEditPermissionRequest` |
| `FileWriteTool` | `FileWritePermissionRequest` |
| `BashTool` | `BashPermissionRequest` |
| `PowerShellTool` | `PowerShellPermissionRequest` |
| `WebFetchTool` | `WebFetchPermissionRequest` |
| `NotebookEditTool` | `NotebookEditPermissionRequest` |
| `ExitPlanModeV2Tool` | `ExitPlanModePermissionRequest` |
| `EnterPlanModeTool` | `EnterPlanModePermissionRequest` |
| `SkillTool` | `SkillPermissionRequest` |
| `AskUserQuestionTool` | `AskUserQuestionPermissionRequest` |
| `GlobTool` / `GrepTool` / `FileReadTool` | `FilesystemPermissionRequest` |
| `ReviewArtifactTool`* | `ReviewArtifactPermissionRequest` |
| `WorkflowTool`* | `WorkflowPermissionRequest` |
| `MonitorTool`* | `MonitorPermissionRequest` |
| 其他所有工具 | `FallbackPermissionRequest` |

> 带 * 号的工具通过 feature flag（`bun:bundle`）条件加载，未启用时回退到 `FallbackPermissionRequest`

### 用户审批交互流程（PermissionPrompt）

1. 各专用权限组件将操作选项组装为 `PermissionPromptOption[]` 传给 `PermissionPrompt`
2. `PermissionPrompt` 将选项转换为 `Select` 组件的格式，渲染选项列表（`PermissionPrompt.tsx:84-135`）
3. 支持**反馈输入模式**：用户按 Tab 键可展开文本输入框，附加反馈信息（如"告诉 Claude 该怎么做"）
4. 反馈分为 `accept`（接受时的补充指令）和 `reject`（拒绝时的改进建议）两种类型
5. 用户选择后调用 `onSelect(value, feedback)` 回调，将结果传回专用权限组件处理
6. 所有反馈交互操作会触发分析事件（`tengu_accept_feedback_mode_entered` 等）

### 权限日志与分析流程

`usePermissionRequestLogging` hook（`hooks.ts:101-209`）在权限弹窗显示时触发：

1. 使用 `useRef` 防护同一 `toolUseID` 的重复日志（防止无限微任务循环，见 `hooks.ts:106-113` 的详细注释）
2. 递增 `AppState.attribution.permissionPromptCount` 用于归因追踪
3. 发送 `tengu_tool_use_show_permission_request` 分析事件
4. [内部用户专用] 对 Bash 工具的权限请求做额外的命令解析和详细日志
5. 发送 unary 事件用于统计

## 函数签名与参数说明

### `PermissionRequest(props: PermissionRequestProps)`

权限请求总路由组件。

| 参数 | 类型 | 说明 |
|------|------|------|
| `toolUseConfirm` | `ToolUseConfirm` | 包含工具、输入、权限决策等完整上下文 |
| `toolUseContext` | `ToolUseContext` | 工具执行上下文 |
| `onDone` | `() => void` | 权限交互完成回调 |
| `onReject` | `() => void` | 拒绝回调 |
| `verbose` | `boolean` | 是否显示详细信息 |
| `workerBadge` | `WorkerBadgeProps \| undefined` | Worker/队友徽章信息 |
| `setStickyFooter` | `(jsx \| null) => void` | 全屏模式下注册粘性底部区域 |

> 源码位置：`PermissionRequest.tsx:83-127`

### `PermissionDialog(props: Props)`

通用权限对话框容器，为所有权限请求提供统一的视觉外壳。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `title` | `string` | - | 对话框标题 |
| `subtitle` | `ReactNode` | - | 副标题（字符串时自动截断显示） |
| `color` | `keyof Theme` | `"permission"` | 边框颜色 |
| `titleColor` | `keyof Theme` | - | 标题文字颜色 |
| `innerPaddingX` | `number` | `1` | 内容区水平内边距 |
| `workerBadge` | `WorkerBadgeProps` | - | Worker 徽章 |
| `titleRight` | `ReactNode` | - | 标题栏右侧内容 |
| `children` | `ReactNode` | - | 对话框内容 |

渲染结构：顶部圆角边框 → 标题栏（含 Worker 徽章）→ 内容区域。仅显示**顶部边框**（左、右、底部边框关闭），视觉上是分隔线效果。

> 源码位置：`PermissionDialog.tsx:7-16`

### `PermissionPrompt<T>(props: PermissionPromptProps<T>)`

带反馈输入功能的操作选项选择器。

| 参数 | 类型 | 说明 |
|------|------|------|
| `options` | `PermissionPromptOption<T>[]` | 选项列表，每项可配置反馈输入 |
| `onSelect` | `(value: T, feedback?: string) => void` | 选择回调 |
| `onCancel` | `() => void` | 取消回调 |
| `question` | `string \| ReactNode` | 提示问题，默认 `"Do you want to proceed?"` |
| `toolAnalyticsContext` | `ToolAnalyticsContext` | 分析上下文 |

> 源码位置：`PermissionPrompt.tsx:23-29`

### `usePermissionRequestLogging(toolUseConfirm, unaryEvent): void`

权限请求日志 hook，在弹窗显示时自动记录分析事件。

> 源码位置：`hooks.ts:101-209`

### `logUnaryPermissionEvent(completion_type, toolUseConfirm, event, hasFeedback?): void`

工具函数，用于在用户接受/拒绝权限时发送 unary 事件。

> 源码位置：`utils.ts:5-25`

## 接口/类型定义

### `ToolUseConfirm<Input>`

权限请求的核心数据结构，贯穿整个权限 UI 系统（`PermissionRequest.tsx:103-127`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `assistantMessage` | `AssistantMessage` | 触发工具调用的助手消息 |
| `tool` | `Tool<Input>` | 工具定义 |
| `description` | `string` | 工具操作描述 |
| `input` | `z.infer<Input>` | 工具输入参数 |
| `toolUseID` | `string` | 唯一标识 |
| `permissionResult` | `PermissionDecision` | 权限决策结果（ask/deny/passthrough） |
| `classifierCheckInProgress` | `boolean` | 分类器是否正在异步检查 |
| `classifierAutoApproved` | `boolean` | 是否被分类器自动批准 |
| `onUserInteraction` | `() => void` | 用户交互回调（阻止分类器自动批准） |
| `onAllow` | `(input, updates, feedback?, contentBlocks?) => void` | 批准回调 |
| `onReject` | `(feedback?, contentBlocks?) => void` | 拒绝回调 |
| `recheckPermission` | `() => Promise<void>` | 重新检查权限 |

### `PermissionRequestProps<Input>`

所有专用权限组件的统一 Props 接口（`PermissionRequest.tsx:83-102`）。

### `PermissionPromptOption<T>`

操作选项定义（`PermissionPrompt.tsx:10-18`）：

```typescript
type PermissionPromptOption<T extends string> = {
  value: T
  label: ReactNode
  feedbackConfig?: {
    type: FeedbackType  // 'accept' | 'reject'
    placeholder?: string
  }
  keybinding?: KeybindingAction
}
```

### `WorkerBadgeProps`

Worker 徽章属性（`WorkerBadge.tsx:6-9`）：

```typescript
type WorkerBadgeProps = {
  name: string   // Worker 名称
  color: string  // 颜色标识
}
```

### `SandboxPermissionRequestProps`

沙盒网络权限请求属性（`SandboxPermissionRequest.tsx:8-13`）：

```typescript
type SandboxPermissionRequestProps = {
  hostPattern: NetworkHostPattern
  onUserResponse: (response: {
    allow: boolean
    persistToSettings: boolean
  }) => void
}
```

## 各组件职责说明

### PermissionRequestTitle

标题栏组件，渲染粗体彩色标题 + 可选的 Worker 徽章（`· @workerName` 格式）+ 可选的副标题。副标题为字符串时使用 `truncate-start` 策略截断（保留路径末尾）。

> 源码位置：`PermissionRequestTitle.tsx:12-65`

### PermissionExplanation

权限解释组件，通过 `Ctrl+E` 快捷键触发（`confirm:toggleExplanation`）。调用 `generatePermissionExplanation()` API 获取操作风险评估，展示：
- 风险等级标签（Low/Med/High，分别用 success/warning/error 颜色）
- 详细解释文本
- 推理过程

使用 React 19 的 `use()` + `Suspense` 实现懒加载，配合 `ShimmerLoadingText` 闪烁动画作为加载状态。

> 源码位置：`PermissionExplanation.tsx:72-147`

### PermissionRuleExplanation

权限规则解释组件，向用户展示**为什么**当前操作需要权限确认。根据 `PermissionDecisionReason` 类型生成不同的解释文本：
- `rule`：显示匹配的权限规则和配置来源
- `hook`：显示触发的 Hook 名称和原因
- `classifier`：显示分类器名称和判断原因
- `safetyCheck` / `other` / `workingDir`：显示原因文本

当在自动模式下被 Hook 阻止时，使用 `warning` 颜色突出显示。

> 源码位置：`PermissionRuleExplanation.tsx:21-67`

### PermissionDecisionDebugInfo

调试信息组件，以结构化格式展示权限决策的完整上下文，包括：
- **Behavior**：allow / ask / deny / passthrough
- **Message**：权限消息（非 allow 时显示）
- **Reason**：决策原因（支持递归展示子命令结果，每个子命令显示 ✓/✗ 图标）
- **Suggestions**：建议的权限规则、目录、模式
- **Unreachable Rules**：检测并警告被遮蔽的无效规则

通过 `SuggestionDisplay` 子组件渲染建议规则/目录/模式，通过 `detectUnreachableRules()` 检测可能永远不会匹配的权限规则。

> 源码位置：`PermissionDecisionDebugInfo.tsx:342-422`

### FallbackPermissionRequest

通用回退权限请求组件，当工具没有专用权限组件时使用。提供三个选项：
- **Yes**：允许执行（支持反馈输入）
- **Yes, and don't ask again**：允许并添加永久规则（条件显示，依赖 `shouldShowAlwaysAllowOptions()`）
- **No**：拒绝执行（支持反馈输入）

展示工具的 `userFacingName`，使用 `PermissionDialog` 容器和 `PermissionRuleExplanation` 说明原因。对工具输入做 JSON 序列化展示（最多 20 行截断）。

> 源码位置：`FallbackPermissionRequest.tsx:16-200`

### SandboxPermissionRequest

沙盒网络权限请求组件，当沙盒环境中的程序尝试访问外部网络时弹出。显示目标主机名，提供三个选项：
- **Yes**：本次允许
- **Yes, and don't ask again for {host}**：允许并持久化（托管沙盒模式下隐藏）
- **No**：拒绝连接

触发 `tengu_sandbox_permission_request_response` 分析事件。

> 源码位置：`SandboxPermissionRequest.tsx:15-150`

### WorkerBadge

彩色圆点 + Worker 名称的徽章组件，格式为 `● @workerName`，用于标识 Swarm 模式下哪个 Worker 发起了权限请求。使用 `toInkColor()` 将颜色字符串转换为 Ink 兼容格式。

> 源码位置：`WorkerBadge.tsx:15-48`

### WorkerPendingPermission

Worker 等待审批指示器，在 Worker 端显示 Spinner 动画和 "Waiting for team lead approval" 提示。展示工具名称、操作描述和团队名称，使用 `warning` 颜色边框。

> 源码位置：`WorkerPendingPermission.tsx:16-104`

## 边界 Case 与注意事项

- **无限微任务循环防护**：`usePermissionRequestLogging` 中的 `loggedToolUseID` ref 防止 `toolUseConfirm` 对象引用变化导致 `useEffect` 反复触发，这在内部构建中可导致 CPU 100% 和 ~500MB/min 内存泄漏（`hooks.ts:106-113`）
- **Feature flag 条件加载**：`ReviewArtifactTool`、`WorkflowTool`、`MonitorTool` 使用 `require()` 动态加载以支持 tree-shaking，未启用时回退到 `FallbackPermissionRequest`
- **分类器自动批准竞态**：`ToolUseConfirm.onUserInteraction()` 回调用于通知系统用户正在与权限对话框交互，防止异步分类器在用户操作过程中自动批准请求
- **Tab 反馈输入的空提交**：反馈输入模式下空提交（直接回车）会取消反馈模式而非提交空文本（`allowEmptySubmitToCancel: true`）
- **MCP 工具名称处理**：`FallbackPermissionRequest` 会自动去除工具名称末尾的 ` (MCP)` 后缀
- **粘性底部区域**：`setStickyFooter` 仅在全屏模式下生效，非全屏模式下终端滚动缓冲区会自然移动所有内容
- **托管沙盒限制**：`shouldAllowManagedSandboxDomainsOnly()` 为 true 时，`SandboxPermissionRequest` 隐藏 "don't ask again" 选项