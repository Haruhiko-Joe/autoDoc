# TransportFactory（传输选择工厂）

## 概述与职责

TransportFactory 是传输协议适配层（Transports）中的工厂模块，由单一函数 `getTransportForUrl` 组成，位于 `src/cli/transports/transportUtils.ts`（45 行）。它的职责是根据环境变量和 URL 协议，为远程会话选择合适的传输策略实例。

在整体架构中，该模块属于 **CLITransport → Transports** 层级。它被上层的 `RemoteIO`（`src/cli/remoteIO.ts`）调用，在建立远程连接时决定使用哪种传输实现。同级模块包括三种具体传输实现（WebSocketTransport、SSETransport、HybridTransport）、CCRClient、以及批量上传器等。

## 关键流程

### 传输策略选择流程

`getTransportForUrl` 按以下优先级依次判断，命中即返回：

1. **SSETransport**（SSE 读 + HTTP POST 写）：当环境变量 `CLAUDE_CODE_USE_CCR_V2` 为真值时选用。此路径还会执行 URL 转换：
   - 将 `wss:` 协议转为 `https:`，`ws:` 转为 `http:`（`transportUtils.ts:27-31`）
   - 在路径末尾拼接 `/worker/events/stream` 以构造 SSE 流端点（`transportUtils.ts:32-33`）

2. **HybridTransport**（WebSocket 读 + HTTP POST 写）：当 URL 协议为 `ws:` 或 `wss:` 且环境变量 `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2` 为真值时选用（`transportUtils.ts:38-40`）

3. **WebSocketTransport**（全双工 WebSocket）：当 URL 协议为 `ws:` 或 `wss:` 且上述环境变量均未设置时，使用默认的全双工 WebSocket 传输（`transportUtils.ts:41`）

4. **异常**：若 URL 协议既非 `ws:`/`wss:`，又未命中 CCR v2 路径，则抛出 `Unsupported protocol` 错误（`transportUtils.ts:43`）

```
┌─────────────────────────────┐
│   getTransportForUrl(url)   │
└──────────┬──────────────────┘
           │
           ▼
   CLAUDE_CODE_USE_CCR_V2?
      ├── Yes ──► 协议转换 wss→https
      │           拼接 /worker/events/stream
      │           返回 SSETransport
      │
      ▼ No
   协议是 ws: / wss: ?
      ├── No ──► throw Error
      │
      ▼ Yes
   CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2?
      ├── Yes ──► 返回 HybridTransport
      │
      ▼ No
   返回 WebSocketTransport（默认）
```

## 函数签名与参数说明

### `getTransportForUrl(url, headers?, sessionId?, refreshHeaders?): Transport`

> 源码位置：`src/cli/transports/transportUtils.ts:16-45`

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `url` | `URL` | — | 远程会话的目标地址（通常由 `--sdk-url` 参数传入，格式如 `.../sessions/{id}`） |
| `headers` | `Record<string, string>` | `{}` | 初始 HTTP 请求头，用于认证等 |
| `sessionId` | `string \| undefined` | `undefined` | 会话标识符，传递给底层传输用于会话追踪 |
| `refreshHeaders` | `() => Record<string, string> \| undefined` | `undefined` | 头部刷新回调，用于 token 过期后重新获取认证头 |

**返回值**：`Transport` 接口实例——具体为 `SSETransport`、`HybridTransport` 或 `WebSocketTransport` 之一。

## 配置项与环境变量

| 环境变量 | 作用 | 选择的传输 |
|----------|------|-----------|
| `CLAUDE_CODE_USE_CCR_V2` | 启用 CCR v2 模式（SSE + POST） | `SSETransport` |
| `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2` | 启用混合写入模式（WS 读 + POST 写） | `HybridTransport` |
| 均未设置 | 默认行为 | `WebSocketTransport` |

环境变量通过 `isEnvTruthy()` 工具函数判断（`src/utils/envUtils.ts:32`），支持字符串和布尔值的真值判定。

## 调用方

该函数的唯一调用方是 `RemoteIO`（`src/cli/remoteIO.ts:88`），在远程 IO 初始化连接时调用。`RemoteIO` 还会对 CCR v2 场景做额外的 invariant 断言——如果 `CLAUDE_CODE_USE_CCR_V2` 为真但返回的传输不是 `SSETransport`，会抛出明确错误（`remoteIO.ts:121-124`）。

## 边界 Case 与注意事项

- **CCR v2 路径不检查 URL 协议**：当 `CLAUDE_CODE_USE_CCR_V2` 为真时，函数直接进入 SSE 分支并执行协议转换，不要求输入 URL 必须是 `ws:`/`wss:`。这意味着 `https:` URL 也能正常工作（协议转换的 if 分支不会命中，保持原协议）。
- **路径末尾斜杠处理**：SSE URL 构造时会先用 `replace(/\/$/, '')` 去除末尾斜杠，再拼接 `/worker/events/stream`，确保路径格式一致。
- **非 WebSocket 协议直接报错**：在非 CCR v2 路径下，如果传入 `http:` 或 `https:` 协议的 URL，会抛出 `Unsupported protocol` 异常，而不是静默降级。