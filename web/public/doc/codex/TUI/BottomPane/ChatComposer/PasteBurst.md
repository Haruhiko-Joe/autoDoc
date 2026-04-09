# PasteBurst — 非括号粘贴突发检测状态机

## 概述与职责

`PasteBurst` 是一个**纯状态机**，用于在不支持括号粘贴模式（bracketed paste）的终端上检测粘贴操作。它位于 **TUI → BottomPane → ChatComposer** 层级中，是 `ChatComposer` 的内部子组件。

### 问题背景

在某些平台（尤其是 Windows），终端不会发送单一的"粘贴"事件，而是将粘贴内容拆解为一连串快速到达的 `KeyCode::Char` 和 `KeyCode::Enter` 按键事件。这会导致三个问题：

1. **副作用误触发**：粘贴的字符可能触发绑定在特定按键上的 UI 动作（如 `?` 触发帮助切换）
2. **Enter 误提交**：多行粘贴中的回车会被当作"提交消息"而非"插入换行"
3. **界面闪烁**：前几个字符以"正常输入"方式插入后，又被重新归类为粘贴，导致视觉闪烁

`PasteBurst` 通过时序分析和缓冲策略解决了这些问题。它本身**不修改任何 UI 文本**——只做决策，由 `ChatComposer` 负责执行对应的 UI 操作。

> 源码位置：`codex-rs/tui/src/bottom_pane/paste_burst.rs`

## 关键概念

### 状态模型

状态机有四个概念状态：

| 状态 | 含义 | 对应字段 |
|------|------|----------|
| **Idle** | 无缓冲文本，无挂起字符 | 所有字段为默认值 |
| **Pending first char** | 暂存第一个快速 ASCII 字符，等待判断是否有突发跟随 | `pending_first_char = Some((char, Instant))` |
| **Active buffer** | 正在缓冲粘贴内容 | `active = true`，`buffer` 非空 |
| **Enter suppress window** | 缓冲刷新后短暂保持，让延迟到达的 Enter 仍作为换行处理 | `burst_window_until = Some(...)` |

### 时序阈值

两个关键超时参数，均有**平台特定值**（Windows 终端传递粘贴事件更慢）：

| 常量 | 非 Windows | Windows | 作用 |
|------|-----------|---------|------|
| `PASTE_BURST_CHAR_INTERVAL` | 8ms | 30ms | 相邻字符间距上限，超过则认为不属于同一突发 |
| `PASTE_BURST_ACTIVE_IDLE_TIMEOUT` | 8ms | 60ms | 缓冲激活后的空闲超时，超过则刷新缓冲区 |

其他常量：
- `PASTE_BURST_MIN_CHARS = 3`：触发突发检测的最小连续快速字符数
- `PASTE_ENTER_SUPPRESS_WINDOW = 120ms`：Enter 抑制窗口时长

> 源码位置：`codex-rs/tui/src/bottom_pane/paste_burst.rs:153-169`

## 关键流程

### 1. ASCII 字符输入流程（`on_plain_char`）

这是主要入口，处理每个普通 ASCII 字符：

1. 调用 `note_plain_char(now)` 更新时序计数器（`codex-rs/tui/src/bottom_pane/paste_burst.rs:277-286`）
   - 如果与上次字符间距 ≤ `PASTE_BURST_CHAR_INTERVAL`，则递增 `consecutive_plain_char_burst`
   - 否则重置为 1
2. **已在缓冲模式**（`active == true`）→ 返回 `BufferAppend`，扩展 Enter 抑制窗口
3. **存在挂起字符且第二个字符足够快** → 将挂起字符压入 `buffer`，激活缓冲模式，返回 `BeginBufferFromPending`
4. **连续快速字符 ≥ 3（`PASTE_BURST_MIN_CHARS`）** → 返回 `BeginBuffer { retro_chars }`，提示调用者回溯捕获已插入的前缀
5. **否则** → 暂存当前字符为 `pending_first_char`，返回 `RetainFirstChar`（闪烁抑制）

> 源码位置：`codex-rs/tui/src/bottom_pane/paste_burst.rs:222-252`

### 2. 非 ASCII / IME 输入流程（`on_plain_char_no_hold`）

与 `on_plain_char` 类似，但**永远不会暂存第一个字符**（避免 IME 输入感觉像丢字）。只可能返回 `BufferAppend`、`BeginBuffer` 或 `None`。

> 源码位置：`codex-rs/tui/src/bottom_pane/paste_burst.rs:260-275`

### 3. 定时刷新流程（`flush_if_due`）

由 UI tick 周期性调用：

1. 根据当前是否在缓冲模式选择超时阈值（`PASTE_BURST_ACTIVE_IDLE_TIMEOUT` vs `PASTE_BURST_CHAR_INTERVAL`）
2. 判断是否超时（使用 `>` 严格大于，因此需要超过阈值至少 1ms）
3. **缓冲模式超时** → 返回 `FlushResult::Paste(buffer_content)`，将整个缓冲区作为一次粘贴
4. **非缓冲超时 + 有挂起字符** → 返回 `FlushResult::Typed(char)`，作为正常输入插入
5. **其他** → 返回 `FlushResult::None`

> 源码位置：`codex-rs/tui/src/bottom_pane/paste_burst.rs:297-321`

### 4. 回溯捕获流程（Retro-capture）

当状态机"后知后觉"发现字符流是粘贴时，需要把已经插入到 textarea 中的前缀字符"抓回来"：

1. `on_plain_char` 返回 `BeginBuffer { retro_chars }` 指示需要回溯的字符数
2. 调用者调用 `decide_begin_buffer(now, before_cursor, retro_chars)`
3. `retro_start_index()` 将字符数转换为 UTF-8 字节偏移（`codex-rs/tui/src/bottom_pane/paste_burst.rs:455-465`）
4. **启发式判断**：只有当抓回的文本包含空白字符或长度 ≥ 16 时才认为"像粘贴"（`codex-rs/tui/src/bottom_pane/paste_burst.rs:395-396`）
5. 如果判定为粘贴，返回 `RetroGrab { start_byte, grabbed }`；否则返回 `None`，调用者按正常输入处理

### 5. Enter 抑制机制

`newline_should_insert_instead_of_submit(now)` 判断 Enter 应插入换行还是提交：
- 缓冲模式激活中 → 插入换行
- 在 `burst_window_until` 窗口内（120ms）→ 插入换行
- 否则 → 正常提交

每次有字符加入缓冲或换行被捕获时，窗口会被延长，确保多行粘贴保持连续。

> 源码位置：`codex-rs/tui/src/bottom_pane/paste_burst.rs:339-342`

## 函数签名

### 核心决策 API

#### `on_plain_char(&mut self, ch: char, now: Instant) -> CharDecision`

ASCII 字符的主入口。根据时序判断返回四种决策之一。

#### `on_plain_char_no_hold(&mut self, now: Instant) -> Option<CharDecision>`

非 ASCII/IME 字符入口。返回 `Some(BufferAppend)`、`Some(BeginBuffer { .. })` 或 `None`。

#### `flush_if_due(&mut self, now: Instant) -> FlushResult`

定时刷新，返回 `Paste(String)`、`Typed(char)` 或 `None`。

### 缓冲操作 API

#### `append_char_to_buffer(&mut self, ch: char, now: Instant)`

将字符追加到突发缓冲区，并延长 Enter 抑制窗口。

#### `append_newline_if_active(&mut self, now: Instant) -> bool`

如果正在缓冲，追加换行并延长窗口；返回是否成功。

#### `try_append_char_if_active(&mut self, ch: char, now: Instant) -> bool`

仅在缓冲已激活时追加字符；返回是否成功。

#### `decide_begin_buffer(&mut self, now: Instant, before: &str, retro_chars: usize) -> Option<RetroGrab>`

决定是否启动回溯捕获缓冲。启发式：文本含空白或长度 ≥ 16 视为粘贴。

#### `begin_with_retro_grabbed(&mut self, grabbed: String, now: Instant)`

以回溯抓取的文本初始化缓冲区。

### 清理 / 刷新 API

#### `flush_before_modified_input(&mut self) -> Option<String>`

在处理非字符输入前立即刷新缓冲区（含挂起字符）。

#### `clear_window_after_non_char(&mut self)`

清除分类窗口（时序计数器、Enter 窗口、挂起字符），但**不刷新缓冲区**——调用者须先调用 `flush_before_modified_input`。

#### `clear_after_explicit_paste(&mut self)`

收到终端原生粘贴事件后完全重置所有状态。

### 查询 API

#### `is_active(&self) -> bool`

是否处于任何粘贴相关的瞬态（缓冲中、有缓冲内容、或有挂起字符）。

#### `newline_should_insert_instead_of_submit(&self, now: Instant) -> bool`

Enter 是否应被视为换行而非提交。

#### `recommended_flush_delay() -> Duration`

推荐的 UI tick / 测试延迟，确保能跨过时序阈值。值为 `PASTE_BURST_CHAR_INTERVAL + 1ms`。

## 类型定义

### `CharDecision`（枚举）

`on_plain_char` 的返回值，指导调用者如何处理当前字符：

| 变体 | 含义 |
|------|------|
| `RetainFirstChar` | 暂不插入，等待判断是否有突发 |
| `BeginBufferFromPending` | 从挂起字符开始缓冲（无需回溯） |
| `BeginBuffer { retro_chars: u16 }` | 开始缓冲，提示回溯指定数量的已插入字符 |
| `BufferAppend` | 追加到已有缓冲区 |

### `FlushResult`（枚举）

`flush_if_due` 的返回值：

| 变体 | 含义 |
|------|------|
| `Paste(String)` | 缓冲区内容作为一次完整粘贴输出 |
| `Typed(char)` | 挂起的单字符作为正常输入输出 |
| `None` | 无需操作 |

### `RetroGrab`（结构体）

回溯捕获的结果：

| 字段 | 类型 | 含义 |
|------|------|------|
| `start_byte` | `usize` | 被抓回文本在 `before_cursor` 中的字节起始索引 |
| `grabbed` | `String` | 被抓回的文本内容 |

### `PasteBurst`（结构体）

状态机本体，所有字段均为 `pub(crate)`：

| 字段 | 类型 | 含义 |
|------|------|------|
| `last_plain_char_time` | `Option<Instant>` | 上一个普通字符到达的时间 |
| `consecutive_plain_char_burst` | `u16` | 连续快速字符计数 |
| `burst_window_until` | `Option<Instant>` | Enter 抑制窗口的截止时间 |
| `buffer` | `String` | 突发缓冲区 |
| `active` | `bool` | 是否正在主动接收突发字符 |
| `pending_first_char` | `Option<(char, Instant)>` | 闪烁抑制暂存的第一个 ASCII 字符 |

## 边界 Case 与注意事项

- **`flush_if_due` 使用严格大于（`>`）**：比较 elapsed > timeout 而非 >=，因此测试和 UI tick 需要超过阈值至少 1ms 才会触发刷新。`recommended_flush_delay()` 已包含这个 +1ms 偏移。

- **清理 vs 刷新的区别**：`clear_window_after_non_char()` 只清除时序状态但**不输出**缓冲内容；`flush_before_modified_input()` 输出缓冲内容。调用者必须先 flush 再 clear，否则缓冲文本会被丢弃。

- **回溯捕获的启发式可能不触发**：`decide_begin_buffer` 中，短于 16 字符且不含空白的文本不会被判定为粘贴——这是有意为之，避免短 IME 输入被误分类。

- **`flush_before_modified_input` 会包含挂起字符**：如果有 `pending_first_char`，它会被追加到刷新输出的末尾（`codex-rs/tui/src/bottom_pane/paste_burst.rs:416-418`）。

- **回溯捕获以字符数表达，以字节数返回**：`retro_chars` 是字符计数，`retro_start_index()` 使用 `char_indices().rev()` 转换为字节偏移，正确处理多字节 UTF-8 字符。

- **`is_active()` 的判定范围比 `active` 字段更广**：它还检查 `pending_first_char` 和非空 `buffer`，确保所有瞬态都被覆盖。