# ChatGPTClient

## 概述与职责

`codex-chatgpt` 是 Codex 认证体系（Auth）中专门与 ChatGPT 后端 API 交互的客户端 crate。它在系统架构中位于 **Auth** 模块下，为需要访问 ChatGPT 账户资源的功能提供统一的 HTTP 请求能力。同级模块还包括 OAuth 登录流程（codex-login）和凭据存储等认证基础设施。

该 crate 承担以下核心职责：

1. **认证 HTTP 请求**：封装对 ChatGPT 后端的 GET 请求，自动注入 Bearer Token 和 Account ID
2. **Token 状态管理**：通过全局单例维护 ChatGPT 的 `TokenData`，支持从本地认证文件初始化
3. **App Connector 列表与合并**：从 ChatGPT Directory API 获取连接器列表，与本地 MCP 工具和插件应用合并
4. **云端任务获取**：调用 `/wham/tasks/{id}` API 获取 Codex Web 的云端 Agent 任务结果
5. **Diff 应用**：将云端任务产出的 diff 补丁应用到本地 Git 仓库

## 模块结构

crate 由 5 个源文件组成（`src/lib.rs:1-5`）：

| 模块 | 可见性 | 职责 |
|------|--------|------|
| `chatgpt_client` | `pub(crate)` | HTTP 请求封装 |
| `chatgpt_token` | 私有 | Token 全局状态管理 |
| `connectors` | `pub` | 连接器列表、合并与过滤 |
| `get_task` | `pub` | 云端任务 API 数据模型与请求 |
| `apply_command` | `pub` | CLI apply 子命令，拉取并应用 diff |

## 关键流程

### 1. 认证请求流程

所有对 ChatGPT 后端的请求都通过 `chatgpt_get_request` 或 `chatgpt_get_request_with_timeout` 发起（`src/chatgpt_client.rs:12-62`）。流程如下：

1. 调用 `init_chatgpt_token_from_auth()` 确保全局 Token 已初始化——它从 `codex_home` 下的认证文件读取凭据并写入全局 `CHATGPT_TOKEN`
2. 通过 `get_chatgpt_token_data()` 读取全局 Token
3. 从 Token 中提取 `access_token`（用于 Bearer Auth）和 `account_id`（用于 `chatgpt-account-id` 请求头）
4. 使用 `codex_login::default_client::create_client()` 创建 HTTP 客户端，发送 GET 请求
5. 成功时将响应体反序列化为泛型 `T: DeserializeOwned`；失败时返回包含 HTTP 状态码和响应体的错误

```
请求头结构:
Authorization: Bearer <access_token>
chatgpt-account-id: <account_id>
Content-Type: application/json
```

### 2. Token 状态管理

Token 通过一个进程级全局单例管理（`src/chatgpt_token.rs:8`）：

```rust
static CHATGPT_TOKEN: LazyLock<RwLock<Option<TokenData>>> = LazyLock::new(|| RwLock::new(None));
```

- `get_chatgpt_token_data()` 通过读锁获取当前 Token 的克隆
- `set_chatgpt_token_data()` 通过写锁设置 Token
- `init_chatgpt_token_from_auth()` 是初始化入口：创建 `AuthManager`，调用 `auth().await` 获取认证信息，再通过 `get_token_data()` 转换为 `TokenData` 并存入全局状态

`init_chatgpt_token_from_auth` 接受两个参数：`codex_home` 路径和 `AuthCredentialsStoreMode`（控制凭据的存储方式，如系统 keyring 或文件）。

### 3. 连接器列表与合并流程

连接器模块（`src/connectors.rs`）是最复杂的部分，负责从多个来源汇集 App Connector 列表。

**主入口 `list_connectors()`**（`src/connectors.rs:37-53`）：

1. 调用 `apps_enabled()` 检查 feature flag——如果未启用则直接返回空列表
2. 并发执行两个请求（`tokio::join!`）：
   - `list_all_connectors()` → 从 ChatGPT Directory API 获取全量连接器
   - `list_accessible_connectors_from_mcp_tools()` → 从已注册的 MCP 工具中提取可用连接器
3. 调用 `merge_connectors_with_accessible()` 合并两个列表
4. 调用 `with_app_enabled_state()` 标记每个连接器的启用状态

**`list_all_connectors_with_options()`**（`src/connectors.rs:78-107`）的详细流程：

1. 检查 apps feature flag
2. 初始化 ChatGPT Token
3. 根据 `chatgpt_base_url`、`account_id`、`chatgpt_user_id`、是否 workspace 账户生成缓存键
4. 调用 `codex_connectors::list_all_connectors_with_options()`，传入一个闭包用于执行实际的 HTTP 请求（带 60 秒超时）
5. 通过 `merge_plugin_apps()` 合并插件管理器中配置的 App
6. 通过 `filter_disallowed_connectors()` 过滤掉被禁止的连接器

**合并策略 `merge_connectors_with_accessible()`**（`src/connectors.rs:139-158`）：

- 当 `all_connectors_loaded = true` 时，仅保留同时存在于全量列表和可访问列表中的连接器（取交集）
- 当 `all_connectors_loaded = false`（全量列表仍在加载中）时，保留可访问列表的全部条目（允许超集）
- 最终都经过 `merge_connectors()` 和 `filter_disallowed_connectors()` 处理

**缓存支持**：`list_cached_all_connectors()` 提供了纯缓存读取路径，不发起网络请求，在缓存未命中时返回 `None`。

### 4. 云端任务获取与 Diff 应用流程

这是 `codex apply <task_id>` 命令的实现路径。

**数据模型**（`src/get_task.rs:7-35`）：

```
GetTaskResponse
  └─ current_diff_task_turn: Option<AssistantTurn>
       └─ output_items: Vec<OutputItem>
            ├─ OutputItem::Pr(PrOutputItem)
            │    └─ output_diff: OutputDiff { diff: String }
            └─ OutputItem::Other  // 忽略非 PR 类型的输出
```

API 端点为 `/wham/tasks/{task_id}`（`src/get_task.rs:37-40`）。

**`run_apply_command()` 完整流程**（`src/apply_command.rs:23-40`）：

1. 使用 `Config::load_with_cli_overrides()` 加载配置（支持 CLI 覆盖参数）
2. 初始化 ChatGPT Token
3. 调用 `get_task()` 从 ChatGPT 后端获取任务数据
4. 调用 `apply_diff_from_task()` 提取并应用 diff

**`apply_diff_from_task()`**（`src/apply_command.rs:42-58`）：

1. 从 `GetTaskResponse.current_diff_task_turn` 提取 diff turn，无则报错
2. 在 `output_items` 中查找第一个 `OutputItem::Pr` 类型的条目
3. 提取其中的 `output_diff.diff` 字符串

**`apply_diff()`**（`src/apply_command.rs:60-81`）：

1. 确定工作目录：优先使用传入的 `cwd`，fallback 到 `current_dir()`，最终 fallback 到 `temp_dir()`
2. 构造 `ApplyGitRequest`（`revert: false`, `preflight: false`）
3. 调用 `codex_git_utils::apply_git_patch()` 执行 `git apply`
4. 检查退出码，非零时报告 applied/skipped/conflicted 路径数及 stdout/stderr

## 函数签名

### chatgpt_client

#### `chatgpt_get_request<T: DeserializeOwned>(config: &Config, path: String) -> anyhow::Result<T>`

对 ChatGPT 后端发起认证 GET 请求。`path` 是相对于 `config.chatgpt_base_url` 的 API 路径。无超时限制。

#### `chatgpt_get_request_with_timeout<T: DeserializeOwned>(config: &Config, path: String, timeout: Option<Duration>) -> anyhow::Result<T>`

同上，但支持可选的请求超时。

> 两个函数均为 `pub(crate)` 可见性，仅供 crate 内部使用。源码位置：`src/chatgpt_client.rs:12-62`

### connectors

#### `list_connectors(config: &Config) -> anyhow::Result<Vec<AppInfo>>`

主入口。并发获取全量连接器和可访问连接器，合并后返回带启用状态标记的列表。

#### `list_all_connectors(config: &Config) -> anyhow::Result<Vec<AppInfo>>`

仅获取 Directory API 的全量连接器（使用缓存，不强制刷新）。

#### `list_all_connectors_with_options(config: &Config, force_refetch: bool) -> anyhow::Result<Vec<AppInfo>>`

支持 `force_refetch` 参数强制绕过缓存。

#### `list_cached_all_connectors(config: &Config) -> Option<Vec<AppInfo>>`

纯缓存读取，不发起网络请求。缓存未命中返回 `None`。

#### `merge_connectors_with_accessible(connectors: Vec<AppInfo>, accessible_connectors: Vec<AppInfo>, all_connectors_loaded: bool) -> Vec<AppInfo>`

合并全量列表和可访问列表。`all_connectors_loaded` 控制是否对可访问列表做交集过滤。

#### `connectors_for_plugin_apps(connectors: Vec<AppInfo>, plugin_apps: &[AppConnectorId]) -> Vec<AppInfo>`

从连接器列表中筛选出指定插件应用 ID 对应的条目。

> 源码位置：`src/connectors.rs:37-158`

### get_task

#### `get_task(config: &Config, task_id: String) -> anyhow::Result<GetTaskResponse>`

`pub(crate)` 函数，请求 `/wham/tasks/{task_id}` 获取云端任务数据。

> 源码位置：`src/get_task.rs:37-40`

### apply_command

#### `run_apply_command(apply_cli: ApplyCommand, cwd: Option<PathBuf>) -> anyhow::Result<()>`

CLI apply 子命令的入口。加载配置、初始化 Token、获取任务、应用 diff。

#### `apply_diff_from_task(task_response: GetTaskResponse, cwd: Option<PathBuf>) -> anyhow::Result<()>`

从已获取的任务响应中提取 diff 并应用。公开导出，可在测试中独立使用。

> 源码位置：`src/apply_command.rs:23-81`

## 类型定义

### `ApplyCommand`（`src/apply_command.rs:17-22`）

CLI 子命令参数结构，使用 `clap::Parser` 派生：

| 字段 | 类型 | 说明 |
|------|------|------|
| `task_id` | `String` | 云端任务 ID |
| `config_overrides` | `CliConfigOverrides` | 全局 CLI 配置覆盖参数（flatten） |

### `GetTaskResponse`（`src/get_task.rs:7-9`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `current_diff_task_turn` | `Option<AssistantTurn>` | 当前任务的最新 diff turn |

### `AssistantTurn`（`src/get_task.rs:12-15`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `output_items` | `Vec<OutputItem>` | 任务产出列表 |

### `OutputItem`（`src/get_task.rs:17-25`）

带 `serde(tag = "type")` 的枚举：

| 变体 | 标签值 | 说明 |
|------|--------|------|
| `Pr(PrOutputItem)` | `"pr"` | 包含 diff 的 PR 产出 |
| `Other` | 其他任何值 | 未识别的产出类型，直接忽略 |

### `PrOutputItem` / `OutputDiff`（`src/get_task.rs:27-35`）

`PrOutputItem.output_diff.diff` 为标准 git diff 格式的字符串。

## 配置项与依赖

- **`config.chatgpt_base_url`**：ChatGPT 后端 API 的基础 URL，所有请求以此为前缀
- **`config.codex_home`**：Codex 主目录路径，用于定位认证文件
- **`config.cli_auth_credentials_store_mode`**：凭据存储模式（`AuthCredentialsStoreMode`）
- **`config.features.apps_enabled()`**：Feature flag，控制是否启用 App Connector 功能

外部 crate 依赖：`codex-core`（Config、连接器类型）、`codex-login`（认证管理）、`codex-connectors`（连接器缓存与 Directory API）、`codex-git-utils`（git patch 应用）、`codex-utils-cli`（CLI 参数覆盖）。

## 边界 Case 与注意事项

- **Token 未初始化**：`chatgpt_get_request` 在 Token 不可用时返回 `"ChatGPT token not available"` 错误；`account_id` 缺失时提示用户重新执行 `codex login`
- **Apps Feature 关闭**：所有连接器列表函数在 `apps_enabled()` 为 false 时直接返回空列表，不发起任何网络请求
- **连接器过滤规则**：`filter_disallowed_connectors()` 会过滤掉 `connector_openai_` 前缀的连接器和特定黑名单 ID（如 `asdk_app_6938a94a61d881918ef32cb999ff937c`），但允许其他 `asdk_` 前缀的连接器通过
- **Diff 应用冲突**：当本地文件与 diff 冲突时，`apply_git_patch` 会返回非零退出码并在文件中留下标准的 Git 冲突标记（`<<<<<<< HEAD` 等）
- **无 diff turn**：如果任务响应中 `current_diff_task_turn` 为 `None` 或不包含 `OutputItem::Pr` 类型条目，`apply_diff_from_task` 会返回明确的错误信息
- **Directory API 超时**：连接器列表请求的超时为 60 秒（`DIRECTORY_CONNECTORS_TIMEOUT`）