# Token 计数与估算服务

## 概述与职责

`tokenEstimation.ts` 是 Services 层 AssistantFeatures 中的 Token 计数与估算模块，提供两类互补的 Token 计量能力：

1. **精确计数**：通过 Anthropic countTokens API（或等效的 Bedrock/Vertex 接口）获取精确的 input token 数
2. **粗略估算**：基于字节长度的快速本地估算，用于 API 不可用时的降级方案

该模块是上下文窗口管理（自动压缩触发、消息预算控制）的基础设施——只有知道当前消耗了多少 Token，系统才能决定何时压缩、何时截断。

在祖先层级中，它位于 **Services → AssistantFeatures** 下，与语音输入、提示建议、VCR 录放等辅助功能并列，同时依赖 **ApiClient** 进行实际的 API 通信。

## 关键流程

### 1. 精确 Token 计数（`countMessagesTokensWithAPI`）

这是模块的核心入口，完整流程如下：

1. 获取当前主循环模型（`getMainLoopModel()`）和对应的 beta 特性列表
2. 检测消息中是否包含 thinking blocks（`hasThinkingBlocks()`）
3. **根据 API 提供商分派**：
   - **Bedrock**：走 `countTokensWithBedrock()` 独立路径（因 `@anthropic-sdk/bedrock-sdk` 不支持 `countTokens`）
   - **Vertex**：过滤 beta 列表（仅保留 `VERTEX_COUNT_TOKENS_ALLOWED_BETAS` 白名单内的），避免 400 错误
   - **直连（Anthropic）**：直接调用 `anthropic.beta.messages.countTokens()`
4. 如果消息列表为空但有工具定义，插入 dummy 消息 `{ role: 'user', content: 'foo' }` 以获取准确的工具 token 数
5. 如果消息包含 thinking blocks，附加 `thinking` 参数（budget=1024, max_tokens=2048）
6. 整个调用被 `withTokenCountVCR()` 包裹，支持测试时的 fixture 录放

> 源码位置：`src/services/tokenEstimation.ts:140-201`

### 2. Bedrock 专用路径（`countTokensWithBedrock`）

由于 Bedrock SDK 不直接支持 `countTokens`，此函数通过底层 `CountTokensCommand` 实现：

1. 创建 Bedrock Runtime 客户端（`createBedrockRuntimeClient()`）
2. 解析模型 ID——如果不是基础模型（foundation model），需通过 `getInferenceProfileBackingModel()` 获取实际模型 ID
3. 构造请求体（包含 `anthropic_version`、messages、tools、thinking 配置等）
4. **动态导入** `@aws-sdk/client-bedrock-runtime`（延迟加载约 279KB 的 AWS SDK 代码）
5. 将请求体 JSON 编码后通过 `CountTokensCommand` 发送
6. 从响应中提取 `inputTokens`

> 源码位置：`src/services/tokenEstimation.ts:437-495`

### 3. Haiku 降级计数（`countTokensViaHaikuFallback`）

当主模型的 `countTokens` 不可用时，通过调用一个廉价模型（Haiku）的 `messages.create` 来获取 usage 中的 token 计数：

1. **模型选择策略**（`src/services/tokenEstimation.ts:274-277`）：
   - Vertex 全局区域 → 使用 Sonnet（Haiku 不可用）
   - Bedrock + thinking blocks → 使用 Sonnet（Haiku 3.5 不支持 thinking）
   - Vertex + thinking blocks → 使用 Sonnet
   - 其他情况 → 使用 `getSmallFastModel()`（默认 Haiku，尊重 `ANTHROPIC_SMALL_FAST_MODEL` 环境变量）
2. 调用 `stripToolSearchFieldsFromMessages()` 清理消息
3. 发送 `messages.create` 请求（`max_tokens=1` 或 thinking 模式下 `max_tokens=2048`）
4. 返回 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` 的总和

> 源码位置：`src/services/tokenEstimation.ts:251-325`

### 4. 工具搜索字段清理（`stripToolSearchFieldsFromMessages`）

在发送 token 计数请求前，需要清理 tool search beta 引入的非标准字段，否则 API 会报错：

- 从 `tool_use` blocks 中移除 `caller` 字段（仅保留 `type`/`id`/`name`/`input`）
- 从 `tool_result` blocks 的 content 中过滤掉 `tool_reference` 类型的 block
- 如果过滤后 `tool_result.content` 为空，替换为 `[{ type: 'text', text: '[tool references]' }]` 占位

> 源码位置：`src/services/tokenEstimation.ts:66-122`

## 函数签名与参数说明

### 导出函数

#### `countTokensWithAPI(content: string): Promise<number | null>`

对单条文本内容进行精确 token 计数。空字符串直接返回 0。内部将 content 包装为 user 消息后委托给 `countMessagesTokensWithAPI`。

#### `countMessagesTokensWithAPI(messages, tools): Promise<number | null>`

对完整的消息列表 + 工具定义进行精确 token 计数。返回 `input_tokens` 数值，失败时返回 `null`。

- **messages**: `Anthropic.Beta.Messages.BetaMessageParam[]` — 要计数的消息列表
- **tools**: `Anthropic.Beta.Messages.BetaToolUnion[]` — 工具定义列表

#### `countTokensViaHaikuFallback(messages, tools): Promise<number | null>`

通过调用廉价模型获取 token 计数（含缓存 token）。签名与 `countMessagesTokensWithAPI` 相同。

#### `roughTokenCountEstimation(content: string, bytesPerToken?: number): number`

基于字符长度的粗略 token 估算。默认比率为 4 字节/token。

#### `roughTokenCountEstimationForFileType(content: string, fileExtension: string): number`

根据文件类型使用不同的字节比率进行估算，JSON 类文件使用 2 字节/token（因单字符 token 密度更高）。

#### `bytesPerTokenForFileType(fileExtension: string): number`

返回文件扩展名对应的字节/token 比率。`json`/`jsonl`/`jsonc` 返回 2，其他返回 4。

#### `roughTokenCountEstimationForMessages(messages): number`

对消息数组进行批量粗略 token 估算。

#### `roughTokenCountEstimationForMessage(message): number`

对单条消息进行粗略估算，支持 `assistant`/`user` 消息和 `attachment` 类型。附件通过 `normalizeAttachmentForAPI()` 规范化后再估算。

### 内部函数

#### `hasThinkingBlocks(messages): boolean`

检测消息列表中是否包含 `thinking` 或 `redacted_thinking` 类型的 block。

#### `stripToolSearchFieldsFromMessages(messages): BetaMessageParam[]`

清理 tool search beta 引入的非标准字段。

#### `roughTokenCountEstimationForBlock(block): number`

对单个 content block 进行粗略 token 估算，按类型分派：

| Block 类型 | 估算策略 |
|---|---|
| `text` | 文本长度 / 4 |
| `image` / `document` | 固定 2000 tokens |
| `tool_use` | name + JSON.stringify(input) 的长度 / 4 |
| `tool_result` | 递归估算其 content |
| `thinking` | thinking 文本长度 / 4 |
| `redacted_thinking` | data 长度 / 4 |
| 其他（server_tool_use 等） | JSON.stringify 后长度 / 4 |

#### `countTokensWithBedrock({model, messages, tools, betas, containsThinking}): Promise<number | null>`

Bedrock 专用的 token 计数实现，使用 `CountTokensCommand`。

## 配置项与常量

| 常量/配置 | 值 | 说明 |
|---|---|---|
| `TOKEN_COUNT_THINKING_BUDGET` | 1024 | thinking 模式下的 budget_tokens 最小值 |
| `TOKEN_COUNT_MAX_TOKENS` | 2048 | thinking 模式下的 max_tokens（API 要求 max_tokens > budget_tokens） |
| `bytesPerToken`（默认） | 4 | 通用文本的粗略估算比率 |
| `bytesPerToken`（JSON） | 2 | JSON 文件的粗略估算比率 |
| image/document 固定值 | 2000 | 图片和 PDF 文档的固定 token 估算值 |

相关环境变量（非本模块直接读取，但影响其行为）：
- `CLAUDE_CODE_USE_VERTEX` — 启用 Vertex 提供商
- `CLAUDE_CODE_USE_BEDROCK` — 启用 Bedrock 提供商
- `ANTHROPIC_SMALL_FAST_MODEL` — 覆盖 Haiku 降级时使用的模型

## 边界 Case 与注意事项

- **空消息列表 + 有工具定义**：插入 dummy 消息 `'foo'` 以确保 API 返回准确的工具 token 数（`src/services/tokenEstimation.ts:177`）
- **Vertex beta 过滤**：某些 beta（如 web-search）在特定 Vertex endpoint 上会导致 400 错误，因此通过白名单过滤（参见 issue #10789）
- **Bedrock 异常响应**：Bedrock 客户端可能返回 `{ Output: { __type: 'UnknownOperationException' } }` 而非抛出异常，通过检查 `response.input_tokens` 是否为 number 来识别（`src/services/tokenEstimation.ts:189-193`）
- **AWS SDK 延迟加载**：`@aws-sdk/client-bedrock-runtime` 通过动态 `import()` 延迟加载（约 279KB），仅在实际使用 Bedrock 时才引入
- **图片/文档固定估算值**：图片和 PDF 使用固定 2000 tokens 而非基于 base64 长度估算——因为 base64 编码的 1MB PDF 会被错误估算为 ~325k tokens，而实际 API 计费约 2000 tokens
- **VCR 集成**：`countMessagesTokensWithAPI` 被 `withTokenCountVCR()` 包裹，测试时可录制和回放 token 计数结果，避免实际 API 调用
- **Haiku 降级的 1P 限制**：注释警告如果将降级模型改为非 Haiku 模型，在 1P 环境下请求会失败（除非使用 `getCLISyspromptPrefix`）