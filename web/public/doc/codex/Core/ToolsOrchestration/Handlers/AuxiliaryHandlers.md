# 辅助工具处理器（AuxiliaryHandlers）

## 概述与职责

本模块包含四个轻量级的工具处理器（tool handler），均位于 **Core → ToolsOrchestration → Handlers** 层级中。它们实现了 `ToolHandler` trait，由 ToolRegistry 分发调用，处理的是非核心执行类（shell/patch）的辅助功能：

- **RequestPermissionsHandler** — 模型请求提升沙箱权限
- **RequestUserInputHandler** — 模型在执行过程中向用户索取输入
- **DynamicToolHandler** — 将调用派发给外部注册的动态工具
- **TestSyncHandler** — 为集成测试提供同步原语（sleep + barrier）

四个处理器均为 `ToolKind::Function` 类型，接收 `ToolPayload::Function { arguments }` 形式的参数。

---

## RequestPermissionsHandler

> 源码：`codex-rs/core/src/tools/handlers/request_permissions.rs`

### 职责

允许模型在运行时请求额外的沙箱权限。当模型发现当前权限不足以完成某项操作时，可以通过此工具向用户发起权限提升请求。

### 关键流程

1. 从 `ToolPayload::Function` 中提取 JSON 参数，使用 `parse_arguments_with_base_path()` 反序列化为 `RequestPermissionsArgs`，以当前工作目录作为基础路径解析相对路径（第 39-40 行）
2. 调用 `normalize_additional_permissions()` 规范化权限列表，然后转换为 `RequestPermissionProfile` 类型（第 41-43 行）
3. 校验权限列表不为空，否则返回错误（第 44-48 行）
4. 调用 `session.request_permissions()` 异步等待用户/系统审批结果（第 50-57 行）
5. 将审批响应序列化为 JSON 返回给模型（第 59-65 行）

### 函数签名

```rust
impl ToolHandler for RequestPermissionsHandler {
    type Output = FunctionToolOutput;
    async fn handle(&self, invocation: ToolInvocation) -> Result<Self::Output, FunctionCallError>;
}
```

**输入参数**（`RequestPermissionsArgs`）：
- `permissions` — 请求的权限列表，经 `normalize_additional_permissions` 规范化处理

**返回值**：审批结果的 JSON 序列化字符串，封装在 `FunctionToolOutput::from_text` 中，`is_error` 标记为 `Some(true)`（表示需要模型注意处理结果）。

### 边界 Case

- 权限列表为空时直接返回 `RespondToModel` 错误，不会发起审批请求
- `session.request_permissions()` 返回 `None` 时（例如请求被取消），返回取消错误
- 序列化响应失败时触发 `Fatal` 错误（严重错误，区别于可回复给模型的错误）

---

## RequestUserInputHandler

> 源码：`codex-rs/core/src/tools/handlers/request_user_input.rs`

### 职责

允许模型在一轮对话的执行过程中向用户索取输入信息。例如模型在执行任务时需要用户确认某个选择或提供额外信息。

### 结构体定义

```rust
pub struct RequestUserInputHandler {
    pub default_mode_request_user_input: bool,
}
```

`default_mode_request_user_input` 字段控制该工具在默认协作模式下是否可用。

### 关键流程

1. 提取 `ToolPayload::Function` 中的 JSON 参数（第 33-40 行）
2. **可用性检查**：获取当前 `session.collaboration_mode()`，调用 `request_user_input_unavailable_message()` 判断当前模式是否允许请求用户输入。若不可用，立即返回错误（第 42-47 行）
3. 反序列化为 `RequestUserInputArgs` 并通过 `normalize_request_user_input_args()` 规范化（第 49-51 行）
4. 调用 `session.request_user_input()` 异步等待用户响应（第 52-59 行）
5. 将用户响应序列化为 JSON 返回给模型（第 61-67 行）

### 边界 Case

- 部分协作模式下此工具不可用，模型调用时会收到明确的不可用消息
- 用户响应被取消时返回取消错误

---

## DynamicToolHandler

> 源码：`codex-rs/core/src/tools/handlers/dynamic.rs`

### 职责

作为外部注册的动态工具的通用分发器。当外部系统（如 IDE 插件、SDK 客户端）通过事件机制注册了自定义工具后，模型调用这些工具时由 `DynamicToolHandler` 统一处理，通过事件总线完成请求/响应的异步通信。

### 关键设计

- 该处理器将自身标记为 **mutating**（`is_mutating()` 返回 `true`，第 29-31 行），这意味着在并行工具执行时会获取互斥锁，避免与其他变更类工具并发执行
- 使用 `oneshot` channel 实现请求/响应的一对一配对

### 关键流程

`handle()` 方法委托给内部函数 `request_dynamic_tool()`：

1. 提取参数并反序列化为 `serde_json::Value`（不做结构化解析，因为各动态工具参数格式不同）（第 52 行）
2. 调用 `request_dynamic_tool()` 发起异步请求（第 53-58 行）
3. 将响应中的 `content_items` 转换为 `FunctionCallOutputContentItem` 列表返回（第 65-69 行）

`request_dynamic_tool()` 的详细流程（第 73-132 行）：

1. 创建 `oneshot::channel` 用于接收响应（第 81 行）
2. 在 `session.active_turn` 的 `turn_state` 中注册 pending 请求，将 `tx_response` 存入待处理映射（第 83-92 行）
3. 如果同一 `call_id` 已有 pending 请求，打印警告日志（第 93-95 行）
4. 记录请求开始时间，构造 `EventMsg::DynamicToolCallRequest` 事件并通过 `session.send_event()` 发送给外部消费者（第 97-104 行）
5. 在 `rx_response` 上等待外部消费者的响应（第 105 行）
6. 无论成功或取消，构造 `EventMsg::DynamicToolCallResponse` 事件（包含耗时信息）并发送（第 107-129 行）
7. 返回响应结果（第 131 行）

### 类型定义

**请求事件**（`DynamicToolCallRequest`）：
| 字段 | 类型 | 说明 |
|------|------|------|
| call_id | String | 工具调用唯一标识 |
| turn_id | String | 当前 turn 的子 ID |
| tool | String | 动态工具名称 |
| arguments | Value | 工具调用参数（任意 JSON） |

**响应事件**（`DynamicToolCallResponseEvent`）：
| 字段 | 类型 | 说明 |
|------|------|------|
| call_id | String | 对应请求的 call_id |
| turn_id | String | 当前 turn 的子 ID |
| tool | String | 动态工具名称 |
| arguments | Value | 原始调用参数 |
| content_items | Vec | 响应内容项列表 |
| success | bool | 执行是否成功 |
| error | Option\<String\> | 错误信息（取消时填充） |
| duration | Duration | 从请求到响应的耗时 |

### 边界 Case

- 同一 `call_id` 重复注册时会覆盖旧的 channel sender，并打印警告
- 外部消费者未响应（channel 被 drop）时，`rx_response.await` 返回 `Err`，转为 `None`，最终返回取消错误
- 即使调用被取消，仍会发送带 `error` 字段的 `DynamicToolCallResponse` 事件用于可观测性

---

## TestSyncHandler

> 源码：`codex-rs/core/src/tools/handlers/test_sync.rs`

### 职责

为集成测试提供同步原语——可控的延迟（sleep）和多方屏障（barrier）。在测试场景中，测试代码可以通过让模型调用此工具来协调多个并发操作的时序。

### 关键设计

使用进程级全局静态 `OnceLock<Mutex<HashMap<String, BarrierState>>>` 存储所有活跃的 barrier 状态（第 23 行）。这使得同一进程中不同 session/turn 的测试可以通过相同的 barrier ID 进行同步。

### 参数定义

**`TestSyncArgs`**：
| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| sleep_before_ms | Option\<u64\> | None | barrier 等待前的延迟（毫秒） |
| sleep_after_ms | Option\<u64\> | None | barrier 等待后的延迟（毫秒） |
| barrier | Option\<BarrierArgs\> | None | 可选的 barrier 同步配置 |

**`BarrierArgs`**：
| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| id | String | — | barrier 唯一标识 |
| participants | usize | — | 参与者数量 |
| timeout_ms | u64 | 1000 | 等待超时（毫秒） |

### 关键流程

1. 如果指定了 `sleep_before_ms` 且大于 0，先执行 sleep（第 77-81 行）
2. 如果指定了 `barrier`，调用 `wait_on_barrier()`（第 83-85 行）
3. 如果指定了 `sleep_after_ms` 且大于 0，再执行 sleep（第 87-91 行）
4. 返回 `"ok"` 字符串（第 93 行）

### Barrier 同步逻辑（`wait_on_barrier`，第 97-152 行）

1. 校验 `participants > 0` 和 `timeout_ms > 0`（第 98-108 行）
2. 获取全局 barrier map 的锁：
   - 若 barrier ID 已存在，检查 participants 数量是否一致（不一致则报错），然后克隆 `Arc<Barrier>`（第 114-123 行）
   - 若 barrier ID 不存在，创建新的 `Barrier::new(participants)` 并存入 map（第 124-131 行）
3. 使用 `tokio::time::timeout` 包裹 `barrier.wait()`，超时则返回错误（第 136-140 行）
4. **leader 清理**：`barrier.wait()` 返回的 `BarrierWaitResult` 中，leader（最后一个到达的参与者）负责从全局 map 中移除已完成的 barrier，并通过 `Arc::ptr_eq` 确保不会误删新创建的同名 barrier（第 142-149 行）

### 边界 Case

- 同一 barrier ID 以不同 participants 数量注册时返回错误
- barrier 等待超时返回 `RespondToModel` 错误
- leader 清理时使用指针比较防止 ABA 问题——如果在等待期间有新的同名 barrier 被创建，旧 barrier 的 leader 不会误删新 barrier
- `sleep_before_ms` 和 `sleep_after_ms` 为 0 时不执行延迟（显式跳过）