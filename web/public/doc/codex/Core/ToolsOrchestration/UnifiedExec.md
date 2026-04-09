# UnifiedExec — 长生命周期进程管理子系统

## 概述与职责

UnifiedExec 是 Codex Core 中 **ToolsOrchestration** 层的进程管理子系统，负责管理跨工具调用边界的长生命周期进程。在传统的单次工具调用模型中，命令执行是同步的——启动、等待完成、返回结果。而 UnifiedExec 提供了一种异步的 **start / check / kill** 生命周期，允许模型启动一个进程后在后续的工具调用中继续与它交互（发送 stdin、轮询输出、终止）。

在整体架构中，UnifiedExec 位于 **Core → ToolsOrchestration** 路径下，与 SessionEngine 和 Sandbox 紧密协作：SessionEngine 发起工具调用，ToolsOrchestration 路由到 UnifiedExec 的处理器，而 Sandbox 则为每个进程提供安全隔离策略。

同级模块包括 apply-patch、MCP 工具、多 Agent 工具、JS REPL 等其他工具处理器。

## 模块组成

子系统由以下文件组成：

| 文件 | 职责 |
|------|------|
| `mod.rs` | 模块入口：常量定义、请求类型、进程存储结构、公开导出 |
| `process_manager.rs` | 核心编排器：进程的创建/复用/轮询/终止、沙箱集成、输出收集 |
| `process.rs` | 进程抽象层：封装本地 PTY 和远程 exec-server 两种后端 |
| `async_watcher.rs` | 异步监视器：后台流式输出和退出事件发射 |
| `head_tail_buffer.rs` | 有限容量缓冲区：保留输出的头部和尾部，丢弃中间部分 |
| `process_state.rs` | 进程状态模型：退出码和失败消息的不可变状态转换 |
| `errors.rs` | 错误类型定义 |

## 关键流程

### 1. 启动新进程（exec_command）

这是最核心的流程，涉及审批、沙箱、PTY 启动和输出收集的完整链路：

1. **构建请求**：调用方提供 `ExecCommandRequest`，包含命令、工作目录、yield 超时、网络代理、TTY 模式等参数
2. **沙箱编排**（`open_session_with_sandbox`，`process_manager.rs:646-710`）：
   - 构造环境变量（合并 shell 策略 + UnifiedExec 专用环境变量如 `NO_COLOR=1`、`TERM=dumb`）
   - 创建 `ToolOrchestrator` 和 `UnifiedExecRuntime`
   - 通过 exec policy 生成审批需求
   - 编排器执行：审批（绕过/缓存/提示用户）→ 选择沙箱类型 → 启动进程
   - 如果沙箱拒绝，编排器自动以 `SandboxType::None` 重试
3. **PTY 启动**（`open_session_with_exec_env`，`process_manager.rs:582-644`）：
   - 远程模式：通过 exec-server 的 `start()` API 启动
   - 本地模式（TTY）：调用 `codex_utils_pty::pty::spawn_process_with_inherited_fds` 启动 PTY
   - 本地模式（非 TTY）：调用 `pipe::spawn_process_no_stdin_with_inherited_fds` 启动管道进程
4. **启动流式输出**（`start_streaming_output`）：后台任务持续读取 PTY 输出，写入 transcript 并发射 `ExecCommandOutputDelta` 事件
5. **存储进程**：如果进程仍然存活，将其存入 `ProcessStore`，并启动 exit watcher
6. **初始输出收集**（`collect_output_until_deadline`）：在 yield 时间窗口内收集输出
7. **返回结果**：构造 `ExecCommandToolOutput`，包含 chunk_id、输出内容、进程 ID（如果仍存活）、退出码（如果已退出）

```
ExecCommandRequest
       │
       ▼
open_session_with_sandbox()
  ├─ 构建环境变量（UNIFIED_EXEC_ENV）
  ├─ 创建 ToolOrchestrator
  ├─ 审批 → 沙箱选择 → 启动
  └─ 沙箱拒绝时自动重试
       │
       ▼
open_session_with_exec_env()
  ├─ 远程: exec-server.start()
  └─ 本地: spawn PTY / pipe
       │
       ▼
UnifiedExecProcess（封装进程句柄）
       │
       ├── start_streaming_output()  → 后台流式事件
       ├── store_process()           → 存入 ProcessStore
       ├── spawn_exit_watcher()      → 后台退出监控
       └── collect_output_until_deadline() → 初始输出快照
```

### 2. 与已有进程交互（write_stdin）

模型通过 `write_stdin` 向已存在的进程发送输入并轮询输出（`process_manager.rs:336-453`）：

1. 通过 `prepare_process_handles` 从 `ProcessStore` 中获取进程句柄，同时更新 `last_used` 时间戳
2. 如果输入非空且进程启用了 TTY，通过 `process.write()` 写入 stdin；非 TTY 进程会返回 `StdinClosed` 错误
3. 写入后短暂等待 100ms 让进程处理输入
4. 使用 `collect_output_until_deadline` 在配置的 yield 时间内收集输出
5. 通过 `refresh_process_state` 检查进程是否仍存活，据此填充返回值中的 `process_id` 和 `exit_code`

### 3. 输出收集机制（collect_output_until_deadline）

这是 UnifiedExec 中最精密的异步逻辑（`process_manager.rs:712-799`）：

- 使用 `tokio::select!` 同时监听四个信号：输出通知、退出信号、超时到达、暂停状态变化
- 进程退出后给予最多 50ms 的宽限期（`POST_EXIT_CLOSE_WAIT_CAP`）收集残余输出
- 支持 **暂停/恢复**：当会话因 out-of-band elicitation 暂停时，自动延长 deadline，避免白白消耗等待时间（`extend_deadlines_while_paused`，`process_manager.rs:801-825`）
- 从 `OutputBuffer`（即 `HeadTailBuffer`）中 drain 所有已缓冲的 chunk

### 4. 进程淘汰策略

当进程数达到上限 `MAX_UNIFIED_EXEC_PROCESSES`（64）时触发淘汰（`process_manager.rs:837-882`）：

1. 按最近使用时间排序，保护最近使用的 8 个进程不被淘汰
2. 优先淘汰已退出的、不在保护名单中的 LRU 进程
3. 如果没有已退出进程，则淘汰最久未使用的非保护进程
4. 达到 60 个进程时发出模型警告

## 函数签名与参数说明

### `UnifiedExecProcessManager::exec_command`

```rust
pub(crate) async fn exec_command(
    &self,
    request: ExecCommandRequest,
    context: &UnifiedExecContext,
) -> Result<ExecCommandToolOutput, UnifiedExecError>
```

启动新进程并收集初始输出。`ExecCommandRequest` 的关键字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `command` | `Vec<String>` | 命令行参数列表 |
| `process_id` | `i32` | 预分配的进程 ID |
| `yield_time_ms` | `u64` | 初始输出等待时间（会被 clamp 到 250ms–30s） |
| `max_output_tokens` | `Option<usize>` | 输出 token 上限，默认 10,000 |
| `tty` | `bool` | 是否以 PTY 模式启动（影响是否能 write_stdin） |
| `sandbox_permissions` | `SandboxPermissions` | 沙箱权限配置 |
| `network` | `Option<NetworkProxy>` | 网络代理配置 |

### `UnifiedExecProcessManager::write_stdin`

```rust
pub(crate) async fn write_stdin(
    &self,
    request: WriteStdinRequest<'_>,
) -> Result<ExecCommandToolOutput, UnifiedExecError>
```

向已有进程写入 stdin 并轮询输出。空输入等同于纯轮询，此时 yield 时间下限为 `MIN_EMPTY_YIELD_TIME_MS`（5 秒）。

### `UnifiedExecProcessManager::allocate_process_id`

```rust
pub(crate) async fn allocate_process_id(&self) -> i32
```

分配唯一进程 ID。生产环境使用 1000–100000 范围内的随机数；测试环境使用确定性递增序列（从 1000 开始）。

### `UnifiedExecProcessManager::terminate_all_processes`

```rust
pub(crate) async fn terminate_all_processes(&self)
```

终止所有托管进程，清空进程存储。用于会话关闭时的清理。

## 接口/类型定义

### `UnifiedExecProcess`（`process.rs:73-87`）

进程的统一抽象，封装了本地 PTY 和远程 exec-server 两种后端：

```rust
pub(crate) struct UnifiedExecProcess {
    process_handle: ProcessHandle,      // Local(ExecCommandSession) | Remote(dyn ExecProcess)
    output_tx: broadcast::Sender<Vec<u8>>,  // 输出广播通道
    output_buffer: OutputBuffer,        // Arc<Mutex<HeadTailBuffer>>
    state_tx/state_rx: watch channel,   // ProcessState 状态通道
    cancellation_token: CancellationToken,  // 退出信号
    sandbox_type: SandboxType,          // 沙箱类型
    // ...
}
```

关键方法：
- `write(&self, data: &[u8])` — 写入 stdin
- `has_exited() / exit_code()` — 查询退出状态
- `terminate()` — 终止进程并取消所有关联任务
- `output_handles()` — 获取共享输出句柄供轮询使用
- `output_receiver()` — 订阅输出广播通道供流式使用
- `from_spawned()` / `from_remote_started()` — 从本地/远程后端构造实例

### `ProcessState`（`process_state.rs`）

不可变风格的进程状态值对象：

```rust
pub(crate) struct ProcessState {
    pub has_exited: bool,
    pub exit_code: Option<i32>,
    pub failure_message: Option<String>,
}
```

通过 `exited()` 和 `failed()` 方法产生新状态，原状态不被修改。通过 `watch` 通道广播状态变更。

### `HeadTailBuffer`（`head_tail_buffer.rs`）

有限容量的双端缓冲区，保留输出的头部和尾部，丢弃中间部分：

```rust
pub(crate) struct HeadTailBuffer {
    max_bytes: usize,       // 默认 1 MiB
    head_budget: usize,     // max_bytes / 2
    tail_budget: usize,     // max_bytes - head_budget
    head: VecDeque<Vec<u8>>,
    tail: VecDeque<Vec<u8>>,
    // ...
}
```

核心方法：
- `push_chunk(chunk)` — 添加数据：先填满 head，再轮转 tail
- `drain_chunks()` — 取走所有缓冲内容并重置
- `snapshot_chunks()` — 只读快照
- `to_bytes()` — 拼接为单个 `Vec<u8>`

### `UnifiedExecError`（`errors.rs`）

错误枚举，覆盖进程生命周期中的各种失败：

| 变体 | 含义 |
|------|------|
| `CreateProcess` | 进程创建失败 |
| `ProcessFailed` | 进程运行时错误 |
| `UnknownProcessId` | 引用了不存在的进程 ID |
| `WriteToStdin` | stdin 写入失败 |
| `StdinClosed` | 非 TTY 进程不支持 stdin 写入 |
| `MissingCommandLine` | 请求缺少命令行 |
| `SandboxDenied` | 沙箱拒绝执行，附带输出快照 |

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|----|------|
| `MIN_YIELD_TIME_MS` | 250 | yield 时间下限 |
| `MIN_EMPTY_YIELD_TIME_MS` | 5,000 | 空轮询 yield 时间下限 |
| `MAX_YIELD_TIME_MS` | 30,000 | yield 时间上限 |
| `DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS` | 300,000（5 分钟） | `write_stdin` 空轮询默认超时上限 |
| `DEFAULT_MAX_OUTPUT_TOKENS` | 10,000 | 默认输出 token 上限 |
| `UNIFIED_EXEC_OUTPUT_MAX_BYTES` | 1,048,576（1 MiB） | `HeadTailBuffer` 最大保留字节 |
| `MAX_UNIFIED_EXEC_PROCESSES` | 64 | 同时存在的最大进程数 |
| `WARNING_UNIFIED_EXEC_PROCESSES` | 60 | 触发模型警告的进程数阈值 |
| `UNIFIED_EXEC_OUTPUT_DELTA_MAX_BYTES` | 8,192 | 单个 `ExecCommandOutputDelta` 事件最大字节数 |
| `EARLY_EXIT_GRACE_PERIOD` | 150ms | 进程启动后等待早退的宽限期 |
| `TRAILING_OUTPUT_GRACE` | 100ms | 进程退出后收集残余输出的宽限期 |

UnifiedExec 还为所有子进程注入固定环境变量（`process_manager.rs:54-65`），禁用颜色输出、设置 UTF-8 locale、将 pager 设为 `cat` 等，确保输出在非交互环境中可预测。

## 边界 Case 与注意事项

- **TTY vs 非 TTY 模式**：`tty=false` 启动的进程无法接受 stdin 写入，`write_stdin` 会返回 `StdinClosed` 错误。非 TTY 模式使用管道而非 PTY。
- **沙箱拒绝检测**：进程退出后，系统通过 `is_likely_sandbox_denied` 启发式检查输出是否像被沙箱拒绝。如果检测到，返回 `SandboxDenied` 错误而非普通退出。
- **早退检测**：进程启动后有 150ms 的宽限期（`EARLY_EXIT_GRACE_PERIOD`），在此期间如果进程退出会被立即捕获并检查沙箱拒绝，避免将失败存入长生命周期的进程池。
- **远程 exec-server 不支持 inherited FDs**：如果检测到 exec-server URL 且 spawn lifecycle 需要传递文件描述符，会直接报错。
- **进程 Drop 时自动终止**：`UnifiedExecProcess` 实现了 `Drop` trait，被丢弃时自动调用 `terminate()`，确保不会泄露子进程。
- **网络审批生命周期**：每个进程可关联一个 `DeferredNetworkApproval`，在进程被释放或淘汰时自动注销。
- **暂停感知**：输出收集会感知 out-of-band elicitation 暂停状态，暂停期间自动延长 deadline，避免因外部中断导致输出截断。
- **UTF-8 流切割**：`async_watcher` 中的 `split_valid_utf8_prefix` 确保事件中的输出片段总是有效 UTF-8 前缀，遇到不完整序列时会等待后续字节或逐字节降级。