# Skill 注入系统

## 概述与职责

Skill 注入（SkillInjection）模块是 **Skills** 子系统的核心运行时组件，负责将用户提及的 Skill 解析、加载并注入到 LLM 对话上下文中。它位于 `codex-rs/core-skills/src/` 目录下，由五个紧密协作的源文件组成。

在整体架构中，此模块属于 **ToolSystem → Skills** 层级。ToolSystem 定义和执行 Agent 工具，Skills 管理 Skill 的完整生命周期，而 SkillInjection 专门处理"用户提到了某个 Skill → 读取其 SKILL.md → 包装为 LLM 上下文"这一关键路径。同级模块包括 ToolDefinitions（工具注册表）、ApplyPatch、FileSearch、ShellCommand 等。

模块由以下五个文件组成：

| 文件 | 职责 |
|------|------|
| `injection.rs` | 核心注入逻辑：解析 mention、收集匹配 Skill、读取文件内容并封装为 `ResponseItem` |
| `injection_tests.rs` | `injection.rs` 的完整单元测试集 |
| `mention_counts.rs` | 统计 Skill 名称出现次数，用于消歧 |
| `env_var_dependencies.rs` | 从 Skill 的 dependencies 中提取 `env_var` 类型的工具依赖 |
| `render.rs` | 将可用 Skill 列表渲染为系统提示词中的指令段 |

## 关键流程

### 流程一：从用户输入到 Skill 注入（端到端）

整个注入过程分两个阶段：**收集匹配的 Skill**（同步）和 **构建注入项**（异步）。

#### 阶段 1：`collect_explicit_skill_mentions` — 收集显式提及的 Skill

入口函数签名（`injection.rs:100-105`）：

```rust
pub fn collect_explicit_skill_mentions(
    inputs: &[UserInput],
    skills: &[SkillMetadata],
    disabled_paths: &HashSet<PathBuf>,
    connector_slug_counts: &HashMap<String, usize>,
) -> Vec<SkillMetadata>
```

该函数接收用户输入列表、所有已知 Skill、禁用路径集合和 connector slug 计数，返回需要注入的 Skill 列表。执行步骤如下：

1. **构建名称计数表**：调用 `build_skill_name_counts()` 统计每个 Skill 名称在启用 Skill 中出现的次数（精确匹配和小写匹配），用于后续消歧（`injection.rs:106`）。

2. **优先处理结构化输入**：遍历所有 `UserInput::Skill { name, path }` 输入。这些来自 UI 层的显式选择（例如用户从 Skill 列表中点选）。按 path 精确匹配 Skill，跳过禁用和已选中的，并将该 name 加入 `blocked_plain_names` 以阻止后续文本扫描中的同名 plain-name 匹配（`injection.rs:119-136`）。

3. **扫描文本输入**：遍历所有 `UserInput::Text` 输入，调用 `extract_tool_mentions()` 解析文本中的 Skill 提及，然后通过 `select_skills_from_mentions()` 进行匹配（`injection.rs:138-150`）。

#### 阶段 2：`build_skill_injections` — 异步加载并封装

入口函数签名（`injection.rs:24-29`）：

```rust
pub async fn build_skill_injections(
    mentioned_skills: &[SkillMetadata],
    otel: Option<&SessionTelemetry>,
    analytics_client: &AnalyticsEventsClient,
    tracking: TrackEventsContext,
) -> SkillInjections
```

对每个匹配到的 Skill：
1. 异步读取其 `path_to_skills_md` 指向的 SKILL.md 文件内容（`injection.rs:41`）
2. 成功时：发射 `codex.skill.injected` OTel 计数器指标（status=ok），记录 `SkillInvocation` 分析事件，将内容包装为 `SkillInstructions` 再转换为 `ResponseItem`（`injection.rs:43-54`）
3. 失败时：发射同名指标（status=error），将错误信息加入 `warnings`（`injection.rs:57-64`）
4. 最终批量发送所有分析事件（`injection.rs:68`）

返回的 `SkillInjections` 结构体包含 `items`（注入项列表）和 `warnings`（加载失败的警告信息）。

### 流程二：文本中的 Skill 提及解析

`extract_tool_mentions()` 函数（`injection.rs:235-300`）是文本解析的核心，支持两种语法：

**语法 1：`$skill-name`（plain mention）**

以 `$`（`TOOL_MENTION_SIGIL`）为前缀，后跟由字母、数字、`_`、`-`、`:` 组成的名称。例如 `$commit`、`$slack:search`。合法字符判定见 `is_mention_name_char()`（`injection.rs:487-489`）。

**语法 2：`[$skill-name](path)`（linked mention / 资源链接）**

Markdown 链接格式，方括号内是 `$` + 名称，圆括号内是路径。解析逻辑由 `parse_linked_tool_mention()` 处理（`injection.rs:380-435`），支持括号前的空白字符，路径会被 trim。

**过滤规则**：
- 常见环境变量（`PATH`、`HOME`、`USER`、`SHELL` 等 11 个）会被 `is_common_env_var()` 过滤，避免误匹配（`injection.rs:437-453`）
- 路径类型为 `App`、`Mcp`、`Plugin` 的链接会被从 Skill 名称集合中排除（仅保留在 paths 集合中供其他系统使用）

返回的 `ToolMentions` 结构体包含三个集合：
- `names`：所有提及的名称（包括 plain 和 linked）
- `paths`：所有 linked mention 的路径
- `plain_names`：仅 plain mention 的名称（不含 linked）

### 流程三：Skill 选择与消歧

`select_skills_from_mentions()`（`injection.rs:303-378`）实现两轮匹配：

**第一轮：路径精确匹配**（`injection.rs:315-341`）

从 `ToolMentions.paths` 中提取所有 Skill 类型的路径（排除 App/Mcp/Plugin），经 `normalize_skill_path()` 去除 `skill://` 前缀后，与每个 Skill 的 `path_to_skills_md` 进行精确比对。

**第二轮：plain name 模糊匹配**（`injection.rs:343-377`）

仅对 `plain_names` 集合中的名称进行匹配，且必须满足所有消歧条件：
- 名称未被 `blocked_plain_names` 阻止（即没有同名的结构化输入）
- `skill_name_counts` 中该名称恰好出现 1 次（无同名歧义）
- `connector_slug_counts` 中该名称的小写形式出现 0 次（与 connector 无冲突）

任一条件不满足则跳过，确保只有明确无歧义的 plain name 才会被选中。

## 函数签名与参数说明

### `collect_explicit_skill_mentions`

```rust
pub fn collect_explicit_skill_mentions(
    inputs: &[UserInput],          // 用户输入列表（Text / Skill 等变体）
    skills: &[SkillMetadata],      // 所有已加载的 Skill 元数据
    disabled_paths: &HashSet<PathBuf>,  // 被禁用的 Skill 路径集合
    connector_slug_counts: &HashMap<String, usize>,  // connector slug 名称计数（小写）
) -> Vec<SkillMetadata>            // 匹配到的 Skill，保持 skills 参数中的原始顺序
```

> 源码位置：`injection.rs:100-153`

### `build_skill_injections`

```rust
pub async fn build_skill_injections(
    mentioned_skills: &[SkillMetadata],       // 前一步收集到的 Skill 列表
    otel: Option<&SessionTelemetry>,          // 可选的 OTel 遥测句柄
    analytics_client: &AnalyticsEventsClient, // 分析事件客户端
    tracking: TrackEventsContext,              // 事件追踪上下文
) -> SkillInjections                          // 包含 items 和 warnings
```

> 源码位置：`injection.rs:24-71`

### `extract_tool_mentions`

```rust
pub fn extract_tool_mentions(text: &str) -> ToolMentions<'_>
```

从单条文本中解析所有 `$name` 和 `[$name](path)` 格式的工具提及。返回的 `ToolMentions` 持有对输入 `text` 的引用（零拷贝）。

> 源码位置：`injection.rs:235-237`

### `tool_kind_for_path`

```rust
pub fn tool_kind_for_path(path: &str) -> ToolMentionKind
```

根据路径前缀判断工具类型：`app://` → App，`mcp://` → Mcp，`plugin://` → Plugin，`skill://` 或文件名为 `SKILL.md` → Skill，其余 → Other。

> 源码位置：`injection.rs:197-209`

### `build_skill_name_counts`

```rust
pub fn build_skill_name_counts(
    skills: &[SkillMetadata],
    disabled_paths: &HashSet<PathBuf>,
) -> (HashMap<String, usize>, HashMap<String, usize>)  // (精确计数, 小写计数)
```

遍历所有非禁用 Skill，返回两个 HashMap：精确名称计数和 ASCII 小写名称计数。用于判断某个名称是否唯一（消歧）。

> 源码位置：`mention_counts.rs:8-24`

### `collect_env_var_dependencies`

```rust
pub fn collect_env_var_dependencies(
    mentioned_skills: &[SkillMetadata],
) -> Vec<SkillDependencyInfo>
```

从已提及 Skill 的 `dependencies.tools` 中提取 `type == "env_var"` 且 `value` 非空的条目，返回 `SkillDependencyInfo` 列表（包含 skill_name、name、description）。

> 源码位置：`env_var_dependencies.rs:10-30`

### `render_skills_section`

```rust
pub fn render_skills_section(skills: &[SkillMetadata]) -> Option<String>
```

将可用 Skill 列表渲染为系统提示词的一部分。返回 `None` 当 skills 为空，否则生成包含 Skills 标题、列表、使用指南的完整文本段，外层包裹 `SKILLS_INSTRUCTIONS_OPEN_TAG` / `SKILLS_INSTRUCTIONS_CLOSE_TAG` 标签。

> 源码位置：`render.rs:5-48`

## 接口/类型定义

### `SkillInjections`

```rust
#[derive(Debug, Default)]
pub struct SkillInjections {
    pub items: Vec<ResponseItem>,  // 成功加载的 Skill 指令，已封装为 LLM 上下文项
    pub warnings: Vec<String>,     // 加载失败的错误信息
}
```

> 源码位置：`injection.rs:18-22`

### `ToolMentions<'a>`

```rust
pub struct ToolMentions<'a> {
    names: HashSet<&'a str>,       // 所有提及的名称（plain + linked）
    paths: HashSet<&'a str>,       // linked mention 中的路径
    plain_names: HashSet<&'a str>, // 仅 plain mention 的名称
}
```

提供 `is_empty()`、`plain_names()` 和 `paths()` 迭代器方法。零拷贝设计，引用原始文本。

> 源码位置：`injection.rs:162-180`

### `ToolMentionKind`

```rust
pub enum ToolMentionKind { App, Mcp, Plugin, Skill, Other }
```

路径前缀对应的工具类型枚举，用于分流不同类型的 mention 到各自的处理逻辑。

> 源码位置：`injection.rs:182-189`

### `SkillDependencyInfo`

```rust
pub struct SkillDependencyInfo {
    pub skill_name: String,        // 所属 Skill 名称
    pub name: String,              // 环境变量名称
    pub description: Option<String>, // 可选描述
}
```

> 源码位置：`env_var_dependencies.rs:4-8`

## 配置项与常量

| 常量 | 值 | 用途 |
|------|----|------|
| `APP_PATH_PREFIX` | `"app://"` | App 类型路径前缀 |
| `MCP_PATH_PREFIX` | `"mcp://"` | MCP 类型路径前缀 |
| `PLUGIN_PATH_PREFIX` | `"plugin://"` | Plugin 类型路径前缀 |
| `SKILL_PATH_PREFIX` | `"skill://"` | Skill 类型路径前缀 |
| `SKILL_FILENAME` | `"SKILL.md"` | Skill 定义文件的标准文件名 |
| `TOOL_MENTION_SIGIL` | `$`（来自 `codex_utils_plugins`） | 文本中标识工具提及的前缀符号 |

被过滤的环境变量名称列表（`is_common_env_var`）：`PATH`、`HOME`、`USER`、`SHELL`、`PWD`、`TMPDIR`、`TEMP`、`TMP`、`LANG`、`TERM`、`XDG_CONFIG_HOME`。

## 边界 Case 与注意事项

- **消歧优先级**：结构化 `UserInput::Skill` 输入具有最高优先级。当结构化输入指定了某个 name，该 name 的 plain-text 匹配会被 `blocked_plain_names` 机制阻止，即使结构化输入本身因路径不匹配而未选中任何 Skill（`injection.rs:121`, `injection.rs:165-183`）。
- **Skill 顺序保持**：文本扫描匹配的结果按 `skills` 参数的原始顺序（而非文本中出现的顺序）排列，测试 `collect_explicit_skill_mentions_text_respects_skill_order` 验证了这一点。
- **路径 vs 名称**：当同一文本中同时出现 `$demo-skill` 和 `[$demo-skill](/tmp/beta)` 时，路径匹配在第一轮执行，plain name 匹配在第二轮中因同名 Skill 已被 `seen_names`/`seen_paths` 记录而自动跳过（`injection.rs:239-252` 对应测试）。
- **Connector 冲突**：当 `connector_slug_counts` 中存在与 Skill 同名（小写）的条目时，plain name 匹配被跳过，但显式路径匹配仍然有效（`injection.rs:269-282` 对应测试）。
- **环境变量过滤**：`$PATH`、`$HOME` 等常见环境变量名不会被误识别为 Skill mention，避免用户讨论环境变量时的误触发。
- **Skill 名称字符集**：名称只允许 `a-zA-Z0-9_-:`，其中 `:` 支持插件命名空间语法如 `$slack:search`。遇到 `.` 等字符时名称截断。
- **OTel 指标**：每次 Skill 注入都会发射 `codex.skill.injected` 计数器，区分 `ok` 和 `error` 两种状态，并携带 `skill` 名称标签。
- **render 输出格式**：`render_skills_section` 输出被 `SKILLS_INSTRUCTIONS_OPEN_TAG` / `CLOSE_TAG` 包裹，包含可用 Skill 列表和详细的使用指南（发现、触发、缺失处理、渐进式加载、协调排序、上下文卫生等规则）。