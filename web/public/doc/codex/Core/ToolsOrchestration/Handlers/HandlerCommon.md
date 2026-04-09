# Handler 公共基础设施（HandlerCommon）

## 概述与职责

本模块是 `codex-rs/core/src/tools/handlers/mod.rs`，作为 **Handlers** 子系统的入口文件，承担三项核心职责：

1. **子模块声明与类型再导出**：声明所有具体的 tool handler 子模块（shell、apply_patch、mcp、multi_agents 等），并将各 handler 类型通过 `pub use` 统一再导出，供 crate 其他部分直接使用。
2. **参数解析工具函数**：提供 `parse_arguments`、`parse_arguments_with_base_path`、`resolve_workdir_base_path` 三个通用函数，为所有 handler 统一处理 JSON 参数反序列化和工作目录解析。
3. **权限验证与计算**：提供 `normalize_and_validate_additional_permissions`、`apply_granted_turn_permissions`、`implicit_granted_permissions` 三个函数，实现附加权限的验证、归一化以及有效权限的合并计算。

在整体架构中，本模块属于 **Core → ToolsOrchestration → Handlers** 层级。它是 Handlers 子系统的"前厅"——ToolDispatch 通过这里找到各个 handler 类型，而各个 handler 实现则调用这里的参数解析和权限工具函数。

## 关键流程

### 参数解析流程

当 handler 需要将模型传来的 JSON 字符串解析为结构化参数时，有三种路径可选：

1. **`parse_arguments<T>(arguments)`**（`mod.rs:55-62`）：最基础的泛型反序列化，直接调用 `serde_json::from_str`，失败时包装为 `FunctionCallError::RespondToModel` 返回给模型。

2. **`parse_arguments_with_base_path<T>(arguments, base_path)`**（`mod.rs:64-73`）：在反序列化前先设置 `AbsolutePathBufGuard`，使得参数中的相对路径能在反序列化期间被正确解析为绝对路径。Guard 在函数返回时自动恢复。

3. **`resolve_workdir_base_path(arguments, default_cwd)`**（`mod.rs:75-89`）：从 JSON 参数中提取 `workdir` 字段。若存在且非空，通过 `crate::util::resolve_path` 将其相对于 `default_cwd` 解析；否则回退到 `default_cwd`。返回的路径通常用作后续 `parse_arguments_with_base_path` 的 `base_path` 参数。

### 附加权限验证流程（`normalize_and_validate_additional_permissions`）

此函数（`mod.rs:93-146`）在命令执行前校验 `with_additional_permissions` 的合法性，执行以下检查链：

1. **功能开关检查**：如果 `additional_permissions_allowed` 为 false 且权限未预批准（`permissions_preapproved` 为 false），但请求使用了附加权限，返回错误要求先启用 `features.exec_permission_approvals`。
2. **审批策略检查**：当 `sandbox_permissions` 为 `WithAdditionalPermissions` 时，如果审批策略不是 `OnRequest` 且权限未预批准，拒绝请求。
3. **必填参数检查**：必须提供 `additional_permissions`（包含 `network` 或 `file_system`）。
4. **归一化与非空检查**：调用 `normalize_additional_permissions` 对路径等进行归一化，并确保结果非空。
5. **一致性检查**：如果提供了 `additional_permissions` 但 `sandbox_permissions` 不是 `WithAdditionalPermissions`，返回错误。

### 有效权限计算流程（`apply_granted_turn_permissions`）

此异步函数（`mod.rs:171-214`）计算某次 tool 调用的最终有效权限，流程如下：

1. **短路处理**：如果 `sandbox_permissions` 为 `RequireEscalated`，直接返回，不合并已授权权限。
2. **合并已授权权限**：从 session 获取 `granted_session_permissions` 和 `granted_turn_permissions`，通过 `merge_permission_profiles` 合并为统一的已授权权限集。
3. **计算有效权限**：将请求的 `additional_permissions` 与已授权权限再次合并，得到 effective_permissions。
4. **判定是否预批准**：将 effective_permissions 与已授权权限做交集比较——如果交集等于 effective_permissions，说明所有请求的权限都已经被预先批准过。
5. **升级沙箱模式**：如果存在有效权限但原始 `sandbox_permissions` 不是 `WithAdditionalPermissions`，自动升级为 `WithAdditionalPermissions`。

### 隐式权限授予（`implicit_granted_permissions`）

函数（`mod.rs:154-169`）决定是否将已授予的 turn 权限隐式地应用到当前命令。只有当命令本身**既没有请求附加权限，也没有要求权限升级**时（`sandbox_permissions` 不是 `WithAdditionalPermissions` 或 `RequireEscalated`，且 `additional_permissions` 为 None），才会返回 effective 中已有的权限。这实现了"粘性权限"语义：一旦用户在本轮批准了权限，后续未显式请求权限的命令也能自动获得这些权限。

## 函数签名与参数说明

### `parse_arguments<T>(arguments: &str) -> Result<T, FunctionCallError>`

将 JSON 字符串反序列化为目标类型 `T`。

- **arguments**：模型传来的原始 JSON 字符串
- **返回**：反序列化成功返回 `T`，失败返回 `FunctionCallError::RespondToModel`

> 源码位置：`codex-rs/core/src/tools/handlers/mod.rs:55-62`

### `parse_arguments_with_base_path<T>(arguments: &str, base_path: &Path) -> Result<T, FunctionCallError>`

在 `AbsolutePathBufGuard` 保护下反序列化 JSON，使参数中的相对路径被解析为基于 `base_path` 的绝对路径。

- **arguments**：模型传来的原始 JSON 字符串
- **base_path**：路径解析的基准目录
- **返回**：同 `parse_arguments`

> 源码位置：`codex-rs/core/src/tools/handlers/mod.rs:64-73`

### `resolve_workdir_base_path(arguments: &str, default_cwd: &Path) -> Result<PathBuf, FunctionCallError>`

从 JSON 参数中提取 `workdir` 字段并解析为绝对路径。

- **arguments**：包含可选 `workdir` 字段的 JSON 字符串
- **default_cwd**：`workdir` 缺失或为空时的回退路径
- **返回**：解析后的工作目录路径

> 源码位置：`codex-rs/core/src/tools/handlers/mod.rs:75-89`

### `normalize_and_validate_additional_permissions(...) -> Result<Option<PermissionProfile>, String>`

验证并归一化附加权限请求。

| 参数 | 类型 | 说明 |
|------|------|------|
| additional_permissions_allowed | bool | `features.exec_permission_approvals` 功能开关 |
| approval_policy | AskForApproval | 当前审批策略 |
| sandbox_permissions | SandboxPermissions | 命令声明的沙箱权限级别 |
| additional_permissions | Option\<PermissionProfile\> | 请求的附加权限 |
| permissions_preapproved | bool | 权限是否已预先批准 |
| _cwd | &Path | 当前工作目录（目前未使用） |

- **返回**：归一化后的权限 `Some(PermissionProfile)` 或 `None`，验证失败返回 `Err(String)`

> 源码位置：`codex-rs/core/src/tools/handlers/mod.rs:93-146`

### `apply_granted_turn_permissions(session, sandbox_permissions, additional_permissions) -> EffectiveAdditionalPermissions`

异步计算有效权限，合并 session 级和 turn 级已授予权限。

> 源码位置：`codex-rs/core/src/tools/handlers/mod.rs:171-214`

### `implicit_granted_permissions(sandbox_permissions, additional_permissions, effective) -> Option<PermissionProfile>`

当命令未显式请求附加权限时，返回已授予的隐式粘性权限。

> 源码位置：`codex-rs/core/src/tools/handlers/mod.rs:154-169`

## 类型定义

### `EffectiveAdditionalPermissions`（`mod.rs:148-152`）

封装权限计算的最终结果，供 handler 在后续执行中使用。

| 字段 | 类型 | 说明 |
|------|------|------|
| sandbox_permissions | SandboxPermissions | 可能被升级后的沙箱权限级别 |
| additional_permissions | Option\<PermissionProfile\> | 合并后的有效附加权限 |
| permissions_preapproved | bool | 所有请求权限是否已被预先批准 |

可见性为 `pub(super)`，仅在 `tools` 模块内部使用。

## 再导出的 Handler 类型

本模块通过 `pub use` 将以下 handler 类型导出，这是 crate 其他部分引用 handler 的唯一入口：

| 再导出类型 | 来源模块 | 用途 |
|-----------|---------|------|
| ApplyPatchHandler | apply_patch | 文件补丁应用 |
| DynamicToolHandler | dynamic | 动态工具调度 |
| JsReplHandler / JsReplResetHandler | js_repl | JavaScript REPL 执行与重置 |
| ListDirHandler | list_dir | 目录列举 |
| McpHandler | mcp | MCP 工具调用 |
| McpResourceHandler | mcp_resource | MCP 资源访问 |
| PlanHandler | plan | 计划管理 |
| RequestPermissionsHandler | request_permissions | 权限请求 |
| RequestUserInputHandler | request_user_input | 用户输入请求 |
| ShellCommandHandler / ShellHandler | shell | Shell 命令执行 |
| TestSyncHandler | test_sync | 测试同步 |
| ToolSearchHandler | tool_search | 工具搜索 |
| ToolSuggestHandler | tool_suggest | 工具建议 |
| UnifiedExecHandler | unified_exec | 长运行进程管理 |
| ViewImageHandler | view_image | 图片查看 |
| CodeModeExecuteHandler / CodeModeWaitHandler | code_mode | 代码模式执行/等待（`pub(crate)` 可见性） |

## 边界 Case 与注意事项

- **`_cwd` 参数未使用**：`normalize_and_validate_additional_permissions` 的 `_cwd` 参数当前被忽略（下划线前缀），路径归一化由 `codex_sandboxing::normalize_additional_permissions` 内部处理。
- **`AbsolutePathBufGuard` 的作用域语义**：`parse_arguments_with_base_path` 中的 guard 利用 RAII 模式在反序列化期间临时设置全局的路径解析基准，函数返回后自动恢复。这意味着该函数的行为依赖于线程局部/全局状态。
- **预批准权限绕过功能开关**：当 `permissions_preapproved` 为 true 时，即使 `additional_permissions_allowed` 为 false 也允许使用附加权限。这支持 `request_permissions` 工具在功能特性未启用时仍能工作。
- **粘性权限的隐式应用**：`implicit_granted_permissions` 实现了"粘性"语义——本轮已授予的权限会自动应用到后续不显式请求权限的命令。但当命令显式请求了权限（`WithAdditionalPermissions`）或要求升级（`RequireEscalated`）时，不会使用隐式路径，避免权限混淆。
- **`RequireEscalated` 短路**：`apply_granted_turn_permissions` 对 `RequireEscalated` 类型直接短路返回，不合并任何已授权权限，确保需要提权的命令始终走完整审批流程。