# RemoteAPI — 远程插件 API 客户端

## 概述与职责

RemoteAPI 模块是插件系统（PluginSystem）中负责与 ChatGPT 后端通信的远程 API 客户端层。它位于 **Core → PluginsAndSkills → PluginSystem** 层级下，与同级的插件发现、Manifest 解析、本地插件存储等模块协作，为插件管理器（PluginsManager）提供远程操作能力。

该模块提供四项核心能力：
1. **获取远程插件状态**：拉取用户已安装的远程插件列表及启用状态
2. **获取推荐插件 ID**：按平台获取推荐（featured）插件列表
3. **启用插件**：向后端发送插件启用请求
4. **卸载插件**：向后端发送插件卸载请求

所有端点都需要 ChatGPT 认证（Bearer Token），部分操作还需要附带 `chatgpt-account-id` 请求头。模块使用 `reqwest` HTTP 客户端发起请求，并通过 `codex_login::CodexAuth` 获取认证凭据。

> 源码位置：`codex-rs/core/src/plugins/remote.rs`

## 关键流程

### 插件状态查询流程（`fetch_remote_plugin_status`）

1. 验证 `auth` 参数存在且为 ChatGPT 认证模式（非 API Key）
2. 从 `config.chatgpt_base_url` 构建请求 URL：`{base_url}/plugins/list`
3. 通过 `build_reqwest_client()` 创建 HTTP 客户端，设置 30 秒超时
4. 附加 Bearer Token；若存在 `account_id`，追加 `chatgpt-account-id` 请求头
5. 发起 GET 请求，校验 HTTP 状态码
6. 将响应体反序列化为 `Vec<RemotePluginStatusSummary>`

> 源码位置：`codex-rs/core/src/plugins/remote.rs:119-161`

### 推荐插件查询流程（`fetch_remote_featured_plugin_ids`）

1. 构建请求 URL：`{base_url}/plugins/featured`，附加 `platform` 查询参数（默认 `Product::Codex`）
2. 设置 10 秒超时（比状态查询更短）
3. **认证为可选**：仅当 `auth` 存在且为 ChatGPT 模式时附加 Token 和 account-id
4. 发起 GET 请求，将响应反序列化为 `Vec<String>`（插件 ID 列表）

> 源码位置：`codex-rs/core/src/plugins/remote.rs:163-206`

### 插件变更流程（enable / uninstall）

`enable_remote_plugin` 和 `uninstall_remote_plugin` 均委托给内部函数 `post_remote_plugin_mutation`，仅 `action` 参数不同（`"enable"` 或 `"uninstall"`）。

1. 通过 `ensure_chatgpt_auth()` 强制验证认证（认证为必需）
2. 调用 `remote_plugin_mutation_url()` 构建 URL：`{base_url}/plugins/{plugin_id}/{action}`，使用 `url::Url` 的路径段操作确保 URL 格式正确
3. 创建 HTTP 客户端，设置 30 秒超时，附加 Bearer Token 和可选 account-id
4. 发起 **POST** 请求
5. 将响应反序列化为 `RemotePluginMutationResponse`（包含 `id` 和 `enabled` 字段）
6. **响应校验**：
   - 验证返回的 `id` 与请求的 `plugin_id` 一致，否则返回 `UnexpectedPluginId` 错误
   - 验证返回的 `enabled` 状态与预期一致（enable → `true`，uninstall → `false`），否则返回 `UnexpectedEnabledState` 错误

> 源码位置：`codex-rs/core/src/plugins/remote.rs:240-293`

## 函数签名与参数说明

### `fetch_remote_plugin_status(config, auth) -> Result<Vec<RemotePluginStatusSummary>, RemotePluginFetchError>`

查询当前用户所有远程插件的状态。**可见性**：`pub(crate)`。

- **config**: `&Config` — 提供 `chatgpt_base_url`
- **auth**: `Option<&CodexAuth>` — ChatGPT 认证凭据，**必需**（`None` 返回 `AuthRequired`）

### `fetch_remote_featured_plugin_ids(config, auth, product) -> Result<Vec<String>, RemotePluginFetchError>`

获取平台推荐插件 ID 列表。**可见性**：`pub`（跨 crate 公开）。

- **config**: `&Config` — 提供 `chatgpt_base_url`
- **auth**: `Option<&CodexAuth>` — 可选；若提供且为 ChatGPT 认证则附加 Token
- **product**: `Option<Product>` — 目标平台，默认 `Product::Codex`，通过 `to_app_platform()` 转换为查询参数

### `enable_remote_plugin(config, auth, plugin_id) -> Result<(), RemotePluginMutationError>`

启用指定插件。**可见性**：`pub(crate)`。

### `uninstall_remote_plugin(config, auth, plugin_id) -> Result<(), RemotePluginMutationError>`

卸载指定插件。**可见性**：`pub(crate)`。

## 类型定义

### `RemotePluginStatusSummary`

插件状态摘要，由 `/plugins/list` 端点返回。

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `String` | 插件名称 |
| `marketplace_name` | `String` | 所属市场名称，默认 `"openai-curated"` |
| `enabled` | `bool` | 是否已启用 |

### `RemotePluginMutationResponse`（内部类型）

变更操作的响应体，使用 `camelCase` 反序列化。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `String` | 插件 ID |
| `enabled` | `bool` | 当前启用状态 |

## 错误类型

### `RemotePluginFetchError`

查询类操作（status / featured）的错误枚举：

| 变体 | 触发场景 |
|------|----------|
| `AuthRequired` | 未提供认证信息 |
| `UnsupportedAuthMode` | 使用了 API Key 而非 ChatGPT 认证 |
| `AuthToken(io::Error)` | 读取 token 失败 |
| `Request { url, source }` | HTTP 请求发送失败 |
| `UnexpectedStatus { url, status, body }` | 非成功 HTTP 状态码 |
| `Decode { url, source }` | JSON 反序列化失败 |

### `RemotePluginMutationError`

变更类操作（enable / uninstall）的错误枚举，除包含与 `FetchError` 类似的变体外，还包含：

| 变体 | 触发场景 |
|------|----------|
| `InvalidBaseUrl(url::ParseError)` | `chatgpt_base_url` 不是合法 URL |
| `InvalidBaseUrlPath` | URL 不支持路径段操作（如 `cannot-be-a-base` URL） |
| `UnexpectedPluginId { expected, actual }` | 响应返回的插件 ID 与请求不匹配 |
| `UnexpectedEnabledState { plugin_id, expected_enabled, actual_enabled }` | 响应返回的启用状态与预期不符 |

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|------|------|
| `DEFAULT_REMOTE_MARKETPLACE_NAME` | `"openai-curated"` | `RemotePluginStatusSummary.marketplace_name` 的默认值 |
| `REMOTE_PLUGIN_FETCH_TIMEOUT` | 30 秒 | 插件状态查询超时 |
| `REMOTE_FEATURED_PLUGIN_FETCH_TIMEOUT` | 10 秒 | 推荐插件查询超时 |
| `REMOTE_PLUGIN_MUTATION_TIMEOUT` | 30 秒 | 插件变更操作超时 |

运行时配置依赖 `Config.chatgpt_base_url` 作为所有 API 端点的基础 URL。

## 边界 Case 与注意事项

- **认证要求不对称**：`fetch_remote_plugin_status` 和变更操作**强制要求** ChatGPT 认证，而 `fetch_remote_featured_plugin_ids` 的认证是**可选的**——未认证时仍可拉取推荐列表（但不会附加用户 Token）。
- **API Key 不被支持**：所有需要认证的操作都显式拒绝非 ChatGPT 认证模式（如 API Key），返回 `UnsupportedAuthMode`。
- **URL 构建差异**：查询操作使用简单的字符串拼接构建 URL，而变更操作使用 `url::Url` 的路径段 API（`path_segments_mut`），包含对 `cannot-be-a-base` URL 的处理（返回 `InvalidBaseUrlPath`）。
- **响应校验严格**：变更操作不仅校验 HTTP 状态码，还会验证响应体中的 `id` 和 `enabled` 字段是否与预期一致，确保后端行为符合契约。
- **超时策略**：推荐插件查询的超时时间（10 秒）显著短于其他操作（30 秒），反映了该端点对响应速度的更高要求。