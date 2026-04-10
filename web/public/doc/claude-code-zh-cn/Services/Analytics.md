# Analytics 模块

## 概述与职责

Analytics 模块是 Claude Code 的**遥测、事件日志和特性开关服务**，位于 `src/services/analytics/` 目录下，属于 Services 层的横切关注点，被多个模块（CoreEngine、TerminalUI、ToolSystem 等）依赖。

该模块承担四项核心职责：

1. **事件日志记录**：提供统一的 `logEvent` / `logEventAsync` API，将事件路由到 Datadog 和第一方（1P）事件日志两个后端
2. **特性门控与远程配置**：集成 GrowthBook SDK，实现特性开关（feature gate）和动态配置（dynamic config），支持 A/B 实验
3. **Killswitch 机制**：通过 GrowthBook 远程配置实现按 sink 粒度的紧急关停
4. **分析元数据管理**：收集运行环境、进程指标、Agent 身份等上下文信息，以统一格式附加到每个事件

模块由 9 个文件组成，设计上 `index.ts` 作为零依赖的公共 API 入口（避免循环引用），其余文件在启动时通过 sink 机制挂载。

## 关键流程

### 事件日志的完整生命周期

1. **调用者发起事件**：业务代码调用 `logEvent(eventName, metadata)`（`src/services/analytics/index.ts:133-144`）
2. **队列缓冲**：若 sink 尚未初始化，事件被推入 `eventQueue` 数组暂存
3. **Sink 挂载**：应用启动时调用 `initializeAnalyticsSink()`（`sink.ts:109-114`），将 `logEventImpl` 注册为 sink 实现
4. **队列排空**：`attachAnalyticsSink()` 通过 `queueMicrotask` 异步排空已缓冲的事件（`index.ts:102-122`），不阻塞启动路径
5. **采样决策**：`shouldSampleEvent()` 从 GrowthBook 动态配置 `tengu_event_sampling_config` 读取每事件的采样率，决定是否丢弃事件（`firstPartyEventLogger.ts:57-85`）
6. **路由分发**（`sink.ts:48-72`）：
   - **Datadog**：调用 `trackDatadogEvent()`，先通过 `stripProtoFields()` 剥离 `_PROTO_*` 键（PII 标记字段），再发送
   - **1P 事件日志**：调用 `logEventTo1P()`，保留完整 payload（含 `_PROTO_*` 键），由 exporter 将其提升为 proto 字段

### GrowthBook 特性门控流程

1. **客户端创建**：`getGrowthBookClient()` 使用 `remoteEval: true` 模式创建 GrowthBook 实例（`growthbook.ts:526-545`），由服务端预计算特性值
2. **初始化与缓存**：`initializeGrowthBook()` 等待 HTTP 初始化完成，调用 `processRemoteEvalPayload()` 解析服务端响应并填充内存缓存 `remoteEvalFeatureValues`（`growthbook.ts:327-394`）
3. **磁盘持久化**：`syncRemoteEvalToDisk()` 将特性值写入 `~/.claude.json` 的 `cachedGrowthBookFeatures` 字段（`growthbook.ts:407-417`），供下次启动冷读
4. **值读取**：
   - 热路径使用 `getFeatureValue_CACHED_MAY_BE_STALE()`（`growthbook.ts:734-775`）：先查内存 Map → 再查磁盘缓存 → 最后返回默认值
   - 安全关键路径使用 `checkSecurityRestrictionGate()`（`growthbook.ts:851-889`）：等待重初始化完成以获取最新值
5. **定期刷新**：`setupPeriodicGrowthBookRefresh()` 每 6 小时（ant 用户 20 分钟）轻量刷新特性值，通过 `refreshed` signal 通知订阅者（`growthbook.ts:1087-1110`）

### Datadog 事件发送流程

1. **门控检查**：`shouldTrackDatadog()` 检查 `tengu_log_datadog_events` 特性门和 killswitch 状态（`sink.ts:29-43`）
2. **环境过滤**：仅在 `production` 环境且使用 `firstParty` API provider 时发送（`datadog.ts:164-170`）
3. **事件白名单**：只发送 `DATADOG_ALLOWED_EVENTS` 集合中的事件（约 40 种），覆盖 API 调用、OAuth、工具使用等（`datadog.ts:19-64`）
4. **元数据富化**：调用 `getEventMetadata()` 获取环境上下文，附加用户桶（hash 分桶，30 桶）、模型名规范化、版本号截断等处理（`datadog.ts:182-263`）
5. **批量发送**：事件先推入 `logBatch` 数组，达到 100 条或 15 秒定时器触发后通过 HTTP POST 发送到 Datadog Logs API（`datadog.ts:98-128`）

### 1P 事件日志发送流程

1. **OpenTelemetry 管线**：`initialize1PEventLogging()` 创建独立的 `LoggerProvider`（与客户 OTLP 遥测隔离），配置 `BatchLogRecordProcessor` + `FirstPartyEventLoggingExporter`（`firstPartyEventLogger.ts:312-389`）
2. **事件发射**：`logEventTo1PAsync()` 将事件及元数据封装为 OTel log record，通过 `logger.emit()` 提交给批处理器（`firstPartyEventLogger.ts:156-207`）
3. **批量导出**：`FirstPartyEventLoggingExporter.export()` 将 OTel log record 转换为 `ClaudeCodeInternalEvent` 或 `GrowthbookExperimentEvent` proto 格式（`firstPartyEventLoggingExporter.ts:635-762`）
4. **HTTP 发送与重试**：通过 `sendBatchWithRetry()` 发送到 `/api/event_logging/batch` 端点，支持认证降级（401 时回退到无认证发送）（`firstPartyEventLoggingExporter.ts:527-615`）
5. **失败恢复**：失败事件以 JSONL 格式追加写入 `~/.claude/telemetry/` 目录，使用二次退避（quadratic backoff）重试，最多 8 次（`firstPartyEventLoggingExporter.ts:445-517`）

## 函数签名与参数说明

### 公共 API（`index.ts`）

#### `logEvent(eventName: string, metadata: LogEventMetadata): void`

同步记录事件。metadata 的值类型限定为 `boolean | number | undefined`——**故意排除 string 类型**，防止意外记录代码片段或文件路径。

#### `logEventAsync(eventName: string, metadata: LogEventMetadata): Promise<void>`

异步记录事件。语义与 `logEvent` 相同，但因两个后端 sink（Datadog / 1P）均为 fire-and-forget，实际行为与同步版本一致。

#### `attachAnalyticsSink(newSink: AnalyticsSink): void`

挂载 analytics 后端 sink。**幂等**——已挂载时为 no-op。挂载后通过 `queueMicrotask` 异步排空事件队列。

#### `stripProtoFields<V>(metadata: Record<string, V>): Record<string, V>`

剥离所有 `_PROTO_*` 前缀的键。无此类键时直接返回原引用（零拷贝）。用于 Datadog 等通用后端，防止 PII 标记数据外泄。

### GrowthBook API（`growthbook.ts`）

#### `getFeatureValue_CACHED_MAY_BE_STALE<T>(feature: string, defaultValue: T): T`

**推荐使用**。同步读取特性值，优先级：环境变量覆盖 → config 覆盖 → 内存缓存 → 磁盘缓存 → 默认值。值可能来自上次进程的缓存。

#### `checkSecurityRestrictionGate(gate: string): Promise<boolean>`

安全关键门控。若 GrowthBook 正在重初始化，会等待完成后返回最新值。优先读 Statsig 缓存（迁移兼容）。

#### `checkGate_CACHED_OR_BLOCKING(gate: string): Promise<boolean>`

面向用户操作的门控。快路径：磁盘缓存为 `true` 时立即返回；慢路径：缓存为 `false` 时阻塞等待初始化获取最新值。

#### `getDynamicConfig_CACHED_MAY_BE_STALE<T>(configName: string, defaultValue: T): T`

读取动态配置（JSON 对象类型特性值的语义包装）。

#### `onGrowthBookRefresh(listener: () => void | Promise<void>): () => void`

注册特性值刷新回调。返回取消订阅函数。若注册时已有特性数据，会在下一个 microtask 立即触发一次回调。

### 元数据 API（`metadata.ts`）

#### `getEventMetadata(options?: EnrichMetadataOptions): Promise<EventMetadata>`

收集并返回所有事件共享的核心元数据：模型名、会话 ID、环境上下文（平台/架构/版本/CI 状态等）、进程指标（内存/CPU）、Agent 身份信息。

#### `sanitizeToolNameForAnalytics(toolName: string): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`

将 MCP 工具名（格式 `mcp__<server>__<tool>`）脱敏为 `'mcp_tool'`，保留内置工具名不变。

## 接口/类型定义

### `AnalyticsSink`（`index.ts:72-78`）

```typescript
type AnalyticsSink = {
  logEvent: (eventName: string, metadata: LogEventMetadata) => void
  logEventAsync: (eventName: string, metadata: LogEventMetadata) => Promise<void>
}
```

Analytics 后端的抽象接口，由 `sink.ts` 提供实现。

### `EventMetadata`（`metadata.ts:472-496`）

所有事件携带的核心元数据结构，包含：`model`、`sessionId`、`userType`、`envContext`（环境信息）、`processMetrics`（进程指标）、`agentId`/`agentType`/`teamName`（Agent 身份）、`subscriptionType`、`rh`（仓库远程 URL 哈希）等。

### `GrowthBookUserAttributes`（`growthbook.ts:32-47`）

发送给 GrowthBook 服务端用于特性定向的用户属性：`id`（设备 ID）、`sessionId`、`platform`、`organizationUUID`、`accountUUID`、`subscriptionType`、`email` 等。

### `SinkName`（`sinkKillswitch.ts:6`）

```typescript
type SinkName = 'datadog' | 'firstParty'
```

可独立关停的 sink 名称类型。

### `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`（`index.ts:19`）

类型为 `never` 的 marker type。强制开发者在记录字符串值时显式声明"我已验证此值不包含代码或文件路径"，通过 `as` 转型使用。这是编译期的隐私防护机制。

### `AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED`（`index.ts:33`）

类似 marker type，标记通过 `_PROTO_*` 键路由到受控 BQ 列的 PII 数据。

## 配置项与默认值

### 环境变量

| 变量 | 用途 | 默认值 |
|------|------|--------|
| `NODE_ENV` | `test` 时禁用全部 analytics | - |
| `CLAUDE_CODE_USE_BEDROCK` / `VERTEX` / `FOUNDRY` | 第三方云提供商模式，禁用 analytics | - |
| `USER_TYPE` | 设为 `ant` 时启用调试日志、缩短 GrowthBook 刷新间隔至 20 分钟 | - |
| `CLAUDE_INTERNAL_FC_OVERRIDES` | JSON 对象，覆盖 GrowthBook 特性值（仅 ant 用户） | - |
| `OTEL_LOG_TOOL_DETAILS` | 启用 MCP 工具名/技能名详细日志 | 禁用 |
| `CLAUDE_CODE_DATADOG_FLUSH_INTERVAL_MS` | 覆盖 Datadog 批量发送间隔 | 15000 |
| `OTEL_LOGS_EXPORT_INTERVAL` | 覆盖 1P 事件批处理间隔 | 10000 |

### GrowthBook 动态配置

| 配置名 | 用途 | 默认值 |
|--------|------|--------|
| `tengu_log_datadog_events` | 特性门，控制是否向 Datadog 发送事件 | false |
| `tengu_event_sampling_config` | 按事件名的采样率配置，格式 `{[eventName]: {sample_rate: 0-1}}` | `{}` |
| `tengu_frond_boric` | Killswitch 配置，`{datadog?: boolean, firstParty?: boolean}`，`true` 表示关停对应 sink | `{}` |
| `tengu_1p_event_batch_config` | 1P 事件批处理参数：`scheduledDelayMillis`、`maxExportBatchSize`、`maxQueueSize`、`skipAuth`、`maxAttempts`、`path`、`baseUrl` | 见代码默认值 |

### 关键常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `DEFAULT_FLUSH_INTERVAL_MS`（Datadog） | 15000 | Datadog 日志刷新间隔 |
| `MAX_BATCH_SIZE`（Datadog） | 100 | Datadog 单批最大事件数 |
| `DEFAULT_LOGS_EXPORT_INTERVAL_MS`（1P） | 10000 | 1P 事件 OTel 批处理器导出间隔 |
| `DEFAULT_MAX_EXPORT_BATCH_SIZE`（1P） | 200 | 1P 单批最大事件数 |
| `DEFAULT_MAX_QUEUE_SIZE`（1P） | 8192 | 1P 批处理器最大队列长度 |
| `NUM_USER_BUCKETS` | 30 | 用户 ID 哈希分桶数（Datadog 基数控制） |
| `GROWTHBOOK_REFRESH_INTERVAL_MS` | 6h / 20min(ant) | GrowthBook 定期刷新间隔 |

## 边界 Case 与注意事项

### 循环依赖防护

`index.ts` **不依赖任何其他模块**（见文件头注释）。这是核心设计约束——任何业务代码都可以安全 import `logEvent`，不会引入循环依赖。实际路由逻辑全部在 `sink.ts` 中实现，通过 `attachAnalyticsSink()` 延迟绑定。

### PII 泄露防护

- `logEvent` 的 metadata 类型排除了 `string` 类型值，从类型系统层面防止意外记录代码或路径
- `_PROTO_*` 前缀的键仅 1P exporter 可见，`stripProtoFields()` 在 Datadog 路径上剥离
- MCP 工具名默认脱敏为 `mcp_tool`，除非满足白名单条件（官方注册表 URL、claude.ai 代理、local-agent 模式）

### Killswitch 递归保护

`isSinkKilled()` 文档明确标注**不能在 `is1PEventLoggingEnabled()` 内部调用**——因为 `growthbook.ts:isGrowthBookEnabled()` 会调用 `is1PEventLoggingEnabled()`，在该路径上再调用 GrowthBook 查询会造成无限递归。Killswitch 仅在每事件分发时检查。

### GrowthBook SDK Workaround

当前 API 返回的特性值使用 `value` 字段而非 SDK 期望的 `defaultValue`（`growthbook.ts:346-356`）。模块通过 `processRemoteEvalPayload()` 进行字段转换，并额外维护 `remoteEvalFeatureValues` 内存缓存绕过 SDK 的本地重新求值逻辑。

### 1P Exporter 的容错设计

- **失败持久化**：导出失败的事件以 JSONL 追加写入磁盘（`~/.claude/telemetry/`），按 sessionId + batchUUID 隔离文件
- **二次退避重试**：delay = baseDelay × attempts²，上限 30 秒，最多 8 次尝试后丢弃
- **短路优化**：批量发送中某个 batch 失败后，剩余 batch 直接入队不再尝试发送
- **认证降级**：401 错误时自动回退到无认证发送（`firstPartyEventLoggingExporter.ts:593-614`）
- **Killswitch 生效时零网络**：`sendBatchWithRetry()` 检查 killswitch，激活时直接抛异常触发本地持久化

### 热重载配置

`reinitialize1PEventLoggingIfConfigChanged()` 监听 GrowthBook 刷新事件，当 `tengu_1p_event_batch_config` 变更时重建整个 OTel 管线。重建窗口期内的事件会被丢弃（`firstPartyEventLogger` 先置 null），但 `forceFlush()` 确保旧管线缓冲区已排空。