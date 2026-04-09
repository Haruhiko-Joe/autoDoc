# SkillModel — 技能系统核心数据类型

## 概述与职责

`SkillModel` 模块（`codex-rs/core-skills/src/model.rs`）定义了技能系统的全部核心数据结构和产品过滤逻辑。它是 `codex-core-skills` crate 的基础层，几乎所有其他子模块（`loader`、`manager`、`injection`、`render` 等）都依赖于此处定义的类型。

在系统架构中，该模块位于 **ToolSystem → Skills** 层级下。Skills 子系统负责技能的发现、加载、配置和注入，而 `SkillModel` 提供的数据类型贯穿整个生命周期——从 SKILL.md 文件解析出 `SkillMetadata`，到加载结果聚合为 `SkillLoadOutcome`，再到按产品过滤后注入会话上下文。

同级模块包括：ToolDefinitions（工具注册中心）、SystemSkills（内置技能安装器）、ApplyPatch、FileSearch、ShellCommand 等。

## 关键类型定义

### `SkillMetadata` — 技能元数据

技能系统中最核心的结构体，完整描述一个技能的所有元信息。

```rust
// codex-rs/core-skills/src/model.rs:10-20
pub struct SkillMetadata {
    pub name: String,
    pub description: String,
    pub short_description: Option<String>,
    pub interface: Option<SkillInterface>,
    pub dependencies: Option<SkillDependencies>,
    pub policy: Option<SkillPolicy>,
    pub path_to_skills_md: PathBuf,
    pub scope: SkillScope,
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `String` | 技能名称，用于匹配调用 |
| `description` | `String` | 技能的完整描述 |
| `short_description` | `Option<String>` | 可选的简短描述 |
| `interface` | `Option<SkillInterface>` | UI 展示元数据（图标、颜色等） |
| `dependencies` | `Option<SkillDependencies>` | 技能依赖的工具列表 |
| `policy` | `Option<SkillPolicy>` | 调用策略控制（隐式调用、产品门控） |
| `path_to_skills_md` | `PathBuf` | 声明该技能的 SKILL.md 文件路径，也用于启用/禁用判断 |
| `scope` | `SkillScope` | 技能作用域，取值为 `User`、`Repo`、`System`、`Admin` 之一（定义在 `codex-protocol` 中） |

`SkillMetadata` 提供两个方法：

- **`allow_implicit_invocation()`**（私有）：读取 `policy.allow_implicit_invocation`，若未设置则默认返回 `true`——即技能默认允许隐式调用（`model.rs:23-28`）
- **`matches_product_restriction_for_product()`**：判断技能是否适用于指定产品。若技能未设置 policy 或 `products` 列表为空，则对所有产品可用；否则检查目标产品是否在允许列表中（`model.rs:30-43`）

### `SkillPolicy` — 调用策略

```rust
// codex-rs/core-skills/src/model.rs:46-52
pub struct SkillPolicy {
    pub allow_implicit_invocation: Option<bool>,
    pub products: Vec<Product>,
}
```

控制技能的两个维度：
- **`allow_implicit_invocation`**：是否允许 Agent 在用户未明确指定时自动调用该技能。`None` 等同于 `true`（默认允许）
- **`products`**：产品门控列表。`Product` 枚举定义在 `codex-protocol` 中，取值为 `Chatgpt`、`Codex`、`Atlas`。空列表表示不限制产品

> 注意：代码中有一条 TODO 注释（`model.rs:49`）表明产品门控目前只做了解析和存储，尚未在技能选择/注入阶段强制执行。

### `SkillInterface` — UI 展示元数据

```rust
// codex-rs/core-skills/src/model.rs:54-62
pub struct SkillInterface {
    pub display_name: Option<String>,
    pub short_description: Option<String>,
    pub icon_small: Option<PathBuf>,
    pub icon_large: Option<PathBuf>,
    pub brand_color: Option<String>,
    pub default_prompt: Option<String>,
}
```

面向 UI 层的展示信息——技能在 TUI 或 IDE 扩展中的显示名称、图标路径、品牌色、以及用户可见的默认 prompt 文本。所有字段均为可选。

### `SkillDependencies` / `SkillToolDependency` — 工具依赖

```rust
// codex-rs/core-skills/src/model.rs:64-77
pub struct SkillDependencies {
    pub tools: Vec<SkillToolDependency>,
}

pub struct SkillToolDependency {
    pub r#type: String,
    pub value: String,
    pub description: Option<String>,
    pub transport: Option<String>,
    pub command: Option<String>,
    pub url: Option<String>,
}
```

声明技能运行时依赖的外部工具。每个 `SkillToolDependency` 描述一个工具依赖项：
- `type` / `value`：标识依赖的类型和值（如 MCP 工具名）
- `transport`：连接方式（如 stdio、SSE）
- `command` / `url`：启动命令或服务地址

### `SkillError` — 加载错误

```rust
// codex-rs/core-skills/src/model.rs:79-83
pub struct SkillError {
    pub path: PathBuf,
    pub message: String,
}
```

记录技能加载失败的信息——哪个文件（`path`）出了什么问题（`message`）。

### `SkillLoadOutcome` — 加载结果聚合

```rust
// codex-rs/core-skills/src/model.rs:85-92
pub struct SkillLoadOutcome {
    pub skills: Vec<SkillMetadata>,
    pub errors: Vec<SkillError>,
    pub disabled_paths: HashSet<PathBuf>,
    pub(crate) implicit_skills_by_scripts_dir: Arc<HashMap<PathBuf, SkillMetadata>>,
    pub(crate) implicit_skills_by_doc_path: Arc<HashMap<PathBuf, SkillMetadata>>,
}
```

整个技能加载流程的最终产出物，包含：

| 字段 | 可见性 | 说明 |
|------|--------|------|
| `skills` | 公开 | 所有成功加载的技能列表 |
| `errors` | 公开 | 加载过程中遇到的错误 |
| `disabled_paths` | 公开 | 被用户配置规则禁用的 SKILL.md 路径集合 |
| `implicit_skills_by_scripts_dir` | crate 内部 | 按脚本目录索引的隐式技能映射，用于命令行检测隐式调用 |
| `implicit_skills_by_doc_path` | crate 内部 | 按文档路径索引的隐式技能映射 |

两个内部索引使用 `Arc<HashMap<...>>` 包裹，支持在多线程环境中廉价克隆共享。

## 关键流程

### 技能启用与隐式调用判断

`SkillLoadOutcome` 提供了一组查询方法，构成技能筛选的核心逻辑链：

1. **`is_skill_enabled()`**（`model.rs:95-97`）：检查技能的 `path_to_skills_md` 是否在 `disabled_paths` 集合中。这是最基础的开关——用户可通过配置规则禁用特定技能。

2. **`is_skill_allowed_for_implicit_invocation()`**（`model.rs:99-101`）：组合两个条件——技能必须 **已启用** 且 **策略允许隐式调用**。两者缺一不可。

3. **`allowed_skills_for_implicit_invocation()`**（`model.rs:103-109`）：返回所有允许隐式调用的技能副本列表。调用链为：遍历 `skills` → 逐个检查 `is_skill_allowed_for_implicit_invocation` → 克隆通过的技能。

4. **`skills_with_enabled()`**（`model.rs:111-115`）：返回一个迭代器，将每个技能与其启用状态配对为 `(&SkillMetadata, bool)` 元组，供 UI 渲染时区分展示。

### 产品过滤流程

`filter_skill_load_outcome_for_product()` 函数（`model.rs:118-142`）根据目标产品过滤整个加载结果。这是一个顶层公开函数，对 `SkillLoadOutcome` 的三个包含技能的集合执行一致的过滤：

1. 对 `skills` 向量调用 `retain()`，原地移除不匹配的技能
2. 重建 `implicit_skills_by_scripts_dir` 的 `Arc<HashMap>`，只保留匹配的条目
3. 重建 `implicit_skills_by_doc_path` 的 `Arc<HashMap>`，只保留匹配的条目

每个技能的匹配逻辑委托给 `SkillMetadata::matches_product_restriction_for_product()`：
- 无 policy → 通过（对所有产品可用）
- policy 的 `products` 为空 → 通过
- 否则检查目标产品是否在列表中（最终调用 `Product::matches_product_restriction()`，即 `products.contains(self)`）

## 模块导出

在 `lib.rs`（`codex-rs/core-skills/src/lib.rs:20-24`）中，以下类型被 re-export 为 crate 的公开 API：

- `SkillError`
- `SkillLoadOutcome`
- `SkillMetadata`
- `SkillPolicy`
- `filter_skill_load_outcome_for_product`

这意味着外部 crate 可以直接通过 `codex_core_skills::SkillMetadata` 等路径访问这些类型，无需深入 `model` 子模块。

## 边界 Case 与注意事项

- **隐式调用默认开启**：`allow_implicit_invocation` 为 `None` 时默认 `true`。技能作者如果不想被隐式调用，必须显式设置为 `false`。
- **产品门控尚未完全执行**：代码中的 TODO（`model.rs:49`）表明 `SkillPolicy.products` 目前只在过滤函数中生效，技能选择和注入阶段的强制执行尚待实现。
- **`SkillInterface` 和 `SkillDependencies` 未 re-export**：这两个类型在 `lib.rs` 中没有被 re-export，只能通过 `codex_core_skills::model::SkillInterface` 访问。
- **内部索引的 `Arc` 包裹**：`implicit_skills_by_scripts_dir` 和 `implicit_skills_by_doc_path` 使用 `Arc` 是因为 `SkillLoadOutcome` 需要在 crate 内被多处引用共享，`filter_skill_load_outcome_for_product` 在过滤时需要重建这些 `Arc`。