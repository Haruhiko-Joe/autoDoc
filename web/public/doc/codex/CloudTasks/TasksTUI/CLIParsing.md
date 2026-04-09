# CLI 参数解析（CLIParsing）

## 概述与职责

本模块是 **CloudTasks → TasksTUI** 子系统的命令行入口定义层，使用 [clap](https://docs.rs/clap) 声明式地定义了 `codex cloud` 命令的所有子命令和参数。它不包含任何业务逻辑——职责仅限于将用户在终端中输入的参数解析为强类型的 Rust 结构体，供 TUI 应用或 headless 执行路径消费。

在整体架构中，CloudTasks 是 Codex 的远程云端任务管理模块，TasksTUI 是其终端界面。本模块位于 TasksTUI 内部，处于最外层——接收用户输入后，将解析结果传递给后端初始化、认证和 TUI 事件循环等下游组件。

## 关键结构

### 顶层入口 `Cli`

```rust
pub struct Cli {
    pub config_overrides: CliConfigOverrides,  // 通过 #[clap(skip)] 跳过 CLI 解析，由程序内部注入
    pub command: Option<Command>,              // 可选子命令；为 None 时启动交互式 TUI
}
```
> 源码位置：`codex-rs/cloud-tasks/src/cli.rs:5-13`

`Cli` 派生了 `Parser` 和 `Default`。`config_overrides` 字段标记为 `#[clap(skip)]`，不从命令行解析，而是在运行时由外层注入（来自 `codex-utils-cli` 的 `CliConfigOverrides`）。`command` 是 `Option<Command>`——当用户不指定子命令时为 `None`，此时 TUI 以交互模式启动。

### 子命令枚举 `Command`

```rust
pub enum Command {
    Exec(ExecCommand),    // 提交新任务（headless）
    Status(StatusCommand), // 查看任务状态
    List(ListCommand),     // 列出任务
    Apply(ApplyCommand),   // 将 diff 应用到本地
    Diff(DiffCommand),     // 显示 unified diff
}
```
> 源码位置：`codex-rs/cloud-tasks/src/cli.rs:15-27`

五个子命令覆盖了云端任务的完整生命周期：创建、查询、列表、查看差异、应用差异。

## 函数签名与参数说明

### `ExecCommand` — 提交新任务

| 参数 | 类型 | CLI 标志 | 默认值 | 说明 |
|------|------|----------|--------|------|
| `query` | `Option<String>` | 位置参数 `QUERY` | — | 任务 prompt |
| `environment` | `String` | `--env ENV_ID` | 必填 | 目标环境标识符 |
| `attempts` | `usize` | `--attempts N` | `1` | best-of-N 尝试次数，范围 1–4 |
| `branch` | `Option<String>` | `--branch BRANCH` | 当前分支 | 指定运行分支 |

> 源码位置：`codex-rs/cloud-tasks/src/cli.rs:29-50`

### `StatusCommand` — 查看任务状态

| 参数 | 类型 | CLI 标志 | 说明 |
|------|------|----------|------|
| `task_id` | `String` | 位置参数 `TASK_ID` | 任务标识符 |

> 源码位置：`codex-rs/cloud-tasks/src/cli.rs:74-79`

### `ListCommand` — 列出任务

| 参数 | 类型 | CLI 标志 | 默认值 | 说明 |
|------|------|----------|--------|------|
| `environment` | `Option<String>` | `--env ENV_ID` | — | 按环境过滤 |
| `limit` | `i64` | `--limit N` | `20` | 返回数量上限，范围 1–20 |
| `cursor` | `Option<String>` | `--cursor CURSOR` | — | 分页游标 |
| `json` | `bool` | `--json` | `false` | 输出 JSON 格式 |

> 源码位置：`codex-rs/cloud-tasks/src/cli.rs:81-98`

### `ApplyCommand` — 应用 diff 到本地

| 参数 | 类型 | CLI 标志 | 说明 |
|------|------|----------|------|
| `task_id` | `String` | 位置参数 `TASK_ID` | 任务标识符 |
| `attempt` | `Option<usize>` | `--attempt N` | 指定尝试编号（1-based），范围 1–4 |

> 源码位置：`codex-rs/cloud-tasks/src/cli.rs:100-109`

### `DiffCommand` — 显示 unified diff

| 参数 | 类型 | CLI 标志 | 说明 |
|------|------|----------|------|
| `task_id` | `String` | 位置参数 `TASK_ID` | 任务标识符 |
| `attempt` | `Option<usize>` | `--attempt N` | 指定尝试编号（1-based），范围 1–4 |

> 源码位置：`codex-rs/cloud-tasks/src/cli.rs:111-120`

## 内部验证函数

模块包含两个自定义 `value_parser` 函数，用于在参数解析阶段进行范围校验：

- **`parse_attempts(input: &str) -> Result<usize, String>`**（`cli.rs:52-61`）：将输入解析为 `usize`，要求值在 1–4 之间。被 `ExecCommand.attempts`、`ApplyCommand.attempt` 和 `DiffCommand.attempt` 共用。
- **`parse_limit(input: &str) -> Result<i64, String>`**（`cli.rs:63-72`）：将输入解析为 `i64`，要求值在 1–20 之间。仅用于 `ListCommand.limit`。

两个函数在输入不合法时返回人类可读的错误消息，clap 会自动将其展示给用户。

## 边界 Case 与注意事项

- **无子命令时的行为**：`Cli.command` 是 `Option<Command>`，当用户仅运行 `codex cloud` 不带子命令时，值为 `None`，由调用方决定进入交互式 TUI 模式。
- **`config_overrides` 跳过解析**：`CliConfigOverrides` 通过 `#[clap(skip)]` 标记，不会出现在 `--help` 输出中，也不接受命令行输入。它由上层代码在构造 `Cli` 后手动注入。
- **`attempts` 范围限制**：1–4 的上限意味着 best-of-N 最多支持 4 个并行尝试，这是后端的硬限制。
- **`limit` 使用 `i64` 而非 `usize`**：这可能是为了与后端 API 的签名类型对齐（某些 API 使用有符号整数），尽管逻辑范围始终为正数 1–20。
- **`ExecCommand.query` 是可选的**：prompt 可以不通过命令行传入，暗示可能有其他输入方式（如 stdin 或后续交互）。