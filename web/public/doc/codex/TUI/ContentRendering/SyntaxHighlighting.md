# 语法高亮引擎（SyntaxHighlighting）

## 概述与职责

语法高亮引擎是 TUI 内容渲染管线（ContentRendering）的核心组件，负责将代码文本转换为带有样式的 ratatui `Line` 序列，供 Markdown 渲染器和 diff 渲染器消费。

该模块基于 [syntect](https://docs.rs/syntect) 解析引擎和 [two_face](https://docs.rs/two_face) 语法/主题捆绑包构建，开箱即支持约 250 种编程语言和 32 款内置配色主题。同时支持用户自定义 `.tmTheme` 文件加载。

在整体架构中，本模块位于 **TUI → ContentRendering** 层级下，被 Markdown 渲染器（围栏代码块高亮）、diff 渲染器（语法着色叠加在 diff 上）和 exec cell（bash 命令预览）共同调用。

## 关键流程

### 1. 初始化与主题配置流程

模块通过四个进程级全局单例管理状态：

| 单例 | 类型 | 用途 |
|------|------|------|
| `SYNTAX_SET` | `OnceLock<SyntaxSet>` | 语法数据库（~250 语言），初始化后不可变 |
| `THEME` | `OnceLock<RwLock<Theme>>` | 活跃的配色主题，运行时可热切换 |
| `THEME_OVERRIDE` | `OnceLock<Option<String>>` | 用户持久化的主题偏好（一次写入） |
| `CODEX_HOME` | `OnceLock<Option<PathBuf>>` | 自定义 `.tmTheme` 文件发现路径 |

> 源码位置：`codex-rs/tui/src/render/highlight.rs:48-51`

**启动时序**：

1. 应用启动后，在最终配置解析完毕时调用 `set_theme_override(name, codex_home)` 一次
2. 该函数将用户偏好和 CODEX_HOME 写入 `OnceLock`，并验证主题名称有效性
3. 首次调用 `theme_lock()` 时，延迟初始化 `THEME` 单例——通过 `build_default_theme()` 解析用户偏好或自适应选择默认主题
4. 之后可通过 `set_syntax_theme()` / `current_syntax_theme()` 实现实时主题预览和恢复

### 2. 主题解析优先级

`resolve_theme_with_override()` 按以下优先级解析主题名称（`codex-rs/tui/src/render/highlight.rs:205-224`）：

1. **内置主题**：通过 `parse_theme_name()` 将 kebab-case 名称（如 `"catppuccin-mocha"`）映射到 `EmbeddedThemeName` 枚举
2. **自定义主题**：在 `{CODEX_HOME}/themes/{name}.tmTheme` 路径查找 TextMate 主题文件
3. **自适应默认**：如果均未命中，根据终端背景亮度自动选择——亮色背景用 `catppuccin-latte`，暗色背景用 `catppuccin-mocha`

> 自适应检测逻辑：`codex-rs/tui/src/render/highlight.rs:184-191`

### 3. 代码高亮核心流程

以 `highlight_code_to_lines(code, lang)` 为入口（`codex-rs/tui/src/render/highlight.rs:634-648`）：

1. **限流检查**：输入超过 512 KB 或 10,000 行时直接返回 `None`，触发无样式回退
2. **语法查找**：`find_syntax(lang)` 在 two_face 扩展语法集中查找匹配的语言定义（支持 token、名称、大小写不敏感匹配、扩展名）
3. **逐行高亮**：使用 `HighlightLines` 逐行解析，通过 `LinesWithEndings` 保留行尾语义
4. **样式转换**：每个高亮区间的 syntect `Style` 经 `convert_style()` 转为 ratatui `Style`
5. **行尾清理**：剥离 `\n` 和 `\r`（兼容 CRLF 输入），由调用方控制换行
6. **空行处理**：空 span 列表补一个 `Span::raw("")` 确保每行至少有一个 span
7. **回退路径**：未识别语言或超限时，用 `code.lines()` 生成纯文本 `Line`（避免尾部 `\n` 产生幽灵空行）

### 4. ANSI 调色板语义转换

syntect/bat 系主题通过 alpha 通道编码 ANSI 语义，`convert_syntect_color()` 负责解码（`codex-rs/tui/src/render/highlight.rs:465-476`）：

| Alpha 值 | 含义 | 转换结果 |
|-----------|------|----------|
| `0x00` | `r` 字段存储 ANSI 调色板索引（非 RGB） | `ansi_palette_color(r)` → 命名颜色或 `Indexed(n)` |
| `0x01` | 使用终端默认前景/背景色 | `None`（省略颜色属性） |
| `0xFF` | 标准不透明 RGB | `Rgb(r, g, b)` |
| 其他 | 某些主题的非标准 alpha | 降级为 `Rgb(r, g, b)` |

对于低索引（0-7），`ansi_palette_color()` 映射到 ratatui 命名颜色变体（`Black`、`Red`、`Green` 等），因为许多终端对命名颜色和 `Indexed(0)`..`Indexed(7)` 的粗体/高亮处理不同。

> 注意：ANSI 索引 7（白色）映射为 `RtColor::Gray`，这是 ratatui 的命名约定。

## 函数签名与参数说明

### 公开 API

#### `highlight_code_to_lines(code: &str, lang: &str) -> Vec<Line<'static>>`

主入口函数。将任意语言代码高亮为 ratatui `Line` 列表。未识别语言或超限时自动回退为纯文本——调用方无需关心错误处理。

> 源码位置：`codex-rs/tui/src/render/highlight.rs:634-648`

#### `highlight_bash_to_lines(script: &str) -> Vec<Line<'static>>`

Bash 脚本的便捷包装，等价于 `highlight_code_to_lines(script, "bash")`。用于 exec cell 命令预览。

> 源码位置：`codex-rs/tui/src/render/highlight.rs:651-653`

#### `highlight_code_to_styled_spans(code: &str, lang: &str) -> Option<Vec<Vec<Span<'static>>>>`

为 diff 渲染器提供逐行 span 向量。返回 `None` 时 diff 渲染器回退为纯 diff 着色。背景色被有意省略，让终端自身背景透出。

> 源码位置：`codex-rs/tui/src/render/highlight.rs:664-669`

### 主题管理 API

#### `set_theme_override(name: Option<String>, codex_home: Option<PathBuf>) -> Option<String>`

启动时调用一次，持久化用户主题偏好。返回 `Option<String>` 形式的用户可读警告（主题未找到、tmTheme 格式无效等）。后续调用不会更改 `OnceLock` 值，但仍会即时更新运行时主题。

> 源码位置：`codex-rs/tui/src/render/highlight.rs:81-101`

#### `set_syntax_theme(theme: Theme)`

运行时热切换活跃主题（用于主题选择器实时预览）。使用 `RwLock` 写锁，对 poisoned 锁做了恢复处理。

> 源码位置：`codex-rs/tui/src/render/highlight.rs:241-247`

#### `current_syntax_theme() -> Theme`

克隆当前活跃主题。典型用途：在打开主题选择器前保存快照，取消时恢复。

> 源码位置：`codex-rs/tui/src/render/highlight.rs:250-255`

#### `configured_theme_name() -> String`

返回用户配置的主题名称（仅当它能成功解析时），否则返回自适应默认主题名。反映持久化配置而非运行时临时切换。

> 源码位置：`codex-rs/tui/src/render/highlight.rs:306-319`

#### `validate_theme_name(name: Option<&str>, codex_home: Option<&Path>) -> Option<String>`

纯验证函数——检查主题名能否解析为内置或自定义主题，不合法时返回用户可读提示信息。

> 源码位置：`codex-rs/tui/src/render/highlight.rs:105-133`

#### `resolve_theme_by_name(name: &str, codex_home: Option<&Path>) -> Option<Theme>`

按名称解析主题对象。先查内置主题，再查自定义 `.tmTheme` 文件。

> 源码位置：`codex-rs/tui/src/render/highlight.rs:323-336`

#### `list_available_themes(codex_home: Option<&Path>) -> Vec<ThemeEntry>`

枚举所有可用主题（32 个内置 + 自定义），返回排序、去重后的列表。自定义主题通过扫描 `{codex_home}/themes/` 目录发现，仅包含能被 syntect 成功解析的 `.tmTheme` 文件。

> 源码位置：`codex-rs/tui/src/render/highlight.rs:350-386`

#### `diff_scope_background_rgbs() -> DiffScopeBackgroundRgbs`

从活跃主题中提取 diff 背景色（`markup.inserted`/`markup.deleted` 或回退到 `diff.inserted`/`diff.deleted` 作用域）。返回的是原始 RGB 元组，由 diff 渲染器根据终端色深做后续量化。

> 源码位置：`codex-rs/tui/src/render/highlight.rs:278-281`

#### `exceeds_highlight_limits(total_bytes: usize, total_lines: usize) -> bool`

公开的限流预检函数。逐行高亮场景（如 diff 渲染）可在开始前用总量预检，避免循环中逐段检查的开销。

> 源码位置：`codex-rs/tui/src/render/highlight.rs:559-561`

## 接口/类型定义

### `DiffScopeBackgroundRgbs`

```rust
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct DiffScopeBackgroundRgbs {
    pub inserted: Option<(u8, u8, u8)>,
    pub deleted: Option<(u8, u8, u8)>,
}
```

承载从主题作用域提取的 diff 背景 RGB 值。`None` 表示主题未定义对应作用域，diff 渲染器应使用硬编码回退色。

> 源码位置：`codex-rs/tui/src/render/highlight.rs:267-271`

### `ThemeEntry`

```rust
pub(crate) struct ThemeEntry {
    pub name: String,
    pub is_custom: bool,
}
```

主题选择器列表项。`is_custom` 标记是否来自磁盘自定义文件。

> 源码位置：`codex-rs/tui/src/render/highlight.rs:340-346`

## 配置项与默认值

| 配置 | 来源 | 默认行为 |
|------|------|----------|
| 主题名称 | 通过 `set_theme_override` 传入的用户配置 | 自适应选择：亮色终端 → `catppuccin-latte`，暗色终端 → `catppuccin-mocha` |
| CODEX_HOME | 通过 `set_theme_override` 传入的路径 | 未设置时不扫描自定义主题 |
| 自定义主题路径 | `{CODEX_HOME}/themes/{name}.tmTheme` | — |
| 高亮字节上限 | `MAX_HIGHLIGHT_BYTES` | 512 KB |
| 高亮行数上限 | `MAX_HIGHLIGHT_LINES` | 10,000 行 |

## 语言查找与别名

`find_syntax()` 在 two_face 扩展语法集中查找语言时，按以下顺序尝试（`codex-rs/tui/src/render/highlight.rs:509-543`）：

1. 先进行**别名修正**：`csharp`/`c-sharp` → `c#`，`golang` → `go`，`python3` → `python`，`shell` → `bash`
2. `find_syntax_by_token()`——按文件扩展名大小写不敏感匹配
3. `find_syntax_by_name()`——按语法名称精确匹配
4. 大小写不敏感的语法名称遍历（如 `"rust"` → `"Rust"`）
5. `find_syntax_by_extension()`——用原始输入作为文件扩展名尝试

## 边界 Case 与注意事项

- **背景色有意忽略**：`convert_style()` 跳过 syntect 背景色，避免覆盖终端自身背景（`codex-rs/tui/src/render/highlight.rs:488-490`）
- **斜体和下划线被抑制**：许多终端对斜体支持不佳；Dracula 等主题在类型名上加下划线，在终端中效果差。仅保留粗体修饰符（`codex-rs/tui/src/render/highlight.rs:495-498`）
- **CRLF 兼容**：行尾同时剥离 `\n` 和 `\r`，避免 Windows 风格换行留下的孤立 `\r`
- **空输入处理**：空字符串直接走回退路径，产生一个包含空字符串的 `Line`
- **尾部换行**：回退路径使用 `lines()` 而非 `split('\n')`，避免 pulldown-cmark 输出的尾部 `\n` 产生幽灵空行
- **RwLock poisoned 恢复**：`set_syntax_theme()` 和 `current_syntax_theme()` 对 poisoned 锁使用 `into_inner()` 恢复，确保单个 panic 不会永久阻塞主题切换
- **`set_theme_override` 幂等性**：底层 `OnceLock` 保证持久化值只写一次，但运行时主题仍会被后续调用更新（`codex-rs/tui/src/render/highlight.rs:94-99`）
- **内置主题列表**：32 个主题名硬编码在 `BUILTIN_THEME_NAMES` 常量中（`codex-rs/tui/src/render/highlight.rs:389-422`），`parse_theme_name()` 的 match 分支与其一一对应