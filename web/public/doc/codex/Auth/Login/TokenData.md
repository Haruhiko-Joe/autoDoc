# TokenData — JWT 令牌解析与身份数据结构

## 概述与职责

`TokenData` 模块是 **Auth → Login** 子系统中负责 JWT 令牌解析和身份信息提取的核心组件。它定义了认证令牌的数据结构（`TokenData`、`IdTokenInfo`），并实现了不验证签名的 base64url JWT payload 解码逻辑，从 OpenAI 自定义 JWT 命名空间中提取用户身份和订阅信息。

在整体架构中，Auth 模块为 Core、TUI、AppServer、ModelProviders 等上层组件提供认证凭据。`TokenData` 作为 Login crate 的一部分，其导出的结构体被 ChatGPTClient 等兄弟模块消费，用于完成 ChatGPT 后端的 API 认证。

## 关键数据结构

### `TokenData`

顶层令牌容器，持有一次认证流程产生的全部令牌信息：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id_token` | `IdTokenInfo` | 从 ID Token JWT 中解析出的用户身份信息（序列化时还原为原始 JWT 字符串） |
| `access_token` | `String` | 用于 API 请求的 JWT 访问令牌 |
| `refresh_token` | `String` | 用于刷新 access_token 的刷新令牌 |
| `account_id` | `Option<String>` | 可选的账户 ID |

> 源码位置：`codex-rs/login/src/token_data.rs:10-25`

`id_token` 字段使用自定义的 serde 序列化/反序列化逻辑——**反序列化时**，从原始 JWT 字符串自动解析为 `IdTokenInfo` 结构体；**序列化时**，从 `IdTokenInfo.raw_jwt` 还原为 JWT 字符串。这使得 `TokenData` 可以直接与 `auth.json` 文件互操作。

### `IdTokenInfo`

从 ID Token 的 JWT payload 中提取的用户身份平面结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `email` | `Option<String>` | 用户邮箱 |
| `chatgpt_plan_type` | `Option<PlanType>` | ChatGPT 订阅计划类型（free、plus、pro、business、enterprise、edu 等） |
| `chatgpt_user_id` | `Option<String>` | ChatGPT 用户标识 |
| `chatgpt_account_id` | `Option<String>` | 组织/工作空间标识 |
| `raw_jwt` | `String` | 原始 JWT 字符串，序列化时使用 |

> 源码位置：`codex-rs/login/src/token_data.rs:28-40`

#### `IdTokenInfo` 方法

- **`get_chatgpt_plan_type()`** — 返回人类可读的计划名称（如 `PlanType::Known` 调用 `display_name()`，`PlanType::Unknown` 直接返回原始字符串）
- **`get_chatgpt_plan_type_raw()`** — 返回原始计划标识值（`PlanType::Known` 调用 `raw_value()`）
- **`is_workspace_account()`** — 判断当前账户是否为工作空间类型（business、enterprise 等）

> 源码位置：`codex-rs/login/src/token_data.rs:42-63`

## 关键流程

### JWT Payload 解码流程

核心解码函数 `decode_jwt_payload<T>()` 实现了不验证签名的 JWT payload 提取：

1. 按 `.` 分割 JWT 字符串为 `header`、`payload`、`signature` 三部分
2. 校验三部分均非空，否则返回 `InvalidFormat` 错误
3. 使用 `base64::URL_SAFE_NO_PAD` 引擎解码 payload 部分
4. 通过 `serde_json::from_slice` 反序列化为泛型类型 `T`

> 源码位置：`codex-rs/login/src/token_data.rs:109-120`

这是一个内部泛型函数，被两个公开函数复用：

### ChatGPT JWT Claims 解析（`parse_chatgpt_jwt_claims`）

从 ID Token 中提取 OpenAI 特定的用户身份信息：

1. 调用 `decode_jwt_payload::<IdClaims>()` 解码 JWT payload
2. **email 提取**：优先使用顶层 `email` 字段，回退到 `https://api.openai.com/profile` 命名空间下的 `email`
3. **auth 信息提取**：从 `https://api.openai.com/auth` 命名空间读取 `chatgpt_plan_type`、`chatgpt_user_id`（回退到 `user_id`）、`chatgpt_account_id`
4. 若 `auth` 命名空间不存在，身份字段均为 `None`，仅保留 email

> 源码位置：`codex-rs/login/src/token_data.rs:129-151`

### Token 过期时间解析（`parse_jwt_expiration`）

从任意 JWT 中提取标准 `exp` claim 并转换为 `DateTime<Utc>`：

1. 调用 `decode_jwt_payload::<StandardJwtClaims>()` 解码
2. 从 `exp` 字段（Unix 时间戳）构造 `DateTime<Utc>`
3. 返回 `Option` — 若 JWT 中无 `exp` claim 或时间戳无效，返回 `None`

> 源码位置：`codex-rs/login/src/token_data.rs:122-127`

## JWT Claims 内部结构

JWT payload 中的 OpenAI 自定义命名空间映射关系：

```text
{
  "email": "...",                           // 顶层 email
  "https://api.openai.com/profile": {       // ProfileClaims
    "email": "..."                          // 备用 email 来源
  },
  "https://api.openai.com/auth": {          // AuthClaims
    "chatgpt_plan_type": "...",
    "chatgpt_user_id": "...",
    "user_id": "...",                       // chatgpt_user_id 的回退
    "chatgpt_account_id": "..."
  }
}
```

> 内部结构定义：`codex-rs/login/src/token_data.rs:65-97`

## 错误类型

`IdTokenInfoError` 枚举覆盖三种失败场景：

| 变体 | 说明 |
|------|------|
| `InvalidFormat` | JWT 不符合 `header.payload.signature` 三段式格式 |
| `Base64(DecodeError)` | payload 的 base64url 解码失败 |
| `Json(serde_json::Error)` | payload JSON 反序列化失败 |

## 边界 Case 与注意事项

- **不验证签名**：`decode_jwt_payload` 仅解码 payload，不校验 JWT 签名。这是有意为之——签名验证由服务端负责，客户端只需提取 claims。
- **email 回退逻辑**：email 有两个来源，顶层 `email` 优先于 `profile.email`，确保兼容不同的 JWT 签发方式。
- **user_id 回退**：`chatgpt_user_id` 为空时回退到 `user_id` 字段（`codex-rs/login/src/token_data.rs:140`），兼容不同版本的 JWT 格式。
- **自定义序列化**：`TokenData.id_token` 在 JSON 中存储为原始 JWT 字符串，反序列化时自动解析为结构体。这意味着如果 JWT 格式不合法，**反序列化 `TokenData` 本身会失败**。
- **所有 claims 字段均为 Optional**：即使 `auth` 命名空间存在，其中每个字段也可能缺失，模块对此做了完整的容错处理。