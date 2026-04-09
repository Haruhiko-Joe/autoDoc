# 选择列表 UI 与状态展示（PickersAndStatus）

## 概述与职责

本模块是 TUI 层中所有**选择列表弹窗**和**状态展示面板**的集合。它位于 `codex-rs/tui/src/` 下，属于 TUI 子系统的一部分——TUI 负责在终端内提供交互式聊天体验，而本模块则为用户提供会话恢复、主题切换、模型选择、协作模式配置、多 Agent 导航以及运行状态查看等关键交互界面。

同层级的兄弟模块包括 Core（代理编排引擎）、CLI（命令行入口）、AppServer（HTTP/WebSocket 服务）等。TUI 通过调用 Core 来驱动代理会话，同时依赖 Config 读取配置、Auth 进行身份验证。

本模块由以下核心组件构成：

| 文件 | 职责 |
|------|------|
| `resume_picker.rs` | 会话恢复/Fork 选择器 |
| `theme_picker.rs` | 语法主题选择器（带实时预览） |
| `model_catalog.rs` | 模型目录与协作模式列表 |
| `oss_selection.rs` | 本地 OSS 模型提供者选择 |
| `model_migration.rs` | 模型升级迁移提示 |
| `collaboration_modes.rs` | 协作模式过滤与切换 |
| `multi_agents.rs` | 多 Agent 状态渲染与导航 |
| `selection_list.rs` | 通用选择列表行组件 |
| `pager_overlay.rs` | 可滚动全屏分页覆盖层（Ctrl+T） |
| `status/` | 状态卡片系统（账户、速率限制、Token 用量） |
| `status_indicator_widget.rs` | 实时任务状态行（动画 spinner + 计时器） |

---

## 关键流程

### 1. 会话恢复选择器（Resume Picker）

入口函数为 `run_resume_picker()` 和 `run_resume_picker_with_app_server()`（`codex-rs/tui/src/resume_picker.rs:158-190`）。

1. 进入终端备选屏幕（`AltScreenGuard`），防止退出时留下空白区域
2. 创建 `PickerState`，初始化分页状态、搜索状态和排序键（支持按创建时间/更新时间排序）
3. 通过 `PageLoader`（基于 `Arc<dyn Fn>` 的闭包）在后台 tokio 任务中按需加载会话页面，支持两种后端：
   - **Rollout 文件**：从本地 rollout 文件读取（`spawn_rollout_page_loader`）
   - **App Server**：通过 WebSocket 从 app-server 获取（`spawn_app_server_page_loader`）
4. 在 `tokio::select!` 循环中并发处理 TUI 事件（键盘输入、绘制）和后台页面加载完成事件
5. 支持搜索过滤、Tab 切换排序、游标分页、provider 过滤、工作目录过滤
6. 返回 `SessionSelection` 枚举：`StartFresh`、`Resume(target)`、`Fork(target)` 或 `Exit`

关键数据结构：
- `SessionTarget`：包含会话路径和 `ThreadId`
- `PickerState`：持有所有行数据、过滤行、搜索查询、分页游标等状态
- `Row`：每行显示的会话信息（时间戳、分支、目录、会话预览）

### 2. 主题选择器（Theme Picker）

`build_theme_picker_params()` 构建 `SelectionViewParams` 交给通用底部面板渲染（`codex-rs/tui/src/theme_picker.rs:314-407`）：

1. 快照当前主题 → `original_theme`（用于取消时恢复）
2. 列出所有可用主题：内置主题 + `{CODEX_HOME}/themes/` 下的自定义 `.tmTheme` 文件
3. 为每个条目创建 `SelectionItem`，选中时发送 `AppEvent::SyntaxThemeSelected`
4. 注册 `on_selection_changed` 回调：用户光标移动时即时切换语法主题，实现**实时预览**
5. 注册 `on_cancel` 回调：Esc/Ctrl+C 时恢复原始主题
6. 提供两种预览渲染器适应不同终端宽度：
   - `ThemePreviewWideRenderable`：侧边面板，垂直居中，2 列缩进，最小宽度 44 列
   - `ThemePreviewNarrowRenderable`：堆叠模式，紧凑 4 行代码片段

### 3. 模型目录与 OSS 选择

`ModelCatalog`（`codex-rs/tui/src/model_catalog.rs:8-31`）是一个轻量容器，持有 `Vec<ModelPreset>` 和 `CollaborationModesConfig`，提供：
- `try_list_models()` → 返回可用模型列表
- `list_collaboration_modes()` → 返回内置协作模式预设

当用户未设置 API key 而选择本地模型时，`select_oss_provider()`（`codex-rs/tui/src/oss_selection.rs:290-343`）启动一个独立全屏 TUI 选择器：
1. 并发检测 LM Studio（端口 1234）和 Ollama（端口 11434）的运行状态
2. 若仅一个运行中，自动选择该 provider
3. 否则显示带状态指示符（●/○）的选择界面，支持键盘导航和快捷键选择
4. 选择结果通过 `set_default_oss_provider()` 持久化到配置

### 4. 模型迁移提示

`run_model_migration_prompt()`（`codex-rs/tui/src/model_migration.rs:137-169`）在备选屏幕显示模型升级提示：

1. `migration_copy_for_models()` 根据当前模型和目标模型生成提示文案，支持：
   - 纯文本模式：标题 + 描述 + 链接
   - Markdown 模式：使用模板变量 `{model_from}`/`{model_to}` 填充
2. `ModelMigrationScreen` 管理交互状态，支持两种模式：
   - `can_opt_out = true`：显示 "Try new model" / "Use existing model" 菜单，上下键选择
   - `can_opt_out = false`：仅显示确认提示，Enter/Esc 接受
3. 返回 `ModelMigrationOutcome`：`Accepted`、`Rejected` 或 `Exit`（Ctrl+C/Ctrl+D）

### 5. 协作模式选择

`collaboration_modes.rs`（`codex-rs/tui/src/collaboration_modes.rs:1-63`）提供纯函数式的模式过滤与切换逻辑：

- `presets_for_tui()` → 过滤出 `is_tui_visible()` 的协作模式预设
- `default_mask()` → 获取默认模式（`ModeKind::Default`），无则取第一个
- `mask_for_kind()` → 按 `ModeKind` 查找特定模式
- `next_mask()` → 在列表中循环切换到下一个模式
- `plan_mask()` → 获取 `ModeKind::Plan` 模式

### 6. 多 Agent 导航与 Picker

`multi_agents.rs`（`codex-rs/tui/src/multi_agents.rs:1-806`）负责多 Agent 模式下的 UI 表示和导航。核心职责分为三部分：

**Picker 条目格式化**：
- `format_agent_picker_item_name()` 将 nickname + role 组合为显示名称，主线程固定显示为 "Main [default]"
- `agent_picker_status_dot_spans()` 生成状态圆点（绿色 = 活跃，灰色 = 已关闭）

**键盘导航快捷键**：
- `previous_agent_shortcut()` / `next_agent_shortcut()` → Alt+Left / Alt+Right
- macOS 特殊处理：当增强键盘报告不可用时，支持 Alt+B / Alt+F 作为后备绑定（仅在 composer 为空时启用，避免干扰文本编辑的词移动操作）

**协作事件渲染**：
为每种协作事件生成 `PlainHistoryCell`，渲染到聊天历史中：
- `spawn_end()` → "• **Spawned** Robie [explorer] (gpt-5 high)"，附带 prompt 预览
- `interaction_end()` → "• **Sent input to** ..."
- `waiting_begin()` / `waiting_end()` → 等待开始/完成，包含各 Agent 状态摘要
- `close_end()` / `resume_begin()` / `resume_end()` → 关闭/恢复事件

Agent 状态摘要使用颜色编码：`Running`=cyan bold、`Completed`=green、`Errored`=red、`Interrupted`=yellow。

### 7. 分页覆盖层（Pager Overlay）

`pager_overlay.rs`（`codex-rs/tui/src/pager_overlay.rs:1-500`）实现 Ctrl+T 触发的全屏转录查看器。

`Overlay` 枚举包含两种变体：
- **`Transcript`**：显示完整聊天历史，支持实时尾部跟踪（`sync_live_tail`），通过缓存键（宽度、修订号、动画 tick）决定何时重新计算
- **`Static`**：通用静态内容分页器

底层 `PagerView` 提供通用分页功能：
- 丰富的 vim 风格导航：Up/Down/k/j（单行）、PageUp/PageDown/Space（整页）、Ctrl+D/Ctrl+U（半页）、Home/End（首尾）、Left/Right（水平滚动）
- 底部进度条显示滚动百分比
- 每个 renderable 的 `desired_height()` 通过 `CachedRenderable` 缓存避免重复计算
- 支持 `ensure_chunk_visible()` 将指定文本块滚动到可见区域

退出键：q、Esc、Enter、Ctrl+T、Ctrl+C。

---

## 函数签名与参数说明

### `build_theme_picker_params`

```rust
pub(crate) fn build_theme_picker_params(
    current_name: Option<&str>,      // 当前持久化的主题名
    codex_home: Option<&Path>,        // CODEX_HOME 路径，用于扫描自定义主题
    terminal_width: Option<u16>,      // 终端宽度，影响预览布局
) -> SelectionViewParams
```

> 源码位置：`codex-rs/tui/src/theme_picker.rs:314-407`

### `select_oss_provider`

```rust
pub async fn select_oss_provider(
    codex_home: &std::path::Path,     // 用于持久化选择结果
) -> io::Result<String>              // 返回 provider ID 或 "__CANCELLED__"
```

> 源码位置：`codex-rs/tui/src/oss_selection.rs:290-343`

### `run_model_migration_prompt`

```rust
pub(crate) async fn run_model_migration_prompt(
    tui: &mut Tui,
    copy: ModelMigrationCopy,         // 提示文案（标题、内容、是否可拒绝）
) -> ModelMigrationOutcome
```

> 源码位置：`codex-rs/tui/src/model_migration.rs:137-169`

### `new_status_output_with_rate_limits_handle`

```rust
pub(crate) fn new_status_output_with_rate_limits_handle(
    config: &Config,
    account_display: Option<&StatusAccountDisplay>,
    token_info: Option<&TokenUsageInfo>,
    total_usage: &TokenUsage,
    session_id: &Option<ThreadId>,
    thread_name: Option<String>,
    forked_from: Option<ThreadId>,
    rate_limits: &[RateLimitSnapshotDisplay],
    plan_type: Option<PlanType>,
    now: DateTime<Local>,
    model_name: &str,
    collaboration_mode: Option<&str>,
    reasoning_effort_override: Option<Option<ReasoningEffort>>,
    refreshing_rate_limits: bool,
) -> (CompositeHistoryCell, StatusHistoryHandle)
```

返回值中 `StatusHistoryHandle` 持有 `Arc<RwLock<StatusRateLimitState>>`，允许后台刷新速率限制数据后就地更新已渲染的状态卡片。

> 源码位置：`codex-rs/tui/src/status/card.rs:186-224`

---

## 接口/类型定义

### `SessionSelection`（会话选择结果）

```rust
pub enum SessionSelection {
    StartFresh,                       // 新建会话
    Resume(SessionTarget),            // 恢复已有会话
    Fork(SessionTarget),              // Fork 已有会话
    Exit,                             // 用户退出
}
```

> 源码位置：`codex-rs/tui/src/resume_picker.rs:64-70`

### `ModelMigrationOutcome`

```rust
pub(crate) enum ModelMigrationOutcome {
    Accepted,     // 用户接受升级
    Rejected,     // 用户选择保留旧模型
    Exit,         // Ctrl+C/Ctrl+D 退出
}
```

> 源码位置：`codex-rs/tui/src/model_migration.rs:27-31`

### `StatusAccountDisplay`

```rust
pub(crate) enum StatusAccountDisplay {
    ChatGpt { email: Option<String>, plan: Option<String> },
    ApiKey,
}
```

> 源码位置：`codex-rs/tui/src/status/account.rs:1-8`

### `StatusRateLimitData`

```rust
pub(crate) enum StatusRateLimitData {
    Available(Vec<StatusRateLimitRow>),   // 数据新鲜
    Stale(Vec<StatusRateLimitRow>),       // 数据超过 15 分钟
    Missing,                              // 无数据
}
```

> 源码位置：`codex-rs/tui/src/status/rate_limits.rs:47-55`

### `RateLimitSnapshotDisplay`

```rust
pub(crate) struct RateLimitSnapshotDisplay {
    pub limit_name: String,
    pub captured_at: DateTime<Local>,
    pub primary: Option<RateLimitWindowDisplay>,
    pub secondary: Option<RateLimitWindowDisplay>,
    pub credits: Option<CreditsSnapshotDisplay>,
}
```

> 源码位置：`codex-rs/tui/src/status/rate_limits.rs:88-99`

---

## 通用选择列表组件

`selection_list.rs`（`codex-rs/tui/src/selection_list.rs:1-46`）提供被多个 picker 复用的行渲染函数：

```rust
pub(crate) fn selection_option_row(
    index: usize,          // 条目序号（显示为 1-based）
    label: String,         // 条目文本
    is_selected: bool,     // 是否高亮
) -> Box<dyn Renderable>
```

选中时前缀为 `› 1. `（cyan 样式），未选中为 `  1. `。支持 `dim` 参数用于已关闭的 Agent 条目。

---

## 状态卡片系统

`/status` 命令触发 `StatusHistoryCell` 渲染一张带边框的信息卡片（`codex-rs/tui/src/status/card.rs:528-670`），包含以下字段：

- **Model**：模型名称 + 可选详情（reasoning effort、summaries）
- **Model provider**：非 OpenAI 默认 provider 时显示名称和 base URL（已清理敏感参数）
- **Directory**：工作目录，使用 `~` 缩写，超宽时中间截断
- **Permissions**："Default" / "Full Access" / "Custom (sandbox, approval)"
- **Agents.md**：发现的项目文档路径
- **Account**：ChatGPT 邮箱+套餐 或 API key 状态
- **Token usage**：总量 + (输入 + 输出) 的紧凑格式（K/M/B/T 后缀）
- **Context window**：剩余百分比 + 已用/总量
- **Rate limits**：进度条 `[████░░░░░░]` + 百分比 + 重置时间，支持多限制桶

`FieldFormatter`（`codex-rs/tui/src/status/format.rs:7-83`）自动对齐所有标签宽度，确保值列左对齐。

`StatusHistoryHandle` 支持异步更新：后台刷新速率限制后调用 `finish_rate_limit_refresh()` 就地更新 `Arc<RwLock>` 中的数据，下次绘制即可反映最新状态。

---

## 状态指示器 Widget

`StatusIndicatorWidget`（`codex-rs/tui/src/status_indicator_widget.rs:42-288`）在 composer 上方显示一行实时任务状态：

```
⠋ Working (5s • esc to interrupt) · running 3 background processes
  └ Searching for files matching pattern...
```

核心特性：
- **动画 spinner**：基于 `Instant` 的帧动画（32ms 间隔），头部文字带 shimmer 效果
- **计时器**：支持暂停/恢复（`pause_timer()` / `resume_timer()`），格式化为 `0s` / `1m 00s` / `1h 00m 00s`
- **中断提示**：可通过 `set_interrupt_hint_visible()` 控制是否显示 "esc to interrupt"
- **详情文本**：`update_details()` 设置多行详情，支持自动换行和超出行数截断（添加 `…`）
- **行内消息**：`update_inline_message()` 在计时器后追加简短上下文

---

## 边界 Case 与注意事项

- **主题选择器的预览对齐**：`on_selection_changed` 回调中的 theme name 列表是从最终 `items`（而非原始 `entries`）中派生的，确保如果排序逻辑变化，预览索引仍然正确对齐
- **OSS 选择器的自动选择**：当且仅当一个 provider 运行、另一个未运行时跳过 UI 直接选择，两者都未运行或都运行时才显示交互界面
- **macOS 键盘兼容**：多 Agent 导航的 Alt+Left/Right 在某些 macOS 终端会被映射为 Alt+B/F（词移动），代码通过平台条件编译和 `allow_word_motion_fallback` 参数处理这一歧义
- **速率限制过期检测**：超过 `RATE_LIMIT_STALE_THRESHOLD_MINUTES`（15 分钟）的快照标记为 `Stale`，渲染时附带警告文字
- **状态卡片中隐藏 ChatGPT 用户的 Token 用量**：当账户类型为 `ChatGpt` 时，Token usage 行不显示（因为这些用户按套餐计费而非按 token）
- **base URL 清理**：`sanitize_base_url()` 在状态卡片中显示 provider URL 前会移除用户名、密码、query 参数和 fragment，防止泄露敏感信息