# ProviderRegistry（模型提供者配置注册表）

## 概述与职责

ProviderRegistry 是 `codex-model-provider-info` crate 的核心模块，属于 **ModelProviders** 层的基础设施组件。它定义了 `ModelProviderInfo` 这一统一的 schema，用于声明任意 LLM 提供者的连接配置——包括 base URL、API key 来源、认证命令、wire 协议、HTTP 头、重试与超时策略等。

该模块内置了三个开箱即用的提供者定义：**OpenAI**、**Ollama** 和 **LM Studio**，并支持用户通过 `~/.codex/config.toml` 的 `model_providers` 字段自定义或覆盖提供者。最终，`ModelProviderInfo` 可以转换为 `codex-api` crate 的 `Provider` 结构体，供 HTTP 客户端直接使用。

在整体架构中，ProviderRegistry 位于 ModelProviders 和 Config 的交汇处：Config 层读取用户配置产出 `ModelProviderInfo`，ModelProviders 层消费它来构建 API 客户端。

## 关键流程

### 提供者注册与查找流程

1. 调用 `built_in_model_providers(openai_base_url)` 生成内置提供者的 `HashMap<String, ModelProviderInfo>`（`src/lib.rs:315-339`）
2. 内置条目包含三个 key：`"openai"`、`"ollama"`、`"lmstudio"`
3. 用户在 `config.toml` 中定义的 `model_providers` 条目会在运行时覆盖或扩展此 HashMap

### ModelProviderInfo → ApiProvider 转换流程

`to_api_provider()` 方法（`src/lib.rs:184-212`）是该模块最核心的转换逻辑：

1. **确定 base URL**：若提供者未配置 `base_url`，根据 `auth_mode` 选择默认值——ChatGPT 模式用 `https://chatgpt.com/backend-api/codex`，否则用 `https://api.openai.com/v1`
2. **构建 HTTP 头**：调用 `build_header_map()` 合并两类头——`http_headers`（静态值）和 `env_http_headers`（从环境变量动态读取值，跳过未设置或为空的变量）
3. **组装重试配置**：使用 `request_max_retries()` 的有效值（用户值或默认 4 次，上限 100），设置 200ms 基础延迟，启用 5xx 和传输层重试，不重试 429
4. **输出 `ApiProvider`**：包含 name、base_url、query_params、headers、retry 配置和 stream idle timeout

### API Key 获取流程

`api_key()` 方法（`src/lib.rs:217-233`）：

1. 检查 `env_key` 是否配置
2. 若有，从对应环境变量读取值（忽略空白字符串）
3. 找不到时返回 `CodexErr::EnvVar` 错误，可附带 `env_key_instructions` 帮助用户设置

### OSS 提供者（Ollama / LM Studio）构建流程

`create_oss_provider()` 函数（`src/lib.rs:341-358`）：

1. 尝试从 `CODEX_OSS_PORT` 环境变量读取端口，否则使用默认端口（Ollama: 11434，LM Studio: 1234）
2. 尝试从 `CODEX_OSS_BASE_URL` 环境变量读取完整 URL，否则拼接 `http://localhost:{port}/v1`
3. 调用 `create_oss_provider_with_base_url()` 创建最小化的 `ModelProviderInfo`（无认证、无自定义 header、不支持 WebSocket）

## 类型定义

### `ModelProviderInfo`

核心结构体，声明一个模型提供者的完整配置（`src/lib.rs:75-124`）：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | `String` | — | 友好的显示名称 |
| `base_url` | `Option<String>` | — | 提供者 API 的 base URL |
| `env_key` | `Option<String>` | — | 存储 API key 的环境变量名 |
| `env_key_instructions` | `Option<String>` | — | 帮助用户设置 API key 的说明文字 |
| `experimental_bearer_token` | `Option<String>` | — | 直接配置的 Bearer Token（不推荐，安全性较差） |
| `auth` | `Option<ModelProviderAuthInfo>` | — | 命令式认证配置（见下文） |
| `wire_api` | `WireApi` | `Responses` | 提供者使用的 wire 协议 |
| `query_params` | `Option<HashMap<String, String>>` | — | 附加到 URL 的查询参数 |
| `http_headers` | `Option<HashMap<String, String>>` | — | 静态 HTTP 请求头 |
| `env_http_headers` | `Option<HashMap<String, String>>` | — | 从环境变量读取值的 HTTP 请求头 |
| `request_max_retries` | `Option<u64>` | 4 | HTTP 请求最大重试次数（上限 100） |
| `stream_max_retries` | `Option<u64>` | 5 | 流式连接断开后的最大重试次数（上限 100） |
| `stream_idle_timeout_ms` | `Option<u64>` | 300,000 (5 min) | 流式响应空闲超时时间 |
| `websocket_connect_timeout_ms` | `Option<u64>` | 15,000 (15s) | WebSocket 连接超时时间 |
| `requires_openai_auth` | `bool` | `false` | 是否需要 OpenAI 登录认证（ChatGPT 账号或 API key） |
| `supports_websockets` | `bool` | `false` | 是否支持 Responses API 的 WebSocket 传输 |

### `WireApi`

Wire 协议枚举（`src/lib.rs:41-70`）：

- `Responses`（默认）——对应 OpenAI `/v1/responses` 端点

> 注意：`chat` 变体已被移除。反序列化 `wire_api = "chat"` 会产生明确的错误提示，引导用户迁移到 `responses`。

### `ModelProviderAuthInfo`

命令式认证配置（定义在 `codex-protocol` crate，`protocol/src/config_types.rs:273-293`）：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `command` | `String` | — | 获取 token 的命令（通过 PATH 解析或相对于 `cwd`） |
| `args` | `Vec<String>` | `[]` | 命令参数 |
| `timeout_ms` | `NonZeroU64` | 5,000 | 等待命令执行完成的最大时间 |
| `refresh_interval_ms` | `u64` | 300,000 | 缓存 token 的最大有效期（0 表示禁用主动刷新） |
| `cwd` | `AbsolutePathBuf` | 当前目录 | 执行命令时的工作目录 |

## 函数签名

### `built_in_model_providers(openai_base_url: Option<String>) -> HashMap<String, ModelProviderInfo>`

返回所有内置提供者的映射表。`openai_base_url` 可覆盖 OpenAI 提供者的默认 base URL。

> 源码位置：`src/lib.rs:315-339`

### `ModelProviderInfo::to_api_provider(&self, auth_mode: Option<AuthMode>) -> CodexResult<ApiProvider>`

将 `ModelProviderInfo` 转换为 `codex-api` 的 `ApiProvider`，可直接用于 HTTP 客户端。`auth_mode` 影响默认 base URL 的选择。

> 源码位置：`src/lib.rs:184-212`

### `ModelProviderInfo::api_key(&self) -> CodexResult<Option<String>>`

从环境变量读取 API key。如果 `env_key` 已配置但环境变量未设置或为空，返回错误。

> 源码位置：`src/lib.rs:217-233`

### `ModelProviderInfo::validate(&self) -> Result<(), String>`

校验配置的合法性。主要检查 `auth` 配置与其他认证方式（`env_key`、`experimental_bearer_token`、`requires_openai_auth`）不能同时存在。

> 源码位置：`src/lib.rs:127-155`

### `create_oss_provider(default_provider_port: u16, wire_api: WireApi) -> ModelProviderInfo`

为本地 OSS 提供者（Ollama、LM Studio）创建配置，端口可通过 `CODEX_OSS_PORT` 环境变量覆盖。

> 源码位置：`src/lib.rs:341-358`

## 配置项与默认值

### 全局常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `DEFAULT_STREAM_IDLE_TIMEOUT_MS` | 300,000 | 流式响应空闲超时（5 分钟） |
| `DEFAULT_STREAM_MAX_RETRIES` | 5 | 流式连接重试次数 |
| `DEFAULT_REQUEST_MAX_RETRIES` | 4 | HTTP 请求重试次数 |
| `DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS` | 15,000 | WebSocket 连接超时（15 秒） |
| `MAX_STREAM_MAX_RETRIES` | 100 | 用户可配置的流式重试上限 |
| `MAX_REQUEST_MAX_RETRIES` | 100 | 用户可配置的请求重试上限 |
| `DEFAULT_OLLAMA_PORT` | 11,434 | Ollama 默认端口 |
| `DEFAULT_LMSTUDIO_PORT` | 1,234 | LM Studio 默认端口 |

### 环境变量

| 变量 | 用途 |
|------|------|
| `CODEX_OSS_PORT` | 覆盖 OSS 提供者的默认端口 |
| `CODEX_OSS_BASE_URL` | 覆盖 OSS 提供者的完整 base URL（优先级高于端口） |
| `OPENAI_ORGANIZATION` | 通过 `env_http_headers` 注入 `OpenAI-Organization` 头 |
| `OPENAI_PROJECT` | 通过 `env_http_headers` 注入 `OpenAI-Project` 头 |

## 内置提供者对比

| 提供者 ID | 名称 | Base URL | 认证方式 | WebSocket | 自定义头 |
|-----------|------|----------|----------|-----------|----------|
| `openai` | OpenAI | `https://api.openai.com/v1`（默认） | OpenAI Auth（登录/API key） | 支持 | `version`、`OpenAI-Organization`（env）、`OpenAI-Project`（env） |
| `ollama` | gpt-oss | `http://localhost:11434/v1` | 无 | 不支持 | 无 |
| `lmstudio` | gpt-oss | `http://localhost:1234/v1` | 无 | 不支持 | 无 |

## 边界 Case 与注意事项

- **`wire_api = "chat"` 已移除**：反序列化时会产生明确错误信息，引导用户迁移到 `responses` 并附带讨论链接。类似地，`ollama-chat` 提供者 ID 也已移除（常量 `LEGACY_OLLAMA_CHAT_PROVIDER_ID`）。

- **`auth` 与其他认证方式互斥**：`validate()` 方法确保 `auth`（命令式认证）不能与 `env_key`、`experimental_bearer_token` 或 `requires_openai_auth` 同时使用。

- **重试次数有硬上限**：`request_max_retries` 和 `stream_max_retries` 的用户配置值会被 `min(value, 100)` 截断，防止不合理的大值。

- **env_http_headers 的静默跳过**：如果 `env_http_headers` 引用的环境变量未设置或为空，该头会被静默忽略而非报错（`build_header_map()` 的 `src/lib.rs:169-179`）。

- **OSS 提供者环境变量优先级**：`CODEX_OSS_BASE_URL` > `CODEX_OSS_PORT` > 默认端口。这些环境变量标记为实验性，未来可能迁移到 config.toml。

- **OpenAI 的 `version` 头**：OpenAI 提供者会自动在请求中附带 `version` HTTP 头，值为 crate 编译时的 `CARGO_PKG_VERSION`。