# 传输层抽象与消息处理（Transport）

## 概述与职责

Transport 模块是 **Bridge** 子系统的传输核心，位于 `BridgeAndRemote > Bridge` 层级中。它为远程控制（Remote Control）模式提供统一的消息收发抽象，屏蔽 v1（WebSocket）和 v2（SSE + HTTP POST）两种底层传输协议的差异，并处理入站消息的解析、去重、规范化和附件下载。

在整体架构中，Bridge 模块实现了 Remote Control 的主体逻辑，而 Transport 作为其传输基础设施，与同级的 RemoteSession（远程 CCR 会话管理）、DirectConnect（直连会话）和 UpstreamProxy（上游代理）协同工作。

本模块由 5 个文件组成，各司其职：

| 文件 | 职责 |
|------|------|
| `replBridgeTransport.ts` | 定义 `ReplBridgeTransport` 统一接口，提供 v1/v2 工厂函数 |
| `bridgeMessaging.ts` | 入站消息路由、回声去重、控制请求处理 |
| `inboundMessages.ts` | 入站用户消息字段提取与图片块规范化 |
| `inboundAttachments.ts` | 解析并下载 web 端上传的文件附件 |
| `flushGate.ts` | 历史消息 flush 阶段的队列状态机 |

## 关键流程

### 1. 传输层创建与连接

replBridge 启动时根据协议版本选择工厂函数创建传输实例：

**v1 路径** — `createV1ReplTransport(hybrid)` (`replBridgeTransport.ts:78-103`)：
1. 接收一个已有的 `HybridTransport`（WebSocket 读 + HTTP POST 写）
2. 用薄包装器适配为 `ReplBridgeTransport` 接口
3. v1 特有字段返回空操作：`getLastSequenceNum()` 返回 0，`reportState/reportMetadata/reportDelivery` 均为 no-op

**v2 路径** — `createV2ReplTransport(opts)` (`replBridgeTransport.ts:119-370`)：
1. 配置认证头——支持 `getAuthToken` 闭包（多会话安全）或 fallback 到进程级环境变量
2. 注册 worker：如果 `opts.epoch` 已提供则跳过，否则调用 `registerWorker()` 获取 epoch
3. 构造 SSE 流 URL（`/worker/events/stream`），创建 `SSETransport` 实例用于读取入站事件
4. 创建 `CCRClient` 实例用于写入出站事件（通过 `SerialBatchEventUploader` 批量上传）
5. 配置 epoch 冲突处理器——收到 409 时关闭资源并通过 `onClose(4090)` 通知上层
6. 重写 `sse.setOnEvent`，在收到每个 SSE 事件时同时 ACK `received` 和 `processed`，防止服务端重连时重放历史消息
7. `connect()` 被调用时：并行启动 SSE 读流（fire-and-forget）和 CCR 初始化，初始化完成后触发 `onConnectCb`

### 2. 入站消息路由

当传输层收到数据时，`handleIngressMessage()` (`bridgeMessaging.ts:132-208`) 执行以下路由：

1. JSON 解析并调用 `normalizeControlMessageKeys()` 兼容键名
2. **control_response** → 直接转发给权限响应回调（如 `onPermissionResponse`）
3. **control_request** → 转发给服务端控制请求处理器（需在 10-14 秒内响应，否则服务端断开连接）
4. **普通 SDKMessage** → 执行双层去重：
   - `recentPostedUUIDs`：过滤自身发出消息的回声
   - `recentInboundUUIDs`：过滤重复投递（如传输切换后服务端重放历史）
5. 仅 `type === 'user'` 的消息被转发给 `onInboundMessage` 回调，其他类型被忽略

### 3. 用户消息规范化

入站用户消息经过两步规范化处理：

**字段提取** — `extractInboundMessageFields()` (`inboundMessages.ts:21-40`)：
- 过滤非 user 类型和空内容消息
- 提取 `content`（字符串或 `ContentBlockParam[]`）和 `uuid`

**图片块修正** — `normalizeImageBlocks()` (`inboundMessages.ts:52-73`)：
- iOS/web 客户端可能发送 camelCase 的 `mediaType` 而非 snake_case 的 `media_type`
- 缺失 `media_type` 会导致后续所有 API 调用失败（"media_type: Field required"）
- 快速路径优化：先用 `Array.some()` 扫描，无问题时返回原始数组引用（零分配）
- 修正时通过 `detectImageFormatFromBase64()` 从 Base64 数据推断格式

### 4. 文件附件下载

当 web 端 composer 上传文件时，消息中包含 `file_attachments` 数组。`resolveAndPrepend()` (`inboundAttachments.ts:167-175`) 一站式处理：

1. **提取** — `extractInboundAttachments()` 使用 Zod schema 验证 `file_attachments` 字段，提取 `{file_uuid, file_name}` 数组
2. **下载** — `resolveOne()` 对每个附件：
   - 通过 OAuth token 调用 `GET /api/oauth/files/{uuid}/content` 下载文件（30 秒超时）
   - 文件名经过 `sanitizeFileName()` 过滤路径遍历和特殊字符
   - 写入 `~/.claude/uploads/{sessionId}/{prefix}-{safeName}`，prefix 取 UUID 前 8 位避免碰撞
3. **注入** — `prependPathRefs()` 将下载路径以 `@"path"` 格式注入消息内容的**最后一个**文本块前（因为 `processUserInputBase` 从最后一个块读取 `inputString`）

全过程 best-effort：任何步骤失败仅记录日志，不阻断消息投递。

### 5. 历史消息 Flush 状态机

`FlushGate<T>` (`flushGate.ts:16-71`) 解决会话启动时的消息交错问题：

```
start() ──→ [flush 进行中: enqueue() 返回 true，新消息入队]
              │
end()   ──→ [flush 完成: 返回已排队项，enqueue() 返回 false]
              │
drop()  ──→ [传输永久关闭: 丢弃队列]
              │
deactivate() → [传输替换: 清除 active 标志但保留队列项供新传输排出]
```

状态转换：
- `start()` → 激活门控，后续新消息被缓存
- `end()` → 关闭门控，返回所有缓存消息供调用方一次性发送
- `drop()` → 丢弃所有缓存（传输永久关闭时使用）
- `deactivate()` → 仅清除 active 标志但保留缓存项——用于传输替换场景，新传输会排出这些消息

## 函数签名

### `ReplBridgeTransport`（接口）

> 源码位置：`src/bridge/replBridgeTransport.ts:23-70`

| 方法 | 说明 |
|------|------|
| `write(message: StdoutMessage): Promise<void>` | 发送单条消息 |
| `writeBatch(messages: StdoutMessage[]): Promise<void>` | 批量发送消息 |
| `close(): void` | 关闭传输 |
| `connect(): void` | 建立连接 |
| `isConnectedStatus(): boolean` | 写入就绪状态 |
| `getStateLabel(): string` | 调试用状态字符串 |
| `setOnData(callback): void` | 注册入站数据回调 |
| `setOnClose(callback): void` | 注册关闭回调 |
| `setOnConnect(callback): void` | 注册连接成功回调 |
| `getLastSequenceNum(): number` | SSE 序列号高水位（v1 返回 0） |
| `droppedBatchCount: number` | 丢弃批次计数（v2 返回 0） |
| `reportState(state): void` | 上报 worker 状态（v2 only） |
| `reportMetadata(metadata): void` | 上报外部元数据（v2 only） |
| `reportDelivery(eventId, status): void` | 上报事件投递状态（v2 only） |
| `flush(): Promise<void>` | 排空写入队列（v2 only） |

### `createV1ReplTransport(hybrid: HybridTransport): ReplBridgeTransport`

v1 适配器工厂。将 `HybridTransport` 包装为 `ReplBridgeTransport`，v2 专有方法为 no-op。

> 源码位置：`src/bridge/replBridgeTransport.ts:78-103`

### `createV2ReplTransport(opts): Promise<ReplBridgeTransport>`

v2 适配器工厂。组合 `SSETransport`（读）+ `CCRClient`（写），包含 worker 注册、epoch 管理、心跳配置。

关键参数：
- `sessionUrl` — CCR 会话 URL
- `ingressToken` — JWT 认证令牌
- `initialSequenceNum` — SSE 序列号续传起点，避免服务端从 seq 0 重放
- `epoch` — worker epoch（若由 `/bridge` 响应提供则跳过 `registerWorker`）
- `outboundOnly` — 仅激活写路径，不打开 SSE 读流
- `getAuthToken` — 多会话安全的认证令牌来源

> 源码位置：`src/bridge/replBridgeTransport.ts:119-370`

### `handleIngressMessage(data, recentPostedUUIDs, recentInboundUUIDs, onInboundMessage, onPermissionResponse?, onControlRequest?): void`

入站消息路由器。解析 JSON，区分 control_response / control_request / SDKMessage，执行 UUID 去重后转发。

> 源码位置：`src/bridge/bridgeMessaging.ts:132-208`

### `handleServerControlRequest(request, handlers): void`

处理服务端控制请求（`initialize`、`set_model`、`interrupt`、`set_permission_mode`、`set_max_thinking_tokens`），构造相应的 `control_response` 并通过传输发回。

> 源码位置：`src/bridge/bridgeMessaging.ts:243-391`

### `extractInboundMessageFields(msg: SDKMessage)`

从入站 SDKMessage 提取 `content` 和 `uuid`，同时规范化图片块的 `media_type` 字段。

> 源码位置：`src/bridge/inboundMessages.ts:21-40`

### `resolveAndPrepend(msg, content): Promise<string | Array<ContentBlockParam>>`

一站式附件处理：提取附件 → 下载文件 → 将 `@"path"` 引用注入消息内容。

> 源码位置：`src/bridge/inboundAttachments.ts:167-175`

## 接口/类型定义

### `BoundedUUIDSet`

> 源码位置：`src/bridge/bridgeMessaging.ts:429-461`

基于循环缓冲区的 FIFO 有界集合，用于消息去重。当容量满时自动淘汰最老的条目，内存使用恒定为 O(capacity)。

| 方法 | 说明 |
|------|------|
| `add(uuid: string)` | 添加 UUID，满时淘汰最老条目 |
| `has(uuid: string): boolean` | 检查 UUID 是否存在 |
| `clear()` | 清空集合 |

Bridge 使用两个独立的 `BoundedUUIDSet` 实例：
- `recentPostedUUIDs` — 记录自己发出的消息 UUID，过滤服务端的回声
- `recentInboundUUIDs` — 记录已处理的入站消息 UUID，防止传输切换后的重复投递

### `ServerControlRequestHandlers`

> 源码位置：`src/bridge/bridgeMessaging.ts:212-229`

控制请求处理器的回调集合：

| 字段 | 类型 | 说明 |
|------|------|------|
| `transport` | `ReplBridgeTransport \| null` | 当前传输实例 |
| `sessionId` | `string` | 会话 ID |
| `outboundOnly` | `boolean?` | 仅出站模式，可变请求返回错误 |
| `onInterrupt` | `() => void` | 中断回调 |
| `onSetModel` | `(model) => void` | 模型切换回调 |
| `onSetMaxThinkingTokens` | `(maxTokens) => void` | 思考 token 上限回调 |
| `onSetPermissionMode` | `(mode) => result` | 权限模式切换回调，返回 `{ok, error?}` |

### `InboundAttachment`

> 源码位置：`src/bridge/inboundAttachments.ts:39`

```typescript
{ file_uuid: string; file_name: string }
```

### `FlushGate<T>`

> 源码位置：`src/bridge/flushGate.ts:16-71`

泛型队列状态机，属性 `active`（是否正在 flush）和 `pendingCount`（队列长度）。

## 配置项与默认值

| 配置 | 位置 | 默认值 | 说明 |
|------|------|--------|------|
| `heartbeatIntervalMs` | `createV2ReplTransport` opts | 20000 (20s) | CCRClient 心跳间隔 |
| `heartbeatJitterFraction` | `createV2ReplTransport` opts | 0 | 心跳抖动比例 |
| `DOWNLOAD_TIMEOUT_MS` | `inboundAttachments.ts:25` | 30000 (30s) | 附件下载超时 |
| 上传目录 | `inboundAttachments.ts:60-62` | `~/.claude/uploads/{sessionId}/` | 附件本地存储路径 |

## 边界 Case 与注意事项

- **Epoch 冲突（409）**：v2 传输收到 409 时通过 `onEpochMismatch` 关闭自身并触发 `onClose(4090)`，replBridge 的 poll loop 会用新 epoch 重新创建传输。自定义关闭码 4090（epoch 冲突）、4091（初始化失败）、4092（SSE 重连预算耗尽）用于遥测区分
- **回声去重是二级保护**：主去重依赖外部的 `lastWrittenIndexRef` 顺序索引，`BoundedUUIDSet` 是安全网，处理时序竞争和传输切换等边缘场景
- **v2 写路径走 CCRClient 而非 SSETransport**：`SSETransport.write()` 的 POST URL 格式是 Session-Ingress 的，与 CCR v2 的 `/worker/*` 路径不兼容
- **图片块 camelCase 问题**：iOS/web 客户端发送 `mediaType` 而非 `media_type`，若不修正会导致**整个会话**后续所有 API 调用失败
- **附件路径注入位置**：`@"path"` 引用必须注入**最后一个**文本块，因为 `processUserInputBase` 从 `processedBlocks` 末尾读取 `inputString`
- **outboundOnly 模式**：仅激活写路径，所有可变控制请求（除 `initialize`）返回错误。用于 mirror-mode 附件转发和 SDK 的 `/bridge` 子路径
- **附件下载 best-effort**：网络错误、无 OAuth token、非 200 响应均不阻断消息投递，仅跳过该附件并记录日志
- **FlushGate.deactivate() vs drop()**：传输替换时用 `deactivate()` 保留队列项供新传输排出；传输永久关闭时用 `drop()` 丢弃