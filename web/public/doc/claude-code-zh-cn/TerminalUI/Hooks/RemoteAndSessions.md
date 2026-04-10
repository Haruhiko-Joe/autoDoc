# 远程会话与连接管理 Hooks

## 概述与职责

本模块提供了一组 React 自定义 Hooks，负责管理 Claude Code 终端 UI 与各类远程运行时之间的会话连接。它们位于 **TerminalUI → Hooks** 层级中，是 REPL 主屏幕与后端远程基础设施（BridgeAndRemote 模块）之间的桥梁。

这组 Hooks 共有五个，覆盖了三种连接模式、一种会话生命周期管理和一种跨设备迁移能力：

| Hook | 连接方式 | 核心职责 |
|------|----------|----------|
| `useRemoteSession` | WebSocket (CCR) | 与云端运行时的完整双向会话管理 |
| `useSSHSession` | SSH 隧道 | 通过 SSH 子进程连接远程实例 |
| `useDirectConnect` | WebSocket (P2P) | 点对点直连服务器模式 |
| `useSessionBackgrounding` | 本地状态 | 会话后台化（Ctrl+B）和前台恢复 |
| `useTeleportResume` | HTTP API | 跨设备会话迁移（Teleport） |

前三个 Hooks 遵循统一的返回接口 `{ isRemoteMode, sendMessage, cancelRequest, disconnect }`，使 REPL 屏幕可以无差别地消费不同连接模式。

## 关键流程

### 1. useRemoteSession：CCR WebSocket 会话生命周期

这是功能最丰富的连接 Hook（605 行），管理与云端运行时（Cloud Code Runtime）的全双工 WebSocket 会话。

**建连流程：**

1. 当 `config` 非空时，`useEffect` 创建 `RemoteSessionManager` 实例并注册六个回调（`onMessage`、`onPermissionRequest`、`onPermissionCancelled`、`onConnected`、`onReconnecting`、`onDisconnected`）
2. 调用 `manager.connect()` 发起 WebSocket 连接
3. 连接成功后通过 `onConnected` 回调将 `remoteConnectionStatus` 设为 `'connected'`

> 源码位置：`src/hooks/useRemoteSession.ts:146-469`

**消息接收与处理流程（onMessage 回调）：**

1. **心跳重置**：收到任意消息即清除响应超时计时器（包括自身消息的回声），防止误判为无响应（`src/hooks/useRemoteSession.ts:172-175`）
2. **回声过滤**：本地发送的消息会被 WS 回传，通过 `BoundedUUIDSet`（容量 50）识别并丢弃，避免消息重复显示（`src/hooks/useRemoteSession.ts:182-191`）
3. **初始化消息**：`system/init` 类型消息触发 `onInit` 回调，传递可用的 slash commands 列表
4. **子任务跟踪**：`task_started` / `task_notification` 消息维护远程后台任务计数器 `remoteBackgroundTaskCount`，用于 UI 显示"N in background"（`src/hooks/useRemoteSession.ts:208-218`）
5. **压缩状态追踪**：`status='compacting'` 消息标记压缩进行中，超时阈值从 60s 延长到 180s（`src/hooks/useRemoteSession.ts:226-235`）
6. **SDK 消息转换**：通过 `convertSDKMessage()` 将远程消息转为 REPL 可渲染的 `MessageType`，支持完整消息和流式事件两种模式
7. **工具执行状态同步**：`tool_use` 块加入 `inProgressToolUseIDs`，对应 `tool_result` 到达时移除，保持 spinner 状态正确

**消息发送流程（sendMessage）：**

1. 在发送前将 UUID 加入 `sentUUIDsRef` 以过滤后续回声
2. 通过 `manager.sendMessage()` 以 HTTP POST 发送到 CCR
3. 首次发送（无初始 prompt 的会话）异步生成并更新会话标题
4. 非 viewerOnly 模式下启动响应超时计时器（60s 正常 / 180s 压缩中），超时触发警告消息和 WebSocket 重连

> 源码位置：`src/hooks/useRemoteSession.ts:472-566`

**权限请求流程（onPermissionRequest 回调）：**

1. 通过 `findToolByName` 查找本地 Tool 定义，找不到时创建 stub
2. 构造合成的 `assistantMessage` 和 `ToolUseConfirm` 对象
3. 加入 `toolUseConfirmQueue` 触发 UI 权限弹窗
4. 用户操作（allow/reject/abort）通过 `manager.respondToPermissionRequest()` 回传给 CCR

> 源码位置：`src/hooks/useRemoteSession.ts:330-416`

**重连与断开：**

- `onReconnecting`：清空远程任务计数和工具执行状态（因 WS 间隙可能丢失事件），宁可少算不多算
- `onDisconnected`：停止加载、清空状态
- 组件卸载时调用 `manager.disconnect()` 并清除超时计时器

### 2. useSSHSession：SSH 隧道会话

与 `useRemoteSession` 功能相似，但驱动的是一个预先创建的 SSH 子进程而非 WebSocket。SSH 进程和认证代理在 `main.tsx` 启动阶段创建，作为 `SSHSession` 对象传入本 Hook。

**核心差异点：**

- 不自行创建连接——接收外部传入的 `SSHSession` 并调用 `session.createManager()` 构建管理器
- 重连时向 UI 注入警告系统消息 `"SSH connection dropped — reconnecting (attempt N/M)..."`（`src/hooks/useSSHSession.ts:162-181`）
- 断开时读取 SSH 进程的 stderr 尾部输出，作为诊断信息显示，然后触发 `gracefulShutdown`（`src/hooks/useSSHSession.ts:182-198`）
- 取消请求通过 `manager.sendInterrupt()` 发送中断信号
- 组件卸载时额外停止认证代理 `session.proxy.stop()`
- 跳过重复的 init 消息（SSH stream-json 模式每轮都发一次）

> 源码位置：`src/hooks/useSSHSession.ts:48-241`

### 3. useDirectConnect：点对点直连

最简洁的连接 Hook（230 行），通过 `DirectConnectSessionManager` 建立与直连服务器的 WebSocket 连接。

**与 useRemoteSession 的关键差异：**

- 没有回声过滤（不需要 `sentUUIDsRef`）
- 没有响应超时检测
- 没有会话标题更新
- 没有远程任务计数跟踪
- 没有流式事件处理
- 断开连接时直接触发 `gracefulShutdown`，区分"从未连接成功"（连接失败）和"连接后断开"（服务器退出）两种场景（`src/hooks/useDirectConnect.ts:165-178`）

> 源码位置：`src/hooks/useDirectConnect.ts:39-229`

### 4. useSessionBackgrounding：会话后台化与恢复

管理 Ctrl+B 触发的会话后台化和前台恢复，与后台任务系统交互。

**后台化流程（handleBackgroundSession）：**

- **已前台化任务存在时**：将当前前台任务重新标记为 `isBackgrounded: true`，清空消息列表和加载状态，回到主 REPL 视图（`src/hooks/useSessionBackgrounding.ts:41-63`）
- **无前台化任务时**：调用 `onBackgroundQuery()` 将当前正在进行的查询转为后台任务

**前台化同步（useEffect）：**

1. 监听 `foregroundedTaskId` 和对应 task 的变化
2. 仅同步 `local_agent` 类型的任务，其他类型直接清除前台状态
3. 通过 `lastSyncedMessagesLengthRef` 做增量对比，仅在消息数量变化时更新 `setMessages`，避免冗余渲染
4. 运行中的任务：同步加载状态和 abort controller（支持 Escape 取消）
5. 如果任务已被 abort，立即恢复到后台
6. 任务完成后自动还原为后台任务并清理前台视图

> 源码位置：`src/hooks/useSessionBackgrounding.ts:27-158`

### 5. useTeleportResume：跨设备会话迁移

处理 Teleport 功能——在不同设备间迁移（恢复）一个已有的 Code Session。

**恢复流程：**

1. 接收一个 `CodeSession` 对象，设置加载状态
2. 记录分析事件 `tengu_teleport_resume_session`（含 source 和 session_id）
3. 调用 `teleportResumeCodeSession(session.id)` 执行实际迁移
4. 成功后通过 `setTeleportedSessionInfo` 记录迁移信息用于后续可靠性日志
5. 失败时区分 `TeleportOperationError`（业务错误，含格式化消息）和通用错误

> 源码位置：`src/hooks/useTeleportResume.tsx:1-84`

**返回值：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `resumeSession` | `(session: CodeSession) => Promise<TeleportRemoteResponse \| null>` | 执行迁移 |
| `isResuming` | `boolean` | 是否正在迁移中 |
| `error` | `TeleportResumeError \| null` | 错误信息 |
| `selectedSession` | `CodeSession \| null` | 当前选中的会话 |
| `clearError` | `() => void` | 清除错误状态 |

注意：该文件是 React Compiler 编译后的产物，使用了 `_c()` 缓存运行时，但逻辑等价于标准的 `useCallback` + `useState` 组合。

## 函数签名与参数说明

### `useRemoteSession(props: UseRemoteSessionProps): UseRemoteSessionResult`

| 参数 | 类型 | 说明 |
|------|------|------|
| `config` | `RemoteSessionConfig \| undefined` | CCR 连接配置，undefined 时禁用远程模式 |
| `setMessages` | `React.Dispatch<SetStateAction<MessageType[]>>` | 消息列表 setter |
| `setIsLoading` | `(loading: boolean) => void` | 加载状态 setter |
| `onInit` | `(slashCommands: string[]) => void` | 初始化回调，接收可用 slash commands |
| `setToolUseConfirmQueue` | `React.Dispatch<SetStateAction<ToolUseConfirm[]>>` | 权限确认队列 setter |
| `tools` | `Tool[]` | 本地工具列表，用于权限请求时查找 Tool 定义 |
| `setStreamingToolUses` | `React.Dispatch<SetStateAction<StreamingToolUse[]>>` | 流式工具使用状态 setter |
| `setStreamMode` | `React.Dispatch<SetStateAction<SpinnerMode>>` | Spinner 模式 setter |
| `setInProgressToolUseIDs` | `(f: (prev: Set<string>) => Set<string>) => void` | 正在执行的工具 ID 集合更新器 |

### `useSSHSession(props: UseSSHSessionProps): UseSSHSessionResult`

| 参数 | 类型 | 说明 |
|------|------|------|
| `session` | `SSHSession \| undefined` | 预创建的 SSH 会话对象 |
| `setMessages` | `React.Dispatch<SetStateAction<MessageType[]>>` | 消息列表 setter |
| `setIsLoading` | `(loading: boolean) => void` | 加载状态 setter |
| `setToolUseConfirmQueue` | `React.Dispatch<SetStateAction<ToolUseConfirm[]>>` | 权限确认队列 setter |
| `tools` | `Tool[]` | 本地工具列表 |

### `useDirectConnect(props: UseDirectConnectProps): UseDirectConnectResult`

| 参数 | 类型 | 说明 |
|------|------|------|
| `config` | `DirectConnectConfig \| undefined` | 直连配置（含 `wsUrl`） |
| `setMessages` | `React.Dispatch<SetStateAction<MessageType[]>>` | 消息列表 setter |
| `setIsLoading` | `(loading: boolean) => void` | 加载状态 setter |
| `setToolUseConfirmQueue` | `React.Dispatch<SetStateAction<ToolUseConfirm[]>>` | 权限确认队列 setter |
| `tools` | `Tool[]` | 本地工具列表 |

### `useSessionBackgrounding(props: UseSessionBackgroundingProps): UseSessionBackgroundingResult`

| 参数 | 类型 | 说明 |
|------|------|------|
| `setMessages` | `(messages: Message[] \| ((prev: Message[]) => Message[])) => void` | 消息 setter |
| `setIsLoading` | `(loading: boolean) => void` | 加载状态 setter |
| `resetLoadingState` | `() => void` | 重置加载状态 |
| `setAbortController` | `(controller: AbortController \| null) => void` | 中止控制器 setter |
| `onBackgroundQuery` | `() => void` | 将当前查询转为后台任务的回调 |

### `useTeleportResume(source: TeleportSource)`

- `source`：`'cliArg' | 'localCommand'`——迁移触发来源，用于分析事件

## 类型定义

### `TeleportResumeError`

```typescript
type TeleportResumeError = {
  message: string              // 错误信息
  formattedMessage?: string    // 格式化的错误信息（仅 TeleportOperationError）
  isOperationError: boolean    // 是否为业务级操作错误
}
```

### `TeleportSource`

```typescript
type TeleportSource = 'cliArg' | 'localCommand'
```

## 配置项与默认值

| 常量 | 值 | 位置 | 说明 |
|------|----|------|------|
| `RESPONSE_TIMEOUT_MS` | 60000 (60s) | `useRemoteSession.ts:37` | 正常模式下的响应超时阈值 |
| `COMPACTION_TIMEOUT_MS` | 180000 (3min) | `useRemoteSession.ts:41` | 压缩期间的扩展超时阈值 |
| `BoundedUUIDSet` 容量 | 50 | `useRemoteSession.ts:137` | 回声过滤环形缓冲区大小 |

## 边界 Case 与注意事项

- **消息回声可多次到达**：同一 UUID 的用户消息可能被服务器广播和 worker 回写各回传一次，因此使用 `BoundedUUIDSet`（不在首次匹配时删除）而非普通 Set 来过滤（`src/hooks/useRemoteSession.ts:126-137`）

- **viewerOnly 模式的特殊处理**：`useRemoteSession` 在 viewerOnly 模式下跳过响应超时检测、不发送中断信号、不更新会话标题——因为远程 agent 可能处于空闲关闭状态，唤醒需要超过 60s

- **WS 重连时的状态清理**：重连会清空远程任务计数和工具执行状态集合，宁可暂时少算也不让状态永久漂移（`src/hooks/useRemoteSession.ts:424-430`）

- **SSH 断开即退出**：`useSSHSession` 在 SSH 进程退出后直接调用 `gracefulShutdown(1)`，不尝试恢复——与 WebSocket 的自动重连策略不同

- **直连断开即退出**：`useDirectConnect` 同样在断开时触发 `gracefulShutdown(1)`，但区分了连接前失败和运行中断开两种错误消息

- **前台化仅支持 local_agent**：`useSessionBackgrounding` 仅同步 `type === 'local_agent'` 的任务消息到主视图，其他类型直接清除前台状态

- **useTeleportResume 是编译产物**：`useTeleportResume.tsx` 文件是 React Compiler 编译后的输出（含 `_c()` 缓存运行时），原始逻辑等价于标准 `useCallback`/`useState` 用法