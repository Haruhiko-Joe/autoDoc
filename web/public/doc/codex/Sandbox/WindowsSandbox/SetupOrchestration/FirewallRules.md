# Windows 防火墙规则管理

## 概述与职责

本模块（`firewall.rs`）负责通过 Windows COM 接口（`INetFwPolicy2` / `INetFwRule3`）管理 Windows 防火墙规则，为沙箱离线用户（`CodexSandboxOffline`）配置出站流量阻断策略。它是 **SetupOrchestration** 子系统的一部分，在系统准备阶段被调用，确保沙箱用户的网络访问被严格限制。

在整体架构中，本模块位于 `Sandbox → WindowsSandbox → SetupOrchestration` 层级下，与 SecurityPrimitives（SID 管理）、Utilities（DPAPI、日志）等兄弟模块协作。SetupOrchestration 在创建沙箱用户账户后调用本模块，为该用户 SID 配置防火墙出站阻断规则。

### 防火墙规则体系

模块管理三类核心防火墙规则，形成多层阻断策略：

| 规则名称（内部标识） | 用途 | 协议 | 目标地址范围 |
|---|---|---|---|
| `codex_sandbox_offline_block_outbound` | 阻断所有非回环出站流量 | ANY | 非 `127.0.0.0/8` 和 `::1` 的全部地址 |
| `codex_sandbox_offline_block_loopback_tcp` | 阻断回环 TCP（代理端口除外） | TCP | `127.0.0.0/8`, `::1` |
| `codex_sandbox_offline_block_loopback_udp` | 阻断全部回环 UDP | UDP | `127.0.0.0/8`, `::1` |

此外，历史遗留规则 `codex_sandbox_offline_allow_loopback_proxy` 会在两种模式下被清理。

## 关键流程

### 非回环出站阻断流程 (`ensure_offline_outbound_block`)

这是最基础的防火墙规则，阻断沙箱用户的一切非回环网络访问。

1. 初始化 COM（`CoInitializeEx`，单线程公寓模型）
2. 通过 `CoCreateInstance` 获取 `INetFwPolicy2` 策略对象，再获取 `INetFwRules` 集合
3. 调用 `ensure_block_rule` 创建或更新一条针对 `NET_FW_IP_PROTOCOL_ANY` 的出站阻断规则
4. 规则的 `RemoteAddresses` 设为 `NON_LOOPBACK_REMOTE_ADDRESSES`——即 `0.0.0.0-126.255.255.255,128.0.0.0-255.255.255.255` 以及对应的 IPv6 范围，精确绕过 `127.0.0.0/8` 和 `::1`
5. 通过 `SetLocalUserAuthorizedList` 将规则限定到指定 SID，使用 SDDL 格式 `O:LSD:(A;;CC;;;{SID})`
6. 清理 COM（`CoUninitialize`）

> 源码位置：`codex-rs/windows-sandbox-rs/src/firewall.rs:155-204`

### 代理端口白名单流程 (`ensure_offline_proxy_allowlist`)

更复杂的流程，在回环地址上实现「阻断一切，仅放行代理端口」的策略。

**标准模式（`allow_local_binding = false`）：**

1. COM 初始化与策略获取（同上）
2. 创建 UDP 回环全阻断规则（`codex_sandbox_offline_block_loopback_udp`）
3. **先创建 TCP 回环全阻断规则**（不带端口限制），确保 fail-closed——即使后续步骤失败，沙箱仍然无法访问回环网络（`firewall.rs:110-124`）
4. 清理历史遗留的 allow 规则（`codex_sandbox_offline_allow_loopback_proxy`），且**在阻断规则就位之后**才清理，避免窗口期流量泄露（`firewall.rs:126-128`）
5. 计算代理端口的**补集端口范围**（`blocked_loopback_tcp_remote_ports`），生成需要阻断的端口字符串
6. 用带端口限制的版本**更新** TCP 回环阻断规则，仅阻断非代理端口

**本地绑定模式（`allow_local_binding = true`）：**

直接删除三条粒度化回环规则（allow、UDP block、TCP block），不做任何阻断。此模式下沙箱用户对回环地址有完全访问权限。

> 源码位置：`codex-rs/windows-sandbox-rs/src/firewall.rs:55-153`

### 补集端口范围计算 (`blocked_loopback_tcp_remote_ports`)

将「允许的代理端口列表」转换为「需要阻断的端口范围列表」，这是 Windows 防火墙不支持"除 X 端口外全部阻断"语义的变通方案。

算法步骤：
1. 过滤掉端口 0，排序去重
2. 从端口 1 开始扫描，每遇到一个允许端口就产生一个 `[start, port-1]` 的阻断区间
3. 最后一个允许端口之后到 65535 也产生一个阻断区间
4. 用逗号连接所有区间，单端口直接写数字，端口范围写 `start-end`

**示例**：代理端口为 `[8080, 8443]` 时，生成 `"1-8079,8081-8442,8444-65535"`

如果所有端口（1-65535）都是代理端口（理论上不会发生），返回 `None`，此时 TCP 回环阻断规则保持全端口阻断。

> 源码位置：`codex-rs/windows-sandbox-rs/src/firewall.rs:357-388`

### 幂等规则创建/更新 (`ensure_block_rule`)

所有规则操作都通过此函数，保证幂等性：

1. 按 `internal_name`（稳定标识符）在现有规则集中查找
2. **已存在**：通过 `INetFwRule3::cast()` 获取 COM 接口引用，随后重新应用全部属性
3. **不存在**：创建新 `NetFwRule` COM 对象，**先设置全部属性再 `Add`**，避免半配置规则残留（`firewall.rs:245-246`）
4. 无论新建还是更新，最后都调用 `configure_rule` 重新设置所有字段

> 源码位置：`codex-rs/windows-sandbox-rs/src/firewall.rs:220-271`

### 写入后读回验证 (`configure_rule`)

`configure_rule` 在设置完所有规则属性后，执行一次 `LocalUserAuthorizedList` 的**读回验证**：

1. 调用 `rule.LocalUserAuthorizedList()` 读回实际值
2. 检查返回的字符串是否包含预期的 `offline_sid`
3. 不匹配则返回 `HelperFirewallRuleVerifyFailed` 错误

这一步防止因 COM 调用静默失败导致规则对错误的用户生效。

> 源码位置：`codex-rs/windows-sandbox-rs/src/firewall.rs:337-354`

## 函数签名

### `ensure_offline_outbound_block(offline_sid: &str, log: &mut File) -> Result<()>`

为指定 SID 的沙箱用户创建非回环出站全阻断规则。

- **offline_sid**：沙箱用户的 Windows SID 字符串（如 `S-1-5-21-...`）
- **log**：日志文件句柄，记录规则配置操作

### `ensure_offline_proxy_allowlist(offline_sid: &str, proxy_ports: &[u16], allow_local_binding: bool, log: &mut File) -> Result<()>`

配置回环地址的 TCP/UDP 阻断规则，代理端口除外。

- **offline_sid**：沙箱用户的 Windows SID
- **proxy_ports**：允许通过的代理端口列表（如 `[8080]`）
- **allow_local_binding**：为 `true` 时进入本地绑定模式，删除所有粒度化回环规则
- **log**：日志文件句柄

## 类型定义

### `BlockRuleSpec<'a>`（内部结构体）

封装单条防火墙规则的全部参数，传递给 `ensure_block_rule` 和 `configure_rule`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `internal_name` | `&str` | 规则的稳定内部标识符，用于幂等查找 |
| `friendly_desc` | `&str` | 在 Windows 防火墙 UI 中显示的友好描述 |
| `protocol` | `i32` | 协议常量（`NET_FW_IP_PROTOCOL_ANY/TCP/UDP`） |
| `local_user_spec` | `&str` | SDDL 格式的用户授权列表 |
| `offline_sid` | `&str` | 用于读回验证的 SID 字符串 |
| `remote_addresses` | `Option<&str>` | 远程地址范围，`None` 表示 `*`（全部） |
| `remote_ports` | `Option<&str>` | 远程端口范围，`None` 表示 `*`（全部） |

> 源码位置：`codex-rs/windows-sandbox-rs/src/firewall.rs:45-53`

## 配置项与常量

- **`NON_LOOPBACK_REMOTE_ADDRESSES`**：IPv4 `0.0.0.0-126.255.255.255,128.0.0.0-255.255.255.255` + IPv6 `::,::2-ffff:...`——精确排除 `127.0.0.0/8` 和 `::1`
- **`LOOPBACK_REMOTE_ADDRESSES`**：`127.0.0.0/8,::1`
- 规则作用于所有防火墙配置文件（`NET_FW_PROFILE2_ALL`）
- 规则方向固定为出站（`NET_FW_RULE_DIR_OUT`），动作固定为阻断（`NET_FW_ACTION_BLOCK`）

## 边界 Case 与注意事项

- **Fail-closed 设计**：TCP 回环阻断规则先以全端口阻断形式创建，再收窄为补集端口。如果收窄步骤失败，沙箱用户仍然无法访问任何回环端口（`firewall.rs:110-112`）
- **清理顺序**：遗留 allow 规则在新 block 规则就位后才删除，避免过渡期出现无规则覆盖的窗口（`firewall.rs:126-128`）
- **COM 生命周期**：`CoInitializeEx` 和 `CoUninitialize` 配对使用，结果通过闭包返回以确保 `CoUninitialize` 始终执行
- **端口 0 被过滤**：`blocked_loopback_tcp_remote_ports` 中 `filter(|port| *port != 0)` 显式排除端口 0
- **SDDL 格式**：`LocalUserAuthorizedList` 使用 `O:LSD:(A;;CC;;;{SID})` 格式，表示「所有者为本地系统，允许该 SID 执行连接操作」
- **规则标识符稳定性**：常量注释明确说明规则名称"intentionally does not change between installs"，保证跨安装/升级的幂等性
- **错误码体系**：所有错误通过 `SetupFailure` 包装，使用 `SetupErrorCode` 枚举（如 `HelperFirewallComInitFailed`、`HelperFirewallRuleVerifyFailed`）区分失败阶段