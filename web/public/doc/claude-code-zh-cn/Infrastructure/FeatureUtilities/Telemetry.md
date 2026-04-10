# 遥测数据收集与追踪框架（Telemetry）

## 概述与职责

Telemetry 模块是 Claude Code 的可观测性基础设施，负责收集、处理和导出应用运行时的指标（Metrics）、日志（Logs）和追踪（Traces）三类遥测信号。它位于 Infrastructure → FeatureUtilities 层级下，为上层所有子系统（CoreEngine、ToolSystem、TaskSystem 等）提供统一的遥测能力。

该模块由以下核心子组件组成：

| 文件 | 职责 |
|------|------|
| `instrumentation.ts` | OpenTelemetry SDK 初始化与生命周期管理 |
| `events.ts` | 遥测事件发送 API |
| `logger.ts` | OpenTelemetry 诊断日志适配器 |
| `sessionTracing.ts` | 会话级 Span 追踪（交互、LLM 请求、工具调用） |
| `betaSessionTracing.ts` | Beta 详细追踪（系统提示词、消息增量、工具输入输出） |
| `bigqueryExporter.ts` | BigQuery 指标导出器 |
| `perfettoTracing.ts` | Perfetto 性能分析数据生成（仅内部用户） |
| `pluginTelemetry.ts` | 插件生命周期遥测辅助函数 |
| `skillLoadedEvent.ts` | 技能加载事件记录 |
| `telemetryAttributes.ts` | 遥测属性构建（用户 ID、会话 ID、组织信息等） |

同级模块包括 ShellAndBash（Shell 执行）、GitOperations（Git 操作）、ConfigAndSettings（配置管理）等基础设施组件。

## 关键流程

### 1. 遥测初始化流程

应用启动时调用 `initializeTelemetry()`（`instrumentation.ts:421`），按以下步骤完成初始化：

1. **环境变量引导**：`bootstrapTelemetry()` 将内部 `ANT_OTEL_*` 变量映射到标准 `OTEL_*` 变量（仅限 `USER_TYPE=ant` 的内部用户）
2. **Console 导出器过滤**：在 stream-json 模式下剥离 console 导出器，防止 stdout 输出破坏 SDK 消息通道（`instrumentation.ts:432-447`）
3. **诊断日志注册**：设置 `ClaudeCodeDiagLogger` 为 OpenTelemetry 内部诊断器，仅记录 ERROR 级别
4. **Perfetto 追踪初始化**：独立于 OTEL，通过环境变量 `CLAUDE_CODE_PERFETTO_TRACE` 控制
5. **Metrics Provider 创建**：合并资源属性（服务名、版本、OS、架构），创建 `MeterProvider` 并注册导出器
6. **Logs Provider 创建**（需 `CLAUDE_CODE_ENABLE_TELEMETRY=1`）：创建 `LoggerProvider` 和事件 Logger
7. **Traces Provider 创建**（需额外启用 Enhanced Telemetry）：创建 `BasicTracerProvider`
8. **关闭钩子注册**：通过 `registerCleanup` 注册带超时保护的优雅关闭逻辑

初始化存在两条分支路径：
- **标准路径**：三信号（metrics/logs/traces）独立配置
- **Beta Tracing 路径**：当 `ENABLE_BETA_TRACING_DETAILED=1` 且 `BETA_TRACING_ENDPOINT` 已设置时，使用独立的端点发送 traces 和 logs，仅保留标准 metrics 管道

### 2. 会话追踪 Span 层级

`sessionTracing.ts` 实现了基于 OpenTelemetry Span 的层级追踪结构：

```
interaction (根 Span)
├── llm_request (LLM 请求)
│   └── [重试子 Span]
├── tool (工具调用)
│   ├── tool.blocked_on_user (等待用户权限确认)
│   └── tool.execution (工具实际执行)
└── hook (Hook 执行，仅 Beta Tracing)
```

**Span 上下文管理**使用 `AsyncLocalStorage`（`sessionTracing.ts:69-70`）：
- `interactionContext`：存储当前交互 Span，作为 LLM 请求和工具调用的父 Span
- `toolContext`：存储当前工具 Span，作为 blocked_on_user 和 execution 的父 Span

**内存管理**采用 WeakRef + 强引用双层机制（`sessionTracing.ts:71-75`）：
- 所有 Span 通过 `activeSpans` Map 以 `WeakRef` 持有
- 不在 ALS 中的 Span（LLM 请求、blocked-on-user、tool execution、hook）额外在 `strongSpans` 中持有强引用，防止 GC 过早回收
- 后台清理定时器每 60 秒清除超过 30 分钟的孤儿 Span（`sessionTracing.ts:100-120`）

### 3. 遥测事件发送流程

`events.ts` 提供 `logOTelEvent()` 函数，将业务事件通过 OpenTelemetry Log API 发送：

1. 获取已初始化的 `eventLogger`（由 `instrumentation.ts` 在初始化阶段设置）
2. 构建事件属性：基础遥测属性 + 事件名 + 时间戳 + 单调递增序列号 + prompt ID
3. 通过 `eventLogger.emit()` 发出 Log Record，body 格式为 `claude_code.{eventName}`

用户 prompt 内容受 `OTEL_LOG_USER_PROMPTS` 环境变量控制——默认被替换为 `<REDACTED>`（`events.ts:17-18`）。

### 4. BigQuery 指标导出流程

`BigQueryMetricsExporter`（`bigqueryExporter.ts:40`）实现 OpenTelemetry `PushMetricExporter` 接口：

1. **准入检查**：
   - 信任对话框是否已接受（交互模式）或非交互会话
   - 组织级 metrics opt-out 检查（`checkMetricsEnabled()`）
2. **数据转换**：将 OTEL `ResourceMetrics` 转换为 `InternalMetricsPayload`（资源属性 + 扁平化指标数据点）
3. **HTTP 发送**：通过 axios POST 到 `https://api.anthropic.com/api/claude_code/metrics`，携带认证 headers

导出间隔为 5 分钟（`instrumentation.ts:332`），聚合时间粒度固定为 **DELTA**（`bigqueryExporter.ts:246-251`），不可修改。

启用条件（`instrumentation.ts:336-347`）：
- 1P API 客户（非 Claude.ai 订阅者、非 Bedrock/Vertex）
- Claude for Enterprise (C4E) 用户
- Claude for Teams 用户

### 5. Perfetto 性能追踪

`perfettoTracing.ts` 生成 Chrome Trace Event 格式的性能数据，可在 `ui.perfetto.dev` 中可视化。**仅限内部用户**（通过 `feature('PERFETTO_TRACING')` 在构建时消除外部版本代码）。

追踪的事件类型：
- **Interaction**：用户交互周期
- **API Call**：LLM 请求，包含 TTFT（首 Token 时间）、TTLT（末 Token 时间）、ITPS/OTPS（吞吐量）、缓存命中率等子 Span
- **Tool**：工具执行
- **Waiting for User Input**：等待用户输入
- **Counter**：时间序列计数器

关键设计：
- 使用数字 `pid`/`tid` 标识 Agent 层级——主进程 pid=1，子 Agent 递增
- 元数据事件（进程名、线程名、父 Agent 关系）与普通事件分离存储，不受驱逐影响
- 事件数上限 100,000，超限时驱逐最旧的一半（`perfettoTracing.ts:232-247`）
- 支持定期写入（`CLAUDE_CODE_PERFETTO_WRITE_INTERVAL_S`）和退出时同步写入兜底

## 函数签名与参数说明

### `initializeTelemetry(): Promise<Meter>`

初始化整个遥测系统，返回 OpenTelemetry `Meter` 实例。应用启动时调用一次。

> 源码位置：`src/utils/telemetry/instrumentation.ts:421-701`

### `flushTelemetry(): Promise<void>`

立即刷新所有待发送的遥测数据。在用户登出或组织切换前调用，防止数据泄漏。超时默认 5 秒（`CLAUDE_CODE_OTEL_FLUSH_TIMEOUT_MS`）。

> 源码位置：`src/utils/telemetry/instrumentation.ts:707-747`

### `logOTelEvent(eventName: string, metadata?: Record<string, string | undefined>): Promise<void>`

发送命名遥测事件，自动附加会话 ID、用户 ID、序列号等基础属性。

> 源码位置：`src/utils/telemetry/events.ts:21-75`

### `startInteractionSpan(userPrompt: string): Span`

开始一个交互 Span（用户请求→Claude 响应的完整周期）。设置 `interactionContext`，作为后续所有 Span 的父节点。

> 源码位置：`src/utils/telemetry/sessionTracing.ts:176-235`

### `endLLMRequestSpan(span?: Span, metadata?: {...}): void`

结束 LLM 请求 Span，附加响应元数据（Token 数、TTFT、成功/失败状态等）。当存在并行请求时**必须传入具体的 span 参数**，否则可能错误匹配。

- `inputTokens` / `outputTokens`：输入/输出 Token 数
- `cacheReadTokens` / `cacheCreationTokens`：缓存读取/创建 Token 数
- `ttftMs`：首 Token 延迟（毫秒）
- `requestSetupMs`：请求建立耗时
- `attemptStartTimes`：各重试尝试的时间戳数组

> 源码位置：`src/utils/telemetry/sessionTracing.ts:353-464`

### `getTelemetryAttributes(): Attributes`

构建通用遥测属性字典，包含 `user.id`、`session.id`、`organization.id`、`user.email`、`terminal.type` 等。通过环境变量控制部分属性的包含/排除以管理指标基数。

> 源码位置：`src/utils/telemetryAttributes.ts:29-71`

## 接口/类型定义

### `SpanType`（`sessionTracing.ts:49-56`）

```typescript
type SpanType =
  | 'interaction'      // 用户交互周期
  | 'llm_request'      // LLM API 请求
  | 'tool'             // 工具调用
  | 'tool.blocked_on_user'  // 等待用户权限确认
  | 'tool.execution'   // 工具实际执行
  | 'hook'             // Hook 执行
```

### `LLMRequestNewContext`（`betaSessionTracing.ts:210-217`）

```typescript
interface LLMRequestNewContext {
  systemPrompt?: string    // 系统提示词
  querySource?: string     // Agent 标识（如 'repl_main_thread'）
  tools?: string           // 工具 Schema JSON
}
```

### `TraceEvent`（`perfettoTracing.ts:58-69`）

Chrome Trace Event 格式，包含 `name`、`cat`（类别）、`ph`（阶段类型）、`ts`（微秒时间戳）、`pid`/`tid`（进程/线程 ID）、`dur`（持续时间）、`args`（自定义参数）。

### `TelemetryPluginScope`（`pluginTelemetry.ts:66-70`）

```typescript
type TelemetryPluginScope = 'official' | 'org' | 'user-local' | 'default-bundle'
```

插件来源分类枚举，用于遥测数据中的插件归类。

## 配置项与默认值

### 核心开关

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | 启用 3P 遥测（logs/traces 导出） | 未设置（禁用） |
| `ENABLE_BETA_TRACING_DETAILED` | 启用 Beta 详细追踪 | 未设置（禁用） |
| `BETA_TRACING_ENDPOINT` | Beta 追踪端点 URL | 无 |
| `CLAUDE_CODE_PERFETTO_TRACE` | 启用 Perfetto 追踪（`1` 或自定义路径） | 未设置（禁用） |

### OTEL 导出配置

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `OTEL_METRICS_EXPORTER` | 指标导出器类型（`console`/`otlp`/`prometheus`） | 无 |
| `OTEL_LOGS_EXPORTER` | 日志导出器类型（`console`/`otlp`） | 无 |
| `OTEL_TRACES_EXPORTER` | 追踪导出器类型（`console`/`otlp`） | 无 |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | OTLP 协议（`grpc`/`http/json`/`http/protobuf`） | 无 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP 端点 URL | 无 |
| `OTEL_EXPORTER_OTLP_HEADERS` | OTLP 请求头（`key=value` 逗号分隔） | 无 |
| `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` | 指标时间粒度 | `delta` |

### 导出间隔与超时

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `OTEL_METRIC_EXPORT_INTERVAL` | 指标导出间隔（毫秒） | 60000 |
| `OTEL_LOGS_EXPORT_INTERVAL` | 日志导出间隔（毫秒） | 5000 |
| `OTEL_TRACES_EXPORT_INTERVAL` | 追踪导出间隔（毫秒） | 5000 |
| `CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS` | 关闭超时（毫秒） | 2000 |
| `CLAUDE_CODE_OTEL_FLUSH_TIMEOUT_MS` | 刷新超时（毫秒） | 5000 |

### 隐私控制

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `OTEL_LOG_USER_PROMPTS` | 是否记录用户 prompt 原文 | 禁用（替换为 `<REDACTED>`） |
| `OTEL_LOG_TOOL_CONTENT` | 是否记录工具输入/输出内容 | 禁用 |
| `OTEL_METRICS_INCLUDE_SESSION_ID` | 指标中包含 session ID | `true` |
| `OTEL_METRICS_INCLUDE_VERSION` | 指标中包含应用版本 | `false` |
| `OTEL_METRICS_INCLUDE_ACCOUNT_UUID` | 指标中包含账户 UUID | `true` |

## 边界 Case 与注意事项

- **Enhanced Telemetry 启用优先级**（`sessionTracing.ts:126-143`）：环境变量 > 内部用户自动启用 > GrowthBook 特性门控。环境变量 `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` 或 `ENABLE_ENHANCED_TELEMETRY_BETA` 可显式覆盖。

- **Beta Tracing 内容可见性差异**：外部用户看不到 thinking output（`betaSessionTracing.ts:430-442`），内部用户可以看到全部内容。所有内容截断到 60KB（Honeycomb 限制为 64KB）。

- **系统提示词去重**：`betaSessionTracing.ts` 使用 SHA-256 哈希跟踪已发送的系统提示词，同一会话内相同内容只完整发送一次（`betaSessionTracing.ts:267-281`）。

- **消息增量追踪**：Beta Tracing 按 `querySource`（Agent 标识）跟踪最后上报的消息哈希，只发送新增消息而非完整历史。上下文压缩后通过 `clearBetaTracingState()` 重置追踪状态。

- **BigQuery 聚合时间粒度**固定为 DELTA（`bigqueryExporter.ts:246-251`），代码注释明确警告不要修改，否则会破坏 CC Productivity 仪表盘的聚合逻辑。

- **OTLP 导出器懒加载**：gRPC、HTTP/JSON、HTTP/Protobuf 三种协议的导出器通过动态 `import()` 按需加载（`instrumentation.ts:169-172`），避免在启动时加载所有 ~1.2MB 的依赖。

- **关闭超时保护**：shutdown 过程中各 Provider 的 flush→shutdown 独立链式执行，避免慢速 Logger flush 阻塞 TracerProvider 关闭（`instrumentation.ts:541-556`）。

- **插件遥测隐私模式**（`pluginTelemetry.ts`）：用户自定义插件名通过"双列隐私模式"处理——原始名称写入 PII 标记列（`_PROTO_*`），公开列中非官方插件名替换为 `'third-party'`。`plugin_id_hash` 提供不依赖隐私策略的聚合键。

- **Perfetto 事件驱逐**：长时间运行的会话（如 cron 模式）中，事件数超过 100,000 时驱逐最旧的一半，并插入 `trace_truncated` 标记事件（`perfettoTracing.ts:232-247`）。

- **stream-json 模式兼容**：Console 导出器会向 stdout 输出 `{` 开头的 JSON 对象，在 SDK 消息通道模式下会破坏行读取器。`initializeTelemetry()` 在此模式下自动剥离 console 导出器（`instrumentation.ts:432-447`）。