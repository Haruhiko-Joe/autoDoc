# SharedUtilities — TUI 共享工具模块

## 概述与职责

SharedUtilities 是 TUI（终端用户界面）内部的共享工具层，汇聚了二十余个小型模块，为 TUI 的各个交互组件提供基础能力支撑。这些工具覆盖了颜色计算、样式生成、键盘快捷键提示、动画效果、剪贴板读写、@-mention 编解码、语音采集/播放、文件搜索管理、会话日志、Git diff 获取、命令解析、斜杠命令定义、技能辅助、附加目录管理、版本常量、外部编辑器集成、调试配置输出、UI 布局常量，以及供外部 crate 复用的 `public_widgets` 接口。

在整体架构中，SharedUtilities 位于 **TUI** 模块内部，被各种 UI 组件（聊天编辑器、历史面板、弹窗等）横向引用。TUI 本身通过调用 **Core** 驱动 Agent 会话，并依赖 **Config** 和 **Auth** 获取配置与认证状态。

---

## 模块索引

| 模块文件 | 主要职责 |
|---------|---------|
| `color.rs` | RGB 颜色工具：亮度判断、Alpha 混合、感知距离 |
| `style.rs` | 基于终端背景色生成 ratatui `Style` |
| `tooltips.rs` | 启动提示语选取与远程公告获取 |
| `shimmer.rs` | 文字微光扫描动画效果 |
| `ascii_animation.rs` | ASCII 帧动画驱动器 |
| `key_hint.rs` | 键绑定定义与快捷键提示格式化 |
| `ui_consts.rs` | UI 布局常量 |
| `clipboard_paste.rs` | 剪贴板图片粘贴与路径规范化 |
| `clipboard_text.rs` | 剪贴板文本复制（含 SSH/WSL 回退） |
| `mention_codec.rs` | @-mention 编解码（Markdown 链接格式 ↔ 可见文本） |
| `voice.rs` | 实时语音采集与音频播放 |
| `audio_device.rs` | 音频设备枚举与选择 |
| `file_search.rs` | `@` 文件搜索的会话管理器 |
| `session_log.rs` | JSONL 格式的会话事件日志 |
| `get_git_diff.rs` | 异步获取 Git 工作区差异 |
| `exec_command.rs` | 命令字符串转义、拆分与路径相对化 |
| `slash_command.rs` | 斜杠命令枚举及元信息 |
| `skills_helpers.rs` | 技能显示名、描述、模糊匹配 |
| `additional_dirs.rs` | `--add-dir` 与沙箱策略兼容性检查 |
| `version.rs` | 编译期版本常量 |
| `external_editor.rs` | 外部编辑器解析与启动 |
| `debug_config.rs` | `/debug-config` 配置层可视化 |
| `public_widgets/` | 对外暴露的可复用组件（`ComposerInput`） |
| `bin/md-events.rs` | Markdown 事件调试小工具 |

---

## 关键流程 Walkthrough

### 1. 颜色与样式计算

`color.rs` 提供三个纯函数：

- **`is_light(bg)`**：使用 ITU-R BT.601 亮度公式判断背景色是否为浅色（`codex-rs/tui/src/color.rs:1-5`）。
- **`blend(fg, bg, alpha)`**：对前景色和背景色进行线性 Alpha 混合（`codex-rs/tui/src/color.rs:7-12`）。
- **`perceptual_distance(a, b)`**：将 sRGB 转为 CIE Lab 色彩空间，计算两色的感知距离（CIE76 公式）（`codex-rs/tui/src/color.rs:14-75`）。

`style.rs` 在此之上构建面向 UI 的样式：根据终端检测到的背景色，对浅色背景叠加 4% 黑色、对深色背景叠加 12% 白色，生成用户消息和 Proposed Plan 的背景色。调用链为 `user_message_style()` → `default_bg()` → `is_light()` → `blend()` → `best_color()`（`codex-rs/tui/src/style.rs:8-44`）。

### 2. Shimmer 微光动画

`shimmer_spans()` 接收一段文本，返回逐字符着色的 `Vec<Span>`。核心思路：

1. 以进程启动时间为基准，计算一个 2 秒周期的扫描位置 `pos`（`codex-rs/tui/src/shimmer.rs:27-32`）
2. 对每个字符计算到扫描中心的距离，用余弦函数生成高亮强度 `t`（半宽 5 字符）
3. 若终端支持 True Color，通过 `blend()` 在默认前景和背景之间插值；否则退化为 DIM / 普通 / BOLD 三档

### 3. 剪贴板操作

**图片粘贴** (`clipboard_paste.rs`)：
1. 通过 `arboard` 库尝试读取系统剪贴板的文件列表或图片数据
2. 编码为 PNG 写入临时文件
3. 在 Linux/WSL 环境下，如果 `arboard` 失败，回退到调用 `powershell.exe` 通过 PowerShell 的 `Get-Clipboard -Format Image` 获取

**文本复制** (`clipboard_text.rs`)：
1. 检测 SSH 环境（`SSH_CONNECTION` / `SSH_TTY`）→ 使用 OSC 52 转义序列
2. 否则尝试 `arboard` 原生剪贴板
3. 在 WSL 下 `arboard` 失败时回退到 `powershell.exe Set-Clipboard`

> 源码位置：`codex-rs/tui/src/clipboard_text.rs:56-80`

### 4. @-mention 编解码

`mention_codec.rs` 在历史记录的 Markdown 持久化格式和 UI 可见文本之间转换：

- **编码** (`encode_history_mentions`)：将 `$figma` + 关联路径转为 `[$figma](app://figma-app)` 链接格式
- **解码** (`decode_history_mentions`)：将链接格式还原为可见的 `$figma` 文本，同时提取出 `LinkedMention` 列表

识别规则：sigil 字符为 `$`（工具 mention）或 `@`（插件 mention），路径必须以 `app://`、`mcp://`、`plugin://`、`skill://` 开头或以 `SKILL.md` 结尾。同时排除常见环境变量名（如 `$PATH`、`$HOME`）以避免误匹配（`codex-rs/tui/src/mention_codec.rs:193-209`）。

### 5. 语音采集与播放

**VoiceCapture**（`voice.rs`）：
1. `start_realtime()` 通过 `audio_device.rs` 选择麦克风设备和流配置
2. 构建 `cpal` 输入流，在回调中将采样数据转为 16-bit PCM、重采样到 24kHz 单声道
3. Base64 编码后通过 `AppEventSender` 发送 `ConversationAudioParams` 给 Agent Core

**RealtimeAudioPlayer**（`voice.rs:283-347`）：
1. `start()` 打开输出设备，创建一个 `Arc<Mutex<VecDeque<i16>>>` 作为播放队列
2. `enqueue_frame()` 解码模型返回的 Base64 PCM，重采样到输出设备参数后入队
3. 输出流回调从队列逐样本取数据填充播放缓冲区

**RecordingMeterState** 提供录音电平指示：使用指数移动平均 (EMA) 计算噪声基线，对数压缩后映射到 braille 字符序列 `['⠤', '⠴', '⠶', '⠷', '⡷', '⡿', '⣿']`。

### 6. 文件搜索管理

`FileSearchManager` 为聊天编辑器中的 `@` 补全提供搜索能力：

1. 用户每次编辑 `@token` 时调用 `on_user_query()`
2. 首次非空查询时，通过 `codex-file-search` crate 创建搜索会话
3. 搜索结果通过 `TuiSessionReporter` → `AppEventSender` → `AppEvent::FileSearchResult` 异步推回 UI
4. 使用 `session_token` 防止已过期会话的结果被误发送

> 源码位置：`codex-rs/tui/src/file_search.rs:16-100`

### 7. 斜杠命令系统

`SlashCommand` 是一个通过 `strum` 宏派生的枚举，定义了 40+ 个用户可用的 `/` 命令。每个变体携带：
- `description()` — 在弹出菜单中显示的说明
- `supports_inline_args()` — 是否接受行内参数（如 `/review <text>`）
- `available_during_task()` — 任务执行期间是否可用
- `is_visible()` — 是否根据平台/构建模式可见

`built_in_slash_commands()` 返回所有可见命令的 `(command_str, SlashCommand)` 列表。

---

## 函数签名与参数说明

### color.rs

```rust
pub(crate) fn is_light(bg: (u8, u8, u8)) -> bool
pub(crate) fn blend(fg: (u8, u8, u8), bg: (u8, u8, u8), alpha: f32) -> (u8, u8, u8)
pub(crate) fn perceptual_distance(a: (u8, u8, u8), b: (u8, u8, u8)) -> f32
```

### clipboard_text.rs

```rust
pub fn copy_text_to_clipboard(text: &str) -> Result<(), String>
```
- 返回的 `Err(String)` 为用户可读的错误信息，直接显示在 TUI 中

### get_git_diff.rs

```rust
pub(crate) async fn get_git_diff() -> io::Result<(bool, String)>
```
- 返回 `(is_git_repo, diff_text)`；非 Git 仓库时返回 `(false, "")`

### exec_command.rs

```rust
pub(crate) fn escape_command(command: &[String]) -> String
pub(crate) fn strip_bash_lc_and_escape(command: &[String]) -> String
pub(crate) fn split_command_string(command: &str) -> Vec<String>
pub(crate) fn relativize_to_home<P: AsRef<Path>>(path: P) -> Option<PathBuf>
```

### external_editor.rs

```rust
pub(crate) fn resolve_editor_command() -> Result<Vec<String>, EditorError>
pub(crate) async fn run_editor(seed: &str, editor_cmd: &[String]) -> Result<String>
```
- `resolve_editor_command()` 优先读取 `VISUAL`，其次 `EDITOR`
- `run_editor()` 将 seed 写入临时 `.md` 文件，启动编辑器，返回编辑后的内容

---

## 接口/类型定义

### KeyBinding (`key_hint.rs`)

```rust
pub(crate) struct KeyBinding {
    key: KeyCode,
    modifiers: KeyModifiers,
}
```

辅助构造函数：`plain(key)`, `alt(key)`, `shift(key)`, `ctrl(key)`, `ctrl_alt(key)`。实现了 `From<KeyBinding> for Span<'static>`，可直接转为带样式的 ratatui 渲染单元。

### PasteImageError / PastedImageInfo (`clipboard_paste.rs`)

| 类型 | 说明 |
|------|------|
| `PasteImageError::ClipboardUnavailable(String)` | 无法访问系统剪贴板 |
| `PasteImageError::NoImage(String)` | 剪贴板中没有图片 |
| `PasteImageError::EncodeFailed(String)` | PNG 编码失败 |
| `PasteImageError::IoError(String)` | 文件 IO 错误 |
| `PastedImageInfo { width, height, encoded_format }` | 粘贴图片的元信息 |
| `EncodedImageFormat` | `Png` / `Jpeg` / `Other` |

### LinkedMention / DecodedHistoryText (`mention_codec.rs`)

```rust
pub(crate) struct LinkedMention {
    pub mention: String,  // e.g. "figma"
    pub path: String,     // e.g. "app://figma-1"
}

pub(crate) struct DecodedHistoryText {
    pub text: String,               // 还原后的可见文本
    pub mentions: Vec<LinkedMention>, // 提取出的 mention 列表
}
```

### ComposerInput (`public_widgets/composer_input.rs`)

对外暴露的可复用文本输入组件，封装了内部 `ChatComposer`，供其他 crate（如 `codex-cloud-tasks`）使用。

```rust
pub struct ComposerInput { ... }

pub enum ComposerAction {
    Submitted(String),  // 用户按 Enter 提交
    None,               // 无提交
}
```

主要方法：`new()`, `input(KeyEvent)`, `handle_paste(String)`, `render_ref(Rect, &mut Buffer)`, `desired_height(u16)`, `cursor_pos(Rect)`。

---

## 配置项与默认值

| 配置项 / 环境变量 | 用途 | 默认值 |
|---|---|---|
| `CODEX_TUI_RECORD_SESSION` | 启用会话日志记录 | `false`（需设为 `1`/`true`/`yes`） |
| `CODEX_TUI_SESSION_LOG_PATH` | 自定义日志文件路径 | `<log_dir>/session-<timestamp>.jsonl` |
| `VISUAL` / `EDITOR` | 外部编辑器命令 | 无（缺失时返回 `EditorError::MissingEditor`） |
| `config.realtime_audio.microphone` | 指定麦克风设备名称 | 系统默认输入设备 |
| `config.realtime_audio.speaker` | 指定扬声器设备名称 | 系统默认输出设备 |

### UI 布局常量 (`ui_consts.rs`)

| 常量 | 值 | 说明 |
|------|---|------|
| `LIVE_PREFIX_COLS` | `2` | 左侧 gutter 预留列数（`u16`） |
| `FOOTER_INDENT_COLS` | `2` | 底部状态行缩进列数（`usize`） |

### 音频常量 (`voice.rs` / `audio_device.rs`)

| 常量 | 值 | 说明 |
|------|---|------|
| `MODEL_AUDIO_SAMPLE_RATE` | 24,000 Hz | 模型端要求的采样率 |
| `MODEL_AUDIO_CHANNELS` | 1 | 模型端要求的声道数 |
| `PREFERRED_INPUT_SAMPLE_RATE` | 24,000 Hz | 输入设备优选采样率 |

### 版本常量 (`version.rs`)

```rust
pub const CODEX_CLI_VERSION: &str = env!("CARGO_PKG_VERSION");
```
编译期从 `Cargo.toml` 读取版本号。

---

## 边界 Case 与注意事项

- **Android 平台**：`clipboard_paste.rs` 和 `clipboard_text.rs` 在 Android 上直接返回不可用错误，因为 `arboard` 不支持该平台。
- **WSL 环境**：剪贴板操作的 WSL 回退依赖 `powershell.exe` 可达性；`is_probably_wsl()` 通过读取 `/proc/version` 和检查环境变量 `WSL_DISTRO_NAME` / `WSL_INTEROP` 双重判断。
- **SSH 剪贴板**：在 SSH 会话中，文本复制通过 OSC 52 转义序列实现，需要终端模拟器支持该协议。在 `tmux` 下自动包裹为 passthrough 形式。
- **快捷键前缀的平台差异**：`key_hint.rs` 中 `ALT_PREFIX` 在 macOS 上显示为 `⌥ + `，其他平台显示为 `alt + `。Windows 下的 AltGr 键（同时按下 Ctrl+Alt）被排除在 `has_ctrl_or_alt()` 判断之外（`codex-rs/tui/src/key_hint.rs:102-112`）。
- **Git diff**：`get_git_diff()` 将 `git diff` 退出码 1 视为成功（表示存在差异），而非错误。非 Git 仓库或 `git` 未安装时安全降级为空结果。
- **Tooltip 远程公告**：`tooltips.rs` 在后台线程预热远程公告（从 GitHub 拉取 TOML 配置），超时 2 秒，使用 `no_proxy()` 避免 macOS 系统代理检测导致的 panic（issue #8912）。
- **会话日志权限**：在 Unix 上，日志文件以 `0o600` 权限创建，仅当前用户可读写。
- **`--add-dir` 与沙箱**：在 `ReadOnly` 沙箱模式下，`additional_dirs.rs` 会生成警告信息，告知用户附加目录将被忽略。
- **`split_command_string` 保守策略**：当 `shlex` 拆分后无法 round-trip 还原（常见于 Windows 路径），直接将整个字符串作为单元素返回，避免破坏命令（`codex-rs/tui/src/exec_command.rs:19-33`）。
- **`bin/md-events.rs`**：一个独立的调试二进制，从 stdin 读取 Markdown 并打印 `pulldown_cmark` 解析事件，不属于 TUI 运行时。