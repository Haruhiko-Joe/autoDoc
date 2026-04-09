# ToolRegistryPlan — 工具注册计划构建器

## 概述与职责

`ToolRegistryPlan` 模块是 **ToolSystem → ToolDefinitions** 层级中的核心编排组件，负责在会话初始化时**组装完整的工具集合**。它根据当前会话的配置（`ToolsConfig`）和运行时参数（`ToolRegistryPlanParams`），调用各个 `create_*` 工厂函数生成工具定义（`ToolSpec`），并将每个工具与其执行方式（`ToolHandlerKind`）绑定，最终产出一个 `ToolRegistryPlan`——这是下游工具注册表和执行引擎的唯一输入。

在整体架构中，`ToolSystem` 负责定义、发现和执行 agent 工具，而本模块是 `ToolDefinitions` 子系统的一部分，与 `ApplyPatch`、`FileSearch`、`ShellCommand`、`Skills` 等同级模块协作。它不直接执行工具，而是**声明**哪些工具在当前会话中可用，以及它们应该由哪种 handler 来处理。

该模块由两个文件组成：
- `tool_registry_plan.rs`：包含核心编排函数 `build_tool_registry_plan()`
- `tool_registry_plan_types.rs`：定义所有相关类型（`ToolRegistryPlan`、`ToolHandlerKind`、`ToolHandlerSpec`、`ToolRegistryPlanParams`、`ToolRegistryPlanAppTool`）

## 关键类型定义

### `ToolHandlerKind`

枚举类型，标识工具应由哪种执行器处理。每个变体对应一种独立的执行路径：

| 变体 | 用途 |
|------|------|
| `Shell` / `ShellCommand` / `UnifiedExec` | 不同模式的 shell 命令执行 |
| `CodeModeExecute` / `CodeModeWait` | code-mode 工具及其等待机制 |
| `ApplyPatch` | 文件补丁应用 |
| `Mcp` / `McpResource` | MCP 协议工具及资源访问 |
| `SpawnAgentV1` / `SpawnAgentV2` 等 | 多 agent 协作（V1 和 V2 两套 API） |
| `JsRepl` / `JsReplReset` | JavaScript REPL |
| `ToolSearch` / `ToolSuggest` | 工具发现与推荐 |
| `Plan` / `ViewImage` / `ListDir` 等 | 其他内置工具 |
| `DynamicTool` | 动态注册的工具 |
| `AgentJobs` | 批量 agent 任务 |

> 源码位置：`codex-rs/tools/src/tool_registry_plan_types.rs:11-44`

### `ToolRegistryPlan`

最终产出结构，包含两个核心字段：

```rust
pub struct ToolRegistryPlan {
    pub specs: Vec<ConfiguredToolSpec>,   // 所有活跃的工具定义
    pub handlers: Vec<ToolHandlerSpec>,   // 工具名 → 执行器的映射
}
```

> 源码位置：`codex-rs/tools/src/tool_registry_plan_types.rs:52-56`

`push_spec()` 方法在添加工具时，如果 code-mode 启用，会自动调用 `augment_tool_spec_for_code_mode()` 对工具定义进行增强（`tool_registry_plan_types.rs:86-99`）。

### `ToolHandlerSpec`

简单的 `(name, kind)` 对，将工具名称映射到 `ToolHandlerKind`：

```rust
pub struct ToolHandlerSpec {
    pub name: String,
    pub kind: ToolHandlerKind,
}
```

### `ToolRegistryPlanParams`

运行时参数，携带会话级别的动态信息：

| 字段 | 类型 | 说明 |
|------|------|------|
| `mcp_tools` | `Option<&HashMap<String, McpTool>>` | 已连接的 MCP 服务器提供的工具集 |
| `app_tools` | `Option<&[ToolRegistryPlanAppTool]>` | 来自 Codex Apps 的应用工具 |
| `discoverable_tools` | `Option<&[DiscoverableTool]>` | 可供工具推荐的候选列表 |
| `dynamic_tools` | `&[DynamicToolSpec]` | 动态注册的工具 |
| `default_agent_type_description` | `&str` | 默认的 agent 类型描述 |
| `wait_agent_timeouts` | `WaitAgentTimeoutOptions` | agent 等待超时配置 |
| `codex_apps_mcp_server_name` | `&str` | Codex Apps MCP 服务器名称 |

> 源码位置：`codex-rs/tools/src/tool_registry_plan_types.rs:58-67`

### `ToolRegistryPlanAppTool`

描述来自 Codex Apps 的单个工具的元信息：

| 字段 | 类型 | 说明 |
|------|------|------|
| `tool_name` | `&str` | 工具名称 |
| `tool_namespace` | `&str` | 命名空间（用于构建 `namespace:name` 格式的标识） |
| `server_name` | `&str` | 所属 MCP 服务器名 |
| `connector_name` | `Option<&str>` | 连接器名称 |
| `connector_description` | `Option<&str>` | 连接器描述 |

> 源码位置：`codex-rs/tools/src/tool_registry_plan_types.rs:69-76`

## 关键流程 Walkthrough

`build_tool_registry_plan()` 是整个模块的核心函数（`tool_registry_plan.rs:65-488`）。它接收 `ToolsConfig`（静态配置）和 `ToolRegistryPlanParams`（运行时参数），按以下顺序组装工具计划：

### 1. Code-Mode 工具（递归构建）

如果 `config.code_mode_enabled` 为 true，函数会**递归调用自身**来构建嵌套工具集（`tool_registry_plan.rs:72-108`）。具体步骤：

1. 通过 `config.for_code_mode_nested_tools()` 生成嵌套配置（禁用 discoverable_tools）
2. 递归调用 `build_tool_registry_plan()` 获取嵌套计划
3. 从嵌套计划中提取所有工具定义，传给 `collect_code_mode_tool_definitions()`
4. 注册 code-mode 主工具（`CodeModeExecute`）和等待工具（`CodeModeWait`）

这个递归设计意味着 code-mode 工具内部可以访问几乎所有常规工具。

### 2. Shell 工具（按类型分支）

根据 `config.shell_type` 选择不同的 shell 工具变体（`tool_registry_plan.rs:110-162`）：

| `ConfigShellToolType` | 注册的工具 | Handler |
|----------------------|-----------|---------|
| `Default` | `shell` | `Shell` |
| `Local` | `local_shell` | `Shell` |
| `UnifiedExec` | `exec_command` + `write_stdin` | `UnifiedExec` |
| `ShellCommand` | `shell_command` | `ShellCommand` |
| `Disabled` | 无 | — |

注意：只要 shell 未被禁用，`shell`、`container.exec`、`local_shell`、`shell_command` 这些名称都会被注册到对应的 handler。

### 3. MCP 资源工具

当 `params.mcp_tools` 存在时，注册三个 MCP 资源相关工具：`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`（`tool_registry_plan.rs:164-183`）。

### 4. 常驻工具

以下工具无条件注册（或仅依赖简单的 feature flag）：

- **`update_plan`**：计划更新工具，始终注册（`tool_registry_plan.rs:185-190`）
- **`view_image`**：图片查看工具，始终注册（`tool_registry_plan.rs:334-341`）

### 5. 条件性内置工具

根据 `ToolsConfig` 中的各项开关，选择性注册：

- **JS REPL**（`js_repl_enabled`）：注册 `js_repl` 和 `js_repl_reset`（`tool_registry_plan.rs:192-205`）
- **用户输入请求**（`request_user_input`）：注册 `request_user_input`，描述文本根据 `default_mode_request_user_input` 动态生成（`tool_registry_plan.rs:207-219`）
- **权限请求**（`request_permissions_tool_enabled`）：注册 `request_permissions`（`tool_registry_plan.rs:221-228`）
- **工具搜索**（`search_tool` + `app_tools` 存在）：注册 `tool_search`，并为每个 app tool 以 `namespace:name` 格式注册 MCP handler（`tool_registry_plan.rs:230-254`）
- **工具推荐**（`tool_suggest` + `discoverable_tools` 非空）：注册 `tool_suggest`（`tool_registry_plan.rs:256-266`）
- **Apply Patch**（`apply_patch_tool_type` 存在）：根据 `Freeform` 或 `Function` 类型选择不同的补丁工具变体（`tool_registry_plan.rs:268-286`）
- **Web Search**（`web_search_mode` 等配置）：由 `create_web_search_tool()` 按配置决定是否返回工具（`tool_registry_plan.rs:314-324`）
- **Image Generation**（`image_gen_tool`）：注册图片生成工具，格式固定为 "png"（`tool_registry_plan.rs:326-332`）

### 6. 实验性工具

通过 `config.experimental_supported_tools` 列表控制：
- `list_dir`：目录列表工具（`tool_registry_plan.rs:288-299`）
- `test_sync_tool`：同步测试工具（`tool_registry_plan.rs:301-312`）

### 7. 协作（Collab）工具

当 `config.collab_tools` 启用时，根据 `config.multi_agent_v2` 选择 V1 或 V2 版本的多 agent 工具集（`tool_registry_plan.rs:343-423`）：

**V2 工具集**：`spawn_agent`、`send_message`、`followup_task`、`wait_agent`、`close_agent`、`list_agents`

**V1 工具集**：`spawn_agent`、`send_input`、`resume_agent`、`wait_agent`、`close_agent`

两个版本的 agent 类型描述通过 `agent_type_description()` 辅助函数获取——如果 `config.agent_type_description` 非空则用它，否则回退到 `default_agent_type_description`（`tool_registry_plan_types.rs:109-118`）。

### 8. Agent Jobs 工具

当 `config.agent_jobs_tools` 启用时注册 `spawn_agents_on_csv`，如果还启用了 `agent_jobs_worker_tools` 则额外注册 `report_agent_job_result`（`tool_registry_plan.rs:425-440`）。

### 9. MCP 工具（外部）

遍历 `params.mcp_tools` 中的所有 MCP 工具，通过 `mcp_tool_to_responses_api_tool()` 转换为 OpenAI Responses API 格式后注册，handler 统一为 `Mcp`（`tool_registry_plan.rs:442-466`）。工具按名称排序以保证确定性输出。转换失败时记录错误日志但不中断流程。

### 10. 动态工具

遍历 `params.dynamic_tools`，通过 `dynamic_tool_to_responses_api_tool()` 转换后注册，handler 为 `DynamicTool`（`tool_registry_plan.rs:468-485`）。同样，转换失败仅记录日志。

## 配置项与行为控制

`build_tool_registry_plan()` 的行为完全由 `ToolsConfig` 的以下字段驱动：

| 配置字段 | 控制的工具/行为 |
|----------|--------------|
| `code_mode_enabled` | code-mode 工具 + 所有工具的 code-mode 增强 |
| `code_mode_only_enabled` | code-mode 独占模式 |
| `shell_type` | shell 工具的变体选择 |
| `exec_permission_approvals_enabled` | shell 工具的权限审批 |
| `allow_login_shell` | UnifiedExec/ShellCommand 是否允许 login shell |
| `js_repl_enabled` | JS REPL 工具 |
| `request_user_input` | 用户输入请求工具 |
| `request_permissions_tool_enabled` | 权限请求工具 |
| `search_tool` | 工具搜索功能 |
| `tool_suggest` | 工具推荐功能 |
| `apply_patch_tool_type` | apply-patch 工具变体 |
| `web_search_mode` / `web_search_config` / `web_search_tool_type` | Web 搜索工具 |
| `image_gen_tool` | 图片生成工具 |
| `can_request_original_image_detail` | view_image 的原图请求能力 |
| `collab_tools` / `multi_agent_v2` | 多 agent 协作工具集版本 |
| `agent_jobs_tools` / `agent_jobs_worker_tools` | 批量 agent 任务工具 |
| `experimental_supported_tools` | 实验性工具白名单 |
| `available_models` | 传递给 spawn_agent 的可用模型列表 |

## 边界 Case 与注意事项

- **递归构建**：code-mode 的嵌套计划构建会递归调用 `build_tool_registry_plan()`，但会将 `discoverable_tools` 设为 `None`，避免在嵌套层级中重复注册 tool_suggest。
- **`push_spec` 的 code-mode 增强**：每个通过 `push_spec()` 添加的工具，如果 code-mode 启用，都会被 `augment_tool_spec_for_code_mode()` 自动修改——这意味着 code-mode 会影响所有工具的定义，而不仅仅是 code-mode 自身的工具。
- **MCP 工具排序**：MCP 工具在注册前按名称排序（`tool_registry_plan.rs:447`），确保相同输入产生相同的计划，便于调试和测试。
- **转换失败的容错**：MCP 工具和动态工具的转换失败不会导致整个计划构建失败，仅通过 `tracing::error!` 记录。
- **handler 名称解耦**：`register_handler` 中注册的名称是硬编码字符串（如 `"shell"`、`"apply_patch"`），与 `ToolSpec` 中的工具名称独立——这意味着 handler 映射和工具定义是松耦合的。
- **App tool 的双重注册**：tool_search 启用时，每个 app tool 会以 `namespace:name` 格式额外注册一个 `Mcp` handler（`tool_registry_plan.rs:248-253`），使得通过搜索发现的 app tool 能被正确路由。