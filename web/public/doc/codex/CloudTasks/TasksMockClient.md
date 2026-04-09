# TasksMockClient

## 概述与职责

`codex-cloud-tasks-mock-client` 是 CloudTasks 子系统中的 mock 实现 crate，提供了 `CloudBackend` trait 的内存桩（stub）实现。它使 TUI 的云任务管理界面在**无需真实后端连接**的情况下即可运行，适用于本地开发、UI 调试和自动化测试。

在系统架构中，CloudTasks 模块负责远程云端 Agent 任务的创建、监控和审查。CloudTasks 依赖 `CloudBackend` trait（定义于 `codex-cloud-tasks-client` crate）作为后端通信的抽象层，而本 crate 提供了该 trait 的 mock 实现。同级的 `codex-cloud-tasks-client` crate 则包含连接真实 API 的生产实现。

## 模块结构

crate 仅包含两个源文件：

- **`src/lib.rs`**（`src/lib.rs:1-3`）：模块声明与公开导出，仅 re-export `MockClient` 结构体
- **`src/mock.rs`**（`src/mock.rs:1-203`）：全部实现逻辑

依赖极为精简：`async-trait`（trait 异步方法支持）、`chrono`（时间戳生成）、`codex-cloud-tasks-client`（trait 和类型定义）、`diffy`（unified diff 解析）。

## 关键流程 Walkthrough

### MockClient 的核心工作方式

`MockClient` 是一个零状态的结构体（`#[derive(Clone, Default)]`），所有方法都返回硬编码的 canned 数据，不持有任何可变状态。

### 环境感知的任务列表

`list_tasks()` 是最复杂的方法，根据传入的 `env` 参数返回不同的任务集合（`src/mock.rs:22-73`）：

1. **`env = "env-A"`**：返回 1 个任务（`T-2000`，Ready 状态）
2. **`env = "env-B"`**：返回 2 个任务（`T-3000` Ready + `T-3001` Pending）
3. **默认（`None` 或其他值）**：返回 3 个任务（`T-1000`、`T-1001`、`T-1002`），分别模拟 README 格式化、clippy 修复、贡献指南添加

每个任务的 diff 摘要（`DiffSummary`）通过 `mock_diff_for()` 生成对应的 unified diff 文本，再由 `count_from_unified()` 统计增删行数。环境标签会映射为人类可读的名称（"Env A"、"Env B"、"Global"）。

### Diff 生成逻辑

`mock_diff_for()` 根据任务 ID 返回不同的硬编码 unified diff（`src/mock.rs:163-175`）：

| 任务 ID | 模拟场景 | 目标文件 |
|---------|---------|---------|
| `T-1000` | 修改现有文件（1 删 2 增） | `README.md` |
| `T-1001` | 删除一行 import | `core/src/lib.rs` |
| 其他 | 新建文件（3 行新增） | `CONTRIBUTING.md` |

### Diff 行数统计

`count_from_unified()` 采用双重策略解析 diff（`src/mock.rs:177-203`）：

1. **优先使用 `diffy::Patch::from_str()`** 进行结构化解析，遍历所有 hunk 的行，按 `Insert`/`Delete` 分类计数
2. **fallback**：如果 `diffy` 解析失败，退化为逐行文本扫描——跳过 `+++`、`---`、`@@` 头部行，按首字符 `+`/`-` 计数

## 函数签名与参数说明

### `MockClient`（结构体）

```rust
#[derive(Clone, Default)]
pub struct MockClient;
```

零大小类型，无字段，通过 `MockClient::default()` 或 `MockClient` 字面量创建。

### `CloudBackend` trait 实现

以下为 `MockClient` 实现的全部 trait 方法：

#### `list_tasks(env, limit, cursor) -> Result<TaskListPage>`

返回环境感知的 canned 任务列表。`limit` 和 `cursor` 参数被忽略（mock 无分页），返回的 `cursor` 始终为 `None`。

#### `get_task_summary(id) -> Result<TaskSummary>`

内部调用 `list_tasks(None, None, None)` 获取默认列表，在其中查找匹配的 `id`。找不到时返回 `CloudTaskError::Msg`。注意：仅搜索默认环境的任务列表，不搜索 env-A/env-B 的任务。

#### `get_task_diff(id) -> Result<Option<String>>`

调用 `mock_diff_for()` 返回对应任务的 unified diff 字符串，始终返回 `Some`。

#### `get_task_messages(id) -> Result<Vec<String>>`

忽略 `id`，固定返回 `["Mock assistant output: this task contains no diff."]`。

#### `get_task_text(id) -> Result<TaskText>`

忽略 `id`，返回一个固定的 `TaskText`，包含 mock prompt（`"Why is there no diff?"`）、mock turn ID（`"mock-turn"`）、`attempt_placement = 0`、状态为 `Completed`。

#### `apply_task(id, diff_override) -> Result<ApplyOutcome>`

忽略 `diff_override`，始终返回成功（`applied: true, status: Success`），消息中包含任务 ID。

#### `apply_task_preflight(id, diff_override) -> Result<ApplyOutcome>`

与 `apply_task` 类似但 `applied: false`（preflight 不实际修改工作树），始终返回成功。

#### `list_sibling_attempts(task, turn_id) -> Result<Vec<TurnAttempt>>`

仅当 `task.0 == "T-1000"` 时返回一个模拟的 alternate attempt（`src/mock.rs:136-147`），其他任务返回空列表。这模拟了 best-of-N 多次尝试场景。

#### `create_task(env_id, prompt, git_ref, qa_mode, best_of_n) -> Result<CreatedTask>`

忽略所有参数，生成一个基于当前毫秒时间戳的唯一 ID（格式 `task_local_{timestamp_ms}`），返回 `CreatedTask`。

## 边界 Case 与注意事项

- **`get_task_summary` 的查找范围有限**：它只在默认环境的任务列表中搜索，对 `env-A`/`env-B` 专属的任务 ID（如 `T-2000`、`T-3000`）会返回 Not Found 错误
- **`limit` 和 `cursor` 被忽略**：mock 不实现分页逻辑，这意味着分页相关的 UI 功能无法通过 mock 进行端到端测试
- **`diff_override` 被忽略**：`apply_task` 和 `apply_task_preflight` 不使用调用者提供的 diff 覆盖参数
- **时间戳不稳定**：`list_tasks` 中的 `updated_at` 和 `create_task` 的 ID 使用 `Utc::now()`，在快照测试中可能导致不确定性
- **`T-1000` 是特殊任务**：它是唯一拥有多次尝试（`attempt_total = 2`）和 sibling attempt 数据的任务，用于测试 best-of-N 相关的 UI 路径