# 非交互式执行模块（codex-exec）

## 概述与职责

`codex-exec` 是 Codex CLI 体系中的**非交互/无头运行模式**入口，对应 `codex-exec` 二进制。它在 CLI 层级中位于顶层 `CLI` 节点之下，与 TUI（交互终端界面）并列，为自动化管道、CI/CD、脚本调用等场景提供 Codex agent 的批处理运行能力。

同层兄弟模块包括 TUI（交互终端）、AppServer（IDE 扩展服务）、MCP Server 等子命令。当用户执行 `codex exec` 或直接调用 `codex-exec` 二进制时，CLI 入口将控制权交给本模块。

核心职责：
- 解析 exec 模式专用的 CLI 参数（模型、沙箱策略、prompt、图片、会话恢复/代码审查等）
- 连接进程内 app-server，管理线程（thread）的启动/恢复/审查生命周期
- 从 stdin 或命令行参数读取 prompt
- 消费并处理 app-server 流式事件，输出为人类可读的彩色终端格式或结构化 JSONL 事件流

## 关键流程

### 1. 启动与初始化流程

1. `main()` 函数通过 `arg0_dispatch_or_else` 机制判断调用身份——若 arg0 为 `codex-linux-sandbox` 则转入沙箱逻辑，否则进入标准的 exec 流程（`src/main.rs:28-41`）
2. `run_main()` 解构 `Cli` 参数，按 `--color` 选项决定 ANSI 彩色输出，初始化 tracing 日志层和 OpenTelemetry 遥测（`src/lib.rs:177-467`）
3. 加载配置（`ConfigBuilder`），处理 `--full-auto`、`--dangerously-bypass-approvals-and-sandbox`（别名 `--yolo`）等安全策略覆盖
4. 通过 `InProcessAppServerClient::start()` 启动进程内 app-server 客户端（`src/lib.rs:528-532`）

### 2. 线程生命周期管理

根据子命令类型执行不同的线程操作：

- **新建会话（默认）**：调用 `thread/start` API 创建新线程（`src/lib.rs:568-581`）
- **恢复会话（`resume` 子命令）**：通过 `resolve_resume_thread_id()` 查找目标线程——支持按 UUID、线程名称匹配，或 `--last` 取最近一个；找到后调用 `thread/resume` API（`src/lib.rs:537-566`）
- **代码审查（`review` 子命令）**：构建 `ReviewRequest` 后调用 `review/start` API，支持审查未提交变更、对比基准分支、指定 commit SHA 或自定义指令（`src/lib.rs:704-728`）

### 3. Prompt 解析策略

prompt 输入有三种行为模式，由 `StdinPromptBehavior` 枚举控制（`src/lib.rs:123-133`）：

- **`RequiredIfPiped`**：当无位置参数 prompt 时，从 stdin 管道读取（默认行为）
- **`Forced`**：显式 `-` 参数时强制从 stdin 读取
- **`OptionalAppend`**：位置参数已有 prompt 且 stdin 有管道输入时，将 stdin 内容以 `<stdin>...</stdin>` 块追加到 prompt 后

stdin 输入还支持多编码自动检测：UTF-8 BOM、UTF-16LE/BE BOM、UTF-32 BOM 均会被正确处理或给出转码提示（`src/lib.rs:1499-1544`）。

### 4. 事件循环与通知处理

`run_exec_session()` 的核心是一个 `tokio::select!` 事件循环（`src/lib.rs:738-824`）：

```
loop {
    select! {
        interrupt = interrupt_rx.recv() => { 发送 turn/interrupt 请求 }
        event = client.next_event()     => { 处理事件 }
    }
}
```

收到的事件按类型处理：
- **`ServerRequest`**：exec 模式不支持交互审批，所有审批类请求（命令执行、文件变更、权限请求等）一律被 reject；MCP elicitation 请求自动取消（`src/lib.rs:1322-1445`）
- **`ServerNotification`**：通过 `should_process_notification()` 过滤当前线程/回合相关的通知，交给 `EventProcessor` 处理；当收到 `TurnCompleted` 且状态为完成/失败/中断时触发关闭流程
- **`Lagged`**：记录事件流延迟告警

当收到 `InitiateShutdown` 信号后，发送 `thread/unsubscribe` 请求，退出循环并关闭客户端。若会话过程中出现致命错误，以退出码 1 终止进程。

### 5. 回合完成后的 items 回填

在 `maybe_backfill_turn_completed_items()` 中（`src/lib.rs:1053-1092`），当 `TurnCompleted` 通知的 `items` 为空时（进程内传输在背压下可能丢弃非终态通知），exec 会发起一次 `thread/read` 来补全最终的 turn items，确保输出格式化器能正确提取 final message。

## 函数签名

### `pub async fn run_main(cli: Cli, arg0_paths: Arg0DispatchPaths) -> anyhow::Result<()>`

模块的公开入口函数。接收解析后的 CLI 参数和 arg0 路径信息，完成从配置加载到会话运行的全流程。

> 源码位置：`codex-rs/exec/src/lib.rs:177`

### `async fn run_exec_session(args: ExecRunArgs) -> anyhow::Result<()>`

内部会话运行函数，负责创建 `EventProcessor`、管理线程生命周期和事件循环。

> 源码位置：`codex-rs/exec/src/lib.rs:469`

## CLI 参数定义

`Cli` 结构体定义了所有 exec 模式的命令行参数（`src/cli.rs:8-112`）：

| 参数 | 短选项 | 类型 | 说明 |
|------|--------|------|------|
| `--model` | `-m` | `String` | 指定 agent 使用的模型 |
| `--sandbox` | `-s` | `SandboxModeCliArg` | 沙箱策略 |
| `--image` | `-i` | `Vec<PathBuf>` | 附加图片（支持逗号分隔多个） |
| `--color` | - | `Color` | 输出着色控制：`always`/`never`/`auto` |
| `--json` | - | `bool` | 以 JSONL 格式输出事件流 |
| `--full-auto` | - | `bool` | 便捷模式：自动审批 + workspace-write 沙箱 |
| `--dangerously-bypass-approvals-and-sandbox` | (别名 `--yolo`) | `bool` | 跳过所有审批和沙箱（极度危险） |
| `--cd` | `-C` | `PathBuf` | 指定工作目录 |
| `--output-schema` | - | `PathBuf` | JSON Schema 文件路径，约束模型最终响应格式 |
| `--output-last-message` | `-o` | `PathBuf` | 将 agent 最后一条消息写入指定文件 |
| `--ephemeral` | - | `bool` | 不持久化会话文件到磁盘 |
| `--oss` | - | `bool` | 使用开源模型提供者 |
| `--add-dir` | - | `Vec<PathBuf>` | 额外可写目录 |
| `PROMPT` | (位置参数) | `String` | 初始指令，`-` 表示从 stdin 读取 |

### 子命令

**`resume`**（`ResumeArgs`）：恢复之前的会话

- `SESSION_ID`：UUID 或线程名称
- `--last`：恢复最近一个会话（按 cwd 过滤）
- `--all`：禁用 cwd 过滤
- `PROMPT`：恢复后发送的 prompt

**`review`**（`ReviewArgs`）：执行代码审查

- `--uncommitted`：审查所有未提交的变更
- `--base BRANCH`：与指定基准分支对比
- `--commit SHA`：审查指定 commit 引入的变更
- `--title TITLE`：commit 标题（需配合 `--commit`）
- `PROMPT`：自定义审查指令

## 接口/类型定义

### `EventProcessor` trait

事件处理的核心抽象（`src/event_processor.rs:13-29`），定义三个方法：

- `print_config_summary()`：打印有效配置和用户 prompt 概要
- `process_server_notification()`：处理 app-server 通知，返回 `CodexStatus`（`Running` 或 `InitiateShutdown`）
- `process_warning()`：处理本地警告

两个实现分别对应两种输出格式。

### `ThreadEvent` 枚举（JSONL 事件 Schema）

`--json` 模式下输出的顶层事件类型（`src/exec_events.rs:9-37`），序列化为带 `type` 标签的 JSON：

| 变体 | 序列化名称 | 说明 |
|------|-----------|------|
| `ThreadStarted` | `thread.started` | 新线程启动，携带 `thread_id` |
| `TurnStarted` | `turn.started` | 新回合开始 |
| `TurnCompleted` | `turn.completed` | 回合完成，携带 `Usage`（token 用量） |
| `TurnFailed` | `turn.failed` | 回合失败，携带 `ThreadErrorEvent` |
| `ItemStarted` | `item.started` | 新 item 开始（通常为进行中状态） |
| `ItemUpdated` | `item.updated` | item 状态更新 |
| `ItemCompleted` | `item.completed` | item 达到终态 |
| `Error` | `error` | 不可恢复错误 |

### `ThreadItemDetails` 枚举

JSONL 模式中 `ThreadItem` 的具体 payload 类型（`src/exec_events.rs:100-128`）：

- **`AgentMessage`**：agent 的文本/JSON 响应
- **`Reasoning`**：推理摘要
- **`CommandExecution`**：命令执行（command、output、exit_code、status）
- **`FileChange`**：文件变更集（路径+增/删/改）
- **`McpToolCall`**：MCP 工具调用（server、tool、arguments、result、error）
- **`CollabToolCall`**：协作 agent 工具调用
- **`WebSearch`**：Web 搜索请求
- **`TodoList`**：agent 的待办清单
- **`Error`**：非致命错误

### `Usage` 结构体

Token 用量统计（`src/exec_events.rs:60-68`）：

```rust
pub struct Usage {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
}
```

## 输出格式化器

### Human-Readable 格式（`EventProcessorWithHumanOutput`）

默认输出模式（`src/event_processor_with_human_output.rs`），特性：

- 根据 `--color` 配置使用 `owo-colors` 库进行终端彩色渲染
- 所有状态信息输出到 **stderr**（命令执行状态、警告、配置摘要等）
- 最终 agent 消息在管道场景下输出到 **stdout**，在纯终端场景下根据是否已渲染过决定是否补输出到 stderr
- 启动时打印配置摘要：版本号、workdir、model、provider、approval policy、sandbox policy、reasoning effort、session id
- Token 用量在最终输出时显示"混合总量"（非缓存输入 + 输出 token）

### JSONL 格式（`EventProcessorWithJsonOutput`）

`--json` 模式的输出格式化器（`src/event_processor_with_jsonl_output.rs`），特性：

- 每个事件输出为 stdout 上的一行 JSON（JSONL 格式）
- 维护 `raw_to_exec_item_id` 映射表，将 app-server 内部 item ID 映射为稳定的序列 ID（`item_0`、`item_1`...）
- `ItemStarted` 事件跳过 `AgentMessage` 和 `Reasoning` 类型（只在完成时输出）
- 回合完成时通过 `reconcile_unfinished_started_items()` 补发未完成的 started items 的 completed 事件
- 追踪 `RunningTodoList` 状态，将 `TurnPlanUpdated` 通知转换为 `TodoList` item 的 started/updated/completed 生命周期事件
- 序列化失败时降级输出包含错误信息的 JSON 对象

## 边界 Case 与注意事项

- **stdout 严格性**：模块顶部 `#![deny(clippy::print_stdout)]` 确保只有最终消息（默认模式）或 JSONL 事件（json 模式）写入 stdout，所有其他输出走 stderr
- **审批请求处理**：exec 模式不支持交互式审批，所有 `ServerRequest` 类的审批请求（命令执行、文件变更、apply-patch、权限、动态工具调用等）一律被 reject；MCP elicitation 自动取消
- **Ctrl+C 处理**：监听 `SIGINT` 信号后发送 `turn/interrupt` 请求而非直接终止进程，确保优雅关闭
- **事件回填**：进程内通道在背压下可能丢弃中间通知但保证 `TurnCompleted`，exec 在收到空 items 的完成通知时主动通过 `thread/read` 补全
- **Git 仓库检查**：默认要求在 Git 仓库内运行，`--skip-git-repo-check` 或 `--yolo` 可绕过
- **编码检测**：stdin 输入支持 UTF-8（含 BOM）和 UTF-16LE/BE 自动检测，不支持 UTF-32
- **`--last` 的位置参数歧义**：当使用 `resume --last` 时，位置参数被解释为 prompt 而非 session ID（`ResumeArgs::from(ResumeArgsRaw)` 中的特殊处理，`src/cli.rs:174-191`）
- **进程退出码**：当 server 报告致命错误（`will_retry=false`）或回合以 Failed/Interrupted 状态结束时，进程以退出码 1 退出