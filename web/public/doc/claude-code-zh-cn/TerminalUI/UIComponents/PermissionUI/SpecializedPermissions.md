# 专用权限审批组件集合（SpecializedPermissions）

## 概述与职责

SpecializedPermissions 是一组专用的权限审批 UI 组件，覆盖 Claude Code 中非 Shell / 非文件类工具的权限请求场景。它位于 `TerminalUI → UIComponents → PermissionUI` 层级下，由顶层权限路由器 `PermissionRequest.tsx` 根据工具类型分发到对应的专用组件。

这些组件共同解决一个核心问题：**当 Claude 需要执行某类敏感操作时，如何以最直观的方式向用户展示请求内容，并收集用户的审批决策**。每种权限请求都有量身定制的预览展示和操作选项。

同级兄弟模块还包括 BashPermissionRequest（Shell 命令）、FilePermissionDialog（文件读写）等，它们共同组成完整的权限 UI 系统。

本模块包含 7 个子组件目录，共 14 个文件：

| 组件 | 文件数 | 职责 |
|------|--------|------|
| AskUserQuestionPermissionRequest | 7 | 多步骤用户提问审批（最复杂） |
| ExitPlanModePermissionRequest | 1 | Plan 模式退出与计划审批 |
| EnterPlanModePermissionRequest | 1 | Plan 模式进入确认 |
| ComputerUseApproval | 1 | 计算机使用权限审批 |
| WebFetchPermissionRequest | 1 | URL 抓取请求预览 |
| SkillPermissionRequest | 1 | 技能调用审批 |
| NotebookEditPermissionRequest | 2 | Notebook 单元格编辑差异展示 |

## 关键流程

### 权限审批通用流程

所有组件接收统一的 `PermissionRequestProps` 接口：

```typescript
{
  toolUseConfirm,  // 包含工具输入、权限结果、onAllow/onReject 回调
  onDone,          // 审批完成回调
  onReject,        // 用户拒绝回调
  workerBadge,     // Worker 标识
  verbose,         // 是否详细展示
}
```

典型流程为：
1. 解析 `toolUseConfirm.input` 获取工具参数
2. 渲染预览内容和操作选项（通常使用 `Select` 组件）
3. 用户选择后调用 `toolUseConfirm.onAllow()` 或 `toolUseConfirm.onReject()`，同时调用 `onDone()` 关闭对话框

### AskUserQuestionPermissionRequest 多步骤提问流程

这是最复杂的组件组，实现了一个完整的多问题交互式审批流程。

**入口组件** `AskUserQuestionPermissionRequest`（`AskUserQuestionPermissionRequest.tsx:30`）：
1. 解析 `toolUseConfirm.input` 中的 `questions` 数组（通过 `AskUserQuestionTool.inputSchema`）
2. 计算全局内容高度/宽度（基于终端尺寸和预览内容）
3. 初始化 `useMultipleChoiceState()` 状态管理器
4. 根据 `currentQuestionIndex` 切换显示 `QuestionView`（答题）或 `SubmitQuestionsView`（提交）

**状态管理** `useMultipleChoiceState`（`use-multiple-choice-state.ts`）使用 `useReducer` 管理：

| 状态字段 | 类型 | 说明 |
|----------|------|------|
| `currentQuestionIndex` | `number` | 当前问题索引 |
| `answers` | `Record<string, AnswerValue>` | 已提交的答案映射 |
| `questionStates` | `Record<string, QuestionState>` | 每个问题的 UI 状态（选中值、文本输入值） |
| `isInTextInput` | `boolean` | 是否处于文本输入模式 |

支持 5 种 Action：`next-question`、`prev-question`、`update-question-state`、`set-answer`、`set-text-input-mode`。

**答题视图** `QuestionView`（`QuestionView.tsx:43`）是核心视图组件：
- 解析问题选项，支持单选（`Select`）和多选（`SelectMulti`）
- 选项可包含 "Other" 自由文本输入（`__other__` 标识）
- 支持图片粘贴附件（`onImagePaste`）
- 支持通过 `Ctrl+G` 在外部编辑器中编辑文本
- 底部有导航页脚：可以"回复 Claude"（reject with feedback）或"完成计划访谈"
- 当问题选项含 `preview` 字段时，自动委托给 `PreviewQuestionView` 渲染

**预览问题视图** `PreviewQuestionView`（`PreviewQuestionView.tsx:41`）：
- 左侧显示选项列表，右侧显示选中选项的预览内容
- 预览内容通过 `PreviewBox` 组件渲染（带边框的等宽文本框）
- 支持上/下键导航选项、左/右键切换问题、Enter 确认选择
- 包含可选的笔记输入区域

**预览框** `PreviewBox`（`PreviewBox.tsx:39`）：
- 使用 Unicode 边框字符（`┌─┐│└─┘`）绘制等宽盒子
- 支持 Markdown 渲染和语法高亮（通过 `applyMarkdown`）
- 超出 `maxLines` 时截断并显示"✂ N lines hidden"指示器
- 自动处理 ANSI 颜色序列的宽度计算和裁剪

**导航栏** `QuestionNavigationBar`（`QuestionNavigationBar.tsx:15`）：
- 显示问题标签页和 Submit 标签
- 自适应终端宽度：宽度不足时自动截断标签文本
- 当前问题获得更大显示空间，其他问题均分剩余宽度
- 已回答问题用 `✓` 标记

**提交视图** `SubmitQuestionsView`（`SubmitQuestionsView.tsx:21`）：
- 展示所有已回答问题的摘要（问题文本 + 选中答案）
- 未回答完所有问题时显示警告
- 提供 Submit / Cancel 两个选项

**提交流程**：
1. 单问题场景：选择答案后自动提交（`AskUserQuestionPermissionRequest.tsx:443-448`）
2. 多问题场景：所有问题回答后进入 SubmitView，确认提交
3. 提交时收集 `annotations`（包括选项 preview 和用户 notes）
4. 支持三种终结操作：
   - **Submit**：`toolUseConfirm.onAllow(updatedInput)` — 提交答案
   - **Respond to Claude**：`toolUseConfirm.onReject(feedback)` — 带反馈拒绝，请求重新提问
   - **Finish Plan Interview**：`toolUseConfirm.onReject(feedback)` — 告知 Claude 停止提问，直接完成计划

### ExitPlanModePermissionRequest 计划审批流程

`ExitPlanModePermissionRequest`（`ExitPlanModePermissionRequest.tsx:118`）是第二复杂的组件，处理 Claude 退出 Plan 模式时的计划展示和审批。

**计划展示**：
- 使用 `Markdown` 组件渲染计划内容
- 计划来源有两种：V1 通过 `toolUseConfirm.input.plan` 传入，V2 从磁盘文件 `getPlanFilePath()` 读取
- 支持 `Ctrl+G` 在外部编辑器中编辑计划（`ExitPlanModePermissionRequest.tsx:228-265`）
- 编辑后显示"Plan saved!"确认消息（5 秒后自动消失）
- 大屏模式下使用 sticky footer（`setStickyFooter`）保持选项可见

**审批选项**由 `buildPlanApprovalOptions`（`ExitPlanModePermissionRequest.tsx:674`）动态构建，根据可用特性组合：

| 选项 | 条件 | 行为 |
|------|------|------|
| Yes, clear context + auto mode | `TRANSCRIPT_CLASSIFIER` + auto mode | 清除上下文，auto 模式执行 |
| Yes, clear context + bypass permissions | `isBypassPermissionsModeAvailable` | 清除上下文，跳过权限 |
| Yes, clear context + auto-accept edits | `showClearContext` | 清除上下文，自动接受编辑 |
| Yes, keep context + auto-accept edits | 始终 | 保留上下文，自动接受编辑 |
| Yes, keep context | 始终 | 保留上下文，默认权限 |
| Ultraplan | `ULTRAPLAN` feature | 将计划发送到 CCR 进行精炼 |
| No, give feedback | 始终（TextInput） | 拒绝并提供修改意见 |

**关键辅助函数**：

`buildPermissionUpdates(mode, allowedPrompts)`（`ExitPlanModePermissionRequest.tsx:56`）：构建权限更新列表，包含 `setMode` 和可选的 prompt-based 规则（Ant 内部功能）。

`autoNameSessionFromPlan(plan, setAppState, isClearContext)`（`ExitPlanModePermissionRequest.tsx:83`）：异步生成会话名称——截取计划前 1000 字符用 Haiku 模型生成 kebab-case 名称。

**空计划特殊处理**（`ExitPlanModePermissionRequest.tsx:558-624`）：当计划为空时，显示简化的 Yes/No 选择界面。

### EnterPlanModePermissionRequest

`EnterPlanModePermissionRequest`（`EnterPlanModePermissionRequest.tsx:11`）是相对简单的确认对话框：

- 使用 `PermissionDialog` 包装，颜色主题为 `planMode`
- 展示 Plan 模式的功能说明（探索代码库、识别模式、设计策略、展示计划）
- 承诺"不会在你批准前做任何代码修改"
- 两个选项：Yes（触发 `handlePlanModeTransition` + `logEvent('tengu_plan_enter')`）/ No
- 批准时发送 `setMode: 'plan'` 权限更新

### WebFetchPermissionRequest

`WebFetchPermissionRequest`（`WebFetchPermissionRequest.tsx:29`）处理 URL 抓取请求：

- 从 `toolUseConfirm.input` 解析 URL，提取 hostname
- 使用 `WebFetchTool.renderToolUseMessage()` 渲染请求预览（URL + prompt）
- 三种选项：
  - **Yes**：单次允许
  - **Yes, don't ask again for [hostname]**：添加域名级别的永久允许规则（`addRules` + `domain:{hostname}`），仅在 `shouldShowAlwaysAllowOptions()` 为 true 时显示
  - **No (esc)**：拒绝

辅助函数 `inputToPermissionRuleContent`（`WebFetchPermissionRequest.tsx:12`）从输入提取域名构建规则内容。

### SkillPermissionRequest

`SkillPermissionRequest`（`SkillPermissionRequest.tsx:18`）处理技能调用审批：

- 解析 `toolUseConfirm.input` 获取技能名称（`skill` 字段）
- 使用 `PermissionPrompt` 组件（而非直接使用 `Select`）渲染选项，支持反馈收集
- 选项层级：
  - **Yes**：单次允许
  - **Yes, don't ask again for [skill] in [cwd]**：精确匹配永久允许
  - **Yes, don't ask again for [prefix]:* in [cwd]**：前缀匹配永久允许（当技能名含空格时显示，如 `commit` vs `commit --amend`）
  - **No**：拒绝
- 批准时发送 `toolName: 'Skill'` + `ruleContent: 'skill:{name}'` 或 `skillPrefix:{prefix}` 规则

### NotebookEditPermissionRequest

**权限对话框** `NotebookEditPermissionRequest`（`NotebookEditPermissionRequest.tsx:12`）：
- 解析 `NotebookEditTool.inputSchema` 获取 `notebook_path`、`edit_mode`、`cell_type`
- 委托给 `FilePermissionDialog` 处理通用文件权限逻辑
- 根据 `edit_mode` 显示不同描述："insert this cell"、"delete this cell"、"make this edit to"

**差异展示** `NotebookEditToolDiff`（`NotebookEditToolDiff.tsx:34`）：
1. 异步读取 Notebook 文件，解析为 JSON（`NotebookContent`）
2. 通过 `cell_id` 定位目标单元格——支持数字索引（`parseCellId`）和字符串 ID 两种查找方式
3. 根据 `edit_mode` 决定展示方式：
   - **replace**：使用 `getPatchForDisplay()` 生成 diff，通过 `StructuredDiff` 组件展示
   - **insert**：使用 `HighlightedCode` 直接展示新内容
   - **delete**：使用 `HighlightedCode` 展示待删除内容
4. 路径显示：verbose 模式用绝对路径，否则用相对路径

### ComputerUseApproval

`ComputerUseApproval`（`ComputerUseApproval.tsx:30`）是一个两面板调度器：

**TCC 面板**（`ComputerUseTccPanel`，`ComputerUseApproval.tsx:51`）——当 macOS 系统权限缺失时显示：
- 检查 `request.tccState` 中的 Accessibility 和 Screen Recording 权限状态
- 每项用 `✓ granted` / `✗ not granted` 标记
- 提供"Open System Settings → Accessibility/Screen Recording"选项，通过 `execFileNoThrow('open', ...)` 打开对应系统设置页
- "Try again"选项重试权限检测
- 使用 `Dialog` 组件而非 `PermissionDialog`

**应用白名单面板**（`ComputerUseAppListPanel`，`ComputerUseApproval.tsx:208`）——正常的应用审批流程：
- 展示请求访问的应用列表，每个应用显示名称和状态（已安装/未安装/已授权）
- 使用 `getSentinelCategory` 检测高风险应用（shell 等效、文件系统访问、系统设置修改），并显示警告
- 展示额外请求的标志位：`clipboardRead`、`clipboardWrite`、`systemKeyCombos`
- 显示将被隐藏的其他应用数量
- 两个选项：Allow for this session（构建 granted/denied/flags 响应）/ Deny

## 接口/类型定义

### PermissionRequestProps（所有组件共享）

```typescript
type PermissionRequestProps = {
  toolUseConfirm: ToolUseConfirm;  // 工具确认上下文
  onDone: () => void;               // 完成回调
  onReject: () => void;             // 拒绝回调
  verbose?: boolean;                 // 详细模式
  workerBadge?: ReactNode;          // Worker 标识
  setStickyFooter?: (node: ReactNode | null) => void;  // 全屏模式底部固定
  toolUseContext?: ToolUseContext;   // 工具使用上下文
};
```

### MultipleChoiceState

```typescript
type MultipleChoiceState = {
  currentQuestionIndex: number;
  answers: Record<string, AnswerValue>;
  questionStates: Record<string, QuestionState>;
  isInTextInput: boolean;
  nextQuestion: () => void;
  prevQuestion: () => void;
  updateQuestionState: (questionText: string, updates: Partial<QuestionState>, isMultiSelect: boolean) => void;
  setAnswer: (questionText: string, answer: string, shouldAdvance?: boolean) => void;
  setTextInputMode: (isInInput: boolean) => void;
};
```

### ComputerUseApprovalProps

```typescript
type ComputerUseApprovalProps = {
  request: CuPermissionRequest;  // 来自 @ant/computer-use-mcp
  onDone: (response: CuPermissionResponse) => void;
};
```

### ResponseValue（ExitPlanMode）

```typescript
type ResponseValue =
  | 'yes-bypass-permissions'
  | 'yes-accept-edits'
  | 'yes-accept-edits-keep-context'
  | 'yes-default-keep-context'
  | 'yes-resume-auto-mode'
  | 'yes-auto-clear-context'
  | 'ultraplan'
  | 'no';
```

## 配置项与默认值

| 配置 | 位置 | 默认值 | 说明 |
|------|------|--------|------|
| `MIN_CONTENT_HEIGHT` | AskUserQuestion | 12 | 问题视图最小内容高度（行） |
| `MIN_CONTENT_WIDTH` | AskUserQuestion | 40 | 最小内容宽度 |
| `CONTENT_CHROME_OVERHEAD` | AskUserQuestion | 15 | 导航栏/标题等固定 UI 占用行数 |
| `settings.showClearContextOnPlanAccept` | ExitPlanMode | false | 是否显示"清除上下文"选项 |
| `settings.syntaxHighlightingDisabled` | PreviewBox | false | 禁用语法高亮时跳过 Suspense |

## 边界 Case 与注意事项

- **单问题自动提交**：当 `questions.length === 1` 且非多选时，用户选择后自动提交答案，不显示 Submit 标签页（`AskUserQuestionPermissionRequest.tsx:264, 443`）
- **空计划处理**：`ExitPlanModePermissionRequest` 对空计划显示简化的 Yes/No UI，不展示 Markdown 渲染区和编辑功能（`ExitPlanModePermissionRequest.tsx:558`）
- **V1/V2 Plan 检测**：通过工具名（`EXIT_PLAN_MODE_V2_TOOL_NAME`）而非 `input.plan` 检测版本，因为 hooks/SDK 会注入 plan 内容导致误判（`ExitPlanModePermissionRequest.tsx:192`）
- **TCC vs AppList 分支**：`ComputerUseApproval` 根据 `request.tccState` 是否存在决定面板类型，两个面板完全独立
- **Sentinel 应用警告**：Computer Use 中的高风险应用（如 Terminal、Finder）会显示额外的安全警告（"equivalent to shell access"等）
- **图片附件**：AskUserQuestion 和 ExitPlanMode 都支持图片粘贴，通过 `maybeResizeAndDownsampleImageBlock` 自动缩放，`cacheImagePath` + `storeImage` 持久化
- **Auto mode 安全处理**：ExitPlanMode 退出时如果 auto mode 在 Plan 期间被激活，会自动停用 auto mode 并恢复危险权限（`ExitPlanModePermissionRequest.tsx:313-329`）
- **Ultraplan 互斥**：当已有 Ultraplan 会话或正在启动时，隐藏 Ultraplan 按钮，避免重复创建（`ExitPlanModePermissionRequest.tsx:144`）
- **React Compiler 优化**：所有组件使用 React Compiler 运行时（`_c` 缓存数组），通过细粒度依赖追踪实现自动 memoization