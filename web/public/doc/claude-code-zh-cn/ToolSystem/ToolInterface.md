# 工具核心类型与接口定义（Tool.ts）

## 概述与职责

`Tool.ts` 是整个工具系统的**类型基石**，定义了工具（Tool）的完整生命周期接口——从输入校验、权限检查、执行调用，到结果渲染和 UI 展示。它位于 **ToolSystem** 模块内，与同级的 `tools.ts`（中央注册表）和 `tools/` 目录（具体工具实现）配合，构成了 Claude Code 40+ 内置工具的运行框架。

在整体架构中，ToolSystem 被 CoreEngine 调度执行工具，被 Entrypoints 的 MCP Server 入口注册暴露，也与 TaskSystem、SkillsAndPlugins 等模块存在调用关系。本文件定义的 `Tool` 接口是所有这些交互的契约。

## 关键流程

### 工具从定义到实例的构建流程

1. 每个具体工具（如 Bash、Read、Grep）在 `tools/` 目录下以 `ToolDef` 类型编写定义，只需提供核心方法（`call`、`prompt`、`renderToolUseMessage` 等），可省略带默认值的方法
2. 调用 `buildTool(def)` 工厂函数，将 `TOOL_DEFAULTS` 与用户定义做对象展开合并（`src/Tool.ts:787-791`）
3. 返回一个完整的 `Tool` 实例——所有方法都已就绪，调用者无需做空值检查

### 工具执行的核心调用链

当 CoreEngine 决定执行某个工具时，按以下顺序调用 `Tool` 接口方法：

1. **`validateInput(input, context)`**：校验输入合法性，返回 `ValidationResult`（通过或带错误信息的失败）
2. **`checkPermissions(input, context)`**：工具特有的权限检查，返回 `PermissionResult`（allow/deny/ask）
3. **`call(args, context, canUseTool, parentMessage, onProgress?)`**：实际执行工具逻辑，返回 `ToolResult<Output>`
4. **`mapToolResultToToolResultBlockParam(content, toolUseID)`**：将工具输出序列化为 API 所需的 `ToolResultBlockParam` 格式
5. **`renderToolResultMessage(content, progressMessages, options)`**：将结果渲染为终端 UI 的 React 节点

### 权限模型流程

权限上下文 `ToolPermissionContext` 携带当前权限模式、允许/拒绝/需询问的规则集：

1. 系统根据 `ToolPermissionContext.mode`（default/auto/plan 等）确定基础行为
2. 对照 `alwaysAllowRules`、`alwaysDenyRules`、`alwaysAskRules` 匹配工具和输入
3. 工具可通过 `preparePermissionMatcher(input)` 提供自定义的模式匹配逻辑（如 Bash 工具匹配 `"git *"` 模式）
4. 最终决定是直接执行、拒绝还是弹出权限确认

## 核心类型定义

### `Tool<Input, Output, P>` — 工具泛型接口

定义于 `src/Tool.ts:362-695`，是整个工具系统的核心契约。三个泛型参数：

| 泛型参数 | 约束 | 含义 |
|---------|------|------|
| `Input` | `extends AnyObject` | 工具输入的 Zod schema |
| `Output` | 无 | 工具返回数据类型 |
| `P` | `extends ToolProgressData` | 工具进度事件类型 |

**关键方法分组**：

**执行与校验类**：
- `call(args, context, canUseTool, parentMessage, onProgress?)` — 核心执行入口
- `validateInput?(input, context)` — 输入合法性校验（可选）
- `checkPermissions(input, context)` — 工具级权限检查
- `preparePermissionMatcher?(input)` — 生成 hook `if` 条件的匹配闭包

**元信息类**：
- `name: string` — 工具唯一标识
- `aliases?: string[]` — 重命名后的向后兼容别名
- `searchHint?: string` — 供 ToolSearch 关键词匹配的短语
- `inputSchema: Input` — Zod 输入 schema
- `inputJSONSchema?: ToolInputJSONSchema` — MCP 工具的原始 JSON Schema
- `outputSchema?: z.ZodType<unknown>` — 输出 schema
- `maxResultSizeChars: number` — 结果超限后落盘的阈值（`Infinity` 表示永不落盘）
- `strict?: boolean` — 启用 API 严格模式

**行为标记类**：
- `isEnabled()` — 工具是否可用
- `isReadOnly(input)` — 是否只读操作
- `isDestructive?(input)` — 是否不可逆操作（删除、覆盖、发送）
- `isConcurrencySafe(input)` — 是否支持并发执行
- `interruptBehavior?()` — 用户中断时 `'cancel'` 还是 `'block'`
- `isSearchOrReadCommand?(input)` — UI 折叠搜索/读取操作的判断
- `isOpenWorld?(input)` — 是否开放世界操作
- `requiresUserInteraction?()` — 是否需要用户交互
- `shouldDefer?: boolean` — 是否延迟加载（需 ToolSearch 激活）
- `alwaysLoad?: boolean` — 是否总是加载（不延迟）

**渲染类**（均返回 `React.ReactNode`）：
- `renderToolUseMessage(input, options)` — 渲染工具调用消息（流式，input 可能不完整）
- `renderToolResultMessage?(content, progressMessages, options)` — 渲染工具结果
- `renderToolUseProgressMessage?(progressMessages, options)` — 渲染执行中进度
- `renderToolUseRejectedMessage?(input, options)` — 渲染权限拒绝时的 UI
- `renderToolUseErrorMessage?(result, options)` — 渲染错误 UI
- `renderGroupedToolUse?(toolUses, options)` — 并行工具的分组渲染
- `renderToolUseTag?(input)` — 工具调用后的附加标签
- `renderToolUseQueuedMessage?()` — 排队等待时的 UI

**其他**：
- `description(input, options)` — 动态生成工具描述（供 prompt 使用）
- `prompt(options)` — 生成工具的系统提示词
- `userFacingName(input)` — 用户可见的工具名称
- `getToolUseSummary?(input)` — 紧凑视图的摘要
- `getActivityDescription?(input)` — spinner 显示的活动描述
- `toAutoClassifierInput(input)` — 自动模式安全分类器的紧凑输入
- `extractSearchText?(out)` — 转录搜索索引的文本
- `isResultTruncated?(output)` — 非 verbose 模式是否截断
- `backfillObservableInput?(input)` — 为观察者补充遗留/衍生字段
- `getPath?(input)` — 获取工具操作的文件路径
- `inputsEquivalent?(a, b)` — 判断两次输入是否等价
- `isMcp?: boolean` / `isLsp?: boolean` — MCP/LSP 工具标记
- `mcpInfo?` — MCP 工具的原始服务器和工具名

### `ToolUseContext` — 工具执行上下文

定义于 `src/Tool.ts:158-300`，是传递给 `call` 和 `checkPermissions` 的运行时上下文。核心字段：

**`options` 子对象**：
- `commands` — 注册的命令列表
- `debug` / `verbose` — 调试模式
- `mainLoopModel` — 当前使用的模型名
- `tools` — 可用工具集
- `thinkingConfig` — 思考配置
- `mcpClients` — MCP 服务器连接
- `isNonInteractiveSession` — 是否非交互模式
- `agentDefinitions` — Agent 定义
- `maxBudgetUsd?` — 预算上限
- `customSystemPrompt?` / `appendSystemPrompt?` — 自定义系统提示词

**状态管理**：
- `getAppState()` / `setAppState()` — 全局应用状态的读写
- `setAppStateForTasks?` — 跨 Agent 嵌套共享的状态写入（子 Agent 的 `setAppState` 可能是 no-op，此方法始终到达根 store）
- `messages` — 当前对话消息列表
- `abortController` — 取消信号
- `readFileState` — 文件状态缓存

**UI 回调**：
- `setToolJSX?` — 设置工具自定义 JSX 渲染
- `addNotification?` — 添加通知
- `sendOSNotification?` — 操作系统级通知
- `setStreamMode?` — 设置 spinner 模式
- `openMessageSelector?` — 打开消息选择器

**Agent 与任务上下文**：
- `agentId?` / `agentType?` — 子 Agent 标识
- `toolUseId?` — 当前工具调用 ID
- `queryTracking?` — 查询链追踪
- `localDenialTracking?` — 异步子 Agent 的本地拒绝追踪状态

**高级特性**：
- `contentReplacementState?` — 工具结果预算的内容替换状态
- `renderedSystemPrompt?` — 缓存共享的系统提示词（避免 fork 子 Agent 时缓存失效）
- `fileReadingLimits?` / `globLimits?` — 文件读取和 glob 结果的限制
- `toolDecisions?` — 工具决策记录

### `ToolPermissionContext` — 权限上下文

定义于 `src/Tool.ts:123-138`，使用 `DeepImmutable` 包装确保不可变：

| 字段 | 类型 | 说明 |
|------|------|------|
| `mode` | `PermissionMode` | 权限模式（default/auto/plan 等） |
| `additionalWorkingDirectories` | `Map<string, AdditionalWorkingDirectory>` | 额外的工作目录 |
| `alwaysAllowRules` | `ToolPermissionRulesBySource` | 始终允许的规则（按来源分组） |
| `alwaysDenyRules` | `ToolPermissionRulesBySource` | 始终拒绝的规则 |
| `alwaysAskRules` | `ToolPermissionRulesBySource` | 始终询问的规则 |
| `isBypassPermissionsModeAvailable` | `boolean` | 是否可绕过权限模式 |
| `shouldAvoidPermissionPrompts?` | `boolean` | 后台 Agent 自动拒绝权限提示 |
| `awaitAutomatedChecksBeforeDialog?` | `boolean` | 协调器工作线程等待自动检查后再弹窗 |
| `prePlanMode?` | `PermissionMode` | 进入 plan 模式前的权限模式快照 |

`getEmptyToolPermissionContext()` 工厂函数返回全默认值的空上下文（`src/Tool.ts:140-148`）。

### `ValidationResult` — 校验结果

```typescript
type ValidationResult =
  | { result: true }
  | { result: false; message: string; errorCode: number }
```

简洁的联合类型：通过时只有 `result: true`，失败时携带错误消息和错误码（`src/Tool.ts:95-101`）。

### `ToolResult<T>` — 工具返回类型

定义于 `src/Tool.ts:321-336`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `data` | `T` | 工具产出的主数据 |
| `newMessages?` | `Message[]` | 工具执行过程中产生的额外消息 |
| `contextModifier?` | `(context) => context` | 修改后续上下文（仅非并发安全工具生效） |
| `mcpMeta?` | `{ _meta?, structuredContent? }` | MCP 协议元数据透传 |

### `Tools` — 工具集合类型

```typescript
type Tools = readonly Tool[]
```

只读数组别名，用于在整个代码库中统一追踪工具集的组装、传递和过滤（`src/Tool.ts:701`）。

## `buildTool` 工厂函数

定义于 `src/Tool.ts:783-792`，是所有工具定义的统一入口。

**签名**：`buildTool<D extends AnyToolDef>(def: D): BuiltTool<D>`

**作用**：将 `ToolDef`（可省略部分方法）合并 `TOOL_DEFAULTS` 后返回完整的 `Tool`。运行时实现只是对象展开：

```typescript
return { ...TOOL_DEFAULTS, userFacingName: () => def.name, ...def }
```

**默认值一览**（`src/Tool.ts:757-769`）：

| 方法 | 默认行为 | 设计原则 |
|------|---------|---------|
| `isEnabled` | `() => true` | 默认启用 |
| `isConcurrencySafe` | `() => false` | **fail-closed**：假设不安全 |
| `isReadOnly` | `() => false` | **fail-closed**：假设写操作 |
| `isDestructive` | `() => false` | 默认非破坏性 |
| `checkPermissions` | 返回 `{ behavior: 'allow' }` | 交给通用权限系统决定 |
| `toAutoClassifierInput` | `() => ''` | 跳过分类器（安全相关工具必须自行覆盖） |
| `userFacingName` | `() => def.name` | 使用工具名 |

**类型层面**：`BuiltTool<D>` 类型（`src/Tool.ts:735-741`）精确模拟了运行时展开的语义——如果定义提供了某方法则保留其类型，否则用默认类型填充。

## 辅助函数与类型

### 工具查找

- **`toolMatchesName(tool, name)`**（`src/Tool.ts:348-353`）：检查工具是否匹配给定名称（主名称或别名）
- **`findToolByName(tools, name)`**（`src/Tool.ts:358-360`）：从工具集中按名称或别名查找工具

### 进度相关

- **`ToolProgress<P>`**：带 `toolUseID` 的进度事件包装
- **`ToolCallProgress<P>`**：进度回调函数类型 `(progress: ToolProgress<P>) => void`
- **`Progress`**：`ToolProgressData | HookProgress` 联合类型
- **`filterToolProgressMessages()`**（`src/Tool.ts:312-319`）：从进度消息中过滤掉 hook 进度，只保留工具进度

### UI 相关

- **`SetToolJSXFn`**（`src/Tool.ts:103-114`）：设置工具自定义 JSX 的回调类型，支持控制动画、spinner、隐藏输入框等
- **`CompactProgressEvent`**（`src/Tool.ts:150-157`）：压缩操作的进度事件（`hooks_start` / `compact_start` / `compact_end`）

### 其他

- **`ToolInputJSONSchema`**（`src/Tool.ts:15-21`）：JSON Schema 格式的工具输入定义（MCP 工具使用）
- **`QueryChainTracking`**（`src/Tool.ts:90-93`）：查询链追踪，包含 `chainId` 和 `depth`
- **`AnyObject`**（`src/Tool.ts:343`）：`z.ZodType<{ [key: string]: unknown }>` 的别名
- **`ToolDef<Input, Output, P>`**（`src/Tool.ts:721-726`）：`buildTool` 接受的输入类型，与 `Tool` 相同但可省略 `DefaultableToolKeys` 中的方法

## 边界 Case 与注意事项

- **`maxResultSizeChars` 设为 `Infinity`** 的工具（如 Read）其输出永不落盘——因为落盘后 Claude 再次读取会产生循环依赖
- **`isConcurrencySafe` 默认 `false`**：这是 fail-closed 设计，确保未显式声明并发安全的工具不会被并行执行。只有 `contextModifier` 在非并发安全工具上才生效
- **`shouldDefer` 与 `alwaysLoad`** 控制工具的延迟加载策略：延迟工具需要先通过 ToolSearch 激活，而 `alwaysLoad` 工具（通过 MCP 的 `_meta['anthropic/alwaysLoad']` 设置）始终在初始 prompt 中完整出现
- **`backfillObservableInput`** 操作的是输入的**副本**，原始 API 输入不被修改以保护 prompt 缓存
- **`ToolPermissionContext` 使用 `DeepImmutable`** 包装，整个权限上下文在传递过程中不可修改
- **`renderToolUseMessage` 的 `input` 是 `Partial`**：因为流式场景下参数可能尚未完全到达，渲染代码必须处理部分输入
- **进度类型的 re-export**：多个进度类型（`BashProgress`、`AgentToolProgress` 等）从 `types/tools.js` 集中定义后在此 re-export，是为了打破循环导入