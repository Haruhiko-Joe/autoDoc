# JsonRpcBase — 基础 JSON-RPC 消息类型

## 概述与职责

`jsonrpc_lite.rs` 是 `codex-app-server-protocol` crate 中的基础线协议（wire protocol）定义模块，定义了所有在客户端与 AppServer 之间传输的 JSON-RPC 消息类型。它是整个 Protocol 层的地基——上层的 v1/v2 请求枚举、Transport 的序列化/反序列化、ClientLib 的类型化调度都建立在这些类型之上。

**在架构中的位置**：该模块属于 **AppServer → Protocol** 子系统。Protocol 是 AppServer 的共享协议定义 crate，而 JsonRpcBase 则是 Protocol 内最底层的类型定义，被 Transport、RequestProcessing、ServerAPIs、ClientLib、DevTools 等所有兄弟模块依赖。

**关键设计决策**：本模块实现的是 **JSON-RPC 2.0 的简化变体**——故意省略了标准协议中的 `"jsonrpc": "2.0"` 版本字段（见文件顶部注释，`jsonrpc_lite.rs:1-2`）。虽然保留了 `JSONRPC_VERSION` 常量（值为 `"2.0"`），但序列化时不会在消息中包含此字段。这简化了线上的 JSON 体积，同时保持了语义兼容。

## 核心类型一览

模块导出以下类型，构成完整的 JSON-RPC 消息体系：

| 类型 | 角色 | 是否携带 `id` |
|------|------|---------------|
| `JSONRPCMessage` | 顶层消息枚举，覆盖所有消息形式 | — |
| `JSONRPCRequest` | 期望响应的请求 | 是 |
| `JSONRPCNotification` | 不期望响应的通知 | 否 |
| `JSONRPCResponse` | 成功响应 | 是 |
| `JSONRPCError` | 错误响应 | 是 |
| `RequestId` | 请求标识符（字符串或整数） | — |
| `Result`（type alias） | `serde_json::Value` 的别名 | — |

## 关键流程

### 消息的反序列化（Untagged Enum 匹配）

`JSONRPCMessage` 使用 `#[serde(untagged)]` 属性（`jsonrpc_lite.rs:36`），这意味着 serde 在反序列化时会**按变体声明顺序**依次尝试匹配：

1. **Request**：JSON 对象同时包含 `id` 和 `method` 字段 → 匹配为 `JSONRPCRequest`
2. **Notification**：JSON 对象包含 `method` 但**没有** `id` → 匹配为 `JSONRPCNotification`
3. **Response**：JSON 对象包含 `id` 和 `result` → 匹配为 `JSONRPCResponse`
4. **Error**：JSON 对象包含 `id` 和 `error` → 匹配为 `JSONRPCError`

> **注意**：变体顺序很重要。`Request` 必须在 `Notification` 之前，否则带 `id` 的请求可能被错误地匹配为通知（因为两者都有 `method` 字段）。

### RequestId 的多态表示

`RequestId`（`jsonrpc_lite.rs:13-21`）同样使用 `#[serde(untagged)]`，支持两种 JSON 值：

- **字符串**：`"abc-123"` → `RequestId::String("abc-123".into())`
- **整数**：`42` → `RequestId::Integer(42)`

这与 JSON-RPC 2.0 规范对 `id` 字段的定义一致（允许 string 或 number）。`RequestId` 实现了 `Display` trait 以便日志输出，并实现了 `Hash`、`Eq`、`Ord` 以支持用作 HashMap 的键。

## 类型定义详解

### `JSONRPCRequest`

```rust
// jsonrpc_lite.rs:46-56
pub struct JSONRPCRequest {
    pub id: RequestId,
    pub method: String,
    pub params: Option<serde_json::Value>,
    pub trace: Option<W3cTraceContext>,
}
```

表示一个期望对端返回响应的请求。字段说明：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `RequestId` | 是 | 请求标识符，响应时原样返回 |
| `method` | `String` | 是 | RPC 方法名 |
| `params` | `Option<serde_json::Value>` | 否 | 方法参数，缺省时序列化中省略 |
| `trace` | `Option<W3cTraceContext>` | 否 | W3C 分布式追踪上下文，用于 OpenTelemetry 链路追踪 |

`trace` 字段是本模块对标准 JSON-RPC 的一个扩展，来自 `codex_protocol::protocol::W3cTraceContext`，使得请求可以在分布式链路中传播追踪上下文。

### `JSONRPCNotification`

```rust
// jsonrpc_lite.rs:60-65
pub struct JSONRPCNotification {
    pub method: String,
    pub params: Option<serde_json::Value>,
}
```

与 `JSONRPCRequest` 结构类似，但**没有 `id` 字段**——这是区分请求与通知的关键。通知是"发后即忘"的，发送方不期待收到响应。也没有 `trace` 字段。

### `JSONRPCResponse`

```rust
// jsonrpc_lite.rs:69-72
pub struct JSONRPCResponse {
    pub id: RequestId,
    pub result: Result,  // 即 serde_json::Value
}
```

成功响应，`id` 与对应请求的 `id` 匹配。`result` 是任意 JSON 值。

### `JSONRPCError`

```rust
// jsonrpc_lite.rs:76-79
pub struct JSONRPCError {
    pub error: JSONRPCErrorError,
    pub id: RequestId,
}
```

错误响应，通过嵌套的 `JSONRPCErrorError` 结构体携带错误详情。

### `JSONRPCErrorError`

```rust
// jsonrpc_lite.rs:82-88
pub struct JSONRPCErrorError {
    pub code: i64,
    pub data: Option<serde_json::Value>,
    pub message: String,
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `code` | `i64` | 是 | 错误码（语义与 JSON-RPC 2.0 规范一致，如 -32600 表示无效请求） |
| `message` | `String` | 是 | 人类可读的错误描述 |
| `data` | `Option<serde_json::Value>` | 否 | 附加的错误数据 |

## 跨语言支持

所有类型同时派生了三套 schema 导出：

- **`serde`**（`Serialize` / `Deserialize`）：Rust 侧的 JSON 序列化
- **`schemars::JsonSchema`**：生成 JSON Schema，用于校验和文档
- **`ts_rs::TS`**：生成 TypeScript 类型定义，供 IDE 扩展（VS Code、Cursor 等）客户端使用

其中 `RequestId::Integer` 变体通过 `#[ts(type = "number")]` 标注（`jsonrpc_lite.rs:19`），确保 TypeScript 端生成 `number` 类型而非 Rust 的 `i64`。

## 边界 Case 与注意事项

- **无 `jsonrpc` 版本字段**：与标准 JSON-RPC 2.0 不同，线上消息中不包含 `"jsonrpc": "2.0"` 字段。如果与严格遵循 JSON-RPC 2.0 的外部系统通信，需注意此差异。
- **untagged enum 的匹配顺序**：`JSONRPCMessage` 的变体顺序决定了反序列化优先级。当前顺序 Request → Notification → Response → Error 是正确的——如果调换 Request 和 Notification 的顺序，带 `id` 的请求可能被错误解析。
- **`Result` 类型别名**：模块内定义了 `pub type Result = serde_json::Value`（`jsonrpc_lite.rs:32`），这会遮蔽 `std::result::Result`。在该模块内使用标准 `Result` 需要写全路径。
- **`params` 的序列化行为**：`params` 字段使用 `skip_serializing_if = "Option::is_none"`，当值为 `None` 时，序列化后的 JSON 中完全不会出现 `params` 键，而非输出 `"params": null`。