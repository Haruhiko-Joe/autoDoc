# MCP 清单、插件管理与反馈 RPC 助手

## 概述与职责

本模块是 TUI `App` 结构体上的一组**异步 fire-and-forget RPC 方法**，负责通过 app-server 发起 MCP 清单查询、插件增删查、用户反馈提交以及速率限制刷新等操作。它们是 MainEventLoop 的组成部分，位于层级 `TUI → AppOrchestrator → AppCore → MainEventLoop` 中。

所有方法遵循统一的调用模式：从 `AppServerSession` 获取 `request_handle`，克隆 `app_event_tx` 发送通道，通过 `tokio::spawn` 发起异步请求，完成后将结果封装为对应的 `AppEvent` 变体发回事件循环处理。这使得 UI 线程不会被阻塞——请求在后台执行，结果通过事件总线异步回流。

同级兄弟模块包括 ServerEventAdapter（处理入站 app-server 事件）、PendingRequests（跟踪审批请求）、InteractiveReplayTracking（回放过滤）、AgentNavigation（多 Agent 导航）和 LoadedThreadDiscovery（子 Agent 线程发现）。

## 关键流程

### 统一的异步 RPC 模式

几乎所有方法都遵循以下模板：

1. 从 `AppServerSession` 获取 `AppServerRequestHandle`
2. 克隆 `self.app_event_tx`（`AppEvent` 发送通道）
3. `tokio::spawn` 一个 async 块
4. 在 async 块内调用对应的模块级 `fetch_*` 函数，将 `Result` 的 `Err` 映射为 `String`
5. 通过 `app_event_tx.send()` 发送对应的 `AppEvent` 变体

这种模式使所有 RPC 调用都是非阻塞的，结果通过事件循环的 `handle_event()` 分发处理。

### MCP 清单获取流程

1. `fetch_mcp_inventory()` 被调用，spawn 后台任务（`app.rs:1883-1892`）
2. 后台任务调用 `fetch_all_mcp_server_statuses()`，该函数通过**分页循环**收集所有 MCP 服务器状态（`app.rs:6010-6037`）：
   - 每次请求 `limit=100` 条记录
   - 使用 `ClientRequest::McpServerStatusList` 发送 RPC
   - 如果响应包含 `next_cursor`，继续下一页；否则结束
3. 结果通过 `AppEvent::McpInventoryLoaded` 回送
4. `handle_mcp_inventory_result()` 处理结果（`app.rs:2106-2131`）：
   - 清除 loading 动画（调用 `clear_mcp_inventory_loading()` 和 `clear_committed_mcp_inventory_loading()`）
   - 错误时显示错误消息
   - 当本地配置和服务器均无 MCP 服务器时，显示"空"提示 cell
   - 正常情况下渲染完整的工具/资源清单

### 插件操作流程

四个插件方法分别对应 CRUD 中的读列表、读详情、安装、卸载：

- **`fetch_plugins_list()`**（`app.rs:1905-1914`）：发送 `ClientRequest::PluginList`，结果回送 `AppEvent::PluginsLoaded`
- **`fetch_plugin_detail()`**（`app.rs:1916-1930`）：发送 `ClientRequest::PluginRead`，结果回送 `AppEvent::PluginDetailLoaded`
- **`fetch_plugin_install()`**（`app.rs:1932-1957`）：发送 `ClientRequest::PluginInstall`，结果回送 `AppEvent::PluginInstallLoaded`，携带 `marketplace_path`、`plugin_name`、`plugin_display_name` 等上下文供 UI 展示
- **`fetch_plugin_uninstall()`**（`app.rs:1959-1981`）：发送 `ClientRequest::PluginUninstall`，结果回送 `AppEvent::PluginUninstallLoaded`

安装和卸载的错误消息会附加描述性前缀（如 `"Failed to install plugin: {err}"`）。

### 反馈提交流程

1. **`submit_feedback()`**（`app.rs:1983-2017`）：收集反馈参数，包括：
   - 当前 `thread_id`（来自 `chat_widget`）
   - 如果 `include_logs` 为 true，获取 `rollout_path` 作为日志附件
   - 调用 `build_feedback_upload_params()` 构建参数
   - Spawn 后台任务调用 `fetch_feedback_upload()`
   - 成功时从响应中提取 `thread_id`，通过 `AppEvent::FeedbackSubmitted` 回送

2. **`handle_feedback_submitted()`**（`app.rs:2081-2099`）：处理回送结果
   - 构建 `FeedbackThreadEvent`（包含 category、include_logs、feedback_audience）
   - 如果存在 `origin_thread_id`，通过 `enqueue_thread_feedback_event()` 路由到对应线程
   - 否则直接调用 `handle_feedback_thread_event()` 在当前上下文处理

3. **`enqueue_thread_feedback_event()`**（`app.rs:2038-2079`）：将反馈事件推入线程缓冲区
   - 通过 `ensure_thread_channel()` 获取线程通道
   - 将事件加入 `store.buffer`（`ThreadBufferedEvent::FeedbackSubmission`）
   - 如果缓冲区超容量，弹出最老的事件，并通知 `pending_interactive_replay` 处理被驱逐的请求
   - 如果线程处于活跃状态（`guard.active`），通过通道发送事件；如果通道满则 spawn 异步发送

4. **`handle_feedback_thread_event()`**（`app.rs:2019-2036`）：最终渲染
   - 成功时调用 `feedback_success_cell()` 添加成功提示到聊天记录
   - 失败时显示错误消息

### 速率限制刷新

`refresh_rate_limits()`（`app.rs:1894-1903`）调用 `fetch_account_rate_limits()`（`app.rs:6039-6052`），后者发送 `ClientRequest::GetAccountRateLimits` 并通过 `app_server_rate_limit_snapshots_to_core()` 转换响应格式，结果以 `AppEvent::RateLimitsLoaded` 回送，附带 `request_id` 用于请求追踪。

## 函数签名与参数说明

### App 方法（`impl App`）

| 方法 | 参数 | 回送事件 |
|------|------|----------|
| `fetch_mcp_inventory(&mut self, app_server)` | `AppServerSession` 引用 | `AppEvent::McpInventoryLoaded` |
| `handle_mcp_inventory_result(&mut self, result)` | `Result<Vec<McpServerStatus>, String>` | — |
| `clear_committed_mcp_inventory_loading(&mut self)` | 无 | — |
| `refresh_rate_limits(&mut self, app_server, request_id)` | `AppServerSession` 引用 + `u64` 请求 ID | `AppEvent::RateLimitsLoaded` |
| `fetch_plugins_list(&mut self, app_server, cwd)` | `AppServerSession` + `PathBuf` 工作目录 | `AppEvent::PluginsLoaded` |
| `fetch_plugin_detail(&mut self, app_server, cwd, params)` | `AppServerSession` + `PathBuf` + `PluginReadParams` | `AppEvent::PluginDetailLoaded` |
| `fetch_plugin_install(&mut self, app_server, cwd, marketplace_path, plugin_name, plugin_display_name)` | 安装路径、插件名、显示名 | `AppEvent::PluginInstallLoaded` |
| `fetch_plugin_uninstall(&mut self, app_server, cwd, plugin_id, plugin_display_name)` | 插件 ID、显示名 | `AppEvent::PluginUninstallLoaded` |
| `submit_feedback(&mut self, app_server, category, reason, include_logs)` | 反馈类别、原因、是否附带日志 | `AppEvent::FeedbackSubmitted` |
| `handle_feedback_thread_event(&mut self, event)` | `FeedbackThreadEvent` | — |
| `enqueue_thread_feedback_event(&mut self, thread_id, event)` | `ThreadId` + `FeedbackThreadEvent` | — |
| `handle_feedback_submitted(&mut self, origin_thread_id, category, include_logs, result)` | 来源线程、类别、日志标志、结果 | — |

### 模块级 async 函数

| 函数 | 签名 | 说明 |
|------|------|------|
| `fetch_all_mcp_server_statuses` | `(AppServerRequestHandle) -> Result<Vec<McpServerStatus>>` | 分页收集所有 MCP 服务器状态 |
| `fetch_account_rate_limits` | `(AppServerRequestHandle) -> Result<Vec<RateLimitSnapshot>>` | 获取账户速率限制 |
| `fetch_plugins_list` | `(AppServerRequestHandle, PathBuf) -> Result<PluginListResponse>` | 获取插件列表 |
| `fetch_plugin_detail` | `(AppServerRequestHandle, PluginReadParams) -> Result<PluginReadResponse>` | 获取单个插件详情 |
| `fetch_plugin_install` | `(AppServerRequestHandle, AbsolutePathBuf, String) -> Result<PluginInstallResponse>` | 安装插件 |
| `fetch_plugin_uninstall` | `(AppServerRequestHandle, String) -> Result<PluginUninstallResponse>` | 卸载插件 |
| `build_feedback_upload_params` | `(Option<ThreadId>, Option<PathBuf>, FeedbackCategory, Option<String>, bool) -> FeedbackUploadParams` | 纯函数，构建反馈上传参数 |
| `fetch_feedback_upload` | `(AppServerRequestHandle, FeedbackUploadParams) -> Result<FeedbackUploadResponse>` | 上传反馈 |
| `mcp_inventory_maps_from_statuses` | `(Vec<McpServerStatus>) -> McpInventoryMaps` | **仅测试**，将状态列表转为按服务器索引的 HashMap 集合 |

## 接口/类型定义

### `McpInventoryMaps`（仅 `#[cfg(test)]`，`app.rs:6156-6161`）

```rust
type McpInventoryMaps = (
    HashMap<String, codex_protocol::mcp::Tool>,          // 工具：key 为 "mcp__{server}__{tool}"
    HashMap<String, Vec<codex_protocol::mcp::Resource>>,  // 资源：key 为 server name
    HashMap<String, Vec<codex_protocol::mcp::ResourceTemplate>>, // 资源模板
    HashMap<String, McpAuthStatus>,                       // 认证状态
);
```

这是一个测试辅助类型，将扁平的 `McpServerStatus` 列表重新组织为四个按服务器名称索引的 HashMap。TUI 生产代码直接使用 `McpServerStatus` 渲染，不经过此转换。

## 配置项与默认值

- **MCP 分页大小**：`fetch_all_mcp_server_statuses` 每次请求 `limit: Some(100)` 条记录，硬编码在函数内部（`app.rs:6023`）
- **插件同步策略**：所有插件操作默认设置 `force_remote_sync: false`，不强制远程同步
- **反馈日志附件**：当 `include_logs` 为 true 时，`build_feedback_upload_params` 会将 `rollout_path` 封装为 `extra_log_files`

## 边界 Case 与注意事项

- **MCP 空状态处理**：`handle_mcp_inventory_result` 会检查本地配置 `config.mcp_servers` 和服务端返回是否**同时为空**，此时渲染 `empty_mcp_output()` 而非完整表格。只有配置端有服务器但远端为空时，仍会走正常渲染路径。

- **反馈路由逻辑**：`handle_feedback_submitted` 根据是否存在 `origin_thread_id` 分两条路径——有线程 ID 时入队到对应线程缓冲区（支持线程切换后展示），无线程 ID 时直接处理。这意味着在无活跃线程时提交的反馈会立即渲染。

- **线程缓冲区溢出**：`enqueue_thread_feedback_event` 中，当缓冲区超容量时会弹出最老的事件。如果被弹出的恰好是 `ThreadBufferedEvent::Request`，还会通知 `pending_interactive_replay` 记录该驱逐，避免回放时重复展示已失效的交互提示。

- **通道背压处理**：如果线程事件通道满（`TrySendError::Full`），会 spawn 一个新的 async 任务进行异步发送，而非丢弃事件。通道关闭时仅记录 warn 日志。

- **loading spinner 清理**：`handle_mcp_inventory_result` 执行**双重清理**——既清除 `chat_widget` 中的 loading 状态，也通过 `clear_committed_mcp_inventory_loading()`（`app.rs:2132-2145`）从 `transcript_cells` 中移除 `McpInventoryLoadingCell`，并同步更新 Transcript overlay。

- **请求 ID 生成**：所有模块级 `fetch_*` 函数使用 `Uuid::new_v4()` 生成唯一请求 ID，格式为 `"{prefix}-{uuid}"`（如 `"mcp-inventory-{uuid}"`），确保并发请求不会冲突。

## 关键代码片段

### fire-and-forget 模式示例（`app.rs:1883-1892`）

```rust
fn fetch_mcp_inventory(&mut self, app_server: &AppServerSession) {
    let request_handle = app_server.request_handle();
    let app_event_tx = self.app_event_tx.clone();
    tokio::spawn(async move {
        let result = fetch_all_mcp_server_statuses(request_handle)
            .await
            .map_err(|err| err.to_string());
        app_event_tx.send(AppEvent::McpInventoryLoaded { result });
    });
}
```

### 分页收集逻辑（`app.rs:6010-6037`）

```rust
async fn fetch_all_mcp_server_statuses(
    request_handle: AppServerRequestHandle,
) -> Result<Vec<McpServerStatus>> {
    let mut cursor = None;
    let mut statuses = Vec::new();
    loop {
        let response: ListMcpServerStatusResponse = request_handle
            .request_typed(ClientRequest::McpServerStatusList {
                request_id,
                params: ListMcpServerStatusParams {
                    cursor: cursor.clone(),
                    limit: Some(100),
                },
            })
            .await?;
        statuses.extend(response.data);
        if let Some(next_cursor) = response.next_cursor {
            cursor = Some(next_cursor);
        } else {
            break;
        }
    }
    Ok(statuses)
}
```

### 反馈参数构建（`app.rs:6119-6138`）

```rust
fn build_feedback_upload_params(
    origin_thread_id: Option<ThreadId>,
    rollout_path: Option<PathBuf>,
    category: FeedbackCategory,
    reason: Option<String>,
    include_logs: bool,
) -> FeedbackUploadParams {
    let extra_log_files = if include_logs {
        rollout_path.map(|rollout_path| vec![rollout_path])
    } else {
        None
    };
    FeedbackUploadParams {
        classification: feedback_classification(category).to_string(),
        reason,
        thread_id: origin_thread_id.map(|thread_id| thread_id.to_string()),
        include_logs,
        extra_log_files,
    }
}
```