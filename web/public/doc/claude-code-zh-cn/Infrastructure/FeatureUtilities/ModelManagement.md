# 模型管理（ModelManagement）

## 概述与职责

模型管理模块是 Claude Code 基础设施层（Infrastructure → FeatureUtilities）中的核心子系统，负责**模型选择、能力检测、多提供商适配和运行时配置**。它为整个应用提供统一的模型抽象层——无论用户通过 Anthropic 第一方 API、AWS Bedrock、GCP Vertex 还是 Foundry 接入，上层代码都通过该模块获取正确的模型标识符、能力矩阵和 Beta 特性头。

同级兄弟模块包括 ShellAndBash（Shell 执行）、GitOperations（Git 操作）、ConfigAndSettings（配置管理）等；本模块依赖 ConfigAndSettings 获取设置和特性开关，同时被 CoreEngine（查询引擎）和 Services（API 通信层）广泛调用。

核心职责：
- **模型标识符统一**：将不同提供商的模型 ID 映射为统一的规范名称
- **别名解析**：将用户友好的别名（`sonnet`、`opus`、`haiku`）解析为具体模型 ID
- **能力检测**：判断模型是否支持 thinking、结构化输出、自动模式等特性
- **多提供商适配**：为 Anthropic/Bedrock/Vertex/Foundry 生成正确的模型字符串
- **Beta 特性管理**：根据模型能力和提供商动态组装 API Beta 头
- **Token 预算与计量**：统计上下文窗口使用量，支持用户指定 Token 预算

## 关键流程

### 1. 模型选择与解析流程

用户可通过多种途径指定模型，`getUserSpecifiedModelSetting()` 按以下优先级解析（`src/utils/model/model.ts:61-78`）：

1. `/model` 命令的会话内覆盖（`getMainLoopModelOverride()`）
2. `--model` 启动参数
3. `ANTHROPIC_MODEL` 环境变量
4. `settings.json` 中的 `model` 字段

解析到的值传入 `parseUserSpecifiedModel()`（`src/utils/model/model.ts:445-506`），该函数执行：
1. 检查是否为模型别名（`sonnet`→`getDefaultSonnetModel()`，`opus`→`getDefaultOpusModel()` 等）
2. 处理 `[1m]` 后缀（1M 上下文窗口标记）
3. 对 1P 提供商上的过时 Opus 4.0/4.1 执行自动重映射到当前默认版本
4. 对内部用户解析 Ant 专属模型配置
5. 保留自定义模型名称的原始大小写（如 Foundry 部署 ID）

```
用户输入 "opus[1m]"
  → isModelAlias("opus") = true
  → getDefaultOpusModel() = "claude-opus-4-6"
  → 返回 "claude-opus-4-6[1m]"
```

### 2. 多提供商模型字符串生成

每个模型在不同提供商有不同的 ID 格式。`configs.ts` 定义了全量映射表（`src/utils/model/configs.ts:9-99`），例如 Opus 4.6：

| 提供商 | 模型 ID |
|--------|---------|
| firstParty | `claude-opus-4-6` |
| bedrock | `us.anthropic.claude-opus-4-6-v1` |
| vertex | `claude-opus-4-6` |
| foundry | `claude-opus-4-6` |

`getModelStrings()`（`src/utils/model/modelStrings.ts:136-145`）根据当前提供商返回完整映射。Bedrock 提供商有特殊处理：异步查询 AWS 推理配置文件列表（`getBedrockInferenceProfiles()`），用实际可用的配置文件 ID 替代硬编码默认值。

提供商通过环境变量确定（`src/utils/model/providers.ts:6-14`）：
- `CLAUDE_CODE_USE_BEDROCK=1` → `bedrock`
- `CLAUDE_CODE_USE_VERTEX=1` → `vertex`
- `CLAUDE_CODE_USE_FOUNDRY=1` → `foundry`
- 默认 → `firstParty`

### 3. 规范名称映射

`getCanonicalName()`（`src/utils/model/model.ts:279-283`）将任意格式的模型 ID 统一为短规范名。先通过 `resolveOverriddenModel()` 处理用户在 `modelOverrides` 中配置的自定义 ID（如 Bedrock ARN），再用 `firstPartyNameToCanonical()` 做子串匹配：

```
"us.anthropic.claude-opus-4-6-v1"  → "claude-opus-4-6"
"claude-sonnet-4-5-20250929"       → "claude-sonnet-4-5"
"claude-3-7-sonnet-20250219"       → "claude-3-7-sonnet"
```

这个统一的规范名被能力检测、Beta 选择、显示名称等所有下游逻辑使用。

### 4. Beta 特性头组装

`getAllModelBetas()`（`src/utils/betas.ts:234-369`）是 Beta 头组装的核心函数，根据模型能力和提供商动态构建头列表：

1. 非 Haiku 模型添加 `claude-code-20250219` 基础头
2. OAuth 订阅者添加 OAuth Beta 头
3. 1M 上下文模型添加 `context-1m` 头
4. 支持交错思考的模型添加 `interleaved-thinking` 头
5. 支持结构化输出的模型添加 `structured-outputs` 头（仅 1P/Foundry）
6. Vertex 上的 Claude 4+ 模型添加 `web-search` 头
7. 1P 提供商添加 `prompt-caching-scope` 头
8. 用户通过 `ANTHROPIC_BETAS` 环境变量添加的自定义头

Bedrock 有特殊处理：部分 Beta 通过 `extraBodyParams` 传递而非 HTTP 头（`getBedrockExtraBodyParamsBetas()`，`src/utils/betas.ts:379-384`）。

### 5. 思考模式控制

`thinking.ts` 管理模型的思考（thinking）能力（`src/utils/thinking.ts:90-162`）：

- **`modelSupportsThinking()`**：1P/Foundry 上所有非 Claude 3 模型支持；3P 上仅 Opus 4+ 和 Sonnet 4+
- **`modelSupportsAdaptiveThinking()`**：仅 Opus 4.6 和 Sonnet 4.6 支持自适应思考；对未知模型在 1P/Foundry 上默认启用
- **`shouldEnableThinkingByDefault()`**：除非 `MAX_THINKING_TOKENS=0` 或设置中 `alwaysThinkingEnabled=false`，否则默认启用
- **`isUltrathinkEnabled()`**：受编译时 feature flag 和 GrowthBook 双重门控

`ThinkingConfig` 类型定义了三种思考模式：`adaptive`（自适应）、`enabled`（固定预算）、`disabled`（禁用）。

### 6. Token 计量与预算

**Token 计量**（`src/utils/tokens.ts`）提供多层次的 Token 统计：

- `tokenCountWithEstimation()`（`src/utils/tokens.ts:226-261`）是**规范的上下文大小测量函数**，用于自动压缩和会话记忆触发。它取最后一个 API 响应的完整 usage（input + output + cache），加上后续新消息的粗略估算。特别处理了并行工具调用场景——多个拆分的 assistant 记录共享同一 `message.id`，函数会回溯到第一个同 ID 记录以避免漏算中间的 tool_result。

- `getTokenCountFromUsage()`（`src/utils/tokens.ts:46-53`）：从 API usage 计算完整上下文 Token 数
- `finalContextTokensFromLastResponse()`（`src/utils/tokens.ts:79-112`）：用于 task_budget 剩余量计算，使用 iterations 数据

**Token 预算**（`src/utils/tokenBudget.ts`）解析用户在提示词中指定的 Token 预算：

```
"+500k"              → 500,000
"use 2M tokens"      → 2,000,000
"+1.5b"              → 1,500,000,000
```

支持三种格式：消息开头的简写（`+500k`）、消息结尾的简写、和自然语言形式（`use/spend X tokens`）。`findTokenBudgetPositions()` 返回匹配位置用于 UI 高亮。

## 函数签名与参数说明

### 模型选择核心

#### `getMainLoopModel(): ModelName`
获取当前会话的主循环模型。按优先级查找用户指定模型，无指定则返回默认模型。
> 源码位置：`src/utils/model/model.ts:92-98`

#### `parseUserSpecifiedModel(modelInput: ModelName | ModelAlias): ModelName`
将用户输入（别名或模型名）解析为完整模型 ID。处理别名展开、`[1m]` 后缀、过时模型重映射等。
> 源码位置：`src/utils/model/model.ts:445-506`

#### `getCanonicalName(fullModelName: ModelName): ModelShortName`
将任意格式的模型 ID 映射为跨提供商统一的短规范名。
> 源码位置：`src/utils/model/model.ts:279-283`

#### `getRuntimeMainLoopModel(params): ModelName`
运行时模型选择，支持 `opusplan`（计划模式用 Opus）和 `haiku`（计划模式升级为 Sonnet）等特殊行为。
> 源码位置：`src/utils/model/model.ts:145-167`

### 提供商与配置

#### `getAPIProvider(): APIProvider`
返回当前 API 提供商：`'firstParty' | 'bedrock' | 'vertex' | 'foundry'`
> 源码位置：`src/utils/model/providers.ts:6-14`

#### `getModelStrings(): ModelStrings`
返回当前提供商下所有模型的 ID 映射表，已应用 `modelOverrides` 设置。
> 源码位置：`src/utils/model/modelStrings.ts:136-145`

### 能力检测

#### `modelSupportsThinking(model: string): boolean`
检测模型是否支持思考模式。1P/Foundry 上非 Claude 3 模型均支持；3P 仅支持 Opus 4+/Sonnet 4+。
> 源码位置：`src/utils/thinking.ts:90-110`

#### `modelSupportsISP(model: string): boolean`
检测是否支持交错思考（Interleaved Thinking）。Foundry 全部支持，1P 排除 Claude 3。
> 源码位置：`src/utils/betas.ts:92-112`

#### `modelSupportsStructuredOutputs(model: string): boolean`
检测是否支持结构化输出。仅 1P/Foundry 上的特定 Claude 4+ 模型。
> 源码位置：`src/utils/betas.ts:142-157`

#### `modelSupportsAutoMode(model: string): boolean`
检测是否支持自动模式（PI 探测）。受 feature flag、GrowthBook 配置和提供商限制。
> 源码位置：`src/utils/betas.ts:160-195`

### Token 计量

#### `tokenCountWithEstimation(messages: readonly Message[]): number`
**规范的上下文大小测量函数**。基于最后一个 API 响应的 usage 加上后续消息的估算。用于自动压缩阈值判断。
> 源码位置：`src/utils/tokens.ts:226-261`

#### `parseTokenBudget(text: string): number | null`
从用户消息中解析 Token 预算指令，支持 k/m/b 后缀。
> 源码位置：`src/utils/tokenBudget.ts:21-29`

## 接口/类型定义

### `APIProvider`
```typescript
type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry'
```
四种支持的 API 提供商。

### `ModelConfig`
```typescript
type ModelConfig = Record<APIProvider, ModelName>
```
每个模型在四个提供商下的 ID 映射。

### `ModelAlias`
```typescript
type ModelAlias = 'sonnet' | 'opus' | 'haiku' | 'best' | 'sonnet[1m]' | 'opus[1m]' | 'opusplan'
```
用户可使用的模型别名。`opusplan` 是特殊别名：计划模式用 Opus，其他模式用 Sonnet。

### `ThinkingConfig`
```typescript
type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }
```
三种思考模式配置。

### `ModelCapability`
```typescript
type ModelCapability = {
  id: string
  max_input_tokens?: number
  max_tokens?: number
}
```
从 API 动态获取的模型能力元数据，缓存在 `~/.claude/cache/model-capabilities.json`。

### `AntModel`
```typescript
type AntModel = {
  alias: string        // 模型别名
  model: string        // 实际模型 ID
  label: string        // 显示名称
  contextWindow?: number
  defaultMaxTokens?: number
  alwaysOnThinking?: boolean  // 是否强制启用思考
  // ...
}
```
Anthropic 内部用户的模型配置，通过 GrowthBook feature flag 动态下发。

### `ModelCapabilityOverride`
```typescript
type ModelCapabilityOverride = 'effort' | 'max_effort' | 'thinking' | 'adaptive_thinking' | 'interleaved_thinking'
```
3P 提供商可通过环境变量覆盖的模型能力维度。

## 配置项与默认值

### 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `ANTHROPIC_MODEL` | 指定使用的模型 | 无（使用默认模型） |
| `CLAUDE_CODE_USE_BEDROCK` | 使用 Bedrock 提供商 | 未设置 |
| `CLAUDE_CODE_USE_VERTEX` | 使用 Vertex 提供商 | 未设置 |
| `CLAUDE_CODE_USE_FOUNDRY` | 使用 Foundry 提供商 | 未设置 |
| `ANTHROPIC_BASE_URL` | 自定义 API 端点 | `api.anthropic.com` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | 覆盖默认 Opus 模型 ID | 无 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | 覆盖默认 Sonnet 模型 ID | 无 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | 覆盖默认 Haiku 模型 ID | 无 |
| `ANTHROPIC_SMALL_FAST_MODEL` | 轻量快速模型（分类器等） | Haiku 默认值 |
| `ANTHROPIC_BETAS` | 自定义 Beta 头（逗号分隔） | 无 |
| `MAX_THINKING_TOKENS` | 思考 Token 预算（0 禁用） | 无（默认启用） |
| `DISABLE_INTERLEAVED_THINKING` | 禁用交错思考 | 未设置 |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | 禁用实验性 Beta | 未设置 |
| `CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP` | 禁用过时模型自动重映射 | 未设置 |
| `CLAUDE_CODE_SUBAGENT_MODEL` | 覆盖子 Agent 模型 | 无（继承父线程） |

### 默认模型选择逻辑

- **Max/Team Premium 订阅者**：默认 Opus 4.6（启用 1M 合并时为 Opus 4.6[1m]）
- **Pro/Team Standard/Enterprise**：默认 Sonnet 4.6
- **PAYG 1P**：默认 Sonnet 4.6
- **PAYG 3P**：默认 Sonnet 4.5（3P 可能尚未支持最新版本）

## 边界 Case 与注意事项

- **Bedrock 跨区域推理配置文件**：子 Agent 自动继承父模型的区域前缀（如 `eu.`、`us.`），除非子 Agent 自身已指定区域前缀。这确保 IAM 权限作用域内的一致性（`src/utils/model/agent.ts:47-67`）。

- **过时模型自动重映射**：在 1P 提供商上，`claude-opus-4-20250514` 和 `claude-opus-4-1-20250805` 会自动重映射到当前默认 Opus。3P 提供商不执行此重映射，因为容量可能滞后。可通过 `CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP=1` 禁用（`src/utils/model/model.ts:538-554`）。

- **模型白名单**：管理员可通过 `settings.json` 的 `availableModels` 限制可用模型。支持三层匹配：家族别名通配（`"opus"` 允许所有 Opus）、版本前缀（`"opus-4-5"` 仅允许该版本）、精确 ID。当同时存在家族别名和具体版本时，具体版本优先（`src/utils/model/modelAllowlist.ts:100-170`）。

- **模型验证**：`validateModel()` 通过实际发送最小 API 请求来验证模型可用性，结果缓存。对 3P 上不存在的模型会建议降级替代（如 Opus 4.6 → Opus 4.1）（`src/utils/model/validateModel.ts:20-82`）。

- **Beta 缓存**：`getAllModelBetas` 和 `getModelBetas` 使用 `lodash/memoize` 缓存。模型切换或配置变更后需调用 `clearBetasCaches()` 刷新（`src/utils/betas.ts:430-434`）。

- **并行工具调用的 Token 计数**：当模型并行调用多个工具时，流式处理代码会为每个内容块生成独立的 assistant 记录（共享同一 `message.id`）。`tokenCountWithEstimation()` 会回溯到第一个同 ID 记录，确保所有交错的 tool_result 都被计入估算（`src/utils/tokens.ts:216-261`）。

- **SDK Beta 白名单**：通过 SDK 传入的 Beta 头受严格限制，仅允许 `context-1m`。订阅者用户不支持自定义 Beta（`src/utils/betas.ts:37-87`）。

- **Opus 1M 合并**：`isOpus1mMergeEnabled()` 在多种条件下返回 false——包括 Pro 订阅者、3P 提供商、以及订阅类型未知的 OAuth 用户（防止 VS Code 子进程中的过时 Token 导致误判）（`src/utils/model/model.ts:314-332`）。