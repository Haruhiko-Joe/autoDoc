# DevTools — 开发测试与调试工具

## 概述与职责

DevTools 是 AppServer 的开发者配套工具集，提供三大能力：

1. **集成测试套件**（`codex-rs/app-server/tests/`）：约 60 个测试文件，通过 mock 模型服务器和伪造 auth 凭证，对 app-server 的 v2 API 进行全面的集成测试。
2. **app-server-test-client**（`codex-rs/app-server-test-client/`）：一个可编程的测试工具，支持通过 stdio 或 WebSocket 两种方式与 app-server 通信，提供丰富的子命令用于手动或脚本化测试。
3. **debug-client**（`codex-rs/debug-client/`）：一个轻量级交互式 CLI，通过 stdio JSON-RPC 协议与 codex 进程通信，支持实时查看服务器事件、管理线程和发送消息。

在整体架构中，DevTools 属于 **AppServer** 模块的子模块。AppServer 本身是一个 HTTP/WebSocket 服务器，将 Codex agent 暴露为本地服务供 IDE 扩展和桌面应用调用。DevTools 确保 AppServer 的所有 API 端点在开发过程中得到充分验证。

## 集成测试套件

### 架构概览

所有集成测试通过单一入口文件 `codex-rs/app-server/tests/all.rs:1-3` 汇聚，内部按模块组织：

- `suite/auth.rs` — 认证相关测试
- `suite/conversation_summary.rs` — 会话摘要功能测试
- `suite/fuzzy_file_search.rs` — 模糊文件搜索测试
- `suite/v2/` — **v2 API 测试**（约 50 个模块），覆盖线程管理、turn 流程、插件系统、MCP 服务器、配置 RPC 等

### 测试基础设施（`tests/common/` — `app_test_support` crate）

测试基础设施作为独立的 `app_test_support` crate 发布（`codex-rs/app-server/tests/common/Cargo.toml`），被所有测试文件引用。核心组件包括：

#### McpProcess — 进程级测试客户端

`McpProcess` 是整个测试套件的核心工具类，封装了一个 `codex-app-server` 子进程的完整生命周期（`tests/common/mcp_process.rs:86-181`）。

```rust
pub struct McpProcess {
    next_request_id: AtomicI64,
    process: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    pending_messages: VecDeque<JSONRPCMessage>,
}
```

**关键能力**：

- `new(codex_home)` / `new_with_env(codex_home, env_overrides)` — 启动 `codex-app-server` 子进程，配置环境变量和工作目录
- `initialize()` — 完成 JSON-RPC 初始化握手，发送 `initialize` 请求和 `Initialized` 通知
- 提供丰富的 `send_*` 方法覆盖所有 v2 API 端点：`send_thread_start_request`、`send_turn_start_request`、`send_thread_list_request` 等
- 自动将子进程 stderr 转发到测试输出，便于调试失败的测试

典型测试流程：

```rust
let codex_home = TempDir::new()?;
// 1. 写入 mock 配置
create_config_toml(codex_home.path(), &server.uri())?;
// 2. 启动并初始化
let mut mcp = McpProcess::new(codex_home.path()).await?;
timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;
// 3. 发送请求并验证响应
let response = mcp.send_thread_start_request(...).await?;
```

#### Mock 模型服务器

`mock_model_server.rs` 基于 `wiremock` 库构建模拟的 OpenAI Responses API 服务器（`tests/common/mock_model_server.rs:14-81`）：

- **`create_mock_responses_server_sequence(responses)`** — 创建一个按序返回 SSE 响应的 mock 服务器，严格校验调用次数
- **`create_mock_responses_server_sequence_unchecked(responses)`** — 同上但不校验调用次数
- **`create_mock_responses_server_repeating_assistant(message)`** — 创建一个对每次请求返回相同助手消息的 mock 服务器

内部通过 `SeqResponder` 结构体使用原子计数器追踪调用顺序（`tests/common/mock_model_server.rs:52-65`）。

#### Auth Fixtures — 认证数据伪造

`auth_fixtures.rs` 提供 `ChatGptAuthFixture` builder，用于在测试中伪造 ChatGPT 认证数据（`tests/common/auth_fixtures.rs:19-77`）：

```rust
ChatGptAuthFixture::new("access-token")
    .plan_type("pro")
    .email("test@example.com")
    .account_id("acc-123")
```

`encode_id_token()` 函数生成不带签名验证的 JWT token（`alg: "none"`），将 email、plan_type、chatgpt_user_id 等 claims 编码为 base64 格式（`tests/common/auth_fixtures.rs:113-143`）。`write_chatgpt_auth()` 将伪造的凭证写入 `CODEX_HOME/auth.json`。

#### SSE 响应构造器

`responses.rs` 提供工厂函数，构造模拟 LLM 返回的 SSE 流数据（`tests/common/responses.rs:5-105`）：

| 函数 | 用途 |
|------|------|
| `create_shell_command_sse_response` | 模拟模型请求执行 shell 命令 |
| `create_apply_patch_sse_response` | 模拟模型请求应用补丁 |
| `create_exec_command_sse_response` | 模拟模型请求执行 exec_command |
| `create_final_assistant_message_sse_response` | 模拟模型返回纯文本助手消息 |
| `create_request_user_input_sse_response` | 模拟模型请求用户输入 |
| `create_request_permissions_sse_response` | 模拟模型请求权限提升 |

#### 其他辅助模块

- **`config.rs`**：`write_mock_responses_config_toml()` 生成完整的测试用 `config.toml`，配置 mock 模型提供商、feature flags、compact 策略等（`tests/common/config.rs:6-80`）
- **`analytics_server.rs`**：`start_analytics_events_server()` 启动一个接收分析事件的 mock HTTP 服务器（`tests/common/analytics_server.rs:8-16`）
- **`rollout.rs`**：`create_fake_rollout()` 在文件系统上创建伪造的会话 rollout JSONL 文件，用于测试线程列表和会话恢复功能（`tests/common/rollout.rs:34-132`）
- **`models_cache.rs`**：`write_models_cache()` 生成模型缓存文件，防止测试中发生网络请求（`tests/common/models_cache.rs:58-77`）

### v2 API 测试覆盖

`suite/v2/` 目录下的 ~50 个测试模块覆盖了 app-server 的完整 v2 API，按功能域分组：

**线程生命周期**：`thread_start`、`thread_resume`、`thread_list`、`thread_loaded_list`、`thread_read`、`thread_archive`、`thread_unarchive`、`thread_fork`、`thread_rollback`、`thread_status`、`thread_unsubscribe`、`thread_metadata_update`、`thread_name_websocket`、`thread_shell_command`

**Turn 管理**：`turn_start`（最大的测试文件，覆盖命令执行审批、文件变更审批、MCP 工具调用、collaboration mode 等场景）、`turn_interrupt`、`turn_steer`、`turn_start_zsh_fork`

**功能特性**：`compaction`、`output_schema`、`plan_item`、`request_user_input`、`request_permissions`、`dynamic_tools`、`safety_check_downgrade`、`realtime_conversation`

**服务管理**：`initialize`、`account`、`analytics`、`rate_limits`、`config_rpc`、`model_list`、`experimental_api`、`experimental_feature_list`、`collaboration_mode_list`、`skills_list`、`app_list`

**插件系统**：`plugin_install`、`plugin_list`、`plugin_read`、`plugin_uninstall`

**MCP 集成**：`mcp_server_status`、`mcp_server_elicitation`

**连接处理**：`connection_handling_websocket`、`connection_handling_websocket_unix`（仅 Unix）

**平台特定**：`windows_sandbox_setup`、`command_exec`（仅 Unix）、`fs`

### 辅助二进制工具

`app-server/src/bin/` 下包含两个小型辅助二进制，供测试使用：

- **`notify_capture.rs`** — 原子写入文件工具：接收输出路径和 payload 参数，通过先写临时文件再 `rename` 的方式保证原子性（`src/bin/notify_capture.rs:12-44`）
- **`test_notify_capture.rs`** — 功能类似的简化版本（`src/bin/test_notify_capture.rs:6-23`）

## app-server-test-client

### 概述

`codex-app-server-test-client` 是一个功能丰富的命令行测试工具，支持通过 **stdio**（启动子进程）或 **WebSocket**（连接已有服务器）两种方式与 app-server 交互。它主要用于手动测试和自动化脚本场景。

### CLI 结构

通过 `clap` 定义的命令行参数（`app-server-test-client/src/lib.rs:107-275`）：

**全局选项**：
- `--codex-bin <path>` / `CODEX_BIN` — 指定 codex 二进制路径（stdio 模式）
- `--url <ws-url>` / `CODEX_APP_SERVER_URL` — WebSocket 服务器 URL（默认 `ws://127.0.0.1:4222`）
- `-c / --config key=value` — 传递配置覆盖项，可重复
- `--dynamic-tools <json-or-@file>` — 注入动态工具定义

**子命令**：

| 子命令 | 功能 |
|--------|------|
| `serve` | 后台启动 WebSocket 模式的 app-server |
| `send-message` | 通过旧版 API 发送用户消息 |
| `send-message-v2` | 通过 v2 thread/turn API 发送消息 |
| `resume-message-v2` | 恢复已有线程并发送消息 |
| `thread-resume` | 恢复线程并持续流式输出事件 |
| `watch` | 初始化后 dump 所有入站消息 |
| `trigger-cmd-approval` | 触发命令执行审批流程 |
| `trigger-patch-approval` | 触发文件补丁审批流程 |
| `no-trigger-cmd-approval` | 验证不触发审批的场景 |
| `send-follow-up-v2` | 在同一线程中发送两轮连续消息 |
| `trigger-zsh-fork-multi-cmd-approval` | 测试 zsh fork 多命令审批 |
| `test-login` | 测试 ChatGPT 登录流程 |
| `get-account-rate-limits` | 获取账户速率限制 |
| `model-list` | 列出可用模型 |
| `thread-list` | 列出已存储线程 |
| `thread-increment-elicitation` | 递增线程的 elicitation 暂停计数器 |
| `thread-decrement-elicitation` | 递减线程的 elicitation 暂停计数器 |
| `live-elicitation-timeout-pause` | 运行 live WebSocket 测试验证 elicitation 暂停功能 |

### 通信模式

该工具通过 `resolve_endpoint()` 自动选择通信模式：

- 如果指定了 `--codex-bin`，使用 **stdio 模式**：启动 `codex app-server` 子进程，通过 stdin/stdout 交换 JSON-RPC 消息
- 如果指定了 `--url` 或两者都未指定，使用 **WebSocket 模式**：基于 `tungstenite` 连接已有的 WebSocket 端点

### 集成 OpenTelemetry

该工具集成了 `codex-otel`，支持分布式追踪。在消息发送时会注入 W3C trace context（`app-server-test-client/src/lib.rs:102-104`）。

## debug-client

### 概述

`codex-debug-client` 是一个最小化的交互式 CLI 调试工具，专为开发者手动测试 app-server 的 JSON-RPC 协议设计。它通过 stdio 管道启动一个 `codex app-server` 进程，将所有服务器输出实时渲染到终端。

### 架构

debug-client 由 5 个模块组成：

```
main.rs  ──→  client.rs（进程管理 + JSON-RPC 通信）
   │               │
   ├→ commands.rs  │→ reader.rs（后台读取线程）
   ├→ output.rs    │→ state.rs（共享状态）
   └→ state.rs
```

#### AppServerClient（`debug-client/src/client.rs:44-413`）

核心客户端类，管理 codex 子进程的生命周期：

- `spawn(codex_bin, config_overrides, ...)` — 启动 `codex app-server` 子进程
- `initialize()` — 完成初始化握手，发送 `Initialize` + `Initialized`
- `start_thread()` / `resume_thread()` — 同步创建/恢复线程
- `send_turn(thread_id, text)` — 发送用户消息
- `start_reader(events, auto_approve, ...)` — 在后台线程中持续读取服务器输出

通信协议为行分隔的 JSON-RPC：每行一条 JSON 消息，通过 stdin 发送、stdout 接收。

#### 命令解析（`debug-client/src/commands.rs:36-76`）

用户输入以 `:` 前缀的为命令，否则视为要发送的消息：

| 命令 | 功能 |
|------|------|
| `:help` / `:h` | 显示帮助信息 |
| `:quit` / `:q` / `:exit` | 退出程序 |
| `:new` | 创建新线程 |
| `:resume <thread-id>` | 恢复已有线程 |
| `:use <thread-id>` | 切换活跃线程（不加载） |
| `:refresh-thread` | 列出可用线程 |

#### 后台读取器（`debug-client/src/reader.rs:35-108`）

`start_reader()` 在独立线程中运行，持续读取服务器 stdout：

- 解析每行 JSON-RPC 消息，区分 Request、Response 和 Notification
- 对服务器发来的审批请求（`CommandExecutionRequestApproval`、`FileChangeRequestApproval`），根据 `--auto-approve` 标志自动接受或拒绝
- 在 `--final-only` 模式下，仅输出 `ItemCompleted` 通知中的助手消息和工具调用结果

#### 输出渲染（`debug-client/src/output.rs:22-122`）

`Output` 结构体提供线程安全的终端输出能力，支持 ANSI 彩色标签（assistant = 绿色、tool = 青色、thread = 蓝色）。自动检测终端环境和 `NO_COLOR` 环境变量。服务器输出写到 stdout，客户端状态信息写到 stderr，避免管道时混淆。

#### 共享状态（`debug-client/src/state.rs:1-28`）

```rust
pub struct State {
    pub pending: HashMap<RequestId, PendingRequest>,  // 追踪未完成的异步请求
    pub thread_id: Option<String>,                     // 当前活跃线程
    pub known_threads: Vec<String>,                    // 已知线程列表
}
```

### CLI 参数

```
codex-debug-client [OPTIONS]

Options:
  --codex-bin <path>         codex 二进制路径（默认 "codex"）
  -c, --config <key=value>   配置覆盖项（可重复）
  --thread-id <id>           恢复已有线程而非创建新线程
  --approval-policy <policy> 审批策略（默认 "on-request"）
  --auto-approve             自动批准所有审批请求
  --final-only               仅显示最终助手消息和工具调用
  --model <model>            模型覆盖
  --model-provider <id>      模型提供商覆盖
  --cwd <path>               工作目录覆盖
```

## 边界 Case 与注意事项

- `McpProcess` 使用 `kill_on_drop(true)` 确保测试结束时子进程被清理，但 Tokio 文档指出这不是强保证
- 测试中的 JWT token 使用 `alg: "none"` 且签名为硬编码值，**仅用于测试环境**，不涉及真实的密钥验证
- v2 测试套件中的超时默认值：Unix 为 10 秒，Windows 为 25 秒（`tests/suite/v2/turn_start.rs:68-70`）
- `connection_handling_websocket_unix` 和 `command_exec` 模块通过 `#[cfg(unix)]` 条件编译，仅在 Unix 平台运行
- debug-client 的 `read_until_response()` 在等待特定请求的响应时，会静默丢弃中间的通知消息（它们仍会被打印但不参与匹配逻辑）
- app-server-test-client 的日志写入 `/tmp/codex-app-server-test-client/` 目录