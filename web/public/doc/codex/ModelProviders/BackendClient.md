# BackendClient

## 概述与职责

BackendClient 是 Codex 与 ChatGPT 后端 API 通信的认证 HTTP 客户端，由两个 Rust crate 组成：

- **`codex-backend-client`**：核心客户端实现，提供速率限制查询、额度查询、云任务管理等高层 API 方法
- **`codex-backend-openapi-models`**：由 OpenAPI Generator 自动生成的请求/响应模型类型，供客户端反序列化使用

在系统架构中，BackendClient 位于 **ModelProviders** 层，是 LLM 集成层的组成部分。它依赖 **Auth** 模块获取认证凭据（Bearer Token），被 **CloudTasks** 模块用于管理远程云端任务，也被 **Core** 和 **AppServer** 等上层模块间接使用。同层的兄弟模块包括 OpenAI Responses API 客户端、Realtime API 客户端、本地模型提供者（Ollama、LM Studio）等。

## 关键流程

### 客户端初始化与 URL 规范化

`Client::new()` 接受一个 base URL 并执行以下规范化逻辑（`codex-rs/backend-client/src/client.rs:111-134`）：

1. 去除尾部斜杠
2. 如果 URL 以 `https://chatgpt.com` 或 `https://chat.openai.com` 开头且不包含 `/backend-api`，自动追加 `/backend-api` 路径段
3. 根据 URL 是否包含 `/backend-api` 推断 `PathStyle`——包含则使用 `ChatGptApi` 风格（`/wham/...` 路径），否则使用 `CodexApi` 风格（`/api/codex/...` 路径）
4. 通过 `build_reqwest_client_with_custom_ca()` 构建支持自定义 CA 的 reqwest HTTP 客户端

### 从认证信息构建客户端

`Client::from_auth()` 是更常用的构造方式（`codex-rs/backend-client/src/client.rs:136-145`）：

1. 从 `CodexAuth` 中提取 Bearer Token
2. 设置 Codex 专用的 User-Agent 头
3. 如果认证信息中包含 `account_id`，设置 `ChatGPT-Account-Id` 请求头

### 双路径风格（PathStyle）

所有 API 方法都通过 `PathStyle` 枚举决定请求路径前缀（`codex-rs/backend-client/src/client.rs:82-98`）：

| PathStyle | 路径前缀 | 适用场景 |
|-----------|----------|----------|
| `CodexApi` | `/api/codex/...` | Codex 专用后端 |
| `ChatGptApi` | `/wham/...` | ChatGPT backend-api |

路径风格在客户端初始化时根据 base URL 自动推断，也可通过 `with_path_style()` 手动覆盖。

### 速率限制查询流程

1. `get_rate_limits_many()` 向 `/usage` 端点发送 GET 请求（`codex-rs/backend-client/src/client.rs:257-266`）
2. 将响应反序列化为 `RateLimitStatusPayload`，其中包含主速率限制、额度状态、附加速率限制
3. `rate_limit_snapshots_from_payload()` 将 OpenAPI 模型转换为 `codex-protocol` 定义的 `RateLimitSnapshot` 列表（`codex-rs/backend-client/src/client.rs:396-419`）：
   - 第一个 snapshot 固定以 `"codex"` 作为 `limit_id`，承载主速率限制和额度信息
   - 后续 snapshot 来自 `additional_rate_limits` 数组，每个对应一个额外的计量特性
4. `get_rate_limits()` 是便捷方法，从多个 snapshot 中优先选择 `limit_id == "codex"` 的条目，否则返回第一个（`codex-rs/backend-client/src/client.rs:248-255`）

### 云任务管理流程

- **列表查询** `list_tasks()`：GET `/tasks/list`，支持 `limit`、`task_filter`、`environment_id`、`cursor` 四个可选查询参数，用于分页和筛选（`codex-rs/backend-client/src/client.rs:268-302`）
- **详情查询** `get_task_details()`：GET `/tasks/{task_id}`，返回 `CodeTaskDetailsResponse`，包含用户 Turn、助手 Turn、Diff Turn 三个当前回合（`codex-rs/backend-client/src/client.rs:304-321`）
- **创建任务** `create_task()`：POST `/tasks`，接受任意 JSON body，从响应中提取 `task.id` 或顶层 `id` 作为返回值（`codex-rs/backend-client/src/client.rs:362-393`）
- **查询兄弟 Turn** `list_sibling_turns()`：GET `/tasks/{task_id}/turns/{turn_id}/sibling_turns`（`codex-rs/backend-client/src/client.rs:323-341`）

### 请求执行与错误处理

客户端内部有两种请求执行路径：

- `exec_request()`：标准路径，非 2xx 状态码时通过 `anyhow::bail!` 返回通用错误（`codex-rs/backend-client/src/client.rs:191-210`）
- `exec_request_detailed()`：结构化错误路径，返回 `RequestError::UnexpectedStatus`，保留 HTTP 状态码、Content-Type 和响应体，调用方可通过 `is_unauthorized()` 判断是否为 401 错误（`codex-rs/backend-client/src/client.rs:212-237`）

目前只有 `get_config_requirements_file()` 使用 `exec_request_detailed()`，其余方法均使用 `exec_request()`。

## 函数签名与参数说明

### `Client::new(base_url: impl Into<String>) -> Result<Self>`

创建未认证的客户端实例。自动规范化 ChatGPT 域名并推断路径风格。

### `Client::from_auth(base_url: impl Into<String>, auth: &CodexAuth) -> Result<Self>`

从 `CodexAuth` 认证信息创建已认证的客户端，自动配置 Bearer Token、User-Agent 和 Account ID。

### Builder 方法

| 方法 | 参数 | 说明 |
|------|------|------|
| `with_bearer_token(token)` | `impl Into<String>` | 设置 Authorization Bearer Token |
| `with_user_agent(ua)` | `impl Into<String>` | 设置 User-Agent 头 |
| `with_chatgpt_account_id(id)` | `impl Into<String>` | 设置 ChatGPT-Account-Id 头 |
| `with_path_style(style)` | `PathStyle` | 手动覆盖路径风格 |

### `get_rate_limits() -> Result<RateLimitSnapshot>`

查询速率限制，返回优先级最高的单个快照（`limit_id == "codex"` 优先）。

### `get_rate_limits_many() -> Result<Vec<RateLimitSnapshot>>`

查询所有速率限制，包括主限制和附加限制，返回完整快照列表。

### `list_tasks(limit, task_filter, environment_id, cursor) -> Result<PaginatedListTaskListItem>`

分页查询云任务列表。所有参数均为可选。

- **limit**：`Option<i32>` — 每页返回数量
- **task_filter**：`Option<&str>` — 任务筛选条件
- **environment_id**：`Option<&str>` — 环境 ID 筛选
- **cursor**：`Option<&str>` — 分页游标

### `get_task_details(task_id: &str) -> Result<CodeTaskDetailsResponse>`

查询单个任务的详情，包含当前用户 Turn、助手 Turn 和 Diff Turn。

### `create_task(request_body: serde_json::Value) -> Result<String>`

创建新任务，返回任务 ID。请求体为任意 JSON Value。

### `list_sibling_turns(task_id: &str, turn_id: &str) -> Result<TurnAttemptsSiblingTurnsResponse>`

查询指定 Turn 的兄弟 Turn 列表。

### `get_config_requirements_file() -> Result<ConfigFileResponse, RequestError>`

获取后端管理的 requirements 配置文件。这是唯一返回结构化 `RequestError` 的方法，调用方可据此区分 401 未认证和其他错误。

## 接口/类型定义

### `RequestError`（`codex-rs/backend-client/src/client.rs:25-80`）

```rust
pub enum RequestError {
    UnexpectedStatus { method, url, status, content_type, body },
    Other(anyhow::Error),
}
```

提供 `status()` 获取 HTTP 状态码和 `is_unauthorized()` 便捷判断。

### `PathStyle`（`codex-rs/backend-client/src/client.rs:82-98`）

```rust
pub enum PathStyle {
    CodexApi,   // /api/codex/…
    ChatGptApi, // /wham/…
}
```

### Cloud Tasks 手写模型（`codex-rs/backend-client/src/types.rs:19-319`）

由于 OpenAPI 生成的任务详情模型使用 `HashMap<String, Value>` 表示 Turn（缺乏类型安全），`types.rs` 中手写了一套结构化模型：

- **`CodeTaskDetailsResponse`**：包含 `current_user_turn`、`current_assistant_turn`、`current_diff_task_turn` 三个可选 `Turn`
- **`Turn`**：包含 `id`、`turn_status`、`input_items`、`output_items`、`worklog`、`error` 等字段
- **`TurnItem`**：Turn 中的单个条目，有 `kind`（如 `"message"`、`"output_diff"`、`"pr"`）、`content`、`diff` 等
- **`ContentFragment`**：内容片段，使用 `#[serde(untagged)]` 支持结构化内容（带 `content_type` 和 `text`）或纯文本字符串
- **`Worklog` / `WorklogMessage`**：任务工作日志，包含 author 角色和内容
- **`TurnError`**：错误信息，包含 `code` 和 `message`

### `CodeTaskDetailsResponseExt` trait（`codex-rs/backend-client/src/types.rs:260-305`）

为 `CodeTaskDetailsResponse` 提供便捷提取方法：

| 方法 | 返回值 | 说明 |
|------|--------|------|
| `unified_diff()` | `Option<String>` | 从 diff_task_turn 或 assistant_turn 提取 unified diff |
| `assistant_text_messages()` | `Vec<String>` | 提取助手文本输出（含 worklog） |
| `user_text_prompt()` | `Option<String>` | 提取用户输入的 prompt 文本 |
| `assistant_error_message()` | `Option<String>` | 提取助手错误摘要 |

### OpenAPI 生成模型（`codex-rs/codex-backend-openapi-models/`）

| 类型 | 说明 |
|------|------|
| `RateLimitStatusPayload` | 速率限制查询的顶层响应，含 `plan_type`、`rate_limit`、`credits`、`additional_rate_limits` |
| `PlanType` | 用户计划类型枚举（Guest、Free、Go、Plus、Pro、Team、Business、Enterprise 等 15 种） |
| `RateLimitStatusDetails` | 速率限制详情，含 `allowed`、`limit_reached`、主/次窗口 |
| `RateLimitWindowSnapshot` | 单个限制窗口快照：`used_percent`、`limit_window_seconds`、`reset_at` |
| `CreditStatusDetails` | 额度状态：`has_credits`、`unlimited`、`balance` |
| `AdditionalRateLimitDetails` | 附加速率限制：`limit_name`、`metered_feature`、`rate_limit` |
| `PaginatedListTaskListItem` | 分页任务列表，含 `items` 和可选 `cursor` |
| `TaskListItem` | 任务列表条目：`id`、`title`、`archived`、`has_unread_turn`、`pull_requests` |
| `ConfigFileResponse` | 配置文件响应：`contents`、`sha256`、`updated_at` |
| `TaskResponse` | 完整任务响应（用于 OpenAPI 生成的 `CodeTaskDetailsResponse`） |
| `ExternalPullRequestResponse` | 任务关联的外部 PR |
| `GitPullRequest` | Git PR 详情：`number`、`url`、`state`、`merged`、`mergeable` 等 |

这些生成模型使用 `serde_with::rust::double_option` 处理 `Option<Option<T>>` 的 JSON null 与字段缺失的区别。

## 配置项与默认值

- **User-Agent**：未通过 `with_user_agent()` 设置时，默认为 `"codex-cli"`（`codex-rs/backend-client/src/client.rs:174`）
- **TLS**：通过 `build_reqwest_client_with_custom_ca()` 支持自定义 CA 证书，使用 rustls 作为 TLS 后端
- **路径风格**：默认根据 base URL 自动推断，可通过 `with_path_style()` 覆盖

## 边界 Case 与注意事项

- **双重 Option 模式**：OpenAPI 生成的模型大量使用 `Option<Option<Box<T>>>` 表示"字段可能缺失（外层 None）或显式为 null（内层 None）"。代码中通过 `.flatten()` 统一处理这两种情况。
- **手写模型与生成模型并存**：`types.rs` 中的 `CodeTaskDetailsResponse` 是手写的强类型版本，而 `codex-backend-openapi-models` 中同名类型使用 `HashMap<String, Value>` 表示 Turn。客户端导出的是手写版本，提供了更好的类型安全和便捷方法。
- **PlanType 映射**：`map_plan_type()` 将 OpenAPI 的 15 种 `PlanType` 映射到 `codex-protocol` 的 `AccountPlanType`，其中 `Guest`、`FreeWorkspace`、`Quorum`、`K12` 映射为 `Unknown`，`Edu` 和 `Education` 合并为 `Edu`（`codex-rs/backend-client/src/client.rs:470-491`）。
- **窗口时间转换**：`window_minutes_from_seconds()` 将秒转换为分钟时使用向上取整（`(seconds + 59) / 60`），零或负值返回 `None`（`codex-rs/backend-client/src/client.rs:493-500`）。
- **create_task 的 ID 提取**：创建任务后，优先从 `response.task.id` 取 ID，回退到 `response.id`，两者都不存在时报错。
- **自定义反序列化**：`types.rs` 中的 `deserialize_vec()` 辅助函数将 JSON null 反序列化为空 Vec 而非报错，增强了对后端返回数据不一致的容错能力（`codex-rs/backend-client/src/types.rs:307-313`）。