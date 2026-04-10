# ToolRegistry — 工具中央注册表与组装逻辑

## 概述与职责

`ToolRegistry`（`src/tools.ts`）是 Claude Code **ToolSystem** 的核心注册表文件，负责管理所有内置工具的注册、特性门控加载、权限过滤和与 MCP 外部工具的合并。它是工具系统的**单一事实来源**——无论是 REPL 界面、Agent 子进程还是 Coordinator 协调器，最终都通过该模块获取可用工具集合。

在整体架构中，ToolRegistry 位于 **ToolSystem** 模块内，上层由 **CoreEngine**（查询引擎调度工具执行）和 **Entrypoints**（MCP Server 入口暴露工具列表）调用，同级模块包括 `Tool.ts`（工具接口与权限模型定义）以及 `tools/` 目录下的 40+ 具体工具实现。

## 关键流程

### 工具注册与加载流程

整个工具注册采用**声明式枚举 + 特性门控**的模式：

1. **静态导入**：核心工具（如 `BashTool`、`FileReadTool`、`AgentTool` 等）通过顶层 ES import 直接加载（`src/tools.ts:2-84`）
2. **条件导入（特性门控）**：非核心工具通过 `feature()` 函数（来自 `bun:bundle`）或 `process.env` 环境变量进行按需加载，使用 `require()` 动态导入以支持 Dead Code Elimination（`src/tools.ts:16-135`）
3. **延迟导入（打破循环依赖）**：`TeamCreateTool`、`TeamDeleteTool`、`SendMessageTool` 通过工厂函数 `getXxxTool()` 延迟加载，避免循环依赖（`src/tools.ts:63-72`）

### 特性门控分类

| 门控条件 | 加载的工具 |
|---------|-----------|
| `process.env.USER_TYPE === 'ant'` | `REPLTool`、`SuggestBackgroundPRTool`、`ConfigTool`、`TungstenTool` |
| `feature('PROACTIVE') \|\| feature('KAIROS')` | `SleepTool` |
| `feature('AGENT_TRIGGERS')` | `CronCreateTool`、`CronDeleteTool`、`CronListTool` |
| `feature('AGENT_TRIGGERS_REMOTE')` | `RemoteTriggerTool` |
| `feature('MONITOR_TOOL')` | `MonitorTool` |
| `feature('KAIROS')` | `SendUserFileTool` |
| `feature('KAIROS') \|\| feature('KAIROS_PUSH_NOTIFICATION')` | `PushNotificationTool` |
| `feature('KAIROS_GITHUB_WEBHOOKS')` | `SubscribePRTool` |
| `feature('COORDINATOR_MODE')` | Coordinator 模式相关逻辑 |
| `feature('OVERFLOW_TEST_TOOL')` | `OverflowTestTool` |
| `feature('CONTEXT_COLLAPSE')` | `CtxInspectTool` |
| `feature('TERMINAL_PANEL')` | `TerminalCaptureTool` |
| `feature('WEB_BROWSER_TOOL')` | `WebBrowserTool` |
| `feature('HISTORY_SNIP')` | `SnipTool` |
| `feature('UDS_INBOX')` | `ListPeersTool` |
| `feature('WORKFLOW_SCRIPTS')` | `WorkflowTool`（含 `initBundledWorkflows()` 初始化） |
| `hasEmbeddedSearchTools()` | 存在时**排除** `GlobTool`、`GrepTool`（由内嵌 bfs/ugrep 替代） |
| `isWorktreeModeEnabled()` | `EnterWorktreeTool`、`ExitWorktreeTool` |
| `isAgentSwarmsEnabled()` | `TeamCreateTool`、`TeamDeleteTool` |
| `isTodoV2Enabled()` | `TaskCreateTool`、`TaskGetTool`、`TaskUpdateTool`、`TaskListTool` |
| `isToolSearchEnabledOptimistic()` | `ToolSearchTool` |
| `isEnvTruthy(ENABLE_LSP_TOOL)` | `LSPTool` |
| `isPowerShellToolEnabled()` | `PowerShellTool` |
| `process.env.NODE_ENV === 'test'` | `TestingPermissionTool` |
| `process.env.CLAUDE_CODE_VERIFY_PLAN === 'true'` | `VerifyPlanExecutionTool` |

### `getAllBaseTools()` — 枚举所有内置工具

> 源码位置：`src/tools.ts:193-251`

该函数返回当前环境下**所有可能可用**的内置工具数组。它是工具列表的唯一来源，必须与 Statsig 动态配置（`claude_code_global_system_caching`）保持同步，以确保系统提示词在不同用户间可缓存。

关键逻辑：
- 无条件包含的核心工具：`AgentTool`、`TaskOutputTool`、`BashTool`、`FileReadTool`/`FileEditTool`/`FileWriteTool`、`NotebookEditTool`、`WebFetchTool`、`TodoWriteTool`、`WebSearchTool`、`TaskStopTool`、`AskUserQuestionTool`、`SkillTool`、`EnterPlanModeTool`、`ExitPlanModeV2Tool`、`BriefTool`、`SendMessageTool`、`ListMcpResourcesTool`、`ReadMcpResourceTool`
- 条件包含的工具通过展开运算符 `...()` 模式有条件地插入数组
- 嵌入式搜索工具检测：当 Ant 原生构建内嵌了 bfs/ugrep 时，`GlobTool` 和 `GrepTool` 被排除，因为 Bash 中的 find/grep 已被别名到快速工具

### `getTools()` — 按权限上下文过滤工具集

> 源码位置：`src/tools.ts:271-327`

该函数在 `getAllBaseTools()` 基础上，根据运行模式和权限规则进一步过滤工具列表。支持三种模式：

**1. Simple 模式**（`CLAUDE_CODE_SIMPLE` 环境变量为 truthy）：
- 默认仅保留 `BashTool`、`FileReadTool`、`FileEditTool` 三个基础工具
- 若同时启用 REPL 模式，则替换为 `REPLTool`（REPL 在 VM 中封装了基础工具）
- 若同时启用 Coordinator 模式，额外添加 `AgentTool`、`TaskStopTool`、`SendMessageTool`

**2. REPL 模式**：
- 当 REPL 工具启用时，从工具列表中移除 `REPL_ONLY_TOOLS` 集合中的工具（这些工具在 REPL VM 内部可用，无需直接暴露）

**3. 标准模式**：
- 排除特殊工具（`ListMcpResourcesTool`、`ReadMcpResourceTool`、`SYNTHETIC_OUTPUT_TOOL_NAME`）
- 应用 `filterToolsByDenyRules()` 权限过滤
- 调用每个工具的 `isEnabled()` 方法进行最终启用检查

### `assembleToolPool()` — 合并内置工具与 MCP 工具

> 源码位置：`src/tools.ts:345-367`

这是构建完整工具池的**唯一入口**，被 REPL.tsx（通过 `useMergedTools` hook）和 `runAgent.ts`（Coordinator Worker）共同使用。

关键设计决策：
1. **分区排序**：内置工具和 MCP 工具分别按名称排序后拼接，而非混合排序。这保证内置工具作为连续前缀存在，避免 MCP 工具插入导致 prompt cache 失效
2. **去重策略**：使用 `lodash.uniqBy` 按 `name` 去重，由于内置工具在前，同名冲突时内置工具优先
3. **兼容性**：避免使用 `Array.toSorted()`（Node 20+），以兼容 Node 18

```typescript
// src/tools.ts:362-366
const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
return uniqBy(
  [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
  'name',
)
```

### `filterToolsByDenyRules()` — 根据 deny 规则剔除工具

> 源码位置：`src/tools.ts:262-269`

泛型函数，接收工具数组和权限上下文，过滤掉被 blanket deny（无 `ruleContent` 的全量拒绝规则）匹配的工具。支持 MCP 服务器前缀匹配（如 `mcp__server` 规则会移除该服务器下的所有工具），确保被拒绝的工具在模型可见的工具列表中就已被移除，而非仅在调用时拦截。

### `getMergedTools()` — 获取内置+MCP 完整工具列表

> 源码位置：`src/tools.ts:383-389`

简单合并函数（不排序不去重），用于工具搜索阈值计算（`isToolSearchEnabled`）和 Token 计数等需要考虑 MCP 工具的场景。与 `assembleToolPool()` 的区别在于不做排序和去重处理。

## 函数签名与参数说明

### `getAllBaseTools(): Tools`

返回当前环境下所有可能的内置工具数组。无参数，返回 `Tools` 类型（即 `Tool[]`）。

### `getTools(permissionContext: ToolPermissionContext): Tools`

根据权限上下文和运行模式过滤内置工具列表。

- **permissionContext**：包含权限规则的上下文对象，类型为 `ToolPermissionContext`（来自 `Tool.js`）
- **返回值**：经过模式过滤、deny 规则过滤和 `isEnabled()` 检查后的工具数组

### `assembleToolPool(permissionContext: ToolPermissionContext, mcpTools: Tools): Tools`

组装完整工具池。

- **permissionContext**：权限上下文
- **mcpTools**：来自 `appState.mcp.tools` 的 MCP 外部工具列表
- **返回值**：去重排序后的内置工具 + MCP 工具合并数组

### `filterToolsByDenyRules<T>(tools: readonly T[], permissionContext: ToolPermissionContext): T[]`

泛型过滤函数，移除被 deny 规则匹配的工具。

- **T**：需包含 `name: string` 和可选 `mcpInfo?: { serverName, toolName }` 的类型
- **tools**：待过滤工具数组
- **permissionContext**：权限上下文
- **返回值**：过滤后的工具数组

### `getMergedTools(permissionContext: ToolPermissionContext, mcpTools: Tools): Tools`

简单合并内置工具和 MCP 工具（不排序不去重），用于 Token 计数等场景。

### `parseToolPreset(preset: string): ToolPreset | null`

解析工具预设字符串，当前仅支持 `'default'` 预设。

### `getToolsForDefaultPreset(): string[]`

返回默认预设下所有已启用工具的名称数组。

## 导出的常量与类型

| 导出项 | 类型 | 说明 |
|--------|------|------|
| `TOOL_PRESETS` | `readonly ['default']` | 可用的工具预设列表 |
| `ToolPreset` | type | 工具预设类型 |
| `ALL_AGENT_DISALLOWED_TOOLS` | 常量（re-export） | Agent 模式下禁用的工具列表（来自 `constants/tools.js`） |
| `CUSTOM_AGENT_DISALLOWED_TOOLS` | 常量（re-export） | 自定义 Agent 禁用工具列表 |
| `ASYNC_AGENT_ALLOWED_TOOLS` | 常量（re-export） | 异步 Agent 允许的工具列表 |
| `COORDINATOR_MODE_ALLOWED_TOOLS` | 常量（re-export） | Coordinator 模式允许的工具列表 |
| `REPL_ONLY_TOOLS` | 常量（re-export） | 仅在 REPL 内部可用的工具集合 |

## 配置项与环境变量

| 环境变量 / 标志 | 说明 |
|----------------|------|
| `CLAUDE_CODE_SIMPLE` | 启用 Simple 模式（仅 Bash/Read/Edit） |
| `USER_TYPE` | 值为 `'ant'` 时加载内部专用工具 |
| `ENABLE_LSP_TOOL` | 启用 LSP 工具 |
| `CLAUDE_CODE_VERIFY_PLAN` | 值为 `'true'` 时加载计划验证工具 |
| `NODE_ENV` | 值为 `'test'` 时加载测试权限工具 |

## 边界 Case 与注意事项

- **Prompt Cache 稳定性**：`assembleToolPool()` 的排序策略是刻意设计的——内置工具作为连续前缀排序，MCP 工具在其后独立排序。如果改为全局混合排序，新增 MCP 工具可能插入内置工具之间，导致服务端 cache 策略（`claude_code_system_cache_policy`）的断点失效，引发缓存穿透
- **Statsig 同步要求**：`getAllBaseTools()` 的工具列表必须与 Statsig 动态配置保持一致，否则系统提示词无法跨用户缓存
- **Node 18 兼容**：避免使用 `Array.toSorted()` 等 Node 20+ API
- **循环依赖**：`TeamCreateTool`、`TeamDeleteTool`、`SendMessageTool` 使用延迟 `require()` 打破循环依赖链（`tools.ts -> XxxTool -> ... -> tools.ts`）
- **嵌入式搜索工具**：Ant 原生构建将 bfs/ugrep 嵌入 Bun 二进制文件，此时 shell 中的 find/grep 已被别名到快速实现，`GlobTool`/`GrepTool` 成为冗余，自动排除
- **REPL 模式下的工具隐藏**：REPL 在 VM 中封装了基础工具，因此启用 REPL 时需从顶层列表中移除 `REPL_ONLY_TOOLS`，避免重复暴露
- **`getMergedTools()` vs `assembleToolPool()`**：前者是简单合并（用于计数），后者是排序去重的正式工具池——不要混用