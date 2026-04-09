# SecurityPrimitives — Windows 沙箱安全原语

## 概述与职责

SecurityPrimitives 是 Windows 沙箱实现（`WindowsSandbox`）的底层安全基础设施，隶属于 Codex 的 **Sandbox** 模块。它提供四项核心能力：

1. **受限令牌创建**（`token.rs`）：基于当前进程令牌创建权限极度受限的子令牌，用于沙箱进程
2. **DACL 操作**（`acl.rs`）：在文件系统对象上添加/撤销 ACE，实现细粒度的读写控制
3. **Capability SID 持久化**（`cap.rs`）：为每个工作区生成并持久化唯一的 Capability SID，确保跨会话 ACL 一致性
4. **工作区目录保护**（`workspace_acl.rs`）：对敏感目录（`.codex`、`.agents`）施加写拒绝 ACE，防止沙箱进程篡改配置

在同级模块中，SecurityPrimitives 被上层的沙箱编排器调用——编排器决定使用 read-only 还是 workspace-write 模式，然后委托本模块创建相应的受限令牌并配置文件系统 ACL。

## 关键流程

### 1. 受限令牌创建流程

这是沙箱启动的核心路径，所有沙箱进程都运行在此流程产出的受限令牌下。

1. 调用 `get_current_token_for_restriction()` 打开当前进程令牌，请求 `TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID | TOKEN_ADJUST_PRIVILEGES` 权限组合（`token.rs:146-167`）
2. 调用 `get_logon_sid_bytes()` 从令牌的 `TOKEN_GROUPS` 中扫描带有 `SE_GROUP_LOGON_ID`（`0xC0000000`）标志的 SID。若当前令牌无 logon SID，则回退到 **linked token**（UAC 场景下的另一半令牌）重新扫描（`token.rs:169-252`）
3. 构建 restricting SID 列表，按固定顺序排列：`[Capability SIDs..., Logon SID, Everyone SID]`（`token.rs:342-352`）
4. 调用 `CreateRestrictedToken` 并传入 `DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED` 标志，生成一个：
   - 禁用了所有危险权限的令牌
   - 降级到 LUA（Limited User Account）级别的令牌
   - 仅允许对 restricting SID 列表中的 SID 进行写操作的令牌（`token.rs:354-369`）
5. 调用 `set_default_dacl()` 为新令牌设置默认 DACL，授予 logon SID、Everyone 和所有 capability SID `GENERIC_ALL` 权限——这保证了沙箱进程可以创建管道和 IPC 对象（如 PowerShell 管道），避免 `ACCESS_DENIED`（`token.rs:54-105`）
6. 调用 `enable_single_privilege()` 启用 `SeChangeNotifyPrivilege`，允许沙箱进程遍历目录路径（`token.rs:253-282`）

### 2. 两种沙箱模式的令牌差异

两种模式的令牌创建路径最终都汇聚到 `create_token_with_caps_from()`，区别在于传入的 capability SID 数量：

- **Read-only 模式**：通过 `create_readonly_token_with_cap()` / `create_readonly_token_with_caps_from()` 创建，传入只读 capability SID（`token.rs:286-327`）
- **Workspace-write 模式**：通过 `create_workspace_write_token_with_caps_from()` 创建，传入多个 capability SID（通常包含工作区专属 SID），使沙箱进程可写入被这些 SID 授权的目录（`token.rs:311-316`）

### 3. 文件系统 ACL 操作流程

ACL 操作围绕"先查再改"的模式展开：

**添加 Allow ACE**（`add_allow_ace`，`token.rs:390-450`）：
1. `GetNamedSecurityInfoW` 获取目标路径的现有 DACL
2. `dacl_has_write_allow_for_sid()` 检查是否已有写权限——若有则跳过，避免不必要的 DACL 重写
3. 构建 `EXPLICIT_ACCESS_W`（`SET_ACCESS` 模式），权限为 `FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE`，带容器和对象继承
4. `SetEntriesInAclW` 合并新 ACE 到现有 DACL → `SetNamedSecurityInfoW` 写回

**添加 Deny ACE**（`add_deny_write_ace`，`acl.rs:456-517`）：
1. 同样先检查是否已有 deny ACE
2. deny mask 覆盖全部写相关权限：`FILE_GENERIC_WRITE | FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | GENERIC_WRITE | DELETE | FILE_DELETE_CHILD`
3. 使用 `DENY_ACCESS` 模式写入

**撤销 ACE**（`revoke_ace`，`acl.rs:519-569`）：
1. 使用 `REVOKE_ACCESS` 模式（值为 4）移除指定 SID 的所有 ACE
2. 用于沙箱清理阶段

**Null 设备授权**（`allow_null_device`，`acl.rs:575-636`）：
- 打开 `\\.\NUL` 设备并修改其内核对象 DACL，授予沙箱 SID RWX 权限
- 确保沙箱进程的 stdout/stderr 重定向正常工作

### 4. Capability SID 持久化流程

Capability SID 以 JSON 格式存储在 `{codex_home}/cap_sid` 文件中：

1. `load_or_create_cap_sids()` 尝试读取现有文件（`cap.rs:49-76`）：
   - 若为 JSON 格式 → 反序列化为 `CapSids`
   - 若为纯文本（旧格式兼容）→ 将其作为 workspace SID，生成新的 readonly SID，升级到 JSON 格式
   - 若不存在 → 生成全新的 workspace 和 readonly SID 对
2. `workspace_cap_sid_for_cwd()` 管理**按工作目录隔离**的 SID（`cap.rs:79-90`）：
   - 以规范化路径（`canonical_path_key`）为 key 查找
   - 若无对应 SID → 生成新随机 SID 并持久化
   - 这确保不同工作区的沙箱进程互相隔离，无法跨工作区写入

SID 格式为标准 Windows SID 字符串：`S-1-5-21-{random}-{random}-{random}-{random}`（`cap.rs:31-38`）

### 5. 工作区目录保护流程

`workspace_acl.rs` 实现了对敏感目录的写保护：

1. `protect_workspace_codex_dir(cwd, psid)` → 对 `{cwd}/.codex` 添加 deny-write ACE（`workspace_acl.rs:13-15`）
2. `protect_workspace_agents_dir(cwd, psid)` → 对 `{cwd}/.agents` 添加 deny-write ACE（`workspace_acl.rs:19-21`）
3. 底层 `protect_workspace_subdir()` 先检查目录是否存在，仅在目录实际存在时才施加 deny ACE（`workspace_acl.rs:23-30`）

## 函数签名与参数说明

### token.rs — 令牌操作

| 函数 | 签名 | 说明 |
|------|------|------|
| `get_current_token_for_restriction` | `() -> Result<HANDLE>` | 打开当前进程令牌，返回的句柄需调用方关闭 |
| `get_logon_sid_bytes` | `(h_token: HANDLE) -> Result<Vec<u8>>` | 从令牌中提取 logon SID 的原始字节，含 linked token 回退 |
| `create_readonly_token_with_cap` | `(psid_capability: *mut c_void) -> Result<(HANDLE, *mut c_void)>` | 创建只读受限令牌（便捷入口，自动获取基础令牌） |
| `create_readonly_token_with_cap_from` | `(base_token: HANDLE, psid_capability: *mut c_void) -> Result<(HANDLE, *mut c_void)>` | 基于指定令牌创建只读受限令牌 |
| `create_readonly_token_with_caps_from` | `(base_token: HANDLE, psid_capabilities: &[*mut c_void]) -> Result<HANDLE>` | 创建包含多个 capability SID 的只读令牌 |
| `create_workspace_write_token_with_caps_from` | `(base_token: HANDLE, psid_capabilities: &[*mut c_void]) -> Result<HANDLE>` | 创建 workspace-write 模式令牌 |
| `world_sid` | `() -> Result<Vec<u8>>` | 返回 Everyone (World) SID 的原始字节 |
| `convert_string_sid_to_sid` | `(s: &str) -> Option<*mut c_void>` | 将 SID 字符串转换为二进制 SID 指针，调用方需 `LocalFree` |

### acl.rs — DACL 操作

| 函数 | 签名 | 说明 |
|------|------|------|
| `fetch_dacl_handle` | `(path: &Path) -> Result<(*mut ACL, *mut c_void)>` | 通过文件句柄获取 DACL，返回 (DACL 指针, SD 指针) |
| `dacl_mask_allows` | `(p_dacl: *mut ACL, psids: &[*mut c_void], desired_mask: u32, require_all_bits: bool) -> bool` | 检查 DACL 中是否有 ACE 为指定 SID 授予目标权限 |
| `path_mask_allows` | `(path: &Path, psids: &[*mut c_void], desired_mask: u32, require_all_bits: bool) -> Result<bool>` | `dacl_mask_allows` 的路径便捷封装 |
| `dacl_has_write_allow_for_sid` | `(p_dacl: *mut ACL, psid: *mut c_void) -> bool` | 检查是否有针对指定 SID 的写允许 ACE |
| `dacl_has_write_deny_for_sid` | `(p_dacl: *mut ACL, psid: *mut c_void) -> bool` | 检查是否有针对指定 SID 的写拒绝 ACE |
| `add_allow_ace` | `(path: &Path, psid: *mut c_void) -> Result<bool>` | 添加 RWX 允许 ACE，幂等（已存在则跳过） |
| `add_deny_write_ace` | `(path: &Path, psid: *mut c_void) -> Result<bool>` | 添加写拒绝 ACE，幂等 |
| `ensure_allow_write_aces` | `(path: &Path, sids: &[*mut c_void]) -> Result<bool>` | 批量确保多个 SID 拥有写权限 |
| `ensure_allow_mask_aces` | `(path: &Path, sids: &[*mut c_void], allow_mask: u32) -> Result<bool>` | 批量确保多个 SID 拥有指定权限掩码 |
| `ensure_allow_mask_aces_with_inheritance` | `(path: &Path, sids: &[*mut c_void], allow_mask: u32, inheritance: u32) -> Result<bool>` | 同上但可自定义继承标志 |
| `revoke_ace` | `(path: &Path, psid: *mut c_void)` | 撤销指定 SID 在目标路径上的所有 ACE |
| `allow_null_device` | `(psid: *mut c_void)` | 授予沙箱 SID 对 `\\.\NUL` 的 RWX 权限 |

### cap.rs — Capability SID 管理

| 函数 | 签名 | 说明 |
|------|------|------|
| `load_or_create_cap_sids` | `(codex_home: &Path) -> Result<CapSids>` | 加载或新建全局 capability SID 集合 |
| `workspace_cap_sid_for_cwd` | `(codex_home: &Path, cwd: &Path) -> Result<String>` | 获取（或生成）指定工作目录的专属 capability SID |
| `cap_sid_file` | `(codex_home: &Path) -> PathBuf` | 返回 cap_sid 持久化文件路径 |

### workspace_acl.rs — 工作区保护

| 函数 | 签名 | 说明 |
|------|------|------|
| `protect_workspace_codex_dir` | `(cwd: &Path, psid: *mut c_void) -> Result<bool>` | 对 `.codex` 目录添加写拒绝 ACE |
| `protect_workspace_agents_dir` | `(cwd: &Path, psid: *mut c_void) -> Result<bool>` | 对 `.agents` 目录添加写拒绝 ACE |
| `is_command_cwd_root` | `(root: &Path, canonical_command_cwd: &Path) -> bool` | 判断命令 CWD 是否为沙箱根目录 |

## 接口/类型定义

### `CapSids`（`cap.rs:14-25`）

持久化存储的 capability SID 集合，JSON 序列化/反序列化：

```rust
pub struct CapSids {
    pub workspace: String,           // 全局 workspace-write 模式 SID
    pub readonly: String,            // 全局 read-only 模式 SID
    pub workspace_by_cwd: HashMap<String, String>,  // 按工作目录隔离的 SID 映射
}
```

### `CreateRestrictedToken` 标志常量（`token.rs:40-42`）

| 常量 | 值 | 含义 |
|------|------|------|
| `DISABLE_MAX_PRIVILEGE` | `0x01` | 禁用令牌中几乎所有权限 |
| `LUA_TOKEN` | `0x04` | 降级到受限用户级别 |
| `WRITE_RESTRICTED` | `0x08` | 只允许对 restricting SID 列表中的 SID 进行写操作 |

### ACL 继承常量（`acl.rs:637-638`）

| 常量 | 值 | 含义 |
|------|------|------|
| `CONTAINER_INHERIT_ACE` | `0x2` | ACE 被子目录继承 |
| `OBJECT_INHERIT_ACE` | `0x1` | ACE 被子文件继承 |

## 配置项与默认值

- **持久化路径**：`{codex_home}/cap_sid` — 通过 `cap_sid_file()` 计算，`codex_home` 由上层传入
- **SID 格式**：`S-1-5-21-{4 个随机 u32}` — 标准 Windows SID，子授权机构值随机生成
- **WRITE_ALLOW_MASK**（`acl.rs:262-266`）：`FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE | FILE_DELETE_CHILD` — `ensure_allow_write_aces` 使用的默认写权限掩码
- **Deny Write Mask**（`acl.rs:482-489`）：覆盖 `FILE_GENERIC_WRITE`、`FILE_WRITE_DATA`、`FILE_APPEND_DATA`、`FILE_WRITE_EA`、`FILE_WRITE_ATTRIBUTES`、`GENERIC_WRITE`、`DELETE`、`FILE_DELETE_CHILD` — 尽可能全面地阻止写操作

## 边界 Case 与注意事项

- **UAC linked token 回退**：当以管理员身份运行时，logon SID 可能只在 linked token（未提权的那半）上。`get_logon_sid_bytes` 会自动查询 `TokenLinkedToken` 并在其中搜索（`token.rs:216-249`）。若两个令牌都没有 logon SID，返回错误。

- **旧格式文件兼容**：`load_or_create_cap_sids` 兼容只包含一个纯文本 SID 的旧版 `cap_sid` 文件——将其升级为 JSON 格式并补充 readonly SID（`cap.rs:59-67`）。

- **路径规范化**：`workspace_cap_sid_for_cwd` 使用 `canonical_path_key()` 规范化路径，确保 `C:\Foo` 和 `c:/FOO` 映射到同一个 SID。测试 `equivalent_cwd_spellings_share_workspace_sid_key` 验证了这一行为（`cap.rs:100-120`）。

- **ACE 幂等性**：`add_allow_ace`、`add_deny_write_ace`、`ensure_allow_mask_aces` 均先检查是否已存在匹配 ACE，避免重复添加导致 DACL 膨胀。

- **Inherit-only ACE 过滤**：`dacl_mask_allows` 和 `dacl_has_write_allow/deny_for_sid` 均跳过设置了 `INHERIT_ONLY_ACE` 标志的 ACE，因为这些 ACE 不作用于当前对象本身。

- **Default DACL 的必要性**：没有 `set_default_dacl`，沙箱进程创建命名管道等 IPC 对象时会因默认 DACL 过于严格而收到 `ACCESS_DENIED`。这在 PowerShell 构建管道时尤为关键（`token.rs:52-53`）。

- **`revoke_ace` 静默失败**：该函数不返回 `Result`，所有错误被静默忽略。这是清理路径的设计选择——沙箱关闭时尽力撤销 ACE，但不因失败阻塞。

- **目录保护的前置条件**：`protect_workspace_subdir` 仅在目录已存在时添加 deny ACE（`workspace_acl.rs:25`）。若 `.codex` 或 `.agents` 尚未创建，保护操作为 no-op。