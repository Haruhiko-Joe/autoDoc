# TmuxBackend

## 概述与职责

TmuxBackend 是 Swarm 多 Agent 协调系统中的 **tmux 终端后端实现**，负责通过 tmux 命令行工具管理 Teammate 的终端分屏窗格（Pane）。它实现了 `PaneBackend` 接口的全部方法，是三种后端之一（另外两种是 ITermBackend 和 InProcessBackend）。

在整体架构中，TmuxBackend 位于 **Infrastructure → FeatureUtilities → Swarm → Backends** 层级。它与同级的 ITermBackend、InProcessBackend 共同构成后端抽象层，由 `registry.ts` 根据运行环境自动选择。上层的 `PaneBackendExecutor` 适配器将 PaneBackend 包装为统一的 `TeammateExecutor` 接口，供 TeammateLifecycle 调用。

该模块通过**文件末尾的副作用调用** `registerTmuxBackend(TmuxBackend)` 完成自注册——当模块被 import 时自动将自己注册到 registry，避免循环依赖（`TmuxBackend.ts:762-764`）。

## 关键流程

### 两种运行模式

TmuxBackend 根据 Leader 进程是否运行在 tmux 内，自动选择不同的分屏策略：

**内部模式（Inside tmux）**：Leader 已在用户的 tmux 会话中运行
- Leader 占据左侧 **30%** 宽度
- 所有 Teammate 共享右侧 **70%** 区域
- 使用 `main-vertical` 布局，Leader 为主窗格
- 通过 `runTmuxInUserSession()` 直接操作用户的 tmux 会话

**外部模式（Outside tmux）**：Leader 在普通终端中运行
- 创建独立的 `claude-swarm` session 和 `swarm-view` window
- 所有 Teammate 使用 `tiled` 等分布局，没有 Leader 窗格
- 通过 `runTmuxInSwarm()` 操作隔离的 swarm socket（`claude-swarm-<PID>`），避免与用户已有 tmux 会话冲突

### Pane 创建流程

`createTeammatePaneInSwarmView()` 是创建 Teammate 窗格的入口方法（`TmuxBackend.ts:129-146`）：

1. **获取锁** — 调用 `acquirePaneCreationLock()` 防止并行创建导致竞态
2. **检测模式** — 调用 `isRunningInside()` 判断当前是内部模式还是外部模式
3. **分派创建** — 内部模式调用 `createTeammatePaneWithLeader()`，外部模式调用 `createTeammatePaneExternal()`
4. **释放锁** — 在 `finally` 块中释放锁，确保异常时也能释放

#### 内部模式创建细节（`createTeammatePaneWithLeader`，`TmuxBackend.ts:551-630`）

- **第一个 Teammate**：从 Leader 窗格水平分屏（`split-window -h -l 70%`），Teammate 占右侧 70%
- **后续 Teammate**：采用交替分屏策略——奇数个时垂直分屏（`-v`），偶数个时水平分屏（`-h`），目标窗格通过 `Math.floor((teammateCount - 1) / 2)` 计算索引
- 创建后依次设置边框颜色、标题，并调用 `rebalancePanesWithLeader()` 重新布局
- 等待 200ms Shell 初始化延迟后返回

#### 外部模式创建细节（`createTeammatePaneExternal`，`TmuxBackend.ts:635-702`）

- 调用 `createExternalSwarmSession()` 确保 `claude-swarm` session 存在
- **第一个 Teammate**：复用 session 创建时自带的初始窗格，通过 `firstPaneUsedForExternal` 标志位追踪
- **后续 Teammate**：采用与内部模式相同的交替分屏策略
- 使用 `tiled` 布局均分所有窗格

### Pane 创建锁机制

模块级变量 `paneCreationLock` 实现了一个基于 Promise 链的串行锁（`TmuxBackend.ts:29-53`）：

```typescript
// src/utils/swarm/backends/TmuxBackend.ts:43-53
function acquirePaneCreationLock(): Promise<() => void> {
  let release: () => void
  const newLock = new Promise<void>(resolve => {
    release = resolve
  })
  const previousLock = paneCreationLock
  paneCreationLock = newLock
  return previousLock.then(() => release!)
}
```

每次调用 `acquirePaneCreationLock()` 会将自己挂到前一个 Promise 之后。调用方拿到 `release` 函数后在 `finally` 中释放，保证即使多个 Teammate 并行 spawn，窗格创建也严格顺序执行。这避免了 tmux 在同一 window 中并发 `split-window` 时可能产生的竞态问题。

### Hide/Show 机制

TmuxBackend 声明 `supportsHideShow = true`，通过 tmux 原生的 `break-pane` 和 `join-pane` 命令实现窗格的隐藏与恢复：

**隐藏（`hidePane`，`TmuxBackend.ts:281-306`）**：
1. 创建名为 `claude-hidden` 的后台 session（如果不存在）
2. 使用 `break-pane -d` 将目标窗格移入 hidden session，窗格内进程不中断

**恢复（`showPane`，`TmuxBackend.ts:313-361`）**：
1. 使用 `join-pane -h` 将窗格从 hidden session 移回目标窗口
2. 重新应用 `main-vertical` 布局
3. 将第一个窗格（Leader）调整为 30% 宽度

### 布局 Rebalance

两种布局策略：

- **`rebalancePanesWithLeader()`**（`TmuxBackend.ts:707-734`）：应用 `main-vertical` 布局，Leader（第一个 pane）固定 30% 宽度，仅在窗格数 > 2 时触发
- **`rebalancePanesTiled()`**（`TmuxBackend.ts:739-758`）：应用 `tiled` 布局均分所有窗格，仅在窗格数 > 1 时触发

## 函数签名与参数说明

### 公开方法（PaneBackend 接口实现）

#### `isAvailable(): Promise<boolean>`
检查系统是否安装了 tmux，委托给 `detection.ts` 的 `isTmuxAvailable()`。

#### `isRunningInside(): Promise<boolean>`
检查当前进程是否在 tmux session 内运行，基于启动时捕获的 `TMUX` 环境变量判断。

#### `createTeammatePaneInSwarmView(name: string, color: AgentColorName): Promise<CreatePaneResult>`
创建 Teammate 窗格的主入口。返回值包含 `paneId`（tmux 窗格 ID，如 `%1`）和 `isFirstTeammate` 标志。

#### `sendCommandToPane(paneId: PaneId, command: string, useExternalSession?: boolean): Promise<void>`
通过 `tmux send-keys` 向指定窗格发送命令。

#### `setPaneBorderColor(paneId: PaneId, color: AgentColorName, useExternalSession?: boolean): Promise<void>`
设置窗格边框颜色。通过 `select-pane -P` 和 `set-option -p` 分别设置窗格前景色和边框样式（需要 tmux 3.2+）。

#### `setPaneTitle(paneId: PaneId, name: string, color: AgentColorName, useExternalSession?: boolean): Promise<void>`
设置窗格标题和带颜色的 `pane-border-format`，在边框顶部显示 Teammate 名称。

#### `enablePaneBorderStatus(windowTarget?: string, useExternalSession?: boolean): Promise<void>`
启用目标窗口的 `pane-border-status`（设为 `top`），使窗格标题在边框顶部可见。

#### `rebalancePanes(windowTarget: string, hasLeader: boolean): Promise<void>`
根据 `hasLeader` 参数分派到 `rebalancePanesWithLeader()` 或 `rebalancePanesTiled()`。

#### `killPane(paneId: PaneId, useExternalSession?: boolean): Promise<boolean>`
关闭指定窗格（`tmux kill-pane`）。

#### `hidePane(paneId: PaneId, useExternalSession?: boolean): Promise<boolean>`
将窗格移入隐藏 session。

#### `showPane(paneId: PaneId, targetWindowOrPane: string, useExternalSession?: boolean): Promise<boolean>`
将隐藏窗格移回目标窗口。

### 模块级辅助函数

#### `getTmuxColorName(color: AgentColorName): string`
将 Agent 颜色名映射到 tmux 内置颜色名（`TmuxBackend.ts:59-71`）。映射关系：`purple → magenta`，`orange → colour208`，`pink → colour205`，其余同名。

#### `runTmuxInUserSession(args: string[]): Promise<{stdout, stderr, code}>`
在用户原始 tmux session 中执行命令，无 socket 覆盖。

#### `runTmuxInSwarm(args: string[]): Promise<{stdout, stderr, code}>`
在外部 swarm socket（`claude-swarm-<PID>`）中执行命令，通过 `-L` 参数指定隔离的 socket 名。

#### `waitForPaneShellReady(): Promise<void>`
等待 200ms（`PANE_SHELL_INIT_DELAY_MS`），让新窗格中的 Shell 完成初始化（加载 rc 文件、提示符等），确保后续 `send-keys` 命令能被正确接收。

## 接口/类型定义

### `PaneBackend`（来自 `types.ts`）

TmuxBackend 实现的核心接口，定义了所有窗格管理操作。关键属性：
- `type: BackendType` — 后端类型标识，TmuxBackend 为 `'tmux'`
- `displayName: string` — 显示名称，为 `'tmux'`
- `supportsHideShow: boolean` — 是否支持隐藏/显示，TmuxBackend 为 `true`

### `CreatePaneResult`（来自 `types.ts`）

| 字段 | 类型 | 说明 |
|------|------|------|
| paneId | PaneId (string) | tmux 窗格 ID，如 `%0`、`%1` |
| isFirstTeammate | boolean | 是否为当前窗口的第一个 Teammate |

### `AgentColorName`（来自 `agentColorManager.ts`）

支持的颜色值：`red`、`blue`、`green`、`yellow`、`purple`、`orange`、`pink`、`cyan`。

## 配置项与默认值

| 配置 | 值 | 说明 |
|------|------|------|
| `PANE_SHELL_INIT_DELAY_MS` | 200 | 窗格创建后等待 Shell 初始化的毫秒数 |
| `SWARM_SESSION_NAME` | `'claude-swarm'` | 外部模式下创建的 tmux session 名 |
| `SWARM_VIEW_WINDOW_NAME` | `'swarm-view'` | 外部模式下的 window 名 |
| `HIDDEN_SESSION_NAME` | `'claude-hidden'` | 隐藏窗格所在的 session 名 |
| `TMUX_COMMAND` | `'tmux'` | tmux 可执行文件名 |
| Swarm socket 名 | `claude-swarm-<PID>` | 外部模式使用的隔离 socket，包含进程 PID 避免多实例冲突 |
| Leader 窗格宽度 | 30% | 内部模式下 Leader 占窗口宽度的比例 |
| 首个 Teammate 宽度 | 70% | 内部模式下首个 Teammate 的初始分屏比例 |

## 边界 Case 与注意事项

- **tmux 版本要求**：`setPaneBorderColor()` 使用 `set-option -p`（per-pane 选项），需要 **tmux 3.2+**
- **TMUX 环境变量覆盖**：`detection.ts` 在模块加载时捕获 `process.env.TMUX` 和 `process.env.TMUX_PANE` 的原始值，因为 `Shell.ts` 后续可能会覆盖这些环境变量。TmuxBackend 通过 `getLeaderPaneId()` 使用启动时的快照值
- **Leader 窗口缓存**：`cachedLeaderWindowTarget` 在首次查询后缓存，因为 Leader 的窗口在生命周期内不会改变。但如果用户手动移动了 Leader 窗格，缓存不会失效
- **首个窗格复用**：外部模式下，`createExternalSwarmSession()` 创建 session 时会自带一个初始窗格。第一个 Teammate 直接复用这个窗格（通过 `firstPaneUsedForExternal` 标志追踪），避免创建空窗格浪费
- **分屏策略**：多个 Teammate 的分屏采用交替水平/垂直分屏策略（`teammateCount % 2 === 1` 时垂直分，否则水平分），并选择中间位置的窗格作为分屏目标，使窗格大小尽量均匀
- **模块级状态**：`firstPaneUsedForExternal`、`cachedLeaderWindowTarget`、`paneCreationLock` 三个模块级变量在进程生命周期内持续有效，不会被重置。这意味着同一进程内不支持多次初始化 swarm