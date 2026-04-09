# MCP Server Elicitation Overlay

## 概述与职责

`McpServerElicitationOverlay` 是 TUI BottomPane 视图栈中的一个模态覆盖层，负责渲染 MCP（Model Context Protocol）服务器发起的结构化输入请求表单。它位于 **TUI → BottomPane → AgentElicitation** 层级中，与同级的 generic request-user-input overlay 和 app-link view 并列，共同组成 Agent 向用户请求结构化输入的三种覆盖层实现。

该模块的核心职责包括：

- **解析 JSON Schema 驱动的表单定义**：将 MCP 协议层传入的 `requested_schema`（JSON Schema `object` 类型）解析为可渲染的字段列表，支持文本输入、布尔选择、枚举单选等字段类型
- **渲染多字段表单 UI**：在终端中绘制包含进度指示、提示文本、输入区域和快捷键提示的完整表单界面
- **管理表单交互状态**：维护每个字段的独立草稿（ComposerDraft）、滚动状态（ScrollState）、提交状态，以及字段间的导航
- **构建并提交结构化 JSON 响应**：将用户填写的表单数据组装为符合 schema 的 JSON 对象，通过 `AppEventSender` 回传给 MCP 协议层
- **处理工具审批流程**：对于 MCP 工具调用审批（tool approval），自动生成 Allow/Deny/Cancel 选项，并支持 session/always 级别的持久化语义

## 关键流程

### 1. 请求解析与表单构建

入口为两个工厂方法 `from_app_server_request()` 和 `from_event()`，最终都汇入核心的 `from_parts()` 方法（`mcp_server_elicitation.rs:259-374`）。该方法根据 `meta` 和 `requested_schema` 的组合决定表单的响应模式：

1. **工具建议模式**（Tool Suggestion）：当 `meta.codex_approval_kind == "tool_suggestion"` 且 schema 为空时，生成空字段的 `FormContent` 模式表单（由上层 app-link view 处理渲染）
2. **审批动作模式**（ApprovalAction）：当 schema 为 `null` 或为空对象且标记为工具审批时，自动生成 Allow / Allow for session / Always allow / Cancel 等选项。persist 模式根据 `meta.persist` 字段动态添加（`mcp_server_elicitation.rs:299-323`）
3. **表单内容模式**（FormContent）：调用 `parse_fields_from_schema()` 从 JSON Schema 的 `properties` 中逐字段解析

### 2. Schema 字段解析

`parse_fields_from_schema()`（`mcp_server_elicitation.rs:552-577`）遍历 JSON Schema 的 `properties`，对每个属性调用 `parse_field()` 进行类型映射：

| Schema 类型 | 映射结果 | 说明 |
|------------|---------|------|
| `string` | `Text { secret: false }` | 自由文本输入 |
| `boolean` | `Select` (True/False) | 双选项单选 |
| `enum`（Legacy） | `Select` + `enum_names` | 带可选显示名称的枚举 |
| `enum`（SingleSelect/Untitled） | `Select` | 纯字符串枚举 |
| `enum`（SingleSelect/Titled） | `Select` + `one_of` | 带 `title` 的 oneOf 枚举 |
| `number` / `MultiSelect` | 不支持，返回 `None` | 整个表单解析失败 |

### 3. 多字段表单交互

`McpServerElicitationOverlay` 维护一个 `answers: Vec<McpServerElicitationAnswerState>` 数组，每个字段对应一个独立的回答状态，包含：

- `selection: ScrollState` — 用于 Select 类型字段的光标位置
- `draft: ComposerDraft` — 用于 Text 类型字段的文本草稿
- `answer_committed: bool` — 标记该字段是否已有有效回答

字段导航通过 `move_field(next: bool)` 实现（`mcp_server_elicitation.rs:1046-1056`），切换时会先 `save_current_draft()` 保存当前字段状态，再 `restore_current_draft()` 恢复目标字段状态到 ChatComposer 中。这使得多字段间切换时草稿不会丢失。

### 4. 提交流程

`submit_answers()`（`mcp_server_elicitation.rs:1146-1213`）执行以下步骤：

1. 保存当前字段草稿
2. 检查是否有未回答的必填字段，有则跳转到第一个未答字段并显示验证错误
3. 根据 `response_mode` 分两条路径：
   - **ApprovalAction**：从第 0 个字段的选中值解码出 `ElicitationAction`（Accept/Decline/Cancel）和可选的 persist meta（session/always），通过 `resolve_elicitation()` 发送
   - **FormContent**：收集所有字段的 `(field_id, value)` 对组装成 `serde_json::Map`，以 `ElicitationAction::Accept` + `content` 发送
4. 提交后检查队列（`self.queue`），如有后续请求则切换到下一个表单，否则标记 `done = true`

### 5. 渲染管线

`Renderable::render()`（`mcp_server_elicitation.rs:1380-1452`）将内容区域划分为四个垂直区块：

```
┌─────────────────────────────┐
│ Progress  (Field 1/3)       │  ← 1 行，显示当前字段位置和未答必填数
│ Prompt    (问题文本)         │  ← 动态高度，textwrap 自动换行
│ Input     (选项列表/文本框)  │  ← Select 用 render_rows，Text 用 ChatComposer
│ Footer    (快捷键提示)       │  ← 底部操作提示
└─────────────────────────────┘
```

布局算法优先保证 footer 和最小 input 高度，剩余空间分配给 prompt，最后将多余空间追加到 input 区域。

## 核心类型定义

### `McpServerElicitationOverlay`（公开）

覆盖层主结构体，实现了 `BottomPaneView` 和 `Renderable` trait。

```rust
// mcp_server_elicitation.rs:727-736
pub(crate) struct McpServerElicitationOverlay {
    app_event_tx: AppEventSender,        // 事件发送通道
    request: McpServerElicitationFormRequest,  // 当前表单请求
    queue: VecDeque<McpServerElicitationFormRequest>,  // 待处理队列
    composer: ChatComposer,              // 文本输入组件（复用）
    answers: Vec<McpServerElicitationAnswerState>,     // 每字段的回答状态
    current_idx: usize,                  // 当前聚焦字段索引
    done: bool,                          // 是否已完成
    validation_error: Option<String>,    // 当前验证错误
}
```

### `McpServerElicitationFormRequest`（公开）

解析后的表单请求数据，包含线程 ID、MCP 服务器名、请求 ID、提示消息、字段列表和响应模式。

```rust
// mcp_server_elicitation.rs:165-174
pub(crate) struct McpServerElicitationFormRequest {
    thread_id: ThreadId,
    server_name: String,
    request_id: McpRequestId,
    message: String,
    approval_display_params: Vec<McpToolApprovalDisplayParam>,
    response_mode: McpServerElicitationResponseMode,
    fields: Vec<McpServerElicitationField>,
    tool_suggestion: Option<ToolSuggestionRequest>,
}
```

### `McpServerElicitationResponseMode`（内部）

```rust
// mcp_server_elicitation.rs:130-133
enum McpServerElicitationResponseMode {
    FormContent,      // 返回 JSON 对象作为 content
    ApprovalAction,   // 返回 Accept/Decline/Cancel 决策
}
```

### `McpServerElicitationFieldInput`（内部）

```rust
// mcp_server_elicitation.rs:110-118
enum McpServerElicitationFieldInput {
    Select {
        options: Vec<McpServerElicitationOption>,
        default_idx: Option<usize>,
    },
    Text {
        secret: bool,   // secret 为 true 时用 '*' 掩码渲染
    },
}
```

### `ToolSuggestionRequest` / `ToolSuggestionToolType` / `ToolSuggestionType`（公开）

用于工具建议场景的数据结构。`tool_type` 区分 Connector 和 Plugin，`suggest_type` 区分 Install 和 Enable。

```rust
// mcp_server_elicitation.rs:147-155
pub(crate) struct ToolSuggestionRequest {
    pub(crate) tool_type: ToolSuggestionToolType,   // Connector | Plugin
    pub(crate) suggest_type: ToolSuggestionType,     // Install | Enable
    pub(crate) suggest_reason: String,
    pub(crate) tool_id: String,
    pub(crate) tool_name: String,
    pub(crate) install_url: Option<String>,
}
```

## 函数签名

### `McpServerElicitationFormRequest::from_event(thread_id, request) -> Option<Self>`

从 `ElicitationRequestEvent` 构造表单请求。返回 `None` 表示 schema 不受支持（如仅含 number 字段或空且未标记为审批）。

> 源码位置：`mcp_server_elicitation.rs:236-257`

### `McpServerElicitationFormRequest::from_app_server_request(thread_id, request_id, request) -> Option<Self>`

从 app-server 协议的 `McpServerElicitationRequestParams` 构造表单请求，逻辑同上。

> 源码位置：`mcp_server_elicitation.rs:206-234`

### `McpServerElicitationOverlay::new(request, app_event_tx, has_input_focus, enhanced_keys_supported, disable_paste_burst) -> Self`

创建覆盖层实例。内部构造一个 plain-text 模式的 `ChatComposer`，初始化字段状态和默认选中项。

> 源码位置：`mcp_server_elicitation.rs:739-768`

## 键盘交互

`handle_key_event()`（`mcp_server_elicitation.rs:1492-1599`）根据当前字段类型路由按键：

**全局按键：**
- `Esc` — 取消整个表单，发送 `ElicitationAction::Cancel`
- `Ctrl+P` / `PageUp` — 切换到上一个字段
- `Ctrl+N` / `PageDown` — 切换到下一个字段

**Select 字段额外按键：**
- `↑` / `k` — 上移选项光标
- `↓` / `j` — 下移选项光标
- `←` / `→` — 切换字段（替代 Ctrl+P/N）
- `Space` — 确认当前选项
- `Enter` — 确认并前进（最后一个字段时提交）
- 数字键 `1-9` — 直接选中对应编号选项并前进
- `Backspace` / `Delete` — 清除选择

**Text 字段：**
- 按键委托给内部 `ChatComposer` 处理
- `Enter` — 提交当前文本并前进/提交
- `Ctrl+C` — 若有草稿则清空，否则取消

## 配置常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `MIN_COMPOSER_HEIGHT` | 3 | 文本输入区域最小高度 |
| `MIN_OVERLAY_HEIGHT` | 8 | 整个覆盖层最小高度 |
| `APPROVAL_TOOL_PARAM_DISPLAY_LIMIT` | 3 | 审批参数摘要最多显示 3 个 |
| `APPROVAL_TOOL_PARAM_VALUE_TRUNCATE_GRAPHEMES` | 60 | 参数值超过 60 字符截断 |

## 边界 Case 与注意事项

- **不支持的 Schema 类型导致整体失败**：如果 `properties` 中有任意一个字段为 `number` 或 `MultiSelect` 类型，`parse_fields_from_schema()` 返回 `None`，整个表单请求被拒绝。这是有意为之——部分字段缺失会导致不完整的表单
- **空 object schema 的语义歧义**：空 `{ "type": "object", "properties": {} }` 在无 meta 标记时返回 `None`（不显示表单），但在有 `codex_approval_kind: "mcp_tool_call"` meta 时进入 ApprovalAction 模式，在有 `codex_approval_kind: "tool_suggestion"` meta 时进入 FormContent 模式（空字段）
- **请求排队机制**：当覆盖层已在显示一个表单时，新到达的请求通过 `try_consume_mcp_server_elicitation_request()` 入队（FIFO）。每次提交后自动弹出下一个请求
- **Secret 字段**：`Text { secret: true }` 类型的字段在渲染时使用 `'*'` 掩码（`render_with_mask`），但当前 schema 解析中只有 `string` 类型映射为 `secret: false`，secret 模式的触发需要上游额外设置
- **persist 选项的动态生成**：Allow for session 和 Always allow 选项仅在 `meta.persist` 数组包含对应值时才出现，不会无条件展示