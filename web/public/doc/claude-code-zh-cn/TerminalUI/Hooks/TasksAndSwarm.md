# 任务管理与多 Agent 协调 Hooks

## 概述与职责

本模块位于 `TerminalUI > Hooks` 层级下，包含 9 个 React 自定义 Hooks，分为两大功能域：

1. **任务管理**：`useTasksV2`、`useBackgroundTaskNavigation`、`useTaskListWatcher`、`useScheduledTasks` —— 负责任务列表的状态订阅、UI 导航、文件系统监听和定时调度。
2. **Swarm 多 Agent 协调**：`useSwarmInitialization`、`useSwarmPermissionPoller`、`useInboxPoller`、`useMailboxBridge`、`useTeammateViewAutoExit` —— 负责 Swarm 模式的初始化、跨 Agent 权限同步、消息轮询与路由、邮箱桥接及视图自动退出。

这些 Hooks 是 REPL 主屏幕和 Spinner 等 UI 组件的行为引擎，连接了底层的任务系统（`TaskSystem`）和状态管理层（`StateAndContext`），使得终端 UI 能够响应后台任务变化和多 Agent 协作事件。

---

## 任务管理 Hooks

### useTasksV2 — 任务列表状态订阅

> 源码：`src/hooks/useTasksV2.ts`

#### 核心设计：单例 Store + `useSyncExternalStore`

`useTasksV2` 通过一个模块级单例 `TasksV2Store` 来管理任务列表状态。多个 UI 组件（REPL、Spinner、PromptInputFooterLeftSide）订阅同一个 Store 实例，避免每个组件各自创建 `fs.watch`——特别是 Spinner 组件频繁挂载/卸载时会导致大量 watch/unwatch 开销。

```typescript
// src/hooks/useTasksV2.ts:29-199
class TasksV2Store {
  #tasks: Task[] | undefined = undefined
  #hidden = false
  #watcher: FSWatcher | null = null
  // ... 单例管理所有文件监听、定时器和缓存
}
```

#### 三重变更检测机制

1. **`fs.watch`**：监视任务目录，捕获外部进程写入
2. **`onTasksUpdated` 回调**：捕获当前进程内的任务变更
3. **Fallback 轮询**（5 秒间隔）：仅在有未完成任务时启用，作为 `fs.watch` 漏报的兜底

#### 自动隐藏逻辑

当所有任务变为 `completed` 状态后，启动 5 秒延时计时器。计时器触发时再次验证所有任务仍为已完成，然后调用 `resetTaskList()` 清空任务列表并隐藏 UI 显示。如果在 5 秒内有新的未完成任务出现，计时器被取消。

#### 导出的 Hooks

- **`useTasksV2()`**：返回 `Task[] | undefined`，在 TodoV2 未启用或当前用户不是 Team Lead 时返回 `undefined`
- **`useTasksV2WithCollapseEffect()`**：在 `useTasksV2` 基础上，当任务列表隐藏时自动折叠 `expandedView`。应仅在一个始终挂载的组件（REPL）中调用

---

### useBackgroundTaskNavigation — 后台任务键盘导航

> 源码：`src/hooks/useBackgroundTaskNavigation.ts`（251 行）

实现 Swarm 队友之间的键盘导航交互，支持以下快捷键：

| 按键 | 模式 | 行为 |
|------|------|------|
| Shift+Up/Down | 任意 | 在 leader(-1) → teammates(0..n-1) → hide(n) 之间循环选择，首次按下展开面板 |
| Enter | selecting-agent | 确认选择：-1=返回 leader，≥n=折叠面板，其他=进入队友视图 |
| f | selecting-agent | 查看选中队友的完整对话记录 |
| k | selecting-agent | 终止选中的运行中队友 |
| Escape | viewing-agent | 运行中的队友：中止当前 turn（不杀死队友）；已完成的队友：退出视图 |
| Escape | selecting-agent | 退出选择模式 |

#### 关键流程

1. `stepTeammateSelection()` 辅助函数实现环绕式索引移动（`src/hooks/useBackgroundTaskNavigation.ts:26-59`）
2. 当无 Swarm 队友但存在其他后台任务（`local_agent`、`local_bash` 等）时，Shift+Up/Down 改为打开后台任务对话框
3. 通过 `useEffect` 监听队友数量变化，自动 clamp 选择索引或在队友全部移除后重置状态

---

### useTaskListWatcher — 任务列表文件监听

> 源码：`src/hooks/useTaskListWatcher.ts`

启用"任务模式"（tasks mode）：监听任务目录中外部创建的任务文件，自动领取并执行。

#### 关键流程 Walkthrough

1. **初始化**：通过 `ensureTasksDir()` 确保目录存在，`fs.watch()` 监听变更
2. **检查任务**（`checkForTasks`，去抖 1 秒）：
   - 如果当前有正在处理的任务且未完成，跳过
   - 如果当前任务已完成，释放引用
   - 调用 `findAvailableTask()` 查找状态为 `pending`、无 owner、且不被阻塞的任务
3. **领取任务**：通过 `claimTask()` 原子性设置 owner
4. **提交 prompt**：将任务格式化为 `"Complete all open tasks. Start with task #${id}: ..."` 提交给 REPL
5. **空闲触发**：当 `isLoading` 从 true 变为 false 时，调度一次检查以拾取下一个任务

#### 防死锁设计

`isLoading` 和 `onSubmitTask` 通过 `useRef` 稳定化，避免 watcher effect 因依赖变化而频繁 re-setup——这是 Bun 的 `PathWatcherManager` 死锁问题的 workaround（`oven-sh/bun#27469`）。

---

### useScheduledTasks — 定时任务调度

> 源码：`src/hooks/useScheduledTasks.ts`

REPL 层的 cron 调度器封装。核心调度逻辑在 `cronScheduler.ts` 中实现（SDK 模式复用），本 Hook 负责在 React 生命周期中挂载/卸载调度器。

#### 任务路由逻辑（`onFireTask`）

```
触发 cron 任务
├── 有 agentId？
│   ├── 对应 teammate 存活 → injectUserMessageToTeammate()
│   └── teammate 已不存在 → removeCronTasks() 清理孤儿 cron
└── 无 agentId（leader 自身的 cron）
    └── enqueuePendingNotification() 以 'later' 优先级入队
```

关键参数：
- `workload: WORKLOAD_CRON`：通过计费头标记为 cron 发起的请求，API 可按低 QoS 调度
- `isMeta: true`：系统生成的消息，隐藏在队列预览和对话记录 UI 中
- `isKilled` 回调：运行时 killswitch，每次 tick 检查特性开关是否已关闭

---

## Swarm 多 Agent 协调 Hooks

### useSwarmInitialization — Swarm 初始化

> 源码：`src/hooks/useSwarmInitialization.ts`

在 `ENABLE_AGENT_SWARMS` 开启时初始化 Swarm 功能，处理两种场景：

1. **恢复会话**（`--resume` 或 `/resume`）：从第一条消息中提取 `teamName`/`agentName`，通过 `initializeTeammateContextFromSession()` 恢复上下文，从 team 文件查找 `agentId` 后调用 `initializeTeammateHooks()`
2. **全新启动**：从 `getDynamicTeamContext()` 获取环境变量中的团队信息，直接调用 `initializeTeammateHooks()`

此 Hook 支持条件加载（`enabled` 参数），允许在 Swarm 功能禁用时进行 dead code elimination。

---

### useSwarmPermissionPoller — 权限轮询（Worker 侧）

> 源码：`src/hooks/useSwarmPermissionPoller.ts`（330 行）

当运行在 Swarm Worker 模式下时，以 500ms 间隔轮询协调节点获取权限决策。

#### 双注册表架构

模块维护两个独立的回调注册表：

1. **`pendingCallbacks`**：工具执行权限（由 `useCanUseTool` 注册）

   ```typescript
   // src/hooks/useSwarmPermissionPoller.ts:58-67
   type PermissionResponseCallback = {
     requestId: string
     toolUseId: string
     onAllow: (updatedInput, permissionUpdates, feedback?) => void
     onReject: (feedback?) => void
   }
   ```

2. **`pendingSandboxCallbacks`**：沙箱网络访问权限

   ```typescript
   // src/hooks/useSwarmPermissionPoller.ts:165-169
   type SandboxPermissionResponseCallback = {
     requestId: string
     host: string
     resolve: (allow: boolean) => void
   }
   ```

#### 两条响应处理路径

- **磁盘轮询路径**（`useSwarmPermissionPoller` Hook）：调用 `pollForResponse()` 从文件系统读取响应，处理后通过 `removeWorkerResponse()` 清理
- **邮箱路径**（供 `useInboxPoller` 调用）：通过 `processMailboxPermissionResponse()` 和 `processSandboxPermissionResponse()` 处理邮箱消息中的权限响应

两条路径共享同一套回调注册表和 `parsePermissionUpdates()` 验证逻辑（使用 Zod schema 过滤格式不正确的条目）。

#### 导出的管理函数

| 函数 | 用途 |
|------|------|
| `registerPermissionCallback()` | 注册工具权限回调 |
| `unregisterPermissionCallback()` | 注销回调（超时或本地解决） |
| `hasPermissionCallback()` | 检查是否有待处理回调 |
| `registerSandboxPermissionCallback()` | 注册沙箱权限回调 |
| `hasSandboxPermissionCallback()` | 检查是否有待处理沙箱回调 |
| `clearAllPendingCallbacks()` | 清空所有回调（`/clear` 时调用） |

---

### useInboxPoller — 收件箱轮询与消息路由

> 源码：`src/hooks/useInboxPoller.ts`（969 行）

这是 Swarm 通信的核心枢纽。以 1 秒间隔轮询收件箱，按消息类型分类后路由到不同处理逻辑。

#### 消息分类与路由

每次轮询读取未读消息后，按以下类型分拣到独立队列：

| 消息类型 | 处理侧 | 处理逻辑 |
|----------|---------|----------|
| `permissionRequest` | Leader | 构建 `ToolUseConfirm` 条目加入 UI 审批队列，支持工具特定的审批 UI |
| `permissionResponse` | Worker | 调用 `processMailboxPermissionResponse()` 触发注册的回调 |
| `sandboxPermissionRequest` | Leader | 加入 `workerSandboxPermissions` 队列 + 桌面通知 |
| `sandboxPermissionResponse` | Worker | 调用 `processSandboxPermissionResponse()` 解析结果 |
| `shutdownRequest` | Worker | 透传为普通消息供 UI 渲染 |
| `shutdownApproval` | Leader | 终止 tmux pane、从 team 文件移除队友、取消分配任务、更新 AppState |
| `teamPermissionUpdate` | Worker | 通过 `applyPermissionUpdate()` 应用权限规则变更 |
| `modeSetRequest` | Worker | 仅接受 team-lead 发来的请求，更新本地权限模式 |
| `planApprovalRequest` | Leader | 自动批准并写入响应到队友邮箱 |
| `planApprovalResponse` | Worker | 解析审批结果，批准时退出 plan 模式 |
| 普通消息 | 双侧 | 空闲时直接提交为新 turn，忙碌时入队到 `AppState.inbox` |

#### Leader/Worker 身份判定

```typescript
// src/hooks/useInboxPoller.ts:81-105
function getAgentNameToPoll(appState: AppState): string | undefined
```

- **In-process teammate**：返回 `undefined`（使用独立的 `waitForNextPromptOrShutdown` 机制）
- **Process-based teammate**（tmux）：返回 `CLAUDE_CODE_AGENT_NAME`
- **Team Lead**：返回 lead 名称（默认 `'team-lead'`）
- **独立会话**：返回 `undefined`（不轮询）

#### 消息投递保证

消息标记为已读（`markMessagesAsRead`）仅在消息成功投递或可靠入队到 `AppState.inbox` 之后执行。如果在此之前崩溃，下次轮询会重新读取。空闲时的投递 effect 通过 `inboxMessageCount` 依赖触发，会清理已处理的消息并投递 pending 消息。

#### 安全校验

- Plan 审批响应仅接受 `from === 'team-lead'` 的消息（`src/hooks/useInboxPoller.ts:162`）
- Mode 设置请求同样验证来源为 team-lead（`src/hooks/useInboxPoller.ts:557`）
- 沙箱权限请求验证必要嵌套字段存在（`hostPattern.host`）

---

### useMailboxBridge — 邮箱通信桥接

> 源码：`src/hooks/useMailboxBridge.ts`

轻量桥接 Hook，将 React Context 中的 `Mailbox` 对象桥接到 REPL 的 prompt 提交机制。

#### 工作流程

1. 通过 `useSyncExternalStore` 订阅 `mailbox.revision` 变更
2. 当 `isLoading` 为 false 且有新消息（revision 变化）时，调用 `mailbox.poll()` 取出消息
3. 将消息内容通过 `onSubmitMessage()` 提交为新的对话 turn

与 `useInboxPoller` 的区别：`useMailboxBridge` 处理进程内的 React Context 消息传递，而 `useInboxPoller` 处理基于文件系统的跨进程消息。

---

### useTeammateViewAutoExit — 队友视图自动退出

> 源码：`src/hooks/useTeammateViewAutoExit.ts`

监听当前正在查看的队友任务状态，在以下情况自动退出查看模式：

- 任务从 `tasks` map 中被移除（evicted）
- 队友状态变为 `killed` 或 `failed`
- 队友出现 `error`
- 状态既非 `running`、`completed` 也非 `pending`

**不会**自动退出的情况：队友状态为 `completed`——用户可以继续查看完整对话记录。

性能优化：通过精确的 selector（`s.tasks[s.viewingAgentTaskId]`）仅订阅被查看任务的变更，避免其他队友的流式更新触发重渲染。

---

## 配置项与常量

| 常量 | 值 | 所在文件 | 说明 |
|------|-----|---------|------|
| `HIDE_DELAY_MS` | 5000 | useTasksV2.ts | 全部任务完成后隐藏 UI 的延迟 |
| `DEBOUNCE_MS` | 50 | useTasksV2.ts | 任务列表变更检测的去抖间隔 |
| `FALLBACK_POLL_MS` | 5000 | useTasksV2.ts | 文件系统监听兜底轮询间隔 |
| `DEBOUNCE_MS` | 1000 | useTaskListWatcher.ts | 任务拾取检查的去抖间隔 |
| `POLL_INTERVAL_MS` | 500 | useSwarmPermissionPoller.ts | 权限响应轮询间隔 |
| `INBOX_POLL_INTERVAL_MS` | 1000 | useInboxPoller.ts | 收件箱轮询间隔 |

## 边界 Case 与注意事项

- **任务列表 ID 运行时变更**：`TasksV2Store` 在每次 fetch 时检查 `getTaskListId()`，如果 ID 变更（例如 `TeamCreateTool` 设置了 `leaderTeamName`），自动重新指向新的监听目录。隐藏计时器也会校验 ID 是否与调度时一致
- **Bun PathWatcherManager 死锁**：`useTaskListWatcher` 特别通过 ref 稳定 props，避免 watcher effect 频繁 re-run 导致 `watch/close` 竞态（参考 `oven-sh/bun#27469`）
- **In-process teammate 与 useInboxPoller 互斥**：In-process teammate 不应使用 `useInboxPoller`（它们有自己的 `waitForNextPromptOrShutdown` 机制），否则会因共享 React Context 和 AppState 导致消息路由问题
- **Orphan cron 清理**：`useScheduledTasks` 在触发 cron 时发现目标 teammate 已不存在，会主动删除该 cron 避免反复空触发
- **权限回调泄漏防护**：`clearAllPendingCallbacks()` 在 `/clear` 命令时调用，清除可能残留的过期回调