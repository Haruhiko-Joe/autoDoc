# TeamConfig — 团队配置与辅助工具集

## 概述与职责

TeamConfig 是 Swarm（多 Agent 协调）子系统的配置与辅助工具层，位于 `Infrastructure → FeatureUtilities → Swarm` 层级中。它为上层的团队创建、协调、销毁流程提供底层数据管理和环境支撑，涵盖五个文件：

- **teamHelpers.ts**（683 行）：核心模块，管理 TeamFile（团队配置文件）的完整 CRUD 生命周期——成员增删、权限模式同步、活跃状态设置、Git Worktree 销毁、以及会话级团队目录清理。
- **teammateLayoutManager.ts**：颜色分配与 Pane 创建门面，屏蔽 tmux/iTerm2 等终端后端差异。
- **teammateModel.ts**：提供 Teammate 默认模型回退逻辑（当前默认 Opus 4.6）。
- **teammatePromptAddendum.ts**：定义 Teammate 专用系统提示词，说明消息可见性约束和 `SendMessage` 通信要求。
- **constants.ts**：定义会话名、命令名、环境变量等全局常量。

与同级模块的关系：TeamConfig 被 Swarm 子系统的其他部分（如 `TeammateTool`、`TeamDeleteTool`、协调器）广泛调用，同时依赖 `ModelManagement` 获取模型配置。

## 关键流程

### 1. TeamFile 读写与路径管理

团队配置以 JSON 文件形式存储在 `~/.claude/teams/{sanitized-team-name}/config.json`。路径由三层函数构成：

1. `sanitizeName(name)` 将团队名转为小写并替换非字母数字字符为连字符（`src/utils/swarm/teamHelpers.ts:100-102`）
2. `getTeamDir(teamName)` 拼接 teams 根目录和 sanitized 名称（`teamHelpers.ts:115-117`）
3. `getTeamFilePath(teamName)` 追加 `config.json`（`teamHelpers.ts:122-124`）

读写均提供 **同步** 和 **异步** 两个版本：
- 同步版本（`readTeamFile` / `writeTeamFile`）供 React 渲染路径等必须同步的上下文使用
- 异步版本（`readTeamFileAsync` / `writeTeamFileAsync`）供工具处理器等 async 上下文使用

读取失败时返回 `null`（`ENOENT` 静默处理，其他错误记录调试日志）；写入时自动 `mkdir -p` 确保目录存在。

### 2. 成员管理（增删改）

TeamFile 的 `members` 数组记录了团队所有成员（包括 leader），每个成员包含 `agentId`、`name`、`tmuxPaneId`、`cwd`、`worktreePath`、`mode`、`isActive` 等字段。

**成员移除**提供三种方式，适用于不同场景：
- `removeTeammateFromTeamFile(teamName, {agentId?, name?})`：按 agentId 或 name 匹配移除，用于 leader 处理关闭审批（`teamHelpers.ts:188-227`）
- `removeMemberFromTeam(teamName, tmuxPaneId)`：按 Pane ID 移除，同时清理 `hiddenPaneIds`（`teamHelpers.ts:285-317`）
- `removeMemberByAgentId(teamName, agentId)`：专为进程内 Teammate 设计——这些 Teammate 共享同一个 tmuxPaneId，只能用 agentId 区分（`teamHelpers.ts:326-348`）

### 3. 权限模式同步

权限模式（`PermissionMode`）可在 leader 的 TeamsDialog 中调整，并同步到 TeamFile 供所有 Teammate 读取：

- `setMemberMode(teamName, memberName, mode)`：单个成员模式更新，仅在值变化时写文件（`teamHelpers.ts:357-389`）
- `setMultipleMemberModes(teamName, modeUpdates)`：**原子批量更新**，避免逐个写入导致的竞态条件（`teamHelpers.ts:415-445`）
- `syncTeammateMode(mode, teamNameOverride?)`：Teammate 侧调用，将自身当前权限模式同步到 config.json，让 leader 可见。非 Teammate 环境下为 no-op（`teamHelpers.ts:397-407`）

### 4. 活跃状态管理

`setMemberActive(teamName, memberName, isActive)` 异步更新成员的 `isActive` 标志——Teammate 空闲时设为 `false`，开始新 turn 时设为 `true`。同样仅在值变化时写文件，避免不必要的 IO（`teamHelpers.ts:454-485`）。

### 5. 隐藏 Pane 管理

`hiddenPaneIds` 数组控制哪些 Pane 在 UI 中不可见：
- `addHiddenPaneId(teamName, paneId)`：添加到隐藏列表（`teamHelpers.ts:235-251`）
- `removeHiddenPaneId(teamName, paneId)`：从隐藏列表移除（`teamHelpers.ts:259-276`）

两者均做去重/存在性检查，确保幂等。

### 6. Git Worktree 销毁

`destroyWorktree(worktreePath)` 实现两阶段清理（`teamHelpers.ts:492-551`）：

1. 读取 worktree 目录下的 `.git` 文件，解析 `gitdir:` 指令定位主仓库路径
2. 尝试 `git worktree remove --force`
3. 若 git 命令失败（如找不到主仓库），回退到 `rm -rf` 强制删除
4. 对 "not a working tree" 错误（已被删除）静默处理

### 7. 会话级团队清理

整个清理流程分三层：

1. **注册**：`registerTeamForSessionCleanup(teamName)` 在团队创建后将其加入会话级 Set（存储在 `bootstrap/state.ts` 中，测试时可 reset）（`teamHelpers.ts:560-562`）
2. **反注册**：`unregisterTeamForSessionCleanup(teamName)` 在显式 TeamDelete 后移除，避免重复清理（`teamHelpers.ts:568-570`）
3. **清理**：`cleanupSessionTeams()` 在进程退出时（注册到 `gracefulShutdown`）执行：
   - 先调用 `killOrphanedTeammatePanes()` 杀掉所有 Pane 后端的 Teammate 进程（`teamHelpers.ts:598-634`）——动态 import `backends/registry.js` 和 `backends/detection.js` 避免增加模块静态依赖
   - 再调用 `cleanupTeamDirectories()` 依次销毁 Worktree、删除团队目录（`~/.claude/teams/{name}/`）和任务目录（`~/.claude/tasks/{name}/`）（`teamHelpers.ts:641-683`）

## 函数签名与参数说明

### teamHelpers.ts — 核心 CRUD

| 函数 | 签名 | 说明 |
|------|------|------|
| `sanitizeName` | `(name: string) → string` | 名称清洗：非字母数字 → `-`，转小写 |
| `sanitizeAgentName` | `(name: string) → string` | Agent 名称清洗：替换 `@` 为 `-`，防止与 `agentName@teamName` 格式冲突 |
| `getTeamDir` | `(teamName: string) → string` | 获取团队目录绝对路径 |
| `getTeamFilePath` | `(teamName: string) → string` | 获取 `config.json` 绝对路径 |
| `readTeamFile` | `(teamName: string) → TeamFile \| null` | 同步读取，ENOENT 返回 null |
| `readTeamFileAsync` | `(teamName: string) → Promise<TeamFile \| null>` | 异步读取 |
| `writeTeamFileAsync` | `(teamName: string, teamFile: TeamFile) → Promise<void>` | 异步写入，自动创建目录 |
| `removeTeammateFromTeamFile` | `(teamName, {agentId?, name?}) → boolean` | 按标识移除成员 |
| `removeMemberFromTeam` | `(teamName, tmuxPaneId) → boolean` | 按 Pane ID 移除，同步清理隐藏列表 |
| `removeMemberByAgentId` | `(teamName, agentId) → boolean` | 按 agentId 移除（进程内 Teammate） |
| `setMemberMode` | `(teamName, memberName, mode: PermissionMode) → boolean` | 设置单个成员权限模式 |
| `setMultipleMemberModes` | `(teamName, modeUpdates[]) → boolean` | 原子批量更新权限模式 |
| `syncTeammateMode` | `(mode, teamNameOverride?) → void` | Teammate 同步自身模式到 config |
| `setMemberActive` | `(teamName, memberName, isActive) → Promise<void>` | 设置成员活跃状态 |
| `addHiddenPaneId` / `removeHiddenPaneId` | `(teamName, paneId) → boolean` | 隐藏/显示 Pane |
| `registerTeamForSessionCleanup` | `(teamName) → void` | 注册会话退出清理 |
| `unregisterTeamForSessionCleanup` | `(teamName) → void` | 取消注册 |
| `cleanupSessionTeams` | `() → Promise<void>` | 执行会话级全量清理 |
| `cleanupTeamDirectories` | `(teamName) → Promise<void>` | 清理指定团队目录和 Worktree |

### teammateLayoutManager.ts — 布局管理

| 函数 | 签名 | 说明 |
|------|------|------|
| `assignTeammateColor` | `(teammateId: string) → AgentColorName` | Round-robin 颜色分配，同 ID 返回缓存值 |
| `getTeammateColor` | `(teammateId: string) → AgentColorName \| undefined` | 查询已分配颜色 |
| `clearTeammateColors` | `() → void` | 清空颜色分配，重置索引 |
| `isInsideTmux` | `() → Promise<boolean>` | 检测当前是否在 tmux 会话内 |
| `createTeammatePaneInSwarmView` | `(name, color) → Promise<{paneId, isFirstTeammate}>` | 创建 Teammate Pane，自动选择后端 |
| `enablePaneBorderStatus` | `(windowTarget?, useSwarmSocket?) → Promise<void>` | 启用 Pane 边框标题显示 |
| `sendCommandToPane` | `(paneId, command, useSwarmSocket?) → Promise<void>` | 向指定 Pane 发送命令 |

### teammateModel.ts

| 函数 | 签名 | 说明 |
|------|------|------|
| `getHardcodedTeammateModelFallback` | `() → string` | 返回当前 API Provider 对应的 Opus 4.6 模型 ID |

## 接口/类型定义

### `TeamFile`（`teamHelpers.ts:64-90`）

团队配置的核心数据结构，序列化为 `config.json`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 团队名称 |
| `description` | `string?` | 团队描述/用途 |
| `createdAt` | `number` | 创建时间戳 |
| `leadAgentId` | `string` | Leader 的 agentId |
| `leadSessionId` | `string?` | Leader 的会话 UUID（用于服务发现） |
| `hiddenPaneIds` | `string[]?` | UI 中隐藏的 Pane ID 列表 |
| `teamAllowedPaths` | `TeamAllowedPath[]?` | 所有 Teammate 无需审批即可编辑的路径 |
| `members` | `Member[]` | 成员列表（含 leader） |

每个 **Member** 包含：`agentId`、`name`、`agentType?`、`model?`、`prompt?`、`color?`、`planModeRequired?`、`joinedAt`、`tmuxPaneId`、`cwd`、`worktreePath?`、`sessionId?`、`subscriptions`、`backendType?`、`isActive?`、`mode?`。

### `TeamAllowedPath`（`teamHelpers.ts:57-62`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `path` | `string` | 绝对目录路径 |
| `toolName` | `string` | 适用的工具名（如 "Edit"、"Write"） |
| `addedBy` | `string` | 添加此规则的 Agent 名称 |
| `addedAt` | `number` | 添加时间戳 |

### `inputSchema`（`teamHelpers.ts:19-42`）

Zod schema，定义工具调用的输入参数：`operation`（"spawnTeam" | "cleanup"）、`agent_type?`、`team_name?`、`description?`。

## 配置项与默认值

### 全局常量（`constants.ts`）

| 常量 | 值 | 用途 |
|------|-----|------|
| `TEAM_LEAD_NAME` | `"team-lead"` | Leader 在 TeamFile 中的固定名称 |
| `SWARM_SESSION_NAME` | `"claude-swarm"` | tmux 会话名 |
| `SWARM_VIEW_WINDOW_NAME` | `"swarm-view"` | tmux 窗口名 |
| `TMUX_COMMAND` | `"tmux"` | tmux 可执行文件名 |
| `HIDDEN_SESSION_NAME` | `"claude-hidden"` | 隐藏会话名 |
| `TEAMMATE_COMMAND_ENV_VAR` | `"CLAUDE_CODE_TEAMMATE_COMMAND"` | 覆盖 Teammate 启动命令的环境变量 |
| `TEAMMATE_COLOR_ENV_VAR` | `"CLAUDE_CODE_AGENT_COLOR"` | 传递给 Teammate 的颜色环境变量 |
| `PLAN_MODE_REQUIRED_ENV_VAR` | `"CLAUDE_CODE_PLAN_MODE_REQUIRED"` | 设为 `"true"` 时 Teammate 必须先进入 Plan 模式 |

### 动态值

- `getSwarmSocketName()` 返回 `claude-swarm-{pid}`，使用进程 PID 隔离多实例（`constants.ts:12-14`）
- `getHardcodedTeammateModelFallback()` 根据当前 API Provider（Anthropic/Bedrock/Vertex/Foundry）返回对应的 Opus 4.6 模型 ID（`teammateModel.ts:8-10`）

### Teammate 系统提示词（`teammatePromptAddendum.ts`）

`TEAMMATE_SYSTEM_PROMPT_ADDENDUM` 追加到 Teammate 的系统提示中，核心规则：
- 必须使用 `SendMessage` 工具与队友通信（`to: "<name>"` 或 `to: "*"` 广播）
- 纯文本回复对团队不可见
- 用户通过 Team Lead 交互，Teammate 通过任务系统和消息协调

## 边界 Case 与注意事项

- **同步 vs 异步**：`readTeamFile` / `writeTeamFile` 是同步的，专为 React 渲染路径设计。在 async 上下文中应使用 `Async` 后缀版本。`writeTeamFile` 未导出，只能通过 `writeTeamFileAsync` 或内部函数间接写入。
- **竞态保护**：`setMultipleMemberModes` 通过单次读-改-写避免逐个更新的竞态。但单个 `setMemberMode` 和 `setMemberActive` 之间没有锁机制——在高并发场景下仍可能丢失更新。
- **幂等性**：`addHiddenPaneId` 和 `removeHiddenPaneId` 做了去重检查，重复调用安全。`setMemberMode` 和 `setMemberActive` 在值未变时跳过写入。
- **Worktree 清理的两阶段策略**：`destroyWorktree` 先尝试 `git worktree remove --force`，失败后 fallback 到 `rm -rf`。对不存在的路径或已移除的 worktree 均安全。
- **Session 清理与 PR #17615**：会话创建的团队 Set 存储在 `bootstrap/state.ts` 而非模块局部变量，确保 `resetStateForTests()` 能清除跨测试分片的泄漏。
- **动态 import 控制依赖**：`killOrphanedTeammatePanes` 在运行时才 import `backends/registry.js` 和 `backends/detection.js`，避免在模块静态依赖图中引入 backend 注册逻辑——该函数仅在关闭时运行。
- **颜色分配是会话级的**：`teammateColorAssignments` Map 和 `colorIndex` 存于模块作用域，不跨进程持久化。`clearTeammateColors()` 需在团队清理时主动调用。
- **`sanitizeAgentName` 防止格式歧义**：Agent ID 使用 `agentName@teamName` 格式，因此 agent name 中的 `@` 必须替换为 `-`。