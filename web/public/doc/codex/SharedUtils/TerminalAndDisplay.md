# 终端环境检测与 ANSI 渲染

## 概述与职责

本模块由两个独立的 Rust crate 组成，同属 SharedUtils 层，为 Codex 的 TUI、CLI 和遥测系统提供终端环境的基础能力：

- **`codex-terminal-detection`**：通过读取环境变量识别用户所使用的终端模拟器（Ghostty、iTerm2、WezTerm、kitty、VS Code、Alacritty、Konsole、GNOME Terminal 等）和终端复用器（tmux、zellij），生成结构化的 `TerminalInfo` 元数据，并可将其格式化为 User-Agent 令牌供 OpenTelemetry 日志使用。
- **`codex-ansi-escape`**：将包含 ANSI 转义序列的字符串转换为 ratatui 的 `Text`/`Line` 类型，用于 TUI 渲染，同时处理 Tab 字符的空格展开以避免视觉对齐问题。

在整体架构中，这两个 crate 是 SharedUtils 模块的一部分，与路径处理、PTY 管理、图像处理等其他公共工具 crate 并列，被 TUI、Core、Observability 等上层模块按需引用。

---

## codex-terminal-detection

### 关键流程

#### 终端检测流程

核心检测逻辑位于 `detect_terminal_info_from_env()` 函数（`codex-rs/terminal-detection/src/lib.rs:288-375`），按以下优先级顺序探测终端类型：

1. **检测终端复用器**：首先调用 `detect_multiplexer()` 检查 `TMUX`/`TMUX_PANE`（tmux）或 `ZELLIJ`/`ZELLIJ_SESSION_NAME`/`ZELLIJ_VERSION`（zellij）环境变量（`lib.rs:377-392`）
2. **`TERM_PROGRAM` 优先匹配**：如果设置了 `TERM_PROGRAM` 环境变量：
   - 若值为 `tmux` 且确实在 tmux 内运行，则通过 `tmux display-message` 获取底层终端的 `client_termtype` 和 `client_termname`，尝试识别 tmux 背后的真实终端（如 `ghostty 1.2.3`）
   - 否则，将 `TERM_PROGRAM` 值通过 `terminal_name_from_term_program()` 匹配到已知终端名称枚举
3. **终端特定环境变量探测**：依次检查 `WEZTERM_VERSION`、`ITERM_SESSION_ID`/`ITERM_PROFILE`、`TERM_SESSION_ID`（Apple Terminal）、`KITTY_WINDOW_ID`、`ALACRITTY_SOCKET`、`KONSOLE_VERSION`、`GNOME_TERMINAL_SCREEN`、`VTE_VERSION`、`WT_SESSION`
4. **`TERM` 兜底**：使用 `TERM` 环境变量的值（如 `xterm-256color`），其中 `dumb` 被标记为 `TerminalName::Dumb`
5. **未知终端**：以上都未匹配则返回 `TerminalName::Unknown`

#### tmux 底层终端穿透

当 `TERM_PROGRAM=tmux` 时，检测系统不会简单报告 "tmux"，而是尝试穿透到实际的底层终端（`lib.rs:292-298`）：

1. 调用 `tmux display-message -p "#{client_termtype}"` 获取客户端终端类型（可能带版本，如 `ghostty 1.2.3`）
2. 调用 `tmux display-message -p "#{client_termname}"` 获取客户端 TERM 能力字符串（如 `xterm-ghostty`）
3. `split_term_program_and_version()` 按空格拆分 termtype 为程序名和版本号（`lib.rs:431-436`）
4. 将拆分后的程序名匹配到 `TerminalName` 枚举

#### User-Agent 令牌生成

`user_agent_token()` 方法（`lib.rs:174-206`）按以下优先级生成标识字符串：

1. 如有 `term_program` 字段，输出 `{program}/{version}` 或 `{program}`
2. 否则使用 `term` 字段值
3. 最后根据 `TerminalName` 枚举生成默认标识

生成结果会通过 `sanitize_header_value()` 将非法 HTTP 头字符替换为下划线，仅保留字母数字和 `-_./`（`lib.rs:462-469`）。

### 类型定义

#### `TerminalInfo`

主要的结构化检测结果（`lib.rs:10-21`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `TerminalName` | 检测到的终端名称枚举 |
| `term_program` | `Option<String>` | `TERM_PROGRAM` 环境变量的原始值 |
| `version` | `Option<String>` | 终端版本字符串 |
| `term` | `Option<String>` | `TERM` 能力字符串（兜底使用） |
| `multiplexer` | `Option<Multiplexer>` | 终端复用器信息 |

#### `TerminalName`

已知终端类型枚举（`lib.rs:25-54`），涵盖 14 种变体：`AppleTerminal`、`Ghostty`、`Iterm2`、`WarpTerminal`、`VsCode`、`WezTerm`、`Kitty`、`Alacritty`、`Konsole`、`GnomeTerminal`、`Vte`、`WindowsTerminal`、`Dumb`、`Unknown`。

#### `Multiplexer`

终端复用器枚举（`lib.rs:58-68`）：

- `Tmux { version: Option<String> }`：tmux，版本号从 `TERM_PROGRAM_VERSION` 获取（仅当 `TERM_PROGRAM=tmux` 时）
- `Zellij {}`：zellij

### 函数签名

#### `pub fn terminal_info() -> TerminalInfo`

返回当前进程的终端元数据。结果通过 `OnceLock` 缓存，全局只检测一次（`lib.rs:268-272`）。

#### `pub fn user_agent() -> String`

返回经过净化的 User-Agent 令牌字符串，供 HTTP 头使用（`lib.rs:263-265`）。

#### `pub fn is_zellij(&self) -> bool`

`TerminalInfo` 的方法，判断当前是否处于 zellij 复用器内（`lib.rs:209-211`）。

### 终端名称匹配规则

`terminal_name_from_term_program()` 在匹配前会对输入做标准化处理（`lib.rs:471-495`）：去除空格、连字符、下划线和点号，然后全部转为小写。因此 `iTerm.app`、`iterm2`、`iTerm` 都能正确匹配到 `TerminalName::Iterm2`。

### 边界 Case 与注意事项

- **`TERM_PROGRAM` 遮蔽效应**：`TERM_PROGRAM` 的检测优先级最高，如果它被设为某个值，后续的终端特定变量（如 `WT_SESSION`）不会被检查。这意味着 `TERM_PROGRAM=vscode` 会遮蔽 `WEZTERM_VERSION`
- **kitty 优先于 Alacritty**：当 `TERM` 包含 `kitty` 时（如 `xterm-kitty`），即使 `ALACRITTY_SOCKET` 也存在，仍然识别为 kitty
- **tmux 版本获取**：tmux 自身的版本号只在 `TERM_PROGRAM=tmux` 时从 `TERM_PROGRAM_VERSION` 读取；底层终端的版本则从 `tmux display-message` 的 `client_termtype` 中按空格拆分获取
- **非 UTF-8 环境变量**：读取到非 UTF-8 值时记录 warning 并视为未设置
- **空白值过滤**：所有环境变量值经过 `none_if_whitespace()` 过滤，纯空白字符串视为未设置

---

## codex-ansi-escape

### 关键流程

该 crate 提供两个公开函数，将 ANSI 转义序列文本转为 ratatui TUI 框架的富文本类型：

1. 输入文本首先经过 `expand_tabs()` 进行 Tab 展开——每个 `\t` 替换为 4 个空格（`codex-rs/ansi-escape/src/lib.rs:11-21`）
2. 调用 `ansi-to-tui` 库的 `IntoText` trait 将 ANSI 转义序列解析为 ratatui 的 `Text` 类型
3. 解析失败时直接 panic（`NomError` 和 `Utf8Error` 被视为不应发生的致命错误）

### 函数签名

#### `pub fn ansi_escape_line(s: &str) -> Line<'static>`

将一行包含 ANSI 转义序列的字符串转为 ratatui `Line`（`lib.rs:26-38`）。

- 先展开 Tab 字符
- 如果解析结果包含多行，记录 warning 并只返回第一行
- 空输入返回空 `Line`

#### `pub fn ansi_escape(s: &str) -> Text<'static>`

将包含 ANSI 转义序列的字符串转为 ratatui `Text`（多行）（`lib.rs:40-58`）。

- 不进行 Tab 展开（仅 `ansi_escape_line` 展开）
- 解析错误直接 panic

### 边界 Case 与注意事项

- **Tab 展开仅在 `ansi_escape_line` 中生效**：`ansi_escape()` 不做 Tab 展开，调用方如需此行为需自行处理
- **固定 4 空格展开**：不尝试对齐到制表位（tab stops），因为跨 ANSI span 的有状态计算复杂度不划算，4 空格对大多数场景已经足够
- **解析错误 panic**：`ansi-to-tui` 的 `NomError` 和 `Utf8Error` 被视为"不应发生"的情况，直接 panic 而非优雅降级
- **所有权转移**：返回的 `Text<'static>` 和 `Line<'static>` 持有 owned 数据，不保留对输入字符串的引用