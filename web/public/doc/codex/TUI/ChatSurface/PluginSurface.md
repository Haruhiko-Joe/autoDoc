# PluginSurface — 插件市场集成界面

## 概述与职责

PluginSurface 是 TUI 中 ChatWidget 的插件管理子系统，实现了从浏览、搜索、查看详情到安装/卸载插件的完整 UI 交互流程。它位于 **TUI → ChatSurface** 层级下，作为 `ChatWidget` 的 `impl` 方法集合存在，通过 `BottomPane` 的 `SelectionView` 弹窗体系来呈现所有界面。

在 TUI 的兄弟模块中，PluginSurface 与 BottomPane（提供弹窗容器）和 SharedUtilities（提供 shimmer 动画）紧密协作，同时依赖 `codex_app_server_protocol` crate 提供的插件协议类型。

## 关键流程

### 1. 插件列表加载与展示

用户通过 `/plugins` 命令触发 `add_plugins_output()`，这是整个模块的入口：

1. 检查 `Feature::Plugins` 是否启用，未启用则显示禁用提示并返回（`codex-rs/tui/src/chatwidget/plugins.rs:133-139`）
2. 调用 `prefetch_plugins()` 发起异步加载——通过 `AppEvent::FetchPluginsList` 事件将请求发送到 app 层（`codex-rs/tui/src/chatwidget/plugins.rs:204`）
3. 根据当前缓存状态（`PluginsCacheState`）决定展示内容：
   - **Ready**：直接打开插件列表弹窗
   - **Failed**：将错误写入历史记录
   - **Loading / Uninitialized**：打开带 shimmer 动画的加载弹窗

异步结果通过 `on_plugins_loaded()` 回调写入缓存，并自动刷新已打开的弹窗（`codex-rs/tui/src/chatwidget/plugins.rs:157-191`）。

### 2. 缓存机制

缓存以工作目录（cwd）为 key，核心状态保存在 `plugins_cache` 和 `plugins_fetch_state` 两个字段中：

- `plugins_fetch_state.in_flight_cwd`：当前正在请求的 cwd，防止重复发起请求（`codex-rs/tui/src/chatwidget/plugins.rs:195-196`）
- `plugins_fetch_state.cache_cwd`：缓存对应的 cwd，切换目录后缓存失效
- `plugins_cache_for_current_cwd()` 方法在 cwd 不匹配时返回 `Uninitialized`（`codex-rs/tui/src/chatwidget/plugins.rs:207-213`）

当 cwd 发生变化，旧缓存不会被复用，下一次打开插件面板将重新加载。

### 3. 插件详情查看

用户在列表中选择插件后触发 `AppEvent::OpenPluginDetailLoading` + `AppEvent::FetchPluginDetail`，详情加载完成后 `on_plugin_detail_loaded()` 回调用 `plugin_detail_popup_params()` 构建详情弹窗（`codex-rs/tui/src/chatwidget/plugins.rs:251-281`）。详情页展示：

- 插件名称、安装状态、所属市场
- 未安装插件会显示数据共享声明（隐私政策/服务条款披露，`codex-rs/tui/src/chatwidget/plugins.rs:847-859`）
- 描述文本（优先取 `PluginDetail.description`，依次 fallback 到 `long_description`、`short_description`）
- 三个能力摘要行：Skills、Apps、MCP Servers
- 操作按钮：安装/卸载/返回列表

### 4. 安装与卸载流程

**安装流程**（`on_plugin_install_loaded()`，`codex-rs/tui/src/chatwidget/plugins.rs:283-341`）：

1. 安装成功后检查 `apps_needing_auth`——需要用户在 ChatGPT 中授权的 App 列表
2. 如果列表为空，显示成功消息，流程结束
3. 如果有需要授权的 App，进入 **Auth Flow**（见下文）
4. 安装失败时显示错误详情弹窗，附带"返回列表"按钮

**卸载流程**（`on_plugin_uninstall_loaded()`，`codex-rs/tui/src/chatwidget/plugins.rs:343-373`）较为简单：成功则清理状态并显示提示（"Bundled apps remain installed."），失败则显示错误弹窗。

### 5. 安装后 App 授权流程（Auth Flow）

当插件安装后有依赖的 App 需要用户授权时，系统进入逐个 App 的授权引导：

1. `PluginInstallAuthFlowState` 追踪当前流程：插件名和 `next_app_index`（`codex-rs/tui/src/chatwidget/plugins.rs:319-322`）
2. 每个 App 显示一个弹窗（`plugin_install_auth_popup_params()`，`codex-rs/tui/src/chatwidget/plugins.rs:410-509`），包含：
   - 进度指示（如 "App setup 2/3"）
   - 如果 App 已安装则显示 "Continue"；否则显示 "Install on ChatGPT" 按钮（打开浏览器）和 "I've installed it" 确认按钮
   - "Skip remaining app setup" 选项用于中断流程
3. `advance_plugin_install_auth_flow()` 推进到下一个 App（`codex-rs/tui/src/chatwidget/plugins.rs:375-390`）
4. `abandon_plugin_install_auth_flow()` 跳过剩余步骤（`codex-rs/tui/src/chatwidget/plugins.rs:392-394`）
5. 流程完成后 `finish_plugin_install_auth_flow()` 清理状态并回到插件列表（`codex-rs/tui/src/chatwidget/plugins.rs:519-552`）

App 是否已安装的判断通过 `plugin_install_auth_app_is_installed()` 检查当前 connectors 列表中是否存在对应 `app_id` 且 `is_accessible` 为 true（`codex-rs/tui/src/chatwidget/plugins.rs:511-517`）。

## 关键类型与接口

### `PluginsCacheState`（枚举）

```rust
pub(super) enum PluginsCacheState {
    Uninitialized,  // 从未加载过
    Loading,        // 正在请求中
    Ready(PluginListResponse),  // 已就绪
    Failed(String), // 加载失败，携带错误信息
}
```

> 源码位置：`codex-rs/tui/src/chatwidget/plugins.rs:122-129`

### `DelayedLoadingHeader`（结构体）

实现 `Renderable` trait 的加载态头部组件。特性：

- 初始 1 秒内显示静态 dim 文本（避免瞬间闪烁），之后切换为 shimmer 动画（`codex-rs/tui/src/chatwidget/plugins.rs:73-85`）
- 如果动画被全局禁用（`animations_enabled = false`），始终显示静态 dim 文本
- 支持可选的 `note` 附加行

相关常量：
- `LOADING_ANIMATION_DELAY`：1 秒（动画延迟启动时间）
- `LOADING_ANIMATION_INTERVAL`：100ms（shimmer 帧间隔）

### `PluginDisclosureLine`（结构体）

用于插件详情页的数据共享披露文本。实现 `Renderable` trait，自动换行并在缓冲区中标记 `APPS_HELP_ARTICLE_URL` 为可点击超链接（`codex-rs/tui/src/chatwidget/plugins.rs:101-120`）。

### 主要公开方法（ChatWidget impl）

| 方法 | 可见性 | 用途 |
|------|--------|------|
| `add_plugins_output()` | `pub(crate)` | 入口：打开插件面板 |
| `on_plugins_loaded()` | `pub(crate)` | 回调：列表加载完成 |
| `on_plugin_detail_loaded()` | `pub(crate)` | 回调：详情加载完成 |
| `on_plugin_install_loaded()` | `pub(crate)` | 回调：安装完成，返回 `bool` 表示流程是否结束 |
| `on_plugin_uninstall_loaded()` | `pub(crate)` | 回调：卸载完成 |
| `open_plugin_detail_loading_popup()` | `pub(crate)` | 显示详情加载中弹窗 |
| `open_plugin_install_loading_popup()` | `pub(crate)` | 显示安装中弹窗 |
| `open_plugin_uninstall_loading_popup()` | `pub(crate)` | 显示卸载中弹窗 |
| `advance_plugin_install_auth_flow()` | `pub(crate)` | 推进 Auth Flow 到下一 App |
| `abandon_plugin_install_auth_flow()` | `pub(crate)` | 中断 Auth Flow |

## 辅助函数

文件底部定义了一组模块级辅助函数，用于从协议类型中提取展示信息：

- `plugin_display_name()` / `marketplace_display_name()`：优先取 `interface.display_name`，fallback 到 `name`（`codex-rs/tui/src/chatwidget/plugins.rs:966-986`）
- `plugin_status_label()`：根据 `installed`、`enabled`、`install_policy` 返回状态文本（`codex-rs/tui/src/chatwidget/plugins.rs:1001-1015`）
- `plugin_description()` / `plugin_detail_description()`：按优先级提取描述文本（`codex-rs/tui/src/chatwidget/plugins.rs:1017-1053`）
- `plugin_skill_summary()` / `plugin_app_summary()` / `plugin_mcp_summary()`：将插件能力列表格式化为逗号分隔字符串（`codex-rs/tui/src/chatwidget/plugins.rs:1055-1087`）
- `plugin_brief_description()`：组合状态标签、市场名和描述为列表行文本，对齐状态标签宽度（`codex-rs/tui/src/chatwidget/plugins.rs:988-999`）

## 配置项与依赖

- **Feature Gate**：整个插件功能受 `Feature::Plugins` feature flag 控制（`codex-rs/tui/src/chatwidget/plugins.rs:133`）
- **动画控制**：`self.config.animations` 决定加载 shimmer 是否启用
- **弹窗 ID**：所有插件相关弹窗共享 `PLUGINS_SELECTION_VIEW_ID = "plugins-selection"`，确保互相替换而非叠加

## 边界 Case 与注意事项

- **cwd 切换保护**：所有异步回调（`on_plugins_loaded`、`on_plugin_detail_loaded` 等）都在第一行检查 `cwd` 是否与当前配置匹配，不匹配则静默丢弃结果，防止陈旧数据覆盖当前状态
- **Auth Flow 期间的刷新抑制**：当 `plugin_install_auth_flow` 处于活跃状态时，插件列表的加载结果会写入缓存但不会刷新弹窗 UI（`codex-rs/tui/src/chatwidget/plugins.rs:176-178`），避免干扰正在进行的授权引导
- **`on_plugin_install_loaded` 返回值**：返回 `bool` 表示是否可以关闭弹窗——当需要进入 Auth Flow 时返回 `false`（`codex-rs/tui/src/chatwidget/plugins.rs:324`），告知调用方保持弹窗打开
- **排序规则**：插件列表中已安装的插件排在前面，其次按名称字母序排列（`codex-rs/tui/src/chatwidget/plugins.rs:740-753`）
- **搜索范围**：搜索时不仅匹配显示名，还包括 `plugin.id`、`plugin.name` 和市场名称（`codex-rs/tui/src/chatwidget/plugins.rs:769-772`）
- **卸载后 App 保留**：卸载插件时，其捆绑的 App 不会一同卸载（提示 "Bundled apps remain installed."）