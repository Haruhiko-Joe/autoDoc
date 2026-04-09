# History（聊天输入历史导航）

## 概述与职责

History 模块实现了一个 **shell 风格的历史导航状态机**，用于在 ChatComposer（聊天输入框）中通过 Up/Down 键回溯和浏览之前提交过的消息。它位于 TUI → BottomPane → ChatComposer 子系统中，刻意与渲染层解耦，使导航逻辑可以独立测试。

该模块管理两类历史来源的统一视图：

1. **持久化跨会话历史**（persistent history）：由 Core 层维护的历史日志文件，通过异步 `GetHistoryEntryRequest` 按需获取，仅包含纯文本
2. **本地会话内历史**（local history）：当前 TUI 会话中用户提交的消息，包含完整的草稿状态（文本元素、图片路径、远程 URL、mention 绑定、待粘贴内容）

源码位置：`codex-rs/tui/src/bottom_pane/chat_composer_history.rs`

## 关键流程

### 历史导航流程（Up 键）

1. ChatComposer 收到 Up 键事件，调用 `should_handle_navigation()` 判断是否应拦截为历史导航（而非普通的多行光标移动）
2. 若允许导航，调用 `navigate_up()`，计算统一游标的下一个位置（从最新条目向最旧方向移动）
3. `populate_history_at_index()` 根据全局索引判断条目来源：
   - **索引 ≥ `history_entry_count`**：从 `local_history` 向量中直接读取，立即返回完整的 `HistoryEntry`
   - **索引 < `history_entry_count` 且已缓存**：从 `fetched_history` HashMap 中命中缓存，立即返回
   - **索引 < `history_entry_count` 且未缓存**：通过 `AppEventSender` 发送 `Op::GetHistoryEntryRequest { offset, log_id }` 异步请求，本次返回 `None`
4. 异步响应到达后，`on_entry_response()` 将结果存入缓存，若游标仍指向该位置则返回条目供 Composer 填充

### 导航守卫逻辑

`should_handle_navigation()` 的判断规则（`chat_composer_history.rs:173-191`）：

- 输入框为空 → 始终允许导航
- 输入框非空时需**同时满足**：
  - 当前文本与上次历史回填的文本完全一致（`last_history_text`）
  - 光标位于文本起始（`cursor == 0`）或末尾（`cursor == text.len()`）
- 这一设计确保用户在多行回填内容中间移动光标时，Up/Down 键执行正常的行内导航，而不会意外触发历史切换

### 提交记录与去重

`record_local_submission()` 在每次用户提交消息时被调用（`chat_composer_history.rs:136-155`）：

1. 空条目（所有字段均为空）被静默忽略
2. 若新条目与 `local_history` 末尾条目完全相同，跳过插入（连续去重）
3. 插入后重置导航游标，退出浏览模式

## 核心类型

### `HistoryEntry`

历史条目的完整草稿状态，用于恢复 Composer 的输入内容（`chat_composer_history.rs:13-26`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `text` | `String` | 原始文本（可能包含占位符字符串） |
| `text_elements` | `Vec<TextElement>` | 文本中占位符的范围信息 |
| `local_image_paths` | `Vec<PathBuf>` | 本地图片附件路径 |
| `remote_image_urls` | `Vec<String>` | 远程图片 URL |
| `mention_bindings` | `Vec<MentionBinding>` | @-mention 引用的工具/应用/技能绑定 |
| `pending_pastes` | `Vec<(String, String)>` | 占位符→粘贴内容的映射对 |

构造函数 `HistoryEntry::new(text)` 会自动调用 `decode_history_mentions()` 解析文本中编码的 mention 信息，将其还原为 `MentionBinding` 列表。

### `ChatComposerHistory`

状态机主结构体（`chat_composer_history.rs:87-110`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `history_log_id` | `Option<u64>` | 持久化历史日志标识符，由 `SessionConfiguredEvent` 提供 |
| `history_entry_count` | `usize` | 会话启动时持久化历史中已有的条目数 |
| `local_history` | `Vec<HistoryEntry>` | 当前会话提交的消息列表（最新在末尾） |
| `fetched_history` | `HashMap<usize, HistoryEntry>` | 按需获取的持久化条目缓存（offset → entry） |
| `history_cursor` | `Option<isize>` | 统一游标位置；`None` 表示不在浏览模式 |
| `last_history_text` | `Option<String>` | 上次历史回填的文本，用于导航守卫判断 |

## 函数签名

### `ChatComposerHistory::new() -> Self`
创建空的历史状态机，所有字段初始化为零值/`None`。

### `set_metadata(&mut self, log_id: u64, entry_count: usize)`
会话配置完成后调用，设置持久化历史的日志 ID 和条目数量，并清空所有缓存和本地历史。

### `record_local_submission(&mut self, entry: HistoryEntry)`
记录一次用户提交。空条目和连续重复条目被过滤。

### `reset_navigation(&mut self)`
重置导航状态（游标和回填文本），使下次 Up 键从最新条目重新开始。

### `should_handle_navigation(&self, text: &str, cursor: usize) -> bool`
判断当前 Up/Down 按键是否应被视为历史导航。参数 `text` 是输入框当前文本，`cursor` 是光标位置。

### `navigate_up(&mut self, app_event_tx: &AppEventSender) -> Option<HistoryEntry>`
处理 Up 键。游标向旧条目方向移动。返回 `Some(entry)` 时调用者应将内容填入 Composer；返回 `None` 表示需要等待异步响应或已到达最旧条目。

### `navigate_down(&mut self, app_event_tx: &AppEventSender) -> Option<HistoryEntry>`
处理 Down 键。游标向新条目方向移动。到达末尾时返回空 `HistoryEntry` 并退出浏览模式。

### `on_entry_response(&mut self, log_id: u64, offset: usize, entry: Option<String>) -> Option<HistoryEntry>`
处理 `GetHistoryEntryResponse` 异步回调。验证 `log_id` 匹配后缓存条目，若游标仍指向该 offset 则返回给调用者。

## 统一索引模型

持久化历史和本地历史共享一个线性索引空间：

```
[0 .. history_entry_count-1] → 持久化历史（最旧 → 最新）
[history_entry_count .. total-1] → 本地会话历史（最旧 → 最新）
```

`navigate_up()` 从 `total - 1`（最新）向 `0`（最旧）移动；`navigate_down()` 反向移动。超出最新端时清空游标并回到正常编辑模式。

## 异步获取与缓存

持久化历史条目通过 `Op::GetHistoryEntryRequest { offset, log_id }` 协议操作异步获取（`chat_composer_history.rs:281-284`）。响应通过 `on_entry_response()` 回调注入，存入 `fetched_history: HashMap<usize, HistoryEntry>` 作为 LRU 式缓存——后续导航到同一 offset 时直接命中缓存，无需再次请求。

`log_id` 用于防止会话切换后旧响应污染新会话的缓存。`set_metadata()` 调用时会清空整个缓存。

## 边界 Case 与注意事项

- **空提交被忽略**：所有字段均为空的 `HistoryEntry` 不会被记录到 `local_history`
- **连续去重**：相邻相同的提交只保留一份，但非相邻的重复不受影响
- **异步获取返回 `None`**：首次访问未缓存的持久化条目时，`navigate_up/down` 返回 `None`，Composer 需在 `on_entry_response` 回调中再次处理填充
- **多行文本中的光标位置**：只有光标在位置 0 或文本末尾时才允许历史导航，中间位置的 Up/Down 交给 TextArea 处理正常的行间移动
- **Down 到底退出浏览**：当游标到达最新条目之后，返回空 `HistoryEntry` 清空输入框，并将 `history_cursor` 置为 `None`
- **会话重置**：`set_metadata()` 会同时清空 `local_history` 和 `fetched_history`，适用于切换到新会话的场景