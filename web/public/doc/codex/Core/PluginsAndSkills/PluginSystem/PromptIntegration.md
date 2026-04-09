# PromptIntegration（插件提示词集成）

## 概述与职责

PromptIntegration 模块负责将插件系统的信息注入到发送给 LLM 的提示词中，并从用户输入中解析 mention 语法。它是 **PluginSystem** 的子模块，位于 `Core > PluginsAndSkills > PluginSystem` 层级下，与同级的插件管理、技能加载、MCP 工具集成等模块协作。

该模块包含四个核心子模块：
- **render.rs**：渲染 `## Plugins` 提示词段落，告诉模型当前可用的插件及使用指南
- **injection.rs**：为被用户显式 mention 的插件构建 `ResponseItem` 注入项
- **mentions.rs**：从用户输入中提取插件 mention、App mention、工具 mention 等信息
- **discoverable.rs**：生成未安装但可通过 tool-suggest 推荐的策展插件列表

## 关键流程

### 1. 插件提示词段落渲染（render.rs）

`render_plugins_section()` 接收已启用的 `PluginCapabilitySummary` 列表，生成包裹在 `<plugins_instructions>` 标签内的 Markdown 提示词。

流程步骤：
1. 若插件列表为空，直接返回 `None`
2. 生成 `## Plugins` 标题和插件定义说明
3. 逐个渲染 `### Available plugins` 列表项（格式：`` - `display_name`: description ``）
4. 附加 `### How to use plugins` 部分，指导模型如何发现、触发和使用插件
5. 将内容包裹在 `PLUGINS_INSTRUCTIONS_OPEN_TAG` / `PLUGINS_INSTRUCTIONS_CLOSE_TAG` 标签中返回

`render_explicit_plugin_instructions()` 为单个被显式提及的插件生成能力说明，列出其关联的 skill 前缀、MCP server 名称和 App 名称。若插件没有任何可用能力（即输出只有标题行），则返回 `None`（`render.rs:81-83`）。

### 2. 插件上下文注入（injection.rs）

`build_plugin_injections()` 将用户提及的插件转换为 `ResponseItem`（实际类型为 `DeveloperInstructions`）注入到对话上下文中。

流程步骤：
1. 遍历 `mentioned_plugins` 列表
2. 对每个插件，从 `mcp_tools` 中筛选出 `plugin_display_names` 匹配的 MCP server（排除 `CODEX_APPS_MCP_SERVER_NAME`），使用 `BTreeSet` 去重排序（`injection.rs:27-39`）
3. 从 `available_connectors` 中筛选出已启用且 `plugin_display_names` 匹配的 App connector，同样去重排序（`injection.rs:40-52`）
4. 调用 `render_explicit_plugin_instructions()` 生成指令文本
5. 将文本包装为 `DeveloperInstructions` -> `ResponseItem` 返回

### 3. Mention 提取与解析（mentions.rs）

mentions.rs 提供了从用户输入中识别各种 mention 的能力：

**工具 mention 收集** — `collect_tool_mentions_from_messages()` 使用 `$` sigil（`TOOL_MENTION_SIGIL`）从消息文本中提取工具引用，返回 `CollectedToolMentions`（包含 `plain_names` 和 `paths` 两个 `HashSet`）。

**App ID 收集** — `collect_explicit_app_ids()` 从 `UserInput` 中收集 App mention：
1. 先从 `UserInput::Mention` 结构化 mention 中取 path
2. 再从 `UserInput::Text` 文本中通过 `$` sigil 链接语法（如 `[$calendar](app://calendar)`）提取
3. 通过 `tool_kind_for_path()` 过滤出 `ToolMentionKind::App` 类型
4. 用 `app_id_from_path()` 提取 App ID

**插件 mention 收集** — `collect_explicit_plugin_mentions()` 使用 `@` sigil（`PLUGIN_TEXT_MENTION_SIGIL`）从输入中识别插件引用（`mentions.rs:86`）。关键区别：插件使用 `@` 而非 `$`，因此 `[$sample](plugin://sample@test)` 这样的 `$` 格式链接不会被识别为插件 mention（参见测试 `collect_explicit_plugin_mentions_ignores_dollar_linked_plugin_mentions`）。正确的格式是 `[@sample](plugin://sample@test)`。

**连接器 slug 计数** — `build_connector_slug_counts()` 遍历 connector 列表，统计每个 slug 出现的次数。

**技能名称计数** — 通过 `pub(crate) use crate::build_skill_name_counts` 重导出。

### 4. 可发现插件列表（discoverable.rs）

`list_tool_suggest_discoverable_plugins()` 生成可通过 tool-suggest 向用户推荐安装的策展插件列表。

流程步骤：
1. 检查 `Feature::Plugins` 特性是否启用，未启用则返回空列表
2. 创建 `PluginsManager`，获取所有 marketplace 列表
3. 找到 `OPENAI_CURATED_MARKETPLACE_NAME` 对应的策展市场
4. 遍历市场中的插件，过滤条件（`discoverable.rs:53-57`）：
   - 排除已安装的插件
   - 仅保留在 `TOOL_SUGGEST_DISCOVERABLE_PLUGIN_ALLOWLIST` 白名单中的 **或** 在用户配置 `tool_suggest.discoverables` 中的插件
5. 对每个合格插件调用 `read_plugin_for_config` 读取详情，转为 `DiscoverablePluginInfo`
6. 按名称排序后返回

## 函数签名与参数说明

### `render_plugins_section(plugins: &[PluginCapabilitySummary]) -> Option<String>`

渲染完整的 `## Plugins` 提示词段落。`plugins` 为空时返回 `None`。

> 源码位置：`codex-rs/core/src/plugins/render.rs:5-40`

### `render_explicit_plugin_instructions(plugin: &PluginCapabilitySummary, available_mcp_servers: &[String], available_apps: &[String]) -> Option<String>`

为单个插件生成能力说明。若该插件无 skill、无 MCP server、无 App，返回 `None`。

> 源码位置：`codex-rs/core/src/plugins/render.rs:42-88`

### `build_plugin_injections(mentioned_plugins: &[PluginCapabilitySummary], mcp_tools: &HashMap<String, ToolInfo>, available_connectors: &[connectors::AppInfo]) -> Vec<ResponseItem>`

将显式提及的插件转换为 `DeveloperInstructions` 类型的 `ResponseItem` 列表，注入到对话上下文中。

> 源码位置：`codex-rs/core/src/plugins/injection.rs:13-58`

### `collect_tool_mentions_from_messages(messages: &[String]) -> CollectedToolMentions`

从文本消息中提取工具 mention（使用 `$` sigil）。返回包含 `plain_names` 和 `paths` 的结构体。

> 源码位置：`codex-rs/core/src/plugins/mentions.rs:22-24`

### `collect_explicit_app_ids(input: &[UserInput]) -> HashSet<String>`

从用户输入中收集所有显式提及的 App ID，同时支持结构化 `Mention` 和文本链接语法。

> 源码位置：`codex-rs/core/src/plugins/mentions.rs:40-59`

### `collect_explicit_plugin_mentions(input: &[UserInput], plugins: &[PluginCapabilitySummary]) -> Vec<PluginCapabilitySummary>`

从用户输入中收集显式提及的插件，使用 `@` sigil 解析文本链接。返回匹配到的 `PluginCapabilitySummary` 列表。

> 源码位置：`codex-rs/core/src/plugins/mentions.rs:62-102`

### `build_connector_slug_counts(connectors: &[connectors::AppInfo]) -> HashMap<String, usize>`

统计每个 connector slug 的出现次数。

> 源码位置：`codex-rs/core/src/plugins/mentions.rs:106-115`

### `list_tool_suggest_discoverable_plugins(config: &Config) -> anyhow::Result<Vec<DiscoverablePluginInfo>>`

列出可推荐安装的策展插件。需要 `Feature::Plugins` 开启，且插件在白名单或用户配置中。

> 源码位置：`codex-rs/core/src/plugins/discoverable.rs:25-94`

## 类型定义

### `CollectedToolMentions`

工具 mention 提取结果：

| 字段 | 类型 | 说明 |
|------|------|------|
| `plain_names` | `HashSet<String>` | 纯名称引用（不含路径前缀） |
| `paths` | `HashSet<String>` | 完整路径引用（如 `app://calendar`） |

> 源码位置：`codex-rs/core/src/plugins/mentions.rs:17-20`

### `PluginCapabilitySummary`（外部依赖）

插件能力摘要，由上层 `PluginsManager` 构建，包含 `config_name`、`display_name`、`description`、`has_skills`、`mcp_server_names`、`app_connector_ids` 等字段。

## 配置项与常量

### 可发现插件白名单

`TOOL_SUGGEST_DISCOVERABLE_PLUGIN_ALLOWLIST` 硬编码了 8 个允许作为 tool-suggest 推荐的策展插件 ID（`discoverable.rs:14-23`）：

- `github@openai-curated`、`notion@openai-curated`、`slack@openai-curated`、`gmail@openai-curated`
- `google-calendar@openai-curated`、`google-drive@openai-curated`、`linear@openai-curated`、`figma@openai-curated`

用户也可通过配置文件的 `[tool_suggest] discoverables` 字段自定义额外的可推荐插件 ID。

### Mention Sigil 约定

- **工具/App mention**：使用 `$` sigil（`TOOL_MENTION_SIGIL`），格式如 `[$calendar](app://calendar)`
- **插件 mention**：使用 `@` sigil（`PLUGIN_TEXT_MENTION_SIGIL`），格式如 `[@sample](plugin://sample@test)`

这一区分确保插件 mention 不会与工具 mention 混淆。

## 边界 Case 与注意事项

- **空列表短路**：`render_plugins_section`、`build_plugin_injections`、`collect_explicit_plugin_mentions` 均在输入为空时立即返回，避免无意义的处理
- **Sigil 区分**：插件使用 `@` sigil，工具/App 使用 `$` sigil。使用错误的 sigil 会导致 mention 无法被识别（如 `[$sample](plugin://...)` 不会匹配到插件）
- **无能力插件不注入**：`render_explicit_plugin_instructions` 在插件没有 skill、MCP server 或 App 时返回 `None`，这意味着 `build_plugin_injections` 会通过 `filter_map` 自动跳过这类插件
- **BTreeSet 去重排序**：injection.rs 使用 `BTreeSet` 收集 MCP server 和 App 名称，确保输出顺序确定性
- **已安装插件排除**：`list_tool_suggest_discoverable_plugins` 会跳过已安装的插件，仅推荐未安装的
- **读取失败降级**：discoverable.rs 在读取插件详情失败时仅记录 `warn` 日志，不会中断整个列表的构建（`discoverable.rs:85`）