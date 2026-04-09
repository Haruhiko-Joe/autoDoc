# AuthEnvTelemetry — 认证环境遥测采集

## 概述与职责

`AuthEnvTelemetry` 模块位于 **Auth → Login** 层级内，是 `codex-login` crate 的一部分。它负责**快照式检测当前进程的认证相关环境变量**，并将检测结果结构化为可供 OpenTelemetry 消费的遥测元数据。

在整体架构中，Auth 子系统为 Core、ModelProviders、AppServer 等多个顶层模块提供凭据。而本模块不参与实际认证流程，只是在会话启动时"拍一张照"——记录哪些环境变量存在、哪些未设置，供 Observability 子系统（OpenTelemetry）追踪，帮助团队排查认证配置相关的问题。

同级模块还有 ChatGPTClient（ChatGPT 后端客户端）、KeyringStore（OS 钥匙串抽象）和 Secrets（加密密钥管理）。

> 源文件：`codex-rs/login/src/auth_env_telemetry.rs`

## 关键流程

### 采集流程 Walkthrough

1. **调用入口**：Core 层（`codex.rs`、`client.rs`）和 ModelsManager 在会话初始化时调用 `collect_auth_env_telemetry(provider, codex_api_key_env_enabled)`
2. **逐项检测环境变量**：
   - 通过内部辅助函数 `env_var_present()` 检查 `OPENAI_API_KEY`（常量 `OPENAI_API_KEY_ENV_VAR`）是否存在且非空
   - 同样检查 `CODEX_API_KEY`（常量 `CODEX_API_KEY_ENV_VAR`）
   - 将调用方传入的 `codex_api_key_env_enabled` 标志直接记录（表示该 key 是否被启用，由上层 `AuthManager` 决定）
   - 如果当前 `ModelProviderInfo` 配置了 `env_key`（供应商专属密钥的环境变量名），记录其**是否配置**（`provider_env_key_name` 统一输出 `"configured"` 而非真实变量名，防止泄漏）和**是否存在**（`provider_env_key_present`）
   - 检查 `CODEX_REFRESH_TOKEN_URL_OVERRIDE`（常量 `REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR`）是否存在
3. **返回 `AuthEnvTelemetry` 结构体**：各字段为布尔值或 `Option`，描述各环境变量的存在状态
4. **转换为 OTel 元数据**：调用方通过 `to_otel_metadata()` 将其转换为 `codex_otel::AuthEnvTelemetryMetadata`，嵌入到 `SessionTelemetry` 中上报

### 隐私保护设计

`provider_env_key_name` 字段值始终为 `Some("configured")` 或 `None`，**绝不暴露实际的环境变量名**。这是有意为之的安全设计——防止供应商专属的 API key 变量名通过遥测链路泄漏（`auth_env_telemetry.rs:39`）。

## 函数签名与参数说明

### `collect_auth_env_telemetry(provider, codex_api_key_env_enabled) -> AuthEnvTelemetry`

主采集函数，读取当前进程环境变量并构建遥测快照。

| 参数 | 类型 | 说明 |
|------|------|------|
| `provider` | `&ModelProviderInfo` | 当前模型供应商配置，包含可选的 `env_key` 字段 |
| `codex_api_key_env_enabled` | `bool` | `CODEX_API_KEY` 是否在当前上下文中被启用（由 `AuthManager` 决定） |

**返回值**：`AuthEnvTelemetry` 结构体

> 源码位置：`codex-rs/login/src/auth_env_telemetry.rs:31-43`

### `AuthEnvTelemetry::to_otel_metadata(&self) -> AuthEnvTelemetryMetadata`

将采集结果转换为 `codex_otel` crate 定义的 `AuthEnvTelemetryMetadata`，字段一一映射。

> 源码位置：`codex-rs/login/src/auth_env_telemetry.rs:19-28`

### `env_var_present(name: &str) -> bool`（内部函数）

判断环境变量是否"有效存在"：

- 变量存在且 `trim()` 后非空 → `true`
- 变量存在但值为非 Unicode → `true`（仍视为存在）
- 变量不存在 → `false`

> 源码位置：`codex-rs/login/src/auth_env_telemetry.rs:45-51`

## 接口/类型定义

### `AuthEnvTelemetry` 结构体

```rust
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuthEnvTelemetry {
    pub openai_api_key_env_present: bool,
    pub codex_api_key_env_present: bool,
    pub codex_api_key_env_enabled: bool,
    pub provider_env_key_name: Option<String>,
    pub provider_env_key_present: Option<bool>,
    pub refresh_token_url_override_present: bool,
}
```

> 源码位置：`codex-rs/login/src/auth_env_telemetry.rs:8-16`

| 字段 | 类型 | 说明 |
|------|------|------|
| `openai_api_key_env_present` | `bool` | `OPENAI_API_KEY` 环境变量是否设置且非空 |
| `codex_api_key_env_present` | `bool` | `CODEX_API_KEY` 环境变量是否设置且非空 |
| `codex_api_key_env_enabled` | `bool` | `CODEX_API_KEY` 是否被当前 `AuthManager` 启用 |
| `provider_env_key_name` | `Option<String>` | 供应商专属 key 是否已配置（值为 `"configured"` 或 `None`，不暴露真实名称） |
| `provider_env_key_present` | `Option<bool>` | 供应商专属环境变量是否存在（仅当 `env_key` 已配置时有值） |
| `refresh_token_url_override_present` | `bool` | `CODEX_REFRESH_TOKEN_URL_OVERRIDE` 是否设置 |

该结构体实现了 `Default`，所有布尔字段默认为 `false`，`Option` 字段默认为 `None`。

## 检测的环境变量

| 环境变量 | 常量名 | 定义位置 |
|----------|--------|----------|
| `OPENAI_API_KEY` | `OPENAI_API_KEY_ENV_VAR` | `codex-rs/login/src/auth/manager.rs:403` |
| `CODEX_API_KEY` | `CODEX_API_KEY_ENV_VAR` | `codex-rs/login/src/auth/manager.rs:404` |
| `CODEX_REFRESH_TOKEN_URL_OVERRIDE` | `REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR` | `codex-rs/login/src/auth/manager.rs:86` |
| *供应商专属 key*（动态） | `ModelProviderInfo.env_key` | 由供应商配置决定 |

## 调用方与数据流向

本模块通过 `codex-login` crate 的 `lib.rs` 对外导出 `AuthEnvTelemetry` 和 `collect_auth_env_telemetry`（`codex-rs/login/src/lib.rs:45-46`）。主要消费方包括：

- **`codex-rs/core/src/codex.rs`**：会话启动时采集，注入到 `SessionTelemetry`
- **`codex-rs/core/src/client.rs`**：API 客户端创建时采集，传递给请求级遥测
- **`codex-rs/models-manager/src/manager.rs`**：模型管理器认证阶段采集
- **`codex-rs/feedback/src/lib.rs`**：反馈上报时附带认证环境信息

遥测数据最终通过 `to_otel_metadata()` 转换为 `AuthEnvTelemetryMetadata`（定义于 `codex-rs/otel/src/events/session_telemetry.rs:67-74`），嵌入 `SessionTelemetryMetadata.auth_env` 字段上报。

## 边界 Case 与注意事项

- **空白值处理**：环境变量设置为空字符串或纯空白时，`env_var_present` 返回 `false`——即视为"未设置"
- **非 Unicode 值**：环境变量值为非法 Unicode 时（`VarError::NotUnicode`），仍视为存在。这避免了因编码问题误判为"未配置"
- **`codex_api_key_env_enabled` 与 `codex_api_key_env_present` 的区别**：`present` 只表示环境变量存在，`enabled` 表示该 key 在当前认证上下文中实际被使用。两者可能不一致（例如变量存在但被配置禁用）
- **供应商 key 名称脱敏**：`provider_env_key_name` 永远不会泄漏真实的环境变量名，测试用例 `collect_auth_env_telemetry_buckets_provider_env_key_name`（`auth_env_telemetry.rs:60-87`）专门验证了这一点——即使传入 `"sk-should-not-leak"`，输出也只是 `"configured"`