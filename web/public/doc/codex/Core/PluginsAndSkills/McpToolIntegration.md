# MCP 工具集成

## 概述与职责

MCP 工具集成模块是 Core 引擎中 **PluginsAndSkills** 子系统的组成部分，负责 MCP（Model Context Protocol）工具调用的执行、审批、遥测和依赖管理。它是模型请求的 MCP 工具调用从"收到请求"到"返回结果"之间的完整处理管道。

在整体架构中，该模块位于 Core > PluginsAndSkills 层级下，与同级的插件发现、技能加载、Mention 解析等模块并列。它的上游消费者是 SessionEngine 和 ToolsOrchestration——当模型在对话中请求调用一个 MCP 工具时，调用链最终会到达本模块的 `handle_mcp_tool_call` 入口。

本模块由四个文件组成：

| 文件 | 职责 |
|------|------|
| `mcp.rs` | `McpManager`——对 `PluginsManager` 的薄封装，提供 MCP 服务器配置查询 |
| `mcp_tool_call.rs` | 核心调用处理器——参数解析、审批流程、Guardian 审核、遥测、结果清洗 |
| `mcp_tool_approval_templates.rs` | 审批模板渲染——将内置 JSON 模板转换为人类可读的审批消息 |
| `mcp_skill_dependencies.rs` | 技能依赖管理——检测、提示安装、写入配置缺失的 MCP 服务器依赖 |

## 关键流程

### 1. MCP 工具调用主流程（`handle_mcp_tool_call`）

这是整个模块的核心入口，完整的调用链如下：

1. **参数解析**：将传入的 `arguments` 字符串解析为 JSON。空字符串视为无参数，非法 JSON 直接返回错误（`mcp_tool_call.rs:78-90`）

2. **元数据查询**：调用 `lookup_mcp_tool_metadata` 从 `mcp_connection_manager` 获取工具的注解（`ToolAnnotations`）、connector 信息、工具标题等（`mcp_tool_call.rs:98-99`）

3. **审批策略确定**：
   - 对 Codex Apps 服务器（`CODEX_APPS_MCP_SERVER_NAME`），通过 `connectors::app_tool_policy` 查询 app 级策略
   - 对自定义 MCP 服务器，通过 `custom_mcp_tool_approval_mode` 从配置层级栈中读取 `mcp_servers.<server>.tools.<tool>.approval_mode`（`mcp_tool_call.rs:100-121`）

4. **策略拦截**：如果 app 工具被策略禁用（`!app_tool_policy.enabled`），直接跳过执行（`mcp_tool_call.rs:123-140`）

5. **发送 Begin 事件**：向 Session 发送 `McpToolCallBegin` 事件通知 UI 层（`mcp_tool_call.rs:157-161`）

6. **审批决策**（详见下文"审批流程"）：
   - 全访问模式（`DangerFullAccess` / `ExternalSandbox` + `AskForApproval::Never`）→ 跳过审批
   - 需要审批 → 进入 `maybe_request_mcp_tool_approval` 流程

7. **执行工具调用**：通过 `sess.call_tool()` 发起实际的 MCP 工具调用，整个调用被包裹在 OpenTelemetry span 中用于分布式追踪（`mcp_tool_call.rs:181-202`）

8. **结果清洗**：`sanitize_mcp_tool_result_for_model` 检查模型是否支持图片输入，不支持时将 `image` 类型内容块替换为文本占位符（`mcp_tool_call.rs:472-501`）

9. **发送 End 事件与遥测**：发送 `McpToolCallEnd` 事件，记录 `codex.mcp.call` 计数器和 `codex.mcp.call.duration_ms` 持续时间指标（`mcp_tool_call.rs:282-291`）

10. **记忆模式污染标记**：如果配置了 `no_memories_if_mcp_or_web_search`，将当前线程标记为"记忆污染"状态，阻止从该线程提取记忆（`mcp_tool_call.rs:456-470`）

### 2. 审批流程（`maybe_request_mcp_tool_approval`）

审批流程根据工具注解和配置策略决定是否需要用户确认：

1. **判断是否需要审批**（`requires_mcp_tool_approval`，`mcp_tool_call.rs:1556-1573`）：
   - `destructive_hint = true` → 必须审批
   - `read_only_hint = true` → 不需要审批
   - 两者都未设置时，默认认为需要审批（安全优先）

2. **自动审批的安全监控**：即使策略为 `Approve`（自动放行），仍然通过 ARC（Automated Risk Control）监控器检查。监控器返回三种结果：
   - `Ok` → 放行
   - `AskUser(reason)` → 降级为用户审批，并在问题中展示原因
   - `SteerModel(reason)` → 直接阻断，返回安全拒绝消息（`mcp_tool_call.rs:856-871`）

3. **会话级审批记忆**：如果当前工具已在本次会话中被用户批准过（`mcp_tool_approval_is_remembered`），直接放行（`mcp_tool_call.rs:735-739`）

4. **Guardian 审核路径**：当配置了 Guardian 审核时，构建 `GuardianApprovalRequest::McpToolCall` 请求，交由独立的 Guardian 模型会话评估风险（`mcp_tool_call.rs:745-763`）

5. **用户审批路径**（两种实现）：
   - **Elicitation 模式**（`Feature::ToolCallMcpElicitation` 开启时）：通过 MCP 的 elicitation 协议发送结构化的审批表单，包含工具参数展示、持久化选项等丰富元数据（`mcp_tool_call.rs:794-833`）
   - **Legacy 模式**：通过 `request_user_input` 发送简单的选项列表（`mcp_tool_call.rs:835-853`）

6. **审批决策种类**（`McpToolApprovalDecision`，`mcp_tool_call.rs:552-559`）：

| 决策 | 含义 |
|------|------|
| `Accept` | 单次允许 |
| `AcceptForSession` | 本次会话内同一工具自动放行 |
| `AcceptAndRemember` | 持久化到配置文件，未来调用都自动放行 |
| `Decline` | 拒绝（来自 Guardian 或合成拒绝标记） |
| `Cancel` | 用户取消 |
| `BlockedBySafetyMonitor(msg)` | 被 ARC 安全监控器阻断 |

7. **持久化审批**（`maybe_persist_mcp_tool_approval`，`mcp_tool_call.rs:1443-1474`）：
   - Codex Apps 工具：写入 `apps.<connector_id>.tools.<tool>.approval_mode = "approve"`
   - 自定义 MCP 工具：写入 `mcp_servers.<server>.tools.<tool>.approval_mode = "approve"`
   - 优先写入项目级配置（如果该服务器在项目配置中定义），否则写入全局配置

### 3. 审批模板渲染（`mcp_tool_approval_templates.rs`）

模板系统将 MCP 工具调用转换为用户友好的审批消息：

1. **模板加载**：在进程启动时通过 `LazyLock` 从编译期嵌入的 `consequential_tool_message_templates.json` 文件中加载模板列表，并校验 schema 版本号（当前为 v4）（`mcp_tool_approval_templates.rs:71-92`）

2. **模板匹配**：根据 `(server_name, connector_id, tool_title)` 三元组精确匹配模板（`mcp_tool_approval_templates.rs:104-108`）

3. **问题文本渲染**：将模板中的 `{connector_name}` 占位符替换为实际的 connector 名称。如果模板包含占位符但 `connector_name` 为空，返回 `None`（`mcp_tool_approval_templates.rs:126-140`）

4. **参数展示渲染**：
   - 模板中定义的参数按定义顺序排列，使用 `label` 作为展示名
   - 未在模板中定义的剩余参数按字母排序追加，使用原始参数名作为展示名
   - 如果 label 重命名会导致名称冲突，返回 `None`（`mcp_tool_approval_templates.rs:142-190`）

### 4. MCP 技能依赖管理（`mcp_skill_dependencies.rs`）

当用户提及某个 skill 时，该流程检测并安装 skill 所需的 MCP 服务器依赖：

1. **前置检查**：仅对第一方客户端（`is_first_party_originator`）和启用了 `SkillMcpDependencyInstall` 特性标志的环境生效（`mcp_skill_dependencies.rs:40-52`）

2. **缺失依赖收集**（`collect_missing_mcp_dependencies`，`mcp_skill_dependencies.rs:413-468`）：
   - 遍历所有提及的 skill 的 `dependencies.tools`
   - 过滤出 `type = "mcp"` 的依赖
   - 通过 `canonical_mcp_server_key` / `canonical_mcp_dependency_key` 生成规范化 key（格式：`mcp__<transport>__<identifier>`），与已安装服务器列表比对

3. **去重已提示过的依赖**：通过 `filter_prompted_mcp_dependencies` 过滤掉本次会话中已经提示过用户的依赖，避免重复打扰（`mcp_skill_dependencies.rs:286-300`）

4. **用户确认**（`should_install_mcp_dependencies`，`mcp_skill_dependencies.rs:215-284`）：
   - 全访问模式下自动安装
   - 否则通过 `request_user_input` 弹出"Install / Continue anyway"选择
   - 支持 `CancellationToken` 取消

5. **安装执行**（`maybe_install_mcp_dependencies`，`mcp_skill_dependencies.rs:75-213`）：
   - 将缺失的服务器配置写入全局 MCP 配置（通过 `ConfigEditsBuilder`）
   - 对每个新增服务器检测是否需要 OAuth 认证（`oauth_login_support`）
   - 需要时执行 OAuth 登录流程（`perform_oauth_login`），失败后如果是 scope 被拒绝，会尝试不带 scope 重试
   - 最后调用 `sess.refresh_mcp_servers_now` 刷新运行时的 MCP 服务器连接

## 函数签名与参数说明

### `McpManager`（`mcp.rs`）

```rust
pub struct McpManager {
    plugins_manager: Arc<PluginsManager>,
}
```

| 方法 | 返回值 | 说明 |
|------|--------|------|
| `configured_servers(&self, config: &Config)` | `HashMap<String, McpServerConfig>` | 返回配置文件中声明的所有 MCP 服务器（包括禁用的） |
| `effective_servers(&self, config: &Config, auth: Option<&CodexAuth>)` | `HashMap<String, McpServerConfig>` | 返回实际生效的 MCP 服务器（考虑认证状态后的有效集合） |
| `tool_plugin_provenance(&self, config: &Config)` | `ToolPluginProvenance` | 返回工具到插件的来源映射关系 |

### `handle_mcp_tool_call`（`mcp_tool_call.rs:70-353`）

```rust
pub(crate) async fn handle_mcp_tool_call(
    sess: Arc<Session>,
    turn_context: &Arc<TurnContext>,
    call_id: String,
    server: String,
    tool_name: String,
    arguments: String,
) -> CallToolResult
```

MCP 工具调用的主入口。参数 `arguments` 为 JSON 字符串，空串合法。返回 `CallToolResult` 包含工具执行结果或错误信息。

### `render_mcp_tool_approval_template`（`mcp_tool_approval_templates.rs:53-69`）

```rust
pub(crate) fn render_mcp_tool_approval_template(
    server_name: &str,
    connector_id: Option<&str>,
    connector_name: Option<&str>,
    tool_title: Option<&str>,
    tool_params: Option<&Value>,
) -> Option<RenderedMcpToolApprovalTemplate>
```

根据服务器名、connector 和工具标题匹配内置模板，渲染人类可读的审批消息。无匹配模板时返回 `None`。

### `maybe_prompt_and_install_mcp_dependencies`（`mcp_skill_dependencies.rs:33-73`）

```rust
pub(crate) async fn maybe_prompt_and_install_mcp_dependencies(
    sess: &Session,
    turn_context: &TurnContext,
    cancellation_token: &CancellationToken,
    mentioned_skills: &[SkillMetadata],
)
```

检测被提及 skill 的 MCP 依赖缺失情况，提示用户安装，并执行配置写入和 OAuth 登录。

## 接口/类型定义

### `McpToolApprovalDecision`（`mcp_tool_call.rs:552-559`）

内部枚举，表示审批流程的最终决策结果。`BlockedBySafetyMonitor(String)` 变体携带安全监控器给出的阻断原因。

### `McpToolApprovalMetadata`（`mcp_tool_call.rs:561-569`）

```rust
pub(crate) struct McpToolApprovalMetadata {
    annotations: Option<ToolAnnotations>,
    connector_id: Option<String>,
    connector_name: Option<String>,
    connector_description: Option<String>,
    tool_title: Option<String>,
    tool_description: Option<String>,
    codex_apps_meta: Option<serde_json::Map<String, serde_json::Value>>,
}
```

从 MCP 工具注册信息中提取的元数据，用于审批提示构建和 Guardian 审核请求。

### `RenderedMcpToolApprovalTemplate`（`mcp_tool_approval_templates.rs:18-23`）

```rust
pub(crate) struct RenderedMcpToolApprovalTemplate {
    pub(crate) question: String,
    pub(crate) elicitation_message: String,
    pub(crate) tool_params: Option<Value>,
    pub(crate) tool_params_display: Vec<RenderedMcpToolApprovalParam>,
}
```

模板渲染结果。`question` 和 `elicitation_message` 当前值相同；`tool_params_display` 包含带 `display_name` 的参数列表供 UI 展示。

### `ConsequentialToolMessageTemplate`（`mcp_tool_approval_templates.rs:39-45`）

内部反序列化结构，对应 JSON 模板文件中的单条模板记录。匹配键为 `(server_name, connector_id, tool_title)` 三元组。

## 配置项与默认值

| 配置 / Feature Flag | 影响 | 默认 |
|---------------------|------|------|
| `mcp_servers.<server>.tools.<tool>.approval_mode` | 自定义 MCP 工具的审批模式（`approve` / `auto` / `prompt`） | `auto` |
| `apps.<connector>.tools.<tool>.approval_mode` | Codex Apps 工具的审批模式 | `auto` |
| `Feature::ToolCallMcpElicitation` | 启用 MCP elicitation 协议进行审批（替代 legacy `request_user_input`） | 关闭 |
| `Feature::SkillMcpDependencyInstall` | 启用 skill 的 MCP 依赖自动安装提示 | 关闭 |
| `memories.no_memories_if_mcp_or_web_search` | MCP 调用后禁止从该线程提取记忆 | `false` |
| 模板 schema 版本 | `consequential_tool_message_templates.json` 的版本号 | `4` |

## 边界 Case 与注意事项

- **全访问模式绕过审批**：当 `AskForApproval::Never` 且沙盒策略为 `DangerFullAccess` 或 `ExternalSandbox` 时，所有审批检查被跳过。两处代码（`mcp_tool_call.rs:951-957` 和 `mcp_skill_dependencies.rs:308-314`）独立维护了相同的判断逻辑。

- **模板匹配为精确匹配**：`(server_name, connector_id, tool_title)` 必须完全一致才能命中模板，tool_title 不同大小写会导致不匹配。

- **参数 label 冲突保护**：如果模板中定义的 label 与某个未被模板覆盖的原始参数名冲突，`render_tool_params` 返回 `None`，整个模板渲染失败，退回到默认审批消息。

- **图片内容降级**：当模型不支持图片输入时，MCP 工具返回的 `image` 类型内容块会被替换为文本占位符 `"<image content omitted because you do not support image input>"`。

- **OAuth 登录重试策略**：安装 MCP 依赖时，如果 OAuth provider 拒绝了请求的 scope，会自动尝试不带 scope 重试一次（`mcp_skill_dependencies.rs:164-191`）。

- **`Prompt` 模式下降级持久选项**：如果审批模式是 `Prompt`（而非 `Auto`），用户选择的 "Allow for this session" 或 "Allow and don't ask again" 会被降级为单次 `Accept`（`mcp_tool_call.rs:1390-1404`）。

- **会话内去重提示**：MCP 依赖安装提示使用规范化 key（`mcp__<transport>__<identifier>`）追踪已提示过的依赖，同一会话内不会重复弹出相同依赖的安装提示。