# 全局类型定义与校验 Schema

## 概述与职责

TypesAndSchemas 模块是 Claude Code 的**类型基础设施层**，为整个应用提供统一的 TypeScript 类型定义和运行时校验 Schema。它位于 Infrastructure 层，被几乎所有上层模块（CoreEngine、ToolSystem、Services、TerminalUI 等）所依赖。

该模块包含三个物理位置：

- **`src/types/`** — 手写的核心业务类型定义（命令、Hook、权限、日志、插件、ID、输入等）
- **`src/types/generated/`** — 由 `protoc-gen-ts_proto` 从 Proto 文件自动生成的遥测事件类型
- **`types/`**（仓库根目录）— JS connector 类型桩
- **`src/schemas/`** — 基于 Zod 的 Hook 配置校验 Schema

## 文件结构总览

```
src/types/
├── command.ts          # 命令系统类型（Command、PromptCommand 等）
├── hooks.ts            # Hook 执行与结果类型 + Zod 校验 Schema
├── permissions.ts      # 权限模型全量类型定义
├── logs.ts             # 会话日志与 transcript 消息类型
├── plugin.ts           # 插件加载、配置、错误类型
├── ids.ts              # Branded ID 类型（SessionId、AgentId）
├── textInputTypes.ts   # 终端文本输入组件 Props 类型
└── generated/          # Proto 自动生成的遥测类型
    ├── google/protobuf/timestamp.ts
    └── events_mono/
        ├── common/v1/auth.ts
        ├── claude_code/v1/claude_code_internal_event.ts
        └── growthbook/v1/growthbook_experiment_event.ts

types/
└── connectorText.js    # JS connector 类型桩（空实现）

src/schemas/
└── hooks.ts            # Hook 配置的 Zod 校验 Schema（4 种 Hook 类型）
```

## 关键流程

### 类型如何被消费

1. **命令注册**：`src/types/command.ts` 定义了 `Command` 联合类型，被命令注册系统（commands.ts）使用。每个命令是 `CommandBase` 加上 `PromptCommand | LocalCommand | LocalJSXCommand` 三者之一
2. **权限校验**：`src/types/permissions.ts` 的类型贯穿整个权限检查链——从 `PermissionMode` 确定模式，到 `PermissionRule` 匹配规则，到 `PermissionDecision` 输出决策
3. **Hook 执行**：`src/types/hooks.ts` 定义了 Hook 的输入/输出/结果类型，`src/schemas/hooks.ts` 提供对应的 Zod 运行时校验
4. **会话持久化**：`src/types/logs.ts` 的 `Entry` 联合类型（18 种变体）定义了所有可写入 transcript 的消息格式
5. **遥测上报**：`src/types/generated/` 的 Proto 生成类型被 analytics 服务用于构造符合 schema 的事件对象

### 权限决策数据流

权限系统是类型最复杂的部分，数据流如下：

1. 工具请求触发权限检查
2. 根据 `PermissionMode`（`default` / `acceptEdits` / `bypassPermissions` / `plan` / `dontAsk`）确定基础策略
3. 查找匹配的 `PermissionRule`（来自 userSettings / projectSettings / session 等 8 种来源）
4. 产出 `PermissionDecision`：`allow`（放行）/ `ask`（交互确认）/ `deny`（拒绝）
5. 决策附带 `PermissionDecisionReason`（11 种原因类型：rule、mode、hook、classifier 等）

## 核心类型详解

### 命令系统 (`src/types/command.ts`)

`Command` 是一个判别联合类型，由 `CommandBase` 和三种命令实现组合：

```typescript
export type Command = CommandBase &
  (PromptCommand | LocalCommand | LocalJSXCommand)
```

> 源码位置：`src/types/command.ts:205-206`

**`CommandBase`** 包含所有命令共享的元数据：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 命令名称 |
| `description` | `string` | 命令描述 |
| `availability` | `CommandAvailability[]` | 可用的认证环境（`'claude-ai'` / `'console'`） |
| `isEnabled` | `() => boolean` | 动态启用检查（特性门控等） |
| `isHidden` | `boolean` | 是否从自动补全隐藏 |
| `loadedFrom` | `string` | 来源：`'skills'` / `'plugin'` / `'mcp'` / `'bundled'` 等 |
| `kind` | `'workflow'` | 工作流命令标记 |
| `immediate` | `boolean` | 是否立即执行（跳过队列） |

三种命令实现：

- **`PromptCommand`**（`type: 'prompt'`）：LLM 提示词命令，包含 `getPromptForCommand()` 方法生成提示内容。支持 `context: 'inline' | 'fork'` 控制执行方式（内联展开 vs 子 Agent 执行）
- **`LocalCommand`**（`type: 'local'`）：本地命令，通过 `load()` 懒加载实现模块
- **`LocalJSXCommand`**（`type: 'local-jsx'`）：返回 React 节点的本地命令，用于需要 UI 渲染的交互

辅助函数：
- `getCommandName(cmd)` — 获取用户可见名称（`src/types/command.ts:209-211`）
- `isCommandEnabled(cmd)` — 检查命令是否启用（`src/types/command.ts:214-216`）

### 权限模型 (`src/types/permissions.ts`)

这是整个模块中最大的类型文件，专门提取为独立文件以**打破循环依赖**（文件头注释明确说明）。

**权限模式：**

```typescript
export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan',
] as const
export type InternalPermissionMode = ExternalPermissionMode | 'auto' | 'bubble'
```

> 源码位置：`src/types/permissions.ts:16-29`

`auto` 模式受特性门控 `TRANSCRIPT_CLASSIFIER` 控制，仅在内部构建中可用（`src/types/permissions.ts:33-36`）。

**权限规则结构：**

| 类型 | 说明 |
|------|------|
| `PermissionRuleSource` | 规则来源（8 种：`userSettings` / `projectSettings` / `localSettings` / `flagSettings` / `policySettings` / `cliArg` / `command` / `session`） |
| `PermissionRuleValue` | 规则内容：`{ toolName, ruleContent? }` |
| `PermissionRule` | 完整规则：来源 + 行为（`allow`/`deny`/`ask`）+ 值 |
| `PermissionUpdate` | 权限更新操作（6 种判别联合：`addRules` / `replaceRules` / `removeRules` / `setMode` / `addDirectories` / `removeDirectories`） |

**权限决策结果：**

`PermissionDecision<Input>` 是泛型判别联合，支持三种结果：

- **`PermissionAllowDecision`**：放行，可携带 `updatedInput`（修改后的工具输入）
- **`PermissionAskDecision`**：需要用户确认，包含建议的权限更新 `suggestions`、可选的异步分类器检查 `pendingClassifierCheck`
- **`PermissionDenyDecision`**：拒绝，附带原因

`PermissionDecisionReason` 有 11 种变体，涵盖规则匹配、模式默认、Hook 覆盖、分类器判定、沙箱覆盖等场景（`src/types/permissions.ts:271-324`）。

**Bash 分类器类型：**

用于 `auto` 模式下的自动权限判定：

```typescript
export type YoloClassifierResult = {
  shouldBlock: boolean
  reason: string
  model: string
  stage?: 'fast' | 'thinking'  // 两阶段分类器
  // ... 丰富的遥测字段
}
```

> 源码位置：`src/types/permissions.ts:346-397`

### Hook 类型与校验 (`src/types/hooks.ts` + `src/schemas/hooks.ts`)

Hook 系统跨两个文件：`src/types/hooks.ts` 定义运行时类型和响应校验 Schema，`src/schemas/hooks.ts` 定义配置校验 Schema。

**Hook 配置 Schema（`src/schemas/hooks.ts`）：**

`HookCommandSchema` 是 4 种 Hook 类型的判别联合：

| Hook 类型 | 判别值 | 说明 | 特有字段 |
|-----------|--------|------|----------|
| `BashCommandHook` | `type: 'command'` | Shell 命令 | `command`, `shell`, `async`, `asyncRewake` |
| `PromptHook` | `type: 'prompt'` | LLM 提示词 | `prompt`, `model` |
| `AgentHook` | `type: 'agent'` | Agent 验证器 | `prompt`, `model` |
| `HttpHook` | `type: 'http'` | HTTP 请求 | `url`, `headers`, `allowedEnvVars` |

共享字段：`if`（条件过滤，使用权限规则语法如 `"Bash(git *)"`）、`timeout`、`statusMessage`、`once`

> 源码位置：`src/schemas/hooks.ts:31-171`

配置层级：`HooksSchema` → `HookMatcherSchema`（含 `matcher` 和 `hooks` 数组）→ `HookCommandSchema`

```typescript
export const HooksSchema = lazySchema(() =>
  z.partialRecord(z.enum(HOOK_EVENTS), z.array(HookMatcherSchema())),
)
```

> 源码位置：`src/schemas/hooks.ts:211-213`

**Hook 响应 Schema（`src/types/hooks.ts`）：**

`hookJSONOutputSchema` 校验 Hook 的 JSON 输出，分为同步和异步两种：

- **异步响应**：`{ async: true, asyncTimeout?: number }` — Hook 在后台运行
- **同步响应**：丰富的结构，包含 `continue`、`decision`（`approve`/`block`）、`systemMessage`，以及按 Hook 事件名区分的 `hookSpecificOutput`（15 种事件特定输出）

> 源码位置：`src/types/hooks.ts:49-176`

**Hook 执行结果类型：**

```typescript
export type HookResult = {
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled'
  permissionBehavior?: 'ask' | 'deny' | 'allow' | 'passthrough'
  updatedInput?: Record<string, unknown>
  // ...
}
```

> 源码位置：`src/types/hooks.ts:260-275`

`AggregatedHookResult` 聚合多个 Hook 的结果，合并 `blockingErrors` 数组和 `additionalContexts`（`src/types/hooks.ts:277-290`）。

编译时类型安全断言确保 Zod Schema 推断类型与 SDK 手写类型完全一致：

```typescript
type _assertSDKTypesMatch = Assert<IsEqual<SchemaHookJSONOutput, HookJSONOutput>>
```

> 源码位置：`src/types/hooks.ts:198-200`

### 会话日志类型 (`src/types/logs.ts`)

定义了会话持久化的全部消息格式。

**核心类型 `LogOption`**：表示一个可恢复的会话记录，包含消息列表、元数据（分支、PR 链接、Agent 信息）、以及恢复所需的状态快照（`worktreeSession`、`contentReplacements`、`contextCollapseCommits` 等）。

> 源码位置：`src/types/logs.ts:19-53`

**`Entry` 联合类型**（18 种变体）：所有可写入 transcript 文件的条目类型：

| 分类 | 类型 |
|------|------|
| 核心消息 | `TranscriptMessage`、`SummaryMessage`、`LastPromptMessage` |
| 会话元数据 | `CustomTitleMessage`、`AiTitleMessage`、`TagMessage`、`ModeEntry` |
| Agent 信息 | `AgentNameMessage`、`AgentColorMessage`、`AgentSettingMessage` |
| GitHub 集成 | `PRLinkMessage` |
| 状态快照 | `FileHistorySnapshotMessage`、`AttributionSnapshotMessage`、`WorktreeStateEntry`、`ContentReplacementEntry` |
| 上下文压缩 | `ContextCollapseCommitEntry`、`ContextCollapseSnapshotEntry` |
| 其他 | `QueueOperationMessage`、`SpeculationAcceptMessage` |

> 源码位置：`src/types/logs.ts:297-318`

上下文压缩条目使用了混淆的类型判别符（`'marble-origami-commit'`、`'marble-origami-snapshot'`），注释说明这是为了避免在外部构建中泄露特性门控名称（`src/types/logs.ts:249-254`）。

### 插件类型 (`src/types/plugin.ts`)

**`LoadedPlugin`**：已加载插件的完整描述，包含清单信息、各组件路径（commands、agents、skills、outputStyles）、Hook 配置、MCP/LSP 服务器配置。

> 源码位置：`src/types/plugin.ts:48-70`

**`PluginError`**：25 种判别联合，覆盖插件生命周期全部可能错误——从 Git 认证失败、清单解析错误、到 MCP 服务器重复、LSP 启动崩溃、市场策略拦截等。

> 源码位置：`src/types/plugin.ts:101-283`

`getPluginErrorMessage()` 函数为每种错误生成用户可读消息（`src/types/plugin.ts:295-363`）。

### Branded ID 类型 (`src/types/ids.ts`)

使用 TypeScript 品牌类型防止 Session ID 和 Agent ID 在编译时混淆：

```typescript
export type SessionId = string & { readonly __brand: 'SessionId' }
export type AgentId = string & { readonly __brand: 'AgentId' }
```

> 源码位置：`src/types/ids.ts:10-17`

`toAgentId()` 使用正则 `/^a(?:.+-)?[0-9a-f]{16}$/` 验证 Agent ID 格式（`a` + 可选标签 + 16 位十六进制字符）。

### 文本输入类型 (`src/types/textInputTypes.ts`)

为终端 UI 的文本输入组件定义 Props 和状态类型。核心类型包括：

- **`BaseTextInputProps`**：40+ 个属性，覆盖光标控制、粘贴处理、Vim 模式、ghost text 自动补全等
- **`QueuedCommand`**：命令队列条目，支持 `'now'`/`'next'`/`'later'` 三级优先级
- **`PromptInputMode`**：`'bash'` / `'prompt'` / `'orphaned-permission'` / `'task-notification'`

> 源码位置：`src/types/textInputTypes.ts:27-202`（BaseTextInputProps）、`src/types/textInputTypes.ts:299-358`（QueuedCommand）

### 自动生成类型 (`src/types/generated/`)

由 `protoc-gen-ts_proto v2.6.1` 从 Proto 文件生成，**不可手动编辑**。每个生成的 interface 附带 `MessageFns<T>` 工具对象（`fromJSON`、`toJSON`、`create`、`fromPartial`）。

三个核心生成类型：

- **`ClaudeCodeInternalEvent`**：内部遥测事件，包含事件名、模型、会话 ID、环境元数据、SWE-bench 字段、Slack 上下文等 30+ 字段（`src/types/generated/events_mono/claude_code/v1/claude_code_internal_event.ts:80-130`）
- **`GrowthbookExperimentEvent`**：A/B 实验分组事件，跟踪用户被分配到哪个实验变体（`src/types/generated/events_mono/growthbook/v1/growthbook_experiment_event.ts:16-41`）
- **`PublicApiAuth`**：API 认证上下文，包含 `account_id`、`organization_uuid`、`account_uuid`

### JS Connector 类型桩 (`types/connectorText.js`)

仓库根目录的 `types/connectorText.js` 是一个空实现桩，导出空函数 `connectorText`。用于 Bun 编译时的模块占位。

## 配置项与默认值

### Hook Schema 默认行为

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `shell` | `'bash'`（使用 $SHELL） | Hook 命令的 Shell 解释器 |
| `timeout` | 无默认（可选） | Hook 执行超时秒数 |
| `once` | `false` | 执行一次后移除 |
| `async` | `false` | 后台运行不阻塞 |
| `asyncRewake` | `false` | 后台运行，exit code 2 时唤醒模型 |

### 权限模式默认

| 模式 | 行为 |
|------|------|
| `default` | 敏感操作需用户确认 |
| `acceptEdits` | 文件编辑自动放行 |
| `bypassPermissions` | 跳过所有权限检查 |
| `plan` | 规划模式 |
| `dontAsk` | 不提示直接拒绝 |
| `auto`（内部） | 分类器自动判定 |

## 边界 Case 与注意事项

- **循环依赖打破**：`permissions.ts` 和 `src/schemas/hooks.ts` 都被专门提取以打破 import 循环。前者从 `src/utils/permissions/` 中抽离（见文件头注释），后者从 `src/utils/settings/types.ts` 中抽离
- **Zod 懒加载**：所有 Schema 使用 `lazySchema()` 包装，延迟实例化以避免模块加载顺序问题
- **生成类型不可编辑**：`src/types/generated/` 下的文件有明确的 `DO NOT EDIT` 标记，由 `protoc-gen-ts_proto` 工具链维护
- **混淆判别符**：上下文压缩相关类型使用 `'marble-origami-commit'` 等非描述性字符串作为判别符，防止特性门控名称泄露到外部构建
- **`auto` 模式条件编译**：`INTERNAL_PERMISSION_MODES` 使用 `feature('TRANSCRIPT_CLASSIFIER')` Bun 编译时条件，`auto` 模式仅在内部构建中存在
- **AgentHook Schema 注意**：注释明确禁止在 `AgentHookSchema.prompt` 上添加 `.transform()`，因为这会导致 `JSON.stringify` 丢失用户配置（参见注释中的 gh-24920 / CC-79 事故引用）