# Secrets — 加密密钥管理

## 概述与职责

`codex-secrets` 是 Codex 的加密密钥管理 crate，隶属于 **Auth** 模块体系。它为用户提供安全的密钥存储能力（API keys、tokens 等敏感值），支持**全局**和**按环境（per-environment）** 两种作用域。密钥以 JSON 格式序列化后，通过 [age](https://github.com/str4d/rage) 库使用 scrypt 口令加密，存储在本地文件 `local.age` 中；加密所用的口令本身则保存在操作系统的 keyring 中，从而避免任何明文密钥出现在磁盘上。

此外，该 crate 还提供了一个基于正则表达式的**输出净化器（sanitizer）**，用于在日志和终端输出中自动脱敏已知格式的密钥（OpenAI key、AWS Access Key、Bearer Token 等）。

在 Auth 模块中，`codex-secrets` 与 `codex-keyring-store`（OS keyring 抽象层）协同工作：keyring-store 负责底层 keyring 读写，secrets crate 在其之上实现完整的加密存储流程。同级模块还包括 ChatGPT OAuth 登录和 API key 认证等其他凭证管理能力。

## 关键流程

### 密钥写入（Set）流程

1. 调用 `SecretsManager::set()` 传入作用域（`SecretScope`）、名称（`SecretName`）和值
2. `LocalSecretsBackend::set()` 校验值非空，生成 canonical key（如 `global/GITHUB_TOKEN` 或 `env/my-repo/API_KEY`）
3. 调用 `load_file()` 读取现有密钥文件：
   - 若 `local.age` 不存在，返回空的 `SecretsFile`
   - 若存在，从 OS keyring 加载口令 → 用 age scrypt 解密 → JSON 反序列化
4. 将新密钥插入 `BTreeMap<String, String>`
5. 调用 `save_file()`：JSON 序列化 → age scrypt 加密 → **原子写入**磁盘（先写临时文件，再 rename）

### 口令管理（Passphrase）流程

口令的加载由 `load_or_create_passphrase()` 处理（`src/local.rs:159-181`）：

1. 计算 keyring account 标识：对 `codex_home` 路径取 SHA-256，截取前 16 位十六进制字符，格式为 `secrets|<hash_prefix>`
2. 尝试从 OS keyring（service=`"codex"`）加载已有口令
3. 若不存在，用 `OsRng` 生成 32 字节随机数 → Base64 编码 → 存入 keyring
4. 生成后立即用 volatile write + compiler fence 擦除原始字节（`wipe_bytes()`，`src/local.rs:284-291`）

### 环境 ID 推导

`environment_id_from_cwd()` 根据当前工作目录自动推导环境标识（`src/lib.rs:142-163`）：

1. 优先使用 git 仓库根目录的目录名（通过 `codex-git-utils::get_git_repo_root`）
2. 若不在 git 仓库中，对规范化路径取 SHA-256，截取前 12 位，格式为 `cwd-<hash_prefix>`

### 输出脱敏（Sanitizer）流程

`redact_secrets()` 对输入字符串依次应用四个正则替换（`src/sanitizer.rs:15-22`）：

1. **OpenAI Key** — `sk-` 前缀 + 20+ 位字母数字 → `[REDACTED_SECRET]`
2. **AWS Access Key ID** — `AKIA` 前缀 + 16 位大写字母数字 → `[REDACTED_SECRET]`
3. **Bearer Token** — `Bearer` + 16+ 位 token → `Bearer [REDACTED_SECRET]`
4. **通用赋值** — 匹配 `api_key=...`、`token: "..."`、`secret=...`、`password=...` 等模式 → 保留键名，替换值为 `[REDACTED_SECRET]`

## 公开接口

### `SecretsManager`

门面（facade）结构体，封装后端实现。支持 `Clone`。

```rust
// src/lib.rs:102-110
pub fn new(codex_home: PathBuf, backend_kind: SecretsBackendKind) -> Self
pub fn new_with_keyring_store(codex_home: PathBuf, backend_kind: SecretsBackendKind, keyring_store: Arc<dyn KeyringStore>) -> Self
```

CRUD 方法：

| 方法 | 签名 | 说明 |
|------|------|------|
| `set` | `(&self, scope: &SecretScope, name: &SecretName, value: &str) -> Result<()>` | 创建或更新密钥 |
| `get` | `(&self, scope: &SecretScope, name: &SecretName) -> Result<Option<String>>` | 读取密钥，不存在返回 `None` |
| `delete` | `(&self, scope: &SecretScope, name: &SecretName) -> Result<bool>` | 删除密钥，返回是否存在 |
| `list` | `(&self, scope_filter: Option<&SecretScope>) -> Result<Vec<SecretListEntry>>` | 列出密钥，可按作用域过滤 |

### `SecretsBackend` trait

```rust
// src/lib.rs:89-94
pub trait SecretsBackend: Send + Sync {
    fn set(&self, scope: &SecretScope, name: &SecretName, value: &str) -> Result<()>;
    fn get(&self, scope: &SecretScope, name: &SecretName) -> Result<Option<String>>;
    fn delete(&self, scope: &SecretScope, name: &SecretName) -> Result<bool>;
    fn list(&self, scope_filter: Option<&SecretScope>) -> Result<Vec<SecretListEntry>>;
}
```

目前唯一实现为 `LocalSecretsBackend`。trait 设计为后续可扩展远程/云端后端。

### `redact_secrets(input: String) -> String`

从 `sanitizer` 模块导出的脱敏函数，对已知密钥模式进行正则替换。

### `environment_id_from_cwd(cwd: &Path) -> String`

根据工作目录推导环境 ID，用于 per-environment 密钥作用域。

## 类型定义

### `SecretName`

密钥名称的 newtype wrapper，强制格式为 `[A-Z0-9_]+`（如 `GITHUB_TOKEN`、`AWS_SECRET_KEY`）。通过 `SecretName::new()` 构造时校验格式（`src/lib.rs:28-38`）。

### `SecretScope`

```rust
pub enum SecretScope {
    Global,                    // canonical key: "global/{name}"
    Environment(String),       // canonical key: "env/{env_id}/{name}"
}
```

`Global` 作用域下的密钥在所有环境中可见；`Environment` 作用域将密钥限定在特定环境（通常对应一个 git 仓库）。

### `SecretListEntry`

列出密钥时返回的条目，包含 `scope: SecretScope` 和 `name: SecretName`。

### `SecretsBackendKind`

```rust
#[derive(Default)]
pub enum SecretsBackendKind {
    #[default]
    Local,
}
```

支持 serde 序列化（`rename_all = "lowercase"`）和 JSON Schema 生成，可用于配置文件。

## 存储格式与文件结构

密钥存储在 `{codex_home}/secrets/local.age` 文件中。加密前的明文为 JSON：

```json
{
  "version": 1,
  "secrets": {
    "global/GITHUB_TOKEN": "ghp_xxxx...",
    "env/my-repo/DATABASE_URL": "postgres://..."
  }
}
```

- `version` 字段用于前向兼容，当前为 `1`；加载时拒绝大于当前版本的文件
- `secrets` 使用 `BTreeMap` 保证 key 有序，canonical key 格式为 `{scope}/{name}` 或 `{scope}/{env_id}/{name}`

## 配置项与默认值

| 项目 | 默认值 | 说明 |
|------|--------|------|
| `SecretsBackendKind` | `Local` | 后端类型，目前仅支持本地加密文件 |
| Keyring service | `"codex"` | OS keyring 中使用的 service 标识 |
| Keyring account | `secrets\|<sha256_prefix_16>` | 基于 `codex_home` 路径哈希派生 |
| 加密算法 | age scrypt | 使用 age 库的 scrypt 密码加密方案 |
| 口令长度 | 32 字节随机 → Base64 | 约 44 字符的高熵口令 |

## 边界 Case 与注意事项

- **空值校验**：`SecretName::new()` 拒绝空名称和非 `[A-Z0-9_]` 字符；`set()` 拒绝空值
- **原子写入**：`write_file_atomically()` 通过先写临时文件再 rename 的方式避免写入中断导致文件损坏。Windows 上因 rename 语义不同，会先删除目标文件再 rename（`src/local.rs:241-259`）
- **内存擦除**：生成口令后用 volatile write 清零原始随机字节，防止编译器优化掉擦除操作（`src/local.rs:284-291`）
- **Keyring 不可用**：若 OS keyring 不可用（如无桌面环境的 headless 服务器），所有密钥操作将失败并返回明确错误
- **脱敏为尽力策略**：`redact_secrets()` 基于已知模式正则匹配，无法保证捕获所有密钥格式，属于纵深防御的一层
- **版本兼容**：加载时若遇到高于 `SECRETS_VERSION` 的文件版本会直接报错，避免静默丢失数据