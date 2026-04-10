# VCR 录放机测试辅助服务

## 概述与职责

VCR（Video Cassette Recorder，录放机）是 Claude Code 的测试辅助服务，位于 `Services > AssistantFeatures` 层级下。它的核心思想借鉴了经典的 VCR 测试模式：**首次运行时录制真实的 API 响应并存储为 fixture 文件，后续运行时直接回放缓存结果**，从而避免重复调用外部 API，使测试既快速又确定性。

该模块与同级的语音输入、提示建议、自动梦境等辅助功能并列，但它的服务对象是**测试基础设施**而非终端用户。上游的 `ApiClient`（Claude API 通信层）在调用模型时会通过 VCR 进行包装，实现透明的录制/回放。

**激活条件**：仅在 `NODE_ENV=test`，或 `USER_TYPE=ant` 且 `FORCE_VCR` 为真时启用（`src/services/vcr.ts:23-33`）。

## 关键流程

### 1. 通用 Fixture 录放流程（`withFixture`）

这是所有 VCR 功能的底层核心，是一个泛型缓存函数（`src/services/vcr.ts:39-86`）：

1. 检查 `shouldUseVCR()` 是否启用 VCR，若未启用则直接执行原始函数
2. 对输入数据做 SHA-1 哈希，取前 12 位作为文件名后缀，生成路径 `fixtures/{fixtureName}-{hash}.json`
3. **回放**：尝试读取该 fixture 文件，若存在则直接返回缓存内容
4. **CI 保护**：若在 CI 环境中且未设置 `VCR_RECORD=1`，抛出明确错误提示开发者先录制 fixture
5. **录制**：执行真实函数，将结果序列化为 JSON 写入 fixture 文件

fixture 根目录由环境变量 `CLAUDE_CODE_TEST_FIXTURES_ROOT` 控制，默认为当前工作目录。

### 2. 消息录放流程（`withVCR`）

专门处理 Claude API 消息响应的录放（`src/services/vcr.ts:88-161`）：

1. 过滤掉 `isMeta` 的用户消息，通过 `normalizeMessagesForAPI()` 规范化消息格式
2. 对每条消息内容执行 **脱水（dehydrate）** 处理——将环境相关的动态值替换为占位符
3. 为每条脱水后的消息分别计算 SHA-1 哈希（取前 6 位），用 `-` 连接作为 fixture 文件名
4. **回放时**：读取缓存后调用 `addCachedCostToTotalSessionCost()` 追踪费用，并通过 `hydrateValue()` 还原占位符为当前环境值，同时生成新的 `randomUUID()` 避免 `sessionStorage` 去重冲突
5. **录制时**：执行真实 API 调用，对输出消息执行脱水处理后存储，fixture 同时保存 `input` 和 `output`

### 3. 流式消息录放（`withStreamingVCR`）

包装异步生成器以支持流式 API 响应的录放（`src/services/vcr.ts:349-380`）：

1. 若 VCR 未启用，直接 `yield*` 透传原始生成器
2. 否则将流式消息收集到 `buffer` 数组中
3. 委托给 `withVCR` 处理缓存逻辑——如果命中缓存则 `yield*` 缓存结果；否则 `yield*` 实时收集的 buffer

### 4. Token 计数录放（`withTokenCountVCR`）

为 token 计数 API 调用提供缓存（`src/services/vcr.ts:382-406`）：

1. 将 `messages` 和 `tools` 序列化后执行脱水处理
2. 额外替换 CWD 的 slug 形式（非字母数字字符替换为 `-`）、UUID 和时间戳为占位符，确保不同运行间 fixture 哈希一致
3. 委托给 `withFixture`，fixture 名为 `token-count`

### 5. 脱水/注水机制

**脱水（`dehydrateValue`）** 将字符串中的动态值替换为稳定占位符（`src/services/vcr.ts:291-336`）：

| 原始值 | 占位符 |
|--------|--------|
| 当前工作目录 (cwd) | `[CWD]` |
| Claude 配置目录 | `[CONFIG_HOME]` |
| `num_files="123"` | `num_files="[NUM]"` |
| `duration_ms="456"` | `duration_ms="[DURATION]"` |
| `cost_usd="789"` | `cost_usd="[COST]"` |
| `Available commands: ...` | `Available commands: [COMMANDS]` |
| `Files modified by user: ...` | `Files modified by user: [FILES]` |

在 Windows 平台上还会处理正斜杠路径、JSON 转义路径等多种路径变体。脱水后还会统一将占位符后的反斜杠路径分隔符规范化为正斜杠，确保跨平台 fixture 哈希一致。

**注水（`hydrateValue`）** 是脱水的逆过程（`src/services/vcr.ts:338-347`），将占位符恢复为当前运行环境的实际值。

## 函数签名

### `withVCR(messages, f)` — 导出

```typescript
export async function withVCR(
  messages: Message[],
  f: () => Promise<(AssistantMessage | StreamEvent | SystemAPIErrorMessage)[]>,
): Promise<(AssistantMessage | StreamEvent | SystemAPIErrorMessage)[]>
```

包装 Claude API 调用，提供消息级别的录放。消息经过脱水处理后生成哈希用于 fixture 查找。

### `withStreamingVCR(messages, f)` — 导出

```typescript
export async function* withStreamingVCR(
  messages: Message[],
  f: () => AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void>,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void>
```

流式版本的 VCR 包装器。将异步生成器的输出收集后委托 `withVCR` 处理缓存，回放时逐条 yield 缓存结果。

### `withTokenCountVCR(messages, tools, f)` — 导出

```typescript
export async function withTokenCountVCR(
  messages: unknown[],
  tools: unknown[],
  f: () => Promise<number | null>,
): Promise<number | null>
```

为 token 计数请求提供 fixture 缓存。额外脱水 UUID、时间戳和 CWD slug，确保哈希稳定性。

### `withFixture<T>(input, fixtureName, f)` — 内部

```typescript
async function withFixture<T>(
  input: unknown,
  fixtureName: string,
  f: () => Promise<T>,
): Promise<T>
```

通用泛型 fixture 管理器。根据输入的 SHA-1 哈希生成确定性文件名，负责缓存读取、CI 保护和缓存写入。

## 配置项与环境变量

| 环境变量 | 说明 |
|---------|------|
| `NODE_ENV` | 值为 `test` 时自动启用 VCR |
| `USER_TYPE` | 值为 `ant` 时配合 `FORCE_VCR` 可强制启用 |
| `FORCE_VCR` | 为真值时（配合 `USER_TYPE=ant`）强制启用 VCR |
| `VCR_RECORD` | 为真值时允许在 CI 环境中录制新 fixture |
| `CLAUDE_CODE_TEST_FIXTURES_ROOT` | fixture 文件存储根目录，默认为当前工作目录 |

## 边界 Case 与注意事项

- **CI 保护机制**：在 CI 环境（`env.isCI` 或 `process.env.CI`）中，若 fixture 缺失且未设置 `VCR_RECORD=1`，会抛出错误并给出明确修复指引。这防止 CI 中意外发起真实 API 调用。`withFixture` 和 `withVCR` 各自独立检查此条件（`src/services/vcr.ts:71-75`、`src/services/vcr.ts:133-137`）
- **UUID 去重问题**：回放时使用 `randomUUID()` 生成新的 UUID，而录制时使用确定性的 `UUID-{index}` 格式。这是因为 `sessionStorage.ts` 按 UUID 去重消息，若跨 VCR 调用复用相同 UUID 会导致不同响应被误判为重复（`src/services/vcr.ts:246-249`）
- **费用追踪**：回放缓存消息时仍会调用 `addCachedCostToTotalSessionCost()` 累计费用，确保测试中的成本统计与真实调用一致（`src/services/vcr.ts:163-173`）
- **跨平台路径兼容**：脱水逻辑针对 Windows 平台做了特殊处理，包括正斜杠路径变体、JSON 转义路径变体，以及占位符后路径分隔符的统一规范化（`src/services/vcr.ts:310-331`）
- **元消息过滤**：`withVCR` 在脱水前会过滤掉 `isMeta` 标记的用户消息，这些消息不参与 fixture 哈希计算（`src/services/vcr.ts:97-105`）
- **非 ENOENT 错误透传**：fixture 读取时仅将"文件不存在"视为缓存未命中，其他文件系统错误会直接抛出