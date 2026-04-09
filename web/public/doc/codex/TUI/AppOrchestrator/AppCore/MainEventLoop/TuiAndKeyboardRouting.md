# TUI 事件处理与键盘路由

## 概述与职责

本模块是 TUI 应用主事件循环中处理终端 UI 事件和键盘输入的核心路由层。它位于 `App` 结构体的 `impl` 块中，属于 **TUI → AppOrchestrator → AppCore → MainEventLoop** 层级。上层的 `run()` 事件循环通过 `select!` 接收到 `TuiEvent` 后，调用本模块的 `handle_tui_event()` 进行分发；键盘事件进一步由 `handle_key_event()` 路由到具体的快捷键处理器或下沉到 `chat_widget`。

同级兄弟模块包括 ServerEventAdapter（处理 app-server 事件）、PendingRequests（跟踪待决请求）、InteractiveReplayTracking（线程切换回放过滤）、AgentNavigation（多 agent 导航状态）和 LoadedThreadDiscovery（子 agent 线程发现）。

## 关键流程

### TuiEvent 分发流程（`handle_tui_event`）

`handle_tui_event()` 是所有终端事件的入口（`codex-rs/tui/src/app.rs:3945-4005`）。处理逻辑如下：

1. **屏幕尺寸变化检测**：每次 `TuiEvent::Draw` 到达时，检查终端尺寸是否变化，若变化则调用 `refresh_status_line()` 更新状态栏
2. **Overlay 优先**：若当前存在 overlay（如 Ctrl+T 打开的 transcript 面板），所有事件交给 `handle_backtrack_overlay_event()` 处理，不进入常规路由
3. **常规事件分发**：
   - `TuiEvent::Key(key_event)` → 交给 `handle_key_event()`
   - `TuiEvent::Paste(pasted)` → 将 `\r` 规范化为 `\n`（兼容 iTerm2 等终端），然后交给 `chat_widget.handle_paste()`
   - `TuiEvent::Draw` → 执行完整的渲染管线

### Draw 渲染管线

`TuiEvent::Draw` 分支（`codex-rs/tui/src/app.rs:3973-4001`）执行以下步骤：

1. 若有待处理的 backtrack 渲染，先刷新 transcript
2. 发送挂起的桌面通知（`maybe_post_pending_notification`）
3. 处理粘贴突发帧计时（`handle_paste_burst_tick`），若仍在突发中则提前返回，避免不必要的重绘
4. 调用 `pre_draw_tick()` 让 widget 处理定时器
5. 调用 `tui.draw()` 执行实际渲染：计算 chat_widget 高度、渲染到帧缓冲区、设置光标位置
6. 检查外部编辑器状态：若为 `Requested` 则转为 `Active` 并发送 `AppEvent::LaunchExternalEditor`

### 键盘路由流程（`handle_key_event`）

`handle_key_event()`（`codex-rs/tui/src/app.rs:5834-5969`）按优先级依次匹配快捷键：

**1. Agent 切换快捷键（最高优先级）**

- **Alt+Left / Alt+Right**：在多 agent 线程之间切换。仅在无 overlay、无弹窗、composer 为空时生效
- 对于不支持增强键盘报告的终端，Alt+b/f 作为后备映射，同样仅在 composer 为空时触发，避免干扰正常的词级光标移动

```rust
// codex-rs/tui/src/app.rs:5844-5876
let allow_agent_word_motion_fallback = !self.enhanced_keys_supported
    && self.chat_widget.composer_text_with_pending().is_empty();
```

**2. Ctrl 组合键**

| 快捷键 | 行为 | 源码位置 |
|--------|------|----------|
| Ctrl+T | 进入 alt-screen，打开 transcript overlay 面板 | `5878-5889` |
| Ctrl+L | 清空终端 UI 并重置状态（需 `can_run_ctrl_l_clear_now()` 通过） | `5890-5908` |
| Ctrl+G | 请求启动外部编辑器（需无 overlay、composer 可用、编辑器未激活） | `5909-5923` |

**3. Backtrack 相关按键**

- **Esc**：在"普通回溯模式"且 composer 为空时，触发 backtrack priming/advancing；否则转发给 chat_widget（如关闭弹窗）
- **Enter**：当 backtrack 已 primed 且已选中目标用户消息时，确认执行回溯

**4. 兜底处理**

所有未匹配的 `KeyEventKind::Press | Repeat` 事件：先取消已 primed 的 backtrack 状态（避免 Esc 残留），然后转发给 `chat_widget.handle_key_event()`。

### 外部编辑器集成

外部编辑器生命周期由三个方法管理：

**`request_external_editor_launch()`**（`codex-rs/tui/src/app.rs:5817-5825`）：
- 将编辑器状态设为 `Requested`，设置页脚提示文案
- 调度一帧重绘——实际启动在下一个 `Draw` 事件中触发

**`launch_external_editor()`**（`codex-rs/tui/src/app.rs:5771-5815`）：
1. 通过 `external_editor::resolve_editor_command()` 解析 `$VISUAL` 或 `$EDITOR` 环境变量
2. 提取当前 composer 文本作为编辑种子内容
3. 使用 `tui.with_restored(RestoreMode::KeepRaw, ...)` 临时恢复终端状态，在子进程中运行编辑器
4. 编辑完成后 trim 尾部空白，调用 `apply_external_edit()` 回填到 composer

**`reset_external_editor_state()`**（`codex-rs/tui/src/app.rs:5827-5832`）：
- 将状态重置为 `Closed`，清除页脚提示，调度重绘

### 粘贴处理

`TuiEvent::Paste` 分支（`codex-rs/tui/src/app.rs:3965-3972`）进行 CR→LF 规范化。这是因为许多终端（如 iTerm2）在粘贴时将换行符编码为 `\r`，而 `tui-textarea` 组件期望 `\n`。

## 函数签名

### `handle_tui_event(&mut self, tui: &mut Tui, app_server: &mut AppServerSession, event: TuiEvent) -> Result<AppRunControl>`

TUI 事件总入口。分发 `Draw`、`Paste`、`Key` 三种事件。当存在 overlay 时，所有事件走 backtrack overlay 处理路径。

> 源码位置：`codex-rs/tui/src/app.rs:3945-4005`

### `handle_key_event(&mut self, tui: &mut Tui, app_server: &mut AppServerSession, key_event: KeyEvent)`

键盘事件路由器。按优先级匹配 agent 切换、Ctrl 组合键、backtrack 按键，未匹配的转发给 chat_widget。

> 源码位置：`codex-rs/tui/src/app.rs:5834-5969`

### `launch_external_editor(&mut self, tui: &mut Tui)`

异步启动外部编辑器。解析编辑器命令、临时恢复终端、运行编辑器子进程、回填编辑结果。

> 源码位置：`codex-rs/tui/src/app.rs:5771-5815`

### `request_external_editor_launch(&mut self, tui: &mut Tui)`

将外部编辑器状态设为 `Requested`，延迟到下一个 Draw 帧实际启动。

> 源码位置：`codex-rs/tui/src/app.rs:5817-5825`

### `reset_external_editor_state(&mut self, tui: &mut Tui)`

重置外部编辑器状态为 `Closed`，清除页脚提示。

> 源码位置：`codex-rs/tui/src/app.rs:5827-5832`

### `refresh_status_line(&mut self)`

委托 `chat_widget.refresh_status_line()` 刷新状态栏内容。在终端尺寸变化、分支切换、turn 开始等场景调用。

> 源码位置：`codex-rs/tui/src/app.rs:5972-5974`

### `spawn_world_writable_scan(cwd, env_map, logs_base_dir, sandbox_policy, tx)`

仅 Windows 平台可用。在 blocking 线程中执行 world-writable 目录扫描，扫描失败时发送警告确认事件。

> 源码位置：`codex-rs/tui/src/app.rs:5977-6002`

## 辅助函数

### `reasoning_label(reasoning_effort: Option<ReasoningEffortConfig>) -> &'static str`

将推理强度枚举映射为显示标签字符串：`minimal`、`low`、`medium`、`high`、`xhigh`、`default`。

> 源码位置：`codex-rs/tui/src/app.rs:5706-5715`

### `reasoning_label_for(model: &str, effort: Option<ReasoningEffortConfig>) -> Option<&'static str>`

仅当模型名称不以 `codex-auto-` 开头时返回推理标签，用于模型切换消息展示。

> 源码位置：`codex-rs/tui/src/app.rs:5717-5722`

### `personality_label(personality: Personality) -> &'static str`

将 `Personality` 枚举映射为 `"None"` / `"Friendly"` / `"Pragmatic"` 显示标签。

> 源码位置：`codex-rs/tui/src/app.rs:5763-5769`

### `sync_tui_theme_selection(&mut self, name: String)` / `restore_runtime_theme_from_config(&self)`

主题管理辅助：前者同步主题选择到 config 和 chat_widget；后者从 config 恢复运行时主题，失败时回退到自适应默认主题。

> 源码位置：`codex-rs/tui/src/app.rs:5740-5761`

## 边界 Case 与注意事项

- **Alt+b/f 的双重语义**：在不支持增强键盘报告的终端上，Alt+b/f 同时是词级光标移动和 agent 切换的快捷键。通过检查 `enhanced_keys_supported` 和 composer 是否为空来消歧——仅在 composer 为空时才触发 agent 切换
- **外部编辑器的两阶段启动**：`Ctrl+G` 不直接启动编辑器，而是先设为 `Requested` 状态，等到下一个 `Draw` 帧才转为 `Active` 并发送启动事件。这确保了在终端状态切换前完成当前帧的渲染
- **粘贴突发抑制**：`handle_paste_burst_tick()` 返回 `true` 时，`Draw` 处理提前返回，跳过本帧渲染。这是为了在快速连续粘贴时避免不必要的重绘开销
- **Backtrack 状态泄漏防护**：任何非 Esc 的按键都会重置 backtrack primed 状态（`codex-rs/tui/src/app.rs:5961-5963`），防止用户按 Esc 后又开始打字导致状态残留
- **`spawn_world_writable_scan` 仅在 Windows 上编译**：使用 `#[cfg(target_os = "windows")]` 条件编译，非 Windows 平台不包含此函数