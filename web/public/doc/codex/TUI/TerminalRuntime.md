# TerminalRuntime — 终端基础设施层

## 概述与职责

TerminalRuntime 是 TUI 模块的底层终端基础设施，负责管理终端的整个生命周期——从 raw mode 初始化到退出时的恢复。它位于 TUI 层级中直接与操作系统终端交互的位置，为上层的 UI 渲染和交互组件提供基础能力。在整体架构中，TUI 模块是用户与 Codex 交互的主要界面，而 TerminalRuntime 是 TUI 与底层终端之间的桥梁。

本模块包含以下核心子系统：

- **终端初始化与恢复**：raw mode 切换、alternate screen 管理、键盘增强模式
- **异步事件流代理**：键盘/粘贴/焦点/窗口大小变化事件的统一分发
- **帧率限制与重绘调度**：120 FPS 上限的智能帧合并机制
- **作业控制**：Unix 下 Ctrl+Z 挂起/恢复的完整处理
- **桌面通知**：BEL 和 OSC 9 两种通知后端
- **自定义终端**：基于 ratatui Terminal 的定制实现，支持 inline viewport 和优化 diff 渲染
- **终端调色板**：终端颜色能力检测和默认前/背景色查询
- **终端标题管理**：安全的 OSC 标题设置与清理

## 关键流程

### 终端初始化流程

1. `init()` 检查 stdin/stdout 是否为真实终端，非终端环境直接报错（`codex-rs/tui/src/tui.rs:209-215`）
2. 调用 `set_modes()` 启用 raw mode、bracketed paste、键盘增强标志（`DISAMBIGUATE_ESCAPE_CODES` + `REPORT_EVENT_TYPES` + `REPORT_ALTERNATE_KEYS`）和焦点变化报告（`codex-rs/tui/src/tui.rs:63-84`）
3. 调用 `flush_terminal_input_buffer()` 清空 stdin 缓冲区中的残留输入（Unix 使用 `tcflush`，Windows 使用 `FlushConsoleInputBuffer`）（`codex-rs/tui/src/tui.rs:172-206`）
4. 注册 panic hook，确保即使程序崩溃也能恢复终端状态（`codex-rs/tui/src/tui.rs:227-233`）
5. 创建 `CrosstermBackend` 并包装为自定义 `Terminal`

`Tui::new()` 在初始化时还会：
- 检测键盘增强支持能力
- 缓存 `supports_color` 结果
- 查询终端默认前/背景色
- 检测是否运行在 Zellij 环境中
- 初始化通知后端

### 事件流处理流程

事件系统采用 broker 模式，核心由 `EventBroker` 和 `TuiEventStream` 组成：

1. `EventBroker` 持有共享的 crossterm `EventStream`，维护三种状态：`Paused`（已释放 stdin）、`Start`（待创建）、`Running`（正在轮询）（`codex-rs/tui/src/tui/event_stream.rs:57-61`）
2. `TuiEventStream` 实现 `tokio_stream::Stream`，同时轮询两个事件源：crossterm 输入事件和 broadcast draw 事件（`codex-rs/tui/src/tui/event_stream.rs:265-291`）
3. 轮询策略采用轮转公平调度（`poll_draw_first` 交替翻转），防止任一事件源饥饿（`codex-rs/tui/src/tui/event_stream.rs:270-271`）
4. crossterm 事件经过 `map_crossterm_event()` 映射：
   - `Key` → `TuiEvent::Key`（Unix 下先检查是否为 Ctrl+Z 挂起键）
   - `Resize` → `TuiEvent::Draw`
   - `Paste` → `TuiEvent::Paste`
   - `FocusGained` → 更新焦点状态 + 重新查询调色板 + `TuiEvent::Draw`
   - `FocusLost` → 更新焦点状态，不产生事件

**暂停/恢复机制**：当需要将终端控制权交给外部程序（如 vim）时，调用 `pause_events()` 将状态设为 `Paused` 以释放 stdin；外部程序完成后调用 `resume_events()` 通过 `watch` channel 唤醒等待中的 stream。这个设计解决了 crossterm EventStream 在停止轮询后仍会读取 stdin 的竞态问题（`codex-rs/tui/src/tui/event_stream.rs:10-18`）。

### 帧调度流程

帧调度采用 actor 模式，由 `FrameRequester`（句柄端）和 `FrameScheduler`（任务端）组成：

1. 任何组件通过 `FrameRequester::schedule_frame()` 或 `schedule_frame_in(dur)` 发送重绘请求（`codex-rs/tui/src/tui/frame_requester.rs:49-56`）
2. `FrameScheduler` 在后台 tokio task 中运行，通过 `tokio::select!` 同时等待新请求和定时器到期（`codex-rs/tui/src/tui/frame_requester.rs:96-127`）
3. 多个请求被合并为单次 draw 通知：收到请求时只更新截止时间（取最早值），不立即发送通知；等定时器到期时才发出一次 broadcast
4. `FrameRateLimiter` 将帧率上限控制在 120 FPS（最小间隔 ≈8.33ms），通过 `clamp_deadline()` 将过早的请求推迟到允许的最小时刻（`codex-rs/tui/src/tui/frame_rate_limiter.rs:13-37`）

### 绘制流程

`Tui::draw()` 在 `stdout().sync_update()` 同步更新块内执行以下步骤（`codex-rs/tui/src/tui.rs:532-590`）：

1. 如果有挂起恢复动作（`^Z` 后），先应用恢复（重新进入 alt screen 或重新对齐 inline viewport）
2. 处理 pending viewport 区域更新（终端 resize 时的光标位置修正）
3. 调用 `update_inline_viewport()` 调整 viewport 高度，必要时滚动上方内容（Zellij 环境使用原始换行而非 DECSTBM 滚动区域）
4. 刷新 pending history lines 到 viewport 上方
5. 更新挂起用光标 Y 坐标
6. 调用 `terminal.draw()` 执行实际渲染

### Ctrl+Z 挂起/恢复流程（Unix）

1. 事件流检测到 Ctrl+Z 按键后调用 `SuspendContext::suspend()`（`codex-rs/tui/src/tui/event_stream.rs:241-243`）
2. 如果在 alt screen 中，先退出 alt screen 和 alt scroll，记录 `ResumeAction::RestoreAlt`；否则记录 `ResumeAction::RealignInline`（`codex-rs/tui/src/tui/job_control.rs:64-76`）
3. 将光标移动到已缓存的 inline viewport 底部位置，显示光标
4. `suspend_process()` 恢复终端状态后发送 `SIGTSTP`（`codex-rs/tui/src/tui/job_control.rs:176-182`）
5. 进程被 `fg` 恢复后，`set_modes()` 重新应用终端模式
6. 下次 `Tui::draw()` 时，`prepare_resume_action()` 消费挂起意图，返回 `PreparedResumeAction` 在同步绘制块内应用

## 函数签名与参数说明

### `init() -> io::Result<Terminal>`

初始化终端：验证 stdin/stdout 为终端、启用 raw mode 和增强模式、清空输入缓冲、设置 panic hook、创建 Terminal 实例。

> 源码位置：`codex-rs/tui/src/tui.rs:209-225`

### `set_modes() -> io::Result<()>`

启用 TUI 所需的终端模式：bracketed paste、raw mode、键盘增强标志、焦点变化报告。

> 源码位置：`codex-rs/tui/src/tui.rs:63-84`

### `restore() -> io::Result<()>` / `restore_keep_raw() -> io::Result<()>`

恢复终端到初始状态。`restore()` 完全恢复（含 disable raw mode），`restore_keep_raw()` 保持 raw mode 不变。

> 源码位置：`codex-rs/tui/src/tui.rs:142-151`

### `Tui::new(terminal: Terminal) -> Self`

构造 `Tui` 实例，初始化帧调度、事件代理、通知后端、焦点状态等。

> 源码位置：`codex-rs/tui/src/tui.rs:263-291`

### `Tui::event_stream() -> Pin<Box<dyn Stream<Item = TuiEvent> + Send + 'static>>`

创建一个统一的事件流，合并 crossterm 输入事件和 draw broadcast 事件。

> 源码位置：`codex-rs/tui/src/tui.rs:391-407`

### `Tui::draw(&mut self, height: u16, draw_fn: impl FnOnce(&mut Frame)) -> io::Result<()>`

在同步更新块内执行一帧绘制。处理挂起恢复、viewport 调整、history line 刷新，然后调用 `draw_fn` 渲染。

> 源码位置：`codex-rs/tui/src/tui.rs:532-590`

### `Tui::with_restored<R, F, Fut>(&mut self, mode: RestoreMode, f: F) -> R`

暂停事件流并恢复终端状态，执行外部交互程序 `f`，完成后重新应用终端模式。用于调用外部编辑器等场景。

> 源码位置：`codex-rs/tui/src/tui.rs:330-362`

### `Tui::notify(&mut self, message: impl AsRef<str>) -> bool`

当终端处于未聚焦状态时发送桌面通知。返回是否成功发送。如果通知失败，自动禁用后续通知。

> 源码位置：`codex-rs/tui/src/tui.rs:366-389`

### `FrameRequester::schedule_frame()` / `schedule_frame_in(dur: Duration)`

请求立即或延迟重绘。多个请求会被合并，帧率上限 120 FPS。

> 源码位置：`codex-rs/tui/src/tui/frame_requester.rs:49-56`

### `set_terminal_title(title: &str) -> io::Result<SetTerminalTitleResult>`

将经过安全清理的标题通过 OSC 0 序列写入终端。自动剥离控制字符、bidi 格式化字符，并截断到 240 字符。

> 源码位置：`codex-rs/tui/src/terminal_title.rs:56-68`

## 接口/类型定义

### `TuiEvent`

TUI 事件的统一抽象：

```rust
pub enum TuiEvent {
    Key(KeyEvent),    // 键盘事件
    Paste(String),    // 粘贴事件（bracketed paste）
    Draw,             // 重绘事件（resize、定时器、焦点变化等触发）
}
```

> 源码位置：`codex-rs/tui/src/tui.rs:236-240`

### `RestoreMode`

终端恢复模式：

| 变体 | 说明 |
|------|------|
| `Full` | 完全恢复终端（包括 disable raw mode） |
| `KeepRaw` | 恢复终端但保持 raw mode |

> 源码位置：`codex-rs/tui/src/tui.rs:153-167`

### `DesktopNotificationBackend`

桌面通知后端枚举：

| 变体 | 说明 |
|------|------|
| `Osc9(Osc9Backend)` | OSC 9 通知，写入 `ESC]9;message BEL` 序列 |
| `Bel(BelBackend)` | BEL 通知，写入 `\x07` 字符 |

> 源码位置：`codex-rs/tui/src/notifications/mod.rs:12-15`

### `SetTerminalTitleResult`

标题设置结果：

| 变体 | 说明 |
|------|------|
| `Applied` | 标题已写入（或 stdout 非终端所以无需写入） |
| `NoVisibleContent` | 清理后无可见内容，未写入任何标题 |

> 源码位置：`codex-rs/tui/src/terminal_title.rs:35-44`

### `StdoutColorLevel`

终端颜色能力级别：

| 变体 | 说明 |
|------|------|
| `TrueColor` | 支持 16M 色（24-bit RGB） |
| `Ansi256` | 支持 256 色 |
| `Ansi16` | 支持 16 色 |
| `Unknown` | 无法检测 |

> 源码位置：`codex-rs/tui/src/terminal_palette.rs:13-18`

### `custom_terminal::Frame`

自定义渲染帧，封装了 viewport 区域、缓冲区和光标位置：

```rust
pub struct Frame<'a> {
    pub(crate) cursor_position: Option<Position>,
    pub(crate) viewport_area: Rect,
    pub(crate) buffer: &'a mut Buffer,
}
```

提供 `area()`、`render_widget_ref()`、`set_cursor_position()`、`buffer_mut()` 方法。

> 源码位置：`codex-rs/tui/src/custom_terminal.rs:82-135`

## 配置项与默认值

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `TARGET_FRAME_INTERVAL` | `Duration` | ≈8.33ms（120 FPS） | 最小帧间隔，用于帧率限制 |
| `MAX_TERMINAL_TITLE_CHARS` | `usize` | 240 | 终端标题最大字符数 |
| `FRAME_TICK_DEFAULT` | `Duration` | 80ms | 动画帧切换间隔 |
| `NotificationMethod` | 枚举 | `Auto` | 通知方式：Auto/Osc9/Bel |

动画帧变体包括：`default`、`codex`、`openai`、`blocks`、`dots`、`hash`、`hbars`、`vbars`、`shapes`、`slug`，每种 36 帧，通过 `include_str!` 编译时嵌入（`codex-rs/tui/src/frames.rs:47-56`）。

## 边界 Case 与注意事项

- **键盘增强标志兼容性**：部分终端（如旧版 Windows 控制台）不支持 `PushKeyboardEnhancementFlags`，启用失败时静默忽略继续运行（`codex-rs/tui/src/tui.rs:72-80`）
- **Zellij 兼容**：Zellij 不支持 DECSTBM 滚动区域，viewport 扩展时改用原始换行滚动（`scroll_zellij_expanded_viewport`），并在 Zellij 环境下可禁用 alt screen（`codex-rs/tui/src/tui.rs:496-509`）
- **通知自动降级**：通知发送失败时自动将 `notification_backend` 设为 `None`，禁用后续通知，避免反复报错（`codex-rs/tui/src/tui.rs:378-388`）
- **OSC 9 检测逻辑**：Windows Terminal（`WT_SESSION`）明确排除 OSC 9；支持的终端通过 `TERM_PROGRAM`（WezTerm、ghostty）、`ITERM_SESSION_ID`、`TERM` 变量检测（`codex-rs/tui/src/notifications/mod.rs:51-72`）
- **标题安全清理**：终端标题内容来自不可信来源（模型输出、项目路径等），写入前会剥离控制字符和 Trojan Source 相关的 bidi 控制符，防止 escape sequence 注入（`codex-rs/tui/src/terminal_title.rs:110-145`）
- **EventBroker 的 drop/recreate 设计**：不是简单停止轮询，而是完全 drop 并重建 crossterm EventStream。因为 crossterm 即使不被轮询也会在后台线程读取 stdin，可能窃取外部程序的输入或捕获终端查询响应（`codex-rs/tui/src/tui/event_stream.rs:10-18`）
- **自定义 Terminal 的 diff 渲染优化**：`diff_buffers` 中对每行扫描最右非空白列，之后的内容用单条 `ClearToEnd` 替代逐个空格写入，显著减少 I/O。同时正确处理 OSC 转义序列（如超链接）的显示宽度计算（`codex-rs/tui/src/custom_terminal.rs:56-79`）
- **调色板版本追踪**：`palette_version()` 提供单调递增计数器，在终端焦点恢复重新查询颜色后递增，使缓存的渲染行知道何时需要失效重绘（`codex-rs/tui/src/terminal_palette.rs:80-86`）