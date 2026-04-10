# UpstreamProxy — CONNECT-over-WebSocket 上游代理

## 概述与职责

UpstreamProxy 是 CCR（Cloud Container Runtime）容器侧的 HTTPS 上游代理模块，属于 **BridgeAndRemote** 层的基础设施组件。它的核心使命是：在 CCR 容器内部启动一个本地 TCP 代理，将容器中 CLI 工具（curl、gh、kubectl 等）的 HTTPS CONNECT 请求通过 WebSocket 隧道转发到 CCR 上游代理服务器，由服务器端进行 TLS MITM 并注入组织级凭证（如 DD-API-KEY）后再转发到真正的上游。

该模块由两个文件组成：
- **`upstreamproxy.ts`**：初始化编排器——读取会话令牌、下载 CA 证书、启动中继、配置环境变量
- **`relay.ts`**：TCP-to-WebSocket 中继核心——手写 protobuf 编解码、双运行时（Bun/Node）支持

**架构定位**：UpstreamProxy 位于 BridgeAndRemote 子系统中，与远程会话管理并列。它不参与业务对话流程，而是为 CCR 容器内所有需要访问外部 HTTPS 服务的子进程提供透明的代理通道。

**关键设计原则**：所有步骤 **fail-open**——任何错误只记录日志并禁用代理，绝不会阻断会话。

## 关键流程

### 初始化流程（`initUpstreamProxy`）

`initUpstreamProxy()` 在 `init.ts` 中被调用一次，执行以下 6 个步骤（`src/upstreamproxy/upstreamproxy.ts:79-153`）：

1. **环境检查**：确认 `CLAUDE_CODE_REMOTE` 和 `CCR_UPSTREAM_PROXY_ENABLED` 环境变量均为 truthy，且 `CLAUDE_CODE_REMOTE_SESSION_ID` 已设置
2. **读取会话令牌**：从 `/run/ccr/session_token` 读取令牌（`readToken()`），文件不存在则 fail-open
3. **安全加固**：调用 `setNonDumpable()` 通过 `prctl(PR_SET_DUMPABLE, 0)` 阻止同 UID 进程 ptrace 堆内存，防止 prompt injection 攻击通过 `gdb -p $PPID` 窃取 token
4. **下载 CA 证书**：从 `{baseUrl}/v1/code/upstreamproxy/ca-cert` 下载 MITM CA 证书，与系统 CA 包拼接后写入 `~/.ccr/ca-bundle.crt`
5. **启动中继**：调用 `startUpstreamProxyRelay()` 在 `127.0.0.1` 上启动 TCP 监听（端口由 OS 分配）
6. **清理令牌文件**：中继启动成功后立即 `unlink` 令牌文件——令牌仅保留在进程堆内存中，agent 循环无法通过文件系统读取

### CONNECT 隧道建立流程

当客户端工具（如 curl）通过 `HTTPS_PROXY` 连接到本地中继时：

**Phase 1 — CONNECT 解析**（`handleData()`, `src/upstreamproxy/relay.ts:295-342`）：
1. 累积 TCP 数据直到遇到 `\r\n\r\n`（完整 CONNECT 请求头）
2. 解析首行验证格式为 `CONNECT host:port HTTP/1.x`，非法请求返回 405
3. 暂存 CONNECT 头之后的尾随字节（TCP 可能将 CONNECT 和 ClientHello 合并到一个包中）
4. 调用 `openTunnel()` 建立 WebSocket 连接

**Phase 2 — WebSocket 隧道**（`openTunnel()`, `src/upstreamproxy/relay.ts:344-428`）：
1. 创建 WebSocket 连接到 `{baseUrl}/v1/code/upstreamproxy/ws`，设置 `Content-Type: application/proto` 和 Bearer 认证头
2. `ws.onopen`：发送第一个 chunk，包含 CONNECT 行和 `Proxy-Authorization` 头；刷新所有 pending 数据；启动 30 秒间隔的 keepalive
3. `ws.onmessage`：解码 protobuf chunk，将有效载荷写回客户端 TCP socket
4. `ws.onerror` / `ws.onclose`：若隧道尚未建立则返回 502 Bad Gateway，然后关闭连接

**Phase 3 — 数据转发**：
隧道建立后，客户端 TCP 数据通过 `forwardToWs()` 按 512KB 分片编码为 protobuf chunk 发送到 WS；WS 接收的数据解码后写回 TCP socket。

### 环境变量注入流程

`getUpstreamProxyEnv()`（`src/upstreamproxy/upstreamproxy.ts:160-199`）被 `subprocessEnv()` 调用，为所有 agent 子进程（Bash、MCP、LSP、hooks）注入代理配置：

- `HTTPS_PROXY` / `https_proxy`：指向本地中继 `http://127.0.0.1:{port}`
- `NO_PROXY` / `no_proxy`：排除列表（loopback、RFC1918、Anthropic API、GitHub、包管理器）
- `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS` / `REQUESTS_CA_BUNDLE` / `CURL_CA_BUNDLE`：指向包含 MITM CA 的证书包

对于子 CLI 进程（令牌文件已被父进程删除，无法重新初始化中继），如果检测到已从父进程继承了 `HTTPS_PROXY` 和 `SSL_CERT_FILE`，则直接透传这些变量。

## 函数签名与参数说明

### `initUpstreamProxy(opts?): Promise<UpstreamProxyState>`

初始化入口。生产环境无需传参，所有 `opts` 字段仅供测试覆盖。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `opts.tokenPath` | `string` | `/run/ccr/session_token` | 会话令牌文件路径 |
| `opts.systemCaPath` | `string` | `/etc/ssl/certs/ca-certificates.crt` | 系统 CA 包路径 |
| `opts.caBundlePath` | `string` | `~/.ccr/ca-bundle.crt` | 输出 CA 包路径 |
| `opts.ccrBaseUrl` | `string` | `process.env.ANTHROPIC_BASE_URL` | CCR API 基地址 |

返回 `{ enabled: boolean; port?: number; caBundlePath?: string }`。

> 源码位置：`src/upstreamproxy/upstreamproxy.ts:79-153`

### `getUpstreamProxyEnv(): Record<string, string>`

返回需要注入子进程的环境变量。代理未启用时返回空对象（或透传继承的代理变量）。

> 源码位置：`src/upstreamproxy/upstreamproxy.ts:160-199`

### `startUpstreamProxyRelay(opts): Promise<UpstreamProxyRelay>`

启动 TCP 中继服务器。自动检测运行时环境：Bun 环境使用 `Bun.listen()`，Node 环境使用 `net.createServer()`。

| 参数 | 类型 | 说明 |
|------|------|------|
| `opts.wsUrl` | `string` | WebSocket 上游端点 URL |
| `opts.sessionId` | `string` | CCR 会话 ID，用于构造 Basic Auth |
| `opts.token` | `string` | 会话令牌，用于 WS 升级和隧道认证 |

返回 `{ port: number; stop: () => void }`。

> 源码位置：`src/upstreamproxy/relay.ts:155-174`

### `encodeChunk(data: Uint8Array): Uint8Array`

手写 protobuf 编码器，将原始字节封装为 `UpstreamProxyChunk` 消息。协议格式：tag `0x0a`（field 1, wire type 2）+ varint 长度 + 数据字节。

> 源码位置：`src/upstreamproxy/relay.ts:66-81`

### `decodeChunk(buf: Uint8Array): Uint8Array | null`

对应的解码器。空缓冲返回空数组，tag 不匹配或长度越界返回 `null`。容忍服务端发送的零长度 chunk（keepalive 语义）。

> 源码位置：`src/upstreamproxy/relay.ts:87-103`

## 接口/类型定义

### `UpstreamProxyRelay`

```typescript
type UpstreamProxyRelay = {
  port: number    // 中继监听的临时端口
  stop: () => void // 停止中继服务器
}
```

### `ConnState`

每个客户端 TCP 连接的内部状态（`src/upstreamproxy/relay.ts:110-127`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ws` | `WebSocketLike` | 该连接对应的 WebSocket 实例 |
| `connectBuf` | `Buffer` | 累积的 CONNECT 请求头 |
| `pending` | `Buffer[]` | WS 握手完成前到达的 TCP 数据缓冲 |
| `wsOpen` | `boolean` | WS 是否已 OPEN |
| `established` | `boolean` | 服务端 200 是否已转发（TLS 隧道已建立） |
| `closed` | `boolean` | 防止重复关闭的 guard（onerror + onclose 可能连续触发） |

### `WebSocketLike`

运行时无关的 WebSocket 接口抽象（`src/upstreamproxy/relay.ts:37-47`），同时兼容 undici 的 `globalThis.WebSocket` 和 `ws` 包。

## 配置项与默认值

| 配置 | 来源 | 默认值 | 说明 |
|------|------|--------|------|
| `CLAUDE_CODE_REMOTE` | 环境变量 | — | 必须为 truthy 才启用代理 |
| `CCR_UPSTREAM_PROXY_ENABLED` | 环境变量（由 CCR 服务端注入） | — | 必须为 truthy 才启用代理 |
| `CLAUDE_CODE_REMOTE_SESSION_ID` | 环境变量 | — | CCR 会话 ID |
| `ANTHROPIC_BASE_URL` | 环境变量 | `https://api.anthropic.com` | CCR API 基地址 |
| `MAX_CHUNK_BYTES` | 常量 | `512 * 1024` (512KB) | 单个 protobuf chunk 最大字节数，受 Envoy 缓冲限制 |
| `PING_INTERVAL_MS` | 常量 | `30000` (30秒) | WS keepalive 间隔，需小于 sidecar 50秒空闲超时 |

## 边界 Case 与注意事项

### Fail-open 设计
所有步骤（令牌读取、CA 下载、中继启动）失败时仅记录警告并返回 `{ enabled: false }`，不会抛出异常阻断会话启动。

### 双运行时支持
- **Bun**：使用 `Bun.listen()` 创建 TCP 服务器，手动管理写缓冲区（`sock.write()` 可能只写入部分字节）；WebSocket 通过 `globalThis.WebSocket` 创建，利用 Bun 的 `proxy` 扩展属性
- **Node**：使用 `net.createServer()`，`sock.write()` 内部缓冲无需手动管理；WebSocket 使用 `ws` 包并传入显式 `agent`（因为 undici 的 `globalThis.WebSocket` 不走全局 dispatcher）

### TCP 数据合并问题
TCP 可能将 CONNECT 请求和 TLS ClientHello 合并为一个包。`handleData()` 通过 `pending` 缓冲区处理这种情况：CONNECT 头解析后的尾随字节被暂存，WS `onopen` 后统一刷新（`src/upstreamproxy/relay.ts:326-330`）。

### 安全加固
- `prctl(PR_SET_DUMPABLE, 0)`：阻止同 UID 的 ptrace（仅 Linux + Bun 环境生效），防止 prompt injection 通过 GDB 窃取堆上的 token
- 令牌文件在中继启动成功后立即删除（`unlink`），agent 循环无法通过文件系统访问
- 令牌 unlink 在中继确认启动**之后**执行，确保 supervisor 重启时令牌文件仍可用于重试

### NO_PROXY 列表
代理排除列表覆盖（`src/upstreamproxy/upstreamproxy.ts:37-63`）：
- 回环地址和 RFC1918 私有网段
- Anthropic API（三种格式以兼容不同运行时的 NO_PROXY 解析：`*.anthropic.com`、`.anthropic.com`、`anthropic.com`）
- GitHub 和主流包管理器（npm、PyPI、crates.io、Go proxy）

### 仅代理 HTTPS
`HTTP_PROXY` 不设置，仅设置 `HTTPS_PROXY`。中继只处理 CONNECT 方法，普通 HTTP 请求会收到 405 响应（`src/upstreamproxy/relay.ts:321-323`）。

### TLS 隧道建立后的错误处理
一旦 `established` 标志为 `true`（服务端的 200 已转发给客户端），WS 错误时不再写入明文 502 响应——因为此时 TCP 连接已承载 TLS 流量，写入明文会破坏客户端的 TLS 状态，直接关闭连接即可（`src/upstreamproxy/relay.ts:414-418`）。

### 子进程环境变量继承
子 CLI 进程无法重新初始化中继（令牌文件已删除），但父进程的中继仍在运行。`getUpstreamProxyEnv()` 检测到继承的 `HTTPS_PROXY` 和 `SSL_CERT_FILE` 时，会透传所有代理相关变量（`src/upstreamproxy/upstreamproxy.ts:166-183`）。