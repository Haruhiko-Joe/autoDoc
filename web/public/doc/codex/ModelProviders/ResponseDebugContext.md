# ResponseDebugContext — 错误上下文提取工具

## 概述与职责

`codex-response-debug-context` 是一个轻量级工具 crate，属于 **ModelProviders** 层的基础设施。它从 API 错误响应的 HTTP 头中提取调试信息（请求 ID、Cloudflare Ray ID、认证错误详情），并将各类 API 错误转换为**遥测安全**的错误消息——即不泄露 HTTP body 中可能包含的敏感信息（如 token、密钥）。

该 crate 被 `codex-rs/core`（核心代理客户端）和 `codex-rs/models-manager`（模型管理器）直接使用，在每次 API 请求失败时提取调试上下文并记录到遥测系统中。

整个 crate 仅包含一个源文件 `src/lib.rs`，无异步依赖，实现简洁。

## 关键流程

### 调试上下文提取流程

1. 调用方在 API 请求失败时，将 `TransportError` 或 `ApiError` 传入提取函数
2. 函数检查错误是否为 `TransportError::Http` 变体（只有 HTTP 错误才携带响应头）
3. 依次从 HTTP 响应头中提取以下信息：
   - **Request ID**：优先读取 `x-request-id`，回退到 `x-oai-request-id`（`src/lib.rs:37-38`）
   - **Cloudflare Ray ID**：读取 `cf-ray` 头（`src/lib.rs:39`）
   - **认证错误描述**：读取 `x-openai-authorization-error` 头（`src/lib.rs:40`）
   - **认证错误码**：读取 `x-error-json` 头，进行 Base64 解码后解析 JSON，提取 `error.code` 字段（`src/lib.rs:41-51`）
4. 返回填充好的 `ResponseDebugContext` 结构体

### 遥测消息生成流程

遥测函数将错误映射为固定格式的字符串，**故意省略 HTTP body 和 URL 等可能包含敏感数据的字段**：

- `TransportError::Http` → `"http {status_code}"`（如 `"http 401"`）
- `TransportError::RetryLimit` → `"retry limit reached"`
- `TransportError::Timeout` → `"timeout"`
- `ApiError::ContextWindowExceeded` → `"context window exceeded"`
- 其他变体各有对应的安全描述

## 函数签名与参数说明

### `extract_response_debug_context(transport: &TransportError) -> ResponseDebugContext`

从 `TransportError` 中提取调试上下文。对于非 `Http` 变体，返回所有字段为 `None` 的默认值。

> 源码位置：`src/lib.rs:19-54`

### `extract_response_debug_context_from_api_error(error: &ApiError) -> ResponseDebugContext`

对 `ApiError` 的包装——如果内部是 `ApiError::Transport`，委托给上述函数；否则返回默认值。

> 源码位置：`src/lib.rs:56-61`

### `telemetry_transport_error_message(error: &TransportError) -> String`

将 `TransportError` 转换为遥测安全的错误描述字符串。HTTP 错误只保留状态码，不暴露 body 或 URL。

> 源码位置：`src/lib.rs:63-71`

### `telemetry_api_error_message(error: &ApiError) -> String`

将 `ApiError` 转换为遥测安全的错误描述字符串。覆盖所有 `ApiError` 变体，每个变体映射到一个固定的、不含敏感信息的字符串。

> 源码位置：`src/lib.rs:73-86`

## 接口/类型定义

### `ResponseDebugContext`

```rust
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ResponseDebugContext {
    pub request_id: Option<String>,     // x-request-id 或 x-oai-request-id
    pub cf_ray: Option<String>,         // Cloudflare cf-ray 头
    pub auth_error: Option<String>,     // x-openai-authorization-error 头的原始值
    pub auth_error_code: Option<String>, // x-error-json Base64 解码后的 error.code
}
```

| 字段 | 来源 | 说明 |
|------|------|------|
| `request_id` | `x-request-id` / `x-oai-request-id` | API 请求的唯一标识，用于与后端日志关联排查 |
| `cf_ray` | `cf-ray` | Cloudflare CDN 的请求追踪 ID |
| `auth_error` | `x-openai-authorization-error` | 认证失败的人可读描述（如 `"missing_authorization_header"`） |
| `auth_error_code` | `x-error-json`（Base64 编码的 JSON） | 结构化的错误码（如 `"token_expired"`），从 JSON 的 `error.code` 路径提取 |

## 边界 Case 与注意事项

- **非 HTTP 错误返回空上下文**：`TransportError::Timeout`、`RetryLimit`、`Network`、`Build` 等变体不携带响应头，提取结果全部为 `None`。
- **Request ID 回退逻辑**：优先使用 `x-request-id`，仅在该头缺失时才回退到 `x-oai-request-id`。两个头都存在时，只取前者。
- **`x-error-json` 解码链**：Base64 解码 → JSON 反序列化 → 提取 `error.code`。这条链上任何一步失败（非法 Base64、非法 JSON、缺少字段），`auth_error_code` 都会静默返回 `None`，不会 panic 或报错。
- **遥测安全设计**：`telemetry_transport_error_message` 对 HTTP 错误**只输出状态码**，故意丢弃 body 和 URL，防止 token、密钥等敏感信息泄漏到遥测管道中。而 `Network` 和 `Build` 变体直接透传错误消息，因为它们不包含服务端响应内容。
- **headers 可能为 `None`**：`TransportError::Http` 的 `headers` 字段是 `Option<HeaderMap>`，当为 `None` 时所有头部提取都返回 `None`。