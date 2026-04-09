# AppsAndMentions — App 渲染与 Mention 语法常量

## 概述与职责

`AppsAndMentions` 模块属于 **Core → PluginsAndSkills** 子系统，包含两个独立的小模块：

- **`apps`**：负责将 MCP（Model Context Protocol）应用列表渲染为一段 "Apps (Connectors)" 指令文本，注入到发给大模型的 system prompt 中，让模型知道有哪些可用的外部应用及其调用方式。
- **`mention_syntax`**：从底层工具库 `codex_utils_plugins` 中 re-export 两个字符常量——插件文本 mention 符号（`@`）和工具 mention 符号（`$`），供 Core 内部的 mention 解析逻辑使用。

在整体架构中，`PluginsAndSkills` 是 Core 的可扩展层，负责插件发现、skill 加载、MCP 工具审批模板等。`AppsAndMentions` 是其中最轻量的部分：一个纯渲染函数和两个常量 re-export。同级兄弟模块还包括插件管理、skill 调用、marketplace 集成等更重的子系统。

## 文件结构

```
codex-rs/core/src/
├── apps/
│   ├── mod.rs          # 模块入口，re-export render_apps_section
│   └── render.rs       # 核心渲染函数 + 单元测试
└── mention_syntax.rs   # re-export 两个 sigil 常量
```

## 关键流程

### Apps 指令段渲染流程

1. 会话引擎在构建 model prompt 时调用 `render_apps_section(&connectors)`（调用点：`codex-rs/core/src/codex.rs:3672`）
2. 函数接收一个 `AppInfo` 切片，遍历检查是否存在 **同时满足 `is_accessible` 和 `is_enabled`** 的应用
3. 若没有任何符合条件的应用，返回 `None`——不注入任何内容
4. 若存在，生成一段 Markdown 格式的指令文本，用 `<apps_instructions>` / `</apps_instructions>` 标签包裹，插入 prompt 中

这段指令文本告知模型：
- 应用可以通过 `[$app-name](app://{connector_id})` 格式在用户消息中显式触发
- 应用也可以根据上下文隐式触发
- 应用本质上是 `codex_apps` MCP 服务器中的一组 MCP 工具
- 不应额外调用 `list_mcp_resources` 或 `list_mcp_resource_templates`

### Mention 符号 re-export

`mention_syntax.rs` 仅做 re-export，使 Core crate 的其他模块（如 `plugins::mentions`，见 `codex-rs/core/src/plugins/mentions.rs:12-13`）可以通过 `crate::mention_syntax::PLUGIN_TEXT_MENTION_SIGIL` 等路径引用这两个常量，而不必直接依赖 `codex_utils_plugins`。

## 函数签名与参数说明

### `render_apps_section(connectors: &[AppInfo]) -> Option<String>`

渲染 Apps 指令段的核心函数。

- **参数** `connectors`：`AppInfo` 切片，每个元素描述一个已安装的应用（包括 id、name、是否可访问、是否启用等字段）
- **返回值**：
  - `Some(String)`：当至少有一个应用同时满足 `is_accessible == true` 且 `is_enabled == true` 时，返回被 `<apps_instructions>` 标签包裹的 Markdown 指令文本
  - `None`：没有可用应用时返回空

> 源码位置：`codex-rs/core/src/apps/render.rs:6-20`

**可见性**：`pub(crate)`，仅 Core crate 内部使用。

## 常量定义

| 常量 | 值 | 来源 | 用途 |
|------|------|------|------|
| `PLUGIN_TEXT_MENTION_SIGIL` | `'@'` | `codex_utils_plugins::mention_syntax` | 解析用户消息中的 `@插件名` mention 语法 |
| `TOOL_MENTION_SIGIL` | `'$'` | `codex_utils_plugins::mention_syntax` | 解析用户消息中的 `$工具名` mention 语法（slash-command 风格） |

> 定义位置：`codex-rs/utils/plugins/src/mention_syntax.rs:4-7`
> Re-export 位置：`codex-rs/core/src/mention_syntax.rs:1-2`

## 外部依赖

- **`codex_app_server_protocol::AppInfo`**：应用信息结构体，包含 `id`、`name`、`description`、`is_accessible`、`is_enabled` 等字段
- **`codex_mcp::mcp::CODEX_APPS_MCP_SERVER_NAME`**：值为 `"codex_apps"`，标识 Apps 专用的 MCP 服务器名称（`codex-rs/codex-mcp/src/mcp/mod.rs:34`）
- **`codex_protocol::protocol::APPS_INSTRUCTIONS_OPEN_TAG` / `APPS_INSTRUCTIONS_CLOSE_TAG`**：值分别为 `"<apps_instructions>"` 和 `"</apps_instructions>"`，用于包裹指令段（`codex-rs/protocol/src/protocol.rs:92-93`）

## 边界 Case 与注意事项

- **必须同时满足两个条件**：应用必须 `is_accessible == true` **且** `is_enabled == true` 才会触发渲染。仅满足其中一个条件等同于没有可用应用，函数返回 `None`。这在单元测试中有明确覆盖（`codex-rs/core/src/apps/render.rs:45-58`）。
- **空列表安全**：传入空切片时直接返回 `None`，不会 panic。
- **渲染结果不含具体应用列表**：当前实现只输出通用说明文本，不逐一列出各应用的名称和 ID。模型需要通过 `tool_search` 工具或已加载的 MCP 工具列表来发现具体应用。
- **mention 符号是硬编码常量**：`@` 和 `$` 符号不可配置，修改需要改动 `codex_utils_plugins` 源码并影响所有依赖方。

## 关键代码片段

渲染函数的核心逻辑——过滤判断与文本生成：

```rust
// codex-rs/core/src/apps/render.rs:6-20
pub(crate) fn render_apps_section(connectors: &[AppInfo]) -> Option<String> {
    if !connectors
        .iter()
        .any(|connector| connector.is_accessible && connector.is_enabled)
    {
        return None;
    }

    let body = format!(
        "## Apps (Connectors)\nApps (Connectors) can be explicitly triggered..."
    );
    Some(format!(
        "{APPS_INSTRUCTIONS_OPEN_TAG}\n{body}\n{APPS_INSTRUCTIONS_CLOSE_TAG}"
    ))
}
```