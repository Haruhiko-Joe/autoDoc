# Skills 集成模块

## 概述与职责

Skills 集成模块（`skills.rs`）是 TUI 层 ChatWidget 的扩展，负责 **技能（Skills）系统在聊天界面中的全部交互逻辑**。它位于 TUI > ChatSurface 层级下，是 ChatWidget 与底层 Skills 数据模型之间的桥梁。

在整体架构中，TUI 层驱动 Core 引擎处理用户消息；本模块则在消息发送前，负责解析用户输入中的技能/工具提及（mention），并管理技能的启用/禁用状态。同级模块包括 BottomPane（提供弹窗视图）和 ContentRendering（渲染内容），本模块与它们协作完成技能菜单展示和状态管理。

核心职责包括：

1. **技能菜单与管理弹窗**：打开技能列表、启用/禁用技能的 toggle 弹窗
2. **技能状态持久化**：跟踪启用/禁用变更，生成变更摘要
3. **提及解析**：从 composer 文本中解析 `$`（技能）和 `@`（工具）前缀的 mention
4. **协议类型映射**：将协议层 `ProtocolSkillMetadata` 转换为 core 层 `SkillMetadata`
5. **连接器/App mention 收集**：识别文本中引用的第三方 App 连接器

## 关键流程

### 技能菜单交互流程

1. 用户触发技能菜单，`open_skills_menu()` 构建一个包含两个选项的 `SelectionView`（`codex-rs/tui/src/chatwidget/skills.rs:31-60`）：
   - "List skills"：发送 `AppEvent::OpenSkillsList`，最终调用 `open_skills_list()` 向 composer 插入 `$` 字符触发技能自动补全
   - "Enable/Disable Skills"：发送 `AppEvent::OpenManageSkillsPopup`，打开 toggle 弹窗

2. `open_manage_skills_popup()`（`codex-rs/tui/src/chatwidget/skills.rs:62-95`）被调用时：
   - 若无可用技能，显示提示信息并返回
   - 快照当前所有技能的启用状态到 `skills_initial_state`（用于后续变更对比）
   - 将每个 `ProtocolSkillMetadata` 转换为 core 类型以获取显示名和描述
   - 构建 `SkillsToggleItem` 列表并通过 `SkillsToggleView` 展示

3. 用户切换某个技能的启用状态时，`update_skill_enabled()`（`codex-rs/tui/src/chatwidget/skills.rs:97-105`）被调用：
   - 通过 `normalize_skill_config_path()` 规范化路径后匹配目标技能
   - 更新 `skills_all` 中对应技能的 `enabled` 状态
   - 重新计算启用技能列表并调用 `set_skills()` 刷新 mention 可用集合

4. 弹窗关闭时，`handle_manage_skills_closed()`（`codex-rs/tui/src/chatwidget/skills.rs:107-138`）对比初始快照与当前状态，统计启用/禁用变更数量，向聊天记录中插入摘要消息（如 "2 skills enabled, 1 skills disabled"）。

### 技能列表初始化流程

`set_skills_from_response()`（`codex-rs/tui/src/chatwidget/skills.rs:140-144`）处理来自 app-server 的 `ListSkillsResponseEvent`：

1. 调用 `skills_for_cwd()` 从响应中按当前工作目录过滤出匹配的技能列表
2. 存储到 `self.skills_all`
3. 筛选出已启用技能并映射为 core 类型，设置为 mention 可用集合

### Mention 解析流程

文本中的 mention 有两种语法形式：

- **裸 mention**：`@tool_name` — sigil 字符后跟名称字符（字母、数字、`_`、`-`）
- **链接 mention**：`[@tool_name](path)` — Markdown 链接风格，名称关联到具体路径

`extract_tool_mentions_from_text_with_sigil()`（`codex-rs/tui/src/chatwidget/skills.rs:303-360`）逐字节扫描输入文本：

1. 遇到 `[` 时尝试 `parse_linked_tool_mention()` 解析链接 mention，提取 `(name, path)` 对
2. 遇到 sigil 字符（默认为 `@`，即 `TOOL_MENTION_SIGIL`）时解析裸 mention
3. 通过 `is_common_env_var()` 过滤掉 `$PATH`、`$HOME` 等常见环境变量名，避免误识别
4. 返回 `ToolMentions` 结构，包含所有提及的名称集合和链接路径映射

`collect_tool_mentions()`（`codex-rs/tui/src/chatwidget/skills.rs:203-214`）在此基础上补充来自 `mention_paths`（composer 维护的已知 mention 映射）的路径信息。

### 技能 Mention 匹配

`find_skill_mentions_with_tool_mentions()`（`codex-rs/tui/src/chatwidget/skills.rs:216-254`）将解析出的 mention 与已知技能列表匹配，**分两轮进行**：

1. **路径匹配优先**：从 `linked_paths` 中筛选 skill 路径（排除 `app://`、`mcp://`、`plugin://` 前缀），通过 `normalize_skill_path()` 去除 `skill://` 前缀后与技能的 `path_to_skills_md` 比较
2. **名称匹配补充**：对未被路径匹配命中的技能，按名称精确匹配
3. 使用 `seen_names` 和 `seen_paths` 两个 HashSet 去重，确保同一技能不会重复出现

### App/连接器 Mention 收集

`find_app_mentions()`（`codex-rs/tui/src/chatwidget/skills.rs:256-292`）识别文本中引用的第三方应用连接器：

1. 从链接 mention 中提取 `app://` 前缀的路径，通过 `app_id_from_path()` 获取 connector ID
2. 对裸 mention，通过 `connector_mention_slug()` 生成的 slug 匹配已启用的 App
3. slug 匹配有三个限制条件：slug 未被链接 mention 显式指定、slug 在所有启用 App 中唯一（`slug_count == 1`）、slug 不与已知技能名称冲突
4. 最终返回所有匹配且启用的 `AppInfo` 列表

## 函数签名与参数说明

### ChatWidget 方法

#### `open_skills_list(&mut self)`
向 composer 插入 `$` 字符，触发技能自动补全列表。
> 源码位置：`codex-rs/tui/src/chatwidget/skills.rs:27-29`

#### `open_skills_menu(&mut self)`
展示技能操作菜单（列表/管理两个选项），通过 `BottomPane` 的 `SelectionView` 呈现。
> 源码位置：`codex-rs/tui/src/chatwidget/skills.rs:31-60`

#### `open_manage_skills_popup(&mut self)`
打开技能启用/禁用 toggle 弹窗。快照当前状态以便关闭时计算变更差异。
> 源码位置：`codex-rs/tui/src/chatwidget/skills.rs:62-95`

#### `update_skill_enabled(&mut self, path: PathBuf, enabled: bool)`
更新指定路径的技能启用状态并刷新 mention 可用集合。
- **path**：技能定义文件的路径（`SKILLS.md` 路径）
- **enabled**：新的启用状态
> 源码位置：`codex-rs/tui/src/chatwidget/skills.rs:97-105`

#### `handle_manage_skills_closed(&mut self)`
管理弹窗关闭回调。对比初始/当前状态，向聊天记录输出变更摘要。
> 源码位置：`codex-rs/tui/src/chatwidget/skills.rs:107-138`

#### `set_skills_from_response(&mut self, response: &ListSkillsResponseEvent)`
从 app-server 的技能列表响应初始化技能数据。按当前工作目录过滤。
> 源码位置：`codex-rs/tui/src/chatwidget/skills.rs:140-144`

### 模块级公开函数

#### `collect_tool_mentions(text: &str, mention_paths: &HashMap<String, String>) -> ToolMentions`
从文本中提取所有工具 mention，并补充已知路径映射。
> 源码位置：`codex-rs/tui/src/chatwidget/skills.rs:203-214`

#### `find_skill_mentions_with_tool_mentions(mentions: &ToolMentions, skills: &[SkillMetadata]) -> Vec<SkillMetadata>`
将提取的 mention 匹配到已知技能列表，返回匹配的技能元数据。路径匹配优先于名称匹配。
> 源码位置：`codex-rs/tui/src/chatwidget/skills.rs:216-254`

#### `find_app_mentions(mentions: &ToolMentions, apps: &[AppInfo], skill_names_lower: &HashSet<String>) -> Vec<AppInfo>`
从 mention 中识别引用的第三方 App 连接器。
- **skill_names_lower**：已知技能名称集合，用于排除名称冲突的 slug 匹配
> 源码位置：`codex-rs/tui/src/chatwidget/skills.rs:256-292`

## 接口/类型定义

### `ToolMentions`（内部结构体）

```rust
pub(crate) struct ToolMentions {
    names: HashSet<String>,          // 所有提及的名称集合（裸 mention + 链接 mention）
    linked_paths: HashMap<String, String>, // 名称 → 路径的映射（仅链接 mention）
}
```
> 源码位置：`codex-rs/tui/src/chatwidget/skills.rs:294-297`

### 协议到 Core 的类型映射

`protocol_skill_to_core()`（`codex-rs/tui/src/chatwidget/skills.rs:163-197`）将 `codex_protocol::SkillMetadata` 映射为 `codex_core::skills::model::SkillMetadata`，映射字段包括：

| 协议字段 | Core 字段 | 说明 |
|---------|----------|------|
| name | name | 技能名称 |
| description | description | 完整描述 |
| short_description | short_description | 简短描述 |
| interface | interface | UI 展示信息（`SkillInterface`） |
| dependencies | dependencies | 工具依赖列表（`SkillDependencies`） |
| path | path_to_skills_md | SKILLS.md 文件路径 |
| scope | scope | 技能作用域 |
| — | policy | 固定为 `None`（协议层不传递策略） |

## 边界 Case 与注意事项

- **环境变量过滤**：`is_common_env_var()` 硬编码了 11 个常见环境变量名（`PATH`、`HOME`、`USER` 等），对这些名称的 mention 会被静默忽略，避免 `$PATH` 等 shell 语法被误解析为技能 mention。比较时使用大写转换，因此大小写不敏感。

- **路径规范化**：`normalize_skill_config_path()` 使用 `dunce::canonicalize()` 处理路径，在 Windows 上避免 UNC 路径前缀问题。规范化失败时（如文件不存在）回退到原始路径。

- **Mention 名称字符集**：仅允许 `a-z`、`A-Z`、`0-9`、`_`、`-`，不支持 Unicode 字符和空格。

- **链接 mention 路径分类**：通过 URL 前缀区分不同类型的资源——`app://` 为 App 连接器、`mcp://` 为 MCP 工具、`plugin://` 为插件、`skill://` 为技能、无前缀默认为技能路径。

- **App slug 歧义处理**：当多个启用的 App 具有相同的 `connector_mention_slug` 时，裸 mention 匹配会被跳过（`slug_count == 1` 条件），只能通过链接 mention 显式指定。这避免了歧义引用。

- **技能名称与 App slug 冲突**：如果一个裸 mention 同时匹配技能名称和 App slug，技能优先（通过 `skill_names_lower` 排除参数实现）。

- **链接 mention 中的 `names` 收集**：只有路径被判定为 skill 路径（非 `app://`/`mcp://`/`plugin://`）的链接 mention 才会将名称加入 `names` 集合，确保 App 引用不会污染技能名称匹配。