# 脚本执行与长运行进程处理器（ScriptAndProcess）

## 概述与职责

本模块包含两组 tool handler 实现，位于 **Core → ToolsOrchestration → Handlers** 层级下，负责处理模型发起的脚本执行和长运行进程管理请求：

- **JsReplHandler / JsReplResetHandler**：将 JavaScript 代码评估委托给 JsReplKernel，提供 REPL 执行与会话重置能力。
- **UnifiedExecHandler**：通过 unified_exec ProcessManager 管理长运行进程的完整生命周期（启动 / 检查 / 终止 / 写入 stdin），支持权限提升和 apply-patch 拦截。

同级兄弟模块包括 shell 命令执行、apply-patch 文件编辑、多 Agent 协作、MCP 工具调用等其他 handler 实现。

---

## JsReplHandler：JavaScript REPL 执行

### 核心流程

1. **Feature 检查**：首先验证 `Feature::JsRepl` 是否启用，未启用则直接拒绝（`js_repl.rs:118-122`）
2. **参数解析**：根据 payload 类型走不同路径：
   - `ToolPayload::Function`：通过标准 `parse_arguments` 解析 JSON 参数
   - `ToolPayload::Custom`：调用 `parse_freeform_args` 解析自由格式的原始 JS 源码
3. **获取 Kernel 管理器**：通过 `turn.js_repl.manager()` 获取 `JsReplKernel` 的管理器实例（`js_repl.rs:133`）
4. **发送执行事件**：调用 `emit_js_repl_exec_begin` 发出 `ExecCommandBegin` 事件
5. **执行代码**：调用 `manager.execute()` 将代码交给 Deno 内核执行（`js_repl.rs:136-138`）
6. **构建输出**：将执行结果的 `output` 文本和 `content_items`（可能包含图片等富内容）组装为 `FunctionToolOutput`
7. **发送完成事件**：调用 `emit_js_repl_exec_end` 发出成功或失败事件

### 自由格式参数解析（parse_freeform_args）

`parse_freeform_args` 函数（`js_repl.rs:205-269`）处理模型以原始文本形式提交的 JS 代码，支持可选的 pragma 指令：

```
// codex-js-repl: timeout_ms=15000
console.log('ok');
```

解析规则：
- **无 pragma**：整个输入作为 JS 代码
- **有 pragma**：第一行以 `// codex-js-repl:` 开头，后跟空格分隔的 `key=value` 键值对（目前仅支持 `timeout_ms`），剩余行作为代码
- **防护性校验**：`reject_json_or_quoted_source`（`js_repl.rs:271-289`）拒绝 JSON 包装的代码（如 `{"code":"..."}` ）和 Markdown 代码围栏，引导模型发送原始 JS

### JsReplResetHandler

`JsReplResetHandler`（`js_repl.rs:183-203`）是一个轻量 handler，调用 `manager.reset()` 重置 REPL 会话状态，返回确认文本 `"js_repl kernel reset"`。同样受 `Feature::JsRepl` feature flag 控制。

### 辅助函数

| 函数 | 位置 | 说明 |
|------|------|------|
| `join_outputs` | `js_repl.rs:28-36` | 合并 stdout/stderr，非空部分用换行拼接 |
| `build_js_repl_exec_output` | `js_repl.rs:38-54` | 构造 `ExecToolCallOutput`，根据是否有 error 设置 exit_code (0/1) |
| `emit_js_repl_exec_begin` | `js_repl.rs:56-69` | 发出 ExecCommandBegin 生命周期事件 |
| `emit_js_repl_exec_end` | `js_repl.rs:71-93` | 发出 ExecCommandEnd 事件，区分 Success/Failure 阶段 |

---

## UnifiedExecHandler：长运行进程管理

### 核心流程

`UnifiedExecHandler` 的 `handle` 方法（`unified_exec.rs:159-364`）根据 `tool_name` 分发到两个子操作：

#### exec_command 流程

1. **解析参数**：反序列化为 `ExecCommandArgs` 结构体
2. **隐式 skill 检测**：调用 `maybe_emit_implicit_skill_invocation` 检查命令是否触发隐式 skill
3. **分配进程 ID**：通过 `manager.allocate_process_id()` 获取唯一 ID
4. **构建 shell 命令**：调用 `get_command()` 根据 shell 模式组装完整命令行
5. **权限提升处理**（`unified_exec.rs:217-275`）：
   - 应用已授权的 turn 级权限（`apply_granted_turn_permissions`）
   - 检查沙箱覆盖请求是否与审批策略兼容——在非 `OnRequest` 策略下拒绝权限提升
   - 规范化额外权限配置（`normalize_and_validate_additional_permissions`）
6. **apply-patch 拦截**：调用 `intercept_apply_patch`（`unified_exec.rs:277-301`）检查命令是否为 apply-patch 调用，如果是则走专用补丁处理路径，跳过常规执行
7. **执行命令**：调用 `manager.exec_command()` 提交到 ProcessManager 异步执行
8. **遥测**：通过 `emit_unified_exec_tty_metric` 记录 TTY/非 TTY 使用计数

#### write_stdin 流程

1. **解析参数**：反序列化为 `WriteStdinArgs`，包含 `session_id`（即进程 ID）和要写入的字符
2. **写入 stdin**：调用 `manager.write_stdin()` 向运行中的进程发送输入
3. **发送交互事件**：构造 `TerminalInteractionEvent` 并通过 session 事件流发送

### 类型定义

#### ExecCommandArgs

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `cmd` | `String` | — | 要执行的命令字符串 |
| `workdir` | `Option<String>` | `None` | 工作目录（相对路径会基于 turn cwd 解析） |
| `shell` | `Option<String>` | `None` | 指定 shell 路径（如 `/bin/bash`、`powershell`、`cmd`） |
| `login` | `Option<bool>` | `None` | 是否使用 login shell |
| `tty` | `bool` | `false` | 是否分配 TTY |
| `yield_time_ms` | `u64` | `10000` | 等待初始输出的超时毫秒数 |
| `max_output_tokens` | `Option<usize>` | `None` | 输出 token 上限 |
| `sandbox_permissions` | `SandboxPermissions` | 默认 | 沙箱权限配置 |
| `additional_permissions` | `Option<PermissionProfile>` | `None` | 请求的额外权限（文件系统读写等） |
| `justification` | `Option<String>` | `None` | 权限请求理由 |
| `prefix_rule` | `Option<Vec<String>>` | `None` | 命令前缀规则 |

#### WriteStdinArgs

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `session_id` | `i32` | — | 目标进程 ID |
| `chars` | `String` | `""` | 要写入 stdin 的字符 |
| `yield_time_ms` | `u64` | `250` | 等待输出超时 |
| `max_output_tokens` | `Option<usize>` | `None` | 输出 token 上限 |

### get_command：Shell 命令构建

`get_command` 函数（`unified_exec.rs:375-407`）根据 shell 模式构建最终的命令行参数数组：

- **Direct 模式**：使用模型指定的 shell（如有）或会话默认 shell，通过 `shell.derive_exec_args()` 生成参数。模型可指定 `/bin/bash`、`powershell`、`cmd` 等不同 shell
- **ZshFork 模式**：忽略模型指定的 shell，强制使用配置的 zsh 路径，生成 `[zsh_path, "-c"/"-lc", cmd]` 格式

Login shell 控制逻辑：
- 如果 `allow_login_shell` 为 `false` 且模型显式请求 `login: true`，返回错误
- 如果模型未指定 `login`，取 `allow_login_shell` 配置值作为默认

### ToolHandler trait 扩展实现

`UnifiedExecHandler` 实现了几个值得注意的 trait 方法：

- **`is_mutating`**（`unified_exec.rs:99-121`）：通过 `is_known_safe_command` 判断命令是否为只读安全命令（如 `ls`、`cat`），影响并发调度中的互斥策略
- **`pre_tool_use_payload`**（`unified_exec.rs:123-135`）：仅为 `exec_command` 类型提取原始命令字符串，供 hook 系统使用；`write_stdin` 返回 `None`
- **`post_tool_use_payload`**（`unified_exec.rs:137-157`）：为非交互（`tty: false`）的已完成命令提供输出摘要；TTY 命令和仍在运行的进程（有 `process_id` 但无 `exit_code`）返回 `None`

---

## 边界 Case 与注意事项

- **Feature flag 守护**：JsRepl 相关 handler 受 `Feature::JsRepl` 控制；UnifiedExec 的权限提升受 `Feature::ExecPermissionApprovals` 和 `Feature::RequestPermissionsTool` 控制
- **Freeform 输入防护**：`parse_freeform_args` 会拒绝 JSON 包装（`{"code":"..."}`）和 Markdown 围栏格式，防止模型发送错误格式
- **apply-patch 拦截**：通过 `exec_command` 发起的 apply-patch 命令会被拦截并走专用的补丁处理路径，而非作为普通 shell 命令执行（`unified_exec.rs:277-301`）
- **权限策略约束**：在非 `OnRequest` 审批策略下，尝试请求沙箱覆盖权限会被拒绝，并在错误消息中明确告知模型原因（`unified_exec.rs:232-246`）
- **进程 ID 释放**：当执行被拦截（apply-patch）或权限校验失败时，已分配的 process_id 会通过 `release_process_id` 归还，避免 ID 泄漏
- **TTY 与 post_tool_use 互斥**：交互式（TTY）命令不产生 `PostToolUsePayload`，因为其输出不适合作为结构化工具响应