# ToolConfig — 工具配置层

## 概述与职责

`tool_config.rs` 是 **ToolDefinitions** 子系统的核心配置模块，负责根据模型能力、沙箱策略、会话来源（TUI / AppServer / CLI）、Feature Flag 和运行平台，计算出当前会话应该启用哪些工具变体和能力。

在整体架构中，该模块位于 **ToolSystem → ToolDefinitions** 层级下。ToolSystem 负责定义、发现和执行 Agent 工具，而 ToolDefinitions 是其中的工具定义与注册中心。`ToolConfig` 则是 ToolDefinitions 内部的"决策引擎"——它不定义工具本身，而是决定**哪些工具该被激活、以何种方式运行**。同级模块包括 Skills（技能管理）、ApplyPatch（补丁应用）、FileSearch（文件搜索）、ShellCommand（Shell 命令解析）等。

> 源码位置：`codex-rs/tools/src/tool_config.rs`

## 关键类型定义

### `ShellCommandBackendConfig`

Shell 命令的后端执行策略枚举（`tool_config.rs:19-23`）：

| 变体 | 说明 |
|------|------|
| `Classic` | 传统 Shell 执行方式 |
| `ZshFork` | 使用 Zsh fork 模式执行，通过预 fork 的 Zsh 进程加速命令启动 |

### `ToolUserShellType`

用户 Shell 类型检测结果（`tool_config.rs:25-32`）：

- `Zsh`、`Bash`、`PowerShell`、`Sh`、`Cmd` —— 覆盖所有主流 Shell 类型，用于决定 Shell 后端行为。

### `UnifiedExecShellMode`

统一执行 Shell 模式（`tool_config.rs:34-38`）：

| 变体 | 说明 |
|------|------|
| `Direct` | 直接执行，不使用特殊 Shell 优化 |
| `ZshFork(ZshForkConfig)` | 携带 Zsh fork 配置的优化模式 |

### `ZshForkConfig`

Zsh fork 模式所需的路径配置（`tool_config.rs:40-44`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `shell_zsh_path` | `AbsolutePathBuf` | Zsh 可执行文件的绝对路径 |
| `main_execve_wrapper_exe` | `AbsolutePathBuf` | execve wrapper 可执行文件的绝对路径，用于 fork 后的进程替换 |

### `ToolsConfigParams`

构建 `ToolsConfig` 所需的输入参数（`tool_config.rs:114-122`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `model_info` | `&ModelInfo` | 当前模型的能力描述（支持的 shell 类型、apply-patch 类型、输入模态等） |
| `available_models` | `&[ModelPreset]` | 可用模型预设列表 |
| `features` | `&Features` | Feature Flag 集合，控制各功能开关 |
| `web_search_mode` | `Option<WebSearchMode>` | Web 搜索模式配置 |
| `session_source` | `SessionSource` | 会话来源（TUI、AppServer、CLI、SubAgent 等） |
| `sandbox_policy` | `&SandboxPolicy` | 当前沙箱执行策略 |
| `windows_sandbox_level` | `WindowsSandboxLevel` | Windows 平台的沙箱级别 |

### `ToolsConfig`

最终的工具配置结构体，包含 20+ 个字段（`tool_config.rs:83-112`），涵盖所有工具的启用/禁用状态。关键字段分为以下几类：

**Shell 执行相关**：
- `shell_type: ConfigShellToolType` — Shell 工具类型（`Disabled` / `ShellCommand` / `UnifiedExec`）
- `shell_command_backend: ShellCommandBackendConfig` — Shell 后端策略
- `unified_exec_shell_mode: UnifiedExecShellMode` — 统一执行 Shell 模式
- `allow_login_shell: bool` — 是否允许登录 Shell

**工具启用开关**：
- `apply_patch_tool_type: Option<ApplyPatchToolType>` — apply-patch 工具类型（`Freeform` / `Function` / 禁用）
- `code_mode_enabled` / `code_mode_only_enabled` — Code Mode 开关
- `js_repl_enabled` / `js_repl_tools_only` — JavaScript REPL 开关
- `search_tool` / `tool_suggest` — 搜索和工具建议功能
- `image_gen_tool` — 图像生成工具
- `collab_tools` / `multi_agent_v2` — 协作工具和多 Agent v2 协议
- `agent_jobs_tools` / `agent_jobs_worker_tools` — Agent 任务调度工具

**权限与交互**：
- `exec_permission_approvals_enabled` — 执行权限审批
- `request_permissions_tool_enabled` — 权限请求工具
- `request_user_input` / `default_mode_request_user_input` — 用户输入请求能力

**其他**：
- `web_search_mode` / `web_search_config` / `web_search_tool_type` — Web 搜索配置
- `can_request_original_image_detail` — 是否可请求原始图像细节
- `experimental_supported_tools: Vec<String>` — 实验性工具列表
- `agent_type_description: String` — Agent 类型描述文本

## 关键流程

### ToolsConfig 构建流程

`ToolsConfig::new()` 是核心构建方法（`tool_config.rs:125-227`），完整决策链如下：

1. **Feature Flag 求值**：逐一检查各 Feature 是否启用，包括 `ApplyPatchFreeform`、`CodeMode`、`CodeModeOnly`、`JsRepl`、`Collab`、`MultiAgentV2`、`SpawnCsv` 等。部分功能有级联依赖——例如 `CodeModeOnly` 需要 `CodeMode` 同时启用，`JsReplToolsOnly` 需要 `JsRepl` 启用。

2. **会话来源影响**：SubAgent 会话会禁用 `request_user_input`（子 Agent 不应直接向用户请求输入，`tool_config.rs:144`）。Agent Jobs Worker 工具仅在来源标签以 `"agent_job:"` 开头的 SubAgent 会话中启用（`tool_config.rs:191-196`）。

3. **Shell 后端选择**（`tool_config.rs:157-183`）：
   - 若 `ShellTool` 未启用 → `Disabled`
   - 若 `ShellZshFork` 启用 → `ShellCommand` + `ZshFork` 后端
   - 若 `UnifiedExec` 启用且环境允许（通过 `unified_exec_allowed_in_environment` 检查）且 conpty 可用 → `UnifiedExec`
   - 若模型偏好 `UnifiedExec` 但环境不允许 → 降级为 `ShellCommand`
   - 否则使用模型默认的 `shell_type`

4. **Apply Patch 类型选择**（`tool_config.rs:185-189`）：优先使用模型指定的类型（`Freeform` 或 `Function`）；若模型未指定，则在 Feature Flag 启用时默认使用 `Freeform`。

5. **模型能力约束**：图像生成需要模型支持 `Image` 输入模态；搜索工具需要模型的 `supports_search_tool` 为 true；工具建议需要 `ToolSuggest` + `Apps` + `Plugins` 三个 Feature 同时启用。

### UnifiedExec 环境检查

`unified_exec_allowed_in_environment()`（`tool_config.rs:279-290`）决定 UnifiedExec 模式是否可用：

- 在非 Windows 平台上总是允许
- 在 Windows 上，仅当沙箱禁用（`WindowsSandboxLevel::Disabled`）或使用完全访问/外部沙箱策略时才允许
- 这是因为 Windows 沙箱对 PTY/conpty 有特殊限制

### ZshFork 模式初始化

`UnifiedExecShellMode::for_session()`（`tool_config.rs:47-81`）决定是否启用 ZshFork 优化：

必须同时满足以下条件：
1. 运行在 Unix 平台（`cfg!(unix)`）
2. 后端配置为 `ZshFork`
3. 用户 Shell 类型为 `Zsh`
4. `shell_zsh_path` 和 `main_execve_wrapper_exe` 两个路径均已提供
5. 两个路径均能成功转换为 `AbsolutePathBuf`

任一条件不满足则降级为 `Direct` 模式。路径转换失败时会通过 `tracing::warn!` 输出警告日志。

## Builder 方法

`ToolsConfig` 提供链式 builder 方法，用于在 `new()` 之后进一步定制配置（`tool_config.rs:229-265`）：

- `with_agent_type_description(String)` — 设置 Agent 类型描述
- `with_allow_login_shell(bool)` — 控制是否允许登录 Shell
- `with_unified_exec_shell_mode(UnifiedExecShellMode)` — 直接设置 Shell 模式
- `with_unified_exec_shell_mode_for_session(...)` — 根据会话参数自动计算 Shell 模式
- `with_web_search_config(Option<WebSearchConfig>)` — 设置 Web 搜索配置

### `for_code_mode_nested_tools()`

为 Code Mode 嵌套工具生成配置副本（`tool_config.rs:267-272`）：克隆当前配置但禁用 `code_mode_enabled` 和 `code_mode_only_enabled`，防止 Code Mode 中递归嵌套 Code Mode。

## 边界 Case 与注意事项

- **Feature Flag 级联依赖**：`CodeModeOnly` 隐含要求 `CodeMode` 启用；`JsReplToolsOnly` 隐含要求 `JsRepl` 启用；`ToolSuggest` 需要 `Apps` 和 `Plugins` 三者同时启用。单独启用子 Flag 不会生效。
- **Windows 平台限制**：当 Windows 沙箱启用且不在 `DangerFullAccess` / `ExternalSandbox` 策略下时，`UnifiedExec` 模式被禁止，自动降级为 `ShellCommand`。
- **ZshFork 仅限 Unix + Zsh**：ZshFork 优化在非 Unix 平台或非 Zsh 用户下静默降级为 `Direct` 模式，不会报错。
- **SubAgent 行为差异**：SubAgent 会话不会获得 `request_user_input` 能力；仅特定标签格式的 SubAgent 会话才能获得 `agent_jobs_worker_tools`。
- **`unified_exec_shell_mode` 延迟初始化**：`new()` 中默认为 `Direct`，需要通过后续 builder 方法（`with_unified_exec_shell_mode_for_session`）传入用户 Shell 信息才能真正启用 ZshFork 模式。