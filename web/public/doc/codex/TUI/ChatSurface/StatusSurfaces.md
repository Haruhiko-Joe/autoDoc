# StatusSurfaces — 状态行与终端标题渲染

## 概述与职责

StatusSurfaces 模块是 TUI 层 ChatSurface 组件的子模块，负责管理 Codex 终端界面中的两个实时信息展示面：**底部状态行（status line）** 和 **终端标题栏（terminal title）**。此外还包含一个轻量的 **SessionHeader** 结构体，用于追踪会话显示的模型名称。

在 TUI 的整体架构中，ChatSurface 是主聊天视口组件，StatusSurfaces 则为其提供状态信息的解析、渲染和刷新能力。该模块解决的核心问题是：如何高效地将运行时状态（当前模型、推理强度、上下文剩余、Git 分支、任务进度等）映射到用户可配置的信息展示位，同时避免重复的文件系统查询和冗余的终端 OSC 写入。

代码分布在两个文件中：
- `codex-rs/tui/src/chatwidget/status_surfaces.rs`（~663 行）：核心逻辑
- `codex-rs/tui/src/chatwidget/session_header.rs`（~17 行）：SessionHeader 结构体

## 关键流程

### 统一刷新流程（`refresh_status_surfaces`）

这是状态展示面的核心入口方法，每帧或状态变化时被调用：

1. **解析配置**：调用 `status_surface_selections()` 一次性解析状态行和终端标题的配置项列表，将字符串 ID 转换为枚举值，同时收集无效 ID（`codex-rs/tui/src/chatwidget/status_surfaces.rs:68-78`）
2. **发出无效项警告**：对无效的配置 ID 发出一次性警告，使用 `compare_exchange` 原子操作确保每类警告仅触发一次（`codex-rs/tui/src/chatwidget/status_surfaces.rs:80-120`）
3. **同步共享状态**：检查是否有任何展示面需要 Git 分支信息，若需要则触发异步分支查询；若不需要则清理缓存（`codex-rs/tui/src/chatwidget/status_surfaces.rs:122-135`）
4. **渲染状态行**：遍历已解析的状态行项目，逐项求值，用 ` · ` 分隔符拼接为最终显示行（`codex-rs/tui/src/chatwidget/status_surfaces.rs:137-158`）
5. **渲染终端标题**：遍历终端标题项目，逐项求值，根据项目类型使用不同分隔符（spinner 用空格，其他用 ` | `），通过 OSC 转义序列写入终端标题栏（`codex-rs/tui/src/chatwidget/status_surfaces.rs:181-240`）

### Git 分支异步查询

分支查询是一个典型的异步状态获取流程：

1. `sync_status_line_branch_state()` 检测工作目录是否变化，变化时重置缓存（`codex-rs/tui/src/chatwidget/status_surfaces.rs:386-398`）
2. `request_status_line_branch()` 通过 `tokio::spawn` 发起异步查询，设置 `pending` 标志防止重复请求（`codex-rs/tui/src/chatwidget/status_surfaces.rs:404-414`）
3. 查询结果通过 `AppEvent::StatusLineBranchUpdated` 事件回传，携带 cwd 用于过期检测

### 终端标题 spinner 动画

模块定义了一套 10 帧的 braille 点阵 spinner（`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`），以 100ms 间隔轮播：

1. `terminal_title_has_active_progress()` 判断是否存在活跃任务（MCP 启动中、任务运行中、或正在撤销）（`codex-rs/tui/src/chatwidget/status_surfaces.rs:594-598`）
2. `terminal_title_spinner_frame_at()` 根据时间戳计算当前帧索引（`codex-rs/tui/src/chatwidget/status_surfaces.rs:580-585`）
3. 渲染后通过 `frame_requester.schedule_frame_in()` 预约下一帧刷新

## 核心类型定义

### `TerminalTitleStatusKind`

终端标题中显示的紧凑运行状态枚举（`codex-rs/tui/src/chatwidget/status_surfaces.rs:24-31`）：

| 变体 | 显示文本 | 含义 |
|------|----------|------|
| `Thinking`（默认） | "Thinking" / "Ready" | 等待模型响应 |
| `Working` | "Working" / "Ready" | 执行工具调用 |
| `WaitingForBackgroundTerminal` | "Waiting" / "Ready" | 等待后台终端完成 |
| `Undoing` | "Undoing" | 正在撤销操作 |

当任务未在运行时（`!bottom_pane.is_task_running()`），所有状态均显示为 "Ready"。MCP 启动阶段显示 "Starting"，优先级最高（`codex-rs/tui/src/chatwidget/status_surfaces.rs:544-566`）。

### `StatusSurfaceSelections`

每帧刷新的配置快照（`codex-rs/tui/src/chatwidget/status_surfaces.rs:40-45`）：

```rust
struct StatusSurfaceSelections {
    status_line_items: Vec<StatusLineItem>,          // 已解析的状态行项目
    invalid_status_line_items: Vec<String>,           // 无效的状态行配置 ID
    terminal_title_items: Vec<TerminalTitleItem>,     // 已解析的终端标题项目
    invalid_terminal_title_items: Vec<String>,        // 无效的终端标题配置 ID
}
```

该结构的核心价值在于：两个展示面共享的开销（如 Git 分支查询检测、无效项收集）只需计算一次。通过 `uses_git_branch()` 方法判断是否有任何展示面需要 Git 分支信息。

### `CachedProjectRootName`

项目根目录名称缓存（`codex-rs/tui/src/chatwidget/status_surfaces.rs:62-65`），按 cwd 缓存查找结果，避免终端标题高频刷新时反复遍历文件系统。缓存失效条件是 cwd 变化。

### `SessionHeader`

轻量级会话头部信息容器（`codex-rs/tui/src/chatwidget/session_header.rs:1-16`），仅跟踪当前显示的模型名称。`set_model()` 方法只在名称实际变化时才执行赋值。

## 函数签名与参数说明

### 公开 API（`pub(crate)`）

#### `refresh_status_surfaces(&mut self)`
统一刷新入口，同时更新状态行和终端标题。每次状态变化或帧刷新时调用。

#### `refresh_terminal_title(&mut self)`
仅刷新终端标题（不影响状态行），用于 spinner 动画等仅需更新标题的场景。

#### `clear_managed_terminal_title(&mut self) -> std::io::Result<()>`
清除 Codex 上次写入的终端标题。注意：不会恢复到 shell 原始标题，仅清除管理的标题并更新缓存。

#### `SessionHeader::new(model: String) -> Self`
创建新的会话头部，传入初始模型名称。

#### `SessionHeader::set_model(&mut self, model: &str)`
更新头部模型名称，仅在值实际变化时执行写入。

### 内部 API（`pub(super)`）

#### `status_line_value_for_item(&mut self, item: &StatusLineItem) -> Option<String>`
将单个状态行配置项解析为显示字符串。返回 `None` 表示该项当前不可用（如 Git 分支查询中），不代表配置错误。

支持的状态行项目（`StatusLineItem` 枚举，定义于 `codex-rs/tui/src/bottom_pane/status_line_setup.rs:50`）：

| 项目 ID | 输出示例 |
|---------|----------|
| `ModelName` | `"o3"` |
| `ModelWithReasoning` | `"o3 medium fast"` |
| `CurrentDir` | `"/Users/joe/project"` |
| `ProjectRoot` | `"codex"` |
| `GitBranch` | `"main"` |
| `ContextRemaining` | `"72% left"` |
| `ContextUsed` | `"28% used"` |
| `FiveHourLimit` | 速率限制显示 |
| `WeeklyLimit` | 周限制显示 |
| `CodexVersion` | 版本号字符串 |
| `ContextWindowSize` | `"200k window"` |
| `TotalInputTokens` | `"12k in"` |
| `TotalOutputTokens` | `"3k out"` |
| `SessionId` | 会话 ID |
| `FastMode` | `"Fast on"` / `"Fast off"` |

#### `terminal_title_value_for_item(&mut self, item: TerminalTitleItem, now: Instant) -> Option<String>`
将单个终端标题项目解析为显示段。

支持的终端标题项目（`TerminalTitleItem` 枚举，定义于 `codex-rs/tui/src/bottom_pane/title_setup.rs:34`）：

| 项目 ID | 截断上限 | 说明 |
|---------|----------|------|
| `AppName` | — | 固定返回 `"codex"` |
| `Project` | 24 字符 | 项目根目录名 |
| `Spinner` | — | braille 动画帧 |
| `Status` | — | 运行状态文本 |
| `Thread` | 48 字符 | 当前线程/对话标题 |
| `GitBranch` | 32 字符 | Git 分支名 |
| `Model` | 32 字符 | 模型名称 |
| `TaskProgress` | — | `"Tasks 3/5"` 格式 |

## 配置项与默认值

- **状态行配置**：`config.tui_status_line`（`Option<Vec<String>>`），未设置时使用 `DEFAULT_STATUS_LINE_ITEMS`
- **终端标题配置**：`config.tui_terminal_title`（`Option<Vec<String>>`），未设置时使用 `DEFAULT_TERMINAL_TITLE_ITEMS`，默认为 `["spinner", "project"]`
- **动画开关**：`config.animations`（`bool`），控制 spinner 是否渲染
- **spinner 帧率**：`TERMINAL_TITLE_SPINNER_INTERVAL = 100ms`（硬编码）

## 边界 Case 与注意事项

- **一次性警告机制**：无效配置 ID 的警告通过 `AtomicBool` + `compare_exchange` 实现仅触发一次。必须在 `thread_id` 存在（会话已初始化）后才发出，避免在启动阶段误报（`codex-rs/tui/src/chatwidget/status_surfaces.rs:81-83`）
- **OSC 写入去重**：终端标题通过 `last_terminal_title` 缓存上次写入值，内容未变则跳过 OSC 写入，减少终端 IO（`codex-rs/tui/src/chatwidget/status_surfaces.rs:208-214`）
- **项目根发现优先级**：Git 仓库根目录优先；非 Git 项目回退到最近的 `.codex` 配置层目录的父级（`codex-rs/tui/src/chatwidget/status_surfaces.rs:319-337`）
- **标题段截断**：`truncate_terminal_title_part()` 按 grapheme cluster 截断（正确处理多字节字符），超长时在末尾附加 `...`。当 `max_chars <= 3` 时直接截断不加省略号（`codex-rs/tui/src/chatwidget/status_surfaces.rs:627-641`）
- **分隔符规则**：终端标题中 spinner 与相邻项之间使用空格分隔，其他项之间使用 ` | ` 分隔（逻辑定义于 `codex-rs/tui/src/bottom_pane/title_setup.rs:93-103`）
- **cwd 变化时缓存失效**：Git 分支缓存和项目根名称缓存均以 cwd 为键，目录切换时自动失效并重新查询

## 关键代码片段

解析配置项的通用函数，将字符串 ID 映射为枚举值并收集无效项（`codex-rs/tui/src/chatwidget/status_surfaces.rs:644-662`）：

```rust
fn parse_items_with_invalids<T>(ids: impl IntoIterator<Item = String>) -> (Vec<T>, Vec<String>)
where
    T: std::str::FromStr,
{
    let mut invalid = Vec::new();
    let mut invalid_seen = HashSet::new();
    let mut items = Vec::new();
    for id in ids {
        match id.parse::<T>() {
            Ok(item) => items.push(item),
            Err(_) => {
                if invalid_seen.insert(id.clone()) {
                    invalid.push(format!(r#""{id}""#));
                }
            }
        }
    }
    (items, invalid)
}
```

该函数利用 `FromStr` trait 约束实现泛型解析，对 `StatusLineItem` 和 `TerminalTitleItem` 复用同一套逻辑。无效 ID 通过 `HashSet` 去重，保持插入顺序用于警告消息。