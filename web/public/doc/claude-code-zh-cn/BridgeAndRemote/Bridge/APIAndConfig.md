# API 客户端、认证与配置基础层

## 概述与职责

本模块是 Bridge 远程控制系统的**基础设施层**，为整个桥接系统提供 HTTP API 通信、认证令牌管理、轮询配置和安全机制。它位于 `BridgeAndRemote > Bridge` 层级下，是桥接主循环（`bridgeMain.ts`）和 REPL 桥接（`replBridge.ts`）的共同底座。

在同级模块中，本模块与会话生命周期管理、消息收发、传输层等模块协同工作——它们依赖本模块提供的 API 客户端发起网络请求，依赖配置层获取认证令牌和基础 URL，依赖轮询配置决定工作轮询节奏。

模块由 10 个文件组成，按职责可分为四组：

- **API 客户端**：`bridgeApi.ts` — 带 OAuth 重试的 HTTP 客户端
- **认证与安全**：`jwtUtils.ts`（JWT 刷新调度）、`bridgeConfig.ts`（令牌/URL 解析）、`trustedDevice.ts`（可信设备令牌）
- **工作密钥与 SDK**：`workSecret.ts` — 解码工作密钥、构建 SDK URL、注册 worker
- **类型与配置**：`types.ts`（核心接口契约）、`bridgePermissionCallbacks.ts`（权限类型）、`pollConfig.ts` + `pollConfigDefaults.ts`（轮询间隔）、`capacityWake.ts`（容量唤醒信号）

## 关键流程

### 1. API 请求与 OAuth 401 自动重试

`bridgeApi.ts` 通过 `createBridgeApiClient()` 工厂函数创建 `BridgeApiClient` 实例。所有需要认证的请求都通过内部 `withOAuthRetry()` 包装，实现了**单次 401 重试**机制：

1. 调用 `resolveAuth()` 获取当前 OAuth access token
2. 执行实际的 HTTP 请求（axios）
3. 若返回 401，调用注入的 `onAuth401` 回调尝试刷新令牌
4. 刷新成功后用新令牌重试一次；若仍然 401，抛出 `BridgeFatalError`

```typescript
// src/bridge/bridgeApi.ts:106-139
async function withOAuthRetry<T>(
  fn: (accessToken: string) => Promise<{ status: number; data: T }>,
  context: string,
): Promise<{ status: number; data: T }> {
  const accessToken = resolveAuth()
  const response = await fn(accessToken)
  if (response.status !== 401) return response
  if (!deps.onAuth401) return response
  const refreshed = await deps.onAuth401(accessToken)
  if (refreshed) {
    const newToken = resolveAuth()
    const retryResponse = await fn(newToken)
    if (retryResponse.status !== 401) return retryResponse
  }
  return response
}
```

所有请求头通过 `getHeaders()` 统一注入 OAuth Bearer token、API 版本号（`anthropic-version: 2023-06-01`）、Beta 头（`environments-2025-11-01`）、runner 版本号，以及可选的 `X-Trusted-Device-Token`。

**安全措施**：所有服务端返回的 ID（environmentId、workId、sessionId）在插入 URL 路径前，都通过 `validateBridgeId()` 校验格式（`/^[a-zA-Z0-9_-]+$/`），防止路径遍历注入。

### 2. JWT 过期前主动刷新

`jwtUtils.ts` 的 `createTokenRefreshScheduler()` 实现了一个**多会话 token 刷新调度器**，确保长时间运行的桥接会话不会因 token 过期而中断：

1. 调用 `schedule(sessionId, token)` 时，解码 JWT 的 `exp` 声明（`decodeJwtExpiry()`）
2. 计算刷新时间：`exp - 当前时间 - 5分钟缓冲`
3. 设置 `setTimeout` 定时器，到期后执行 `doRefresh()`
4. `doRefresh()` 获取新的 OAuth token，调用 `onRefresh` 回调将其传递给调用方
5. 刷新成功后**自动安排下一次刷新**（30 分钟后），形成持续的刷新链

关键设计：

- **Generation 计数器**：每次 `schedule()` 或 `cancel()` 递增 generation，异步的 `doRefresh()` 在执行前检查 generation 是否匹配，避免取消后的幽灵回调（`src/bridge/jwtUtils.ts:91-100`）
- **失败重试与上限**：OAuth token 获取失败时，60 秒后重试，最多连续失败 3 次后放弃
- **`scheduleFromExpiresIn`**：支持不解码 JWT，直接使用服务端返回的 `expires_in` 秒数调度刷新，适用于 CCR v2 的 bridge 端点

### 3. 认证令牌与 URL 解析

`bridgeConfig.ts` 集中管理桥接系统的认证凭据来源，实现了两层优先级：

```
开发覆盖（ant 内部）→ 生产 OAuth
```

- `getBridgeAccessToken()`：先检查 `CLAUDE_BRIDGE_OAUTH_TOKEN` 环境变量（仅 `USER_TYPE=ant` 时生效），否则从 OAuth keychain 读取（`src/bridge/bridgeConfig.ts:38-40`）
- `getBridgeBaseUrl()`：先检查 `CLAUDE_BRIDGE_BASE_URL`，否则使用生产 OAuth 配置的 `BASE_API_URL`（`src/bridge/bridgeConfig.ts:46-48`）

这些函数被多个文件引用（bridgeMain、replBridge、daemon workers 等），统一了此前分散在十余处的环境变量读取逻辑。

### 4. 可信设备令牌（CCR v2 ELEVATED 安全层级）

`trustedDevice.ts` 管理桥接会话的可信设备认证，属于 CCR v2 的 ELEVATED 安全层级：

**注册流程**（`enrollTrustedDevice()`，在 `/login` 后立即调用）：

1. 检查 GrowthBook 特性门控 `tengu_sessions_elevated_auth_enforcement`
2. 获取当前 OAuth access token
3. `POST /api/auth/trusted_devices` 注册设备，提交设备显示名（主机名 + 平台）
4. 将返回的 `device_token` 持久化到系统 keychain（`secureStorage`）
5. 清除 memoize 缓存使新 token 立即生效

**读取流程**（`getTrustedDeviceToken()`，每次 API 请求时调用）：

1. 检查特性门控——门控关闭时直接返回 `undefined`（不发送 header）
2. 从 memoized 缓存读取：优先 `CLAUDE_TRUSTED_DEVICE_TOKEN` 环境变量，否则从 keychain 读取

> 设计要点：存储读取被 memoize 缓存（macOS `security` 子进程每次约 40ms），而特性门控是实时检查的，确保门控翻转后无需重启即可生效。服务端约束注册必须在账户会话创建后 10 分钟内完成，所以不能延迟到首次 bridge 调用时才注册。

### 5. 工作密钥解码与 SDK URL 构建

`workSecret.ts` 处理轮询到工作项后的关键解码和连接建立步骤：

**`decodeWorkSecret(secret)`**（`src/bridge/workSecret.ts:6-32`）：
- 将 base64url 编码的 `secret` 字段解码为 JSON
- 校验 `version === 1`
- 校验 `session_ingress_token` 和 `api_base_url` 必须存在
- 返回类型化的 `WorkSecret` 对象

**`buildSdkUrl(apiBaseUrl, sessionId)`**（`src/bridge/workSecret.ts:41-48`）：
- 将 HTTP(S) URL 转换为 WebSocket URL
- 本地开发使用 `ws://` + `/v2/`（直连 session-ingress）
- 生产环境使用 `wss://` + `/v1/`（经 Envoy 代理重写到 `/v2/`）

**`buildCCRv2SdkUrl(apiBaseUrl, sessionId)`**（`src/bridge/workSecret.ts:81-87`）：
- CCR v2 路径返回 HTTP(S) URL（非 WebSocket），指向 `/v1/code/sessions/{id}`
- 子进程从此 base URL 派生 SSE 流和 worker 端点

**`sameSessionId(a, b)`**（`src/bridge/workSecret.ts:62-73`）：
- 比较两个可能带不同前缀标签的 session ID（如 `session_*` vs `cse_*`）
- 提取最后一个 `_` 后的 body 部分比较，要求至少 4 个字符以避免误匹配
- 解决了 CCR v2 兼容层返回不同前缀标签时桥接拒绝自身会话的问题

**`registerWorker(sessionUrl, accessToken)`**（`src/bridge/workSecret.ts:97-127`）：
- `POST {sessionUrl}/worker/register` 注册为 CCR v2 会话的 worker
- 返回 `worker_epoch`（处理了 protojson int64 可能序列化为 string 的情况）
- 该 epoch 需要传递给子进程的 CCRClient 用于后续心跳/状态请求

## 函数签名与参数说明

### `createBridgeApiClient(deps: BridgeApiDeps): BridgeApiClient`

> 源码位置：`src/bridge/bridgeApi.ts:68`

创建桥接 API 客户端实例。

**BridgeApiDeps 参数：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `baseUrl` | `string` | API 基础 URL |
| `getAccessToken` | `() => string \| undefined` | 获取当前 OAuth token |
| `runnerVersion` | `string` | Runner 版本号，随请求头发送 |
| `onDebug` | `(msg: string) => void` | 可选，调试日志回调 |
| `onAuth401` | `(staleToken: string) => Promise<boolean>` | 可选，401 时的令牌刷新回调 |
| `getTrustedDeviceToken` | `() => string \| undefined` | 可选，获取可信设备令牌 |

**BridgeApiClient 方法：**

| 方法 | 说明 |
|------|------|
| `registerBridgeEnvironment(config)` | 注册桥接环境，返回 `environment_id` 和 `environment_secret` |
| `pollForWork(envId, secret, signal?, reclaimMs?)` | 轮询可用工作项，返回 `WorkResponse` 或 `null` |
| `acknowledgeWork(envId, workId, sessionToken)` | 确认已接收工作项 |
| `stopWork(envId, workId, force)` | 停止工作项 |
| `deregisterEnvironment(envId)` | 注销桥接环境（优雅关闭） |
| `heartbeatWork(envId, workId, sessionToken)` | 心跳续租，返回 `{ lease_extended, state }` |
| `sendPermissionResponseEvent(sessionId, event, token)` | 向会话发送权限响应事件 |
| `archiveSession(sessionId)` | 归档会话（409 幂等） |
| `reconnectSession(envId, sessionId)` | 重连会话（`--session-id` 恢复场景） |

### `createTokenRefreshScheduler(opts): TokenRefreshScheduler`

> 源码位置：`src/bridge/jwtUtils.ts:72`

| 返回方法 | 说明 |
|---------|------|
| `schedule(sessionId, token)` | 根据 JWT exp 声明安排刷新定时器 |
| `scheduleFromExpiresIn(sessionId, expiresInSeconds)` | 根据显式 TTL 安排刷新 |
| `cancel(sessionId)` | 取消单个会话的刷新 |
| `cancelAll()` | 取消所有会话的刷新 |

### `createCapacityWake(outerSignal): CapacityWake`

> 源码位置：`src/bridge/capacityWake.ts:28`

| 返回方法 | 说明 |
|---------|------|
| `signal()` | 创建合并信号（外部关闭 OR 容量释放），返回 `{ signal, cleanup }` |
| `wake()` | 触发容量唤醒，中断当前 sleep 使轮询循环立即重新检查 |

## 接口/类型定义

### `BridgeConfig`

> 源码位置：`src/bridge/types.ts:81-115`

桥接环境的完整配置。关键字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `dir` | `string` | 工作目录 |
| `machineName` | `string` | 机器名称 |
| `spawnMode` | `SpawnMode` | 会话工作目录策略：`single-session` / `worktree` / `same-dir` |
| `maxSessions` | `number` | 最大并发会话数 |
| `bridgeId` | `string` | 客户端生成的 UUID，标识桥接实例 |
| `environmentId` | `string` | 客户端生成的 UUID，幂等注册用 |
| `reuseEnvironmentId` | `string?` | 后端颁发的 ID，用于重连恢复 |
| `workerType` | `string` | worker 类型标识（`claude_code` / `claude_code_assistant` 等） |
| `sessionTimeoutMs` | `number?` | 单会话超时，默认 24 小时 |

### `WorkSecret`

> 源码位置：`src/bridge/types.ts:33-51`

轮询获取的工作项密钥，base64url 编码传输。包含 session ingress token、API base URL、代码源配置、认证信息、环境变量注入等。`use_code_sessions` 标志指示是否走 CCR v2 路径。

### `WorkResponse`

> 源码位置：`src/bridge/types.ts:23-31`

轮询返回的工作项，包含 `id`、`environment_id`、工作数据（`type: 'session' | 'healthcheck'`）和 base64url 编码的 `secret`。

### `SessionHandle`

> 源码位置：`src/bridge/types.ts:178-190`

运行中会话的控制句柄。暴露 `done` Promise（完成状态）、`kill()`/`forceKill()` 终止方法、活动环形缓冲区、stdin 写入和 token 热更新能力。

### `BridgePermissionCallbacks` / `BridgePermissionResponse`

> 源码位置：`src/bridge/bridgePermissionCallbacks.ts:1-43`

权限请求/响应的回调接口。`sendRequest` 发起权限询问，`onResponse` 注册响应处理器（返回取消订阅函数），`cancelRequest` 取消挂起的请求。`BridgePermissionResponse` 包含 `behavior: 'allow' | 'deny'` 以及可选的修改后输入和权限更新。

### `PollIntervalConfig`

> 源码位置：`src/bridge/pollConfigDefaults.ts:44-53`

轮询间隔配置类型，包含 8 个字段，覆盖单会话和多会话模式的不同容量状态下的轮询/心跳间隔。

## 配置项与默认值

### 轮询间隔（`pollConfigDefaults.ts`）

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `poll_interval_ms_not_at_capacity` | 2000ms | 寻找工作时的轮询间隔 |
| `poll_interval_ms_at_capacity` | 600000ms (10min) | 已连接时的轮询间隔（兼作存活信号） |
| `non_exclusive_heartbeat_interval_ms` | 0 (禁用) | 心跳间隔，与轮询独立运行 |
| `reclaim_older_than_ms` | 5000ms | 回收未确认工作项的阈值 |
| `session_keepalive_interval_v2_ms` | 120000ms (2min) | 空闲会话保活帧间隔 |

所有轮询配置通过 GrowthBook 特性标志 `tengu_bridge_poll_interval_config` 远程可调，5 分钟刷新窗口。配置经 Zod schema 校验——不合法的值会导致整个配置回退到默认值而非部分信任。

### JWT 刷新参数（`jwtUtils.ts`）

| 参数 | 值 | 说明 |
|------|-----|------|
| `TOKEN_REFRESH_BUFFER_MS` | 5 分钟 | 在过期前多久触发刷新 |
| `FALLBACK_REFRESH_INTERVAL_MS` | 30 分钟 | 无法解码 JWT 时的后备刷新间隔 |
| `MAX_REFRESH_FAILURES` | 3 | 连续失败上限 |
| `REFRESH_RETRY_DELAY_MS` | 60 秒 | 失败后重试延迟 |

### 环境变量

| 变量 | 用途 |
|------|------|
| `CLAUDE_BRIDGE_OAUTH_TOKEN` | 开发覆盖：直接指定 OAuth token（仅 `USER_TYPE=ant`） |
| `CLAUDE_BRIDGE_BASE_URL` | 开发覆盖：指定 API 基础 URL（仅 `USER_TYPE=ant`） |
| `CLAUDE_TRUSTED_DEVICE_TOKEN` | 测试/金丝雀覆盖：直接指定可信设备令牌 |

## 边界 Case 与注意事项

- **401 重试只执行一次**：`withOAuthRetry` 在刷新成功后仅重试一次，避免无限循环。未注入 `onAuth401` 的调用方（如 daemon workers 使用环境变量 token）直接抛出 `BridgeFatalError`
- **`BridgeFatalError` 区分可恢复与不可恢复**：401/403/404/410 抛出 `BridgeFatalError`（不应重试），429 抛出普通 `Error`（可重试）。`isSuppressible403()` 识别非核心权限错误（如 `external_poll_sessions`），避免干扰用户
- **轮询空响应的日志抑制**：连续空轮询只在第 1 次和每 100 次时记录日志，防止高频日志噪声（`src/bridge/bridgeApi.ts:229-239`）
- **archiveSession 幂等处理**：409 状态码（已归档）被静默处理，不抛异常
- **JWT 刷新的 Generation 机制**：防止取消后的异步回调设置新定时器导致内存泄漏或幽灵刷新。`cancel()` 和 `schedule()` 都会递增 generation
- **scheduleFromExpiresIn 的 30 秒下限**：当 `refreshBufferMs` 超过 `expiresInSeconds` 时，clamp 到 30 秒防止紧循环
- **轮询配置的 0-or-≥100 校验**：at_capacity 间隔允许 0（禁用）或 ≥100ms，拒绝 1-99ms（防止单位混淆——运维以为是秒，实际是毫秒）。同时强制要求至少启用心跳或 at-capacity 轮询之一，防止全部禁用导致紧循环
- **`sameSessionId` 的标签兼容**：CCR v2 兼容层可能给同一个会话 UUID 加上不同的前缀标签（`session_*` vs `cse_*`），此函数通过比较尾部 body 来正确识别同一会话
- **可信设备注册的时间窗口**：服务端要求在账户会话创建后 10 分钟内完成注册，所以必须在 `/login` 流程中立即调用，不能延迟到首次 bridge 调用