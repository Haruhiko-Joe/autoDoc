# 凭据存储（CredentialStorage）

## 概述与职责

凭据存储模块是 Codex 认证系统的持久化层，负责管理 CLI 认证凭据（OAuth token、API key 等）的存储、读取和删除。它通过 `AuthStorageBackend` trait 定义了统一的存储接口，并提供四种可插拔的后端实现，让上层的 `AuthManager` 无需关心凭据实际存放在哪里。

**在系统架构中的位置**：该模块属于 Auth > Login 子系统。Login crate 中的 `AuthManager` 编排 token 的加载、刷新与持久化生命周期，而本模块就是持久化的具体执行者。KeyringStore trait 来自同级的 `codex-keyring-store` crate，提供跨平台 OS 密钥链的抽象。

源码位置：`codex-rs/login/src/auth/storage.rs`

## 关键流程

### 存储后端的创建

上层通过工厂函数 `create_auth_storage()` 根据用户配置的 `AuthCredentialsStoreMode` 创建对应的后端实例（`storage.rs:311-317`）：

1. 创建一个 `DefaultKeyringStore` 作为 OS 密钥链访问的默认实现
2. 委托给 `create_auth_storage_with_keyring_store()`，根据 mode 枚举值匹配并构造对应的后端
3. 返回 `Arc<dyn AuthStorageBackend>`，调用方通过 trait object 统一使用

### Auto 模式的降级策略

`AutoAuthStorage` 是最常用的模式，其核心策略是"keyring 优先，文件兜底"（`storage.rs:240-266`）：

- **load**：先尝试从 keyring 加载；如果 keyring 中无数据，回退到文件；如果 keyring 报错，也回退到文件并记录警告日志
- **save**：先尝试写入 keyring；如果 keyring 写入失败，回退到文件存储
- **delete**：调用 keyring 后端的 delete，keyring 后端内部会同时清除 keyring 条目和磁盘文件

### Keyring 存储的键计算

为了将不同的 `codex_home` 路径映射为稳定的 keyring 键名，`compute_store_key()` 函数（`storage.rs:138-149`）执行以下步骤：

1. 对 `codex_home` 路径做 `canonicalize()`（失败时使用原始路径）
2. 对规范化后的路径字符串计算 SHA-256 哈希
3. 截取哈希的前 16 个十六进制字符
4. 返回 `"cli|{truncated_hash}"` 格式的键名

这确保了不同 `codex_home` 目录的凭据互不干扰，同时键名足够短，适合存入 OS 密钥链。

### 文件存储的安全写入

`FileAuthStorage::save()` 在写入 `auth.json` 时（`storage.rs:111-128`）：

1. 确保父目录存在（`create_dir_all`）
2. 将 `AuthDotJson` 序列化为格式化的 JSON
3. 在 Unix 系统上以 `0o600`（仅所有者可读写）权限创建文件
4. 使用 truncate + write + flush 保证原子性写入

## 核心 Trait 与类型

### `AuthStorageBackend` trait

```rust
// storage.rs:72-76
pub(super) trait AuthStorageBackend: Debug + Send + Sync {
    fn load(&self) -> std::io::Result<Option<AuthDotJson>>;
    fn save(&self, auth: &AuthDotJson) -> std::io::Result<()>;
    fn delete(&self) -> std::io::Result<bool>;
}
```

所有后端实现必须满足 `Debug + Send + Sync`，以支持跨线程共享。三个方法的语义：

| 方法 | 返回值 | 说明 |
|------|--------|------|
| `load` | `Ok(Some(auth))` / `Ok(None)` | 加载凭据。不存在时返回 `None`，而非报错 |
| `save` | `Ok(())` | 持久化凭据。覆盖已有数据 |
| `delete` | `Ok(bool)` | 删除凭据。返回 `true` 表示确实删除了内容 |

### `AuthCredentialsStoreMode` 枚举

```rust
// storage.rs:29-41
pub enum AuthCredentialsStoreMode {
    #[default]
    File,      // 持久化到 CODEX_HOME/auth.json
    Keyring,   // 持久化到 OS 密钥链，不可用时报错
    Auto,      // 优先 keyring，失败降级到文件
    Ephemeral, // 仅内存中，进程退出即丢失
}
```

默认值为 `File`。该枚举实现了 `Serialize`/`Deserialize`/`JsonSchema`，可直接用于配置文件解析。serde 使用小写命名（`rename_all = "lowercase"`）。

### `AuthDotJson` 数据模型

对应 `$CODEX_HOME/auth.json` 文件的结构（`storage.rs:44-57`）：

| 字段 | 类型 | JSON 键名 | 说明 |
|------|------|-----------|------|
| `auth_mode` | `Option<AuthMode>` | `auth_mode` | 认证模式（来自 `codex_app_server_protocol`） |
| `openai_api_key` | `Option<String>` | `OPENAI_API_KEY` | OpenAI API 密钥 |
| `tokens` | `Option<TokenData>` | `tokens` | OAuth token 数据 |
| `last_refresh` | `Option<DateTime<Utc>>` | `last_refresh` | 上次 token 刷新时间 |

所有字段均为 `Option`，空值字段在序列化时被跳过（`skip_serializing_if = "Option::is_none"`）。

## 四种后端实现

### `FileAuthStorage`

最基础的文件存储后端（`storage.rs:78-133`）。将凭据以 JSON 格式存储在 `{codex_home}/auth.json`。

- **安全性**：Unix 下文件权限设为 `0600`，仅文件所有者可访问
- **读取**：文件不存在时返回 `Ok(None)` 而非报错
- **写入**：truncate 模式覆盖写入，并 flush 确保落盘

### `KeyringAuthStorage`

基于 OS 密钥链的存储后端（`storage.rs:151-223`）。通过 `KeyringStore` trait 与平台原生凭据管理器交互（macOS Keychain、Windows Credential Manager、Linux Secret Service）。

- **服务名**：固定为 `"Codex Auth"`（`KEYRING_SERVICE` 常量）
- **键名**：由 `compute_store_key()` 根据 `codex_home` 路径哈希生成
- **save 副作用**：保存到 keyring 后，会尝试删除磁盘上的 `auth.json` 文件（`storage.rs:206-208`），避免敏感数据残留在文件系统中
- **delete**：同时清除 keyring 条目和磁盘文件

### `AutoAuthStorage`

组合模式后端（`storage.rs:225-266`），内部持有 `KeyringAuthStorage` 和 `FileAuthStorage` 两个后端实例。策略：

- **load**：keyring 优先 → keyring 无数据时读文件 → keyring 出错时也读文件（并发出警告）
- **save**：keyring 优先 → keyring 写失败时降级到文件
- **delete**：委托给 keyring 后端（其 delete 实现会同时清理文件）

这种设计保证了在没有可用密钥链的环境中（如无桌面的 CI/CD 容器），认证仍能正常工作。

### `EphemeralAuthStorage`

纯内存后端（`storage.rs:268-309`），适用于测试或一次性会话场景。

- **底层存储**：全局静态 `Lazy<Mutex<HashMap<String, AuthDotJson>>>`，所有 `EphemeralAuthStorage` 实例共享同一个 HashMap
- **键名**：复用 `compute_store_key()` 的哈希逻辑，以 `codex_home` 路径区分不同实例
- **生命周期**：数据仅在进程存活期间有效，进程退出即丢失
- **并发安全**：通过 `Mutex` 保护，`with_store()` 辅助方法封装了加锁逻辑（`storage.rs:282-291`）

## 辅助函数

### `get_auth_file(codex_home: &Path) -> PathBuf`

返回 `{codex_home}/auth.json` 的完整路径（`storage.rs:59-61`）。被 `FileAuthStorage` 和 `delete_file_if_exists` 共同使用。

### `delete_file_if_exists(codex_home: &Path) -> io::Result<bool>`

删除 `auth.json` 文件（`storage.rs:63-70`）。文件不存在时返回 `Ok(false)` 而非报错，文件存在并成功删除时返回 `Ok(true)`。被多个后端的 `delete` 实现复用。

## 边界 Case 与注意事项

- **路径规范化失败**：`compute_store_key()` 在 `canonicalize()` 失败时（如路径尚不存在），会降级使用原始路径计算哈希。这意味着同一目录在创建前后可能产生不同的键名。
- **Keyring 保存时的清理行为**：`KeyringAuthStorage::save()` 成功写入 keyring 后会删除磁盘上的 `auth.json`。如果删除失败只发出警告，不影响保存成功的返回。
- **EphemeralAuthStorage 的全局状态**：虽然每个实例独立创建，但底层 HashMap 是全局共享的 `static`。在同一进程中创建多个指向相同 `codex_home` 的 `EphemeralAuthStorage` 实例，它们会共享同一份凭据数据。
- **文件权限仅限 Unix**：`0o600` 权限设置通过 `#[cfg(unix)]` 条件编译，在 Windows 上不会应用文件权限限制。