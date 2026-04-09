# ShellAndPatch — Shell 与 ApplyPatch 执行处理器

## 概述与职责

ShellAndPatch 模块包含两个核心的工具处理器（Tool Handler）：**ShellHandler / ShellCommandHandler** 和 **ApplyPatchHandler**。它们是 Codex agent 最常用的两种代码执行方式的入口——运行 shell 命令和应用补丁修改文件。

在整体架构中，本模块位于 **Core → ToolsOrchestration → Handlers** 层级。当模型（LLM）发出工具调用请求时，ToolDispatch 将请求路由到这里的 handler，handler 完成参数解析、权限计算后，委托给对应的 Runtime（ShellRuntime / ApplyPatchRuntime），通过 ToolOrchestrator 的审批/沙盒循环完成实际执行。

同级兄弟模块包括多 agent 通信、JS REPL、unified-exec、MCP 工具调用等其他 handler 实现。

---

## 关键流程

### Shell 命令执行流程（`ShellHandler::run_exec_like`）

这是 shell 执行的核心路径，`ShellHandler` 和 `ShellCommandHandler` 最终都汇聚到此方法（`shell.rs:383-568`）：

1. **注入依赖环境变量**：从 session 获取 `dependency_env`，合并到 `exec_params.env` 中
2. **计算有效权限**：调用 `apply_granted_turn_permissions` 合并 session/turn 级别已授予的权限，再通过 `normalize_and_validate_additional_permissions` 校验额外权限请求是否合法
3. **审批策略守卫**：若命令请求了沙盒提权（`requests_sandbox_override`），且非 `OnRequest` 审批模式且未预批准，直接拒绝
4. **拦截 apply_patch**：调用 `intercept_apply_patch` 检测命令是否实质上是 `apply_patch` 调用——若是，透明转发到 patch 处理逻辑，避免绕过 patch 专用审批流程
5. **发射 begin 事件**：通过 `ToolEmitter::shell` 和 `ToolEventCtx` 发出 `ExecCommandBegin` 事件
6. **构建执行策略**：调用 `exec_policy.create_exec_approval_requirement_for_command` 生成审批需求
7. **组装 ShellRequest 并执行**：创建 `ToolOrchestrator`，选择合适的 `ShellRuntime` 后端（Generic / Classic / ZshFork），通过 `orchestrator.run()` 进入审批→沙盒→执行→重试循环
8. **发射 finish 事件并返回**：将执行输出格式化后通过 `emitter.finish` 发射 `ExecCommandEnd` 事件，返回 `FunctionToolOutput`

### ShellHandler 与 ShellCommandHandler 的区别

- **ShellHandler**：接受 `ShellToolCallParams`——命令以 token 数组形式传入（`Vec<String>`），通过 `shlex_join` 拼接。同时支持 `ToolPayload::LocalShell` 类型。使用 `ShellRuntimeBackend::Generic` 后端。
- **ShellCommandHandler**：接受 `ShellCommandToolCallParams`——命令以单个字符串传入，由 handler 根据用户 shell（bash/zsh/powershell）调用 `shell.derive_exec_args()` 包装为完整命令行。支持 login shell 配置。可选 Classic 或 ZshFork 后端。还会触发 `maybe_emit_implicit_skill_invocation`。

### ApplyPatch 执行流程（`ApplyPatchHandler::handle`）

`apply_patch.rs:142-252`：

1. **提取 patch 输入**：从 `ToolPayload::Function`（JSON 参数）或 `ToolPayload::Custom`（直接输入）中提取 patch 文本
2. **解析并验证补丁**：调用 `maybe_parse_apply_patch_verified` 解析 unified diff，检验格式正确性
3. **计算文件权限**：通过 `effective_patch_permissions` 分析 patch 涉及的所有文件路径（包括 move 目标路径），计算哪些路径需要额外写入权限
4. **尝试直接应用**：调用 `apply_patch::apply_patch`，若可以直接应用则返回结果（`InternalApplyPatchInvocation::Output` 分支）
5. **委托到 Runtime**：若需要沙盒执行（`DelegateToExec` 分支），构建 `ApplyPatchRequest`，通过 `ToolOrchestrator` + `ApplyPatchRuntime` 执行
6. **错误处理**：格式错误（`CorrectnessError`）、解析失败（`ShellParseError`）、非 patch 输入（`NotApplyPatch`）均返回模型可理解的错误信息

### Shell 到 ApplyPatch 的透明路由（`intercept_apply_patch`）

`apply_patch.rs:255-347`：Shell handler 在执行命令前会调用此函数，检测命令是否为 `apply_patch` 调用。如果是：

- 记录模型警告（建议模型直接使用 apply_patch 工具）
- 计算 patch 权限并执行，与 `ApplyPatchHandler` 走相同的 patch 应用逻辑
- 返回 `Some(FunctionToolOutput)`，shell handler 跳过后续 shell 执行

如果不是 patch 命令或解析失败，返回 `None`，shell 正常执行。

---

## 函数签名与参数说明

### `ShellHandler`

```rust
pub struct ShellHandler;
```

实现 `ToolHandler<Output = FunctionToolOutput>`。

#### `ShellHandler::to_exec_params`（私有）

```rust
fn to_exec_params(
    params: &ShellToolCallParams,
    turn_context: &TurnContext,
    thread_id: ThreadId,
) -> ExecParams
```

将 `ShellToolCallParams`（token 数组命令）转换为 `ExecParams`。命令直接使用 token 数组，不经过 shell 包装。

> 源码位置：`codex-rs/core/src/tools/handlers/shell.rs:91-113`

#### `ShellHandler::run_exec_like`（私有）

```rust
async fn run_exec_like(args: RunExecLikeArgs) -> Result<FunctionToolOutput, FunctionCallError>
```

Shell 执行的核心方法，处理权限计算、apply_patch 拦截、事件发射、orchestrator 调度的全流程。`ShellHandler` 和 `ShellCommandHandler` 均调用此方法。

> 源码位置：`codex-rs/core/src/tools/handlers/shell.rs:383-568`

### `ShellCommandHandler`

```rust
pub struct ShellCommandHandler {
    backend: ShellCommandBackend,  // Classic 或 ZshFork
}
```

实现 `ToolHandler<Output = FunctionToolOutput>`，通过 `From<ShellCommandBackendConfig>` 构造。

#### `ShellCommandHandler::to_exec_params`（私有）

```rust
fn to_exec_params(
    params: &ShellCommandToolCallParams,
    session: &Session,
    turn_context: &TurnContext,
    thread_id: ThreadId,
    allow_login_shell: bool,
) -> Result<ExecParams, FunctionCallError>
```

将字符串命令通过 `shell.derive_exec_args()` 包装为完整命令行，支持 login shell 控制。

> 源码位置：`codex-rs/core/src/tools/handlers/shell.rs:140-168`

#### `ShellCommandHandler::resolve_use_login_shell`（私有）

```rust
fn resolve_use_login_shell(
    login: Option<bool>,
    allow_login_shell: bool,
) -> Result<bool, FunctionCallError>
```

决定是否使用 login shell：若配置禁止但模型显式请求 `login=true`，返回错误；否则默认跟随配置。

> 源码位置：`codex-rs/core/src/tools/handlers/shell.rs:123-134`

### `ApplyPatchHandler`

```rust
pub struct ApplyPatchHandler;
```

实现 `ToolHandler<Output = ApplyPatchToolOutput>`。`is_mutating` 始终返回 `true`。

### `intercept_apply_patch`（pub(crate)）

```rust
pub(crate) async fn intercept_apply_patch(
    command: &[String],
    cwd: &Path,
    timeout_ms: Option<u64>,
    session: Arc<Session>,
    turn: Arc<TurnContext>,
    tracker: Option<&SharedTurnDiffTracker>,
    call_id: &str,
    tool_name: &str,
) -> Result<Option<FunctionToolOutput>, FunctionCallError>
```

Shell handler 调用的拦截函数。返回 `Ok(Some(...))` 表示已作为 patch 处理，`Ok(None)` 表示应继续作为 shell 命令执行。

> 源码位置：`codex-rs/core/src/tools/handlers/apply_patch.rs:255-347`

---

## 接口/类型定义

### `ShellCommandBackend`（私有枚举）

```rust
enum ShellCommandBackend {
    Classic,   // 传统 shell 执行方式
    ZshFork,   // zsh fork 优化后端
}
```

映射到 `ShellRuntimeBackend::ShellCommandClassic` 和 `ShellRuntimeBackend::ShellCommandZshFork`。通过 `From<ShellCommandBackendConfig>` 从配置转换。

> 源码位置：`codex-rs/core/src/tools/handlers/shell.rs:45-49`

### `RunExecLikeArgs`（私有结构体）

```rust
struct RunExecLikeArgs {
    tool_name: String,
    exec_params: ExecParams,
    additional_permissions: Option<PermissionProfile>,
    prefix_rule: Option<Vec<String>>,
    session: Arc<Session>,
    turn: Arc<TurnContext>,
    tracker: SharedTurnDiffTracker,
    call_id: String,
    freeform: bool,                          // ShellCommandHandler 为 true，ShellHandler 为 false
    shell_runtime_backend: ShellRuntimeBackend,
}
```

> 源码位置：`codex-rs/core/src/tools/handlers/shell.rs:77-88`

---

## 权限与安全机制

### 安全命令检测

两个 handler 的 `is_mutating` 方法都使用 `is_known_safe_command` 判断命令是否安全（只读）。安全命令可以跳过审批流程。`ShellCommandHandler` 还会先将命令通过 `base_command` 包装后再检测，确保 shell 包装层（如 `bash -lc "..."`)不干扰安全性判断。

### 权限计算（ApplyPatch）

`write_permissions_for_paths`（`apply_patch.rs:62-90`）遍历 patch 涉及的所有文件路径，检查哪些路径的父目录不在当前文件系统沙盒策略的可写范围内，为这些路径生成额外的 `PermissionProfile`（包含写权限请求）。

`file_paths_for_action`（`apply_patch.rs:38-56`）提取 patch 中所有涉及的文件路径，包括 `move_path` 目标路径。

### 审批策略守卫

在 `run_exec_like` 中（`shell.rs:445-458`），如果命令请求沙盒提权但当前审批策略非 `OnRequest`（如自动审批模式），直接拒绝执行——防止模型在非交互模式下擅自提权。

---

## 边界 Case 与注意事项

- **Login shell 控制**：`ShellCommandHandler` 支持 `login` 参数。若全局配置 `allow_login_shell=false`，模型显式请求 `login=true` 会收到错误提示；`login=None` 时默认跟随配置值
- **apply_patch 拦截是透明的**：Shell handler 在执行任何命令前都会尝试解析为 patch。成功拦截后会记录模型警告，提示模型应直接使用 `apply_patch` 工具
- **Shell 解析失败不阻塞**：`intercept_apply_patch` 中若 patch 解析失败（`ShellParseError`），返回 `None` 让命令继续作为普通 shell 命令执行，不会报错
- **`freeform` 标志**：`ShellHandler` 传入 `freeform=false`，`ShellCommandHandler` 传入 `freeform=true`——这影响事件发射时的命令分类，区分结构化命令与自由格式命令
- **dependency_env 合并**：session 级别的 dependency 环境变量会注入每次命令执行，且被加入 `explicit_env_overrides` 以确保在 shell snapshot 恢复时不被覆盖
- **ApplyPatch 双路径执行**：patch 可能直接在进程内应用（`InternalApplyPatchInvocation::Output`），也可能需要委托到沙盒 Runtime 执行（`DelegateToExec`），取决于 turn 的文件系统沙盒策略
- **ApplyPatch 始终视为 mutating**：`is_mutating` 无条件返回 `true`，意味着 patch 操作总是需要经过审批流程