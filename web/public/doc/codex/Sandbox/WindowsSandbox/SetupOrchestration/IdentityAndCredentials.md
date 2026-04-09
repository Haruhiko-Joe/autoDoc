# 身份验证与凭据加载（IdentityAndCredentials）

## 概述与职责

本模块（`identity.rs`）是 Windows 沙箱执行路径中的**运行时身份验证与凭据加载**组件。它位于系统层级 `Sandbox → WindowsSandbox → SetupOrchestration` 之下，与同级的 Setup 流程（用户账户创建、防火墙规则配置、DPAPI 加密等）紧密协作。

核心职责：
- **验证沙箱初始化状态**：通过读取 `setup_marker.json` 和 `sandbox_users.json` 的版本戳判断环境是否就绪
- **选择身份**：根据沙箱策略和代理强制状态，选择 Offline 或 Online 身份
- **解密凭据**：对 DPAPI 加密的密码执行 Base64 解码 + `dpapi::unprotect` 解密
- **触发提权安装**：当标记文件缺失或防火墙配置偏移时，自动调用 `run_elevated_setup`
- **刷新 ACL**：凭据加载后**总是**执行一次非提权的 ACL 刷新

## 关键流程

### 凭据获取主流程（`require_logon_sandbox_creds`）

这是模块的核心入口，完整流程如下：

1. **计算运行时参数**：调用 `gather_read_roots` / `gather_write_roots` 收集当前需要的读写根目录，通过 `SandboxNetworkIdentity::from_policy` 根据沙箱策略和 `proxy_enforced` 标志确定网络身份类型（Offline/Online），并计算期望的离线代理设置（`identity.rs:138-143`）

2. **检查 Setup Marker**：加载 `setup_marker.json`，验证版本是否匹配。若 marker 存在且版本匹配，进一步调用 `marker.request_mismatch_reason()` 检查防火墙设置是否与当前请求一致。任何不匹配都会记录原因并置 identity 为 `None`（`identity.rs:149-169`）

3. **选择身份并解密密码**：若 marker 校验通过，调用 `select_identity` 进一步校验 `sandbox_users.json` 版本，根据网络身份类型选择 `users.offline` 或 `users.online` 记录，解密密码（`identity.rs:107-128`）

4. **条件性触发提权安装**：若 identity 仍为 `None`（marker 缺失、版本不匹配、防火墙偏移、用户文件异常），记录原因日志后调用 `run_elevated_setup` 执行提权安装，安装完成后再次尝试 `select_identity`（`identity.rs:171-195`）

5. **无条件 ACL 刷新**：无论是否触发了提权安装，**始终**调用 `run_setup_refresh` 执行非提权 ACL 刷新，确保当前读写根目录的 ACL 与最新策略同步（`identity.rs:197-204`）

6. **返回凭据**：将解密后的用户名和密码封装为 `SandboxCreds` 返回。若经过所有尝试仍无法获得有效身份，返回错误（`identity.rs:205-213`）

### Setup 完整性快速检查（`sandbox_setup_is_complete`）

供外部模块使用的**轻量级**就绪检查，仅验证两个文件的版本戳是否匹配，不执行防火墙偏移检测或凭据解密：

```rust
// identity.rs:40-46
pub fn sandbox_setup_is_complete(codex_home: &Path) -> bool {
    let marker_ok = matches!(load_marker(codex_home), Ok(Some(marker)) if marker.version_matches());
    if !marker_ok {
        return false;
    }
    matches!(load_users(codex_home), Ok(Some(users)) if users.version_matches())
}
```

### 密码解密流程（`decode_password`）

对 `SandboxUserRecord` 中存储的密码执行两步解密（`identity.rs:98-105`）：
1. **Base64 解码**：使用标准 Base64 引擎将字符串还原为字节数组
2. **DPAPI 解密**：调用 `dpapi::unprotect` 解密受 Windows DPAPI 保护的数据
3. **UTF-8 转换**：将解密后的字节转为字符串

## 函数签名与参数说明

### `sandbox_setup_is_complete(codex_home: &Path) -> bool`

快速检查沙箱初始化是否完成。

| 参数 | 类型 | 说明 |
|------|------|------|
| `codex_home` | `&Path` | Codex 主目录路径，marker 和 users 文件存储在其子目录中 |

**返回值**：`true` 表示 marker 和 users 文件均存在且版本匹配。

> 源码位置：`identity.rs:40-46`

### `require_logon_sandbox_creds(...) -> Result<SandboxCreds>`

获取沙箱执行所需的登录凭据，必要时触发提权安装。

| 参数 | 类型 | 说明 |
|------|------|------|
| `policy` | `&SandboxPolicy` | 当前沙箱策略（决定读写权限和网络模式） |
| `policy_cwd` | `&Path` | 策略计算使用的工作目录 |
| `command_cwd` | `&Path` | 实际命令执行的工作目录 |
| `env_map` | `&HashMap<String, String>` | 环境变量映射 |
| `codex_home` | `&Path` | Codex 主目录 |
| `proxy_enforced` | `bool` | 是否强制使用代理（影响 Online/Offline 身份选择） |

**返回值**：`Result<SandboxCreds>` — 成功时包含解密后的用户名和密码。

> 源码位置：`identity.rs:130-214`

## 接口/类型定义

### `SandboxCreds`（公开）

对外暴露的凭据结构体，包含解密后的明文用户名和密码。

| 字段 | 类型 | 说明 |
|------|------|------|
| `username` | `String` | 沙箱用户账户名（如 `CodexSandboxOffline` / `CodexSandboxOnline`） |
| `password` | `String` | 解密后的明文密码 |

> 源码位置：`identity.rs:29-33`

### `SandboxIdentity`（内部）

内部使用的身份结构体，字段与 `SandboxCreds` 相同但不对外暴露。在 `select_identity` 中构造，在 `require_logon_sandbox_creds` 末尾转换为 `SandboxCreds`。

> 源码位置：`identity.rs:23-27`

## 边界 Case 与注意事项

- **文件读取/解析失败的容错**：`load_marker` 和 `load_users` 对文件不存在（`NotFound`）、读取失败、JSON 解析失败均做了优雅降级——记录调试日志后返回 `None`，不会直接 panic 或抛出错误（`identity.rs:50-70`、`identity.rs:73-96`）

- **防火墙偏移检测**：即使 marker 版本匹配，`request_mismatch_reason` 仍会检查当前请求的网络身份和离线代理设置是否与 marker 记录一致。若防火墙配置已"漂移"，会触发重新安装（`identity.rs:151-155`）

- **sandbox 目录不可写**：注释明确指出 `CODEX_HOME/.sandbox` **不能**加入 `needed_write`，因为受限的 capability token 不应拥有该目录的写权限。访问控制由 setup 阶段的 `lock_sandbox_dir` 单独处理（`identity.rs:144-146`）

- **ACL 刷新始终执行**：即使凭据已缓存且无需重新安装，ACL 刷新仍会执行。这确保当读写根目录集合在两次调用之间发生变化时，ACL 权限始终保持同步（`identity.rs:196-204`）

- **提权安装后的二次验证**：`run_elevated_setup` 完成后会再次调用 `select_identity` 加载新写入的凭据。若此时仍失败（如安装过程中出现异常），最终会返回明确的错误信息指引用户手动重新执行安装（`identity.rs:205-209`）