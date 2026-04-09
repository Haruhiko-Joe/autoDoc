# Utilities（共享工具函数）

## 概述与职责

`util.rs` 是 **CloudTasks → TasksTUI** 模块内的共享工具函数集合，为云任务 TUI 应用提供认证、网络请求、URL 处理、错误日志和时间格式化等基础能力。它不包含业务逻辑，而是被 TUI 主循环和后端客户端调用的"胶水层"。

**在系统中的位置**：CloudTasks 是 Codex 的远程云任务管理子系统，TasksTUI 是其中面向终端用户的 TUI 应用 crate（`codex-cloud-tasks`）。`util.rs` 与同 crate 中的 UI 渲染、事件循环、状态管理等模块并列，为它们提供底层辅助。CloudTasks 依赖 Auth（认证）和 Config（配置）两个顶层模块，而 `util.rs` 正是这些依赖的具体接入点。

---

## 关键流程

### ChatGPT 认证请求头构建流程

这是本模块最核心的函数 `build_chatgpt_headers()`，负责组装与 ChatGPT 后端通信所需的全部 HTTP 请求头：

1. 调用 `set_user_agent_suffix("codex_cloud_tasks_tui")` 设置 User-Agent 后缀标识（`util.rs:80`）
2. 通过 `codex_login::default_client::get_codex_user_agent()` 获取完整 User-Agent 字符串，插入 `USER_AGENT` 头
3. 调用 `load_auth_manager()` 从 `codex-core` 的 `Config` 加载认证管理器（`util.rs:87`）
4. 通过 `AuthManager::auth()` 获取当前认证凭据，提取 token
5. 若 token 非空，构造 `Bearer <token>` 格式的 `Authorization` 头
6. 尝试从认证凭据的 `get_account_id()` 获取账户 ID；若不可用，回退到 `extract_chatgpt_account_id()` 从 JWT payload 中解析
7. 若获取到账户 ID，插入 `ChatGPT-Account-Id` 自定义请求头

### JWT 账户 ID 提取流程

`extract_chatgpt_account_id()` 从 JWT token 字符串中提取 ChatGPT 账户 ID（`util.rs:46-60`）：

1. 按 `.` 分割 token 为 header、payload、signature 三部分，校验均非空
2. 使用 URL-safe Base64（无 padding）解码 payload 部分
3. 将解码结果解析为 JSON，从 `["https://api.openai.com/auth"]["chatgpt_account_id"]` 路径提取字符串值

### URL 规范化流程

`normalize_base_url()` 将用户配置的 base URL 转换为后端客户端所需的标准形式（`util.rs:31-43`）：

1. 去除末尾所有 `/` 字符
2. 如果是 ChatGPT 域名（`chatgpt.com` 或 `chat.openai.com`）且路径中不含 `/backend-api`，自动追加该后缀

---

## 函数签名与参数说明

### `build_chatgpt_headers() -> HeaderMap` （async）

构建 ChatGPT 后端请求所需的完整请求头集合。包含 `User-Agent`、`Authorization`（Bearer token）和 `ChatGPT-Account-Id`。认证失败时静默降级——仅包含 User-Agent 头。

> 源码位置：`codex-rs/cloud-tasks/src/util.rs:74-106`

### `load_auth_manager() -> Option<AuthManager>` （async）

从 `codex-core` 的 `Config::load_with_cli_overrides` 加载配置，并据此创建 `AuthManager` 实例。

- 传入空的 CLI overrides（`Vec::new()`），代码注释标注了 TODO：待云任务支持 CLI 覆盖参数后补充
- `enable_codex_api_key_env` 硬编码为 `false`，即不从环境变量读取 API key

> 源码位置：`codex-rs/cloud-tasks/src/util.rs:62-70`

### `extract_chatgpt_account_id(token: &str) -> Option<String>`

从 JWT token 的 payload 中提取 ChatGPT 账户 ID。

- **token**：完整的 JWT 字符串（`header.payload.signature` 格式）
- **返回值**：成功时返回 `Some(account_id)`，token 格式不合法或不含该字段时返回 `None`

> 源码位置：`codex-rs/cloud-tasks/src/util.rs:46-60`

### `normalize_base_url(input: &str) -> String`

规范化后端 base URL。

- **input**：用户配置的原始 URL
- **返回值**：去除尾部斜杠、ChatGPT 域名自动追加 `/backend-api` 后的 URL

> 源码位置：`codex-rs/cloud-tasks/src/util.rs:31-43`

### `task_url(base_url: &str, task_id: &str) -> String`

根据后端 base URL 和任务 ID 生成浏览器可访问的任务页面 URL。

- 处理多种 URL 后缀模式：`/backend-api`、`/api/codex`、`/codex`，以及无已知后缀的 fallback
- 所有情况最终生成 `{root}/codex/tasks/{task_id}` 形式的 URL

> 源码位置：`codex-rs/cloud-tasks/src/util.rs:109-121`

### `set_user_agent_suffix(suffix: &str)`

设置全局 User-Agent 后缀。通过 `codex_login::default_client::USER_AGENT_SUFFIX` 全局锁写入。

> 源码位置：`codex-rs/cloud-tasks/src/util.rs:10-14`

### `append_error_log(message: impl AsRef<str>)`

将带时间戳的错误消息追加写入当前工作目录下的 `error.log` 文件。

- 时间戳格式为 RFC 3339（UTC）
- 写入失败时静默忽略（所有 I/O 错误均被 `let _` 丢弃）

> 源码位置：`codex-rs/cloud-tasks/src/util.rs:16-26`

### `format_relative_time(reference: DateTime<Utc>, ts: DateTime<Utc>) -> String`

将时间戳格式化为相对于参考时间的人类可读字符串。

- < 60 秒：`"{n}s ago"`
- < 60 分钟：`"{n}m ago"`
- < 24 小时：`"{n}h ago"`
- >= 24 小时：转换为本地时区，输出 `"Apr  4 15:30"` 格式的绝对时间

> 源码位置：`codex-rs/cloud-tasks/src/util.rs:123-141`

### `format_relative_time_now(ts: DateTime<Utc>) -> String`

`format_relative_time` 的便捷封装，以当前时刻作为参考时间。

> 源码位置：`codex-rs/cloud-tasks/src/util.rs:143-145`

---

## 依赖关系

本模块的外部 crate 依赖（从 `Cargo.toml` 和 import 语句可见）：

| 依赖 | 用途 |
|------|------|
| `codex-core` | 加载 `Config`（codex_home、认证存储模式） |
| `codex-login` | 提供 `AuthManager`、User-Agent 工具函数、全局 UA 后缀 |
| `base64` | JWT payload 的 URL-safe Base64 解码 |
| `chrono` | UTC/本地时间处理、相对时间计算 |
| `reqwest` | `HeaderMap` / `HeaderValue` / `HeaderName` 类型 |
| `serde_json` | JWT payload JSON 解析 |

---

## 边界 Case 与注意事项

- **认证静默降级**：`build_chatgpt_headers()` 在 Config 加载失败、认证失败、token 为空等任何环节出错时均不报错，只是返回不含 `Authorization` 头的 `HeaderMap`。调用方需要处理未认证请求可能被后端拒绝的情况。

- **error.log 写入位置**：`append_error_log` 写入的是**当前工作目录**下的 `error.log`，而非固定的 codex_home 目录。如果工作目录不可写，日志会静默丢失。

- **JWT 解析的局限**：`extract_chatgpt_account_id` 仅做 Base64 解码和 JSON 字段提取，不验证 JWT 签名。这是有意为之——此处只需读取 claim，不需要做安全验证。

- **负时间差处理**：`format_relative_time` 中若 `ts` 晚于 `reference`（时钟偏移等场景），秒数被钳位为 0，显示为 `"0s ago"`。

- **CLI overrides 未接入**：`load_auth_manager` 中传入空的 `Vec::new()` 作为 CLI overrides，注释标注了 TODO。这意味着目前云任务模块不支持通过命令行参数覆盖配置。