# HistoryCell — 会话记录条目的渲染模型

## 概述与职责

`HistoryCell` 是 Codex TUI 会话记录（transcript）的核心抽象，定义了对话 UI 中每一条可见条目的数据模型与渲染接口。它位于 **TUI → ContentRendering** 子系统中，被 `ChatSurface`（ChatWidget）消费：当 agent 产出事件时，`ChatWidget` 将协议事件转化为具体的 `HistoryCell` 实现，推入可滚动的 transcript 列表进行显示。

该文件是内容渲染范围内最大的单文件（约 4700 行），包含 1 个 trait 定义、20+ 个具体实现结构体，以及大量的工厂函数。

同级模块包括 `ExecCell`（命令执行条目）、diff 渲染、markdown 解析、流式 pipeline 等，它们共同组成 ContentRendering 层。

## 关键流程

### HistoryCell trait 的生命周期

1. **创建**：外部代码（主要是 `ChatWidget`）通过工厂函数（如 `new_user_prompt()`、`new_active_mcp_tool_call()`）创建具体 cell 实例，返回 `Box<dyn HistoryCell>`
2. **渲染**：`ChatWidget` 在每帧调用 `display_lines(width)` 获取 `Vec<Line<'static>>`，再通过 `Paragraph::wrap` 渲染到 ratatui Buffer
3. **布局**：`desired_height(width)` 返回该 cell 在给定终端宽度下占用的行数，考虑了自动换行
4. **Transcript 覆盖层**：`Ctrl+T` 打开的 transcript overlay 调用 `transcript_lines(width)` 获取可能不同于主视图的渲染结果（如 `ReasoningSummaryCell` 在主视图可能隐藏但在 transcript 中显示）
5. **动画**：包含 spinner/shimmer 的 cell（如进行中的 MCP 调用）通过 `transcript_animation_tick()` 返回随时间变化的 tick 值，通知缓存刷新

### Renderable 适配

`Box<dyn HistoryCell>` 实现了 `Renderable` trait（`history_cell.rs:180-197`），其 `render()` 方法：

1. 调用 `display_lines(area.width)` 获取逻辑行
2. 构造 `Paragraph` 并启用 `Wrap { trim: false }`
3. 计算溢出行数，通过 `scroll((overflow, 0))` 实现底部对齐渲染

```rust
// history_cell.rs:181-193
fn render(&self, area: Rect, buf: &mut Buffer) {
    let lines = self.display_lines(area.width);
    let paragraph = Paragraph::new(Text::from(lines)).wrap(Wrap { trim: false });
    let y = if area.height == 0 { 0 } else {
        let overflow = paragraph.line_count(area.width)
            .saturating_sub(usize::from(area.height));
        u16::try_from(overflow).unwrap_or(u16::MAX)
    };
    paragraph.scroll((y, 0)).render(area, buf);
}
```

## HistoryCell Trait 定义

```rust
// history_cell.rs:108
pub(crate) trait HistoryCell: std::fmt::Debug + Send + Sync + Any
```

| 方法 | 是否必须实现 | 说明 |
|------|-------------|------|
| `display_lines(&self, width: u16) -> Vec<Line<'static>>` | **必须** | 返回主视图的逻辑行 |
| `desired_height(&self, width: u16) -> u16` | 可选 | 默认通过 `Paragraph::line_count` 计算含换行的实际行数 |
| `transcript_lines(&self, width: u16) -> Vec<Line<'static>>` | 可选 | 默认等于 `display_lines`；用于 `Ctrl+T` overlay |
| `desired_transcript_height(&self, width: u16) -> u16` | 可选 | 同 `desired_height`，含 ratatui 单行空白 bug 的 workaround |
| `is_stream_continuation(&self) -> bool` | 可选 | 默认 `false`；为 `true` 时表示该 cell 是流式追加的续行 |
| `transcript_animation_tick(&self) -> Option<u64>` | 可选 | 返回 `Some(tick)` 表示渲染结果随时间变化，缓存需刷新 |

通过 `as_any()` / `as_any_mut()` 方法（`history_cell.rs:199-206`），外部可以向下转型到具体结构体以进行原位变更（如完成 MCP 调用时更新 `McpToolCallCell` 的结果字段）。

## 所有 HistoryCell 实现一览

### 用户输入类

| 结构体 | 行号 | 说明 |
|--------|------|------|
| `UserHistoryCell` | :210 | 用户消息，支持 `TextElement` 高亮（如 @-mention）和远程图片 URL 标签 |
| `RequestUserInputResultCell` | :2215 | MCP elicitation 的问答记录，展示问题、选项答案和中断状态 |

### 助手输出类

| 结构体 | 行号 | 说明 |
|--------|------|------|
| `AgentMessageCell` | :450 | 助手 markdown 消息块，`is_first_line` 控制 `"• "` 前缀 vs 续行缩进 |
| `ReasoningSummaryCell` | :385 | 推理摘要，支持 `transcript_only` 模式（主视图隐藏，transcript 可见） |
| `ProposedPlanCell` | :2380 | 最终化的计划提案，使用 `proposed_plan_style` 样式渲染 markdown |
| `ProposedPlanStreamCell` | :2387 | 流式计划提案的中间态，直接持有预渲染的 `Lines` |
| `PlanUpdateCell` | :2430 | 计划更新，以 checkbox 列表渲染每个步骤（✔ 完成 / □ 进行中 / □ 待办） |

### 工具调用类

| 结构体 | 行号 | 说明 |
|--------|------|------|
| `McpToolCallCell` | :1406 | MCP 工具调用，包含 spinner 动画、调用结果渲染（文本/图片/资源链接/错误） |
| `CompletedMcpToolCallWithImageOutput` | :992 | MCP 工具返回图片时附加的独立 cell |
| `WebSearchCell` | :1607 | Web 搜索，支持 action 更新和完成状态切换 |
| `McpInventoryLoadingCell` | :2173 | `/mcp` 命令加载中的 spinner 占位 cell |
| `UnifiedExecInteractionCell` | :588 | 后台终端交互记录（stdin 发送或等待） |
| `UnifiedExecProcessesCell` | :656 | `/ps` 命令的后台进程快照列表 |

### 文件变更与补丁类

| 结构体 | 行号 | 说明 |
|--------|------|------|
| `PatchHistoryCell` | :980 | 文件变更 diff 摘要，委托给 `create_diff_summary()` |

### 会话元信息类

| 结构体 | 行号 | 说明 |
|--------|------|------|
| `SessionHeaderHistoryCell` | :1228 | 会话头部卡片，展示版本号、模型名、推理 effort、目录路径 |
| `SessionInfoCell` | :1112 | 组合 cell：session header + 帮助文本/tooltip/模型变更提示 |
| `FinalMessageSeparator` | :2601 | 轮次之间的分隔线，可选显示工作时长和运行时指标 |
| `TooltipHistoryCell` | :1078 | 会话开头的 Tip 提示 |

### 通用 / 状态类

| 结构体 | 行号 | 说明 |
|--------|------|------|
| `PlainHistoryCell` | :484 | 最简实现，直接返回预构造的 `Vec<Line>` |
| `PrefixedWrappedHistoryCell` | :555 | 带前缀自动换行的通用 cell |
| `CompositeHistoryCell` | :1377 | 组合多个子 cell，用空行分隔 |
| `UpdateAvailableHistoryCell` | :502 | 新版本提醒卡片 |
| `DeprecationNoticeCell` | :1757 | 弃用警告 |

## 关键内部机制

### 自适应换行（Adaptive Wrap）

几乎所有 cell 都使用 `adaptive_wrap_lines()` / `adaptive_wrap_line()` 进行文本换行（来自 `crate::wrapping`），配合 `RtOptions` 设置初始前缀和续行前缀。典型模式：

```rust
// history_cell.rs:466-476 — AgentMessageCell 示例
adaptive_wrap_lines(
    &self.lines,
    RtOptions::new(width as usize)
        .initial_indent(if self.is_first_line { "• ".dim().into() } else { "  ".into() })
        .subsequent_indent("  ".into()),
)
```

### 边框卡片渲染

`with_border()` 和 `with_border_with_inner_width()`（`history_cell.rs:1012-1068`）提供 Unicode 方框字符（╭╮╰╯│─）围绕内容的卡片效果，用于 session header 和 update 通知。内部宽度根据内容最大行宽或强制宽度取较大值。

### 动画 Tick 机制

带 spinner 的 cell（`McpToolCallCell`、`WebSearchCell`、`McpInventoryLoadingCell`）实现 `transcript_animation_tick()`，返回基于 elapsed 时间的 tick 值（50ms 粒度）。transcript overlay 用这个 tick 作为缓存 key 的一部分——当 tick 变化时重新渲染该 cell 的 transcript 输出。

```rust
// history_cell.rs:1582-1587 — McpToolCallCell
fn transcript_animation_tick(&self) -> Option<u64> {
    if !self.animations_enabled || self.result.is_some() {
        return None;  // 完成后不再动画
    }
    Some((self.start_time.elapsed().as_millis() / 50) as u64)
}
```

### MCP 工具调用的原位更新

`McpToolCallCell` 被创建为"活动 cell"（active cell），初始时 `result = None` 并显示 spinner。当调用完成时，外部代码通过 `as_any_mut()` 向下转型后调用 `complete()` 方法（`history_cell.rs:1435-1445`）原位写入结果，同时可选返回一个独立的图片 cell。`mark_failed()` 用于中断场景。

### UserHistoryCell 的 TextElement 高亮

`build_user_message_lines_with_elements()`（`history_cell.rs:222-282`）将用户消息按 byte range 与 `TextElement` 列表对齐，交错生成普通文本 span 和 Cyan 样式的元素 span。容错处理了 UTF-8 边界不合法的情况（跳过而非 panic）。

### 推理摘要的双模式渲染

`ReasoningSummaryCell` 有 `transcript_only` 字段（`history_cell.rs:390`）。当为 `true` 时，`display_lines()` 返回空 vec（主视图不可见），但 `transcript_lines()` 仍然返回完整内容——这样 `Ctrl+T` overlay 能看到完整推理过程而不干扰主聊天界面。

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|-----|------|
| `SESSION_HEADER_MAX_INNER_WIDTH` | 56 | 会话头部卡片的最大内部宽度 |
| `LIVE_PREFIX_COLS`（外部） | — | 用户消息换行时预留的左侧前缀列数 |
| `TOOL_CALL_MAX_LINES`（外部） | — | MCP 工具结果和命令输出的最大显示行数 |

## 工厂函数汇总

文件导出大量 `pub(crate)` 或 `pub` 工厂函数，隔离了构造逻辑：

- `new_user_prompt()` → `UserHistoryCell`
- `new_session_info()` → `SessionInfoCell`
- `new_approval_decision_cell()` → `Box<dyn HistoryCell>`（审批决策）
- `new_guardian_denied_patch_request()` / `new_guardian_approved_action_request()` — 自动审查结果
- `new_active_mcp_tool_call()` → `McpToolCallCell`
- `new_active_web_search_call()` / `new_web_search_call()` → `WebSearchCell`
- `new_mcp_inventory_loading()` → `McpInventoryLoadingCell`
- `new_patch_event()` → `PatchHistoryCell`
- `new_plan_update()` → `PlanUpdateCell`
- `new_proposed_plan()` / `new_proposed_plan_stream()` — 计划提案
- `new_reasoning_summary_block()` → `Box<dyn HistoryCell>`
- `new_warning_event()` / `new_error_event()` / `new_info_event()` / `new_deprecation_notice()` — 状态消息
- `new_view_image_tool_call()` / `new_image_generation_call()` — 图片相关
- `new_unified_exec_interaction()` / `new_unified_exec_processes_output()` — 后台终端
- `new_patch_apply_failure()` — 补丁应用失败
- `new_review_status_line()` — 代码审查状态
- `empty_mcp_output()` / `new_mcp_tools_output_from_statuses()` — MCP 工具列表

## 边界 Case 与注意事项

- **width = 0 防御**：多个 cell 的 `display_lines()` 在 `width == 0` 时返回空 vec，避免除零或布局异常
- **ratatui 单行空白 bug**：`desired_transcript_height()` 中有 workaround——当内容仅一行且全为空白时，`Paragraph::line_count` 错误返回 2，代码强制 clamp 为 1（`history_cell.rs:145-152`）
- **UTF-8 边界安全**：`build_user_message_lines_with_elements()` 在处理 `TextElement` byte range 时检查 `is_char_boundary()`，遇到非法范围跳过而非 panic
- **MCP 图片解码容错**：`decode_mcp_image()` 在 base64 解码失败、格式猜测失败、图片解码失败时均返回 `None` 并记录 error 日志，不会中断渲染流程
- **data URL 兼容**：MCP 图片数据支持 `data:` URL 前缀格式，会自动剥离 MIME 头部后解码
- **transcript_only 模式**：`ReasoningSummaryCell` 可配置为仅在 transcript overlay 中可见，主视图返回空行