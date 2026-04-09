# Analytics（codex-analytics）

## 概述与职责

`codex-analytics` 是 Codex 可观测性（Observability）层的核心组件，负责采集和上报使用行为分析事件。它属于 **Observability** 模块组，与 OpenTelemetry 分布式追踪、用户反馈提交一起，共同构成 Codex 的可观测性基础设施。同级兄弟模块还包括 tracing 和 feedback 相关组件。

该 crate 采用**生产者-消费者**架构：业务代码通过 `AnalyticsEventsClient` 将"事实"（Fact）入队到异步 mpsc channel，后台 tokio 任务中的 `AnalyticsReducer` 将事实归约为结构化的 `TrackEventRequest`，再经 HTTP POST 发送到 ChatGPT 分析后端。

## 关键流程

### 事件采集与上报完整流程

1. **业务调用入口**：上层模块（Core、AppServer 等）持有 `AnalyticsEventsClient` 实例，调用 `track_*` 系列方法记录事件
2. **前置过滤**：`record_fact()` 检查 `analytics_enabled` 标志；若为 `Some(false)` 则直接丢弃（`src/client.rs:210-215`）
3. **去重判定**（仅 app-used 和 plugin-used 事件）：通过 `should_enqueue_app_used()` / `should_enqueue_plugin_used()` 使用 `(turn_id, connector_id/plugin_id)` 作为复合键，在同一个 turn 内去重（`src/client.rs:69-100`）
4. **入队**：`try_send()` 将 `AnalyticsFact` 写入容量为 256 的 mpsc channel；若队列已满则丢弃并记录 warning 日志（`src/client.rs:62-67`）
5. **归约**：后台 tokio 任务从 channel 读取 Fact，调用 `AnalyticsReducer::ingest()` 将原始事实转换为 `TrackEventRequest`（`src/reducer.rs:49-96`）
6. **HTTP 上报**：`send_track_events()` 获取 ChatGPT 认证 token，向 `{base_url}/codex/analytics-events/events` 发送 JSON payload，超时时间 10 秒（`src/client.rs:225-272`）

### Reducer 归约逻辑

`AnalyticsReducer` 是一个有状态的处理器，内部维护 `connections: HashMap<u64, ConnectionState>` 来缓存每个连接的客户端元数据和运行时信息。

不同类型的 Fact 归约行为如下：

| Fact 类型 | 归约行为 |
|-----------|---------|
| `Initialize` | 缓存 `ConnectionState`（客户端信息 + 运行时元数据），不产出事件 |
| `Response`（ThreadStart/Resume/Fork） | 结合已缓存的连接信息产出 `codex_thread_initialized` 事件；若对应连接未 Initialize 则跳过 |
| `Request` / `Notification` | 当前为空操作（预留扩展） |
| `SkillInvoked` | 解析技能路径、查询 git 信息、生成 SHA1 skill_id，产出 `skill_invocation` 事件 |
| `AppMentioned` | 每个 mention 产出一条 `codex_app_mentioned` 事件 |
| `AppUsed` | 产出 `codex_app_used` 事件 |
| `PluginUsed` | 产出 `codex_plugin_used` 事件 |
| `PluginStateChanged` | 根据状态产出 `codex_plugin_installed/uninstalled/enabled/disabled` 事件 |

### 线程初始化事件的两阶段模式

线程初始化事件的产出需要**两个前置条件**同时满足：

1. 该 `connection_id` 已通过 `Initialize` Fact 注册了客户端元数据
2. 收到包含 `ThreadStart`、`ThreadResume` 或 `ThreadFork` 的 `Response` Fact

只有两者都具备，才会产出 `codex_thread_initialized` 事件。这保证了事件中的 `app_server_client` 和 `runtime` 字段始终可用。

### Skill ID 生成

`skill_id_for_local_skill()` 为本地技能生成唯一标识（`src/reducer.rs:265-281`）：

- 路径归一化：仓库内技能使用相对路径，用户/系统级技能使用绝对路径
- ID 构造：`{prefix}_{path}_{skill_name}`，其中 prefix 为 `repo_{url}` 或 `personal`
- 最终取 SHA1 哈希作为 skill_id

### 去重机制

`app-used` 和 `plugin-used` 事件在**入队前**进行 per-turn 去重（`src/client.rs:69-100`）：

- 去重键：`(turn_id, connector_id)` 或 `(turn_id, plugin_id)`
- 存储在 `Arc<Mutex<HashSet>>` 中，多个 `AnalyticsEventsClient` clone 共享
- 当 HashSet 条目达到 4096 上限时整体清空，防止无限增长
- 无 `connector_id` 的 app-used 事件不参与去重，始终入队

## 公开 API

### `AnalyticsEventsClient`

主入口结构体，通过 `Clone` 可在多个模块间共享。

```rust
// src/client.rs:103-113
pub fn new(
    auth_manager: Arc<AuthManager>,
    base_url: String,
    analytics_enabled: Option<bool>,
) -> Self
```

- `auth_manager`：认证管理器，用于获取 ChatGPT access token
- `base_url`：分析后端 URL 前缀
- `analytics_enabled`：`Some(false)` 时禁用所有事件采集；`None` 或 `Some(true)` 时启用

#### track 方法一览

| 方法 | 用途 | 去重 |
|------|------|------|
| `track_initialize()` | 记录连接初始化（客户端信息、RPC 传输方式） | 否 |
| `track_response()` | 记录服务端响应（线程生命周期） | 否 |
| `track_skill_invocations()` | 记录技能调用（支持批量） | 否 |
| `track_app_mentioned()` | 记录 app 被提及（支持批量） | 否 |
| `track_app_used()` | 记录 app 被使用 | **是**（per-turn + connector_id） |
| `track_plugin_used()` | 记录插件被使用 | **是**（per-turn + plugin_id） |
| `track_plugin_installed()` | 记录插件安装 | 否 |
| `track_plugin_uninstalled()` | 记录插件卸载 | 否 |
| `track_plugin_enabled()` | 记录插件启用 | 否 |
| `track_plugin_disabled()` | 记录插件禁用 | 否 |

### `TrackEventsContext`

每个事件所需的上下文信息（`src/facts.rs:14-18`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `model_slug` | `String` | 当前使用的模型标识 |
| `thread_id` | `String` | 会话线程 ID |
| `turn_id` | `String` | 当前对话轮次 ID |

通过 `build_track_events_context()` 便捷构造。

### `AppServerRpcTransport`

标识 AppServer 的 RPC 传输方式（`src/events.rs:12-16`）：

- `Stdio` — 标准输入输出
- `Websocket` — WebSocket 连接
- `InProcess` — 进程内调用

### `SkillInvocation` / `AppInvocation` / `InvocationType`

描述技能调用和 App 调用的数据结构，从 `lib.rs` 公开导出供上层模块使用。

## 接口/类型定义

### `AnalyticsFact`（内部枚举）

所有分析事实的统一表示（`src/facts.rs:54-75`）：

- `Initialize` — 连接初始化信息
- `Request` — 客户端请求（当前未处理）
- `Response` — 服务端响应（触发线程初始化事件）
- `Notification` — 服务端通知（当前未处理）
- `Custom(CustomAnalyticsFact)` — 自定义事实，包含 SkillInvoked、AppMentioned、AppUsed、PluginUsed、PluginStateChanged

### `TrackEventRequest`（内部枚举）

序列化为 JSON 的事件载荷（`src/events.rs:33-43`），使用 `#[serde(untagged)]` 实现扁平化 JSON 输出。包含 9 种事件变体，每种变体都有对应的 `event_type` 字段标识。

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|---|------|
| `ANALYTICS_EVENTS_QUEUE_SIZE` | 256 | mpsc channel 容量 |
| `ANALYTICS_EVENTS_TIMEOUT` | 10 秒 | HTTP 请求超时 |
| `ANALYTICS_EVENT_DEDUPE_MAX_KEYS` | 4096 | 去重 HashSet 上限，超出后清空重建 |

事件仅在 ChatGPT 认证（`auth.is_chatgpt_auth() == true`）时上报；API Key 认证不会触发上报。

## 边界 Case 与注意事项

- **队列满时丢弃事件**：`try_send()` 使用非阻塞发送，队列满时记录 `warn` 日志并丢弃事件，不会阻塞业务流程
- **去重集合溢出保护**：HashSet 达到 4096 条目后整体清空（`src/client.rs:81-83`），可能导致短暂的重复事件，但保证了内存不会无限增长
- **仅 ChatGPT 认证上报**：`send_track_events()` 在非 ChatGPT 认证或 token 获取失败时静默返回，不报错
- **Initialize 顺序依赖**：`ingest_response()` 需要对应的 `connection_id` 已经 Initialize，否则静默跳过线程初始化事件
- **异步 skill ID 生成**：`ingest_skill_invoked()` 是 `async` 方法，因为需要调用 `collect_git_info()` 获取仓库 URL
- **Poison lock 容忍**：Mutex 中毒时通过 `into_inner` 恢复，保证不 panic（`src/client.rs:80`）