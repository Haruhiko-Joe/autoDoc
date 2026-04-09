# NetworkPolicy — 网络策略决策与代理配置

## 概述与职责

NetworkPolicy 模块是 **Core > CoreConfig** 子系统的一部分，负责 Codex 代理的网络访问控制。它处于沙箱安全层和网络代理之间，承担三项核心职责：

1. **策略决策翻译**：将网络代理产生的底层 blocked-request 事件翻译为用户可理解的审批上下文（`NetworkApprovalContext`）和拒绝消息
2. **代理规格构建**：根据权限配置、沙箱策略和托管约束，构建 `NetworkProxySpec`（代理配置 + 约束条件）
3. **配置热加载**：基于文件 mtime 检测配置变更，支持网络代理状态的运行时重新加载

在上层架构中，本模块的同级兄弟包括 Protocol（类型定义）、SessionEngine（会话引擎）、ToolsOrchestration（工具调度）等。SessionEngine 和 ToolsOrchestration 依赖 CoreConfig（包含本模块）来获取网络策略和执行策略配置。

模块由三个源文件组成：
- `codex-rs/core/src/network_policy_decision.rs` — 策略决策翻译层
- `codex-rs/core/src/config/network_proxy_spec.rs` — `NetworkProxySpec` 构建与代理启动
- `codex-rs/core/src/network_proxy_loader.rs` — 配置层加载与 mtime 热加载

## 关键流程

### 1. 被阻断请求 → 用户审批/拒绝消息

当网络代理拦截了一个不在白名单中的请求时，系统需要决定是弹出审批对话框让用户授权，还是直接拒绝并给出原因。这由 `network_policy_decision.rs` 中的两个函数处理：

**审批上下文生成**（`network_approval_context_from_payload`，`codex-rs/core/src/network_policy_decision.rs:26-44`）：
1. 检查 payload 是否为 "ask" 类型决策（`is_ask_from_decider()`）
2. 提取协议类型（HTTP/HTTPS/SOCKS5 等）和目标主机名
3. 构造 `NetworkApprovalContext { host, protocol }` 返回给上层，触发用户审批流程

**拒绝消息生成**（`denied_network_policy_message`，`codex-rs/core/src/network_policy_decision.rs:46-72`）：
1. 解析决策字符串，确认为 "deny" 类型
2. 根据 `reason` 字段映射到具体的人类可读解释：
   - `"denied"` → 域名被策略明确禁止，且无法从当前 prompt 中批准
   - `"not_allowed"` → 不在当前沙箱模式的白名单中
   - `"not_allowed_local"` → 本地/私有网络地址被策略阻断
   - `"method_not_allowed"` → 请求方法被当前网络模式阻断
   - `"proxy_disabled"` → 托管网络代理已禁用
3. 格式化为 `Network access to "{host}" was blocked: {detail}.` 形式的用户可见错误消息

### 2. 用户审批 → exec-policy 规则修订

当用户批准或拒绝一个网络访问请求后，`execpolicy_network_rule_amendment`（`codex-rs/core/src/network_policy_decision.rs:74-102`）负责将用户的决定转化为 exec-policy 层面的规则变更：

1. 将协议类型从 `NetworkApprovalProtocol`（Http / Https / Socks5Tcp / Socks5Udp）映射到 `ExecPolicyNetworkRuleProtocol`
2. 将用户动作映射到 exec-policy 决策：`Allow → ExecPolicyDecision::Allow`，`Deny → ExecPolicyDecision::Forbidden`
3. 生成协议标签（`http` / `https_connect` / `socks5_tcp` / `socks5_udp`）
4. 构造 justification 字符串，如 `"Allow https_connect access to api.example.com"`

### 3. NetworkProxySpec 构建

`NetworkProxySpec` 是整个网络代理的配置核心，封装了代理配置（`NetworkProxyConfig`）、约束条件（`NetworkProxyConstraints`）和硬拒绝标志。

**从配置和约束构建**（`from_config_and_constraints`，`codex-rs/core/src/config/network_proxy_spec.rs:87-116`）：
1. 检查是否启用 `managed_allowed_domains_only` 模式（仅允许托管白名单中的域名）
2. 调用 `apply_requirements` 应用托管约束（端口、域名列表、Unix socket 等）
3. 根据沙箱策略决定白名单/黑名单是否允许用户扩展：
   - `ReadOnly` / `WorkspaceWrite` 策略：允许用户在托管基线之上添加域名
   - `DangerFullAccess` 策略：用户配置被丢弃，仅使用托管基线
4. 调用 `validate_policy_against_constraints` 校验最终配置不违反约束

**域名列表合并逻辑**（`apply_requirements`，`codex-rs/core/src/config/network_proxy_spec.rs:188-294`）：

关键设计：托管（managed）域名列表是基线，用户域名列表在允许扩展时可以叠加，但永远不会覆盖托管基线。具体逻辑：

- `allowlist_expansion_enabled`：仅在 `ReadOnly`/`WorkspaceWrite` 沙箱且未开启 `managed_allowed_domains_only` 时为 true
- `denylist_expansion_enabled`：仅在 `ReadOnly`/`WorkspaceWrite` 沙箱时为 true
- 当扩展启用时，用户域名与托管域名合并（去重，大小写不敏感）
- 当扩展禁用时（如 `DangerFullAccess`），仅保留托管域名

### 4. 网络代理启动

`start_proxy`（`codex-rs/core/src/config/network_proxy_spec.rs:118-155`）组装并启动实际的网络代理实例：

1. 将当前配置和审计元数据构建为 `NetworkProxyState`（使用 `StaticNetworkProxyReloader` 作为不会变更的 reloader）
2. 创建 `NetworkProxy::builder()`，注入状态
3. 根据条件挂载策略决策器（policy decider）：
   - 仅在 `ReadOnly`/`WorkspaceWrite` 沙箱 + 未硬拒绝白名单 miss + 启用审批流程时启用
   - 默认决策器对不在白名单中的请求返回 `NetworkDecision::ask("not_allowed")`
4. 挂载可选的 blocked-request 观察者
5. 构建并运行代理，返回 `StartedNetworkProxy`

### 5. 配置层加载与热重载

`codex-rs/core/src/network_proxy_loader.rs` 实现了独立于 `NetworkProxySpec` 的配置加载路径，用于网络代理状态的独立构建和热重载。

**初始加载**（`build_config_state_with_mtimes`，`codex-rs/core/src/network_proxy_loader.rs:44-78`）：
1. 查找 `CODEX_HOME` 目录
2. 加载多层配置（system / user / project / legacy 等）
3. 加载 exec-policy（解析失败时降级为空策略并记录警告）
4. 从配置层构建 `NetworkProxyConfig`：遍历所有层，逐层叠加网络配置（`config_from_layers`，`codex-rs/core/src/network_proxy_loader.rs:208-222`）
5. 从受信任层提取约束条件（排除用户可控层）
6. 将 exec-policy 中的网络域名规则合并到配置中
7. 记录各配置文件的 mtime

**受信任约束提取**（`enforce_trusted_constraints`，`codex-rs/core/src/network_proxy_loader.rs:105-114`）：
- 仅从**非用户可控层**（System、LegacyManagedConfig 等）提取约束
- 用户可控层（`User`、`Project`、`SessionFlags`）被跳过，防止用户绕过系统级约束（`is_user_controlled_layer`，`codex-rs/core/src/network_proxy_loader.rs:255-262`）
- 约束条件覆盖：enabled、mode、allow_upstream_proxy、域名白名单/黑名单、Unix socket 权限等

**mtime 热重载**（`MtimeConfigReloader`，`codex-rs/core/src/network_proxy_loader.rs:277-325`）：
- 实现 `ConfigReloader` trait，提供 `maybe_reload` 和 `reload_now` 两个入口
- `needs_reload`：比较每个配置文件当前 mtime 与上次加载时的 mtime
- `maybe_reload`：仅在检测到变更时重新加载全部配置并更新内部 mtime 记录
- `reload_now`：无条件重新加载
- 使用 `RwLock<Vec<LayerMtime>>` 保证并发安全

## 函数签名与参数说明

### network_policy_decision.rs

#### `network_approval_context_from_payload(payload: &NetworkPolicyDecisionPayload) -> Option<NetworkApprovalContext>`

从代理的策略决策 payload 提取审批上下文。仅当 payload 为 "ask" 类型且包含有效的 host 和 protocol 时返回 `Some`。

#### `denied_network_policy_message(blocked: &BlockedRequest) -> Option<String>`

为被拒绝的网络请求生成用户可见的错误消息。仅当决策为 "deny" 时返回 `Some`。

#### `execpolicy_network_rule_amendment(amendment: &NetworkPolicyAmendment, network_approval_context: &NetworkApprovalContext, host: &str) -> ExecPolicyNetworkRuleAmendment`

将用户的网络审批决定转化为 exec-policy 规则修订。返回包含协议、决策和 justification 的结构体。

### network_proxy_spec.rs — `NetworkProxySpec`

#### `from_config_and_constraints(config: NetworkProxyConfig, requirements: Option<NetworkConstraints>, sandbox_policy: &SandboxPolicy) -> io::Result<Self>`

从代理配置、托管约束和沙箱策略构建 `NetworkProxySpec`。校验最终配置不违反约束，否则返回 `InvalidInput` 错误。

#### `start_proxy(&self, sandbox_policy, policy_decider, blocked_request_observer, enable_network_approval_flow, audit_metadata) -> io::Result<StartedNetworkProxy>`

启动网络代理实例。根据沙箱策略和配置决定是否启用审批流程。

#### `with_exec_policy_network_rules(&self, exec_policy: &Policy) -> io::Result<Self>`

在现有 spec 基础上叠加 exec-policy 的网络域名规则，返回新的 spec。校验合并后的配置不违反约束。

#### `enabled(&self) -> bool` / `proxy_host_and_port(&self) -> String` / `socks_enabled(&self) -> bool`

分别返回代理是否启用、代理监听地址（默认端口 3128）、SOCKS5 是否启用。

### network_proxy_loader.rs

#### `build_network_proxy_state() -> Result<NetworkProxyState>`

完整构建网络代理状态（含热重载器），适用于独立代理场景。

#### `build_network_proxy_state_and_reloader() -> Result<(ConfigState, MtimeConfigReloader)>`

构建配置状态和热重载器，调用方可自行组装 `NetworkProxyState`。

## 接口/类型定义

### `ExecPolicyNetworkRuleAmendment`（`codex-rs/core/src/network_policy_decision.rs:11-16`）

```rust
pub(crate) struct ExecPolicyNetworkRuleAmendment {
    pub protocol: ExecPolicyNetworkRuleProtocol,  // HTTP / HTTPS / SOCKS5_TCP / SOCKS5_UDP
    pub decision: ExecPolicyDecision,              // Allow / Forbidden
    pub justification: String,                     // 人类可读的操作说明
}
```

### `NetworkProxySpec`（`codex-rs/core/src/config/network_proxy_spec.rs:23-28`）

```rust
pub struct NetworkProxySpec {
    config: NetworkProxyConfig,              // 完整的代理配置
    constraints: NetworkProxyConstraints,    // 不可违反的约束条件
    hard_deny_allowlist_misses: bool,        // 是否对不在白名单中的请求硬拒绝（不走审批流程）
}
```

### `StartedNetworkProxy`（`codex-rs/core/src/config/network_proxy_spec.rs:30-46`）

持有运行中的代理实例及其 handle。通过 `proxy()` 方法获取可克隆的 `NetworkProxy` 引用。

### `MtimeConfigReloader`（`codex-rs/core/src/network_proxy_loader.rs:277-299`）

基于文件修改时间的配置热重载器，实现 `ConfigReloader` trait。内部使用 `RwLock<Vec<LayerMtime>>` 跟踪各配置文件的 mtime。

### `LayerMtime`（`codex-rs/core/src/network_proxy_loader.rs:264-275`）

```rust
struct LayerMtime {
    path: PathBuf,
    mtime: Option<std::time::SystemTime>,
}
```

记录单个配置文件路径及其最后修改时间。构造时自动读取当前 mtime。

## 配置项与默认值

网络代理配置来自多层 TOML 配置文件（system → user → project），通过 `[permissions]` 表下的 `[network]` 段配置。关键可配字段：

| 配置字段 | 说明 | 来源 |
|---------|------|------|
| `enabled` | 是否启用网络代理 | 配置层 / 托管约束 |
| `mode` | 网络模式 | 受信任层约束 |
| `proxy_url` | HTTP 代理监听地址 | 托管约束中的 `http_port` |
| `socks_url` | SOCKS5 代理监听地址 | 托管约束中的 `socks_port` |
| `allow_upstream_proxy` | 是否允许上游代理 | 受信任层约束 |
| `dangerously_allow_non_loopback_proxy` | 是否允许非回环代理地址 | 受信任层约束 |
| `dangerously_allow_all_unix_sockets` | 是否允许所有 Unix socket | 受信任层约束 |
| `domains` | 域名白名单/黑名单 | 多层合并 |
| `unix_sockets` | 允许的 Unix socket 路径 | 托管约束 |
| `allow_local_binding` | 是否允许本地端口绑定 | 受信任层约束 |
| `managed_allowed_domains_only` | 仅允许托管白名单域名 | 云端/托管约束 |

## 边界 Case 与注意事项

- **exec-policy 解析失败降级**：加载 exec-policy 时如果遇到 `ParsePolicy` 错误，系统不会中断启动，而是降级为空策略并通过 `tracing::warn` 记录警告（`codex-rs/core/src/network_proxy_loader.rs:58-69`）。其他类型的错误会导致启动失败。

- **受信任层与用户层隔离**：约束条件（constraints）仅从 System 和 LegacyManagedConfig 层提取。User、Project、SessionFlags 层被视为用户可控，不能设置约束。这防止用户通过修改本地配置绕过系统级安全策略（`is_user_controlled_layer`，`codex-rs/core/src/network_proxy_loader.rs:255-262`）。

- **`DangerFullAccess` 沙箱下的域名固定**：在全权限沙箱模式下，白名单和黑名单都不允许用户扩展，仅使用托管基线。这是一个安全防线——即使用户选择了最宽松的沙箱，托管策略仍然生效。测试 `danger_full_access_keeps_managed_allowlist_and_denylist_fixed`（`codex-rs/core/src/config/network_proxy_spec_tests.rs:146-179`）验证了这一行为。

- **`managed_allowed_domains_only` 的硬拒绝行为**：启用此标志后，不在托管白名单中的域名会被硬拒绝（`hard_deny_allowlist_misses = true`），不会触发用户审批流程。当没有托管白名单时，所有用户域名都会被移除（测试 `managed_allowed_domains_only_without_managed_allowlist_blocks_all_user_domains`，`codex-rs/core/src/config/network_proxy_spec_tests.rs:245-266`）。

- **审批流程的启用条件**：用户审批流程仅在同时满足以下条件时启用（`codex-rs/core/src/config/network_proxy_spec.rs:128-143`）：
  1. `enable_network_approval_flow` 为 true
  2. 未启用硬拒绝模式（`hard_deny_allowlist_misses` 为 false）
  3. 沙箱策略为 `ReadOnly` 或 `WorkspaceWrite`

- **用户域名允许移除托管基线中的条目**：即使托管基线允许了某个域名，用户仍可将其加入黑名单。测试 `requirements_allowed_domains_do_not_override_user_denies_for_same_pattern`（`codex-rs/core/src/config/network_proxy_spec_tests.rs:74-103`）验证了用户 deny 不会被托管 allow 覆盖。

- **mtime 检测的边界情况**：`needs_reload` 对四种 mtime 状态组合做了完整处理（`codex-rs/core/src/network_proxy_loader.rs:292-298`）：文件新出现（`Some, None` → reload）、文件被删除（`None, Some` → reload）、双方都无法读取（`None, None` → 不 reload）。

- **域名合并的大小写不敏感去重**：`merge_domain_lists` 使用 `eq_ignore_ascii_case` 进行去重（`codex-rs/core/src/config/network_proxy_spec.rs:317-327`），避免同一域名因大小写不同被重复添加。