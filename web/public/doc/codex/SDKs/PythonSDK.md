# Python SDK（codex-app-server-sdk）

## 概述与职责

Python SDK（包名 `codex-app-server-sdk`）是 Codex 系统中 **SDKs** 模块的子组件，提供对 Codex app-server 的完整 Python 编程接口。它通过 stdio 上的 JSON-RPC 协议与 app-server 子进程通信，让 Python 开发者能够以编程方式创建会话线程、发送消息、流式接收响应、管理线程生命周期。

SDK 提供两层 API：
- **低层 RPC 客户端**：`AppServerClient`（同步）和 `AsyncAppServerClient`（异步），直接映射 JSON-RPC 方法调用
- **高层语义 API**：`Codex` / `AsyncCodex`、`Thread` / `AsyncThread`、`TurnHandle` / `AsyncTurnHandle`，提供面向对象的、类型安全的交互体验

在整体架构中，Python SDK 是 SDKs 层的一部分，与 TypeScript SDK 和 npm CLI 包并列。它通过 stdio 管道与 AppServer 通信——SDK 自动启动 `codex app-server --listen stdio://` 子进程，所有交互通过标准输入输出的 JSON-RPC 消息完成。

## 包结构

```
sdk/python/
├── src/codex_app_server/      # 核心包
│   ├── __init__.py            # 公开 API 导出
│   ├── client.py              # 同步 RPC 客户端 + 二进制解析
│   ├── async_client.py        # 异步 RPC 客户端（线程卸载）
│   ├── api.py                 # 高层语义 API（Codex/Thread/TurnHandle）
│   ├── _inputs.py             # 输入类型定义与序列化
│   ├── _run.py                # RunResult 收集逻辑
│   ├── errors.py              # 异常层级
│   ├── retry.py               # 重试逻辑
│   ├── models.py              # 通知与响应模型
│   └── generated/             # 自动生成的 Pydantic 模型
│       ├── v2_all.py          # 从 JSON Schema 生成的全量类型
│       └── notification_registry.py  # 通知方法→模型映射表
├── _runtime_setup.py          # 运行时二进制下载与安装
├── scripts/update_sdk_artifacts.py  # 代码生成脚本
├── examples/                  # 14 个示例（同步+异步对）
├── notebooks/                 # Jupyter walkthrough
└── tests/                     # 测试套件
```

## 关键流程

### 1. 客户端启动与初始化流程

使用高层 API 时，整个启动流程在 `Codex` 构造函数中自动完成：

1. 创建 `AppServerClient` 实例（`src/codex_app_server/api.py:72-73`）
2. 调用 `client.start()` 启动 app-server 子进程：
   - 通过 `resolve_codex_bin()` 定位 codex 二进制文件（`client.py:106-117`）——优先使用 `AppServerConfig.codex_bin` 显式路径，否则从 `codex-cli-bin` 依赖包中导入
   - 组装命令行参数：`[codex_bin, --config, ..., app-server, --listen, stdio://]`（`client.py:165-172`）
   - 通过 `subprocess.Popen` 启动子进程，stdin/stdout/stderr 均为管道（`client.py:178-188`）
   - 启动后台守护线程持续读取 stderr（`client.py:486-498`）
3. 发送 `initialize` JSON-RPC 请求，携带客户端信息和能力声明（`client.py:210-226`）
4. 发送 `initialized` 通知，完成握手
5. 验证响应中的 `serverInfo`（名称、版本），验证失败则关闭连接并抛出异常（`api.py:88-123`）

```python
# 典型用法
with Codex(config=AppServerConfig(model="gpt-5.4")) as codex:
    print(codex.metadata.serverInfo.name)
```

### 2. JSON-RPC 请求/响应循环

`AppServerClient._request_raw()` 实现了核心的 JSON-RPC 请求循环（`client.py:240-271`）：

1. 生成唯一 `request_id`（UUID4）
2. 通过 `_write_message()` 将 JSON 写入子进程 stdin（线程安全，使用 `threading.Lock`）
3. 进入读取循环，逐行从 stdout 解析 JSON-RPC 消息：
   - **服务端请求**（有 `method` + `id`）：交由 `_handle_server_request()` 处理（主要是审批回调），将结果写回
   - **通知**（有 `method`，无 `id`）：压入 `_pending_notifications` 队列
   - **响应**（匹配 `request_id`）：返回 `result` 或抛出映射后的异常

`request()` 方法在 `_request_raw()` 之上增加了 Pydantic 模型验证（`client.py:228-238`），将原始 JSON 自动反序列化为类型化的响应对象。

### 3. Turn 执行与流式事件消费

Turn 是与 LLM 交互的基本单元。SDK 提供三种消费 Turn 的方式：

**方式一：`Thread.run()`——一次性获取结果**

```python
result = thread.run("Say hello")  # RunResult
print(result.final_response)
```

内部流程（`api.py:472-504` 和 `_run.py:59-83`）：
1. 调用 `thread.turn()` 创建 `TurnHandle`
2. 调用 `turn.stream()` 获取事件迭代器
3. `_collect_run_result()` 消费所有事件，收集 `ItemCompletedNotification` 中的 items 和 token usage
4. 等到 `turn/completed` 事件后，检查 turn 状态（失败则抛出 `RuntimeError`）
5. 从收集到的 items 中提取最终助手响应（优先取 `phase == final_answer` 的消息）

**方式二：`TurnHandle.stream()`——逐事件流式处理**

```python
turn = thread.turn(TextInput("Explain SIMD"))
for event in turn.stream():
    if event.method == "item/agentMessage/delta":
        print(event.payload.delta, end="")
```

`TurnHandle.stream()` 是一个生成器（`api.py:655-669`），通过 `acquire_turn_consumer` / `release_turn_consumer` 机制确保同一时间只有一个消费者在读取事件流。循环读取通知直到收到匹配 `turn_id` 的 `turn/completed` 事件。

**方式三：`TurnHandle.run()`——获取原始 Turn 对象**

```python
turn_obj = thread.turn(TextInput("Hello")).run()
print(turn_obj.status)
```

### 4. 通知分发与类型化

从 app-server 收到的每条 JSON-RPC 通知都经过 `_coerce_notification()` 处理（`client.py:456-467`）：

1. 查询 `NOTIFICATION_MODELS` 注册表（`generated/notification_registry.py`），这是一个 `method → Pydantic模型类` 的映射，包含 40+ 种通知类型
2. 如果找到匹配模型，使用 `model_validate()` 将 JSON params 反序列化为类型化的 payload
3. 如果未找到或验证失败，回退为 `UnknownNotification`（保留原始 params dict）
4. 返回 `Notification(method=..., payload=...)` 数据类

## 函数签名与核心 API

### `AppServerConfig`

配置数据类，控制客户端行为（`client.py:123-134`）：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `codex_bin` | `str \| None` | `None` | codex 二进制路径，`None` 时自动从 `codex-cli-bin` 包解析 |
| `launch_args_override` | `tuple[str, ...] \| None` | `None` | 完全覆盖启动命令行 |
| `config_overrides` | `tuple[str, ...]` | `()` | 追加的 `--config key=value` 参数 |
| `cwd` | `str \| None` | `None` | 子进程工作目录 |
| `env` | `dict[str, str] \| None` | `None` | 追加到子进程环境变量 |
| `client_name` | `str` | `"codex_python_sdk"` | initialize 握手中的客户端名称 |
| `client_version` | `str` | `"0.2.0"` | 客户端版本号 |
| `experimental_api` | `bool` | `True` | 是否启用实验性 API |

### `Codex` 高层 API

```python
class Codex:
    def __init__(self, config: AppServerConfig | None = None) -> None
    def thread_start(self, *, model: str | None = None, ...) -> Thread
    def thread_resume(self, thread_id: str, ...) -> Thread
    def thread_list(self, *, archived: bool | None = None, ...) -> ThreadListResponse
    def thread_fork(self, thread_id: str, ...) -> Thread
    def thread_archive(self, thread_id: str) -> ThreadArchiveResponse
    def thread_unarchive(self, thread_id: str) -> Thread
    def models(self, *, include_hidden: bool = False) -> ModelListResponse
    @property
    def metadata(self) -> InitializeResponse
    def close(self) -> None
```

`thread_start` 等方法展开了 Pydantic 模型的所有字段为关键字参数（`api.py:133-166`），支持 `approval_policy`、`sandbox`、`model`、`personality` 等配置。这些方法签名由 `scripts/update_sdk_artifacts.py` 的代码生成器从 v2 协议 schema 自动派生。

### `Thread` / `AsyncThread`

```python
@dataclass
class Thread:
    id: str
    def run(self, input: RunInput, *, model: str | None = None, ...) -> RunResult
    def turn(self, input: Input, *, effort: ReasoningEffort | None = None, ...) -> TurnHandle
    def read(self, *, include_turns: bool = False) -> ThreadReadResponse
    def set_name(self, name: str) -> ThreadSetNameResponse
    def compact(self) -> ThreadCompactStartResponse
```

`run()` 是最简便的调用方式——接受字符串或 `Input` 对象，内部创建 turn、消费流、返回 `RunResult`。`RunInput` 类型别名允许直接传入 `str`，会自动转换为 `TextInput`（`_inputs.py:60-63`）。

### `TurnHandle` / `AsyncTurnHandle`

```python
@dataclass
class TurnHandle:
    thread_id: str
    id: str
    def stream(self) -> Iterator[Notification]
    def run(self) -> Turn
    def steer(self, input: Input) -> TurnSteerResponse
    def interrupt(self) -> TurnInterruptResponse
```

`steer()` 允许在 turn 执行过程中注入新的输入（`api.py:649-650`），`interrupt()` 可中止正在进行的 turn（`api.py:652-653`）。

### `RunResult`

```python
@dataclass
class RunResult:
    final_response: str | None   # 最终助手回复文本
    items: list[ThreadItem]      # 所有完成的 items
    usage: ThreadTokenUsage | None  # token 使用统计
```

`final_response` 的提取逻辑优先选择 `phase == final_answer` 的 `AgentMessageThreadItem`，否则取最后一条 `phase == None` 的消息（`_run.py:36-48`）。

## 输入类型系统

SDK 定义了 5 种输入类型（`_inputs.py`），每种都是一个简单的 dataclass：

| 类型 | 字段 | 序列化后的 wire 格式 |
|------|------|---------------------|
| `TextInput` | `text: str` | `{"type": "text", "text": "..."}` |
| `ImageInput` | `url: str` | `{"type": "image", "url": "..."}` |
| `LocalImageInput` | `path: str` | `{"type": "localImage", "path": "..."}` |
| `SkillInput` | `name: str, path: str` | `{"type": "skill", "name": "...", "path": "..."}` |
| `MentionInput` | `name: str, path: str` | `{"type": "mention", "name": "...", "path": "..."}` |

类型别名：
- `InputItem = TextInput | ImageInput | LocalImageInput | SkillInput | MentionInput`
- `Input = list[InputItem] | InputItem`（单个或列表）
- `RunInput = Input | str`（`Thread.run()` 额外支持直接传字符串）

## 异常层级

异常定义在 `errors.py`，形成清晰的继承树：

```
AppServerError                    # SDK 基础异常
├── TransportClosedError          # 传输层关闭（子进程退出）
└── JsonRpcError                  # JSON-RPC 错误（携带 code/message/data）
    └── AppServerRpcError         # 标准 JSON-RPC 错误码
        ├── ParseError            # -32700
        ├── InvalidRequestError   # -32600
        ├── MethodNotFoundError   # -32601
        ├── InvalidParamsError    # -32602
        ├── InternalRpcError      # -32603
        └── ServerBusyError       # -32000~-32099 + server_overloaded 标记
            └── RetryLimitExceededError  # 服务端重试预算耗尽
```

`map_jsonrpc_error()` 函数（`errors.py:90-113`）根据错误码和 data 字段中的 `server_overloaded` 标记进行精细分类。`is_retryable_error()` 判断异常是否为可重试的瞬态过载错误（`errors.py:116-125`）。

## 重试逻辑

`retry_on_overload()` 提供带指数退避的重试机制（`retry.py:12-41`）：

```python
def retry_on_overload(
    op: Callable[[], T],
    *,
    max_attempts: int = 3,        # 最大尝试次数
    initial_delay_s: float = 0.25, # 初始延迟（秒）
    max_delay_s: float = 2.0,     # 最大延迟上限
    jitter_ratio: float = 0.2,    # 抖动比例（±20%）
) -> T
```

每次重试前延迟翻倍（受 `max_delay_s` 限制），并加入随机抖动避免雷群效应。仅对 `is_retryable_error()` 返回 `True` 的异常进行重试，非瞬态错误立即向上传播。

`AppServerClient` 也暴露了 `request_with_retry_on_overload()` 方法（`client.py:396-411`），在低层 RPC 层面直接集成重试。

## 异步实现策略

`AsyncAppServerClient` 不是独立的异步实现，而是对同步客户端的**线程卸载包装**（`async_client.py:39-40`）：

```python
class AsyncAppServerClient:
    def __init__(self, config):
        self._sync = AppServerClient(config=config)
        self._transport_lock = asyncio.Lock()

    async def _call_sync(self, fn, /, *args, **kwargs):
        async with self._transport_lock:
            return await asyncio.to_thread(fn, *args, **kwargs)
```

所有异步方法都通过 `asyncio.to_thread()` 将同步阻塞调用卸载到工作线程，同时用 `asyncio.Lock` 保证 stdio 传输的串行访问。`stream_text()` 的异步版本特别处理：在持有传输锁的情况下，通过 `_next_from_iterator` 辅助方法逐个 yield 事件（`async_client.py:193-208`）。

`AsyncCodex` 在此基础上增加了惰性初始化——直到首次使用或 `async with` 进入时才启动连接（`api.py:291-306`），使用 `asyncio.Lock` 保证初始化只执行一次。

## 代码生成管线

`scripts/update_sdk_artifacts.py` 是 SDK 的代码生成入口，从 Rust 端的 JSON Schema 自动生成 Python 类型：

1. **Schema 预处理**：读取 `codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json`，执行两步规范化：
   - `_flatten_string_enum_one_of()`：将单值字符串 oneOf 合并为 enum（`update_sdk_artifacts.py:163-194`）
   - `_annotate_schema()`：为 union 分支生成稳定的 Python 类名（而非匿名编号），基于鉴别字段（type/method/mode 等）派生 PascalCase 标题（`update_sdk_artifacts.py:358-396`）

2. **类型生成**：调用 `datamodel-code-generator` 将规范化后的 JSON Schema 转换为 Pydantic v2 模型，输出到 `generated/v2_all.py`（~数千行）

3. **通知注册表生成**：解析 `ServerNotification.json`，生成 `notification_registry.py` 中的 `NOTIFICATION_MODELS` 字典

4. **公开 API 签名生成**：反射生成的 Pydantic 模型字段，自动更新 `api.py` 中 `Codex.thread_start()`、`Thread.turn()` 等方法的关键字参数签名（`update_sdk_artifacts.py:836-901`），确保公开 API 与协议 schema 保持同步

## 运行时二进制解析

SDK 需要一个 codex 二进制文件来启动 app-server 子进程。解析策略（`client.py:106-121`）：

1. 如果 `AppServerConfig.codex_bin` 已设置，直接使用（验证文件存在）
2. 否则尝试 `from codex_cli_bin import bundled_codex_path`——这是一个伴随分发的 Python 包（`codex-cli-bin`），其中打包了平台特定的 codex 二进制
3. 如果 `codex-cli-bin` 未安装，抛出 `FileNotFoundError` 并提示安装

`_runtime_setup.py` 提供了开发环境下的自动安装能力：`ensure_runtime_package_installed()` 会检查已安装版本是否匹配 `PINNED_RUNTIME_VERSION`（当前 `0.116.0-alpha.1`），如不匹配则从 GitHub Releases 下载对应平台的 archive，提取二进制，打包为 `codex-cli-bin` wheel 并 pip install。

## 边界 Case 与注意事项

- **并发 Turn 限制**：当前实验版本不支持并发 Turn 消费。`acquire_turn_consumer()` 会检查是否已有活跃消费者，如果有则抛出 `RuntimeError`（`client.py:289-297`）。这意味着同一个客户端连接上同一时间只能流式处理一个 turn。

- **审批自动接受**：默认的 `_default_approval_handler` 会自动接受所有命令执行和文件变更的审批请求（`client.py:479-484`）。如需自定义审批策略，可在构造 `AppServerClient` 时传入自定义 `approval_handler`。

- **Stderr 缓冲**：客户端维护最近 400 行 stderr 输出的环形缓冲区（`client.py:151`），当传输关闭时会在异常消息中包含 stderr 尾部（最后 40 行），便于诊断子进程崩溃。

- **异步客户端的传输锁**：由于底层 stdio 传输不支持并发读写，`AsyncAppServerClient` 使用 `asyncio.Lock` 串行化所有 I/O 操作（`async_client.py:45`）。这意味着异步客户端的并发优势主要在于不阻塞事件循环，而非真正的并行 I/O。

- **版本一致性**：`__init__.py` 中的 `__version__` 和 `AppServerConfig.client_version` 都硬编码为 `"0.2.0"`，需要与 `pyproject.toml` 中的版本保持同步。发布时由 `update_sdk_artifacts.py` 的 staging 流程统一重写。

- **Python 版本要求**：`requires-python = ">=3.10"`，唯一运行时依赖为 `pydantic>=2.12`。