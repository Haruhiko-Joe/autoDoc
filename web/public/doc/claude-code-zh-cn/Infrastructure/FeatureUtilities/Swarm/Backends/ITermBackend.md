# ITermBackend — iTerm2 原生分屏后端

## 概述与职责

`ITermBackend` 是 Swarm 多 Agent 协调系统中的终端分屏后端之一，负责通过 `it2` CLI 工具驱动 iTerm2 的 Python API，实现 Teammate 窗格的创建、命令发送和生命周期管理。

**在架构中的位置**：Infrastructure → FeatureUtilities → Swarm → Backends。它与 `TmuxBackend`、`InProcessBackend` 是同级兄弟后端，均实现 `PaneBackend` 接口（定义于 `types.ts`）。后端选择由 `registry.ts` 根据运行环境自动检测：tmux 内优先 → iTerm2+it2 → tmux 外部 → in-process 回退。

> 源码位置：`src/utils/swarm/backends/ITermBackend.ts`（370 行）

## 关键流程

### 模块加载与自注册

模块在被 import 时，会在文件末尾通过副作用调用 `registerITermBackend(ITermBackend)` 将自身注册到 `registry.ts` 的后端注册表中（`ITermBackend.ts:369-370`）。这种自注册模式是为了**避免循环依赖**——registry 不需要直接 import 各后端模块。

### 可用性检测

`isAvailable()` 执行两步检测（`ITermBackend.ts:87-99`）：

1. 调用 `isInITerm2()` 检查环境变量（`TERM_PROGRAM`、`ITERM_SESSION_ID`、`env.terminal`）判断是否在 iTerm2 中运行
2. 调用 `isIt2CliAvailable()` 执行 `it2 session list` 验证 it2 CLI 可用**且** Python API 已启用（注意：不用 `--version`，因为它在 Python API 禁用时也会成功）

### Pane 创建流程（核心）

`createTeammatePaneInSwarmView()` 是最核心的方法（`ITermBackend.ts:114-240`），包含锁机制、布局策略和死 session 自动修剪三个关键设计。

**布局策略**：
- **首个 Teammate**：从 Leader session 发起**垂直分屏**（`-v`），Leader 在左，Teammate 在右
- **后续 Teammate**：从最后一个 Teammate session 发起**水平分屏**（默认），在右侧纵向堆叠

**执行步骤**：

1. **获取 Pane 创建锁**——通过 `acquirePaneCreationLock()` 串行化并发创建请求（`ITermBackend.ts:121`）
2. **确定分屏目标**：
   - 首个 Teammate：从 `ITERM_SESSION_ID` 环境变量提取 Leader 的 session UUID（格式 `wXtYpZ:UUID`，取冒号后部分），使用 `-s` 标志精确指定分屏来源
   - 后续 Teammate：从 `teammateSessionIds` 数组取最后一个 session ID 作为目标
3. **执行分屏**：调用 `it2 session split [-v] [-s <sessionId>]`
4. **解析结果**：从输出 `"Created new pane: <session-id>"` 中提取新 pane 的 session ID（`parseSplitOutput()`，`ITermBackend.ts:50-56`）
5. **记录 session ID**：将新 ID 推入 `teammateSessionIds` 数组供后续分屏使用

**死 session 检测与自动修剪**（`ITermBackend.ts:179-207`）：

当分屏命令对某个 Teammate session 失败时（用户可能通过 Cmd+W 关闭了窗格），执行以下恢复逻辑：

1. 调用 `it2 session list` 确认目标 session 是否真的不存在
2. **仅在确认目标已死时**才修剪——如果 `session list` 本身失败（Python API 关闭、socket 错误等系统性故障），**不修剪**，避免误删有效 ID 导致状态损坏
3. 修剪后将 `teammateSessionIds` 中对应 ID 移除
4. 若修剪后数组为空，重置 `firstPaneUsed = false`，回到"从 Leader 分屏"模式
5. 自动 `continue` 重试

复杂度分析：修剪重试循环有界为 **O(N+1)**——每次 `continue` 至少移除一个 session ID，当数组清空后下一轮迭代必然走不同分支终止。

### 命令发送

`sendCommandToPane()` 通过 `it2 session run -s <paneId> <command>` 向指定窗格发送命令（`ITermBackend.ts:245-264`）。始终使用 `-s` 标志精确定位目标 session，确保即使用户切换了窗口焦点也能正确送达。

### Pane 关闭

`killPane()` 调用 `it2 session close -f -s <paneId>`（`ITermBackend.ts:320-339`）。`-f`（force）标志是必需的——没有它，iTerm2 会遵循"关闭前确认"偏好设置，在 session 有运行进程时弹出对话框或拒绝关闭。关闭后无论成功与否都会清理 `teammateSessionIds` 中的 ID，因为 pane 可能已被用户手动关闭。

## 函数签名与参数说明

### 模块级函数

#### `acquirePaneCreationLock(): Promise<() => void>`

基于 Promise 链的串行锁。返回一个 release 函数，调用方在 `finally` 中释放。多个并发调用会自动排队，确保 pane 创建操作按顺序执行。

> `ITermBackend.ts:21-31`

#### `runIt2(args: string[]): Promise<{ stdout, stderr, code }>`

封装 `execFileNoThrow(IT2_COMMAND, args)`，执行 `it2` CLI 命令。

> `ITermBackend.ts:36-40`

#### `parseSplitOutput(output: string): string`

从 `it2 session split` 的输出中用正则 `/Created new pane:\s*(.+)/` 提取 session ID。

> `ITermBackend.ts:50-56`

#### `getLeaderSessionId(): string | null`

从 `process.env.ITERM_SESSION_ID`（格式 `wXtYpZ:UUID`）提取冒号后的 UUID 部分，作为 Leader 的 session 标识。

> `ITermBackend.ts:63-73`

### ITermBackend 类方法

| 方法 | 行为 | 备注 |
|------|------|------|
| `isAvailable()` | 检测 iTerm2 环境 + it2 CLI | 两步检测 |
| `isRunningInside()` | 检测是否在 iTerm2 中 | 同步 `isInITerm2()` |
| `createTeammatePaneInSwarmView(name, color)` | 创建分屏窗格 | 含锁和死 session 修剪 |
| `sendCommandToPane(paneId, command)` | 发送命令到指定窗格 | 通过 `it2 session run` |
| `setPaneBorderColor(...)` | **No-op** | 性能优化 |
| `setPaneTitle(...)` | **No-op** | 性能优化 |
| `enablePaneBorderStatus(...)` | **No-op** | iTerm2 自动处理 |
| `rebalancePanes(...)` | **No-op** | iTerm2 自动处理 |
| `killPane(paneId)` | 强制关闭窗格 | `-f` 跳过确认 |
| `hidePane(paneId)` | 返回 `false` | 不支持 |
| `showPane(paneId, target)` | 返回 `false` | 不支持 |

## 接口/类型定义

`ITermBackend` 实现 `PaneBackend` 接口（定义于 `types.ts`），核心类型：

- **`PaneId`**：`string` 类型，在 iTerm2 后端中为 `it2 session split` 返回的 session UUID
- **`CreatePaneResult`**：`{ paneId: PaneId, isFirstTeammate: boolean }`
- **`BackendType`**：`'tmux' | 'iterm2' | 'in-process'`

类自身声明了三个只读属性：
```typescript
readonly type = 'iterm2' as const
readonly displayName = 'iTerm2'
readonly supportsHideShow = false
```

## 模块级状态

| 变量 | 类型 | 用途 |
|------|------|------|
| `teammateSessionIds` | `string[]` | 追踪所有已创建 Teammate 的 session ID，用于确定分屏目标和清理 |
| `firstPaneUsed` | `boolean` | 标记是否已创建过首个 Teammate（决定垂直 vs 水平分屏） |
| `paneCreationLock` | `Promise<void>` | 串行化 pane 创建操作的 Promise 链锁 |

## 边界 Case 与注意事项

- **No-op 方法的原因**：`setPaneBorderColor`、`setPaneTitle`、`rebalancePanes` 均为空实现。原因是每次 `it2` 调用都会启动一个独立的 Python 进程与 iTerm2 通信，开销较大。代码中注释建议未来可考虑批量化或 fire-and-forget 优化（`ITermBackend.ts:231-233`）

- **不支持 hide/show**：iTerm2 没有 tmux `break-pane`/`join-pane` 的对等功能，因此 `hidePane` 和 `showPane` 始终返回 `false`，`supportsHideShow` 标记为 `false`

- **Leader session ID 获取的 fallback**：如果 `ITERM_SESSION_ID` 环境变量不存在或格式异常，首次分屏会退化为从"当前活跃 session"分屏（不带 `-s` 标志），此时如果用户切换了窗口焦点可能分屏到错误位置

- **`killPane` 的 `-f` 标志**：必须强制关闭，因为 iTerm2 的"关闭前确认"偏好会在 session 有运行进程（shell 始终算）时阻止关闭。这是 iTerm2 独有的问题，tmux 的 `kill-pane` 没有此行为

- **状态清理的无条件性**：`killPane` 在清理 `teammateSessionIds` 时不依赖 `it2 session close` 的返回码——即使关闭失败（pane 可能已被用户手动关闭），也会移除 stale ID，这是正确的防御性设计

- **并发安全**：`acquirePaneCreationLock` 通过 Promise 链实现了简单而有效的互斥锁，确保多个 Teammate 同时 spawn 时不会产生竞态条件