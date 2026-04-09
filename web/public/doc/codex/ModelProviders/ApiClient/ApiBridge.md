# ApiBridge

## 概述与职责

ApiBridge 是 codex-api crate 中的协议桥接模块，负责将 API 层的错误类型（`ApiError` / `TransportError`）转换为 agent core 消费的 `CodexErr` 类型。它是 **ModelProviders → ApiClient** 子系统的一部分，位于 HTTP 传输层和 agent 核心之间，确保上游各种 HTTP 错误码和业务错误能被精准映射为 agent core 可识别的语义化错误。

在整体架构中，ModelProviders 负责所有 LLM API 交互。ApiClient 作为其高层抽象，处理请求构造和流式解析；当请求失败时，ApiBridge 将底层的 `ApiError`（包括包装的 `TransportError`）翻译为 `CodexErr`，供 Core agent 做重试决策、用量提示、错误展示等。

此外，模块还提供了 `CoreAuthProvider` 结构体——`AuthProvider` trait 的具体实现，用于向 API 请求注入 Bearer Token 和 Account ID。

## 关键流程

### 错误映射流程 (`map_api_error`)

`map_api_error` 是模块的核心入口函数，接收一个 `ApiError` 并返回对应的 `CodexErr`。映射分为两层：

**第一层：直接映射的 ApiError 变体**（`api_bridge.rs:19-25`）

这些变体有直接的一对一语义映射，无需额外解析：

| ApiError | CodexErr | 说明 |
|----------|----------|------|
| `ContextWindowExceeded` | `ContextWindowExceeded` | 上下文窗口超限 |
| `QuotaExceeded` | `QuotaExceeded` | 配额耗尽 |
| `UsageNotIncluded` | `UsageNotIncluded` | 用量未包含在计划内 |
| `Retryable { message, delay }` | `Stream(message, delay)` | 可重试错误，携带延迟信息 |
| `Stream(msg)` | `Stream(msg, None)` | 流式传输错误 |
| `ServerOverloaded` | `ServerOverloaded` | 服务端过载 |
| `InvalidRequest { message }` | `InvalidRequest(message)` | 请求无效 |
| `RateLimit(msg)` | `Stream(msg, None)` | 速率限制 |
| `Api { status, message }` | `UnexpectedStatus(...)` | 带状态码的通用 API 错误 |

**第二层：TransportError::Http 的深度解析**（`api_bridge.rs:36-108`）

当错误为 `TransportError::Http` 时，函数根据 HTTP 状态码进入不同分支：

1. **503 Service Unavailable**（`api_bridge.rs:45-56`）：解析响应体 JSON，如果 `error.code` 为 `"server_is_overloaded"` 或 `"slow_down"`，映射为 `CodexErr::ServerOverloaded`。

2. **400 Bad Request**（`api_bridge.rs:58-65`）：检查响应体是否包含无效图片的错误消息，是则返回 `InvalidImageRequest`，否则返回 `InvalidRequest`。

3. **500 Internal Server Error**（`api_bridge.rs:66-67`）：直接映射为 `CodexErr::InternalServerError`。

4. **429 Too Many Requests**（`api_bridge.rs:68-94`）：这是最复杂的分支，尝试将响应体反序列化为 `UsageErrorResponse`：
   - 若 `error.type == "usage_limit_reached"`：从响应头提取 `x-codex-active-limit` 标识当前限制，调用 `parse_rate_limit_for_limit()` 解析速率限制快照，调用 `parse_promo_message()` 提取促销消息，从响应体提取 `resets_at` 时间戳，最终封装为 `CodexErr::UsageLimitReached`。
   - 若 `error.type == "usage_not_included"`：映射为 `CodexErr::UsageNotIncluded`。
   - 其他 429 情况：映射为 `CodexErr::RetryLimit`，携带请求追踪 ID。

5. **其他状态码**（`api_bridge.rs:96-107`）：映射为 `CodexErr::UnexpectedStatus`，同时从响应头提取丰富的调试上下文。

**其他 TransportError 变体**（`api_bridge.rs:110-117`）：

| TransportError | CodexErr |
|---------------|----------|
| `RetryLimit` | `RetryLimit(500, None)` |
| `Timeout` | `Timeout` |
| `Network(msg)` / `Build(msg)` | `Stream(msg, None)` |

### 调试上下文提取

模块定义了一组 header 常量和辅助函数，用于从 HTTP 响应头提取调试信息：

- **`extract_request_id`**（`api_bridge.rs:138-141`）：优先从 `x-request-id` 提取，回退到 `x-oai-request-id`。
- **`extract_request_tracking_id`**（`api_bridge.rs:134-136`）：先尝试 `extract_request_id`，再回退到 `cf-ray`（Cloudflare Ray ID）。
- **`extract_x_error_json_code`**（`api_bridge.rs:151-162`）：从 `x-error-json` header 中 Base64 解码 JSON，提取 `error.code` 字段。这用于识别如 `token_expired` 等身份验证错误的细分类型。
- **`extract_header`**（`api_bridge.rs:143-149`）：通用的 header 值提取辅助函数。

涉及的 header 常量（`api_bridge.rs:123-128`）：

| 常量 | Header 名 | 用途 |
|------|-----------|------|
| `ACTIVE_LIMIT_HEADER` | `x-codex-active-limit` | 标识当前生效的速率限制 |
| `REQUEST_ID_HEADER` | `x-request-id` | 请求追踪 ID |
| `OAI_REQUEST_ID_HEADER` | `x-oai-request-id` | OpenAI 请求 ID（备选） |
| `CF_RAY_HEADER` | `cf-ray` | Cloudflare Ray ID |
| `X_OPENAI_AUTHORIZATION_ERROR_HEADER` | `x-openai-authorization-error` | 认证错误详情 |
| `X_ERROR_JSON_HEADER` | `x-error-json` | Base64 编码的错误 JSON |

## 函数签名与参数说明

### `pub fn map_api_error(err: ApiError) -> CodexErr`

模块的核心公开函数，执行 `ApiError` → `CodexErr` 的完整映射。

- **err**：来自 codex-api 的错误枚举，涵盖所有可能的 API 和传输层错误
- **返回值**：agent core 消费的 `CodexErr` 枚举

> 源码位置：`codex-rs/codex-api/src/api_bridge.rs:18-121`

## 接口/类型定义

### `CoreAuthProvider`

```rust
#[derive(Clone, Default)]
pub struct CoreAuthProvider {
    pub token: Option<String>,
    pub account_id: Option<String>,
}
```

agent core 使用的 `AuthProvider` trait 具体实现，携带 Bearer Token 和 ChatGPT Account ID（`api_bridge.rs:177-210`）。

**方法：**

| 方法 | 签名 | 说明 |
|------|------|------|
| `auth_header_attached` | `&self -> bool` | 检查 token 是否存在且能构成合法的 HTTP header 值 |
| `auth_header_name` | `&self -> Option<&'static str>` | token 有效时返回 `Some("authorization")`，否则 `None` |
| `for_test` | `(token: Option<&str>, account_id: Option<&str>) -> Self` | 测试辅助构造器 |
| `bearer_token` | `&self -> Option<String>` | `AuthProvider` trait 实现，返回 token 克隆 |
| `account_id` | `&self -> Option<String>` | `AuthProvider` trait 实现，返回 account_id 克隆 |

### `UsageErrorResponse` / `UsageErrorBody`（内部类型）

用于反序列化 429 响应体的内部结构体（`api_bridge.rs:164-175`）：

```rust
struct UsageErrorResponse {
    error: UsageErrorBody,
}

struct UsageErrorBody {
    error_type: Option<String>,   // JSON 字段名为 "type"
    plan_type: Option<PlanType>,  // 用户订阅计划类型
    resets_at: Option<i64>,       // Unix 时间戳，限制重置时间
}
```

## 边界 Case 与注意事项

- **503 body 解析失败时不会映射为 ServerOverloaded**：只有当响应体能成功解析为 JSON 且 `error.code` 为特定值时才触发，否则会走到 `UnexpectedStatus` 分支。
- **429 的多层判断**：不是所有 429 都映射为 `UsageLimitReached`——只有 `error.type == "usage_limit_reached"` 的才是；`usage_not_included` 映射为 `UsageNotIncluded`；其他 429 映射为 `RetryLimit`。
- **x-error-json 的 Base64 解码**：该 header 是 Base64 编码的 JSON 字符串。解码或解析失败时静默返回 `None`，不会导致错误。
- **请求 ID 的优先级**：`x-request-id` 优先于 `x-oai-request-id`，两者都不存在时才回退到 `cf-ray`（仅在 `extract_request_tracking_id` 中）。
- **CoreAuthProvider 的 header 校验**：`auth_header_attached()` 不仅检查 token 是否存在，还验证 `Bearer {token}` 能否构成合法的 `HeaderValue`（即不含非法字符）。