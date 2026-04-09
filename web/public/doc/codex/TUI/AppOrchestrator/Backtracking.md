# Backtracking（回溯状态机）

## 概述与职责

Backtracking 模块实现了 TUI 中的"对话回溯"功能——允许用户通过 Esc 键导航回历史用户消息，并请求 Core 将对话回滚到选定的位置。该模块位于 **TUI → AppOrchestrator** 层级下，是 `App` 的一组方法扩展，协调 transcript overlay（Ctrl+T 打开的全屏转录视图）与主聊天视图之间的回溯交互。

在架构上，Backtracking 充当 TUI 层与 Core 协议层之间的桥梁：它在本地维护回溯选择状态，向 Core 提交回滚请求（`AppCommand::thread_rollback`），等待 Core 确认后才修剪本地 transcript，确保 UI 状态不会与真实的对话线程产生分歧。

## 关键流程

### 状态机流转

Backtracking 的核心是一个四阶段状态机：

1. **Prime（预备）**：用户在主视图中按下 Esc，`primed` 置为 `true`，记录当前 `base_id`（线程 ID），在 composer 中显示提示 hint。此时 overlay 尚未打开。（`app_backtrack.rs:263-268`）

2. **Open Overlay（打开 overlay 预览）**：用户再次按 Esc，打开 transcript overlay 并进入 backtrack preview 模式。自动选中最新的用户消息并高亮。（`app_backtrack.rs:271-277`）

3. **Step Through（逐步浏览）**：在 overlay 中按 Esc/Left 向更早的用户消息移动，按 Right 向更新的消息移动。选择会在 overlay 中以高亮显示。（`app_backtrack.rs:292-333`）

4. **Confirm（确认回滚）**：按 Enter 确认选择，关闭 overlay，发送回滚请求到 Core，并用选中消息的内容预填 composer。（`app_backtrack.rs:402-410`）

还有一个替代入口：如果用户已经通过 Ctrl+T 打开了 transcript overlay，在 overlay 中按 Esc 会直接从阶段 2 开始（`begin_overlay_backtrack_preview`，`app_backtrack.rs:280-289`）。

### 回滚请求与确认

```
用户确认选择 → apply_backtrack_rollback()
    ├── 计算 num_turns = 总用户消息数 - 选中消息序号
    ├── 设置 pending_rollback 守卫
    ├── 提交 AppCommand::thread_rollback(num_turns) 到 Core
    └── 立即预填 composer（UX 便利，不等待确认）

Core 响应 ThreadRolledBack
    ├── 有 pending_rollback → finish_pending_backtrack()
    │     ├── 校验 thread_id 匹配
    │     ├── 按 nth_user_message 裁剪 transcript_cells
    │     └── 同步 overlay 状态
    └── 无 pending_rollback → apply_non_pending_thread_rollback()
          ├── 按 num_turns 从末尾删除用户轮次
          └── 同步 overlay 状态
```

关键设计：`pending_rollback` 作为互斥守卫，阻止在等待 Core 响应期间发起重复回滚请求（`app_backtrack.rs:194-198`）。

### Transcript 裁剪

裁剪有两种模式，对应两种回滚来源：

- **`trim_transcript_cells_to_nth_user`**（`app_backtrack.rs:566-580`）：用于用户主动发起的回溯。截断到第 N 个用户消息所在位置，该用户消息及其后的所有 cell 被移除。
- **`trim_transcript_cells_drop_last_n_user_turns`**（`app_backtrack.rs:582-604`）：用于服务端发起的回滚。从末尾删除最后 N 个用户轮次及其对应的 cell。

两者都会在裁剪后调用 `sync_overlay_after_transcript_trim` 保持 UI 一致性。

### Overlay 与 Live Tail 同步

当 transcript overlay 打开时，`overlay_forward_event` 在每次 `TuiEvent::Draw` 时执行特殊处理（`app_backtrack.rs:363-399`）：

1. 从 `ChatWidget` 获取 active cell 的缓存 key（`active_cell_transcript_key`）
2. 调用 `TranscriptOverlay::sync_live_tail` 将当前活跃的、尚未提交的 cell 作为只读尾部追加到 overlay 视图中
3. 如果活跃 cell 包含动画 tick 且 overlay 滚动到底部，安排 50ms 后的刷新帧

这确保了用户在 Ctrl+T overlay 中能看到正在进行中的工具调用和流式输出，而不会等到下一次 flush 边界。

## 类型定义

### `BacktrackState`

聚合了所有回溯相关的运行时状态，作为 `App` 的字段存在。

| 字段 | 类型 | 说明 |
|------|------|------|
| `primed` | `bool` | Esc 是否已预备回溯模式 |
| `base_id` | `Option<ThreadId>` | 预备时捕获的线程 ID，线程切换后选择失效 |
| `nth_user_message` | `usize` | 当前高亮的用户消息序号（`usize::MAX` = 无选择） |
| `overlay_preview_active` | `bool` | overlay 是否处于回溯预览状态 |
| `pending_rollback` | `Option<PendingBacktrackRollback>` | 等待 Core 确认的回滚请求守卫 |

> 源码位置：`app_backtrack.rs:47-66`

### `BacktrackSelection`

用户选定的回溯目标，包含回滚所需的全部信息。

| 字段 | 类型 | 说明 |
|------|------|------|
| `nth_user_message` | `usize` | 选中的用户消息序号 |
| `prefill` | `String` | 从选中消息提取的 composer 预填内容 |
| `text_elements` | `Vec<TextElement>` | 选中消息的文本元素 |
| `local_image_paths` | `Vec<PathBuf>` | 选中消息关联的本地图片路径 |
| `remote_image_urls` | `Vec<String>` | 选中消息关联的远程图片 URL |

> 源码位置：`app_backtrack.rs:69-87`

### `PendingBacktrackRollback`

一个正在等待 Core 响应的回滚请求。包含 `BacktrackSelection` 和发出请求时的 `thread_id`，用于校验响应是否对应同一线程。

> 源码位置：`app_backtrack.rs:93-97`

## 函数签名与参数说明

### 公开方法（`impl App`）

| 方法 | 说明 |
|------|------|
| `handle_backtrack_overlay_event(&mut self, tui, event) → Result<bool>` | 在 overlay 打开时路由按键事件：Esc/Left 后退、Right 前进、Enter 确认，其余转发给 overlay |
| `handle_backtrack_esc_key(&mut self, tui)` | 主视图中 Esc 键处理：composer 非空则忽略，否则按状态 prime → open → step |
| `apply_backtrack_rollback(&mut self, selection)` | 提交回滚请求到 Core，设置 pending 守卫，预填 composer |
| `open_transcript_overlay(&mut self, tui)` | 打开 transcript overlay（进入 alt screen） |
| `close_transcript_overlay(&mut self, tui)` | 关闭 overlay，刷新 deferred history lines，重置 backtrack 状态 |
| `render_transcript_once(&mut self, tui)` | 一次性将所有 transcript cells 渲染到终端 scrollback |
| `confirm_backtrack_from_main(&mut self) → Option<BacktrackSelection>` | 从主视图确认回溯选择（非 overlay 路径） |
| `reset_backtrack_state(&mut self)` | 完全清除回溯状态 |
| `handle_backtrack_rollback_succeeded(&mut self, num_turns)` | 处理 Core 回滚成功事件 |
| `handle_backtrack_rollback_failed(&mut self)` | 处理 Core 回滚失败事件，清除 pending 守卫 |
| `apply_non_pending_thread_rollback(&mut self, num_turns) → bool` | 处理非用户发起的回滚（服务端 `ThreadRolledBack`） |

### 模块级辅助函数

| 函数 | 说明 |
|------|------|
| `user_count(cells) → usize` | 统计当前 session 起始后的用户消息数 |
| `trim_transcript_cells_to_nth_user(cells, nth) → bool` | 截断到第 N 个用户消息位置 |
| `trim_transcript_cells_drop_last_n_user_turns(cells, num_turns) → bool` | 从末尾删除最后 N 个用户轮次 |
| `nth_user_position(cells, nth) → Option<usize>` | 返回第 N 个用户消息在 cells 数组中的实际索引 |
| `user_positions_iter(cells) → impl Iterator<Item = usize>` | 迭代当前 session 内所有用户消息的位置索引 |

## 边界 Case 与注意事项

- **Session 边界**：`user_positions_iter` 从最后一个 `SessionInfoCell` 之后开始计数（`app_backtrack.rs:626-629`），因此回溯只作用于当前 session 的用户消息，不会跨越 session 边界。

- **线程切换保护**：`backtrack_selection` 和 `finish_pending_backtrack` 都会校验当前 `thread_id` 是否与 `base_id` 一致（`app_backtrack.rs:510-513`, `496-499`）。如果用户在回溯过程中切换了线程，选择会被静默丢弃。

- **重复回滚保护**：`pending_rollback` 作为互斥守卫，在等待 Core 响应期间阻止新的回滚请求。回滚失败时守卫被清除（`app_backtrack.rs:471-473`）。

- **Deferred history lines 清理**：overlay 打开期间，渲染的历史行会被缓冲。如果此时发生回滚裁剪，`sync_overlay_after_transcript_trim` 会清空这些缓冲行（`app_backtrack.rs:560-562`），避免关闭 overlay 时刷出已被删除的内容。

- **Composer 预填的时机**：composer 内容在回滚请求发出时立即填充，不等待 Core 确认（`app_backtrack.rs:218-225`）。如果回滚失败，预填内容会保留，方便用户重试或编辑。

- **`nth_user_message = usize::MAX`**：这是一个哨兵值，表示"尚未选择任何用户消息"（`app_backtrack.rs:57`）。裁剪函数会将此值视为无操作。

- **Overflow 安全**：`trim_transcript_cells_drop_last_n_user_turns` 能正确处理 `num_turns` 大于实际用户消息数的情况——会裁剪到第一个用户消息位置，保留 session 之前的非用户 cell（`app_backtrack.rs:596-600`）。