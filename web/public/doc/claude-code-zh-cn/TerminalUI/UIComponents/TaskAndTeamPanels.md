# 任务与团队状态面板（TaskAndTeamPanels）

## 概述与职责

TaskAndTeamPanels 模块是 Claude Code 终端 UI 中负责**后台任务管理和团队协作状态展示**的组件集合。它隶属于 `TerminalUI > UIComponents` 层级，为用户提供对所有后台运行的任务（Shell 命令、本地/远程 Agent、Dream 任务、进程内队友等）以及团队成员状态的可视化监控和交互操作能力。

该模块由三部分组成：
- **`tasks/` 目录**：后台任务管理的核心组件，包括任务列表对话框、各类任务的详情对话框、进度显示和状态工具函数
- **`teams/` 目录**：团队协作状态展示，包括团队对话框和团队状态指示器
- **顶层组件**：`TaskListV2`（todo 任务列表）、`CoordinatorAgentStatus`（协调器 Agent 面板）、`AgentProgressLine`（Agent 进度行）、`TeammateViewHeader`（队友视图头部）、`ResumeTask`（会话恢复选择器）

## 关键流程

### 后台任务查看与管理流程

1. 用户在 REPL 底部看到 `BackgroundTaskStatus` 组件渲染的任务状态摘要（以彩色药丸 pill 形式展示各队友/任务）
2. 用户按快捷键打开 `BackgroundTasksDialog`，对话框从 `AppState.tasks` 中过滤出后台任务（`isBackgroundTask()`），按运行状态和启动时间排序
3. 对话框以列表视图展示所有任务（Shell、Remote Agent、Local Agent、Teammate、Dream、Workflow 等），用户可上下导航选择
4. 选中某任务后按 Enter 进入详情视图，根据任务类型路由到对应的 Detail Dialog（`ShellDetailDialog`、`RemoteSessionDetailDialog`、`AsyncAgentDetailDialog` 等）
5. 在详情视图中用户可查看任务输出、状态和耗时，按 `x` 终止运行中的任务，按 `f` 前台化队友

> 关键入口：`BackgroundTasksDialog` (`src/components/tasks/BackgroundTasksDialog.tsx:127`)

### 任务状态判定流程

`taskStatusUtils.tsx` 提供统一的状态判定逻辑，供所有任务组件共享：
1. `isTerminalStatus()` 判断任务是否已终结（`completed` / `failed` / `killed`）
2. `getTaskStatusIcon()` 根据状态和附加标志（idle、awaitingApproval、hasError、shutdownRequested）返回对应图标
3. `getTaskStatusColor()` 按相同优先级逻辑返回语义颜色（`success` / `error` / `warning` / `background`）
4. `shouldHideTasksFooter()` 判断 spinner tree 模式下是否隐藏任务 footer（当所有可见后台任务都是 in_process_teammate 时隐藏，因为它们已在 spinner tree 中展示）

> 源码位置：`src/components/tasks/taskStatusUtils.tsx:16-106`

### 协调器 Agent 面板流程

`CoordinatorAgentStatus` 组件在 prompt 输入区下方渲染一个可导航的 Agent 任务列表：
1. `getVisibleAgentTasks()` 过滤出 panel-managed 的 Agent 任务（`isPanelAgentTask(t) && t.evictAfter !== 0`），按启动时间排序
2. 每秒执行一次 tick，自动驱逐超过 `evictAfter` 截止时间的终态任务
3. 渲染 `MainLine`（主线程入口）和每个 Agent 的 `AgentLine`，支持鼠标点击和键盘选择在主线程和各 Agent 视图间切换

> 源码位置：`src/components/CoordinatorAgentStatus.tsx:31-76`

## 函数签名与参数说明

### `BackgroundTasksDialog({ onDone, toolUseContext, initialDetailTaskId })`

后台任务管理的主对话框。

| 参数 | 类型 | 说明 |
|------|------|------|
| `onDone` | `(result?, options?) => void` | 关闭对话框的回调 |
| `toolUseContext` | `ToolUseContext` | 工具使用上下文，传递给子 Detail Dialog |
| `initialDetailTaskId` | `string?` | 可选，直接打开指定任务的详情视图 |

内部维护 `ViewState`（`'list'` 或 `'detail'`），当只有一个任务或指定了 `initialDetailTaskId` 时自动跳过列表直接进入详情。

### `BackgroundTaskStatus({ tasksSelected, isViewingTeammate, teammateFooterIndex, isLeaderIdle, onOpenDialog })`

REPL 底部的任务状态摘要栏。以横向药丸列表展示各队友/任务状态，支持水平滚动。

### `BackgroundTask({ task, maxActivityWidth })`

单个后台任务的一行摘要渲染。根据 `task.type` 分支处理 7 种任务类型：
- `local_bash`：显示命令文本 + `ShellProgress`
- `remote_agent`：钻石图标 + 标题 + `RemoteSessionProgress`
- `local_agent`：描述 + `TaskStatusText`
- `in_process_teammate`：描述活动 + `TaskStatusText`
- `dream`：描述 + `TaskStatusText`
- 其他类型依此类推

### `renderToolActivity(activity, tools, theme)`

将工具活动记录渲染为人类可读的 React 节点。通过 `findToolByName` 查找工具定义，解析输入后调用 `tool.userFacingName()` 和 `tool.renderToolUseMessage()` 生成展示内容。

> 源码位置：`src/components/tasks/renderToolActivity.tsx:7-32`

### 状态工具函数

```typescript
function isTerminalStatus(status: TaskStatus): boolean
function getTaskStatusIcon(status: TaskStatus, options?: { isIdle?, awaitingApproval?, hasError?, shutdownRequested? }): string
function getTaskStatusColor(status: TaskStatus, options?: { ... }): 'success' | 'error' | 'warning' | 'background'
function describeTeammateActivity(t: DeepImmutable<InProcessTeammateTaskState>): string
function shouldHideTasksFooter(tasks: Record<string, TaskState>, showSpinnerTree: boolean): boolean
```

`describeTeammateActivity` 的降级链：`shutdownRequested` → `'stopping'` → `awaitingPlanApproval` → `'awaiting approval'` → `isIdle` → `'idle'` → `recentActivities` 摘要 → `lastActivity` 描述 → `'working'`。

## 接口/类型定义

### `ListItem`（BackgroundTasksDialog 内部）

一个联合类型，代表对话框列表中的一项。支持 8 种 `type`：`local_bash`、`remote_agent`、`local_agent`、`in_process_teammate`、`local_workflow`、`monitor_mcp`、`dream`、`leader`。每种类型携带对应的 `task` 状态对象。

### `ViewState`

```typescript
type ViewState = { mode: 'list' } | { mode: 'detail'; itemId: string }
```

控制 `BackgroundTasksDialog` 在列表视图和详情视图之间切换。

## 各 Detail Dialog 组件

### `ShellDetailDialog`

Shell 任务详情对话框。通过 `tailFile` 读取任务输出文件的最后 8192 字节（`SHELL_DETAIL_TAIL_BYTES`），运行中每秒自动刷新。展示命令、状态、耗时、输出大小和尾部输出内容。支持 `x` 终止和返回操作。

> 源码位置：`src/components/tasks/ShellDetailDialog.tsx:24-48`

### `RemoteSessionDetailDialog`

远程 Agent 会话详情。内含两种子视图：
- **UltraplanSessionDetail**：超级计划模式，展示 agent 生成数、工具调用数、phase 状态（`needs_input`/`plan_ready`），并提供 `formatToolUseSummary()` 将工具调用压缩为一行摘要
- **标准远程会话详情**：展示会话日志、状态和可操作按钮

### `RemoteSessionProgress`

远程会话的内联进度指示器。包含特殊的 Review 模式支持：
- `formatReviewStageCounts()` 根据审查阶段（`finding`/`verifying`/`synthesizing`）格式化计数摘要
- `ReviewRainbowLine` 使用彩虹渐变动画展示 ultrareview 进度，通过 `useSmoothCount` 实现平滑计数递增动画
- `RainbowText` 按字符着色，phase 偏移使颜色扫过文本

> 源码位置：`src/components/tasks/RemoteSessionProgress.tsx:22-38`

### `AsyncAgentDetailDialog`

本地异步 Agent 详情。展示 Agent 描述、prompt（超过 300 字符截断）、plan 内容（通过 `extractTag` 提取 `<plan>` 标签）、token 消耗、工具调用计数和最近活动列表。使用 `renderToolActivity` 渲染活动详情。

### `DreamDetailDialog`

Dream 任务详情。展示最近 6 轮对话（`VISIBLE_TURNS = 6`），更早的轮次折叠为计数。显示正在审查的会话数和已触及的文件数。

### `InProcessTeammateDetailDialog`

进程内队友详情。展示队友名称（带颜色标识）、当前活动描述（通过 `describeTeammateActivity`）、token 消耗、工具调用列表。支持 `x` 终止、`f` 前台化操作。

## 顶层组件

### `TaskListV2`

Todo 任务列表组件（需 `isTodoV2Enabled()` 开启）。从 `AppState` 读取任务列表，按 ID 排序渲染。完成的任务在 30 秒内保持可见（`RECENT_COMPLETED_TTL_MS = 30_000`），之后自动消失。支持根据团队上下文为队友任务着色。

### `CoordinatorTaskPanel`

协调器 Agent 面板。在 prompt 输入区下方渲染 `MainLine`（主线程）+ 各个 `AgentLine`。通过 `getVisibleAgentTasks()` 获取可见任务列表，`useCoordinatorTaskCount()` Hook 提供任务计数。每秒自动驱逐终态任务。

### `AgentProgressLine`

Agent 进度的单行渲染。以树状字符（`├─` / `└─`）前缀展示 Agent 类型、描述、工具调用计数、token 消耗和状态文本。区分同步和异步 Agent——异步 Agent 完成后显示 "Running in the background"。

> 源码位置：`src/components/AgentProgressLine.tsx:23`

### `TeammateViewHeader`

队友视图切换时的头部横幅。当用户前台化某个队友时，在消息列表顶部显示 "Viewing @{agentName}"（带颜色）和 esc 返回提示。通过 `getViewedTeammateTask` 从 AppState 获取当前查看的队友。

> 源码位置：`src/components/TeammateViewHeader.tsx:14`

### `ResumeTask`

远程会话恢复选择器。通过 `fetchCodeSessionsFromSessionsAPI` 加载历史会话列表，按当前仓库过滤、按更新时间排序，用户选择后恢复该会话。支持加载错误处理和重试。

### `TeamStatus`

团队状态 footer 指示器。从 `AppState.teamContext` 读取队友数量（排除 team-lead），以 "N teammates" 形式显示。选中时高亮并提示 "Enter to view"。

> 源码位置：`src/components/teams/TeamStatus.tsx:14`

### `TeamsDialog`

团队管理对话框。以两层导航结构呈现：
- **teammateList**：显示团队中所有队友状态（名称、权限模式、活动状态）
- **teammateDetail**：单个队友的详细信息和操作（权限模式切换、终止、隐藏/显示面板等）

通过 `getTeammateStatuses()` 获取队友状态，每秒自动刷新。支持循环切换队友权限模式（`cycleTeammateMode`）。

> 源码位置：`src/components/teams/TeamsDialog.tsx:48`

## 边界 Case 与注意事项

- **单任务自动跳转**：`BackgroundTasksDialog` 在只有一个后台任务时自动跳过列表直接进入详情视图。返回时如果仍只有 ≤1 个任务则直接关闭对话框，但如果期间有新任务加入则回到列表
- **Spinner tree 模式互斥**：当 `expandedView === 'teammates'`（spinner tree 开启）时，`BackgroundTaskStatus` 隐藏所有 in_process_teammate 类型任务（由 `shouldHideTasksFooter` 控制），`BackgroundTasksDialog` 也将 teammates 列表置空
- **Feature gate 机制**：`WorkflowDetailDialog` 和 `MonitorMcpDetailDialog` 通过 `feature()` 函数按构建标志门控加载，外部构建中这些代码会被 dead-code elimination 移除
- **`"external" === 'ant'` 常量条件**：`shouldHideTasksFooter` 中的 `"external" === 'ant'` 是编译时常量比较，在外部构建中始终为 false，使 `isPanelAgentTask` 检查被跳过
- **任务驱逐**：`CoordinatorTaskPanel` 的 1 秒 tick 会自动驱逐 `evictAfter` 到期的终态任务，`evictAfter === 0` 表示立即驱逐（用户按 x 关闭时设置）
- **完成任务保留**：`TaskListV2` 中完成的 todo 任务保留 30 秒后消失，通过 `completionTimestampsRef` 追踪完成时间并用 `setTimeout` 触发重渲染
- **平滑计数动画**：`RemoteSessionProgress` 中 `useSmoothCount` 让数字变化逐帧 +1 显示，减少运动模式下直接跳到目标值