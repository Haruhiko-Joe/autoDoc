# CoordinatorMode — 多 Agent 协调（Swarm）模式配置

## 概述与职责

`coordinatorMode.ts` 是多 Agent 协调（Swarm）模式的核心配置模块，位于 `src/coordinator/` 目录下，属于 **TaskSystem** 层级。它负责四件事：

1. **开关检测**：通过编译时特性门控 + 环境变量判断是否启用 coordinator 模式
2. **会话模式匹配**：恢复历史会话时自动切换到该会话对应的模式（coordinator / normal）
3. **系统提示词生成**：为 coordinator 角色构建完整的系统提示词（约 370 行），定义 worker 调度策略、任务工作流阶段、prompt 编写规范
4. **Worker 工具上下文生成**：根据运行模式动态计算 worker 可用的工具列表，并注入 MCP 服务器和 Scratchpad 信息

在整体架构中，该模块被 CoreEngine 的查询引擎（QueryEngine）在构建系统提示词时调用，是 coordinator 模式下整个多 Agent 协作的"规则手册"。

> 源码位置：`src/coordinator/coordinatorMode.ts`（共 369 行）

---

## 关键流程

### 1. Coordinator 模式开关检测

模式是否启用由两层门控决定：

1. **编译时特性门控**：`feature('COORDINATOR_MODE')` —— 使用 Bun 的 bundle-time feature flag，编译时决定该代码分支是否包含在产物中
2. **运行时环境变量**：`process.env.CLAUDE_CODE_COORDINATOR_MODE` —— 通过 `isEnvTruthy()` 判断是否为真值（如 `"1"`、`"true"` 等）

两层条件全部满足时，`isCoordinatorMode()` 返回 `true`。

```typescript
// src/coordinator/coordinatorMode.ts:36-41
export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  }
  return false
}
```

### 2. 会话恢复时的模式自动切换

当用户恢复一个已有会话时，`matchSessionMode()` 对比当前运行时模式与会话中存储的模式。如果不匹配，直接修改 `process.env.CLAUDE_CODE_COORDINATOR_MODE` 环境变量使其一致（`isCoordinatorMode()` 每次实时读取环境变量，无缓存），并记录遥测事件。

流程如下：

1. 若 `sessionMode` 为 `undefined`（旧版会话，未记录模式），不做任何操作
2. 比较当前模式与会话模式，一致则返回 `undefined`
3. 不一致时，设置或删除环境变量 `CLAUDE_CODE_COORDINATOR_MODE`
4. 通过 `logEvent('tengu_coordinator_mode_switched', ...)` 记录切换事件
5. 返回用户可见的提示消息，如 `"Entered coordinator mode to match resumed session."`

> 源码位置：`src/coordinator/coordinatorMode.ts:49-78`

### 3. Worker 工具上下文生成

`getCoordinatorUserContext()` 在 coordinator 模式下生成注入到用户上下文中的工具描述，让 coordinator 知道它的 worker 拥有哪些工具能力。

该函数有两种工具集计算路径：

- **简单模式**（`CLAUDE_CODE_SIMPLE` 环境变量为真）：worker 仅拥有 `Bash`、`Read`、`Edit` 三个基础工具
- **标准模式**：从 `ASYNC_AGENT_ALLOWED_TOOLS` 常量集合出发，过滤掉 coordinator 内部工具（`TeamCreate`、`TeamDelete`、`SendMessage`、`SyntheticOutput`），剩余工具按字母排序后列出

在此基础上，还会追加两类可选信息：

- **MCP 服务器**：如果有已连接的 MCP 客户端，列出其名称
- **Scratchpad 目录**：如果 `scratchpadDir` 存在且 `tengu_scratch` 特性门控开启，告知 worker 可以在该目录免权限读写，用于跨 worker 的持久化知识共享

> 源码位置：`src/coordinator/coordinatorMode.ts:80-109`

### 4. Coordinator 系统提示词构建

`getCoordinatorSystemPrompt()` 返回一段约 250 行的 Markdown 系统提示词，是 coordinator 模式下 Claude 行为的完整规范。提示词分为 6 个章节：

| 章节 | 内容 |
|------|------|
| **1. Your Role** | 定义 coordinator 的身份——编排者而非执行者；所有消息面向用户；不要致谢 worker |
| **2. Your Tools** | 列出 coordinator 可用的 4 类工具：`Agent`（派发 worker）、`SendMessage`（继续已有 worker）、`TaskStop`（终止 worker）、PR 订阅工具 |
| **3. Workers** | 说明 worker 的工具能力（根据简单/标准模式动态切换） |
| **4. Task Workflow** | 定义 Research → Synthesis → Implementation → Verification 四阶段工作流，以及并发管理策略 |
| **5. Writing Worker Prompts** | prompt 编写的核心规范——必须自包含、必须经过 coordinator 综合分析、禁止懒委托 |
| **6. Example Session** | 一个完整的对话示例，展示从调查到修复的全流程 |

---

## 函数签名与参数说明

### `isCoordinatorMode(): boolean`

检测当前是否处于 coordinator 模式。

- **返回值**：`true` 表示 coordinator 模式已启用
- **依赖**：编译时 `feature('COORDINATOR_MODE')` + 运行时 `CLAUDE_CODE_COORDINATOR_MODE` 环境变量

### `matchSessionMode(sessionMode: 'coordinator' | 'normal' | undefined): string | undefined`

将运行时模式与恢复的会话模式对齐。

- **sessionMode**：会话中存储的模式标记。`undefined` 表示旧版会话（无模式记录）
- **返回值**：模式切换时返回用户可见的提示消息；无需切换时返回 `undefined`
- **副作用**：直接修改 `process.env.CLAUDE_CODE_COORDINATOR_MODE`；记录 `tengu_coordinator_mode_switched` 遥测事件

### `getCoordinatorUserContext(mcpClients, scratchpadDir?): { [k: string]: string }`

生成 worker 工具上下文，注入到系统提示词中。

- **mcpClients**：`ReadonlyArray<{ name: string }>` —— 当前已连接的 MCP 服务器列表
- **scratchpadDir**：可选，Scratchpad 目录路径（由 QueryEngine 通过依赖注入传入，避免循环依赖）
- **返回值**：非 coordinator 模式返回空对象 `{}`；否则返回 `{ workerToolsContext: string }`

### `getCoordinatorSystemPrompt(): string`

生成 coordinator 的完整系统提示词。

- **返回值**：Markdown 格式的系统提示词字符串
- **动态部分**：根据 `CLAUDE_CODE_SIMPLE` 环境变量切换 worker 能力描述（简单模式 vs 标准模式）

---

## 接口/类型定义

本模块未定义独立的 interface 或 type。值得注意的内部常量：

### `INTERNAL_WORKER_TOOLS`

```typescript
// src/coordinator/coordinatorMode.ts:29-34
const INTERNAL_WORKER_TOOLS = new Set([
  'TeamCreate',    // TEAM_CREATE_TOOL_NAME
  'TeamDelete',    // TEAM_DELETE_TOOL_NAME
  'SendMessage',   // SEND_MESSAGE_TOOL_NAME
  'SyntheticOutput', // SYNTHETIC_OUTPUT_TOOL_NAME
])
```

这些工具是 coordinator 内部调度机制使用的，在生成"worker 可用工具列表"时被过滤掉——worker 不应直接使用这些工具。

---

## 配置项与默认值

| 配置 | 类型 | 说明 |
|------|------|------|
| `CLAUDE_CODE_COORDINATOR_MODE` | 环境变量 | 启用 coordinator 模式的运行时开关。需同时满足编译时 `COORDINATOR_MODE` feature flag |
| `CLAUDE_CODE_SIMPLE` | 环境变量 | 简单模式开关。为真时 worker 仅获得 `Bash`、`Read`、`Edit` 三个工具 |
| `feature('COORDINATOR_MODE')` | 编译时常量 | Bun bundle-time feature flag，编译时决定 coordinator 代码分支是否纳入产物 |
| `tengu_scratch` | Statsig 特性门控 | 控制 Scratchpad 功能是否启用（通过 Growthbook 远程配置） |

---

## 边界 Case 与注意事项

1. **循环依赖规避**：`isScratchpadGateEnabled()` 是对 `utils/permissions/filesystem.ts` 中 `isScratchpadEnabled()` 的刻意重复实现（`src/coordinator/coordinatorMode.ts:19-27`）。因为 `filesystem.ts` 的导入链会形成循环依赖，所以这里直接调用底层的 `checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_scratch')`。Scratchpad 的实际路径通过 `getCoordinatorUserContext` 的 `scratchpadDir` 参数依赖注入，而非直接 import。

2. **环境变量实时读取**：`isCoordinatorMode()` 不缓存结果，每次调用都读取 `process.env`。这使得 `matchSessionMode()` 可以通过直接修改环境变量来切换模式，无需额外的状态同步机制。

3. **旧版会话兼容**：`matchSessionMode()` 对 `sessionMode === undefined` 的情况直接跳过，确保不会影响模式追踪功能上线前创建的历史会话。

4. **缓存可能过期的特性门控**：`isScratchpadGateEnabled()` 使用的是 `checkStatsigFeatureGate_CACHED_MAY_BE_STALE`（函数名明确标注"缓存可能过期"），即它读取的是 Growthbook 的本地缓存值，不会阻塞等待远程请求。

5. **系统提示词中的 PR 订阅工具**：提示词提到 `subscribe_pr_activity / unsubscribe_pr_activity` 但标注"if available"，说明这些工具不是始终存在的，取决于运行时的工具注册状态。