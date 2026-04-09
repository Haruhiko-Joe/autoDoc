# TasksClient — 云任务 API 客户端库

## 概述与职责

`codex-cloud-tasks-client` 是 Codex 云任务系统的 Rust 客户端库，位于 `CloudTasks` 模块层级下。它为上层 TUI 和 CLI 提供了与 OpenAI 云端代理任务交互的统一接口，包括任务的创建、列表查询、详情获取、diff 审阅，以及将云端产出的补丁应用到本地工作区。

在整体架构中，`CloudTasks` 依赖 `Auth` 进行身份认证，依赖 `Config` 读取环境配置。本 crate 是 `CloudTasks` 的数据层和网络层，向上暴露 `CloudBackend` trait 供 TUI 调用，向下委托 `codex-backend-client` 完成 HTTP 传输、委托 `codex-git-utils` 完成本地 git patch 应用。

## 模块结构

```
codex-rs/cloud-tasks-client/src/
├── lib.rs   # 公开接口 re-export
├── api.rs   # 数据模型、错误类型、CloudBackend trait 定义
└── http.rs  # HttpClient 实现及内部 API 适配层
```

- **`api.rs`**：定义所有公开的数据类型（`TaskId`、`TaskSummary`、`TaskStatus` 等）、错误枚举 `CloudTaskError`，以及核心 trait `CloudBackend`。
- **`http.rs`**：提供 `HttpClient` 结构体，实现 `CloudBackend` trait，并包含一个私有 `api` 模块处理请求构建、响应解析和 diff 应用逻辑。
- **`lib.rs`**：纯 re-export 层，将 `api` 和 `http` 中的公开类型统一导出。

## 关键流程

### 1. 任务列表查询

调用 `CloudBackend::list_tasks()` → `HttpClient` 委托内部 `Tasks::list()` → 调用 `backend::Client::list_tasks()` 发起 HTTP 请求 → 将返回的 `TaskListItem` 列表通过 `map_task_list_item_to_summary()` 转换为 `TaskSummary` 向量，连同分页 cursor 一起包装为 `TaskListPage` 返回。

> 源码位置：`codex-rs/cloud-tasks-client/src/http.rs:147-180`

### 2. 任务详情获取

`Tasks::summary()` 调用 `details_with_body()` 获取原始 JSON 响应，然后从 `task` 对象和 `task_status_display` 中逐一提取标题、状态、时间戳、环境标签、diff 统计等字段。状态映射逻辑优先从 `latest_turn_status_display.turn_status` 推断（`failed` → `Error`，`completed` → `Ready`，`in_progress`/`pending` → `Pending`），其次回退到 `state` 字段。

如果 `task_status_display` 中的 diff 统计全为零，会尝试从 `unified_diff()` 重新计算（`diff_summary_from_diff()`），通过逐行统计 `diff --git`、`+`、`-` 行得出变更摘要。

> 源码位置：`codex-rs/cloud-tasks-client/src/http.rs:182-249`

### 3. 获取任务文本（prompt + 消息 + 尝试信息）

`Tasks::task_text()` 是最完整的详情获取方法，返回 `TaskText` 结构，包含：
1. 用户原始 prompt（`details.user_text_prompt()`）
2. 助手消息列表（先尝试 `details.assistant_text_messages()`，不足则从原始 body 的 `current_assistant_turn.worklog.messages` 中提取）
3. 当前助手 turn 的元数据：`turn_id`、`sibling_turn_ids`（兄弟尝试列表）、`attempt_placement`（在 best-of-N 中的位置）、`attempt_status`

> 源码位置：`codex-rs/cloud-tasks-client/src/http.rs:289-316`

### 4. Best-of-N 兄弟尝试列表

`Attempts::list()` 调用 `backend.list_sibling_turns()` 获取同一任务的多次尝试结果。返回值通过 `turn_attempt_from_map()` 解析每个 turn 的 ID、placement、状态、diff 和消息。结果按 `attempt_placement` 排序（优先），无 placement 时按 `created_at` 排序，最终回退到 `turn_id` 字典序。

> 源码位置：`codex-rs/cloud-tasks-client/src/http.rs:390-416`，排序逻辑：`codex-rs/cloud-tasks-client/src/http.rs:633-645`

### 5. Diff 应用流程（apply / preflight）

`Apply::run()` 是核心的补丁应用逻辑，支持两种模式：

1. **获取 diff**：优先使用调用方传入的 `diff_override`（用于 best-of-N 场景中选择特定尝试的 diff），否则从后端重新获取。
2. **格式校验**：调用 `is_unified_diff()` 检查补丁是否为标准 unified git diff 格式（检测 `diff --git` 前缀或 `---`/`+++`/`@@` 组合），不合格直接返回 `ApplyStatus::Error`。
3. **执行应用**：构造 `ApplyGitRequest`（cwd 取当前工作目录，`preflight` 标志控制是否为干运行），调用 `codex_git_utils::apply_git_patch()`。
4. **结果判定**：
   - exit_code == 0 → `Success`
   - 有 applied_paths 或 conflicted_paths → `Partial`
   - 其余 → `Error`
   - `applied` 字段仅在非 preflight 且 Success 时为 `true`
5. **错误日志**：非成功情况下会将 patch 摘要、stdout/stderr 尾部写入 `error.log`。

> 源码位置：`codex-rs/cloud-tasks-client/src/http.rs:429-561`

### 6. 任务创建

`Tasks::create()` 构造包含用户 prompt 的 `input_items` 数组。如果环境变量 `CODEX_STARTING_DIFF` 存在且非空，会追加一个 `pre_apply_patch` 项作为初始 diff。当 `best_of_n > 1` 时，在请求体中插入 `metadata.best_of_n` 字段。最终调用 `backend.create_task()` 发起创建请求。

> 源码位置：`codex-rs/cloud-tasks-client/src/http.rs:318-379`

## 函数签名与参数说明

### `CloudBackend` trait（异步）

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `list_tasks` | `env: Option<&str>`, `limit: Option<i64>`, `cursor: Option<&str>` | `Result<TaskListPage>` | 分页列举任务，可按环境过滤 |
| `get_task_summary` | `id: TaskId` | `Result<TaskSummary>` | 获取单个任务的完整摘要 |
| `get_task_diff` | `id: TaskId` | `Result<Option<String>>` | 获取任务的 unified diff |
| `get_task_messages` | `id: TaskId` | `Result<Vec<String>>` | 获取助手输出的文本消息 |
| `get_task_text` | `id: TaskId` | `Result<TaskText>` | 获取 prompt、消息和 turn 元数据 |
| `list_sibling_attempts` | `task: TaskId`, `turn_id: String` | `Result<Vec<TurnAttempt>>` | 列举 best-of-N 的兄弟尝试 |
| `apply_task_preflight` | `id: TaskId`, `diff_override: Option<String>` | `Result<ApplyOutcome>` | 干运行，检查补丁是否可应用 |
| `apply_task` | `id: TaskId`, `diff_override: Option<String>` | `Result<ApplyOutcome>` | 实际应用补丁到本地工作区 |
| `create_task` | `env_id: &str`, `prompt: &str`, `git_ref: &str`, `qa_mode: bool`, `best_of_n: usize` | `Result<CreatedTask>` | 创建新的云端任务 |

> trait 定义位置：`codex-rs/cloud-tasks-client/src/api.rs:133-170`

### `HttpClient`

| 方法 | 说明 |
|------|------|
| `new(base_url: impl Into<String>)` | 创建客户端，内部初始化 `backend::Client` |
| `with_bearer_token(self, token)` | Builder 模式设置认证 token |
| `with_user_agent(self, ua)` | Builder 模式设置 User-Agent |
| `with_chatgpt_account_id(self, id)` | Builder 模式设置 ChatGPT 账户 ID |

> 源码位置：`codex-rs/cloud-tasks-client/src/http.rs:23-61`

## 接口/类型定义

### `TaskId`

`String` 的透明包装类型，序列化时直接作为字符串。（`api.rs:20-22`）

### `TaskStatus`

```rust
enum TaskStatus { Pending, Ready, Applied, Error }
```
使用 kebab-case 序列化。表示任务的生命周期阶段。

### `TaskSummary`

任务的完整摘要信息，包含 `id`、`title`、`status`、`updated_at`（UTC 时间戳）、可选的 `environment_id`/`environment_label`、`summary`（diff 统计）、`is_review`（是否为 code review）、`attempt_total`（best-of-N 总尝试数）。（`api.rs:34-50`）

### `AttemptStatus`

```rust
enum AttemptStatus { Pending, InProgress, Completed, Failed, Cancelled, Unknown }
```
`Unknown` 为默认值。用于表示单次 turn 尝试的执行状态。（`api.rs:52-61`）

### `TurnAttempt`

Best-of-N 场景下单次尝试的完整信息：`turn_id`、`attempt_placement`（排位）、`created_at`、`status`、`diff`、`messages`。（`api.rs:63-71`）

### `ApplyOutcome`

补丁应用结果：`applied`（是否已实际应用）、`status`（`Success`/`Partial`/`Error`）、`message`（人类可读描述）、`skipped_paths`、`conflict_paths`。（`api.rs:81-90`）

### `TaskText`

任务的文本内容聚合：用户 `prompt`、助手 `messages`、当前 `turn_id` 及其 `sibling_turn_ids`、`attempt_placement` 和 `attempt_status`。（`api.rs:110-131`）

### `DiffSummary`

变更统计：`files_changed`、`lines_added`、`lines_removed`，全部默认为 0。（`api.rs:103-108`）

### `CloudTaskError`

```rust
enum CloudTaskError {
    Unimplemented(&'static str),
    Http(String),
    Io(String),
    Msg(String),
}
```
基于 `thiserror` 派生，覆盖了未实现、HTTP 错误、IO 错误和通用消息四类场景。（`api.rs:8-18`）

## 配置项与环境变量

- **`CODEX_STARTING_DIFF`**：可选环境变量。创建任务时若存在且非空，会作为 `pre_apply_patch` 项附加到请求中，使云端任务以该 diff 为起点执行。
- **`base_url`**：通过 `HttpClient::new()` 传入，决定 API 端点。URL 中包含 `/backend-api` 或 `/api/codex` 时会影响详情接口的路径拼接逻辑。

## 边界 Case 与注意事项

- **助手消息回退提取**：当 `backend::CodeTaskDetailsResponse` 的结构化接口未返回消息时，会从原始 JSON body 中手动遍历 `current_assistant_turn.worklog.messages` 提取文本，兼容不同后端版本的响应格式。（`http.rs:573-614`）
- **非 unified diff 拒绝**：`is_unified_diff()` 检查要求 diff 以 `diff --git` 开头，或同时包含 `---`/`+++` 和 `@@` 标记。不符合条件的 diff（如 codex-patch 格式）会被拒绝应用并记录日志。（`http.rs:850-858`）
- **Preflight 模式不修改工作区**：`apply_task_preflight` 传递 `preflight=true`，`applied` 字段即使 exit_code == 0 也始终为 `false`。
- **错误日志写入**：`append_error_log()` 将诊断信息追加写入当前目录的 `error.log` 文件，包含时间戳。写入失败时静默忽略。（`http.rs:897-907`）
- **时间戳解析**：后端返回 Unix 浮点时间戳（秒），无时间戳时回退到 `Utc::now()`。负数秒会被 clamp 到 0。（`http.rs:763-772`）
- **尝试排序稳定性**：`compare_attempts` 使用三级排序（placement → created_at → turn_id），保证即使元数据不完整也能产出确定性顺序。