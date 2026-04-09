# 技能发现（SkillDiscovery）

## 概述与职责

技能发现模块是 Codex **Skills** 子系统的基础设施层，负责从文件系统中定位、加载并解析所有可用的技能定义（`SKILL.md`）。它在整体架构中位于 **ToolSystem → Skills** 路径下，与同级的 SystemSkills（内置技能安装器）协同工作——SystemSkills 将编译时内嵌的技能写入磁盘缓存目录，而本模块则从该目录及其他多个来源统一扫描并加载技能元数据。

本模块由三个源文件组成：
- **`loader.rs`**：核心实现——技能根目录解析、BFS 目录遍历、`SKILL.md` frontmatter 解析、`agents/openai.yaml` 元数据加载、字段校验
- **`loader_tests.rs`**：覆盖各种场景的单元测试
- **`system.rs`**：对 `codex-skills` crate 的薄封装，提供系统技能安装/卸载接口

## 关键流程

### 1. 技能根目录解析

入口函数 `skill_roots()` 从三类来源收集技能根目录：

**配置层（Config Layers）**：遍历 `ConfigLayerStack` 中的每一层（`loader.rs:221-272`），根据层类型映射到不同 scope：

| 配置层类型 | 生成的技能根路径 | Scope |
|-----------|-----------------|-------|
| `Project` | `<.codex>/skills` | `Repo` |
| `User` | `<CODEX_HOME>/skills`（旧路径，向后兼容） | `User` |
| `User` | `$HOME/.agents/skills` | `User` |
| `User` | `<CODEX_HOME>/skills/.system`（系统缓存） | `System` |
| `System` | `/etc/codex/skills` | `Admin` |

**插件根目录**：外部传入的 `plugin_skill_roots` 统一以 `User` scope 加入（`loader.rs:206-209`）。

**仓库 `.agents/skills` 目录**：从当前工作目录向上遍历到项目根目录（由 `.git` 等标记文件确定），沿途每一层目录的 `.agents/skills` 子目录如果存在，都会作为 `Repo` scope 的技能根加入（`loader.rs:277-292`）。

最后通过 `dedupe_skill_roots_by_path()` 去除路径重复的根目录。

### 2. BFS 目录遍历发现 SKILL.md

`discover_skills_under_root()` 对每个技能根执行广度优先搜索（`loader.rs:356-493`）：

1. 使用 `dunce::canonicalize` 解析根路径，确认是有效目录
2. 维护 `VecDeque` 队列和 `HashSet<PathBuf>` 已访问集合
3. 对每个目录条目：
   - **隐藏文件/目录**（以 `.` 开头）：跳过
   - **符号链接目录**：仅在非 `System` scope 下跟随（`loader.rs:385-388`）；解析真实路径后入队
   - **符号链接文件**：始终跳过（不加载符号链接的 `SKILL.md`）
   - **普通目录**：规范化后入队
   - **`SKILL.md` 文件**：调用 `parse_skill_file()` 解析

**安全限制**：
- `MAX_SCAN_DEPTH = 6`：最大遍历深度
- `MAX_SKILLS_DIRS_PER_ROOT = 2000`：单个根目录下最大扫描目录数
- 符号链接循环通过 `visited_dirs` 集合自动检测和避免

### 3. SKILL.md 解析

`parse_skill_file()` 的处理流程（`loader.rs:495-549`）：

1. **读取文件** → 提取 `---` 分隔的 YAML frontmatter
2. **反序列化** 为 `SkillFrontmatter` 结构体，包含 `name`、`description`、`metadata.short-description`
3. **名称解析**：
   - 有 `name` 字段则使用，否则回退到父目录名（`default_skill_name()`，`loader.rs:551-558`）
   - 如果技能位于插件目录下，自动添加命名空间前缀（如 `sample:skill-name`）（`namespaced_skill_name()`，`loader.rs:560-564`）
4. **加载可选元数据**（`agents/openai.yaml`）
5. **字段长度校验**（name ≤ 64 字符，description ≤ 1024 字符等）
6. 规范化路径后构造 `SkillMetadata` 返回

### 4. 元数据文件加载（agents/openai.yaml）

`load_skill_metadata()` 尝试读取技能目录下的 `agents/openai.yaml`（`loader.rs:566-615`）。该文件是可选的，加载失败时采用 "fail open" 策略——记录警告但不阻止技能加载。

元数据包含三个可选部分：

**Interface**（`loader.rs:617-646`）：UI 展示相关字段
- `display_name`、`short_description`、`default_prompt`：字符串字段，经过空白规范化和长度校验
- `icon_small`、`icon_large`：必须为 `assets/` 目录下的相对路径，不允许 `..`、绝对路径或 `assets/` 之外的路径
- `brand_color`：必须为 `#RRGGBB` 格式的 7 字符十六进制颜色值

**Dependencies**（`loader.rs:648-660`）：声明技能依赖的外部工具
- 每个工具有 `type`（如 `env_var`/`mcp`/`cli`）、`value`、`description`、`transport`、`command`、`url` 字段
- `type` 和 `value` 为必填，其余可选

**Policy**（`loader.rs:662-667`）：技能策略配置
- `allow_implicit_invocation`：是否允许隐式调用（未设置时默认允许）
- `products`：限制技能可用的产品列表（如 `codex`、`chatgpt`、`atlas`）

### 5. 结果汇总与排序

`load_skills_from_roots()` 汇总所有根目录的扫描结果（`loader.rs:152-184`）：

1. 对所有根依次调用 `discover_skills_under_root()`
2. 按 `path_to_skills_md` 去重（先出现的优先保留）
3. 按 scope 优先级排序（Repo > User > System > Admin），同 scope 内按名称字母序排列

## 函数签名与参数说明

### `load_skills_from_roots<I>(roots: I) -> SkillLoadOutcome`

主入口：给定一组技能根目录，返回所有发现的技能及加载错误。

- **`roots`**：实现 `IntoIterator<Item = SkillRoot>` 的迭代器，每项包含路径和 scope
- **返回值**：`SkillLoadOutcome`，包含 `skills: Vec<SkillMetadata>` 和 `errors: Vec<SkillError>`

> 源码位置：`codex-rs/core-skills/src/loader.rs:152-184`

### `skill_roots(config_layer_stack, cwd, plugin_skill_roots) -> Vec<SkillRoot>`

从配置层栈、当前工作目录和插件根目录解析出所有技能根。

- **`config_layer_stack`**：`&ConfigLayerStack`，分层配置
- **`cwd`**：`&Path`，当前工作目录
- **`plugin_skill_roots`**：`Vec<PathBuf>`，来自插件的额外技能根

> 源码位置：`codex-rs/core-skills/src/loader.rs:186-197`

### `install_system_skills` / `uninstall_system_skills`

`system.rs` 中对 `codex-skills` crate 的封装：
- `install_system_skills`：将编译时内嵌的系统技能安装到 `$CODEX_HOME/skills/.system`（由 `codex-skills` crate 实现）
- `uninstall_system_skills(codex_home: &Path)`：删除整个系统技能缓存目录（`codex-rs/core-skills/src/system.rs:6-9`）

## 接口/类型定义

### `SkillRoot`

```rust
pub struct SkillRoot {
    pub path: PathBuf,    // 技能根目录的文件系统路径
    pub scope: SkillScope, // Repo / User / System / Admin
}
```

### `SkillScope` 优先级

| Scope | 优先级 | 来源 |
|-------|--------|------|
| `Repo` | 0（最高） | 项目 `.codex/skills` 或 `.agents/skills` |
| `User` | 1 | `$CODEX_HOME/skills` 或 `$HOME/.agents/skills` |
| `System` | 2 | `$CODEX_HOME/skills/.system`（内置技能缓存） |
| `Admin` | 3（最低） | `/etc/codex/skills` |

### 内部解析结构体

- **`SkillFrontmatter`**：YAML frontmatter 反序列化目标，包含 `name`、`description`、`metadata.short-description`
- **`SkillMetadataFile`**：`agents/openai.yaml` 反序列化目标，包含 `interface`、`dependencies`、`policy`
- **`SkillParseError`**：枚举错误类型——`Read`、`MissingFrontmatter`、`InvalidYaml`、`MissingField`、`InvalidField`

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|------|------|
| `SKILLS_FILENAME` | `"SKILL.md"` | 技能定义文件名 |
| `AGENTS_DIR_NAME` | `".agents"` | 仓库内技能目录前缀 |
| `SKILLS_METADATA_DIR` | `"agents"` | 元数据子目录名 |
| `SKILLS_METADATA_FILENAME` | `"openai.yaml"` | 元数据文件名 |
| `MAX_SCAN_DEPTH` | `6` | BFS 最大遍历深度 |
| `MAX_SKILLS_DIRS_PER_ROOT` | `2000` | 单根最大扫描目录数 |
| `MAX_NAME_LEN` | `64` | 技能名称最大字符数 |
| `MAX_DESCRIPTION_LEN` | `1024` | 描述最大字符数 |

## 边界 Case 与注意事项

- **符号链接文件被忽略**：只有符号链接的目录会被跟随，符号链接的 `SKILL.md` 文件不会被加载。这是有意的安全设计。
- **System scope 不跟随符号链接**：系统技能由 Codex 自身写入，无需跟随外部符号链接（`loader.rs:385-388`）。
- **符号链接循环安全**：BFS 使用规范化路径的 `HashSet` 防止无限循环。测试用例 `does_not_loop_on_symlink_cycle_for_user_scope` 验证了此行为。
- **System scope 的解析错误被静默忽略**：当 scope 为 `System` 时，`SKILL.md` 解析失败不会记入 `outcome.errors`（`loader.rs:474-479`），因为系统技能由 Codex 自身管理。
- **Fail-open 元数据加载**：`agents/openai.yaml` 缺失或格式错误只会产生 warning 日志，不会阻止技能加载。
- **图标路径安全**：图标路径必须是 `assets/` 目录下的相对路径，含 `..` 或绝对路径的值会被丢弃。
- **颜色格式严格**：`brand_color` 必须严格匹配 `#RRGGBB`（7 个字符，`#` 后跟 6 位十六进制），不接受缩写或 CSS 颜色名。
- **向后兼容**：`$CODEX_HOME/skills` 作为旧版用户技能路径保留，新推荐路径为 `$HOME/.agents/skills`。
- **禁用的项目层仍被扫描**：`skill_roots_from_layer_stack_inner` 调用 `get_layers` 时传入 `include_disabled: true`，确保即使项目配置被标记为不受信任，其技能根仍然被发现。
- **去重规则**：同一 `SKILL.md` 路径只保留首次出现的实例（配合根目录的扫描顺序，高优先级 scope 的技能会胜出）。