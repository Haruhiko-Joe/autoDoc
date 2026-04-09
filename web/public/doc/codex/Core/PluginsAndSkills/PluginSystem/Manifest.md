# Manifest — 插件清单解析器

## 概述与职责

`manifest.rs` 是插件系统（PluginSystem）的清单解析模块，负责从插件根目录中读取并验证 `plugin.json` 文件，将其转换为类型安全的 `PluginManifest` 结构体。它处于 Core → PluginsAndSkills → PluginSystem 层级中，是插件发现和加载流程的基础环节——其他组件（如 `PluginsManager`）依赖它来获取插件的元数据和路径信息。

同级模块包括 Skills（技能加载与依赖解析）、McpToolIntegration（MCP 工具调用）和 AppsAndMentions（应用渲染与提及语法）。

## 关键流程

### 清单加载流程（`load_plugin_manifest`）

入口函数 `load_plugin_manifest(plugin_root: &Path) -> Option<PluginManifest>`（`manifest.rs:114-228`）执行以下步骤：

1. **定位清单文件**：拼接 `plugin_root` 与 `PLUGIN_MANIFEST_PATH`（来自 `codex_utils_plugins` crate 的常量）得到 `plugin.json` 的完整路径。若文件不存在则返回 `None`
2. **读取与反序列化**：使用 `fs::read_to_string` 读取文件内容，通过 `serde_json` 反序列化为内部的 `RawPluginManifest` 结构体。解析失败时记录 `tracing::warn` 日志并返回 `None`
3. **名称回退**：若清单中的 `name` 字段为空白字符串，则使用插件根目录的目录名作为插件名（`manifest.rs:130-135`）
4. **路径解析**：对 `skills`、`mcp_servers`、`apps` 三个路径字段调用 `resolve_manifest_path` 进行安全校验和绝对路径转换
5. **接口元数据解析**：若存在 `interface` 字段，解析其中的展示信息、默认提示词、品牌资源路径等。若所有接口字段均为空，则整个 `interface` 设为 `None`

### 路径安全校验流程（`resolve_manifest_path`）

`resolve_manifest_path(plugin_root, field, path) -> Option<AbsolutePathBuf>`（`manifest.rs:331-372`）实施严格的路径安全规则：

1. **必须以 `./` 开头**：确保路径是相对于插件根目录的。裸路径如 `skills/` 会被拒绝
2. **不能仅为 `./`**：去掉前缀后路径不能为空
3. **逐组件扫描**：遍历路径的每个组件，只允许 `Component::Normal`。遇到 `..`（父目录遍历）或其他特殊组件（如根路径 `/`）立即拒绝
4. **生成绝对路径**：将规范化后的相对路径拼接到 `plugin_root` 下，通过 `AbsolutePathBuf::try_from` 转换为绝对路径

这套规则确保插件清单中声明的路径不会逃逸出插件根目录，防止路径遍历攻击。

### 默认提示词解析流程（`resolve_default_prompts`）

`resolve_default_prompts`（`manifest.rs:238-293`）支持两种格式：

1. **单字符串**：`"defaultPrompt": "Summarize my inbox"` — 返回包含一个元素的 `Vec`
2. **字符串数组**：`"defaultPrompt": ["prompt1", "prompt2"]` — 最多接受 `MAX_DEFAULT_PROMPT_COUNT`（3）个有效项

对每个提示词字符串，`resolve_default_prompt_str`（`manifest.rs:295-310`）执行：
- **空白归一化**：用 `split_whitespace().join(" ")` 将多余空白压缩为单个空格
- **空值检查**：归一化后为空则丢弃
- **长度限制**：超过 `MAX_DEFAULT_PROMPT_LEN`（128 字符）则丢弃

非字符串值（数字、对象等）通过 `#[serde(untagged)]` 枚举 `RawPluginManifestDefaultPrompt::Invalid` 捕获并记录警告。

## 类型定义

### `PluginManifest`（`manifest.rs:30-36`）

解析后的插件清单，crate 内部可见。

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `String` | 插件名称，来自清单或目录名回退 |
| `description` | `Option<String>` | 插件描述 |
| `paths` | `PluginManifestPaths` | 技能/MCP 服务器/应用的目录路径 |
| `interface` | `Option<PluginManifestInterface>` | 用户界面展示元数据 |

### `PluginManifestPaths`（`manifest.rs:38-43`）

公开结构体，包含插件子目录的绝对路径。

| 字段 | 类型 | 说明 |
|------|------|------|
| `skills` | `Option<AbsolutePathBuf>` | 技能定义目录 |
| `mcp_servers` | `Option<AbsolutePathBuf>` | MCP 服务器配置目录 |
| `apps` | `Option<AbsolutePathBuf>` | 应用目录 |

### `PluginManifestInterface`（`manifest.rs:45-61`）

公开结构体，包含插件在 UI 中展示所需的全部元数据。

| 字段 | 类型 | 说明 |
|------|------|------|
| `display_name` | `Option<String>` | 展示名称 |
| `short_description` | `Option<String>` | 简短描述 |
| `long_description` | `Option<String>` | 详细描述 |
| `developer_name` | `Option<String>` | 开发者名称 |
| `category` | `Option<String>` | 分类标签 |
| `capabilities` | `Vec<String>` | 能力列表 |
| `website_url` | `Option<String>` | 插件网站 |
| `privacy_policy_url` | `Option<String>` | 隐私政策链接 |
| `terms_of_service_url` | `Option<String>` | 服务条款链接 |
| `default_prompt` | `Option<Vec<String>>` | 默认提示词（最多 3 个，每个最多 128 字符） |
| `brand_color` | `Option<String>` | 品牌颜色 |
| `composer_icon` | `Option<AbsolutePathBuf>` | 编辑器图标路径 |
| `logo` | `Option<AbsolutePathBuf>` | Logo 路径 |
| `screenshots` | `Vec<AbsolutePathBuf>` | 截图路径列表 |

### 内部反序列化类型

- **`RawPluginManifest`**（`manifest.rs:11-28`）：使用 `camelCase` 风格从 JSON 反序列化的中间结构。路径以原始字符串保留，待后续安全校验
- **`RawPluginManifestInterface`**（`manifest.rs:63-97`）：接口部分的原始反序列化结构。URL 字段支持 `camelCase` 和大写 `URL` 后缀两种别名（如 `websiteUrl` 和 `websiteURL`）
- **`RawPluginManifestDefaultPrompt`**（`manifest.rs:99-105`）：`#[serde(untagged)]` 枚举，支持字符串、字符串数组或无效值三种形态

## 函数签名

### `load_plugin_manifest(plugin_root: &Path) -> Option<PluginManifest>`

模块唯一的公开入口。读取指定插件根目录下的清单文件，返回解析后的 `PluginManifest`；文件不存在或解析失败时返回 `None`。

> 源码位置：`manifest.rs:114-228`

### `resolve_manifest_path(plugin_root: &Path, field: &'static str, path: Option<&str>) -> Option<AbsolutePathBuf>`

内部函数。校验路径安全性并转换为绝对路径。`field` 参数用于警告日志中标识出问题的字段。

> 源码位置：`manifest.rs:331-372`

### `resolve_default_prompts(plugin_root: &Path, value: Option<&RawPluginManifestDefaultPrompt>) -> Option<Vec<String>>`

内部函数。解析并归一化默认提示词，支持单字符串和数组两种输入格式。

> 源码位置：`manifest.rs:238-293`

### `resolve_default_prompt_str(plugin_root: &Path, field: &str, prompt: &str) -> Option<String>`

内部函数。对单条提示词字符串执行空白归一化和长度校验。

> 源码位置：`manifest.rs:295-310`

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|-----|------|
| `MAX_DEFAULT_PROMPT_COUNT` | 3 | 默认提示词最大数量 |
| `MAX_DEFAULT_PROMPT_LEN` | 128 | 单条提示词最大字符数 |
| `PLUGIN_MANIFEST_PATH` | （来自 `codex_utils_plugins`） | 清单文件相对路径（测试中可见为 `.codex-plugin/plugin.json`） |

## 边界 Case 与注意事项

- **名称回退逻辑**：当清单中 `name` 为空或纯空白时（`trim().is_empty()`），使用 `plugin_root` 的目录名作为插件名。注意这里的判断条件在 `filter` 中是反直觉的——`filter(|_| raw_name.trim().is_empty())` 在 `raw_name` **为空时**才保留目录名（`manifest.rs:130-135`）
- **空接口折叠**：即使清单包含 `interface` 对象，若所有字段解析后均为空/默认值，整个 `interface` 将被设为 `None`（`manifest.rs:188-203`）
- **路径必须以 `./` 开头**：这是强制要求，不支持裸相对路径（如 `skills/` 会被拒绝）。这保证了路径的意图明确性
- **所有路径安全失败为 `None`**：路径校验失败不会导致整个清单加载失败，只有对应字段被忽略，并输出 `tracing::warn` 级别日志
- **提示词数组中的无效项被跳过**：数组中的非字符串值、空字符串、超长字符串都被静默跳过（记录日志），不影响其他有效项的解析
- **提示词数量截断**：达到 3 个有效提示词后，后续项直接被丢弃
- **URL 字段双重别名**：`websiteUrl`/`websiteURL`、`privacyPolicyUrl`/`privacyPolicyURL`、`termsOfServiceUrl`/`termsOfServiceURL` 均可识别，兼容不同命名风格

## 关键代码片段

路径安全校验的核心逻辑——逐组件扫描防止目录遍历：

```rust
// manifest.rs:351-364
let mut normalized = std::path::PathBuf::new();
for component in Path::new(relative_path).components() {
    match component {
        Component::Normal(component) => normalized.push(component),
        Component::ParentDir => {
            tracing::warn!("ignoring {field}: path must not contain '..'");
            return None;
        }
        _ => {
            tracing::warn!("ignoring {field}: path must stay within the plugin root");
            return None;
        }
    }
}
```