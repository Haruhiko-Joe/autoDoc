# Store — 本地插件缓存

## 概述与职责

`PluginStore` 是 Codex 插件系统的本地文件系统缓存层，位于 **Core → PluginsAndSkills → PluginSystem** 层级之下。它管理 `codex_home/plugins/cache` 目录，以 `marketplace_name/plugin_name/version` 三级层次结构存储已安装的插件。

同层的兄弟模块包括插件发现（Marketplace）、清单解析（Manifest）、远程 API 等。Store 专注于**本地磁盘上的插件生命周期管理**——安装、卸载、版本发现和路径解析。

## 核心数据结构

### `PluginStore`

```rust
pub struct PluginStore {
    root: AbsolutePathBuf,  // codex_home/plugins/cache
}
```

通过 `PluginStore::new(codex_home)` 构造，自动拼接 `plugins/cache` 子路径作为缓存根目录（`store.rs:27-32`）。

### `PluginInstallResult`

安装成功后的返回值，包含三个字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `plugin_id` | `PluginId` | 插件标识（含 marketplace_name 和 plugin_name） |
| `plugin_version` | `String` | 安装的版本字符串 |
| `installed_path` | `AbsolutePathBuf` | 安装后的完整路径 |

### `PluginStoreError`

错误枚举，两个变体：
- `Io { context, source }` — 文件系统操作失败，附带静态上下文描述
- `Invalid(String)` — 校验失败（路径遍历、清单不匹配等）

## 关键流程

### 路径解析

缓存目录遵循固定层次结构：

```
{codex_home}/plugins/cache/{marketplace_name}/{plugin_name}/{version}/
```

三个方法逐层构建路径：

1. **`plugin_base_root(plugin_id)`** → `cache/marketplace/plugin_name`
2. **`plugin_root(plugin_id, version)`** → `cache/marketplace/plugin_name/version`
3. **`active_plugin_root(plugin_id)`** → 自动发现活跃版本后返回完整路径

### 版本发现（`active_plugin_version`）

版本发现逻辑（`store.rs:57-78`）：

1. 读取 `plugin_base_root` 下的所有子目录
2. 过滤出有效的版本目录名（通过 `validate_plugin_segment` 校验，仅允许 ASCII 字母、数字、`_`、`-`）
3. 对版本列表排序
4. **优先选择 `"local"` 版本**——如果存在，直接返回
5. 否则返回排序后的最后一个（字典序最大的版本）
6. 无版本目录时返回 `None`

这一设计意味着本地开发版本（`local`）始终优先于远程下载的版本（如 commit hash `0123456789abcdef`）。

### 安装流程（`install` / `install_with_version`）

安装是整个模块最复杂的流程，采用**原子替换 + 备份回滚**策略（`store.rs:89-131`、`195-260`）：

**1. 校验阶段**
- 验证 `source_path` 是目录
- 从源目录加载插件清单（`.codex-plugin/plugin.json`），提取清单中的 `name` 字段
- 校验清单名称与 `plugin_id.plugin_name` **严格一致**——不一致则拒绝安装
- 校验版本字符串格式（`validate_plugin_segment`）

**2. 原子安装阶段**（`replace_plugin_root_atomically`，`store.rs:195-260`）

```
步骤 1: 在 marketplace 目录下创建临时目录（plugin-install-XXXX）
步骤 2: 将源插件递归复制到临时目录中的正确子路径
步骤 3a (已有旧版本):
   - 创建备份目录（plugin-backup-XXXX）
   - 将现有目标目录 rename 到备份目录
   - 尝试将临时目录 rename 到目标位置
   - 如果 rename 失败，尝试回滚（将备份恢复原位）
   - 如果回滚也失败，保留备份目录并返回详细错误信息
步骤 3b (全新安装):
   - 直接将临时目录 rename 到目标位置
```

这个设计确保了：
- **原子性**：通过 `rename` 实现瞬间切换，不会出现"半安装"状态
- **安全性**：旧版本在新版本就位前不会被删除
- **可恢复性**：即使最坏情况（rename 和回滚都失败），备份文件仍保留在磁盘上，错误信息中包含备份路径

**3. 返回安装结果**

成功时返回 `PluginInstallResult`，包含插件 ID、版本和安装路径。

### 卸载流程（`uninstall`）

直接删除 `plugin_base_root` 整个目录（`store.rs:133-136`），即删除该插件的所有版本。内部使用 `remove_existing_target`，如果目录不存在则视为成功。

## 函数签名

### 公开 API

#### `PluginStore::new(codex_home: PathBuf) -> Self`
构造函数，基于 codex_home 路径初始化缓存根目录。

#### `PluginStore::root(&self) -> &AbsolutePathBuf`
返回缓存根路径（`codex_home/plugins/cache`）。

#### `PluginStore::plugin_base_root(&self, plugin_id: &PluginId) -> AbsolutePathBuf`
返回插件基础路径（不含版本）。

#### `PluginStore::plugin_root(&self, plugin_id: &PluginId, plugin_version: &str) -> AbsolutePathBuf`
返回指定版本的完整路径。

#### `PluginStore::active_plugin_version(&self, plugin_id: &PluginId) -> Option<String>`
发现并返回当前活跃版本。优先 `"local"`，否则取字典序最大版本。

#### `PluginStore::active_plugin_root(&self, plugin_id: &PluginId) -> Option<AbsolutePathBuf>`
返回活跃版本的完整安装路径。

#### `PluginStore::is_installed(&self, plugin_id: &PluginId) -> bool`
检查插件是否已安装（有任意版本目录即视为已安装）。

#### `PluginStore::install(&self, source_path: AbsolutePathBuf, plugin_id: PluginId) -> Result<PluginInstallResult, PluginStoreError>`
以默认版本 `"local"` 安装插件。

#### `PluginStore::install_with_version(&self, source_path: AbsolutePathBuf, plugin_id: PluginId, plugin_version: String) -> Result<PluginInstallResult, PluginStoreError>`
以指定版本安装插件。执行清单校验和原子安装。

#### `PluginStore::uninstall(&self, plugin_id: &PluginId) -> Result<(), PluginStoreError>`
卸载插件（删除该插件的所有版本）。

### 内部函数

#### `plugin_name_for_source(source_path: &Path) -> Result<String, PluginStoreError>`
从源目录加载 `.codex-plugin/plugin.json` 清单，提取并校验插件名称（`store.rs:157-177`）。

#### `replace_plugin_root_atomically(source, target_root, plugin_version) -> Result<(), PluginStoreError>`
原子替换核心逻辑：临时目录复制 → 备份旧版本 → rename 切换 → 失败时回滚（`store.rs:195-260`）。

#### `copy_dir_recursive(source, target) -> Result<(), PluginStoreError>`
递归复制目录，只处理文件和子目录（跳过符号链接等特殊文件类型）（`store.rs:262-286`）。

#### `remove_existing_target(path: &Path) -> Result<(), PluginStoreError>`
删除指定路径（目录或文件），不存在时静默成功（`store.rs:179-193`）。

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|------|------|
| `DEFAULT_PLUGIN_VERSION` | `"local"` | 默认安装版本名，也是版本发现时的优先版本 |
| `PLUGINS_CACHE_DIR` | `"plugins/cache"` | 缓存子路径（相对于 codex_home） |
| `PLUGIN_MANIFEST_PATH` | `.codex-plugin/plugin.json` | 插件清单文件路径（来自 `codex_utils_plugins` crate） |

## 边界 Case 与注意事项

- **路径遍历防护**：`PluginId` 的构造（`PluginId::new` / `PluginId::parse`）以及 `validate_plugin_segment` 严格限制名称和版本只能包含 ASCII 字母、数字、`_`、`-`，阻止 `../../etc` 之类的目录遍历攻击。
- **清单名称必须匹配**：安装时，源目录清单中的 `name` 必须与 `plugin_id.plugin_name` 完全一致。这防止了插件伪装（用一个名字的 ID 安装另一个名字的插件内容）。
- **卸载是全版本删除**：`uninstall` 删除的是 `marketplace/plugin_name` 整个目录，包含其下所有版本。不支持只卸载某个特定版本。
- **符号链接被忽略**：`copy_dir_recursive` 只处理普通文件和目录，符号链接不会被复制。
- **回滚后备份保留**：在最坏情况下（rename 和回滚都失败），备份目录不会被清理（通过 `tempdir.keep()`），错误信息中包含备份路径供手动恢复。
- **版本发现依赖目录结构**：`active_plugin_version` 仅检查子目录是否存在，不验证目录内容是否为有效插件。