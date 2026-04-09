# AppState — 应用状态模型与事件类型

## 概述与职责

AppState 模块是 CloudTasks TUI 的**核心状态层**，定义了整个终端界面所需的全部数据模型和异步事件类型。它位于 `CloudTasks > TasksTUI` 层级中，与渲染层（ratatui UI）和事件循环协作：事件循环接收用户输入与后台事件，修改此模块中的状态，渲染层再根据状态绘制界面。

同级模块包括 TasksClient（API 客户端）、TasksMockClient（模拟后端）和 CloudRequirements（云端配置加载）。本模块通过 `CloudBackend` trait 与 TasksClient 交互来获取任务数据。

模块由两个源文件组成：
- `app.rs`：主应用状态结构体 `App`、差异覆盖层 `DiffOverlay`、各种模态框状态、`AppEvent` 事件枚举、以及 `load_tasks` 辅助函数
- `new_task.rs`：新建任务页面 `NewTaskPage` 的状态定义

## 关键流程

### 任务加载流程

1. 事件循环调用 `load_tasks()` 异步函数，传入 `CloudBackend` 实例和可选的环境 ID 过滤器
2. `load_tasks()` 通过 `backend.list_tasks()` 请求最多 20 条任务，并设置 5 秒超时（`app.rs:126-130`）
3. 过滤掉 `is_review = true` 的纯审阅任务，只保留可操作的任务（`app.rs:132`）
4. 结果通过 `AppEvent::TasksLoaded` 事件传递回事件循环
5. 事件循环更新 `App.tasks` 列表并重置选中索引

### Diff 详情与多尝试导航流程

1. 用户选中任务后，后台加载 diff 和消息内容，通过 `AppEvent::DetailsMessagesLoaded` 和 `AppEvent::DetailsDiffLoaded` 投递
2. 创建 `DiffOverlay`，初始化 `ScrollableDiff` 组件用于可滚动显示
3. 用户可在 `DetailView::Diff`（差异视图）和 `DetailView::Prompt`（消息/提示视图）之间切换
4. 对于 best-of-N 任务，通过 `AppEvent::AttemptsLoaded` 加载多个尝试（attempt）
5. 用户使用 `step_attempt(delta)` 在多个尝试之间循环切换，该方法采用模运算实现环形导航（`app.rs:229-242`）
6. 每次切换尝试或视图时，`apply_selection_to_fields()` 将当前选中尝试的数据同步到顶层字段并更新 `ScrollableDiff` 内容（`app.rs:253-288`）

### 新建任务流程

1. 用户进入新建任务页面，创建 `NewTaskPage` 实例
2. `NewTaskPage` 内嵌 `ComposerInput`（来自 codex-tui），提供带快捷键提示的多行文本编辑器
3. 用户编写 prompt 后提交，`submitting` 标志置为 true
4. 后台完成后通过 `AppEvent::NewTaskSubmitted` 返回结果

## 核心数据结构

### `App`

中央应用状态结构体，持有所有 TUI 需要的运行时数据（`app.rs:47-75`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `tasks` | `Vec<TaskSummary>` | 当前显示的任务列表 |
| `selected` | `usize` | 列表中选中项的索引 |
| `status` | `String` | 底部状态栏文字 |
| `diff_overlay` | `Option<DiffOverlay>` | 打开时显示 diff/消息详情 |
| `spinner_start` | `Option<Instant>` | 加载动画起始时间 |
| `refresh_inflight` / `details_inflight` | `bool` | 防止重复发起后台请求 |
| `env_filter` | `Option<String>` | 当前生效的环境 ID 过滤器 |
| `env_modal` | `Option<EnvModalState>` | 环境选择模态框状态 |
| `apply_modal` | `Option<ApplyModalState>` | 补丁应用模态框状态 |
| `best_of_modal` | `Option<BestOfModalState>` | best-of-N 选择模态框状态 |
| `environments` | `Vec<EnvironmentRow>` | 可用环境列表 |
| `new_task` | `Option<NewTaskPage>` | 新建任务页面状态 |
| `best_of_n` | `usize` | 当前 best-of-N 并行尝试数，默认 1 |
| `list_generation` | `u64` | 列表刷新代数，用于后台充实协调 |
| `in_flight` | `HashSet<String>` | 正在进行的后台充实任务 ID 集合 |

`App` 提供 `next()` 和 `prev()` 方法用于安全地移动列表选中项，带边界保护（`app.rs:104-118`）。

### `DiffOverlay`

任务详情覆盖层，管理 diff 展示和多尝试导航（`app.rs:136-150`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `task_id` | `TaskId` | 当前查看的任务 ID |
| `sd` | `ScrollableDiff` | 可滚动显示组件 |
| `attempts` | `Vec<AttemptView>` | 所有尝试的数据 |
| `selected_attempt` | `usize` | 当前选中的尝试索引 |
| `current_view` | `DetailView` | 当前视图模式（Diff 或 Prompt） |
| `base_turn_id` | `Option<String>` | 基础 turn ID，用于查询兄弟尝试 |
| `sibling_turn_ids` | `Vec<String>` | 兄弟 turn ID 列表 |
| `attempt_total_hint` | `Option<usize>` | 预期的尝试总数提示（可能大于已加载数） |

关键方法：
- `current_can_apply()` — 仅在 Diff 视图且当前尝试有非空 diff 时返回 true（`app.rs:244-251`）
- `step_attempt(delta)` — 使用模运算在尝试间环形切换（`app.rs:229-242`）
- `expected_attempts()` — 返回预期总数，优先使用 hint，回退到实际数量（`app.rs:210-218`）

### `AttemptView`

单个尝试的视图数据（`app.rs:152-161`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `turn_id` | `Option<String>` | 尝试的 turn ID |
| `status` | `AttemptStatus` | 尝试状态（来自客户端类型） |
| `attempt_placement` | `Option<i64>` | 尝试的排名位置 |
| `diff_lines` | `Vec<String>` | 渲染后的 diff 行 |
| `text_lines` | `Vec<String>` | 消息/输出文本行 |
| `prompt` | `Option<String>` | 原始 prompt |
| `diff_raw` | `Option<String>` | 原始 diff 字符串（用于 apply） |

提供 `has_diff()` 和 `has_text()` 便捷方法判断内容是否可用。

### `NewTaskPage`

新建任务的编辑器状态（`new_task.rs:3-8`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `composer` | `ComposerInput` | 多行文本编辑器（来自 codex-tui） |
| `submitting` | `bool` | 是否正在提交中 |
| `env_id` | `Option<String>` | 目标环境 ID |
| `best_of_n` | `usize` | 并行尝试数 |

构造时自动配置快捷键提示：⏎ 发送、Shift+⏎ 换行、Ctrl+O 切换环境、Ctrl+N 设置尝试数、Ctrl+C 退出（`new_task.rs:13-19`）。

## 辅助类型

### `EnvironmentRow`

环境列表中的一行数据（`app.rs:6-11`）：包含 `id`、可选 `label`、`is_pinned` 标记、和 `repo_hints`（如 `"openai/codex"`）。

### `EnvModalState` / `BestOfModalState`

模态框状态：`EnvModalState` 持有搜索 `query` 和 `selected` 索引用于环境模糊搜索；`BestOfModalState` 仅持有 `selected` 索引。

### `ApplyModalState`

补丁应用模态框状态（`app.rs:32-40`）：关联 `task_id`，展示应用结果（`result_message` + `result_level`），以及跳过和冲突的文件路径列表。

### `ApplyResultLevel`

补丁应用结果等级枚举：`Success`、`Partial`（部分成功）、`Error`。

### `DetailView`

详情视图切换枚举：`Diff`（差异视图）和 `Prompt`（消息/提示视图）。

## `AppEvent` 事件枚举

`AppEvent` 是后台任务向 UI 事件循环投递结果的统一通道（`app.rs:300-350`），保持 UI 在异步操作期间保持响应：

| 变体 | 说明 |
|------|------|
| `TasksLoaded { env, result }` | 任务列表加载完成 |
| `EnvironmentAutodetected(Result)` | 环境自动检测完成（基于 Git remote） |
| `EnvironmentsLoaded(Result)` | 环境列表加载完成 |
| `DetailsDiffLoaded { id, title, diff }` | 任务 diff 内容加载完成 |
| `DetailsMessagesLoaded { id, title, messages, prompt, turn_id, sibling_turn_ids, ... }` | 任务消息和 prompt 加载完成，包含尝试元数据 |
| `DetailsFailed { id, title, error }` | 详情加载失败 |
| `AttemptsLoaded { id, attempts }` | 兄弟尝试列表加载完成 |
| `NewTaskSubmitted(Result)` | 新任务提交完成 |
| `ApplyPreflightFinished { id, title, message, level, skipped, conflicts }` | 补丁应用预检完成 |
| `ApplyFinished { id, result }` | 补丁实际应用完成 |

## `load_tasks` 辅助函数

```rust
pub async fn load_tasks(
    backend: &dyn CloudBackend,
    env: Option<&str>,
) -> anyhow::Result<Vec<TaskSummary>>
```

> 源码位置：`app.rs:121-134`

从 `CloudBackend` 获取任务列表的异步辅助函数：
- 设置 **5 秒超时**防止 UI 长时间阻塞
- 请求上限 **20 条**任务
- 过滤掉 `is_review = true` 的审阅任务
- 支持可选的 `env` 参数按环境过滤

## 边界 Case 与注意事项

- `App::next()` 和 `App::prev()` 在空列表时直接返回，不会 panic（`app.rs:105-107`）
- `DiffOverlay::base_attempt_mut()` 在 attempts 为空时自动插入默认 `AttemptView`，保证始终有基础尝试可用（`app.rs:198-203`）
- `step_attempt()` 在只有 0 或 1 个尝试时返回 false 不做任何操作（`app.rs:231-233`）
- `apply_selection_to_fields()` 在当前尝试不存在时显示 `<loading attempt>` 占位文本（`app.rs:264`）
- `load_tasks()` 的 5 秒超时意味着网络慢时可能返回超时错误，调用方需要处理
- `list_generation` 和 `in_flight` 字段用于后台充实协调，防止过期的后台响应覆盖新数据