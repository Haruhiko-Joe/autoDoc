# Protocol — 共享类型定义与数据模型

## 概述与职责

`codex-protocol` 是 Codex 代理系统的**规范 schema 层**，为所有 Core 子系统提供统一的类型定义和数据模型。它位于 Core 模块体系的最底层，被 TUI、CLI、AppServer、ToolSystem、Sandbox、ModelProviders 等几乎所有上层模块依赖。

在整体架构中，Protocol 的角色类似于一份"合约"：它定义了用户（客户端）与代理（服务端）之间的**通信线协议**（wire protocol），包括提交队列（Submission Queue）和事件队列（Event Queue）中所有消息的结构。同级的兄弟模块（如 ModelProviders、ToolSystem、Sandbox 等）都通过 Protocol 定义的类型进行数据交换。

crate 名称为 `codex-protocol`，对外暴露为 `codex_protocol`（`codex-rs/protocol/Cargo.toml:1-9`）。

## 关键流程

### SQ/EQ 异步通信模型

Protocol 的核心设计围绕 **Submission Queue / Event Queue** 模式构建，用于客户端和代理之间的异步通信。

1. **客户端 → 代理**：客户端构造一个 `Submission`，包含唯一 `id`、一个 `Op` 操作载荷和可选的 W3C 分布式追踪上下文（`codex-rs/protocol/src/protocol.rs:106-114`）
2. **Op 调度**：`Op` 枚举定义了所有可能的操作类型，包括 `UserInput`（用户输入）、`UserTurn`（完整的对话轮次）、`ExecApproval`（命令审批）、`PatchApproval`（补丁审批）、`Interrupt`（中断）、`Compact`（上下文压缩）等超过 30 种变体（`codex-rs/protocol/src/protocol.rs:214-511`）
3. **代理 → 客户端**：代理通过 `Event` 回传结果，包含关联的 Submission `id` 和一个 `EventMsg` 载荷（`codex-rs/protocol/src/protocol.rs:1209-1215`）
4. **EventMsg 分发**：`EventMsg` 枚举涵盖 60+ 种事件类型，从 `TurnStarted`/`TurnComplete` 生命周期事件，到 `AgentMessage`/`AgentMessageDelta` 流式输出，到 `ExecCommandBegin`/`ExecCommandEnd` 命令执行，再到各类审批请求事件（`codex-rs/protocol/src/protocol.rs:1223-1421`）

### 审批流程数据流

当代理需要执行需要用户确认的操作时：

1. 代理发出 `EventMsg::ExecApprovalRequest(ExecApprovalRequestEvent)` 事件，携带命令信息、cwd、可选的 execpolicy 修改提案和网络策略修改提案（`codex-rs/protocol/src/approvals.rs:173-219`）
2. 客户端收集用户决策，构造 `Op::ExecApproval { id, decision }` 提交回代理
3. `ReviewDecision` 枚举表达用户的裁定，包括 `Approved`（批准）、`ApprovedForSession`（本次会话批准）、`ApprovedExecpolicyAmendment`（批准并修改执行策略）、`Abort`（中止）等

对于补丁应用也有类似流程，通过 `ApplyPatchApprovalRequestEvent` 和 `Op::PatchApproval` 实现。

### TurnItem 与 Legacy Event 桥接

`TurnItem` 是新版对话项的统一枚举，包含 `UserMessage`、`AgentMessage`、`Reasoning`、`WebSearch`、`ImageGeneration` 等变体（`codex-rs/protocol/src/items.rs:27-36`）。每个变体都实现了 `as_legacy_events()` 方法，将新格式转换为旧的 `EventMsg` 以保持向后兼容：

```rust
// codex-rs/protocol/src/items.rs:398-409
pub fn as_legacy_events(&self, show_raw_agent_reasoning: bool) -> Vec<EventMsg> {
    match self {
        TurnItem::UserMessage(item) => vec![item.as_legacy_event()],
        TurnItem::AgentMessage(item) => item.as_legacy_events(),
        TurnItem::WebSearch(item) => vec![item.as_legacy_event()],
        // ...
    }
}
```

## 模块结构与核心类型

### 线协议（protocol.rs）

**`Submission`** — 提交队列入口：
| 字段 | 类型 | 说明 |
|------|------|------|
| id | String | 唯一标识，用于关联返回事件 |
| op | Op | 操作载荷 |
| trace | Option\<W3cTraceContext\> | 可选的分布式追踪上下文 |

**`Op`** — 操作枚举（`codex-rs/protocol/src/protocol.rs:214-511`），关键变体：
- `UserInput { items, final_output_json_schema }` — 基础用户输入
- `UserTurn { items, cwd, approval_policy, sandbox_policy, model, ... }` — 完整的用户轮次，包含所有上下文
- `OverrideTurnContext { ... }` — 更新持久化的轮次上下文，不触发输入
- `ExecApproval / PatchApproval` — 审批响应
- `ResolveElicitation` — MCP 诱导请求响应
- `InterAgentCommunication` — 代理间通信
- `Compact / Undo / ThreadRollback` — 上下文管理
- `Review` — 代码审查请求
- `Shutdown` — 关闭实例
- `RealtimeConversation*` — 实时语音对话生命周期

**`Event`** / **`EventMsg`** — 事件队列（`codex-rs/protocol/src/protocol.rs:1209-1421`），包含 60+ 种事件变体，主要分类：
- **生命周期**：`TurnStarted`、`TurnComplete`、`TurnAborted`、`ShutdownComplete`
- **内容流**：`AgentMessage`、`AgentMessageDelta`、`AgentReasoning`、`AgentReasoningDelta`
- **命令执行**：`ExecCommandBegin`、`ExecCommandOutputDelta`、`ExecCommandEnd`
- **审批请求**：`ExecApprovalRequest`、`ApplyPatchApprovalRequest`、`ElicitationRequest`
- **MCP**：`McpToolCallBegin`、`McpToolCallEnd`、`McpStartupUpdate`、`McpListToolsResponse`
- **协作模式**：`CollabAgentSpawnBegin/End`、`CollabAgentInteractionBegin/End` 等
- **杂项**：`TokenCount`、`ContextCompacted`、`PlanUpdate`、`StreamError`、`DeprecationNotice`

### 沙箱策略（protocol.rs）

**`SandboxPolicy`** — 定义命令执行的安全限制（`codex-rs/protocol/src/protocol.rs:793-855`）：
- `DangerFullAccess` — 无任何限制
- `ReadOnly { access, network_access }` — 只读访问，可选网络
- `ExternalSandbox { network_access }` — 进程已在外部沙箱中
- `WorkspaceWrite { writable_roots, read_only_access, network_access, ... }` — 可写工作区目录，自动保护 `.git`、`.codex`、`.agents` 目录为只读

`WritableRoot` 结构将可写根路径与其下应保持只读的子路径配对（`codex-rs/protocol/src/protocol.rs:862-886`），例如即使 cwd 可写，`.git/hooks` 也会被保护以防止权限提升。

**`AskForApproval`** — 审批策略（`codex-rs/protocol/src/protocol.rs:629-660`）：
- `UnlessTrusted` — 仅自动批准已知安全的只读命令
- `OnRequest`（默认）— 由模型决定何时请求审批
- `Never` — 从不请求审批
- `Granular(GranularApprovalConfig)` — 细粒度控制各类审批流

### 审批类型（approvals.rs）

**`ExecApprovalRequestEvent`** — 命令执行审批请求，携带命令详情、网络上下文、execpolicy 修改提案等（`codex-rs/protocol/src/approvals.rs:173-219`）。提供 `effective_available_decisions()` 方法自动推导可用决策选项。

**`GuardianAssessmentEvent`** — Guardian 子代理审查事件（`codex-rs/protocol/src/approvals.rs:148-171`），包含风险评分（0-100）、风险等级（Low/Medium/High）和审查理由。`GuardianAssessmentAction` 枚举覆盖命令执行、execve、补丁应用、网络访问、MCP 工具调用五种场景。

**`ElicitationRequest`** — MCP 诱导请求，支持 `Form`（表单）和 `Url`（URL 重定向）两种模式（`codex-rs/protocol/src/approvals.rs:281-305`）。

### 对话项（items.rs）

**`TurnItem`** — 对话轮次的统一项类型（`codex-rs/protocol/src/items.rs:27-36`）：
- `UserMessage` — 用户消息，内部通过 `UserInput` 向量承载文本、图片、技能、Mention 等
- `HookPrompt` — 生命周期钩子注入的提示，通过 XML 格式序列化/反序列化以嵌入 hook_run_id
- `AgentMessage` — 代理回复，携带可选的 `MessagePhase`（Commentary/FinalAnswer）和 `MemoryCitation`
- `Reasoning` — 推理摘要和原始推理内容
- `WebSearch` / `ImageGeneration` — 工具调用结果项
- `ContextCompaction` — 上下文压缩标记

### 用户输入（user_input.rs）

**`UserInput`** — 用户输入的统一枚举（`codex-rs/protocol/src/user_input.rs:11-40`）：
- `Text { text, text_elements }` — 纯文本，附带 `TextElement` 标记特殊 UI 元素（如图片占位符）的字节范围
- `Image { image_url }` — base64 data URI 图片
- `LocalImage { path }` — 本地图片路径，请求序列化时转为 base64
- `Skill { name, path }` — 用户选择的技能
- `Mention { name, path }` — 显式的结构化提及（如 `app://<connector-id>`）

单条文本输入限制为 `MAX_USER_INPUT_TEXT_CHARS = 1 << 20`（约 1MB）。

### 权限模型（permissions.rs）

**`FileSystemSandboxPolicy`** — 文件系统沙箱策略（`codex-rs/protocol/src/permissions.rs:135-140`），由 `kind`（Restricted/Unrestricted/ExternalSandbox）和 `entries` 列表组成。每个 `FileSystemSandboxEntry` 指定一个路径和访问模式（Read/Write/None）。

**`FileSystemPath`** 支持两种路径形式：
- `Path { path }` — 绝对路径
- `Special { value }` — 特殊路径标记，如 `Root`、`CurrentWorkingDirectory`、`ProjectRoots`、`Tmpdir`、`SlashTmp`，以及 `Unknown` 用于前向兼容

**`NetworkSandboxPolicy`** — 网络沙箱策略，Restricted（默认）或 Enabled。

### 模型元数据（openai_models.rs）

**`ModelInfo`** — 后端 `/models` 端点返回的模型元数据（`codex-rs/protocol/src/openai_models.rs:243-294`），关键字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| slug | String | 模型标识符（如 "gpt-5"） |
| display_name | String | UI 展示名称 |
| shell_type | ConfigShellToolType | Shell 工具类型 |
| supported_reasoning_levels | Vec\<ReasoningEffortPreset\> | 支持的推理努力等级 |
| context_window | Option\<i64\> | 上下文窗口大小 |
| truncation_policy | TruncationPolicyConfig | 输出截断策略 |
| input_modalities | Vec\<InputModality\> | 支持的输入模态（Text/Image） |

**`ModelPreset`** — 面向 UI 的模型预设，从 `ModelInfo` 转换而来，增加 `is_default`、`show_in_picker` 等 UI 相关字段。

**`ReasoningEffort`** — 推理努力等级枚举：None、Minimal、Low、Medium（默认）、High、XHigh。

### 配置类型（config_types.rs）

定义各种配置枚举和结构：

- **`CollaborationMode`** — 协作模式（`codex-rs/protocol/src/config_types.rs:434-439`），由 `ModeKind`（Plan/Default）和 `Settings`（model、reasoning_effort、developer_instructions）组成
- **`ApprovalsReviewer`** — 审批审查者：User（默认）或 GuardianSubagent
- **`Personality`** — 人格风格：None、Friendly、Pragmatic
- **`ServiceTier`** — 服务层级：Fast、Flex
- **`WebSearchMode/Config`** — Web 搜索配置，包含域名过滤、地理位置、上下文大小
- **`ModelProviderAuthInfo`** — 模型提供者认证配置，通过外部命令获取 bearer token
- **`AltScreenMode`** — 终端备用屏幕模式：Auto（默认，在 Zellij 中自动禁用）、Always、Never

### MCP 类型（mcp.rs）

为 Model Context Protocol 值提供 TS/JSON Schema 友好的类型（`codex-rs/protocol/src/mcp.rs:1-9`）：

- **`Tool`** — MCP 工具定义，含 name、description、input_schema、output_schema、annotations
- **`Resource`** — MCP 资源，含 name、uri、mime_type、size
- **`ResourceTemplate`** — MCP 资源模板，含 uri_template
- **`CallToolResult`** — 工具调用返回结果
- **`RequestId`** — 请求 ID，可以是 String 或 Integer

每个类型都提供 `from_mcp_value()` 工厂方法，通过内部 `*Serde` 辅助结构支持 camelCase/snake_case 双重反序列化，兼容来自 `rmcp` 的 wire JSON。

### 错误类型（error.rs）

**`CodexErr`** — 核心错误枚举（`codex-rs/protocol/src/error.rs:67-159`），30+ 变体覆盖所有故障场景：
- 网络相关：`Stream`、`ConnectionFailed`、`ResponseStreamFailed`、`InternalServerError`
- 资源限制：`ContextWindowExceeded`、`UsageLimitReached`、`QuotaExceeded`、`ServerOverloaded`
- 认证相关：`RefreshTokenFailed`、`UsageNotIncluded`
- 沙箱相关：`Sandbox(SandboxErr)`（嵌套枚举，含 Denied/Timeout/Signal）
- 会话相关：`TurnAborted`、`Interrupted`、`ThreadNotFound`、`AgentLimitReached`

关键方法：
- `is_retryable()` — 判断错误是否可重试（`codex-rs/protocol/src/error.rs:168-203`）
- `to_codex_protocol_error()` — 转换为面向客户端的 `CodexErrorInfo` 枚举
- `to_error_event()` — 生成 `ErrorEvent` 用于事件流

**`UsageLimitReachedError`** 根据用户的 `PlanType`（Free/Plus/Pro/Team/Enterprise 等）生成差异化的提示信息和升级引导。

### 动态工具（dynamic_tools.rs）

**`DynamicToolSpec`** — 动态工具规格（`codex-rs/protocol/src/dynamic_tools.rs:8-16`），含 name、description、input_schema 和 `defer_loading` 标志（兼容旧版的 `expose_to_context` 字段取反）。

**`DynamicToolCallRequest`** / **`DynamicToolResponse`** — 动态工具调用的请求/响应对，响应内容支持文本和图片两种类型。

### 辅助类型

- **`AgentPath`**（`codex-rs/protocol/src/agent_path.rs`）— 代理层级路径（如 `/root/researcher/worker`），强制以 `/root` 开头，段名只允许小写字母、数字和下划线
- **`ThreadId`**（`codex-rs/protocol/src/thread_id.rs`）— 基于 UUID v7 的线程标识符，序列化为字符串
- **`HistoryEntry`**（`codex-rs/protocol/src/message_history.rs`）— 跨会话消息历史条目
- **`MemoryCitation`**（`codex-rs/protocol/src/memory_citation.rs`）— 记忆引用，包含文件路径、行范围和注释
- **`ParsedCommand`**（`codex-rs/protocol/src/parse_command.rs`）— 解析后的命令分类（Read/ListFiles/Search/Unknown）
- **`ExecToolCallOutput`**（`codex-rs/protocol/src/exec_output.rs`）— 命令执行输出，含 exit_code、stdout、stderr、duration，内置智能编码检测（chardetng + encoding_rs），自动处理 Windows 遗留编码（CP1251/CP866）

### 认证类型

- **`PlanType`/`KnownPlan`**（`codex-rs/protocol/src/auth.rs`）— 用户付费计划类型（Free/Go/Plus/Pro/Team/Business/Enterprise/Edu），包含计划层级判断方法
- **`account::PlanType`**（`codex-rs/protocol/src/account.rs`）— 面向账户系统的计划类型枚举，含 `is_team_like()`/`is_business_like()` 分组辅助方法

## 接口与类型定义

### 跨系统常量

Protocol 定义了一组 XML 标签常量用于系统提示的结构化分段（`codex-rs/protocol/src/protocol.rs:88-103`）：

```rust
pub const USER_INSTRUCTIONS_OPEN_TAG: &str = "<user_instructions>";
pub const ENVIRONMENT_CONTEXT_OPEN_TAG: &str = "<environment_context>";
pub const APPS_INSTRUCTIONS_OPEN_TAG: &str = "<apps_instructions>";
pub const SKILLS_INSTRUCTIONS_OPEN_TAG: &str = "<skills_instructions>";
pub const COLLABORATION_MODE_OPEN_TAG: &str = "<collaboration_mode>";
```

### 序列化特征

所有核心类型都同时派生 `Serialize`、`Deserialize`（serde）、`JsonSchema`（schemars）和 `TS`（ts-rs），确保：
- JSON 线协议序列化/反序列化
- 自动生成 JSON Schema（用于配置验证）
- 自动生成 TypeScript 类型定义（用于 VS Code 扩展等 TS 客户端）

枚举类型统一使用 `#[serde(tag = "type")]` 内标签格式进行序列化。

## 边界 Case 与注意事项

- **向后兼容**：`EventMsg` 中的 `TurnStarted`/`TurnComplete` 在 v1 线格式中使用 `task_started`/`task_complete` 名称，通过 `#[serde(rename = "task_started", alias = "turn_started")]` 实现双向兼容
- **旧版桥接**：`HasLegacyEvent` trait 为 v2 格式的事件提供到 v1 `EventMsg` 的转换，确保旧客户端可继续工作
- **FileSystemSpecialPath::Unknown**：未知的特殊路径不会导致反序列化失败，而是被保留为 `Unknown` 变体，保证新版配置在旧运行时中也能加载
- **SandboxPolicy 的 `.git` 保护**：`WorkspaceWrite` 模式自动将 cwd 下的 `.git`、`.codex`、`.agents` 目录标记为只读，包括 worktree/submodule 场景下通过 `.git` 文件中的 gitdir 指针追踪到的实际 git 目录
- **编码检测启发式**：`exec_output.rs` 中的 `bytes_to_string_smart` 使用 chardetng 检测编码，但在 IBM866 被误判时（短字符串中 Windows-1252 智能标点被识别为西里尔字母），会启发式地回退到 Windows-1252
- **Op 枚举的 `#[non_exhaustive]`** 标记意味着匹配 Op 时必须包含通配分支，为未来新增操作保留扩展性