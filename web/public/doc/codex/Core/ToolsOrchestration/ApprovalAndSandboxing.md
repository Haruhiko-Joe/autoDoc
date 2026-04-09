# 审批与沙箱执行层（ApprovalAndSandboxing）

## 概述与职责

审批与沙箱执行层是 **ToolsOrchestration** 子系统的核心安全网关，位于 **Core** 模块之下。它为每一次工具运行时调用提供统一的 **审批 → 沙箱选择 → 执行 → 失败后升级重试** 流程，确保所有工具调用都经过权限校验和安全隔离。

在整体架构中，它的同级模块包括工具路由、工具注册表和各种具体的工具处理器（shell、apply-patch、MCP 等）。该层向上被 SessionEngine 通过 ToolsOrchestration 间接调用，向下依赖 CoreConfig 读取执行策略和沙箱配置，并与 GuardianReview 模块集成实现自动化安全审查。

该层由三个核心文件组成：
- **orchestrator.rs** — 编排器，驱动完整的审批-沙箱-执行-重试循环
- **sandboxing.rs** — 定义 `ToolRuntime` trait 及沙箱/审批原语
- **network_approval.rs** — 网络出站请求的拦截与审批服务

## 关键流程

### 工具调用的完整生命周期

`ToolOrchestrator::run()` 方法是所有工具执行的入口，它按以下步骤驱动整个流程：

**第一阶段：审批决策**

1. 调用 `tool.exec_approval_requirement(req)` 查询该工具是否有自定义审批需求；若无，则回退到 `default_exec_approval_requirement()` 根据全局审批策略（`AskForApproval`）和文件系统沙箱策略计算默认需求（`orchestrator.rs:122-124`）
2. 根据返回的 `ExecApprovalRequirement` 枚举分支处理：
   - `Skip`：直接放行，记录 telemetry 事件
   - `Forbidden`：立即拒绝，返回 `ToolError::Rejected`
   - `NeedsApproval`：构建 `ApprovalCtx`，调用 `tool.start_approval_async()` 异步请求用户或 Guardian 审批。若审批被拒绝或中止，返回拒绝错误；若通过（包括 `ApprovedForSession`、`NetworkPolicyAmendment` 等变体），标记 `already_approved = true` 并继续

**第二阶段：首次沙箱执行**

3. 根据 `tool.sandbox_mode_for_first_attempt()` 决定是否绕过沙箱：
   - `BypassSandboxFirstAttempt`：首次执行不使用沙箱（`SandboxType::None`）
   - `NoOverride`：通过 `SandboxManager::select_initial()` 根据文件系统策略、网络策略、工具偏好及平台特性选择合适的沙箱类型（`orchestrator.rs:181-190`）
4. 构建 `SandboxAttempt`，包含沙箱类型、各项策略、工作目录、平台特定参数（Linux sandbox 可执行文件路径、legacy landlock 标志、Windows 沙箱级别等）
5. 调用 `run_attempt()` 执行工具——该方法同时启动网络审批流程

**第三阶段：失败后升级重试**

6. 若首次执行因沙箱拒绝（`SandboxErr::Denied`）而失败：
   - 检查是否存在可处理的网络策略决策上下文
   - 检查 `tool.escalate_on_failure()` 是否允许升级
   - 检查 `tool.wants_no_sandbox_approval(policy)` 是否允许无沙箱审批提示
   - 构建人类可读的拒绝原因（网络阻断时显示被阻断的域名；其他场景显示通用提示）
   - 若需要审批（且未在首次审批中已通过），再次调用 `start_approval_async()` 请求用户确认
   - 审批通过后，以 `SandboxType::None` 构建升级后的 `SandboxAttempt` 并重试执行（`orchestrator.rs:325-354`）

### run_attempt：单次执行与网络审批集成

`run_attempt()` 是每次实际执行工具的内部方法（`orchestrator.rs:51-99`）：

1. 调用 `begin_network_approval()` 根据工具的 `NetworkApprovalSpec` 注册网络审批监听
2. 调用 `tool.run()` 执行工具逻辑
3. 根据网络审批模式处理结果：
   - **Immediate 模式**：执行完成后立即调用 `finish_immediate_network_approval()` 检查是否有被阻断的网络请求。若有拒绝记录，将工具执行标记为失败
   - **Deferred 模式**：将网络审批信息作为 `DeferredNetworkApproval` 返回给调用方，由上层在合适时机完成清理。若工具执行本身失败，立即清理 deferred 审批

### 默认审批需求计算

`default_exec_approval_requirement()` 函数（`sandboxing.rs:171-207`）根据 `AskForApproval` 策略和文件系统沙箱策略的组合来决定默认行为：

| 审批策略 | 文件系统受限 | 结果 |
|---------|------------|------|
| `Never` / `OnFailure` | 任意 | `Skip`（不需审批） |
| `OnRequest` / `Granular` | `Restricted` | `NeedsApproval` |
| `OnRequest` / `Granular` | 非受限 | `Skip` |
| `Granular`（sandbox_approval=false） | `Restricted` | `Forbidden` |
| `UnlessTrusted` | 任意 | `NeedsApproval` |

### 网络出站审批流程

当工具执行过程中发生出站网络请求时，网络代理会拦截该请求并调用 `NetworkApprovalService::handle_inline_policy_request()`（`network_approval.rs:288-515`）：

1. 将网络协议映射为 `NetworkApprovalProtocol`（HTTP/HTTPS/SOCKS5-TCP/SOCKS5-UDP）
2. 构建 `HostApprovalKey`（host + protocol + port 三元组），作为缓存和去重的唯一标识
3. 检查会话级缓存：已拒绝的主机直接 Deny，已批准的主机直接 Allow
4. 通过 `get_or_create_pending_approval()` 实现请求去重——相同 `HostApprovalKey` 的并发请求共享同一个 `PendingHostApproval`，只有第一个请求（owner）发起审批，其余等待结果
5. 根据当前审批策略决定路由：
   - `AskForApproval::Never`：直接拒绝
   - 路由到 Guardian：调用 `review_approval_request()` 进行自动化安全评估
   - 路由到用户：调用 `session.request_command_approval()` 弹出交互式审批提示
6. 根据审批结果更新会话级缓存（`session_approved_hosts` / `session_denied_hosts`），并持久化网络策略修正（`NetworkPolicyAmendment`）

## 函数签名与关键 API

### `ToolOrchestrator`

```rust
pub(crate) struct ToolOrchestrator {
    sandbox: SandboxManager,
}
```

- **`new() -> Self`**：构造编排器，内部创建 `SandboxManager`
- **`run<Rq, Out, T>(&mut self, tool, req, tool_ctx, turn_ctx, approval_policy) -> Result<OrchestratorRunResult<Out>, ToolError>`**：完整编排流程入口。`T` 必须实现 `ToolRuntime<Rq, Out>` trait（`orchestrator.rs:101-358`）

### `OrchestratorRunResult<Out>`

```rust
pub(crate) struct OrchestratorRunResult<Out> {
    pub output: Out,
    pub deferred_network_approval: Option<DeferredNetworkApproval>,
}
```

执行结果的包装，携带可能的延迟网络审批句柄。

### `ToolRuntime<Req, Out>` trait

```rust
pub(crate) trait ToolRuntime<Req, Out>: Approvable<Req> + Sandboxable {
    fn network_approval_spec(&self, req: &Req, ctx: &ToolCtx) -> Option<NetworkApprovalSpec>;
    async fn run(&mut self, req: &Req, attempt: &SandboxAttempt<'_>, ctx: &ToolCtx) -> Result<Out, ToolError>;
}
```

所有工具运行时必须实现的核心 trait，组合了 `Approvable`（审批能力）和 `Sandboxable`（沙箱能力）（`sandboxing.rs:307-318`）。

### `Approvable<Req>` trait

定义工具的审批行为（`sandboxing.rs:236-285`）：

- **`approval_keys(&self, req) -> Vec<Self::ApprovalKey>`**：返回审批缓存键。大多数工具只有一个键，但 `apply_patch` 需要按文件路径粒度的多键审批
- **`sandbox_mode_for_first_attempt(&self, req) -> SandboxOverride`**：是否在首次执行时跳过沙箱
- **`should_bypass_approval(&self, policy, already_approved) -> bool`**：是否可以跳过重试审批
- **`exec_approval_requirement(&self, req) -> Option<ExecApprovalRequirement>`**：自定义审批需求
- **`wants_no_sandbox_approval(&self, policy) -> bool`**：是否愿意请求无沙箱执行审批
- **`start_approval_async(&mut self, req, ctx) -> BoxFuture<ReviewDecision>`**：发起异步审批请求

### `Sandboxable` trait

```rust
pub(crate) trait Sandboxable {
    fn sandbox_preference(&self) -> SandboxablePreference;
    fn escalate_on_failure(&self) -> bool { true }
}
```

定义工具的沙箱偏好和失败升级策略（`sandboxing.rs:287-292`）。

### `with_cached_approval()`

```rust
pub(crate) async fn with_cached_approval<K, F, Fut>(
    services: &SessionServices,
    tool_name: &str,
    keys: Vec<K>,
    fetch: F,
) -> ReviewDecision
```

通用的审批缓存包装器（`sandboxing.rs:70-116`）。当所有键都已被批准为 `ApprovedForSession` 时直接返回，否则执行 `fetch` 获取审批决策并缓存结果。

## 接口/类型定义

### `ExecApprovalRequirement`

```rust
pub(crate) enum ExecApprovalRequirement {
    Skip { bypass_sandbox: bool, proposed_execpolicy_amendment: Option<ExecPolicyAmendment> },
    NeedsApproval { reason: Option<String>, proposed_execpolicy_amendment: Option<ExecPolicyAmendment> },
    Forbidden { reason: String },
}
```

工具编排器对单次工具调用的审批裁决（`sandboxing.rs:129-148`）：
- `Skip`：无需审批。`bypass_sandbox` 为 `true` 时首次执行也跳过沙箱（由 ExecPolicy `Allow` 触发）
- `NeedsApproval`：需要用户或 Guardian 审批
- `Forbidden`：直接禁止执行

### `SandboxOverride`

```rust
pub(crate) enum SandboxOverride {
    NoOverride,
    BypassSandboxFirstAttempt,
}
```

控制首次执行是否绕过沙箱（`sandboxing.rs:209-213`）。`sandbox_override_for_first_attempt()` 根据 `SandboxPermissions` 和 `ExecApprovalRequirement` 计算该值。

### `SandboxAttempt`

```rust
pub(crate) struct SandboxAttempt<'a> {
    pub sandbox: SandboxType,
    pub policy: &'a SandboxPolicy,
    pub file_system_policy: &'a FileSystemSandboxPolicy,
    pub network_policy: NetworkSandboxPolicy,
    pub enforce_managed_network: bool,
    pub(crate) manager: &'a SandboxManager,
    pub(crate) sandbox_cwd: &'a Path,
    pub codex_linux_sandbox_exe: Option<&'a PathBuf>,
    pub use_legacy_landlock: bool,
    pub windows_sandbox_level: WindowsSandboxLevel,
    pub windows_sandbox_private_desktop: bool,
}
```

一次沙箱执行尝试的完整上下文（`sandboxing.rs:320-332`）。提供 `env_for()` 方法将 `SandboxCommand` 转换为带有沙箱隔离的 `ExecRequest`。

### `ToolError`

```rust
pub(crate) enum ToolError {
    Rejected(String),
    Codex(CodexErr),
}
```

工具执行的两种错误（`sandboxing.rs:301-305`）：用户/策略拒绝 vs 系统级错误。

### `NetworkApprovalMode`

```rust
pub(crate) enum NetworkApprovalMode {
    Immediate,
    Deferred,
}
```

网络审批的两种处理模式（`network_approval.rs:33-37`）：
- **Immediate**：工具执行完毕后立即检查网络审批结果，若有拒绝则标记工具执行失败
- **Deferred**：将网络审批句柄返回给调用方，允许延迟处理（适用于需要流式输出等场景）

### `NetworkApprovalService`

核心的网络审批服务（`network_approval.rs:167-185`），内部维护五个并发安全的状态表：
- `active_calls`：当前活跃的工具调用注册表（`IndexMap` 保持插入顺序）
- `call_outcomes`：每次调用的审批结果
- `pending_host_approvals`：正在等待审批的主机请求（用于去重）
- `session_approved_hosts`：会话级已批准主机缓存
- `session_denied_hosts`：会话级已拒绝主机缓存

### `ApprovalStore`

```rust
pub(crate) struct ApprovalStore {
    map: HashMap<String, ReviewDecision>,
}
```

通用的审批决策缓存（`sandboxing.rs:39-62`），通过将审批键序列化为 JSON 字符串实现跨类型的统一缓存。支持 `get()` 和 `put()` 操作。

## 边界 Case 与注意事项

- **并发网络请求去重**：当多个并发的出站请求命中同一 `(host, protocol, port)` 三元组时，只有第一个请求（owner）会发起审批流程，其他请求通过 `Notify` 机制等待相同结果。这避免了对用户的重复审批提示（`network_approval.rs:225-237`，测试 `pending_approvals_are_deduped_per_host_protocol_and_port`）
- **端口隔离**：同一主机不同端口的请求被视为独立的审批目标，不会共享审批状态（测试 `pending_approvals_do_not_dedupe_across_ports`）
- **用户拒绝不可覆盖**：一旦记录了 `DeniedByUser` 结果，后续的策略拒绝（`DeniedByPolicy`）不会覆盖它（`network_approval.rs:254-258`，测试 `blocked_request_policy_does_not_override_user_denial_outcome`）
- **多活跃调用时不归因**：当存在多个并发活跃调用时，无法确定被阻断的网络请求属于哪个调用，此时 `record_blocked_request` 不会记录任何结果（测试 `record_blocked_request_ignores_ambiguous_unattributed_blocked_requests`）
- **Guardian 拒绝消息**：当审批路由到 Guardian 审查器且被拒绝时，使用统一的 `GUARDIAN_REJECTION_MESSAGE` 而非"rejected by user"，以区分自动化拒绝和人工拒绝
- **会话级主机缓存同步**：`sync_session_approved_hosts_to()` 支持将一个会话的网络审批缓存完整复制到另一个会话（用于子 agent 场景），但执行的是完全替换而非合并（`network_approval.rs:189-195`）
- **Granular 策略的 sandbox_approval 开关**：当使用 `Granular` 审批策略且 `sandbox_approval` 为 `false` 时，需要审批的操作会直接返回 `Forbidden` 而非弹出审批提示（`sandboxing.rs:186-196`）
- **OnRequest 策略下的网络审批特例**：即便 `wants_no_sandbox_approval()` 对 `OnRequest` 返回 `false`，如果沙箱拒绝是由网络策略触发的，且默认审批需求本身也是 `NeedsApproval`，仍然允许进入重试审批流程（`orchestrator.rs:254-264`）