# NetworkProxy — 网络代理与域名策略执行引擎

## 概述与职责

`codex-network-proxy` 是 Codex 沙箱安全层（Sandbox）的核心网络组件，负责拦截并管控所有由沙箱内子进程发起的网络请求。它以本地代理服务器的形式运行，支持 HTTP 和 SOCKS5 两种协议，通过域名白名单/黑名单策略、HTTP 方法限制、MITM（中间人）HTTPS 检查等机制，确保子进程只能访问经过授权的网络目标。

在 Codex 的整体架构中，NetworkProxy 隶属于 **Sandbox** 模块。当 CLI 或 Core 引擎执行 shell 命令时，会通过环境变量（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 等）将子进程的网络流量导向这个代理。同级组件包括 OS 级沙箱（landlock/seccomp/seatbelt）和 exec-server。

## 关键流程

### 1. 代理启动流程

1. 调用方通过 `NetworkProxyBuilder` 构建 `NetworkProxy` 实例，传入 `NetworkProxyState`（运行时状态）、可选的 `NetworkPolicyDecider`（外部策略钩子）和 `BlockedRequestObserver`（阻断事件观察者）
2. `build()` 方法解析配置中的 `proxy_url` 和 `socks_url`，在非 Windows 平台上预先绑定 loopback 临时端口（`src/proxy.rs:232-244`），Windows 上尝试绑定配置端口并回退到临时端口
3. `run()` 方法生成两个 tokio 任务：HTTP 代理（`http_proxy::run_http_proxy`）和 SOCKS5 代理（`socks5::run_socks5`），返回 `NetworkProxyHandle` 用于等待或关闭
4. `apply_to_env()` 方法将代理地址注入到子进程环境变量中（覆盖 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及各工具链特定变量如 `npm_config_proxy`、`PIP_PROXY`、`GIT_SSH_COMMAND` 等）

### 2. HTTP 请求处理流程

对于 HTTP 明文请求（`http_plain_proxy`，`src/http_proxy.rs:423-549`）：

1. 检查代理是否启用（`enabled()`），未启用返回 403
2. 检查 HTTP 方法是否被当前模式允许（Full 模式允许所有方法，Limited 模式只允许 GET/HEAD/OPTIONS）
3. 如果请求携带 `x-unix-socket` 头，走 Unix socket 代理路径（仅 macOS，需要显式白名单）
4. 解析目标 host，调用 `evaluate_host_policy()` 进行域名策略评估
5. 策略通过后，通过 `UpstreamClient` 转发请求到上游目标

### 3. HTTPS CONNECT 处理流程

对于 HTTPS 隧道请求（`http_connect_accept`，`src/http_proxy.rs:152-315`）：

1. 提取 CONNECT 请求的目标 authority（host:port）
2. 检查代理启用状态和域名策略
3. 如果当前为 **Limited 模式**且未启用 MITM，拒绝 CONNECT（因为无法检查隧道内的 HTTP 方法）
4. 如果启用 MITM，将 `MitmState` 注入请求扩展
5. 升级连接后，若有 MITM 标记则进入 `mitm::mitm_tunnel()`，否则直接进行 TCP 流转发

### 4. MITM HTTPS 检查流程

当 Limited 模式 + MITM 启用时（`src/mitm.rs:117-181`）：

1. 从连接扩展中取出目标 host 和 `MitmState`
2. 使用本地 CA 为目标 host 即时签发叶子证书（ECDSA P-256）
3. 用签发的证书建立 TLS 服务端，终止客户端 TLS 连接
4. 对解密后的内部 HTTP 请求再次执行方法策略检查（`mitm_blocking_response`，`src/mitm.rs:245-331`）
5. 检查 host 一致性（防止内层请求篡改 Host 头）
6. 重新检查 DNS 解析是否指向私有 IP（防止 DNS rebinding）
7. 通过 `UpstreamClient` 将请求转发到真实上游

### 5. SOCKS5 处理流程

SOCKS5 代理（`src/socks5.rs:75-130`）：

1. Limited 模式下 SOCKS5 被完全阻断（因为 SOCKS5 是纯 TCP 隧道，无法检查 HTTP 方法）
2. Full 模式下，TCP 连接请求经过 `handle_socks5_tcp` 进行域名策略评估后转发
3. UDP associate 请求经过 `inspect_socks5_udp` 同样进行策略评估后中继

### 6. 域名策略评估流程

`evaluate_host_policy()`（`src/network_policy.rs:289-359`）是所有协议共享的核心策略入口：

1. 调用 `host_blocked()` 进行基线策略检查：
   - **显式拒绝**（deny_set 匹配）→ 直接拒绝
   - **本地/私有 IP 检查**（当 `allow_local_binding=false`）→ 检查 IP 字面量和 DNS 解析结果是否为非公共地址
   - **白名单检查**（allow_set 未匹配）→ 拒绝
2. 如果基线策略结果为 `NotAllowed`，调用外部 `NetworkPolicyDecider` 进行二次决策（可覆盖基线拒绝）
3. 发射审计事件（`codex.network_proxy.policy_decision`），包含完整的请求上下文

## 核心类型与接口

### `NetworkProxy`

代理的主入口结构体，由 `NetworkProxyBuilder` 构建。

```rust
// src/proxy.rs:298-308
pub struct NetworkProxy {
    state: Arc<NetworkProxyState>,
    http_addr: SocketAddr,
    socks_addr: SocketAddr,
    socks_enabled: bool,
    allow_local_binding: bool,
    allow_unix_sockets: Vec<String>,
    dangerously_allow_all_unix_sockets: bool,
    reserved_listeners: Option<Arc<ReservedListeners>>,
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
}
```

关键方法：

| 方法 | 说明 |
|------|------|
| `builder()` | 返回 `NetworkProxyBuilder` |
| `run()` | 启动 HTTP 和 SOCKS5 监听任务 |
| `apply_to_env(&self, env)` | 将代理地址注入子进程环境变量 |
| `add_allowed_domain(host)` | 运行时添加域名到白名单 |
| `add_denied_domain(host)` | 运行时添加域名到黑名单 |
| `http_addr()` / `socks_addr()` | 获取实际监听地址 |

### `NetworkProxyBuilder`

Builder 模式构建器（`src/proxy.rs:92-231`）。

| 方法 | 说明 |
|------|------|
| `state(Arc<NetworkProxyState>)` | **必填**，注入运行时状态 |
| `managed_by_codex(bool)` | 是否由 Codex 管理（默认 true，使用临时端口） |
| `policy_decider(impl NetworkPolicyDecider)` | 设置外部策略决策器 |
| `blocked_request_observer(impl BlockedRequestObserver)` | 设置阻断事件回调 |
| `build()` | 构建 `NetworkProxy` 实例 |

### `NetworkPolicyDecider` trait

```rust
// src/network_policy.rs:267-269
#[async_trait]
pub trait NetworkPolicyDecider: Send + Sync + 'static {
    async fn decide(&self, req: NetworkPolicyRequest) -> NetworkDecision;
}
```

外部策略钩子接口。当基线策略判定为 `NotAllowed`（不在白名单中）时被调用，可以返回 `Allow`（覆盖拒绝）、`Deny` 或 `Ask`。同时支持 `Arc<D>` 和闭包 `Fn(NetworkPolicyRequest) -> Future<Output = NetworkDecision>` 作为实现。

### `NetworkDecision`

```rust
// src/network_policy.rs:122-129
pub enum NetworkDecision {
    Allow,
    Deny {
        reason: String,
        source: NetworkDecisionSource,
        decision: NetworkPolicyDecision,  // Deny | Ask
    },
}
```

### `NetworkMode`

```rust
// src/config.rs:269-280
pub enum NetworkMode {
    Limited,  // 只读：仅允许 GET/HEAD/OPTIONS，SOCKS5 被阻断
    Full,     // 完全访问（默认）
}
```

### `BlockedRequestObserver` trait

```rust
// src/runtime.rs:178-180
#[async_trait]
pub trait BlockedRequestObserver: Send + Sync + 'static {
    async fn on_blocked_request(&self, request: BlockedRequest);
}
```

### `ConfigReloader` trait

```rust
// src/runtime.rs:166-175
#[async_trait]
pub trait ConfigReloader: Send + Sync {
    fn source_label(&self) -> String;
    async fn maybe_reload(&self) -> Result<Option<ConfigState>>;
    async fn reload_now(&self) -> Result<ConfigState>;
}
```

支持运行时热重载配置。每次策略查询前自动调用 `maybe_reload()` 检查是否需要更新。

## 配置项

### `NetworkProxySettings`（`src/config.rs:117-142`）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | `bool` | `false` | 是否启用代理 |
| `proxy_url` | `String` | `http://127.0.0.1:3128` | HTTP 代理监听地址 |
| `enable_socks5` | `bool` | `true` | 是否启用 SOCKS5 代理 |
| `socks_url` | `String` | `http://127.0.0.1:8081` | SOCKS5 监听地址 |
| `enable_socks5_udp` | `bool` | `true` | 是否启用 SOCKS5 UDP relay |
| `allow_upstream_proxy` | `bool` | `true` | 是否允许代理自身使用上游代理（读取环境变量） |
| `dangerously_allow_non_loopback_proxy` | `bool` | `false` | 是否允许绑定非 loopback 地址 |
| `dangerously_allow_all_unix_sockets` | `bool` | `false` | 是否允许所有 Unix socket 代理 |
| `mode` | `NetworkMode` | `Full` | 网络访问模式 |
| `domains` | `Option<NetworkDomainPermissions>` | `None` | 域名权限列表（allow/deny 映射） |
| `unix_sockets` | `Option<NetworkUnixSocketPermissions>` | `None` | Unix socket 路径权限 |
| `allow_local_binding` | `bool` | `false` | 是否允许访问本地/私有网络 |
| `mitm` | `bool` | `false` | 是否启用 MITM HTTPS 检查 |

### 域名模式语法

- `example.com` — 精确匹配
- `*.example.com` — 匹配子域名（不含 apex）
- `**.example.com` — 匹配 apex 和所有子域名
- 全局通配符 `*` 仅在白名单中允许，黑名单中禁止使用

### 环境变量注入

`apply_to_env()` 设置的关键环境变量（`src/proxy.rs:331-463`）：

| 变量 | 值 |
|------|-----|
| `HTTP_PROXY` / `HTTPS_PROXY` | `http://<http_addr>` |
| `ALL_PROXY` | `socks5h://<socks_addr>`（SOCKS5 启用时） |
| `NO_PROXY` | `localhost,127.0.0.1,::1,*.local,...` |
| `GIT_SSH_COMMAND`（macOS） | `ssh -o ProxyCommand='nc -X 5 -x <socks_addr> %h %p'` |
| `CODEX_NETWORK_ALLOW_LOCAL_BINDING` | `0` 或 `1` |

## TLS 证书管理

MITM CA 证书管理位于 `src/certs.rs`。

- CA 密钥和证书存储在 `$CODEX_HOME/proxy/ca.key` 和 `$CODEX_HOME/proxy/ca.pem`
- 首次使用时自动生成自签名 CA（ECDSA P-256，CN=`network_proxy MITM CA`）
- CA 密钥文件使用 `0o600` 权限原子写入（hard-link + create-new 语义避免覆盖）
- 加载时验证密钥文件权限（Unix：拒绝 group/world 可读）和符号链接
- 叶子证书按需为每个目标 host 即时签发，支持域名和 IP SAN

## 约束验证

`NetworkProxyConstraints`（`src/state.rs:23-35`）允许管理配置层对用户配置施加限制：

- 可限制 `enabled`、`mode`、`allow_upstream_proxy` 等布尔/枚举字段的最大值
- 可指定强制包含的 `allowed_domains` 和 `denied_domains`
- 通过 `allowlist_expansion_enabled` / `denylist_expansion_enabled` 控制用户是否能扩展列表
- `validate_policy_against_constraints()` 在配置加载和每次运行时更新时执行校验

## 审计日志

所有策略决策（允许和拒绝）都通过 `tracing` 发射结构化审计事件（`src/network_policy.rs:228-255`）：

- **target**: `codex_otel.network_proxy`
- **event.name**: `codex.network_proxy.policy_decision`
- 包含字段：`network.policy.scope`（domain/non_domain）、`network.policy.decision`（allow/deny/ask）、`network.policy.source`（baseline_policy/mode_guard/proxy_state/decider）、`server.address`、`server.port`、`http.request.method`、`client.address`、`network.policy.override` 等
- 阻断事件同时记录到 `BlockedRequest` 缓冲区（上限 200 条），可通过 `BlockedRequestObserver` 实时订阅

## 边界 Case 与注意事项

- **deny 优先于 allow**：`NetworkDomainPermission` 的排序为 `None < Allow < Deny`，同一域名同时出现在 allow 和 deny 中时，deny 生效
- **DNS rebinding 防护**：当 `allow_local_binding=false` 时，即使域名在白名单中，如果 DNS 解析到私有/本地 IP 仍会被阻断（2 秒超时）
- **Unix socket 安全**：当 unix socket 代理启用时，即使设置了 `dangerously_allow_non_loopback_proxy`，也会强制回退到 loopback 绑定（防止远程利用本地 socket）
- **Limited 模式 + HTTPS**：如果不启用 MITM，所有 HTTPS CONNECT 请求在 Limited 模式下会被拒绝（原因：`mitm_required`）
- **Limited 模式 + SOCKS5**：SOCKS5 在 Limited 模式下完全阻断
- **配置热重载**：每次策略评估前自动检查 `ConfigReloader::maybe_reload()`，配置变更会记录 diff 日志
- **Windows 端口绑定**：Windows 上尝试绑定配置端口，失败时回退到临时端口；非 Windows 总是使用临时端口