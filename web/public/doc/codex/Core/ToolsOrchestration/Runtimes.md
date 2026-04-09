# Runtimes — 工具执行运行时

## 概述与职责

Runtimes 模块位于 **Core > ToolsOrchestration** 层，提供三种具体的 `ToolRuntime` 实现，将模型请求的工具调用接入编排器的 **审批（approval）→ 沙箱（sandbox）→ 重试（retry）** 循环。每个 runtime 都是精简且聚焦的：解析请求、构建沙箱命令、请求用户/guardian 审批、在沙箱约束下执行并返回结果。

三个 runtime 分别是：

| Runtime | 职责 | 输出类型 |
|---------|------|----------|
| **ShellRuntime** | 执行 shell 命令（`shell` / `shell_command` 工具） | `ExecToolCallOutput` |
| **ApplyPatchRuntime** | 解析 unified diff 并在文件系统上应用补丁 | `ExecToolCallOutput` |
| **UnifiedExecRuntime** | 通过 unified_exec 进程管理器执行长时间运行命令 | `UnifiedExecProcess` |

此外，模块还包含两个 Unix 专有子系统：
- **unix_escalation**：通过 `codex-shell-escalation` 实现 execve 级别的权限提升与细粒度策略拦截
- **zsh_fork_backend**：zsh fork 执行后端的平台适配层

### 在架构中的位置

Runtimes 是 ToolsOrchestration 的底层执行层。上游的 tool handler（shell handler、apply-patch handler、unified-exec handler）构造请求对象后，将其交给对应的 runtime。Runtime 通过实现 `Sandboxable`、`Approvable`、`ToolRuntime` 三个 trait 接入编排器循环。同级模块包括 tool router、tool registry、network approval 等。

## 关键流程

### 公共基础设施（`mod.rs`）

模块入口提供两个共享 helper：

**1. `build_sandbox_command`**：将分词后的命令行（`&[String]`）包装为 `SandboxCommand` 结构体，验证至少有一个程序名存在。所有三个 runtime 都依赖此函数。（`codex-rs/core/src/tools/runtimes/mod.rs:21-37`）

**2. `maybe_wrap_shell_lc_with_snapshot`**：POSIX 专用的 shell 快照注入。当会话配置了 shell snapshot 时，将形如 `[shell, "-lc", script]` 的命令改写为：

```
user_shell -c ". SNAPSHOT (best effort); exec original_shell -c <script>"
```

改写流程（`mod.rs:51-110`）：
1. 仅在非 Windows 平台且 snapshot 存在时生效
2. 校验 snapshot 的 cwd 与命令 cwd 是否匹配（通过 `normalize_for_path_comparison` 处理 `.` 别名）
3. 确认命令格式为 `[shell, "-lc", script, ...]`
4. 用 `shell_single_quote` 对路径和脚本做单引号转义
5. 如果存在 `explicit_env_overrides`，通过 `build_override_exports` 生成 capture/restore 脚本，确保环境变量覆盖的优先级高于 snapshot 中的值

**环境变量覆盖保护**（`mod.rs:112-156`）：snapshot sourcing 可能修改环境变量（如 `PATH`、`OPENAI_API_KEY`）。`build_override_exports` 在 source 之前捕获显式覆盖变量的当前值，source 之后恢复它们。值通过 `${}` 变量引用传递而非嵌入 argv，**避免敏感值泄露到命令行**。

### Shell Runtime 执行流程

`ShellRuntime` 是最常用的 runtime，处理 `shell` 和 `shell_command` 工具的执行。

**请求结构 `ShellRequest`**（`shell.rs:46-59`）：
| 字段 | 类型 | 说明 |
|------|------|------|
| `command` | `Vec<String>` | 分词后的命令行 |
| `cwd` | `PathBuf` | 工作目录 |
| `timeout_ms` | `Option<u64>` | 超时时间 |
| `env` | `HashMap<String, String>` | 环境变量 |
| `explicit_env_overrides` | `HashMap<String, String>` | 需要在 snapshot 之后恢复的覆盖变量 |
| `network` | `Option<NetworkProxy>` | 网络代理配置 |
| `sandbox_permissions` | `SandboxPermissions` | 沙箱权限级别 |
| `additional_permissions` | `Option<PermissionProfile>` | 附加权限配置 |
| `justification` | `Option<String>` | 工具调用理由 |
| `exec_approval_requirement` | `ExecApprovalRequirement` | 审批需求 |

**执行流程**（`shell.rs:217-264`）：
1. 通过 `maybe_wrap_shell_lc_with_snapshot` 注入 shell 环境快照
2. 对 PowerShell 命令，添加 UTF-8 前缀（`prefix_powershell_script_with_utf8`）
3. 如果 backend 是 `ShellCommandZshFork`，尝试通过 zsh fork 路径执行；不满足条件则 fallback
4. 调用 `build_sandbox_command` 构建 `SandboxCommand`
5. 通过 `SandboxAttempt.env_for()` 获取最终的执行环境（含沙箱变换）
6. 调用 `execute_env` 执行命令，支持 stdout 流式输出

**Backend 选择**（`shell.rs:67-86`）：
- `Generic`：默认路径，无特殊后端行为
- `ShellCommandClassic`：`shell_command` 工具的标准路径
- `ShellCommandZshFork`：`shell_command` 工具的 zsh fork 路径（Unix 专用）

**审批流程**（`shell.rs:130-202`）：
- 通过 `canonicalize_command_for_approval` 规范化命令生成 `ApprovalKey`
- 如果 turn 路由到 guardian，走 `review_approval_request` 的自动化审批
- 否则通过 `with_cached_approval` 做缓存审批——相同命令+cwd+权限不需要重复审批

### Apply Patch Runtime 执行流程

`ApplyPatchRuntime` 负责将 unified diff 格式的补丁应用到文件系统。

**请求结构 `ApplyPatchRequest`**（`apply_patch.rs:37-45`）：
| 字段 | 类型 | 说明 |
|------|------|------|
| `action` | `ApplyPatchAction` | 包含 patch 内容和 cwd |
| `file_paths` | `Vec<AbsolutePathBuf>` | 受影响的文件路径列表 |
| `changes` | `HashMap<PathBuf, FileChange>` | 文件变更描述（Add/Modify/Delete） |
| `permissions_preapproved` | `bool` | 权限是否已预审批 |

**执行流程**（`apply_patch.rs:207-230`）：
1. 通过 `build_sandbox_command` 构建自调用命令：`codex --codex-run-as-apply-patch <patch_content>`
2. 在 Unix 上优先使用 `codex_self_exe`，回退到 `std::env::current_exe()`；Windows 上通过 `resolve_current_exe_for_launch` 解析
3. 使用**空环境**（`HashMap::new()`）运行，确保确定性并防止环境泄露
4. 通过 `SandboxAttempt.env_for()` 应用沙箱约束
5. 调用 `execute_env` 执行

**审批特点**：
- 审批 key 是文件路径（`Vec<AbsolutePathBuf>`），而非命令
- 如果 `permissions_preapproved && !retry`，直接返回 `Approved`（上游 `assess_patch_safety` 已做决策）
- 支持 `wants_no_sandbox_approval` 根据 `AskForApproval` 策略决定是否跳过沙箱审批

### Unified Exec Runtime 执行流程

`UnifiedExecRuntime` 桥接 `UnifiedExecProcessManager` 进程管理器，支持 PTY 和长时间运行的命令。

**请求结构 `UnifiedExecRequest`**（`unified_exec.rs:51-65`）：
与 `ShellRequest` 类似，额外包含：
- `process_id: i32`：进程管理器分配的会话 ID
- `tty: bool`：是否分配 PTY

**执行流程**（`unified_exec.rs:197-302`）：
1. 注入 shell 快照、处理 PowerShell UTF-8 前缀
2. 将网络代理配置应用到环境变量（`network.apply_to_env`）
3. 如果 `shell_mode` 是 `ZshFork`：
   - 通过 `zsh_fork_backend::maybe_prepare_unified_exec` 准备 escalation session
   - 拒绝在有 `exec_server_url` 时使用 zsh-fork（不兼容）
   - 调用 `manager.open_session_with_exec_env` 启动 PTY 会话，传入 `ZshForkSpawnLifecycle`
4. 否则走标准路径：`build_sandbox_command` → `env_for` → `open_session_with_exec_env`（使用 `NoopSpawnLifecycle`）

**网络审批差异**：Shell runtime 使用 `NetworkApprovalMode::Immediate`（立即审批），而 unified exec 使用 `NetworkApprovalMode::Deferred`（延迟审批）。

### Unix 权限提升（`unix_escalation.rs`）

这是最复杂的子模块，实现了 **execve 级别的权限拦截和策略评估**，用于 zsh fork 后端。

**核心架构**：
- `EscalateServer`：启动一个 socket-based 服务，拦截 zsh fork 出的子进程的 `execve` 调用
- `CoreShellActionProvider`（实现 `EscalationPolicy`）：对每个拦截到的 execve 做策略决策
- `CoreShellCommandExecutor`（实现 `ShellCommandExecutor`）：实际执行命令，支持沙箱和非沙箱模式

**策略决策流程**（`unix_escalation.rs:502-562`）：

```
拦截到 execve(program, argv)
    ↓
evaluate_intercepted_exec_policy()
    ├── 检查 exec policy 规则
    ├── 如果命中规则 → 由规则决定 Allow/Prompt/Forbidden
    └── 未命中 → 走 render_decision_for_unmatched_command 兜底
    ↓
process_decision()
    ├── Forbidden → deny
    ├── Prompt → 检查 AskForApproval 策略是否允许提示
    │   ├── Never → deny
    │   ├── Granular 且不允许对应类型 → deny
    │   └── 允许 → 向用户请求审批
    └── Allow → run 或 escalate
```

**提升执行模式**（`unix_escalation.rs:345-369`）：
- `TurnDefault`：使用 turn 级别的沙箱策略
- `Unsandboxed`：完全跳出沙箱（用于规则明确允许的命令）
- `Permissions(Permissions{...})`：使用指定的沙箱策略（用于 `WithAdditionalPermissions`）

**`CoreShellCommandExecutor.run`**（`unix_escalation.rs:686-734`）：执行最终命令时，仅从 env_overlay 中合并 `CODEX_ESCALATE_SOCKET` 和 `EXEC_WRAPPER` 两个变量到基础环境中，然后通过 `execute_exec_request_with_after_spawn` 执行。

**`prepare_escalated_exec`**（`unix_escalation.rs:736-798`）：为被拦截的 execve 准备沙箱化执行环境。根据 `EscalationExecution` 模式选择：
- `Unsandboxed`：直接使用原始命令和环境
- `TurnDefault` / `Permissions`：通过 `SandboxManager.select_initial` + `transform` 构建完整的沙箱执行请求

**辅助函数**：
- `extract_shell_script`（`unix_escalation.rs:874-897`）：从命令数组中定位 `-c`/`-lc` 三元组，提取 shell 脚本内容
- `map_exec_result`（`unix_escalation.rs:899-926`）：将 `ExecResult` 映射为 `ExecToolCallOutput`，检测超时和沙箱拒绝
- `join_program_and_argv`（`unix_escalation.rs:934-938`）：将 `(program, argv)` 合并为命令向量，用 program 替换 argv[0] 避免重复

### Zsh Fork Backend 平台适配（`zsh_fork_backend.rs`）

该模块是 zsh fork 功能的平台抽象层：

**Unix 实现**（`zsh_fork_backend.rs:47-110`）：
- `maybe_run_shell_command`：委托给 `unix_escalation::try_run_zsh_fork`
- `maybe_prepare_unified_exec`：委托给 `unix_escalation::prepare_unified_exec_zsh_fork`，并将 `EscalationSession` 包装为 `ZshForkSpawnLifecycle`

`ZshForkSpawnLifecycle` 实现了 `SpawnLifecycle` trait（`zsh_fork_backend.rs:59-72`）：
- `inherited_fds()`：返回 escalation socket 的 fd，确保子进程继承
- `after_spawn()`：spawn 后关闭 client socket（只保留 server 端）

**非 Unix 实现**（`zsh_fork_backend.rs:112-136`）：所有函数直接返回 `Ok(None)`，表示 fallback 到标准路径。

## 接口与类型定义

### Trait 实现模式

所有三个 runtime 都实现了三个核心 trait：

```
Sandboxable          → sandbox_preference() + escalate_on_failure()
Approvable<Req>      → approval_keys() + start_approval_async() + ...
ToolRuntime<Req,Out> → run() + network_approval_spec()
```

其中：
- `sandbox_preference` 全部返回 `SandboxablePreference::Auto`
- `escalate_on_failure` 全部返回 `true`（沙箱失败时自动升级权限重试）

### `ShellRuntimeBackend`

```rust
enum ShellRuntimeBackend {
    Generic,              // 默认路径
    ShellCommandClassic,  // shell_command 标准路径
    ShellCommandZshFork,  // shell_command + zsh fork
}
```

> 源码位置：`codex-rs/core/src/tools/runtimes/shell.rs:67-86`

### `ApprovalKey`（Shell）

```rust
struct ApprovalKey {
    command: Vec<String>,     // 规范化后的命令
    cwd: PathBuf,
    sandbox_permissions: SandboxPermissions,
    additional_permissions: Option<PermissionProfile>,
}
```

> 源码位置：`codex-rs/core/src/tools/runtimes/shell.rs:93-99`

### `UnifiedExecApprovalKey`

```rust
struct UnifiedExecApprovalKey {
    command: Vec<String>,
    cwd: PathBuf,
    tty: bool,               // 额外的 TTY 维度
    sandbox_permissions: SandboxPermissions,
    additional_permissions: Option<PermissionProfile>,
}
```

> 源码位置：`codex-rs/core/src/tools/runtimes/unified_exec.rs:69-76`

## 配置项与默认值

- **Shell Snapshot**：通过 `session_shell.shell_snapshot()` 获取，由会话级 `watch` channel 管理
- **Shell 类型检测**：`ShellType::Zsh`、`Bash`、`Sh`、`PowerShell` 等，影响命令改写和 fork 后端选择
- **Feature Flag**：`Feature::ShellZshFork` 控制 zsh fork 后端是否启用
- **`shell_zsh_path`**：Session 级配置，指向 zsh 可执行文件路径
- **`main_execve_wrapper_exe`**：execve 包装器可执行文件路径，zsh fork 必需
- **默认超时**：`DEFAULT_EXEC_COMMAND_TIMEOUT_MS`（来自 `crate::exec`）
- **Shell wrapper 解析**：`ENABLE_INTERCEPTED_EXEC_POLICY_SHELL_WRAPPER_PARSING` 硬编码为 `false`，避免路径敏感规则的误判

## 边界 Case 与注意事项

- **Snapshot CWD 不匹配**：当命令 cwd 与 snapshot cwd 不同时（如在不同 worktree 中），snapshot 注入被跳过，命令原样执行
- **敏感值不嵌入 argv**：环境变量覆盖通过 `${}` 引用而非字面值传递，确保 `OPENAI_API_KEY` 等敏感值不出现在进程命令行中
- **Apply Patch 空环境**：apply_patch 以空 `HashMap` 作为环境运行，避免父进程环境泄露
- **Exec Server 不兼容 ZshFork**：`unified_exec` 在配置了 `exec_server_url` 时明确拒绝 zsh fork 模式
- **非 Unix 平台 Fallback**：zsh fork 和 unix_escalation 在非 Unix 平台静默返回 `None`，由调用方 fallback 到标准路径
- **单引号转义**：`shell_single_quote` 使用 `'` → `'"'"'` 模式处理嵌套引号，这是 POSIX shell 的标准做法
- **env_overlay 白名单**：`CoreShellCommandExecutor.run` 仅合并 `CODEX_ESCALATE_SOCKET` 和 `EXEC_WRAPPER` 两个变量，防止 escalation 环境污染命令环境
- **Guardian 审批路由**：当 turn 配置了 guardian 时，审批请求走自动化 guardian 路径而非用户交互路径，三个 runtime 都支持此分支