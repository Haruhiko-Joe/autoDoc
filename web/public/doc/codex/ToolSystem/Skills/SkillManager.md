# SkillsManager

## 概述与职责

`SkillsManager` 是 Codex 技能系统的核心编排器，位于 **ToolSystem → Skills** 层级中。它将技能发现（discovery）、配置规则（config rules）和缓存（caching）三个关注点整合在一起，为上层提供"给定当前环境，返回可用技能列表"的统一入口。

在 ToolSystem 架构中，`SkillsManager` 与同级模块 ToolDefinitions（工具注册表）协作：ToolDefinitions 依赖 Skills 提供的技能配置信息来构建工具注册计划。`SkillsManager` 又依赖下游的 SystemSkills（`codex-skills`）来安装内置技能。

该模块由两个核心文件组成：
- **`manager.rs`**：`SkillsManager` 结构体及其两条加载路径
- **`config_rules.rs`**：配置规则的解析与应用逻辑

## 关键流程

### 初始化流程

`SkillsManager` 在构造时即完成系统技能的安装/卸载决策：

1. 调用 `SkillsManager::new()` 或 `new_with_restriction_product()`，创建实例并初始化两个空缓存（`cache_by_cwd` 和 `cache_by_config`）
2. 根据 `bundled_skills_enabled` 参数决定操作：
   - **禁用**：调用 `uninstall_system_skills()` 清理 `skills/.system` 目录下的残留内容（`manager.rs:76`）
   - **启用**：调用 `install_system_skills()` 将编译时嵌入的系统技能释放到 `codex_home/skills/.system`（`manager.rs:77`）
3. 安装失败时仅记录错误日志，不阻断启动

### 加载路径一：`skills_for_cwd`（cwd 缓存）

以当前工作目录（cwd）为缓存键的加载路径，适合常规交互场景：

1. 检查 `force_reload` 标志和 `cache_by_cwd` 中是否存在命中项（`manager.rs:123`）
2. 缓存未命中或强制刷新时，调用 `skill_roots()` 收集技能根目录
3. 若配置层中 `skills.bundled.enabled = false`，过滤掉 `SkillScope::System` 根目录（`manager.rs:147-149`）
4. 合并通过 `extra_user_roots` 传入的额外用户目录（规范化后去重排序）（`manager.rs:150-158`）
5. 从配置层栈解析 `SkillConfigRules`
6. 调用 `build_skill_outcome()` 完成加载、过滤和终态构建
7. 将结果写入 `cache_by_cwd`，键为 `cwd` 路径

**重要行为**：缓存命中时直接返回旧结果，即使传入了不同的 `extra_user_roots`——只有 `force_reload = true` 才会真正刷新。测试用例 `skills_for_cwd_reuses_cached_entry_even_when_entry_has_extra_roots` 明确验证了这一点。

### 加载路径二：`skills_for_config`（配置状态缓存）

以配置有效状态为缓存键的加载路径，用于会话隔离场景（如子 agent 拥有不同的 session flags）：

1. 调用 `skill_roots_for_config()` 获取技能根目录，按 `bundled_skills_enabled` 过滤系统根（`manager.rs:106-116`）
2. 从 `ConfigLayerStack` 解析出 `SkillConfigRules`
3. 将根目录列表和规则组合为 `ConfigSkillsCacheKey`（`manager.rs:251-270`）
4. 检查 `cache_by_config` 是否命中
5. 未命中时执行 `build_skill_outcome()` 并缓存

缓存键 `ConfigSkillsCacheKey` 包含根目录路径+scope rank 和完整配置规则，因此**相同 cwd 但不同 session flags 会产生不同的缓存条目**，实现了会话级隔离。

### `build_skill_outcome` 核心构建流程

两条加载路径最终都汇聚到 `build_skill_outcome()`（`manager.rs:169-180`）：

1. `load_skills_from_roots(roots)` — 从各根目录发现并加载所有技能
2. `filter_skill_load_outcome_for_product()` — 按产品限制（如 `Product::Codex`）过滤不适用的技能
3. `resolve_disabled_skill_paths()` — 根据配置规则计算被禁用的技能路径集合
4. `finalize_skill_outcome()` — 将 `disabled_paths` 写入结果，并构建隐式调用索引

`finalize_skill_outcome()` 会调用 `build_implicit_skill_path_indexes()` 为允许隐式调用的技能建立两个索引（`manager.rs:277-280`）：
- `implicit_skills_by_scripts_dir`：按脚本目录索引
- `implicit_skills_by_doc_path`：按文档路径索引

## 配置规则系统（`config_rules.rs`）

### 规则解析：`skill_config_rules_from_stack`

从 `ConfigLayerStack` 中提取技能启用/禁用规则（`config_rules.rs:31-70`）：

1. 按**最低优先级在前**的顺序遍历配置层（`ConfigLayerStackOrdering::LowestPrecedenceFirst`）
2. 只处理 `User` 和 `SessionFlags` 两种层源，忽略其他层（如项目层、管理层）
3. 从每层的 `skills.config` 数组中提取条目
4. 每个条目通过 `skill_config_rule_selector()` 解析为选择器：
   - **`Path(PathBuf)`**：按技能文件的绝对路径匹配（通过 `dunce::canonicalize` 规范化）
   - **`Name(String)`**：按技能名称匹配
5. 关键的优先级机制：**后出现的规则覆盖先前同选择器的规则**（`config_rules.rs:61`），通过 `retain` 移除旧条目再 `push` 新条目实现

无效条目的处理（`config_rules.rs:106-129`）：
- 同时指定 `path` 和 `name`：忽略并警告
- 都未指定：忽略并警告
- `name` 为空字符串：忽略并警告

### 规则应用：`resolve_disabled_skill_paths`

将解析好的规则应用到已加载的技能列表上，返回被禁用的技能路径集合（`config_rules.rs:72-104`）：

- **Path 选择器**：直接对路径执行 `insert`（禁用）或 `remove`（启用）
- **Name 选择器**：先在技能列表中查找所有同名技能，再对它们的路径执行相同操作

规则按顺序逐条应用，后面的规则可以覆盖前面的结果。这意味着 **SessionFlags 层可以覆盖 User 层的决策**，且 **Name 选择器可以覆盖 Path 选择器**。

## 函数签名与参数说明

### `SkillsManager::new(codex_home: PathBuf, bundled_skills_enabled: bool) -> Self`

便捷构造函数，默认使用 `Product::Codex` 作为产品限制。

### `SkillsManager::new_with_restriction_product(codex_home, bundled_skills_enabled, restriction_product: Option<Product>) -> Self`

完整构造函数。`restriction_product` 为 `None` 时不进行产品过滤。

> 源码位置：`manager.rs:62-81`

### `skills_for_config(&self, input: &SkillsLoadInput) -> SkillLoadOutcome`

配置状态缓存加载路径。缓存键由根目录和配置规则共同决定，保证不同会话的技能集互不干扰。

> 源码位置：`manager.rs:89-104`

### `skills_for_cwd(&self, input: &SkillsLoadInput, force_reload: bool) -> SkillLoadOutcome`

cwd 缓存加载路径。`force_reload = true` 时跳过缓存重新加载。

> 源码位置：`manager.rs:118-129`

### `skills_for_cwd_with_extra_user_roots(&self, input, force_reload, extra_user_roots: &[PathBuf]) -> SkillLoadOutcome`

支持额外用户技能根目录的 cwd 加载路径。额外根目录会被规范化（canonicalize）、去重和排序后以 `SkillScope::User` 身份加入。

> 源码位置：`manager.rs:131-167`

### `clear_cache(&self)`

清空两个缓存（`cache_by_cwd` 和 `cache_by_config`），记录清除条目数的日志。

> 源码位置：`manager.rs:182-203`

### `skill_config_rules_from_stack(config_layer_stack: &ConfigLayerStack) -> SkillConfigRules`

从配置层栈解析技能启用/禁用规则。只处理 User 和 SessionFlags 层源。

> 源码位置：`config_rules.rs:31-70`

### `resolve_disabled_skill_paths(skills: &[SkillMetadata], rules: &SkillConfigRules) -> HashSet<PathBuf>`

将规则应用于技能列表，返回应被禁用的技能路径集合。

> 源码位置：`config_rules.rs:72-104`

### `bundled_skills_enabled_from_stack(config_layer_stack: &ConfigLayerStack) -> bool`

从有效配置中读取 `skills.bundled.enabled`，默认为 `true`（即默认启用系统内置技能）。

> 源码位置：`manager.rs:229-249`

## 接口/类型定义

### `SkillsLoadInput`

加载技能所需的输入参数包：

| 字段 | 类型 | 说明 |
|------|------|------|
| `cwd` | `PathBuf` | 当前工作目录 |
| `effective_skill_roots` | `Vec<PathBuf>` | 有效的技能根目录列表 |
| `config_layer_stack` | `ConfigLayerStack` | 配置层栈 |
| `bundled_skills_enabled` | `bool` | 是否启用系统内置技能 |

> 源码位置：`manager.rs:26-48`

### `SkillConfigRuleSelector`（枚举）

规则匹配方式，两种变体：
- `Name(String)` — 按技能名称匹配
- `Path(PathBuf)` — 按技能文件绝对路径匹配

> 源码位置：`config_rules.rs:14-18`

### `SkillConfigRule`

单条配置规则：

| 字段 | 类型 | 说明 |
|------|------|------|
| `selector` | `SkillConfigRuleSelector` | 匹配方式 |
| `enabled` | `bool` | `true` 启用，`false` 禁用 |

> 源码位置：`config_rules.rs:20-24`

### `SkillConfigRules`

规则集合，包含一个有序的 `entries: Vec<SkillConfigRule>`。实现了 `Hash` 和 `Eq`，可作为缓存键的一部分。

> 源码位置：`config_rules.rs:26-29`

### `ConfigSkillsCacheKey`（内部类型）

`skills_for_config` 的缓存键，由根目录路径+scope rank 列表和 `SkillConfigRules` 组成。scope rank 映射：Repo=0, User=1, System=2, Admin=3。

> 源码位置：`manager.rs:223-227`

## 边界 Case 与注意事项

- **缓存 poison 恢复**：所有缓存读写都通过 `unwrap_or_else(PoisonError::into_inner)` 处理，即使某个线程 panic 导致锁中毒，缓存仍可继续使用（`manager.rs:101, 164, 187, 197, 207-208, 217-218`）。

- **cwd 缓存不感知 extra roots 变化**：`skills_for_cwd` 仅以 `cwd` 路径为键。如果首次使用 `extra_user_roots=[A]` 加载，后续不带 extra roots 的调用仍会命中包含 A 的旧缓存。只有 `force_reload = true` 才能刷新。

- **SessionFlags 层的覆盖能力**：SessionFlags 层在配置层栈中优先级高于 User 层，因此会话级标志可以覆盖用户全局配置——既能重新启用被禁用的技能，也能禁用被启用的技能。

- **Name 选择器覆盖 Path 选择器**：在同一配置层中，后出现的 name 规则会覆盖先前对同一技能的 path 规则（因为两者最终操作的是同一个 `disabled_paths` 集合，且按序执行）。

- **`bundled_skills_enabled` 的双重检查**：`skills_for_cwd` 路径通过 `bundled_skills_enabled_from_stack()` 从配置层实时读取此设置，而 `skills_for_config` 路径依赖调用者在 `SkillsLoadInput` 中提供的值。两者的过滤逻辑相同——移除 `SkillScope::System` 根目录。

- **路径规范化**：额外用户根目录通过 `dunce::canonicalize` 规范化（去除 Windows UNC 前缀等），规范化失败时回退到原始路径。配置规则中的路径选择器也使用同样的规范化策略。