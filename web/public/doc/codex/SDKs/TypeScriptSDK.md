# TypeScript SDK（@openai/codex-sdk）

## 概述与职责

TypeScript SDK 是 Codex 项目提供的 Node.js/TypeScript 客户端库，包名为 `@openai/codex-sdk`。它允许开发者以编程方式与 Codex agent 交互——创建会话线程、提交 prompt、接收流式事件或等待完整结果返回。

在整体架构中，该模块属于 **SDKs** 层。它不直接与 Core 或 AppServer 通信，而是通过 `child_process.spawn` 调用 Codex CLI 的 `codex exec --experimental-json` 子命令，以 JSONL 格式接收事件流。这意味着使用 SDK 的前提是本地安装了 `@openai/codex` npm 包（含平台对应的 Rust 二进制文件）。

同级模块还包括 Python SDK（通过 app-server 的 WebSocket/HTTP API 交互）和 npm CLI 分发包（打包和分发 Rust 二进制）。

## 关键流程

### 1. 初始化与二进制定位

```
Codex 构造函数 → CodexExec 构造函数 → findCodexPath()
```

1. 用户创建 `Codex` 实例，可传入 `CodexOptions`（API key、base URL、CLI 路径覆盖、环境变量、config 覆盖）
2. `Codex` 内部实例化 `CodexExec`，它负责实际的进程管理
3. 若未提供 `codexPathOverride`，`findCodexPath()` 根据当前平台（`process.platform` + `process.arch`）推导 target triple（如 `aarch64-apple-darwin`），然后通过 Node.js 的 `createRequire` 解析 `@openai/codex` → 平台特定包（如 `@openai/codex-darwin-arm64`）→ `vendor/<triple>/codex/codex` 二进制路径（`src/exec.ts:317-389`）

支持的平台包括：
- Linux x64/arm64（musl）
- macOS x64/arm64
- Windows x64/arm64

### 2. 创建线程与执行 Turn

```
codex.startThread() → thread.run(input) 或 thread.runStreamed(input)
```

1. `startThread()` 创建一个 `Thread` 实例，关联 `CodexExec` 和配置选项（`src/codex.ts:25-27`）
2. 调用 `thread.run(input)` 执行同步模式：内部调用 `runStreamedInternal()`，收集所有事件后返回 `Turn`（包含 `items`、`finalResponse`、`usage`）
3. 调用 `thread.runStreamed(input)` 执行流式模式：返回 `StreamedTurn`，其 `events` 字段为 `AsyncGenerator<ThreadEvent>`，调用方可逐个消费事件

### 3. CLI 进程调用（核心执行路径）

`CodexExec.run()` 是整个 SDK 的核心方法（`src/exec.ts:72-226`），它是一个 `AsyncGenerator<string>`：

1. **构建命令行参数**：以 `exec --experimental-json` 为基础，根据传入的选项拼接 `--model`、`--sandbox`、`--cd`、`--config`、`--output-schema`、`--image` 等参数。config 覆盖项会通过 `serializeConfigOverrides()` 展平为 TOML 格式的 `key=value` 字符串
2. **设置环境变量**：如果用户提供了 `env` 则使用用户的；否则继承 `process.env`。始终设置 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_sdk_ts` 用于遥测标识。如果提供了 `apiKey` 则注入 `CODEX_API_KEY` 环境变量
3. **spawn 子进程**：通过 `child_process.spawn` 启动 CLI 二进制，将用户 prompt 写入 stdin 后关闭
4. **逐行读取 stdout**：使用 `readline.createInterface` 按行读取 CLI 的 JSONL 输出，每行 yield 一个字符串
5. **错误处理与清理**：收集 stderr 内容；进程退出码非 0 或被信号终止时抛出包含 stderr 信息的错误；支持 `AbortSignal` 取消正在进行的执行

### 4. 事件流解析

`Thread.runStreamedInternal()`（`src/thread.ts:70-112`）将 `CodexExec.run()` yield 的每行 JSON 字符串解析为 `ThreadEvent` 类型：

- 收到 `thread.started` 事件时，提取 `thread_id` 保存到 Thread 实例，用于后续 resume
- 每个解析后的事件通过 `yield` 传递给消费方
- 如果 turn 提供了 `outputSchema`，会先通过 `createOutputSchemaFile()` 将 JSON schema 写入临时文件，结束后自动清理

### 5. 恢复已有线程

```
codex.resumeThread(id) → thread.run(input)
```

`resumeThread()` 创建 Thread 时传入已有的 `id`（`src/codex.ts:36-38`），在后续 `CodexExec.run()` 中会追加 `resume <threadId>` 到命令行参数（`src/exec.ts:137-139`），让 CLI 从 `~/.codex/sessions` 中恢复之前的会话状态。

## 公开 API

### `Codex` 类

SDK 的入口类。

```typescript
constructor(options?: CodexOptions)
startThread(options?: ThreadOptions): Thread
resumeThread(id: string, options?: ThreadOptions): Thread
```

### `Thread` 类

代表一轮或多轮对话的会话。

```typescript
get id(): string | null  // 首次 turn 启动后才有值

run(input: Input, turnOptions?: TurnOptions): Promise<Turn>
runStreamed(input: Input, turnOptions?: TurnOptions): Promise<StreamedTurn>
```

`Input` 类型为 `string | UserInput[]`，其中 `UserInput` 支持 `{ type: "text", text: string }` 和 `{ type: "local_image", path: string }` 两种形式，允许发送文本和本地图片。

## 类型定义

### `CodexOptions`（客户端级配置）

| 字段 | 类型 | 说明 |
|------|------|------|
| `codexPathOverride` | `string` | 自定义 CLI 二进制路径 |
| `baseUrl` | `string` | OpenAI API base URL |
| `apiKey` | `string` | API 密钥（注入为 `CODEX_API_KEY` 环境变量） |
| `config` | `CodexConfigObject` | 传递给 CLI 的 `--config key=value` 覆盖项 |
| `env` | `Record<string, string>` | 自定义环境变量（提供后不继承 `process.env`） |

> 源码位置：`src/codexOptions.ts:1-22`

### `ThreadOptions`（线程级配置）

| 字段 | 类型 | 说明 |
|------|------|------|
| `model` | `string` | 使用的模型名称 |
| `sandboxMode` | `SandboxMode` | 沙箱模式：`"read-only"` / `"workspace-write"` / `"danger-full-access"` |
| `workingDirectory` | `string` | 工作目录（`--cd`） |
| `skipGitRepoCheck` | `boolean` | 跳过 git 仓库检查 |
| `modelReasoningEffort` | `ModelReasoningEffort` | 推理投入度：`"minimal"` / `"low"` / `"medium"` / `"high"` / `"xhigh"` |
| `networkAccessEnabled` | `boolean` | 是否允许网络访问 |
| `webSearchMode` | `WebSearchMode` | 网络搜索模式：`"disabled"` / `"cached"` / `"live"` |
| `webSearchEnabled` | `boolean` | 启用网络搜索（旧版配置，推荐用 `webSearchMode`） |
| `approvalPolicy` | `ApprovalMode` | 审批策略：`"never"` / `"on-request"` / `"on-failure"` / `"untrusted"` |
| `additionalDirectories` | `string[]` | 额外工作目录（`--add-dir`） |

> 源码位置：`src/threadOptions.ts:1-20`

### `TurnOptions`（单次 Turn 配置）

| 字段 | 类型 | 说明 |
|------|------|------|
| `outputSchema` | `unknown` | JSON Schema 对象，约束 agent 输出格式 |
| `signal` | `AbortSignal` | 用于取消当前 turn |

> 源码位置：`src/turnOptions.ts:1-6`

### `Turn`（`run()` 返回值）

| 字段 | 类型 | 说明 |
|------|------|------|
| `items` | `ThreadItem[]` | 本轮产生的所有已完成的 item |
| `finalResponse` | `string` | 最后一条 `agent_message` 的文本 |
| `usage` | `Usage \| null` | token 用量统计 |

### 事件类型（`ThreadEvent`）

`ThreadEvent` 是以下事件类型的联合（`src/events.ts:72-80`）：

| 事件类型 | 说明 |
|----------|------|
| `thread.started` | 线程创建，携带 `thread_id` |
| `turn.started` | 一轮对话开始 |
| `turn.completed` | 一轮对话完成，携带 `Usage` |
| `turn.failed` | 一轮对话失败，携带错误信息 |
| `item.started` | 新 item 开始（通常处于进行中状态） |
| `item.updated` | item 更新（如 todo_list 进度变化） |
| `item.completed` | item 完成 |
| `error` | 不可恢复的流级别错误 |

### Item 类型（`ThreadItem`）

`ThreadItem` 是以下 item 类型的联合（`src/items.ts:119-127`）：

| Item 类型 | 说明 |
|-----------|------|
| `agent_message` | agent 的文本或 JSON 回复 |
| `reasoning` | agent 的推理摘要 |
| `command_execution` | 命令执行，包含 command、aggregated_output、exit_code、status |
| `file_change` | 文件变更，包含变更列表（add/delete/update）和状态 |
| `mcp_tool_call` | MCP 工具调用，包含 server、tool、arguments、result |
| `web_search` | 网络搜索请求 |
| `todo_list` | agent 的待办列表 |
| `error` | 非致命错误 |

## 结构化输出

SDK 支持通过 `TurnOptions.outputSchema` 传入 JSON Schema，约束 agent 返回结构化 JSON。内部流程为：

1. `createOutputSchemaFile()` 将 schema 对象序列化为 JSON 文件，写入系统临时目录（`src/outputSchemaFile.ts:10-36`）
2. 文件路径通过 `--output-schema` 参数传给 CLI
3. agent 返回的 `agent_message.text` 将是符合 schema 的 JSON 字符串
4. turn 结束后临时文件自动清理

可以直接传入 JSON Schema 对象，也可以结合 Zod 使用 `zod-to-json-schema` 转换：

```typescript
// 原生 JSON Schema
const turn = await thread.run("Summarize status", {
  outputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] }
});

// Zod + zod-to-json-schema
import z from "zod";
import zodToJsonSchema from "zod-to-json-schema";
const schema = z.object({ summary: z.string() });
const turn = await thread.run("Summarize status", {
  outputSchema: zodToJsonSchema(schema, { target: "openAi" })
});
```

## 配置覆盖机制

`CodexOptions.config` 接受嵌套的 JS 对象，SDK 会自动将其展平为 TOML 格式的 `dotted.key=value` 字符串，通过 `--config` 传递给 CLI。例如：

```typescript
new Codex({
  config: {
    sandbox_workspace_write: {
      network_access: true
    }
  }
});
// 生成 CLI 参数: --config sandbox_workspace_write.network_access=true
```

支持的值类型包括 string、number、boolean、array 和嵌套对象。不支持 `null`。序列化逻辑见 `src/exec.ts:229-315`。

## 边界 Case 与注意事项

- **环境变量隔离**：当 `CodexOptions.env` 被设置时，子进程 **不会** 继承 `process.env`，这意味着 PATH 等系统变量也需要手动提供。这是有意为之的设计（`src/exec.ts:147-156`）
- **Thread ID 延迟赋值**：`thread.id` 在第一个 turn 开始前为 `null`，只有收到 `thread.started` 事件后才会被赋值。在调用 `run()` 或 `runStreamed()` 之前访问 `id` 将得到 `null`
- **平台依赖**：SDK 依赖 `@openai/codex` 包及其平台特定的 optional dependency（如 `@openai/codex-darwin-arm64`）。如果安装时跳过了 optional dependencies，`findCodexPath()` 会抛出明确错误
- **Node.js 版本**：要求 Node.js >= 18
- **AbortSignal 支持**：可通过 `TurnOptions.signal` 或 `CodexExecArgs.signal` 取消正在执行的 turn，底层通过 `spawn` 的 `signal` 选项传递
- **JSONL 解析失败**：如果 CLI 输出了非 JSON 的行，`runStreamedInternal` 会抛出包含原始内容的解析错误
- **turn 失败处理**：`run()` 方法在遇到 `turn.failed` 事件时会抛出 `Error`；`runStreamed()` 则将该事件作为普通事件 yield 出来，由调用方决定如何处理