# CloudRequirements — 云端配置需求加载器

## 概述与职责

`codex-cloud-requirements` 是 Codex 系统中为 **Business（Enterprise CBP）和 Enterprise ChatGPT 客户**提供云端托管配置需求加载的 crate。它从后端 API 获取 `requirements.toml` 配置数据，替代从本地文件系统加载的方式。

该模块在系统架构中属于 **CloudTasks** 分组，与 Auth（认证管理）和 Config（配置系统）协同工作。同级模块包括 Core、TUI、CLI 等核心组件。

**核心设计原则：Fail Closed（关闭式失败）**——当符合条件的 Business/Enterprise 账户无法加载云端配置时，Codex 会**中止配置加载**而非跳过，确保企业级安全策略始终生效。

> 源码位置：`codex-rs/cloud-requirements/src/lib.rs`

## 关键流程

### 1. 启动加载流程

入口函数 `cloud_requirements_loader()` 创建 `CloudRequirementsService` 并同时启动两个异步任务（`codex-rs/cloud-requirements/src/lib.rs:689-721`）：

1. **主加载任务**：调用 `fetch_with_timeout()` 获取配置，带 15 秒超时保护
2. **后台刷新任务**：调用 `refresh_cache_in_background()` 每 5 分钟刷新缓存

后台刷新任务通过全局 `OnceLock<Mutex<Option<JoinHandle<()>>>>` 管理，确保同一时刻只有一个刷新任务运行。如果已存在旧任务，会先 abort 再替换（`codex-rs/cloud-requirements/src/lib.rs:62-65`）。

返回的 `CloudRequirementsLoader` 是一个 future wrapper，消费者 await 它即可获得加载结果。

### 2. 资格检查

在 `fetch()` 方法中，加载前会进行三重资格检查（`codex-rs/cloud-requirements/src/lib.rs:327-337`）：

1. 是否存在有效的认证信息（`auth_manager.auth()`）
2. 账户是否有 plan 类型信息
3. 是否为 ChatGPT 认证 **且** plan 为 Business-like 或 Enterprise

不满足任一条件则返回 `Ok(None)`，不报错——这意味着非企业用户会静默跳过云端配置。

### 3. 缓存优先策略

通过资格检查后，系统先尝试加载本地缓存（`codex-rs/cloud-requirements/src/lib.rs:340-356`）：

- 缓存命中且有效 → 直接使用缓存内容，跳过网络请求
- 缓存未命中或无效 → 回退到带重试的网络请求

### 4. 带重试的网络获取

`fetch_with_retries()` 实现了复杂的重试逻辑（`codex-rs/cloud-requirements/src/lib.rs:359-528`）：

```
最多 5 次尝试 (CLOUD_REQUIREMENTS_MAX_ATTEMPTS)
├── 成功 → 解析 TOML，写入缓存，返回结果
├── 可重试失败 (Retryable) → 指数退避后重试
│   ├── BackendClientInit（客户端构造失败）
│   └── Request（请求失败，非 401）
└── 未授权 (Unauthorized) → 尝试认证恢复
    ├── 恢复成功 → 刷新 auth 后继续重试
    ├── Permanent 失败 → 立即返回 Auth 错误
    └── Transient 失败 → 指数退避后重试
```

重试间隔使用 `codex_core::util::backoff()` 计算指数退避时间。

### 5. 后台缓存刷新

`refresh_cache_in_background()` 以 5 分钟间隔循环运行（`codex-rs/cloud-requirements/src/lib.rs:530-544`）：

- 每次刷新同样经过资格检查
- 刷新失败不影响已有缓存，仅记录日志
- 如果资格检查不再满足（如用户退出登录），循环终止

## 函数签名

### `cloud_requirements_loader(auth_manager, chatgpt_base_url, codex_home) -> CloudRequirementsLoader`

主入口函数。创建加载服务并启动后台任务。

| 参数 | 类型 | 说明 |
|------|------|------|
| `auth_manager` | `Arc<AuthManager>` | 共享的认证管理器 |
| `chatgpt_base_url` | `String` | ChatGPT 后端 API 基础 URL |
| `codex_home` | `PathBuf` | Codex 主目录，缓存文件存放于此 |

> 源码位置：`codex-rs/cloud-requirements/src/lib.rs:689-721`

### `cloud_requirements_loader_for_storage(codex_home, enable_codex_api_key_env, credentials_store_mode, chatgpt_base_url) -> CloudRequirementsLoader`

便捷入口，内部创建 `AuthManager` 后委托给 `cloud_requirements_loader()`。适用于调用方尚未持有 `AuthManager` 实例的场景。

> 源码位置：`codex-rs/cloud-requirements/src/lib.rs:723-735`

## 接口/类型定义

### `RequirementsFetcher` trait

```rust
#[async_trait]
trait RequirementsFetcher: Send + Sync {
    async fn fetch_requirements(
        &self,
        auth: &CodexAuth,
    ) -> Result<Option<String>, FetchAttemptError>;
}
```

抽象的需求获取接口，返回 `Ok(None)` 表示账户无云端配置，返回 `Err` 表示获取失败。`BackendRequirementsFetcher` 是其生产实现，通过 `BackendClient::get_config_requirements_file()` 发起实际请求（`codex-rs/cloud-requirements/src/lib.rs:184-244`）。

### `CloudRequirementsCacheFile`

缓存文件的顶层结构（`codex-rs/cloud-requirements/src/lib.rs:118-121`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `signed_payload` | `CloudRequirementsCacheSignedPayload` | HMAC 签名保护的有效负载 |
| `signature` | `String` | Base64 编码的 HMAC-SHA256 签名 |

### `CloudRequirementsCacheSignedPayload`

签名有效负载（`codex-rs/cloud-requirements/src/lib.rs:124-130`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `cached_at` | `DateTime<Utc>` | 缓存创建时间 |
| `expires_at` | `DateTime<Utc>` | 缓存过期时间（TTL 30 分钟） |
| `chatgpt_user_id` | `Option<String>` | 缓存所属用户 ID |
| `account_id` | `Option<String>` | 缓存所属账户 ID |
| `contents` | `Option<String>` | 原始 `requirements.toml` 文本内容 |

### `FetchAttemptError`

网络请求错误的分类（`codex-rs/cloud-requirements/src/lib.rs:83-89`）：

- `Retryable(RetryableFailureKind)` — 可重试的瞬态错误
- `Unauthorized { status_code, message }` — 认证失败，需要认证恢复

### `CacheLoadStatus`

缓存加载失败的细分原因枚举（`codex-rs/cloud-requirements/src/lib.rs:92-109`），包括：`AuthIdentityIncomplete`、`CacheFileNotFound`、`CacheReadFailed`、`CacheParseFailed`、`CacheSignatureInvalid`、`CacheIdentityIncomplete`、`CacheIdentityMismatch`、`CacheExpired`。

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|-----|------|
| `CLOUD_REQUIREMENTS_TIMEOUT` | 15 秒 | 单次加载操作的总超时时间 |
| `CLOUD_REQUIREMENTS_MAX_ATTEMPTS` | 5 | 最大重试次数 |
| `CLOUD_REQUIREMENTS_CACHE_REFRESH_INTERVAL` | 5 分钟 | 后台缓存刷新间隔 |
| `CLOUD_REQUIREMENTS_CACHE_TTL` | 30 分钟 | 缓存有效期 |
| `CLOUD_REQUIREMENTS_CACHE_FILENAME` | `cloud-requirements-cache.json` | 缓存文件名，存放于 `codex_home` 目录下 |

## 缓存安全机制

### HMAC-SHA256 签名

缓存文件使用 HMAC-SHA256 签名保护完整性（`codex-rs/cloud-requirements/src/lib.rs:139-168`）：

1. **写入时**：将 `signed_payload` 序列化为 JSON 字节，使用固定密钥计算 HMAC-SHA256，Base64 编码后存入 `signature` 字段
2. **读取时**：重新序列化 payload，遍历 `CLOUD_REQUIREMENTS_CACHE_READ_HMAC_KEYS`（支持密钥轮换）逐一验证签名

当前写入密钥为 `CLOUD_REQUIREMENTS_CACHE_WRITE_HMAC_KEY`（包含版本号 `v3` 和唯一 UUID），读取密钥列表 `CLOUD_REQUIREMENTS_CACHE_READ_HMAC_KEYS` 仅包含当前写入密钥，但其数组设计支持未来密钥轮换时同时接受新旧密钥。

### 身份绑定

缓存在加载时会验证 `chatgpt_user_id` 和 `account_id` 与当前认证身份一致（`codex-rs/cloud-requirements/src/lib.rs:610-618`），防止用户切换账户后使用错误的缓存配置。

## 可观测性

模块通过 `codex_otel` 发射以下指标：

| 指标名 | 标签 | 说明 |
|--------|------|------|
| `codex.cloud_requirements.fetch_attempt` | trigger, attempt, outcome, status_code | 每次获取尝试 |
| `codex.cloud_requirements.fetch_final` | trigger, outcome, reason, attempt_count, status_code | 最终获取结果 |
| `codex.cloud_requirements.load` | trigger, outcome | 整体加载结果（startup/refresh） |
| `codex.cloud_requirements.fetch.duration_ms` | — | 获取耗时（计时器） |

`trigger` 标签区分 `"startup"`（启动时加载）和 `"refresh"`（后台刷新）。

## 边界 Case 与注意事项

- **非企业用户静默跳过**：API Key 认证或非 Business/Enterprise plan 的用户直接返回 `Ok(None)`，不触发任何错误
- **空内容处理**：后端返回空字符串或空白内容时，`parse_cloud_requirements()` 返回 `None`；`is_empty()` 的 TOML 同样返回 `None`（`codex-rs/cloud-requirements/src/lib.rs:737-750`）
- **认证恢复**：遇到 401 时会通过 `auth_manager.unauthorized_recovery()` 尝试刷新 token，`Permanent` 类型的刷新失败立即终止
- **缓存文件不存在不告警**：`CacheFileNotFound` 状态不输出日志，属于正常首次使用场景（`codex-rs/cloud-requirements/src/lib.rs:629`）
- **刷新任务单例**：全局只允许一个后台刷新任务，新建 loader 时旧任务会被 abort