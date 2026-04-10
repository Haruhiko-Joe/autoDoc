# 类型定义与接口抽象层（TypesAndInterfaces）

## 概述与职责

本模块是 Swarm 多 Agent 协调子系统中 **Backends** 层的类型基础，定义了终端后端的完整抽象体系。它位于 `Infrastructure → FeatureUtilities → Swarm → Backends` 层级路径上，为同级的三种后端实现（TmuxBackend、ITermBackend、InProcessBackend）以及 registry 自动检测、PaneBackendExecutor 适配器提供统一的类型契约。

该文件不包含任何业务逻辑实现，纯粹定义类型标识、数据结构和接口抽象，是整个 Backends 子系统的"接口契约层"。

## 关键流程

### 两层抽象体系

本模块定义了两个层次的抽象接口，理解这一分层是理解整个 Backends 架构的关键：

1. **PaneBackend（底层）**：面向终端分屏操作——创建 Pane、发送命令、设置边框颜色/标题、隐藏/显示/销毁 Pane、重排布局。仅适用于 `tmux` 和 `iterm2` 两种基于终端分屏的后端。
2. **TeammateExecutor（高层）**：面向 Teammate 生命周期管理——spawn、sendMessage、terminate、kill、isActive。覆盖所有三种后端类型（包括 `in-process`）。

在实际架构中，`PaneBackendExecutor` 适配器将 `PaneBackend` 包装为 `TeammateExecutor`，使得上层调用方无需关心底层是哪种后端。

### 类型标识的层次关系

```
BackendType = 'tmux' | 'iterm2' | 'in-process'   ← 全部三种后端
PaneBackendType = 'tmux' | 'iterm2'                ← 仅基于终端分屏的后端
```

`isPaneBackend()` 类型守卫用于在运行时区分这两个集合，使调用方可以安全地进行类型收窄。

## 接口/类型定义

### `BackendType`（`src/utils/swarm/backends/types.ts:9`）

后端类型的联合类型标识：

| 值 | 含义 |
|---|---|
| `'tmux'` | 使用 tmux 管理分屏 |
| `'iterm2'` | 使用 iTerm2 原生分屏（通过 it2 CLI） |
| `'in-process'` | 同进程内隔离执行（AsyncLocalStorage） |

### `PaneBackendType`（`src/utils/swarm/backends/types.ts:15`）

`BackendType` 的子集，仅包含 `'tmux' | 'iterm2'`，用于需要明确排除 `in-process` 的场景。

### `PaneId`（`src/utils/swarm/backends/types.ts:22`）

Pane 的不透明标识符（`string` 类型别名）。对于 tmux 是 pane ID（如 `"%1"`），对于 iTerm2 是 session ID。

### `CreatePaneResult`（`src/utils/swarm/backends/types.ts:27-32`）

创建 Pane 的返回结果：

| 字段 | 类型 | 说明 |
|------|------|------|
| `paneId` | `PaneId` | 新创建的 Pane 标识 |
| `isFirstTeammate` | `boolean` | 是否为第一个 Teammate Pane（影响布局策略） |

### `PaneBackend` 接口（`src/utils/swarm/backends/types.ts:39-168`）

终端分屏后端的核心接口，定义了所有 Pane 管理操作：

**只读属性：**

| 属性 | 类型 | 说明 |
|------|------|------|
| `type` | `BackendType` | 后端类型标识 |
| `displayName` | `string` | 人类可读的显示名称 |
| `supportsHideShow` | `boolean` | 是否支持隐藏/显示 Pane |

**方法：**

| 方法 | 签名 | 说明 |
|------|------|------|
| `isAvailable()` | `() → Promise<boolean>` | 检查后端是否在当前系统可用 |
| `isRunningInside()` | `() → Promise<boolean>` | 检查是否在该后端环境内运行 |
| `createTeammatePaneInSwarmView` | `(name, color) → Promise<CreatePaneResult>` | 在 Swarm 视图中创建 Teammate Pane |
| `sendCommandToPane` | `(paneId, command, useExternalSession?) → Promise<void>` | 向指定 Pane 发送执行命令 |
| `setPaneBorderColor` | `(paneId, color, useExternalSession?) → Promise<void>` | 设置 Pane 边框颜色 |
| `setPaneTitle` | `(paneId, name, color, useExternalSession?) → Promise<void>` | 设置 Pane 标题 |
| `enablePaneBorderStatus` | `(windowTarget?, useExternalSession?) → Promise<void>` | 启用 Pane 边框状态显示 |
| `rebalancePanes` | `(windowTarget, hasLeader) → Promise<void>` | 重新排列 Pane 布局 |
| `killPane` | `(paneId, useExternalSession?) → Promise<boolean>` | 销毁指定 Pane |
| `hidePane` | `(paneId, useExternalSession?) → Promise<boolean>` | 隐藏 Pane（仍在运行但不可见） |
| `showPane` | `(paneId, targetWindowOrPane, useExternalSession?) → Promise<boolean>` | 显示之前被隐藏的 Pane |

多个方法包含 `useExternalSession` 可选参数，这是 tmux 特有的概念——用于区分是否通过外部 session socket 操作（在外部 swarm session 模式下使用）。

### `BackendDetectionResult`（`src/utils/swarm/backends/types.ts:173-180`）

后端自动检测的结果类型：

| 字段 | 类型 | 说明 |
|------|------|------|
| `backend` | `PaneBackend` | 应使用的后端实例 |
| `isNative` | `boolean` | 是否在该后端的原生环境内运行 |
| `needsIt2Setup?` | `boolean` | 检测到 iTerm2 但 it2 CLI 未安装时为 `true` |

### `TeammateIdentity`（`src/utils/swarm/backends/types.ts:191-200`）

Teammate 的身份标识字段，是 `TeammateSpawnConfig` 的基类型，也与 `TeammateContext`（定义在 TeammateLifecycle 模块中）共享子集以避免循环依赖：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | Agent 名称（如 `"researcher"`、`"tester"`） |
| `teamName` | `string` | 所属团队名称 |
| `color?` | `AgentColorName` | UI 颜色标识 |
| `planModeRequired?` | `boolean` | 是否要求 Plan Mode 审批后才实施 |

### `TeammateSpawnConfig`（`src/utils/swarm/backends/types.ts:205-225`）

创建 Teammate 的完整配置，继承自 `TeammateIdentity`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `prompt` | `string` | 初始提示词 |
| `cwd` | `string` | 工作目录 |
| `model?` | `string` | 使用的模型 |
| `systemPrompt?` | `string` | 系统提示词 |
| `systemPromptMode?` | `'default' \| 'replace' \| 'append'` | 系统提示词应用方式 |
| `worktreePath?` | `string` | Git worktree 路径 |
| `parentSessionId` | `string` | 父会话 ID |
| `permissions?` | `string[]` | 授予的工具权限列表 |
| `allowPermissionPrompts?` | `boolean` | 是否允许弹出权限确认（默认 `false`，即未列出的工具自动拒绝） |

### `TeammateSpawnResult`（`src/utils/swarm/backends/types.ts:230-254`）

创建 Teammate 的返回结果：

| 字段 | 类型 | 适用场景 | 说明 |
|------|------|----------|------|
| `success` | `boolean` | 通用 | 是否成功 |
| `agentId` | `string` | 通用 | 唯一标识，格式为 `agentName@teamName` |
| `error?` | `string` | 通用 | 失败时的错误信息 |
| `abortController?` | `AbortController` | 仅 in-process | Leader 用于取消/终止 Teammate |
| `taskId?` | `string` | 仅 in-process | AppState.tasks 中的任务 ID，用于 UI 渲染 |
| `paneId?` | `PaneId` | 仅 pane-based | 终端 Pane 标识 |

注意 `agentId` 是逻辑标识符，`taskId` 是 AppState 索引用的标识——两者用途不同。

### `TeammateMessage`（`src/utils/swarm/backends/types.ts:259-270`）

Teammate 间消息的数据结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `text` | `string` | 消息内容 |
| `from` | `string` | 发送者 Agent ID |
| `color?` | `string` | 发送者显示颜色 |
| `timestamp?` | `string` | ISO 格式时间戳 |
| `summary?` | `string` | 5-10 字摘要，用于 UI 预览 |

### `TeammateExecutor` 接口（`src/utils/swarm/backends/types.ts:279-300`）

高层 Teammate 生命周期管理接口，统一了所有三种后端的操作：

| 方法 | 签名 | 说明 |
|------|------|------|
| `isAvailable()` | `() → Promise<boolean>` | 检查执行器是否可用 |
| `spawn` | `(config: TeammateSpawnConfig) → Promise<TeammateSpawnResult>` | 创建并启动 Teammate |
| `sendMessage` | `(agentId, message: TeammateMessage) → Promise<void>` | 向 Teammate 发送消息 |
| `terminate` | `(agentId, reason?) → Promise<boolean>` | 优雅终止（发送关闭请求） |
| `kill` | `(agentId) → Promise<boolean>` | 强制终止（立即停止） |
| `isActive` | `(agentId) → Promise<boolean>` | 检查 Teammate 是否仍在运行 |

## 类型守卫

### `isPaneBackend(type)`（`src/utils/swarm/backends/types.ts:309-311`）

```typescript
export function isPaneBackend(type: BackendType): type is 'tmux' | 'iterm2' {
  return type === 'tmux' || type === 'iterm2'
}
```

运行时类型守卫，判断给定的 `BackendType` 是否为基于终端分屏的后端。返回 `true` 时 TypeScript 会将类型收窄为 `PaneBackendType`（即 `'tmux' | 'iterm2'`），使调用方可以安全访问 Pane 相关操作。

## 外部依赖

本模块唯一的外部导入是 `AgentColorName`（来自 `src/tools/AgentTool/agentColorManager.ts`），用于 Pane 边框颜色和 Teammate 身份颜色标识。这是一个颜色名称的字符串联合类型。

## 边界 Case 与注意事项

- **`TeammateIdentity` 与循环依赖**：该类型被显式标注为 `TeammateContext` 的共享子集，目的是避免与 TeammateLifecycle 模块产生循环导入。如需在 Teammate 身份信息上扩展字段，应优先在此处添加。
- **`useExternalSession` 参数**：多个 `PaneBackend` 方法携带此可选参数，它仅对 tmux 后端有意义（控制是否使用外部 session socket）。iTerm2 后端实现时应忽略此参数。
- **`TeammateSpawnResult` 的条件字段**：`abortController` 和 `taskId` 仅在 in-process 模式下有值，`paneId` 仅在 pane-based 模式下有值。调用方应结合 `BackendType` 判断哪些字段可用。
- **`allowPermissionPrompts` 默认行为**：默认为 `false`，意味着未在 `permissions` 列表中明确授权的工具会被自动拒绝，Teammate 不会弹出权限确认弹窗。这是出于安全考虑的保守默认值。