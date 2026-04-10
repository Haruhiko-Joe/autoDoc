# Hook 注册与执行框架

## 概述与职责

Hook 系统是 Claude Code 的事件拦截与扩展框架，位于 **Infrastructure → FeatureUtilities** 层级中。它允许在 Claude Code 生命周期的关键节点（工具调用前后、用户提交 Prompt、会话开始/结束等）注入自定义逻辑。

该模块提供四种 Hook 执行方式：**命令行（command）**、**HTTP 请求（http）**、**LLM Prompt 评估（prompt）**、**多轮 Agent 验证（agent）**，以及仅限内存的 **Function Hook**。Hook 可以从多个来源注册——用户/项目/本地配置文件、企业策略（policySettings）、插件系统、Agent/Skill 的 frontmatter、以及运行时的 Session 级注册。

同级模块包括 plugins/（插件生命周期管理）、model/（模型选择与能力检测）、swarm/（多 Agent 协调）等，它们共同构成领域特定工具库集合。

## 核心架构

### 文件总览

| 文件 | 职责 |
|------|------|
| `hooksConfigManager.ts` | Hook 配置来源管理，策略优先级控制 |
| `hooksConfigSnapshot.ts` | 启动时捕获配置快照，运行时更新 |
| `hooksSettings.ts` | Hook 数据模型、来源枚举、排序逻辑 |
| `hookEvents.ts` | Hook 事件广播系统（started/progress/response） |
| `hooksConfigManager.ts` | Hook 事件元数据（26 种事件类型定义） |
| `hookHelpers.ts` | 共享工具：响应 Schema、参数替换、结构化输出工具 |
| `AsyncHookRegistry.ts` | 异步 Hook 注册表，管理后台进程生命周期 |
| `execHttpHook.ts` | HTTP Hook 执行器，含 SSRF 防护和沙箱代理 |
| `execPromptHook.ts` | Prompt Hook 执行器，单轮 LLM 评估 |
| `execAgentHook.ts` | Agent Hook 执行器，多轮 LLM 查询验证 |
| `ssrfGuard.ts` | SSRF 防护——DNS 解析时阻止私有/链路本地地址 |
| `sessionHooks.ts` | Session 级 Hook 存储（内存 Map，支持 Function Hook） |
| `registerFrontmatterHooks.ts` | 从 Agent frontmatter 注册 Session Hook |
| `registerSkillHooks.ts` | 从 Skill frontmatter 注册 Session Hook |
| `postSamplingHooks.ts` | 采样后钩子注册表（内部 API，不暴露于配置） |
| `apiQueryHookHelper.ts` | API 查询 Hook 工厂，封装 LLM 调用流程 |
| `skillImprovement.ts` | 技能改进检测 Hook（基于 apiQueryHookHelper） |
| `fileChangedWatcher.ts` | 文件变更监听器（chokidar），触发 FileChanged/CwdChanged Hook |

## 关键流程

### 1. Hook 配置加载与快照

应用启动时调用 `captureHooksConfigSnapshot()` 冻结一份 Hook 配置，后续所有 Hook 执行都从此快照读取，避免运行时配置变更导致不一致。

**策略优先级链**（`src/utils/hooks/hooksConfigSnapshot.ts:18-53`）：

1. 若 `policySettings.disableAllHooks === true` → 返回空配置（全部禁用）
2. 若 `policySettings.allowManagedHooksOnly === true` → 仅返回企业管理 Hook
3. 若 `isRestrictedToPluginOnly('hooks')` → 仅返回策略 Hook
4. 若非管理配置设置 `disableAllHooks` → 企业 Hook 仍可运行
5. 否则 → 合并所有来源的 Hook（向后兼容）

### 2. Hook 来源与合并

`getAllHooks()` 函数（`src/utils/hooks/hooksSettings.ts:92-161`）从以下来源聚合 Hook：

- **用户配置** `~/.claude/settings.json`
- **项目配置** `.claude/settings.json`
- **本地配置** `.claude/settings.local.json`
- **Session Hook** 运行时注册的临时 Hook（来自 frontmatter/skill/function）
- **插件 Hook** 通过 `getRegisteredHooks()` 获取
- **内置 Hook** 内部注册的回调

来源间通过去重（基于文件路径 resolve）避免重复加载。排序时按来源优先级排列，插件/内置 Hook 优先级最低（`src/utils/hooks/hooksSettings.ts:230-271`）。

### 3. 四种 Hook 执行方式

#### 3.1 命令行 Hook（command）

最基础的执行方式——在 Shell 子进程中运行命令。Hook 输入通过 stdin 以 JSON 传入，通过 exit code 控制行为：
- `exit 0`：成功
- `exit 2`：阻止操作并将 stderr 反馈给模型
- 其他 exit code：显示 stderr 给用户但不阻止

#### 3.2 HTTP Hook（`src/utils/hooks/execHttpHook.ts:123-242`）

向配置的 URL 发送 POST 请求，支持：

- **URL 白名单**：`allowedHttpHookUrls` 配置项控制允许访问的 URL 模式
- **环境变量插值**：Header 值中的 `$VAR_NAME` / `${VAR_NAME}` 会被替换，但仅限 `allowedEnvVars` 中声明的变量
- **CRLF 注入防护**：`sanitizeHeaderValue()` 移除 `\r\n\x00` 字符
- **沙箱代理**：当沙箱启用时，请求通过沙箱网络代理路由
- **SSRF 防护**：非代理模式下使用 `ssrfGuardedLookup` 验证 DNS 解析结果
- **超时**：默认 10 分钟，可通过 `hook.timeout` 配置

```typescript
// src/utils/hooks/execHttpHook.ts:201-217
const response = await axios.post<string>(hook.url, jsonInput, {
  headers,
  signal: combinedSignal,
  proxy: sandboxProxy ?? false,
  lookup: sandboxProxy || envProxyActive ? undefined : ssrfGuardedLookup,
})
```

#### 3.3 Prompt Hook（`src/utils/hooks/execPromptHook.ts:21-211`）

通过**单轮 LLM 调用**评估条件是否满足：

1. 将 `hook.prompt` 中的 `$ARGUMENTS` 替换为 Hook 输入 JSON
2. 使用 `queryModelWithoutStreaming()` 发送请求，模型默认为 `getSmallFastModel()`
3. 强制 JSON Schema 输出格式 `{ ok: boolean, reason?: string }`
4. `ok: true` → 成功；`ok: false` → 阻止操作并携带 `reason`

超时默认 30 秒。

#### 3.4 Agent Hook（`src/utils/hooks/execAgentHook.ts:36-339`）

通过**多轮 LLM Agent 对话**验证条件，适用于需要工具调用的复杂验证：

1. 创建独立的 `hookAgentId`，配置 `dontAsk` 权限模式
2. 过滤掉 `ALL_AGENT_DISALLOWED_TOOLS`（防止子 Agent 嵌套或进入计划模式）
3. 注入 `StructuredOutput` 工具要求 Agent 返回 `{ ok, reason }` 格式
4. 通过 `registerStructuredOutputEnforcement()` 注册 Stop Hook 强制 Agent 调用输出工具
5. 最多执行 50 轮（`MAX_AGENT_TURNS`），超时默认 60 秒
6. 完成后清理 Session Hook

```typescript
// src/utils/hooks/execAgentHook.ts:167-227
for await (const message of query({
  messages: agentMessages,
  systemPrompt,
  canUseTool: hasPermissionsToUseTool,
  toolUseContext: agentToolUseContext,
  querySource: 'hook_agent',
})) {
  // 处理流式消息、计数轮次、提取结构化输出
}
```

### 4. 异步 Hook 生命周期（AsyncHookRegistry）

`AsyncHookRegistry`（`src/utils/hooks/AsyncHookRegistry.ts`）管理后台运行的异步命令 Hook：

1. **注册** `registerPendingAsyncHook()`：记录 Hook 元数据（processId、超时、ShellCommand 引用），启动进度上报定时器
2. **轮询** `checkForAsyncHookResponses()`：遍历所有待处理 Hook，检查 ShellCommand 状态：
   - `killed` → 移除
   - `completed` → 解析 stdout 中的 JSON 行，提取同步响应，调用 `finalizeHook()`
   - 其他 → 跳过（仍在执行中）
3. **清理** `finalizePendingAsyncHooks()`：会话结束时终止所有未完成 Hook
4. SessionStart Hook 完成后会调用 `invalidateSessionEnvCache()` 刷新环境变量缓存

全局状态存储在 `Map<string, PendingAsyncHook>` 中，使用 `Promise.allSettled` 隔离单个 Hook 的失败。

### 5. Session 级 Hook 管理

Session Hook 是临时的、内存中的 Hook，生命周期与 Session/Agent 绑定（`src/utils/hooks/sessionHooks.ts`）。

**核心数据结构**：

```typescript
// src/utils/hooks/sessionHooks.ts:62
export type SessionHooksState = Map<string, SessionStore>
```

使用 `Map` 而非 `Record` 是关键性能优化——在 N 个并行 Agent 同时注册 Hook 时，`Map.set()` 是 O(1) 且不触发 store listener，避免了 O(N²) 的复制开销。

**两类 Hook**：
- **HookCommand**：可序列化（command/prompt/agent/http），通过 `addSessionHook()` 注册
- **FunctionHook**：TypeScript 回调函数，仅存在于内存，通过 `addFunctionHook()` 注册，用于内部验证逻辑（如结构化输出强制）

### 6. 前端 Hook 注册

#### Frontmatter Hook（`src/utils/hooks/registerFrontmatterHooks.ts`）

将 Agent frontmatter 中声明的 Hook 注册为 Session Hook。关键行为：当 `isAgent = true` 时，`Stop` 事件自动转换为 `SubagentStop`，因为子 Agent 触发的是 `SubagentStop` 而非 `Stop`。

#### Skill Hook（`src/utils/hooks/registerSkillHooks.ts`）

将 Skill frontmatter 中的 Hook 注册为 Session Hook。支持 `once: true` 标记——执行成功后自动移除。注册时可传入 `skillRoot` 作为 `CLAUDE_PLUGIN_ROOT` 环境变量。

### 7. 文件变更监听（`src/utils/hooks/fileChangedWatcher.ts`）

基于 chokidar 的文件监听器，支持 `FileChanged` 和 `CwdChanged` 两种 Hook 事件：

1. `initializeFileChangedWatcher(cwd)` 在会话启动时初始化
2. 从 Hook 配置中解析 `matcher` 字段获取静态监听路径（如 `.envrc|.env`）
3. Hook 输出可返回 `watchPaths` 动态更新监听列表
4. 工作目录变更时（`onCwdChangedForHooks()`）重新计算路径并重启监听
5. chokidar 配置了 500ms 写入稳定阈值避免频繁触发

## 函数签名与参数说明

### `execHttpHook(hook, hookEvent, jsonInput, signal?)`

HTTP Hook 执行入口。

| 参数 | 类型 | 说明 |
|------|------|------|
| `hook` | `HttpHook` | Hook 配置（url、headers、allowedEnvVars、timeout） |
| `hookEvent` | `HookEvent` | 触发事件类型 |
| `jsonInput` | `string` | JSON 格式的 Hook 输入数据 |
| `signal` | `AbortSignal?` | 可选的取消信号 |

返回 `{ ok, statusCode?, body, error?, aborted? }`。

### `execPromptHook(hook, hookName, hookEvent, jsonInput, signal, toolUseContext, messages?, toolUseID?)`

Prompt Hook 执行入口。返回 `HookResult`，outcome 可为 `success`、`blocking`、`non_blocking_error`、`cancelled`。

### `execAgentHook(hook, hookName, hookEvent, jsonInput, signal, toolUseContext, toolUseID, messages, agentName?)`

Agent Hook 执行入口。支持最多 50 轮多轮对话，返回 `HookResult`。

### `createApiQueryHook<TResult>(config)`

API 查询 Hook 工厂（`src/utils/hooks/apiQueryHookHelper.ts:56-141`）。接受 `ApiQueryHookConfig<TResult>` 配置对象：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `QuerySource` | 查询来源标识 |
| `shouldRun` | `(ctx) => Promise<boolean>` | 是否执行的条件判断 |
| `buildMessages` | `(ctx) => Message[]` | 构建发送给模型的消息 |
| `parseResponse` | `(content, ctx) => TResult` | 解析模型响应 |
| `getModel` | `(ctx) => string` | 延迟获取模型标识（避免过早访问配置） |

### `registerPendingAsyncHook(params)`

注册异步 Hook 到全局注册表。`asyncTimeout` 默认 15 秒。

### `addFunctionHook(setAppState, sessionId, event, matcher, callback, errorMessage, options?)`

注册内存中的 Function Hook，返回唯一 `hookId`。

## 类型定义

### `HookEvent`（26 种事件）

| 事件 | 触发时机 | 支持 Matcher |
|------|---------|-------------|
| `PreToolUse` | 工具执行前 | `tool_name` |
| `PostToolUse` | 工具执行后 | `tool_name` |
| `PostToolUseFailure` | 工具执行失败后 | `tool_name` |
| `PermissionDenied` | 自动模式拒绝工具 | `tool_name` |
| `PermissionRequest` | 权限对话框显示时 | `tool_name` |
| `Notification` | 发送通知时 | `notification_type` |
| `UserPromptSubmit` | 用户提交提示词 | — |
| `SessionStart` | 会话开始 | `source` |
| `SessionEnd` | 会话结束 | `reason` |
| `Stop` | Claude 即将结束响应 | — |
| `StopFailure` | API 错误导致轮次结束 | `error` |
| `SubagentStart` | 子 Agent 启动 | `agent_type` |
| `SubagentStop` | 子 Agent 即将结束 | `agent_type` |
| `PreCompact` / `PostCompact` | 上下文压缩前后 | `trigger` |
| `Setup` | 仓库初始化/维护 | `trigger` |
| `CwdChanged` | 工作目录变更 | — |
| `FileChanged` | 监听文件变更 | 文件名模式 |
| `ConfigChange` | 配置文件变更 | `source` |
| `InstructionsLoaded` | 指令文件加载 | `load_reason` |
| `WorktreeCreate` / `WorktreeRemove` | Worktree 创建/移除 | — |
| `Elicitation` / `ElicitationResult` | MCP 用户输入请求 | `mcp_server_name` |
| `TeammateIdle` / `TaskCreated` / `TaskCompleted` | 团队协作事件 | — |

### `HookSource`

```typescript
type HookSource =
  | 'userSettings' | 'projectSettings' | 'localSettings'
  | 'policySettings' | 'pluginHook' | 'sessionHook' | 'builtinHook'
```

### `PendingAsyncHook`

```typescript
type PendingAsyncHook = {
  processId: string
  hookId: string
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  toolName?: string
  pluginId?: string
  startTime: number
  timeout: number           // 默认 15000ms
  command: string
  responseAttachmentSent: boolean
  shellCommand?: ShellCommand
  stopProgressInterval: () => void
}
```

### `FunctionHook`

```typescript
type FunctionHook = {
  type: 'function'
  id?: string
  timeout?: number          // 默认 5000ms
  callback: (messages: Message[], signal?: AbortSignal) => boolean | Promise<boolean>
  errorMessage: string
  statusMessage?: string
}
```

## SSRF 防护机制

`ssrfGuard.ts` 实现了 DNS 级别的 SSRF 防护，作为 axios 的 `lookup` 回调注入，确保验证的 IP 就是实际连接的 IP（无 rebinding 窗口）。

**阻止的地址范围**：
- `0.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`（私有网络）
- `169.254.0.0/16`（链路本地/云元数据）
- `100.64.0.0/10`（CGNAT，部分云元数据如阿里云 `100.100.100.200`）
- IPv6 等价范围（`fc00::/7`、`fe80::/10`、`::ffff:<blocked-v4>`）

**明确允许**：`127.0.0.0/8` 和 `::1`（loopback），因为本地开发策略服务器是 HTTP Hook 的主要用例。

IPv4-mapped IPv6 地址会被展开并委托给 IPv4 检查，防止 `::ffff:a9fe:a9fe` 绕过（`src/utils/hooks/ssrfGuard.ts:97-104`）。

## Hook 事件广播系统

`hookEvents.ts` 提供与主消息流分离的事件广播机制：

- **三种事件**：`started`（Hook 开始）、`progress`（进度更新）、`response`（完成）
- **缓冲机制**：Handler 注册前的事件暂存于队列（最多 100 条），注册后立即回放
- **过滤策略**：`SessionStart` 和 `Setup` 始终广播；其他事件仅在 `allHookEventsEnabled`（SDK 的 `includeHookEvents` 选项或 `CLAUDE_CODE_REMOTE` 模式）时广播
- **进度定时器**：`startHookProgressInterval()` 每秒检查输出变化并广播（`src/utils/hooks/hookEvents.ts:124-151`）

## 技能改进检测

`skillImprovement.ts` 是 `apiQueryHookHelper` 的实际消费者，实现了一个后采样 Hook：

1. 每 5 轮用户消息触发一次
2. 仅当存在项目级 Skill 时运行
3. 使用小型快速模型分析最近对话，检测用户对 Skill 的改进建议
4. 检测到的更新通过 `setAppState` 存入 `skillImprovement` 状态
5. `applySkillImprovement()` 使用 LLM 重写 Skill 文件

## 边界 Case 与注意事项

- **无限递归保护**：`execPromptHook` 和 `execAgentHook` 使用 `createUserMessage()` 而非 `processUserInput()`，避免触发 `UserPromptSubmit` Hook 导致无限递归
- **并发安全**：`SessionHooksState` 使用 `Map` 而非 `Record`，`.set()` 不改变容器身份，避免在 N 个并行 Agent 场景下的 O(N²) 复制和不必要的 listener 触发
- **代理场景下的 SSRF**：当沙箱代理或环境变量代理活跃时，跳过 SSRF 检查——代理处理 DNS，直接检查会误判代理自身的私有 IP
- **配置文件去重**：当从 home 目录运行时，`userSettings` 和 `projectSettings` 可能指向同一文件，通过 `resolve()` 后的路径比较去重
- **Agent Hook 清理**：Agent Hook 完成后必须调用 `clearSessionHooks()` 清理为其注册的 Stop Hook，否则会泄漏到主会话
- **`getModel` 延迟调用**：`ApiQueryHookConfig` 的 `getModel` 是函数而非值，因为配置对象在允许访问 settings 之前就被创建