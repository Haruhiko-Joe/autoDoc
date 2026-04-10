# BridgeCores — 两套桥接路径的核心实现

## 概述与职责

BridgeCores 是 Remote Control 桥接系统的核心引擎层，包含两套独立的桥接路径实现，负责将本地 Claude Code CLI 会话与云端（claude.ai / CCR）双向连接。它位于 **BridgeAndRemote → Bridge** 层级下，与同级的 RemoteSession（CCR WebSocket 会话管理）、DirectConnect（直连会话管理）、UpstreamProxy（容器侧代理）协同工作。

两套路径的核心区别：

| 维度 | v1 (replBridge.ts) | v2 (remoteBridgeCore.ts) |
|------|-------------------|-------------------------|
| 入口函数 | `initBridgeCore()` | `initEnvLessBridgeCore()` |
| 架构 | Environments API 轮询分发 | 绕过 Environments API，直连 session-ingress |
| 会话创建 | `createSession()` 注入回调 | `POST /v1/code/sessions`（无 env_id） |
| 令牌获取 | 轮询工作项中携带 JWT | `POST /v1/code/sessions/{id}/bridge` → worker_jwt |
| 传输层 | v1: HybridTransport（WS + POST）<br>v2: SSETransport + CCRClient | 仅 SSETransport + CCRClient |
| 令牌刷新 | 服务端重新分发工作项（携带新 JWT） | 主动定时调度 `createTokenRefreshScheduler` |
| 连接恢复 | 环境重注册 + 会话重建/重连 | OAuth 刷新 + `/bridge` 重调 + 传输层重建 |
| 代码量 | ~2400 行 | ~1000 行 |
| 使用场景 | REPL + daemon（通用） | 仅 REPL（GrowthBook `tengu_bridge_repl_v2` 门控） |

配置层 `envLessBridgeConfig.ts` 为 v2 路径提供超时、重试、心跳等运行时参数，支持通过 GrowthBook 远程调整。

## 关键流程

### v1 路径：initBridgeCore 完整生命周期

```
注册环境 → 创建会话 → 启动轮询 → 接收工作项 → 建立传输 → 消息收发 → 清理
```

1. **环境注册**：调用 `api.registerBridgeEnvironment(bridgeConfig)` 向 Environments API 注册本地环境，获得 `environmentId` + `environmentSecret`（`src/bridge/replBridge.ts:352-354`）

2. **持久模式恢复（可选）**：若启用 `perpetual` 模式且存在崩溃恢复指针（`bridgePointer`），尝试 `tryReconnectInPlace()` 复用前次会话（`src/bridge/replBridge.ts:425-427`）

3. **创建会话**：通过注入的 `createSession()` 回调 POST 创建会话，获得 `sessionId`（`src/bridge/replBridge.ts:457-476`）

4. **写入崩溃恢复指针**：将 `{sessionId, environmentId, source: 'repl'}` 写入磁盘文件，供 kill -9 后恢复（`src/bridge/replBridge.ts:484-488`）

5. **启动轮询循环** `startWorkPollLoop()`：在后台持续轮询工作项。当用户在 claude.ai 输入时，后端分发工作项到此环境（`src/bridge/replBridge.ts:1503`）

6. **接收工作项** `onWorkReceived`：解码 work secret 获得 JWT，根据 `useCcrV2` 标志选择 v1（HybridTransport）或 v2（SSETransport + CCRClient）传输层（`src/bridge/replBridge.ts:1077-1501`）

7. **消息收发**：通过 `writeMessages()` / `writeSdkMessages()` 发送；通过 `handleIngressMessage()` 接收入站消息

8. **清理**：发送结果消息 → stopWork + archiveSession 并行 → 关闭传输 → deregisterEnvironment → 清除指针

### v2 路径：initEnvLessBridgeCore 完整生命周期

```
创建会话 → 获取凭证 → 建立传输 → 调度刷新 → 消息收发 → 清理
```

1. **创建会话**：`POST /v1/code/sessions`（不传 env_id），直接获得 `sessionId`（`src/bridge/remoteBridgeCore.ts:173-184`）

2. **获取桥接凭证**：`POST /v1/code/sessions/{id}/bridge` → 返回 `{worker_jwt, expires_in, api_base_url, worker_epoch}`。每次调用 `/bridge` 都会递增 epoch（`src/bridge/remoteBridgeCore.ts:189-214`）

3. **建立 v2 传输**：`createV2ReplTransport()` 创建 SSETransport（读）+ CCRClient（写），传入 JWT 和 epoch（`src/bridge/remoteBridgeCore.ts:222-236`）

4. **JWT 主动刷新调度**：`createTokenRefreshScheduler` 在 token 到期前 5 分钟（`token_refresh_buffer_ms`）触发刷新——重新调用 `/bridge` 获取新 JWT + 新 epoch，然后**重建整个传输层**（`src/bridge/remoteBridgeCore.ts:317-377`）

5. **消息收发**：与 v1 共享相同的 `writeMessages()` / `writeSdkMessages()` / `handleIngressMessage()` 接口

6. **清理**：报告 idle 状态 → 发送结果消息 → archiveSession（带 401 重试） → 关闭传输

### v2 路径：传输层重建（JWT 刷新 / 401 恢复）

v2 的 JWT 刷新和 SSE 401 恢复共享同一个 `rebuildTransport()` 函数：

1. 启动 `flushGate` 队列化写入（防止 epoch 过期后的写入丢失）
2. 获取旧传输的 SSE 序列号高水位
3. 关闭旧传输
4. `createV2ReplTransport()` 创建新传输（使用新 JWT、新 epoch、旧序列号恢复）
5. 重新绑定回调 `wireTransportCallbacks()`
6. 连接新传输并重新调度下次刷新
7. 排空 flushGate 中缓冲的消息

> 源码位置：`src/bridge/remoteBridgeCore.ts:477-527`

关键约束：`authRecoveryInFlight` 标志确保主动刷新和 401 恢复互斥——防止两者同时调用 `/bridge` 导致双重 epoch 递增。

### v1 路径：环境丢失恢复（doReconnect）

当轮询返回 404（环境被服务端清理），执行两阶段恢复：

**策略 1 — 原地重连**：以原 environmentId 为 `reuseEnvironmentId` 重新注册。若服务端返回相同 ID，调用 `reconnectSession()` 重新排队已有会话。URL 不变，无需重发历史。

**策略 2 — 全新会话**：若服务端返回不同 ID（原环境 TTL 过期），归档旧会话，在新环境上创建新会话。重置 `previouslyFlushedUUIDs` + SSE 序列号。

> 源码位置：`src/bridge/replBridge.ts:605-836`

### 轮询循环详解（startWorkPollLoop）

轮询循环是 v1 路径的核心状态机（`src/bridge/replBridge.ts:1851-2398`）：

- **空闲轮询**：按 `poll_interval_ms_not_at_capacity` 间隔（通常 2-5s）快速轮询
- **容量满**：传输已建立时，切换到 `poll_interval_ms_at_capacity`（通常 10min）的低频轮询作为心跳
- **非独占心跳**：在容量满期间，按 `non_exclusive_heartbeat_interval_ms` 调用 `heartbeatWork` 维持工作项租约（300s TTL）
- **挂起检测**：at-capacity sleep 超时 60s+ 视为进程挂起（笔记本合盖），强制一次快速轮询
- **错误恢复**：指数退避 2s → 60s，持续失败 15 分钟后放弃

## 函数签名与参数说明

### `initBridgeCore(params: BridgeCoreParams): Promise<BridgeCoreHandle | null>`

v1 桥接核心入口。注册环境、创建会话、启动轮询循环。失败返回 null。

**BridgeCoreParams 关键字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `dir` | string | 工作目录路径 |
| `baseUrl` | string | API 基础 URL |
| `sessionIngressUrl` | string | Session Ingress 服务 URL |
| `workerType` | string | 发送至后端的 worker 类型标识 |
| `getAccessToken` | `() => string \| undefined` | OAuth token 获取器 |
| `createSession` | 回调函数 | 创建会话的注入回调，避免依赖链膨胀 |
| `archiveSession` | 回调函数 | 归档会话的注入回调，必须不抛异常 |
| `toSDKMessages` | `(messages: Message[]) => SDKMessage[]` | 消息格式转换器（注入以隔离依赖） |
| `onAuth401` | 回调函数 | OAuth 401 处理（钥匙串刷新） |
| `getPollIntervalConfig` | `() => PollIntervalConfig` | 轮询间隔配置（GrowthBook 动态调整） |
| `perpetual` | boolean | 持久模式——teardown 不关闭服务端资源 |
| `initialSSESequenceNum` | number | SSE 序列号种子（daemon 跨重启恢复） |

### `initEnvLessBridgeCore(params: EnvLessBridgeParams): Promise<ReplBridgeHandle | null>`

v2 桥接核心入口。直连 session-ingress，无 Environments API。

**EnvLessBridgeParams 关键字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `baseUrl` | string | API 基础 URL |
| `orgUUID` | string | 组织 UUID（归档请求需要） |
| `title` | string | 会话标题 |
| `getAccessToken` | `() => string \| undefined` | OAuth token 获取器 |
| `toSDKMessages` | `(messages: Message[]) => SDKMessage[]` | 消息格式转换器 |
| `initialHistoryCap` | number | 初始历史消息刷新上限 |
| `outboundOnly` | boolean | 仅激活写路径（CCR Mirror 模式） |
| `tags` | `string[]` | 会话分类标签 |

### 返回值：ReplBridgeHandle / BridgeCoreHandle

```typescript
type ReplBridgeHandle = {
  bridgeSessionId: string        // 当前会话 ID（v1 中可变——重连后更新）
  environmentId: string          // 环境 ID（v2 返回空字符串）
  sessionIngressUrl: string      // Session Ingress URL
  writeMessages(messages: Message[]): void       // 发送内部格式消息
  writeSdkMessages(messages: SDKMessage[]): void // 发送 SDK 格式消息（daemon 路径）
  sendControlRequest(request: SDKControlRequest): void   // 权限请求
  sendControlResponse(response: SDKControlResponse): void // 权限响应
  sendControlCancelRequest(requestId: string): void       // 取消权限请求
  sendResult(): void             // 发送结果消息（标记 turn 结束）
  teardown(): Promise<void>      // 清理所有资源
}

// v1 扩展
type BridgeCoreHandle = ReplBridgeHandle & {
  getSSESequenceNum(): number    // SSE 序列号高水位（daemon 持久化用）
}
```

> 源码位置：`src/bridge/replBridge.ts:70-81`（ReplBridgeHandle）、`228-235`（BridgeCoreHandle）

## 接口/类型定义

### `BridgeState`

桥接连接的四种状态：

```typescript
type BridgeState = 'ready' | 'connected' | 'reconnecting' | 'failed'
```

- `ready`：环境注册完成/凭证获取完成，等待传输层连接
- `connected`：传输层已连接且初始历史刷新完成
- `reconnecting`：连接丢失，正在恢复（JWT 刷新/环境重建/轮询错误退避）
- `failed`：不可恢复的失败

### `EnvLessBridgeConfig`

v2 路径的完整运行时配置（`src/bridge/envLessBridgeConfig.ts:7-42`）：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `init_retry_max_attempts` | number | 3 | 初始化阶段重试次数 |
| `init_retry_base_delay_ms` | number | 500 | 重试基础延迟 |
| `init_retry_jitter_fraction` | number | 0.25 | 重试抖动系数 (±25%) |
| `init_retry_max_delay_ms` | number | 4000 | 重试最大延迟 |
| `http_timeout_ms` | number | 10000 | HTTP 请求超时 |
| `uuid_dedup_buffer_size` | number | 2000 | BoundedUUIDSet 环形缓冲区大小 |
| `heartbeat_interval_ms` | number | 20000 | CCRClient 心跳间隔（服务端 TTL 60s，3× 余量） |
| `heartbeat_jitter_fraction` | number | 0.1 | 心跳抖动系数，分散集群负载 |
| `token_refresh_buffer_ms` | number | 300000 | JWT 到期前提前刷新的缓冲时间（5 分钟） |
| `teardown_archive_timeout_ms` | number | 1500 | 归档请求超时（受限于 gracefulShutdown 2s 上限） |
| `connect_timeout_ms` | number | 15000 | 传输层连接超时（p99 约 2-3s，5× 余量） |
| `min_version` | string | '0.0.0' | v2 路径最低版本要求 |
| `should_show_app_upgrade_message` | boolean | false | 是否提示用户升级 claude.ai 客户端 |

### `ConnectCause`（v2 内部类型）

```typescript
type ConnectCause = 'initial' | 'proactive_refresh' | 'auth_401_recovery'
```

用于遥测区分 WebSocket 连接的触发原因。

## 配置项与默认值

### GrowthBook 特性开关

- **`tengu_bridge_repl_v2`**：v2 路径总开关，在 `initReplBridge.ts` 中判断
- **`tengu_bridge_repl_v2_config`**：v2 路径的完整配置对象（EnvLessBridgeConfig），通过 `getEnvLessBridgeConfig()` 读取
- **`tengu_bridge_min_version`**：v1 路径最低版本（独立于 v2 的 `min_version`）
- **`tengu_bridge_poll_interval_config`**：v1 轮询间隔配置（PollIntervalConfig）
- **`tengu_bridge_initial_history_cap`**：初始历史消息刷新上限（默认 200）

### 环境变量

- **`CLAUDE_BRIDGE_USE_CCR_V2`**：v1 路径内部强制使用 CCR v2 传输（ant-dev 覆盖）
- **`CLAUDE_BRIDGE_BASE_URL`**：开发环境下覆盖 `/bridge` 请求的基础 URL
- **`USER_TYPE=ant`**：启用内部调试功能（fault injection、SIGUSR2 重连、/bridge-kick）

### v1 轮询错误恢复常量

```typescript
const POLL_ERROR_INITIAL_DELAY_MS = 2_000   // 首次退避
const POLL_ERROR_MAX_DELAY_MS = 60_000      // 最大退避
const POLL_ERROR_GIVE_UP_MS = 15 * 60 * 1000 // 15 分钟后放弃
```

> 源码位置：`src/bridge/replBridge.ts:244-246`

## 消息去重机制

两套路径共享相同的三层去重策略：

1. **`initialMessageUUIDs`**（Set）：初始历史消息的 UUID，防止通过 `writeMessages()` 重复发送
2. **`recentPostedUUIDs`**（BoundedUUIDSet，容量 2000）：最近发送的消息 UUID 环形缓冲区，用于回声过滤（服务端将发送的消息回弹到 SSE 流）
3. **`recentInboundUUIDs`**（BoundedUUIDSet，容量 2000）：最近接收的入站消息 UUID，防止序列号协商边界场景下的重复转发

初始消息同时种入 `initialMessageUUIDs` 和 `recentPostedUUIDs`——后者是有限容量的环形缓冲区，大量写入后可能驱逐初始 UUID，前者作为无限兜底。

### FlushGate 写入排序

`FlushGate<Message>` 在初始历史刷新期间缓冲实时写入，确保服务端接收顺序为 `[history..., live...]`。`flushGate.start()` 在传输连接前激活；历史刷新完成后 `drainFlushGate()` 排空缓冲。

## 边界 Case 与注意事项

### epoch 一致性（v2）

每次调用 `/bridge` 都会在服务端递增 epoch。重建传输时必须使用新 epoch——否则旧 CCRClient 的心跳会在 20s 内触发 409。`authRecoveryInFlight` 标志防止主动刷新和 401 恢复同时调用 `/bridge` 导致双重 epoch 递增。

### 笔记本合盖恢复

- **v1**：at-capacity sleep 超时检测（overrun > 60s → `suspensionDetected`），强制一次快速轮询；WebSocket 10s ping 是短暂挂起的主要检测器
- **v2**：醒来后主动刷新定时器和 SSE 401 近乎同时触发，`authRecoveryInFlight` 保证只执行一次恢复

### gracefulShutdown 2s 预算

`gracefulShutdown` 在 2s 内跑完所有 cleanup 函数。v2 归档超时默认 1.5s（`teardown_archive_timeout_ms`，上限 2000ms）。v1 的 stopWork + archiveSession 并行执行以压缩耗时。结果消息在归档前发送——归档延迟（100-500ms）作为 POST drain 窗口。

### perpetual 模式（v1）

daemon 调用方使用的持久模式。teardown 时**不发送结果、不调用 stopWork、不关闭传输**——仅停止轮询，让 socket 随进程死亡。服务端的工作项租约 TTL（300s）自动回收。下次启动时读取 `bridgePointer` 恢复。小时级 pointer mtime 刷新防止 >4h 会话的指针过期。

### v1/v2 认证差异

- **v1 HybridTransport**：使用 OAuth token（标准 refresh 流程处理过期），WebSocket 和 POST 都用 OAuth
- **v1 CCR v2 传输**：使用工作项中的 JWT（register_worker 校验 session_id claim），JWT 过期时服务端重新分发工作项
- **v2 路径**：使用 `/bridge` 返回的 JWT，主动调度刷新

### 配置校验的防御性设计

`envLessBridgeConfig.ts` 的 Zod schema 对每个字段设置了 min/max 约束。违反任一约束时**整个对象回退到默认值**（而非部分信任），与 pollConfig.ts 的策略一致。特别地，`token_refresh_buffer_ms` 的 max 30 分钟上限防止运维人员混淆 "到期前缓冲" 和 "刷新延迟" 的语义。

> 源码位置：`src/bridge/envLessBridgeConfig.ts:60-117`

### Session ID 标签兼容

会话 ID 存在两种形式：`session_*`（v1 API 返回）和 `cse_*`（基础设施层 ID）。`sameSessionId()` 和 `toCompatSessionId()` / `toInfraSessionId()` 处理两者之间的转换。归档请求必须使用 `session_*` 形式（compat 层校验）；CCR v2 的 `/worker/*` 端点需要 `cse_*` 形式。