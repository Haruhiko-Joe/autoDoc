# AgentNavigationState — 多 Agent 选择器导航状态

## 概述与职责

`AgentNavigationState` 是 TUI 多 Agent 选择器（`/agent` picker）的**纯状态容器**，负责维护线程的稳定遍历顺序和键盘导航逻辑。它位于 **TUI → AppOrchestrator → AppCore** 层级中，被 `App` 主状态机持有，为多 Agent 场景下的选择器行渲染、键盘前后切换、以及页脚标签显示提供数据支撑。

在同级模块中，`AppCore` 负责线程发现和 UI 状态切换等副作用操作，而 `AgentNavigationState` 只承担纯粹的状态查询职责——记住选择器条目及其首次出现顺序、回答遍历问题（"下一个线程是什么？"）、派生用户可见的选择器/页脚文本。这种拆分使导航逻辑可独立测试。

> 源码位置：`codex-rs/tui/src/app/agent_navigation.rs`

## 核心数据结构

```rust
// codex-rs/tui/src/app/agent_navigation.rs:38-44
pub(crate) struct AgentNavigationState {
    threads: HashMap<ThreadId, AgentPickerThreadEntry>,
    order: Vec<ThreadId>,
}
```

- **`threads`**：以 `ThreadId` 为键的 HashMap，存储每个线程的最新选择器元数据（`AgentPickerThreadEntry`，包含 `agent_nickname`、`agent_role`、`is_closed` 字段）。
- **`order`**：`Vec<ThreadId>`，记录线程的**首次出现顺序**（spawn order）。一旦线程 ID 被观察到就固定其位置，后续更新不会改变排列。

### `AgentNavigationDirection` 枚举

```rust
// codex-rs/tui/src/app/agent_navigation.rs:47-53
pub(crate) enum AgentNavigationDirection {
    Previous,
    Next,
}
```

用于键盘导航时指定遍历方向：`Previous` 向 spawn 更早的方向移动，`Next` 向更晚的方向移动，两端均支持环绕（wraparound）。

## 关键流程

### 线程注册与顺序稳定性

`upsert()` 是修改状态的核心入口（`codex-rs/tui/src/app/agent_navigation.rs:79-97`）：

1. 检查 `threads` HashMap 中是否已存在该 `thread_id`
2. **仅在首次观察时**将 `thread_id` 追加到 `order` 向量末尾
3. 无论新旧，都在 `threads` 中插入/覆盖最新的 `AgentPickerThreadEntry`

这个设计确保了**核心不变量**：键盘导航的遍历顺序始终是首次出现顺序，即使条目的 nickname、role 或关闭状态被反复更新，其在循环中的位置也不会改变。

### 键盘循环导航

`adjacent_thread_id()` 实现前后切换（`codex-rs/tui/src/app/agent_navigation.rs:172-197`）：

1. 获取按首次出现顺序排列的有效线程列表（`ordered_threads()`）
2. 如果列表少于 2 个线程，返回 `None`（无法导航）
3. 找到当前显示线程在列表中的索引位置
4. 根据方向计算目标索引：
   - **Next**：`(current_idx + 1) % len`，末尾环绕到开头
   - **Previous**：`current_idx - 1`，若为 0 则跳到末尾 `len - 1`
5. 返回目标位置的 `ThreadId`

调用方必须传入**实际正在显示的线程 ID**，而非簿记中最近标记为活跃的线程，否则导航会产生不确定性的跳跃感。

### 页脚标签渲染

`active_agent_label()` 为当前显示线程生成上下文标签（`codex-rs/tui/src/app/agent_navigation.rs:205-232`）：

1. 若 `threads` 中只有 1 个或更少线程，返回 `None`——单线程会话不浪费页脚空间
2. 判断当前线程是否为主线程（`is_primary`）
3. 调用 `format_agent_picker_item_name()` 生成显示名称，如 `"Robie [explorer]"` 或 `"Main [default]"`
4. 若元数据缺失，使用相同函数的默认参数作为 fallback

## 函数签名与参数说明

| 方法 | 签名 | 说明 |
|------|------|------|
| `get()` | `(&self, thread_id: &ThreadId) -> Option<&AgentPickerThreadEntry>` | 查询指定线程的选择器元数据 |
| `is_empty()` | `(&self) -> bool` | 判断是否无任何已跟踪线程 |
| `upsert()` | `(&mut self, thread_id, agent_nickname: Option<String>, agent_role: Option<String>, is_closed: bool)` | 插入或更新条目，仅首次追加到顺序列表 |
| `mark_closed()` | `(&mut self, thread_id: ThreadId)` | 标记线程为已关闭但保留在导航中；若不存在则自动 upsert |
| `clear()` | `(&mut self)` | 清空全部状态，恢复到初始空状态 |
| `remove()` | `(&mut self, thread_id: ThreadId)` | 从 `threads` 和 `order` 中完全移除（仅用于清理幽灵条目） |
| `has_non_primary_thread()` | `(&self, primary_thread_id: Option<ThreadId>) -> bool` | 判断是否存在非主线程的跟踪条目 |
| `ordered_threads()` | `(&self) -> Vec<(ThreadId, &AgentPickerThreadEntry)>` | 按首次出现顺序返回有效的 (thread_id, entry) 对 |
| `tracked_thread_ids()` | `(&self) -> Vec<ThreadId>` | 按稳定顺序返回已跟踪的线程 ID 列表 |
| `adjacent_thread_id()` | `(&self, current_displayed_thread_id: Option<ThreadId>, direction: AgentNavigationDirection) -> Option<ThreadId>` | 计算键盘导航的前/后目标线程 |
| `active_agent_label()` | `(&self, current_displayed_thread_id: Option<ThreadId>, primary_thread_id: Option<ThreadId>) -> Option<String>` | 生成当前线程的页脚显示标签 |
| `picker_subtitle()` | `() -> String`（静态方法） | 生成选择器副标题文本，包含实际快捷键名称 |

## 外部依赖

- **`AgentPickerThreadEntry`** / **`format_agent_picker_item_name()`** / **`next_agent_shortcut()`** / **`previous_agent_shortcut()`**：来自 `crate::multi_agents`，提供线程条目数据模型和显示名称格式化。
- **`ThreadId`**：来自 `codex_protocol`，线程的唯一标识符。
- **`ratatui::text::Span`**：仅在 `picker_subtitle()` 中用于从快捷键 helper 提取文本内容。

## 边界 Case 与注意事项

- **`mark_closed()` 不移除条目**（`codex-rs/tui/src/app/agent_navigation.rs:105-114`）：关闭的线程仍留在选择器和遍历顺序中，用户可以继续查看它们。如果改为删除，环绕导航的形状会在会话中途发生变化。对于未知线程 ID，`mark_closed()` 会自动 upsert 一个空元数据的已关闭条目。

- **`remove()` 仅用于幽灵条目**（`codex-rs/tui/src/app/agent_navigation.rs:130-133`）：只在后端确认条目不再存在且从未成为可重放的本地线程时使用，避免选择器中出现无效行。

- **`ordered_threads()` 的防御性过滤**（`codex-rs/tui/src/app/agent_navigation.rs:151-156`）：`order` 向量和 `threads` HashMap 在 teardown 竞态期间可能短暂不同步，因此该方法通过 `filter_map` 而非假设两者完全一致来避免 panic。

- **单线程时隐藏标签**：`active_agent_label()` 在只有 0-1 个线程时返回 `None`，避免在单 Agent 会话中显示多余信息。

- **`adjacent_thread_id()` 要求至少 2 个线程**：少于 2 个线程时返回 `None`，因为没有可切换的目标。

## 单元测试

模块包含 4 个测试用例（`codex-rs/tui/src/app/agent_navigation.rs:261-354`），通过 `populated_state()` 辅助函数构建包含 3 个线程（main、Robie/explorer、Bob/worker）的标准测试状态：

- **`upsert_preserves_first_seen_order`**：验证对已存在线程重复 upsert 后，`ordered_thread_ids()` 的顺序不变。
- **`adjacent_thread_id_wraps_in_spawn_order`**：验证 Next 方向从末尾环绕到开头、Previous 方向从开头环绕到末尾。
- **`picker_subtitle_mentions_shortcuts`**：验证生成的副标题文本包含实际的快捷键名称。
- **`active_agent_label_tracks_current_thread`**：验证主线程显示为 `"Main [default]"`，子 Agent 线程显示为 `"Robie [explorer]"` 格式。