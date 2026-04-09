# Marketplace 发现与解析

## 概述与职责

Marketplace 模块是插件系统（PluginSystem）的子组件，负责**发现**和**解析** `marketplace.json` 清单文件，将其转换为结构化的 `Marketplace` / `MarketplacePlugin` 类型，并提供按名查找单个插件的能力。

在 Codex 的整体架构中，它位于 **Core → PluginsAndSkills → PluginSystem** 层级下，与 Skills（技能加载）、McpToolIntegration（MCP 工具集成）、AppsAndMentions（应用渲染与 @-提及）同属 PluginsAndSkills 子系统。Marketplace 模块本身不执行插件安装——它只负责"哪些插件存在、是否可安装、认证策略如何"的元数据解析，具体的安装/卸载由上层 `PluginsManager` 调用。

模块对外暴露两个核心公开函数：
- `resolve_marketplace_plugin` — 在安装流程中按名查找并验证单个插件
- `list_marketplaces` — 枚举所有可发现的 marketplace 及其插件列表

> 源码位置：`codex-rs/core/src/plugins/marketplace.rs`

## 关键流程

### 1. Marketplace 发现流程（`list_marketplaces`）

`list_marketplaces` 从多个根路径发现所有 `marketplace.json` 文件，加载并解析为结构化数据。

1. 调用 `list_marketplaces_with_home(additional_roots, home_dir())`，将用户 home 目录注入发现逻辑（`marketplace.rs:208-212`）
2. `discover_marketplace_paths_from_roots` 按以下优先级搜索：
   - **Home 目录**：检查 `~/.agents/plugins/marketplace.json` 是否存在（`marketplace.rs:290-297`）
   - **附加根目录**（additional_roots）：对每个根，先直接在该目录下查找 `<root>/.agents/plugins/marketplace.json`（支持非 git 的 HTTP 下载目录），若不存在则通过 `get_git_repo_root()` 回溯到 git 仓库根再查找（`marketplace.rs:299-317`）
   - 路径去重：已加入列表的路径不会重复添加，这确保同一 git 仓库下的多个子目录不会产生重复条目
3. 对每个发现的路径调用 `load_marketplace` 加载并解析
4. 加载失败的 marketplace 不会中断整个流程——错误被记录到 `MarketplaceListOutcome.errors` 中，同时通过 `tracing::warn!` 输出日志（`marketplace.rs:267-278`）

### 2. Marketplace 加载流程（`load_marketplace`）

将一个 `marketplace.json` 文件解析为 `Marketplace` 结构体。

1. `load_raw_marketplace_manifest` 读取文件内容并通过 serde 反序列化为 `RawMarketplaceManifest`（`marketplace.rs:322-338`）
2. 遍历每个原始插件条目：
   - 调用 `resolve_plugin_source_path` 将相对路径解析为绝对路径
   - 调用 `load_plugin_manifest` 加载插件自身的 `plugin.json` 清单，提取 interface 信息（displayName、capabilities、icon 等）
   - 如果 marketplace 条目中指定了 `category`，它会**覆盖**插件清单中的 category（marketplace 分类优先）（`marketplace.rs:231-236`）
3. 组装最终的 `Marketplace` 结构体，包括解析后的 `MarketplaceInterface`（display_name）

### 3. 单插件解析流程（`resolve_marketplace_plugin`）

在安装时按名查找插件，每次都从磁盘重新读取 `marketplace.json`（无缓存），确保获取最新内容。

1. 加载原始清单，按 `name` 字段查找目标插件（`marketplace.rs:163-175`）
2. **安装策略检查**：如果 `install_policy == NotAvailable`，直接拒绝（`marketplace.rs:191-196`）
3. **产品门控检查**（`marketplace.rs:184-190`）：
   - `products` 为 `None`（未设置）→ 允许所有产品
   - `products` 为空数组 `[]` → 拒绝所有产品（等效于禁用）
   - `products` 含具体产品列表 → 调用 `Product::matches_product_restriction` 校验当前产品是否在允许列表中
4. 构建 `PluginId`（格式为 `name@marketplace_name`），解析源路径，返回 `ResolvedMarketplacePlugin`

### 4. 插件源路径解析（`resolve_plugin_source_path`）

将 marketplace 中声明的相对路径转换为文件系统绝对路径，同时执行安全校验（`marketplace.rs:340-381`）：

1. 路径**必须**以 `./` 开头，否则拒绝
2. 路径不能为空（去掉 `./` 后）
3. 路径中不能包含 `..`、绝对路径分量等非 `Normal` 组件——防止路径穿越攻击
4. 路径相对于 marketplace 根目录（即 `<root>`，而非 `<root>/.agents/plugins/`）解析

`marketplace_root_dir` 通过连续三次 `.parent()` 调用从 `<root>/.agents/plugins/marketplace.json` 回溯到 `<root>`，并验证中间目录名确实是 `.agents` 和 `plugins`（`marketplace.rs:383-419`）。

## 函数签名与参数说明

### `resolve_marketplace_plugin(marketplace_path, plugin_name, restriction_product) -> Result<ResolvedMarketplacePlugin, MarketplaceError>`

安装时查找单个插件。

| 参数 | 类型 | 说明 |
|------|------|------|
| `marketplace_path` | `&AbsolutePathBuf` | `marketplace.json` 文件的绝对路径 |
| `plugin_name` | `&str` | 目标插件名称 |
| `restriction_product` | `Option<Product>` | 当前产品标识（如 `Codex`、`Chatgpt`），用于产品门控 |

> 源码位置：`marketplace.rs:158-206`

### `list_marketplaces(additional_roots) -> Result<MarketplaceListOutcome, MarketplaceError>`

枚举所有可发现的 marketplace。

| 参数 | 类型 | 说明 |
|------|------|------|
| `additional_roots` | `&[AbsolutePathBuf]` | 额外的搜索根路径（如 curated repo 路径、git 仓库根） |

> 源码位置：`marketplace.rs:208-212`

### `load_marketplace(path) -> Result<Marketplace, MarketplaceError>`（crate 内部）

加载单个 `marketplace.json` 并解析为完整的 `Marketplace` 结构体。

> 源码位置：`marketplace.rs:214-256`

## 接口/类型定义

### `Marketplace`

表示一个完整的 marketplace 实例。

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `String` | marketplace 名称（如 `"codex-curated"`） |
| `path` | `AbsolutePathBuf` | `marketplace.json` 文件的绝对路径 |
| `interface` | `Option<MarketplaceInterface>` | 展示信息（仅在 `display_name` 存在时才 `Some`） |
| `plugins` | `Vec<MarketplacePlugin>` | 该 marketplace 下的所有插件 |

### `MarketplacePlugin`

表示 marketplace 中的一个插件条目。

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `String` | 插件名称 |
| `source` | `MarketplacePluginSource` | 插件来源（目前仅 `Local { path }` 一种） |
| `policy` | `MarketplacePluginPolicy` | 安装和认证策略 |
| `interface` | `Option<PluginManifestInterface>` | 从插件 `plugin.json` 加载的展示信息 |

### `MarketplacePluginPolicy`

| 字段 | 类型 | 说明 |
|------|------|------|
| `installation` | `MarketplacePluginInstallPolicy` | 安装策略 |
| `authentication` | `MarketplacePluginAuthPolicy` | 认证策略 |
| `products` | `Option<Vec<Product>>` | 产品门控列表 |

### `MarketplacePluginInstallPolicy`（枚举）

| 变体 | JSON 值 | 说明 |
|------|---------|------|
| `NotAvailable` | `"NOT_AVAILABLE"` | 不可安装 |
| `Available`（默认） | `"AVAILABLE"` | 可安装 |
| `InstalledByDefault` | `"INSTALLED_BY_DEFAULT"` | 默认安装 |

### `MarketplacePluginAuthPolicy`（枚举）

| 变体 | JSON 值 | 说明 |
|------|---------|------|
| `OnInstall`（默认） | `"ON_INSTALL"` | 安装时认证 |
| `OnUse` | `"ON_USE"` | 使用时认证 |

### `ResolvedMarketplacePlugin`

`resolve_marketplace_plugin` 的返回值，表示一个经过验证可安装的插件。

| 字段 | 类型 | 说明 |
|------|------|------|
| `plugin_id` | `PluginId` | 插件唯一标识（`name@marketplace_name`） |
| `source_path` | `AbsolutePathBuf` | 插件源码的绝对路径 |
| `auth_policy` | `MarketplacePluginAuthPolicy` | 认证策略 |

### `MarketplaceError`（错误枚举）

| 变体 | 触发场景 |
|------|---------|
| `Io` | 文件读取 I/O 错误 |
| `MarketplaceNotFound` | `marketplace.json` 不存在 |
| `InvalidMarketplaceFile` | JSON 解析失败或路径不合法 |
| `PluginNotFound` | 指定名称的插件不存在 |
| `PluginNotAvailable` | 插件存在但不可安装（策略或产品门控） |
| `PluginsDisabled` | 插件功能整体禁用 |
| `InvalidPlugin` | `PluginId` 构造失败 |

## 配置项与 JSON 格式

### `marketplace.json` 文件格式

文件必须位于 `<root>/.agents/plugins/marketplace.json`，使用 camelCase：

```json
{
  "name": "codex-curated",
  "interface": {
    "displayName": "ChatGPT Official"
  },
  "plugins": [
    {
      "name": "demo-plugin",
      "source": {
        "source": "local",
        "path": "./plugins/demo-plugin"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL",
        "products": ["CODEX", "CHATGPT", "ATLAS"]
      },
      "category": "Design"
    }
  ]
}
```

- `interface` 和 `policy` 均为可选字段
- `policy` 不提供时，默认为 `installation: AVAILABLE`、`authentication: ON_INSTALL`、`products: null`（允许所有产品）
- `source.path` 必须以 `./` 开头，相对于仓库根目录解析
- `category` 是可选的 marketplace 层级分类，会覆盖插件自身 `plugin.json` 中的 category

### 发现路径常量

```rust
const MARKETPLACE_RELATIVE_PATH: &str = ".agents/plugins/marketplace.json";
```

## 边界 Case 与注意事项

- **无缓存设计**：`resolve_marketplace_plugin` 每次都重新从磁盘读取文件，确保安装流程看到的是最新的 marketplace 内容，无需担心缓存失效问题（`marketplace.rs:156-157` 注释）
- **同名 marketplace 不去重**：来自 home 目录和 repo 的两个同名 marketplace（如都叫 `"codex-curated"`）会作为**独立条目**同时出现在结果中。去重仅基于文件路径，不基于 name 字段
- **重复插件名**：同一 marketplace 中出现多个同名插件时，`resolve_marketplace_plugin` 使用 `Iterator::find` 返回**第一个**匹配项
- **空 products 数组意味着禁用**：`products: []` 会拒绝所有产品的安装请求，等效于 `NotAvailable`。而 `products: null`（未设置）则允许所有产品
- **旧版顶层策略字段被忽略**：JSON 中的 `installPolicy`、`authPolicy` 顶层字段会被 serde 静默忽略（因为 `#[serde(rename_all = "camelCase")]` 不匹配且无对应字段），只有 `policy` 对象内的字段才生效
- **路径安全校验**：`resolve_plugin_source_path` 严格要求 `./` 前缀并禁止 `..` 等路径穿越，确保插件路径不会逃逸出 marketplace 根目录
- **非 git 目录支持**：`discover_marketplace_paths_from_roots` 先检查根目录自身，再回退到 git repo root 发现。这支持了从 HTTP 下载的非 git 目录中发现 marketplace（`marketplace.rs:300-301` 注释）
- **加载失败不阻断**：`list_marketplaces` 中单个 marketplace 加载失败会被记录到 `errors` 列表并通过 warn 日志输出，不影响其他 marketplace 的正常加载