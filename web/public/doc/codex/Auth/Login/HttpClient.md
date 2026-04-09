# HttpClient

## 概述与职责

HttpClient 模块（`codex-rs/login/src/auth/default_client.rs`）是 Login crate 中负责**构建和配置默认 HTTP 客户端**的基础组件。它位于 **Auth → Login** 层级之下，为整个 login crate（乃至 workspace 中的其他 crate）提供统一的 `reqwest` HTTP 客户端实例。

该模块的核心职责包括：

- 构建带有 Codex 标准 User-Agent 字符串的 HTTP 客户端
- 注入默认请求头（originator、数据驻留 residency）
- 支持自定义 CA 证书（企业环境适配）
- 感知沙箱环境并禁用代理
- 管理全局 originator 标识，并提供 first-party originator 判定

在兄弟模块（ChatGPTClient、KeyringStore、Secrets）中，需要发起 HTTP 请求的组件都依赖本模块提供的客户端工厂函数。

## 关键流程

### HTTP 客户端构建流程

这是模块最核心的流程，入口为 `create_client()` 函数：

1. 调用 `get_codex_user_agent()` 生成 User-Agent 字符串，格式为：
   `{originator}/{version} ({OS类型} {OS版本}; {架构}) {终端user_agent} ({可选后缀})`
2. 创建 `reqwest::Client::builder()`，设置 User-Agent 和默认 headers
3. 检查是否处于沙箱环境（`CODEX_SANDBOX=seatbelt`），如果是则调用 `.no_proxy()` 禁用系统代理
4. 调用 `build_reqwest_client_with_custom_ca()` 加载自定义 CA 证书（通过 `CODEX_CA_CERTIFICATE` / `SSL_CERT_FILE` 环境变量）
5. 将底层 `reqwest::Client` 包装为 `CodexHttpClient` 返回

如果构建过程中任何步骤失败，会记录警告日志并回退到 `reqwest::Client::new()` 默认客户端（`default_client.rs:202-205`）。

### Originator 解析流程

Originator 标识用于区分请求来源（CLI、VSCode 插件、MCP 客户端等）：

1. 首先检查环境变量 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`，如果设置则使用该值
2. 否则使用调用方通过 `set_default_originator()` 提供的值
3. 如果都没有，回退到默认值 `"codex_cli_rs"`
4. 验证 originator 是否为合法 HTTP header value，非法时记录错误并回退到默认值

该值通过全局 `RwLock<Option<Originator>>` 存储，写入操作是一次性的——一旦初始化，再次调用 `set_default_originator()` 将返回 `AlreadyInitialized` 错误（`default_client.rs:84-85`）。

### User-Agent 构建与清洗

`get_codex_user_agent()` 组装完整的 User-Agent 字符串后，会通过 `sanitize_user_agent()` 进行清洗（`default_client.rs:162-187`）：

1. 如果候选字符串是合法的 HTTP header value，直接返回
2. 否则将非 ASCII 可打印字符替换为下划线 `_`
3. 如果清洗后仍然非法，回退到不带后缀的基础 User-Agent
4. 如果基础字符串也非法，最终回退到 originator 值本身

## 函数签名与参数说明

### `create_client() -> CodexHttpClient`

主入口。构建一个配置了 User-Agent、默认 headers、CA 证书和代理策略的 `CodexHttpClient`。

> 源码位置：`default_client.rs:190-193`

### `build_reqwest_client() -> reqwest::Client`

构建底层 `reqwest::Client`，失败时静默回退到默认客户端。适用于不需要 `CodexHttpClient` 包装的场景。

> 源码位置：`default_client.rs:201-206`

### `try_build_reqwest_client() -> Result<reqwest::Client, BuildCustomCaTransportError>`

与 `build_reqwest_client()` 相同，但返回 `Result` 以便调用方处理 CA 加载错误。

> 源码位置：`default_client.rs:212-224`

### `set_default_originator(value: String) -> Result<(), SetOriginatorError>`

设置全局 originator 标识。只能调用一次，重复调用返回 `AlreadyInitialized`。

- **value**：originator 字符串，必须是合法的 HTTP header value
- 如果 value 不合法，返回 `InvalidHeaderValue`

> 源码位置：`default_client.rs:76-89`

### `originator() -> Originator`

获取当前 originator。优先读取已初始化的全局值，否则检查环境变量覆盖，最后回退到默认值。

> 源码位置：`default_client.rs:99-118`

### `set_default_client_residency_requirement(enforce_residency: Option<ResidencyRequirement>)`

设置全局数据驻留要求。设置后，所有通过 `default_headers()` 生成的请求头中会自动包含 `x-openai-internal-codex-residency` header。

> 源码位置：`default_client.rs:91-97`

### `is_first_party_originator(originator_value: &str) -> bool`

判断 originator 是否为 Codex 第一方客户端。匹配以下值：
- `"codex_cli_rs"`（CLI）
- `"codex-tui"`（终端 UI）
- `"codex_vscode"`（VSCode 扩展）
- 以 `"Codex "` 开头的值

> 源码位置：`default_client.rs:120-125`

### `is_first_party_chat_originator(originator_value: &str) -> bool`

判断 originator 是否为 Codex 第一方**聊天**客户端。匹配 `"codex_atlas"` 和 `"codex_chatgpt_desktop"`。

> 源码位置：`default_client.rs:127-129`

### `get_codex_user_agent() -> String`

生成完整的 User-Agent 字符串，包含版本号、OS 信息、originator 和可选后缀。

> 源码位置：`default_client.rs:131-155`

### `default_headers() -> HeaderMap`

生成默认请求头，包含 `originator` header，以及可选的 `x-openai-internal-codex-residency` header。

> 源码位置：`default_client.rs:226-239`

## 类型定义

### `Originator`

```rust
pub struct Originator {
    pub value: String,           // originator 字符串值
    pub header_value: HeaderValue, // 预解析的 HTTP header value
}
```

同时持有字符串和 `HeaderValue` 形式，避免重复解析。

### `SetOriginatorError`

```rust
pub enum SetOriginatorError {
    InvalidHeaderValue,   // 提供的值不是合法的 HTTP header value
    AlreadyInitialized,   // 全局 originator 已经被设置过
}
```

## 全局状态

模块使用三个全局静态变量管理状态：

| 变量 | 类型 | 用途 |
|------|------|------|
| `USER_AGENT_SUFFIX` | `LazyLock<Mutex<Option<String>>>` | User-Agent 后缀，主要用于区分不同 MCP 客户端 |
| `ORIGINATOR` | `LazyLock<RwLock<Option<Originator>>>` | 全局 originator 标识，一次性写入 |
| `REQUIREMENTS_RESIDENCY` | `LazyLock<RwLock<Option<ResidencyRequirement>>>` | 数据驻留要求设置 |

## 配置项与环境变量

| 环境变量 | 用途 | 默认值 |
|----------|------|--------|
| `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` | 覆盖 originator 标识（内部使用） | 无 |
| `CODEX_SANDBOX` | 沙箱模式标识，值为 `"seatbelt"` 时禁用 HTTP 代理 | 无 |
| `CODEX_CA_CERTIFICATE` / `SSL_CERT_FILE` | 自定义 CA 证书路径（由 `codex_client` 处理） | 无 |

常量：
- `DEFAULT_ORIGINATOR`：`"codex_cli_rs"`——默认的 originator 标识
- `RESIDENCY_HEADER_NAME`：`"x-openai-internal-codex-residency"`——数据驻留请求头名称

## 边界 Case 与注意事项

- **Originator 只能设置一次**：`set_default_originator()` 在 originator 已初始化后会返回错误，而不是覆盖。但 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` 环境变量始终优先于 `set_default_originator()` 设置的值。
- **User-Agent 后缀的安全性**：`USER_AGENT_SUFFIX` 是一个公开的全局 `Mutex`，模块注释中明确指出这不是理想设计——它主要为 MCP 客户端区分场景设计，因为每个进程只有一个 MCP server，所以全局状态是安全的。但未来使用者需要谨慎。
- **构建失败的回退策略**：`build_reqwest_client()` 是 infallible 的——如果自定义 CA 加载失败，它会静默回退到 `reqwest::Client::new()`（无自定义 CA、无 User-Agent、无默认 headers）。需要感知失败的调用方应使用 `try_build_reqwest_client()`。
- **沙箱代理禁用**：当 `CODEX_SANDBOX=seatbelt` 时，客户端调用 `.no_proxy()` 绕过系统代理设置，避免沙箱环境中代理导致的网络问题。
- **ResidencyRequirement 目前仅支持 US**：`ResidencyRequirement::Us` 是唯一的变体（`default_client.rs:234`），header 值为 `"us"`。