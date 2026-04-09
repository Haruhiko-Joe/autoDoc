# Connectors（连接器发现服务）

## 概述与职责

`codex-connectors` 是 Codex 的**应用目录与连接器发现服务**，属于 ModelProviders 层的子模块。它负责从远端目录接口获取可用的连接器（Connectors）列表，将目录连接器和工作区连接器合并去重，对元数据进行规范化处理，并将结果缓存以避免重复请求。

在整体架构中，该模块与 Auth（提供认证凭据）和 Config（提供 base URL 等配置）协作，为上层的 TUI 和 AppServer 提供连接器选择列表。同级模块包括 OpenAI Responses API 客户端、Realtime API 客户端、Ollama/LM Studio 本地模型提供者等。

整个 crate 仅由一个文件 `codex-rs/connectors/src/lib.rs` 组成，对外暴露缓存查询和带选项的连接器列表获取两个核心公开函数。

## 关键流程

### 连接器列表获取流程

核心入口是 `list_all_connectors_with_options()` 异步函数（`src/lib.rs:92-132`），完整流程如下：

1. **缓存检查**：若 `force_refetch` 为 `false`，先调用 `cached_all_connectors()` 检查缓存是否命中（key 匹配且未过期），命中则直接返回
2. **拉取目录连接器**：调用 `list_directory_connectors()`，向 `/connectors/directory/list?tier=categorized&external_logos=true` 发起**分页请求**，通过 `nextToken` 循环拉取所有页面，过滤掉 `visibility=HIDDEN` 的应用
3. **拉取工作区连接器**（仅当 `is_workspace_account=true`）：调用 `list_workspace_connectors()`，向 `/connectors/directory/list_workspace?external_logos=true` 发起单次请求；若请求失败则静默返回空列表
4. **合并去重**：调用 `merge_directory_apps()` 按 `id` 去重，相同 ID 的应用会逐字段合并——已有值优先保留，缺失字段从后来者补充
5. **转换为 AppInfo**：将 `DirectoryApp` 转换为标准的 `AppInfo` 类型
6. **规范化处理**：为每个连接器生成 `install_url`（基于 `chatgpt.com/apps/{slug}/{id}` 格式）、去除名称和描述中的多余空白、空名称回退为 ID
7. **排序**：按名称字母序排序，名称相同则按 ID 排序
8. **写入缓存**并返回结果

### 缓存机制

缓存采用全局静态 `Mutex<Option<CachedAllConnectors>>`（`src/lib.rs:46-47`），是一个**单条目 LRU 缓存**：

- **缓存键**（`AllConnectorsCacheKey`）包含 4 个维度：`chatgpt_base_url`、`account_id`、`chatgpt_user_id`、`is_workspace_account`
- **TTL**：固定 1 小时（`CONNECTORS_CACHE_TTL = Duration::from_secs(3600)`，`src/lib.rs:13`）
- **命中条件**：key 完全匹配 **且** 未过期
- **失效策略**：过期时主动清除；key 不匹配时保留旧缓存（但不命中）
- 锁中毒时通过 `PoisonError::into_inner` 恢复，保证可用性

### 合并策略

`merge_directory_app()`（`src/lib.rs:209-347`）将两个同 ID 的 `DirectoryApp` 合并，遵循**"先到者优先"**原则：

- `name`：仅当已有名称为空时才用新值覆盖
- `description`：新值非空时覆盖（后到者优先，与 name 策略不同）
- `logo_url`/`logo_url_dark`/`distribution_channel`/`labels`：已有值为 `None` 时才补充
- `branding`/`app_metadata`：嵌套结构逐字段合并，每个字段独立判断是否需要补充

## 函数签名与参数说明

### `list_all_connectors_with_options<F, Fut>(cache_key, is_workspace_account, force_refetch, fetch_page) -> Result<Vec<AppInfo>>`

核心公开异步函数。通过泛型参数 `fetch_page` 接收一个 HTTP 请求回调，使得 crate 本身不依赖具体的 HTTP 客户端实现。

| 参数 | 类型 | 说明 |
|------|------|------|
| `cache_key` | `AllConnectorsCacheKey` | 缓存键，标识当前用户/账户/环境 |
| `is_workspace_account` | `bool` | 是否为工作区账户，决定是否额外拉取工作区连接器 |
| `force_refetch` | `bool` | 是否强制跳过缓存 |
| `fetch_page` | `FnMut(String) -> Future<Result<DirectoryListResponse>>` | HTTP 请求回调，接收 URL 路径，返回分页响应 |

> 源码位置：`codex-rs/connectors/src/lib.rs:92-132`

### `cached_all_connectors(cache_key: &AllConnectorsCacheKey) -> Option<Vec<AppInfo>>`

公开的缓存查询函数，仅读取缓存不触发网络请求。用于在不需要刷新时快速获取上次结果。

> 源码位置：`codex-rs/connectors/src/lib.rs:74-90`

### `AllConnectorsCacheKey::new(chatgpt_base_url, account_id, chatgpt_user_id, is_workspace_account) -> Self`

构造缓存键。

> 源码位置：`codex-rs/connectors/src/lib.rs:24-36`

## 接口/类型定义

### `DirectoryListResponse`

目录接口返回的分页响应体，反序列化自 JSON。

| 字段 | 类型 | 说明 |
|------|------|------|
| `apps` | `Vec<DirectoryApp>` | 当前页的应用列表 |
| `next_token` | `Option<String>` | 下一页 token（`nextToken` 别名），为空时表示最后一页 |

### `DirectoryApp`

目录接口返回的单个应用条目。JSON 字段名使用 camelCase（通过 `serde(alias)` 映射）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `String` | 应用唯一标识 |
| `name` | `String` | 应用名称 |
| `description` | `Option<String>` | 应用描述 |
| `app_metadata` | `Option<AppMetadata>` | 应用元数据（分类、截图、版本等） |
| `branding` | `Option<AppBranding>` | 品牌信息（类别、开发者、网站等） |
| `labels` | `Option<HashMap<String, String>>` | 自定义标签 |
| `logo_url` / `logo_url_dark` | `Option<String>` | 亮色/暗色主题 Logo URL |
| `distribution_channel` | `Option<String>` | 分发渠道 |
| `visibility` | `Option<String>` | 可见性，`"HIDDEN"` 表示应被过滤 |

### `AllConnectorsCacheKey`

缓存键，实现了 `Clone`、`Debug`、`PartialEq`、`Eq`。

## 配置项与默认值

| 常量/配置 | 值 | 说明 |
|-----------|-----|------|
| `CONNECTORS_CACHE_TTL` | `3600` 秒（1 小时） | 缓存过期时间，硬编码于 `src/lib.rs:13` |

API 端点路径：
- 目录列表：`/connectors/directory/list?tier=categorized&external_logos=true`
- 工作区列表：`/connectors/directory/list_workspace?external_logos=true`
- 安装 URL 格式：`https://chatgpt.com/apps/{name-slug}/{id}`

## 边界 Case 与注意事项

- **空名称回退**：如果连接器名称为空或全为空白字符，规范化后使用 `id` 作为显示名称（`normalize_connector_name()`，`src/lib.rs:393-400`）
- **Slug 生成**：名称中非 ASCII 字母数字的字符统一替换为 `-`，首尾 `-` 被去除；完全无有效字符时 slug 为 `"app"`（`connector_name_slug()`，`src/lib.rs:376-391`）
- **工作区请求失败静默处理**：`list_workspace_connectors()` 在请求失败时返回空 `Vec` 而非传播错误（`src/lib.rs:187-194`），保证即使工作区端点不可用也不影响整体列表
- **缓存锁中毒恢复**：缓存读写均使用 `PoisonError::into_inner` 恢复中毒的 Mutex，保证即使某个线程 panic 也不会永久阻塞缓存
- **单条目缓存**：全局缓存只存储最近一次查询结果。切换账户后旧缓存不会命中（key 不匹配），但也不会被立即清除——仅在 key 不匹配 **且** 过期后才被清除
- **`is_accessible` 默认为 `false`**：所有从目录获取的连接器初始标记为不可访问（`src/lib.rs:123`），需要上层逻辑根据用户实际安装状态更新此字段
- **合并中 `description` 的特殊行为**：与大多数字段的"先到优先"不同，`description` 采用"后到覆盖"策略——只要新值非空就会替换已有值（`src/lib.rs:228-234`）