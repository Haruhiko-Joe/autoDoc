# ResponsesApiProxy

## 概述与职责

ResponsesApiProxy（crate 名 `codex-responses-api-proxy`）是一个轻量级的本地 HTTP 代理服务器，专门用于将 `POST /v1/responses` 请求转发到上游 LLM 提供商（默认为 OpenAI），同时自动注入 `Authorization` 头。它的核心设计目标是**将 API 密钥与子进程隔离**——由特权用户启动代理并持有密钥，非特权用户通过代理发送请求而无需接触密钥本身。

在 Codex 的整体架构中，该模块属于 **ModelProviders** 层的一部分，为 Codex CLI 和其他客户端提供安全的 API 请求代理能力。它与同层的 OpenAI Responses API 客户端、Realtime API 客户端等模块并列，专注于"协议桥接 + 密钥隔离"这一特定场景。

该 crate 同时发布为 Rust 二进制和 NPM 包（`@openai/codex-responses-api-proxy`），支持 Node.js 生态集成。

## 关键流程

### 启动流程

1. `main.rs` 中通过 `#[ctor::ctor]` 在 `main()` 之前调用 `codex_process_hardening::pre_main_hardening()` 进行进程加固（`src/main.rs:4-7`）
2. 使用 `clap` 解析命令行参数为 `Args` 结构体
3. 调用 `run_main(args)` 进入核心逻辑（`src/lib.rs:73`）

### 密钥读取与保护流程

这是该模块安全设计的核心，实现在 `src/read_api_key.rs`：

1. 在栈上分配 1024 字节缓冲区，预填充 `"Bearer "` 前缀（`src/read_api_key.rs:83-84`）
2. 通过低级 `read(2)` 系统调用（Unix）直接从 stdin 读取 API 密钥，刻意绕过 `std::io::stdin()` 的内部 `BufReader` 以避免密钥在内存中产生多余拷贝（`src/read_api_key.rs:41-69`）
3. 去除尾部换行符，校验密钥仅包含 `[A-Za-z0-9\-_]` 字符（`src/read_api_key.rs:208-219`）
4. 将 `"Bearer <key>"` 拷贝为堆上的 `String`，随后立即用 `zeroize` 清零栈缓冲区（`src/read_api_key.rs:155-156`）
5. 调用 `.leak()` 将 `String` 转为 `&'static str`，再用 `mlock(2)` 锁定其内存页防止被交换到磁盘（`src/read_api_key.rs:158-159`）

### 服务器启动与监听

1. 绑定 `127.0.0.1:<port>`，若未指定端口则使用临时端口（`src/lib.rs:138-143`）
2. 如指定 `--server-info`，写入 JSON 文件 `{"port": <u16>, "pid": <u32>}`（`src/lib.rs:97-99`）
3. 基于 `tiny_http` 创建 HTTP 服务器，进入请求循环（`src/lib.rs:100-136`）
4. 每个请求在独立线程中处理（`src/lib.rs:117`）

### 请求转发流程

`forward_request()` 函数（`src/lib.rs:163-275`）：

1. **路径校验**：仅放行 `POST /v1/responses`，其他一律返回 `403 Forbidden`（`src/lib.rs:171-179`）
2. **读取请求体**：完整读取客户端请求体（`src/lib.rs:182-184`）
3. **构建上游请求头**：
   - 转发原始请求的所有头，但**剥离** `Authorization` 和 `Host`（`src/lib.rs:199-213`）
   - 注入保护后的 `Authorization` 头（使用 `from_static()` 避免拷贝 + `set_sensitive(true)` 标记敏感）（`src/lib.rs:217-219`）
   - 设置 `Host` 头为上游域名（`src/lib.rs:221`）
4. **发送请求**：通过 `reqwest::blocking::Client` 转发到上游 URL，超时设置为 `None` 以支持长时间流式响应（`src/lib.rs:102-108, 223-228`）
5. **流式回传响应**：将上游响应的状态码、头部和 body 流式回传给客户端，利用 `reqwest::blocking::Response` 实现 `Read` trait 直接作为 `tiny_http::Response` 的 body（`src/lib.rs:234-274`）

### HTTP 关停流程

当 `--http-shutdown` 启用时，收到 `GET /shutdown` 请求会返回 200 后立即调用 `std::process::exit(0)`（`src/lib.rs:118-121`）。这允许非特权用户在无法发送 `SIGTERM` 时关停代理。

## 函数签名与参数说明

### `run_main(args: Args) -> Result<()>`

库的主入口点。读取密钥、启动服务器、进入请求循环。正常情况下不会返回（事件循环是无限的），仅在服务器异常停止时返回错误。

> 源码位置：`src/lib.rs:73-136`

### `Args` 结构体（CLI 参数）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `port` | `Option<u16>` | 无（使用临时端口） | 监听端口 |
| `server_info` | `Option<PathBuf>` | 无 | 启动信息 JSON 文件路径 |
| `http_shutdown` | `bool` | `false` | 是否启用 `GET /shutdown` 端点 |
| `upstream_url` | `String` | `https://api.openai.com/v1/responses` | 上游转发目标 URL |
| `dump_dir` | `Option<PathBuf>` | 无 | 请求/响应 dump 输出目录 |

> 源码位置：`src/lib.rs:37-59`

### `read_auth_header_from_stdin() -> Result<&'static str>`

从 stdin 读取 API 密钥，返回 `"Bearer <key>"` 格式的静态字符串引用。密钥内存通过 `mlock(2)` 保护。

> 源码位置：`src/read_api_key.rs:16-18`（Unix）、`src/read_api_key.rs:21-29`（Windows）

## 请求/响应 Dump 机制

当指定 `--dump-dir` 时，`ExchangeDumper`（`src/dump.rs`）会为每个被接受的请求生成一对 JSON 文件：

- **命名格式**：`{sequence:06}-{timestamp_ms}-request.json` 和 `{sequence:06}-{timestamp_ms}-response.json`
- **请求 dump 内容**：method、url、headers、body（JSON 解析后存储，解析失败则以 UTF-8 文本存储）
- **响应 dump 内容**：status、headers、body

**安全措施**：`Authorization` 头和任何名称包含 `cookie` 的头在 dump 中会被替换为 `[REDACTED]`（`src/dump.rs:186-189`）。

响应 body 的 dump 通过 `ResponseBodyDump<R>` 实现，它包装了上游响应的 `Read` trait，在流式传输给客户端的同时将数据拷贝一份用于 dump。当流读取完毕（`read()` 返回 0）或对象被 drop 时写入 dump 文件（`src/dump.rs:117-134`）。

## NPM 包集成

该 crate 通过 `npm/` 目录发布为 NPM 包 `@openai/codex-responses-api-proxy`：

- **入口脚本** `npm/bin/codex-responses-api-proxy.js` 根据 `process.platform` 和 `process.arch` 确定目标三元组（支持 linux/darwin/win32 的 x64/arm64），然后从 `vendor/` 目录启动对应的原生二进制（`npm/bin/codex-responses-api-proxy.js:11-42`）
- 使用 `spawn()` 启动子进程，继承 stdio，转发 `SIGINT`/`SIGTERM`/`SIGHUP` 信号，并正确传递退出码或信号（`npm/bin/codex-responses-api-proxy.js:60-97`）
- 要求 Node.js >= 16

## 边界 Case 与注意事项

- **严格的路径限制**：仅 `POST /v1/responses` 被转发，不允许查询字符串。所有其他请求（包括 GET、其他路径）返回 `403`
- **密钥格式要求**：密钥只能包含 ASCII 字母、数字、`-` 和 `_`，最大长度受 1024 字节缓冲区限制（减去 `"Bearer "` 前缀后约 1017 字节）
- **无超时限制**：reqwest 客户端的超时设置为 `None`，以支持长时间运行的流式响应。这意味着如果上游无响应，连接会一直挂起
- **进程加固**：通过 `codex-process-hardening` crate 在 `main()` 之前执行加固，阻止调试器附加等操作
- **Windows 平台**：密钥读取使用标准 `std::io::stdin()` 而非低级 API，且 `mlock` 为空操作——README 中注明这是待改进项
- **响应头过滤**：回传响应时跳过 `content-length`、`transfer-encoding`、`connection`、`trailer`、`upgrade` 这些由 `tiny_http` 自行管理的头
- **典型使用模式**：特权用户（如 root）启动代理并通过管道传入密钥（`printenv OPENAI_API_KEY | codex-responses-api-proxy`），非特权用户通过 `http://127.0.0.1:<port>` 发送请求，密钥不会暴露给非特权进程