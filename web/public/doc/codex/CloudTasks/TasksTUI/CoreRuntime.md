# CoreRuntime — 云任务主入口与异步运行时

## 概述与职责

`CoreRuntime` 是 `codex-rs/cloud-tasks` crate 的核心模块（`lib.rs`），负责两件事：

1. **交互模式**：启动基于 ratatui/crossterm 的 TUI 事件循环，提供任务列表浏览、diff 查看、环境切换、任务创建和 apply 操作的全键盘交互体验。
2. **非交互模式**：通过 CLI 子命令（`exec`、`status`、`list`、`apply`、`diff`）直接执行操作并输出结果到 stdout。

在整体架构中，本模块属于 **CloudTasks → TasksTUI** 层级。它依赖 `TasksClient`（`codex_cloud_tasks_client`）进行 API 通信，依赖 `Auth`（`codex_login`）进行 ChatGPT 认证，依赖 `codex_git_utils` 进行 Git 分支解析。同级模块包括 `TasksClient`（API 客户端库）、`TasksMockClient`（mock 实现）和 `CloudRequirements`（云端配置加载）。

本模块还引用了内部子模块 `app`（应用状态管理）、`cli`（CLI 参数定义）、`env_detect`（环境自动检测）、`new_task`（新任务创建页）、`ui`（ratatui 渲染）、`scrollable_diff`（可滚动 diff 组件）和 `util`（工具函数）。

## 关键流程

### 1. 后端初始化与认证流程

所有操作的入口都经过 `init_backend()` 函数（`lib.rs:43-113`）：

1. 在 debug 构建中，检查 `CODEX_CLOUD_TASKS_MODE=mock` 环境变量，若匹配则返回 `MockClient` 跳过真实认证
2. 从 `CODEX_CLOUD_TASKS_BASE_URL` 读取 API 地址，默认为 `https://chatgpt.com/backend-api`
3. 调用 `util::load_auth_manager()` 加载认证管理器，获取 ChatGPT OAuth token
4. 若未登录，打印提示信息并 `exit(1)`
5. 将 bearer token 和 account ID 注入 `HttpClient`，返回 `BackendContext`

```rust
// lib.rs:43-50
async fn init_backend(user_agent_suffix: &str) -> anyhow::Result<BackendContext> {
    #[cfg(debug_assertions)]
    let use_mock = matches!(
        std::env::var("CODEX_CLOUD_TASKS_MODE").ok().as_deref(),
        Some("mock") | Some("MOCK")
    );
    let base_url = std::env::var("CODEX_CLOUD_TASKS_BASE_URL")
        .unwrap_or_else(|_| "https://chatgpt.com/backend-api".to_string());
```

### 2. 入口分发：`run_main()`

`run_main()` 是 `codex cloud` 子命令的公开入口（`lib.rs:737-2021`）。它首先检查是否有 CLI 子命令，有则直接分发到对应的非交互 runner；否则进入 TUI 模式：

```rust
// lib.rs:738-746
if let Some(command) = cli.command {
    return match command {
        crate::cli::Command::Exec(args) => run_exec_command(args).await,
        crate::cli::Command::Status(args) => run_status_command(args).await,
        crate::cli::Command::List(args) => run_list_command(args).await,
        crate::cli::Command::Apply(args) => run_apply_command(args).await,
        crate::cli::Command::Diff(args) => run_diff_command(args).await,
    };
}
```

### 3. TUI 事件循环

TUI 模式的核心是一个 `tokio::select!` 驱动的事件循环（`lib.rs:928-2008`），同时监听三类事件源：

- **`redraw_rx`**：合并后的重绘信号（spinner 动画、paste-burst 微刷新）
- **`rx`**：后台任务完成事件（`AppEvent` 枚举，包括任务加载完成、apply 完成、环境检测完成等）
- **`events`**：crossterm 的终端事件流（键盘、鼠标、粘贴、窗口大小变化）

#### 终端设置

进入 TUI 前的终端配置（`lib.rs:778-794`）：
- 启用 raw mode 和 alternate screen
- 启用 bracketed paste（区分粘贴和键入）
- 推送增强键盘标志（`DISAMBIGUATE_ESCAPE_CODES`、`REPORT_EVENT_TYPES`、`REPORT_ALTERNATE_KEYS`），使 Shift+Enter 可区分于普通 Enter
- 退出时恢复所有终端状态（`lib.rs:2010-2016`）

#### 合并重绘调度器

为避免过于频繁的终端重绘，模块实现了一个独立的合并调度器（`lib.rs:886-912`）：

1. 各事件处理器通过 `frame_tx` 发送"期望重绘时间点"
2. 调度器 task 持续跟踪最早的 deadline，使用 `sleep_until` 等待
3. 到期后通过 `redraw_tx` 发出一次重绘信号
4. 多个请求被合并到同一次重绘——确保 UI 流畅且不浪费 CPU

spinner 动画以 600ms 间隔触发重绘，仅在有加载中操作时才运行（`lib.rs:941-954`）。

#### 键盘处理优先级

键盘事件按以下优先级链处理（`lib.rs:1347-1992`）：

1. **Ctrl+C**：逐层关闭当前打开的 UI 层（环境选择器 → best-of 弹窗 → apply 弹窗 → 新任务编辑器 → diff 覆盖层 → 退出程序）
2. **Ctrl+N**：打开/关闭 best-of-N 尝试次数选择弹窗
3. **Best-of 弹窗**：数字键直选、上下导航、Enter 确认
4. **Ctrl+O**：在新任务编辑模式下打开环境选择器
5. **新任务编辑器**：文本输入委托给 `ComposerInput`，Enter 提交任务，Esc 取消
6. **Apply 确认弹窗**：`y` 执行 apply、`p` 执行 preflight、`n`/`Esc` 取消
7. **Diff 覆盖层**：`a` 触发 apply、Tab/`[]` 切换尝试、Left/Right 切换 prompt/diff 视图、`j`/`k` 滚动、`q`/Esc 关闭
8. **环境选择器**：文本搜索过滤、Enter 选择、Esc 关闭
9. **任务列表**：`j`/`k` 上下选择、`r` 刷新、`o` 打开环境选择器、`n` 新建任务、Enter 查看详情、`a` 快速 apply、`q` 退出

### 4. 后台 Apply/Preflight 操作

`spawn_preflight()` 和 `spawn_apply()`（`lib.rs:620-730`）负责在后台执行 apply 操作：

- 两者都检查 `apply_inflight` 和 `apply_preflight_inflight` 标志防止并发
- 使用 `tokio::spawn` 异步执行 API 调用
- 完成后通过 `tx` 通道发送 `ApplyPreflightFinished` 或 `ApplyFinished` 事件
- Preflight 返回冲突路径和跳过路径信息，供 UI 展示

### 5. 非交互 CLI 子命令

#### `exec`（`lib.rs:163-186`）
创建新的云任务。从参数或 stdin 读取 query，解析环境 ID 和 git ref，调用 `create_task` 并打印任务 URL。

#### `status`（`lib.rs:499-513`）
查询单个任务的状态。解析任务 ID（支持 URL 格式），获取摘要并格式化输出。若状态非 `Ready` 则 `exit(1)`。

#### `list`（`lib.rs:515-580`）
列出任务。支持 `--environment` 过滤、`--limit` 分页、`--cursor` 翻页、`--json` JSON 输出。

#### `apply`（`lib.rs:591-610`）
将任务的 diff 应用到本地工作区。支持 `--attempt` 选择特定尝试。非成功状态时 `exit(1)`。

#### `diff`（`lib.rs:582-589`）
输出任务的 diff 内容到 stdout。支持 `--attempt` 选择特定尝试。

## 函数签名

### `pub async fn run_main(cli: Cli, _codex_linux_sandbox_exe: Option<PathBuf>) -> anyhow::Result<()>`

crate 的公开入口。分发到子命令 runner 或启动 TUI 事件循环。

> 源码位置：`lib.rs:737`

### `async fn init_backend(user_agent_suffix: &str) -> anyhow::Result<BackendContext>`

初始化 API 后端：认证、构造 `HttpClient`（或 debug 模式下的 `MockClient`）。

> 源码位置：`lib.rs:43`

### `async fn resolve_git_ref(branch_override: Option<&String>) -> String`

解析 git 引用：优先使用覆盖值，其次当前分支，再次默认分支，最终回退到 `"main"`。

> 源码位置：`lib.rs:135`

### `fn spawn_preflight(app, backend, tx, frame_tx, title, job) -> bool`

在后台 tokio task 中执行 apply preflight（冲突检测）。返回 `false` 表示已有操作进行中。

> 源码位置：`lib.rs:620`

### `fn spawn_apply(app, backend, tx, frame_tx, job) -> bool`

在后台 tokio task 中执行实际的 apply 操作。返回 `false` 表示已有操作进行中。

> 源码位置：`lib.rs:682`

### `fn parse_task_id(raw: &str) -> anyhow::Result<TaskId>`

从原始字符串或完整 URL 中提取任务 ID。自动剥离 URL 路径、query string 和 fragment。

> 源码位置：`lib.rs:260`

### `async fn resolve_environment_id(ctx: &BackendContext, requested: &str) -> anyhow::Result<String>`

将用户输入的环境标识（ID 或 label）解析为确定的环境 ID。支持精确 ID 匹配和大小写不敏感的 label 匹配，label 歧义时报错。

> 源码位置：`lib.rs:188`

### `fn resolve_query_input(query_arg: Option<String>) -> anyhow::Result<String>`

解析 query 输入：从参数获取，或当参数为 `"-"` 或 stdin 非终端时从 stdin 读取。

> 源码位置：`lib.rs:233`

## 接口/类型定义

### `BackendContext`

```rust
struct BackendContext {
    backend: Arc<dyn codex_cloud_tasks_client::CloudBackend>,
    base_url: String,
}
```

封装初始化后的后端客户端和 base URL，在各 runner 中传递。

> 源码位置：`lib.rs:38-41`

### `ApplyJob`

```rust
struct ApplyJob {
    task_id: codex_cloud_tasks_client::TaskId,
    diff_override: Option<String>,
}
```

描述一个 apply/preflight 操作的参数。`diff_override` 为 `Some` 时使用指定的 diff 而非从 API 重新获取。

> 源码位置：`lib.rs:33-36`

### `AttemptDiffData`

```rust
struct AttemptDiffData {
    placement: Option<i64>,
    created_at: Option<chrono::DateTime<Utc>>,
    diff: String,
}
```

表示一次尝试的 diff 数据，用于多尝试排序和选择。排序规则：先按 `placement` 升序，再按 `created_at` 升序。

> 源码位置：`lib.rs:281-286`

### `GitInfoProvider` trait

```rust
#[async_trait::async_trait]
trait GitInfoProvider {
    async fn default_branch_name(&self, path: &Path) -> Option<String>;
    async fn current_branch_name(&self, path: &Path) -> Option<String>;
}
```

Git 信息抽象层，用于在测试中注入 stub。生产实现 `RealGitInfo` 委托给 `codex_git_utils`。

> 源码位置：`lib.rs:115-133`

## 配置项与默认值

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `CODEX_CLOUD_TASKS_BASE_URL` | `https://chatgpt.com/backend-api` | API 后端地址 |
| `CODEX_CLOUD_TASKS_MODE` | — | debug 构建中设为 `mock` 可使用 `MockClient` |
| `CODEX_CLOUD_TASKS_FORCE_INTERNAL` | — | 设为 `1`/`true` 强制使用内部模式 |
| `RUST_LOG` | `error` | tracing 日志级别（通过 `EnvFilter` 配置） |

## 文本格式化辅助函数

### `task_status_label(status: &TaskStatus) -> &'static str`

将 `TaskStatus` 枚举映射为大写标签字符串：`PENDING`、`READY`、`APPLIED`、`ERROR`。

> 源码位置：`lib.rs:365-372`

### `summary_line(summary: &DiffSummary, colorize: bool) -> String`

格式化 diff 统计行，如 `+5/-2 • 3 files`。`colorize=true` 时使用 `owo_colors` 添加绿色/红色。

> 源码位置：`lib.rs:374-411`

### `format_task_status_lines(task, now, colorize) -> Vec<String>`

为单个任务生成 3 行摘要：状态+标题、环境+时间、diff 统计。

> 源码位置：`lib.rs:413-478`

### `conversation_lines(prompt, messages) -> Vec<String>`

将 prompt 和 assistant 消息拼接为带 `user:`/`assistant:` 标签的纯文本行。

> 源码位置：`lib.rs:2027-2051`

### `pretty_lines_from_error(raw: &str) -> Vec<String>`

将冗长的 HTTP 错误响应解析为用户友好的摘要行。尝试从嵌入的 JSON body 中提取错误码、消息和状态信息。

> 源码位置：`lib.rs:2055-2131`

## 边界 Case 与注意事项

- **并发 apply 保护**：`spawn_preflight` 和 `spawn_apply` 通过 `apply_inflight`/`apply_preflight_inflight` 标志互斥，防止用户在操作进行中重复触发
- **事件竞态处理**：`TasksLoaded` 事件会检查 `env` 是否匹配当前 `env_filter`，丢弃过时的加载结果（`lib.rs:962-969`）
- **task ID 解析宽容**：`parse_task_id` 同时支持原始 ID 和完整 URL，自动剥离 path、query、fragment
- **stdin 输入**：`resolve_query_input` 区分 `-` 显式指定 stdin 和管道 stdin（非终端检测）
- **环境 label 歧义**：当多个环境共享同一 label 但 ID 不同时，`resolve_environment_id` 会报错要求用户使用精确 ID
- **终端兼容性**：增强键盘标志的推送可能失败（某些终端不支持），错误被静默忽略
- **Spinner 生命周期**：仅在有 inflight 操作时激活 spinner 动画，操作完成后立即清除 `spinner_start` 停止动画