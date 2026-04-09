# KeyringStore — OS 密钥环抽象层

## 概述与职责

`codex-keyring-store` 是 Codex 认证体系（Auth 模块）中的底层凭据存储 crate，提供了跨平台的 OS 密钥环访问抽象。它定义了统一的 `KeyringStore` trait，使上层模块（如 OAuth 登录、API Key 管理）无需关心底层操作系统的凭据存储差异，即可实现凭据的加载、保存和删除。

在整体架构中，Auth 模块为 Core、TUI、AppServer、ModelProviders、CloudTasks 等多个上层模块提供认证支持，而 `KeyringStore` 则是 Auth 模块中负责"持久化凭据到 OS 安全存储"的最底层组件。

### 平台后端

通过 `keyring` crate 的条件编译 feature，自动适配不同操作系统的原生凭据存储（`Cargo.toml:14-24`）：

| 平台 | Feature | 底层后端 |
|------|---------|---------|
| macOS | `apple-native` | macOS Keychain |
| Windows | `windows-native` | Windows Credential Manager |
| Linux | `linux-native-async-persistent` | Secret Service (GNOME Keyring / KWallet) |
| FreeBSD / OpenBSD | `sync-secret-service` | Secret Service |

所有平台均启用 `crypto-rust` feature 以使用纯 Rust 加密实现。

## 关键流程

### 凭据加载流程（load）

1. 使用 `service` 和 `account` 构造 `keyring::Entry`
2. 调用 `entry.get_password()` 从 OS 密钥环读取密码
3. 成功返回 `Ok(Some(password))`；若条目不存在返回 `Ok(None)`（而非报错）；其他错误包装为 `CredentialStoreError`

> 源码位置：`codex-rs/keyring-store/src/lib.rs:52-69`

### 凭据保存流程（save）

1. 构造 `keyring::Entry`
2. 调用 `entry.set_password(value)` 写入密钥环
3. 成功返回 `Ok(())`，失败返回 `CredentialStoreError`

> 源码位置：`codex-rs/keyring-store/src/lib.rs:71-87`

### 凭据删除流程（delete）

1. 构造 `keyring::Entry`
2. 调用 `entry.delete_credential()`
3. 成功删除返回 `Ok(true)`；条目不存在返回 `Ok(false)`；其他错误返回 `CredentialStoreError`

> 源码位置：`codex-rs/keyring-store/src/lib.rs:89-107`

所有操作均通过 `tracing::trace!` 输出调试日志，包含 service、account 以及操作结果，便于排查凭据问题。

## 函数签名与接口定义

### `KeyringStore` trait

```rust
pub trait KeyringStore: Debug + Send + Sync {
    fn load(&self, service: &str, account: &str) -> Result<Option<String>, CredentialStoreError>;
    fn save(&self, service: &str, account: &str, value: &str) -> Result<(), CredentialStoreError>;
    fn delete(&self, service: &str, account: &str) -> Result<bool, CredentialStoreError>;
}
```

> 源码位置：`codex-rs/keyring-store/src/lib.rs:42-46`

**参数说明**：

- `service`：服务标识符，通常为应用名称（如 `"codex"`），用于在密钥环中隔离不同应用的凭据
- `account`：账户标识符，表示具体的凭据条目（如 `"api_key"`、`"oauth_token"`）
- `value`（save）：要存储的凭据值（明文字符串，由 OS 密钥环负责加密存储）

**返回值语义**：

| 方法 | 返回值 | 含义 |
|------|--------|------|
| `load` | `Ok(Some(s))` | 成功读取凭据 |
| `load` | `Ok(None)` | 条目不存在 |
| `save` | `Ok(())` | 保存成功 |
| `delete` | `Ok(true)` | 成功删除 |
| `delete` | `Ok(false)` | 条目不存在，无需删除 |

trait 要求实现 `Debug + Send + Sync`，确保可安全地在多线程环境中共享使用。

### `DefaultKeyringStore`

```rust
pub struct DefaultKeyringStore;
```

无状态的单元结构体，直接委托给 `keyring::Entry` 与底层 OS 密钥环交互。这是生产环境使用的实现。

> 源码位置：`codex-rs/keyring-store/src/lib.rs:48-107`

## 类型定义

### `CredentialStoreError`

```rust
pub enum CredentialStoreError {
    Other(KeyringError),
}
```

> 源码位置：`codex-rs/keyring-store/src/lib.rs:9-11`

对 `keyring::Error` 的包装类型，实现了 `Debug`、`Display`、`Error` trait。提供以下方法：

- `new(error: KeyringError)` — 从底层错误构造
- `message() -> String` — 获取错误描述字符串
- `into_error() -> KeyringError` — 取出内部的原始 `KeyringError`

## 测试支持：MockKeyringStore

`tests` 模块（公开模块，非 `#[cfg(test)]`）提供了 `MockKeyringStore`，供其他 crate 在测试中替代真实密钥环。

```rust
pub struct MockKeyringStore {
    credentials: Arc<Mutex<HashMap<String, Arc<MockCredential>>>>,
}
```

> 源码位置：`codex-rs/keyring-store/src/lib.rs:120-123`

### Mock 特点

- **内存存储**：凭据保存在 `HashMap` 中，不接触 OS 密钥环
- **线程安全**：通过 `Arc<Mutex<...>>` 实现，且支持 `Clone`
- **可注入错误**：`set_error(account, error)` 方法可让指定 account 的后续操作返回特定错误，用于模拟密钥环故障场景
- **忽略 service 参数**：Mock 实现中 `_service` 参数被忽略，仅按 `account` 索引凭据

### Mock 辅助方法

| 方法 | 用途 |
|------|------|
| `credential(account)` | 获取或创建指定 account 的 `MockCredential`，返回 `Arc<MockCredential>` |
| `saved_value(account)` | 直接读取 account 当前存储的值，返回 `Option<String>` |
| `set_error(account, error)` | 为指定 account 注入错误 |
| `contains(account)` | 检查是否存在指定 account 的条目 |

### Mock 的 delete 行为

Mock 的 `delete` 实现除了调用底层 `MockCredential::delete_credential()` 外，还会从 `HashMap` 中移除该条目（`codex-rs/keyring-store/src/lib.rs:218-222`），确保后续 `load` 返回 `None`。

## 边界 Case 与注意事项

- **条目不存在是正常情况**：`load` 和 `delete` 将 `keyring::Error::NoEntry` 视为正常返回（`None` / `false`），而非错误。上层调用者无需捕获"未找到"异常。
- **Mutex 中毒恢复**：`MockKeyringStore` 在所有 `lock()` 调用上使用 `unwrap_or_else(PoisonError::into_inner)`，即使某个线程 panic 导致 Mutex 中毒，也会恢复而非传播 panic。
- **`tests` 模块是公开的**：`pub mod tests` 而非 `#[cfg(test)]`，这是有意为之——其他 crate（如认证模块的测试）可以直接 `use codex_keyring_store::tests::MockKeyringStore`。
- **日志不含敏感值**：`save` 操作的 trace 日志只记录 `value.len()` 而非实际值，避免凭据泄露到日志中。