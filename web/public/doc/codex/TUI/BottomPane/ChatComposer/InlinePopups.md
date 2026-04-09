# InlinePopups — 行内弹出菜单与共享辅助模块

## 概述与职责

InlinePopups 是 TUI 底部面板（BottomPane）中 ChatComposer 的三个行内弹出窗口组件及其共享辅助模块的集合。当用户在输入框中键入 `/`、`@` 等触发字符时，这些弹出窗口会出现在 composer 上方，提供可过滤的命令菜单、文件搜索结果或技能/插件提示列表。

在系统架构中，该模块位于 **TUI → BottomPane → ChatComposer** 层级下。ChatComposer 负责输入状态管理和触发路由，而本模块则负责具体的弹出内容渲染和选择逻辑。三个弹出组件均依赖同级的 **SelectionFramework**（`GenericDisplayRow`、`render_rows` 等）进行行渲染，同级兄弟模块包括 Orchestration（视图栈管理）、ApprovalOverlay（审批对话框）等。

## 模块组成

| 文件 | 职责 |
|------|------|
| `command_popup.rs` | 斜杠命令菜单，前缀匹配 + 特性开关过滤 |
| `file_search_popup.rs` | 异步文件搜索结果展示 |
| `skill_popup.rs` | 技能/插件/连接器的模糊匹配选择列表 |
| `slash_commands.rs` | 共享的内置命令过滤和查找逻辑 |
| `prompt_args.rs` | 从输入行解析 `/name <rest>` 格式的斜杠命令 |

---

## 关键流程

### 1. CommandPopup：斜杠命令菜单

**触发**：用户在 composer 中键入 `/` 时弹出。

**核心流程**：

1. **初始化**（`CommandPopup::new`）：根据传入的 `CommandPopupFlags` 调用 `slash_commands::builtins_for_input()` 获取当前可用的命令列表。同时过滤掉所有 `debug*` 前缀命令和 `Apps` 命令（`command_popup.rs:61-66`）
2. **文本变化响应**（`on_composer_text_change`）：每次 composer 文本变化时调用。从首行提取 `/` 后的第一个 token 作为过滤关键字（`command_popup.rs:78-103`）
3. **过滤匹配**（`filtered`）：执行两级匹配——先找精确匹配（exact），再找前缀匹配（prefix），二者分别收集后依次排列。别名命令（`quit`→`exit`、`approvals`→`permissions`）在无过滤时隐藏，但在有输入时仍可被匹配到（`command_popup.rs:117-164`）
4. **渲染**：将匹配结果转换为 `GenericDisplayRow`，通过 `render_rows` 渲染到终端。命令名以 `/` 前缀显示，匹配字符高亮偏移 +1 以适配前缀（`command_popup.rs:170-193`）

**特性开关机制**：`CommandPopupFlags` 结构体包含 8 个布尔标志，控制对应命令的可见性：

| 标志 | 控制的命令 |
|------|-----------|
| `collaboration_modes_enabled` | `/collab`、`/plan` |
| `connectors_enabled` | `/apps` |
| `plugins_command_enabled` | `/plugins` |
| `fast_command_enabled` | `/fast` |
| `personality_command_enabled` | `/personality` |
| `realtime_conversation_enabled` | `/realtime` |
| `audio_device_selection_enabled` | `/settings` |
| `windows_degraded_sandbox_active` | `/elevate-sandbox` |

### 2. FileSearchPopup：文件搜索弹出窗口

**触发**：用户键入 `@` 并输入查询文本时弹出。

**核心流程**：

1. **查询设置**（`set_query`）：当用户输入变化时更新 `pending_query` 并将状态设为 `waiting`。若新查询与当前 `pending_query` 相同则跳过（`file_search_popup.rs:43-52`）
2. **空提示**（`set_empty_prompt`）：当用户仅键入 `@` 但未输入搜索词时，清空所有状态并重置选择
3. **结果到达**（`set_matches`）：异步搜索结果返回时调用。仅在 `query` 与 `pending_query` 匹配时才应用结果（丢弃过时的搜索结果），且最多保留 `MAX_POPUP_ROWS` 条结果（`file_search_popup.rs:67-78`）
4. **渲染**：将 `FileMatch` 转换为 `GenericDisplayRow`（文件路径为 name，匹配位置索引转为 `usize`），空列表时显示 `"loading..."` 或 `"no matches"` 取决于 `waiting` 状态（`file_search_popup.rs:112-154`）

**关键设计**：采用 `display_query` / `pending_query` 双查询模型。`pending_query` 随用户输入实时更新，而 `display_query` 仅在收到匹配结果后更新。这确保了在搜索进行中已有结果仍然稳定可见，不会因新查询而闪烁。

### 3. SkillPopup：技能/插件选择弹出窗口

**触发**：用户在 composer 中触发 mention 输入时弹出。

**核心流程**：

1. **初始化**（`SkillPopup::new`）：接收 `Vec<MentionItem>` 作为候选列表
2. **模糊匹配过滤**（`filtered`）：使用 `codex_utils_fuzzy_match::fuzzy_match` 进行模糊匹配。对每个 `MentionItem`，先尝试匹配 `display_name`，若不匹配再逐一尝试 `search_terms`（`skill_popup.rs:130-181`）
3. **排序**：有查询时按三级排序——① `display_name` 匹配优先于仅 `search_terms` 匹配（`indices.is_none()` 排后）；② 模糊匹配分数升序；③ `sort_rank` 升序。同分时按 `display_name` 字母序。无查询时仅按 `sort_rank` + 字母序（`skill_popup.rs:158-178`）
4. **渲染**：列表区域 + 底部 hint 区域（显示"Press Enter to insert or Esc to close"）。显示名截断为 24 字符。描述由 `category_tag` 和 `description` 拼接（`skill_popup.rs:93-128`）

## 函数签名与参数说明

### slash_commands.rs

#### `builtins_for_input(flags: BuiltinCommandFlags) -> Vec<(&'static str, SlashCommand)>`

根据特性标志过滤内置命令列表。从 `built_in_slash_commands()` 获取全量命令，逐一检查每个标志决定是否保留对应命令。

> 源码位置：`codex-rs/tui/src/bottom_pane/slash_commands.rs:26-41`

#### `find_builtin_command(name: &str, flags: BuiltinCommandFlags) -> Option<SlashCommand>`

按精确名称查找单个命令。先通过 `SlashCommand::from_str` 解析，再检查该命令是否通过了特性开关过滤。

> 源码位置：`codex-rs/tui/src/bottom_pane/slash_commands.rs:44-50`

#### `has_builtin_prefix(name: &str, flags: BuiltinCommandFlags) -> bool`

检查是否有任何可见的内置命令与给定前缀模糊匹配。用于判断是否应显示命令弹窗。

> 源码位置：`codex-rs/tui/src/bottom_pane/slash_commands.rs:53-57`

### prompt_args.rs

#### `parse_slash_name(line: &str) -> Option<(&str, &str, usize)>`

从输入行解析 `/name <rest>` 格式。返回三元组 `(name, rest_after_name, rest_offset)`，其中 `rest_offset` 是 `rest_after_name` 在原始行中的字节偏移量。若行不以 `/` 开头或名称为空则返回 `None`。

> 源码位置：`codex-rs/tui/src/bottom_pane/prompt_args.rs:7-25`

## 接口/类型定义

### `CommandItem`（command_popup.rs）

```rust
pub(crate) enum CommandItem {
    Builtin(SlashCommand),
}
```

弹出列表中可选条目的抽象。目前仅包含内置命令变体。

### `CommandPopupFlags`（command_popup.rs）

8 个布尔字段的结构体，控制命令可见性。实现了 `From<CommandPopupFlags> for BuiltinCommandFlags` 用于向 `slash_commands` 模块传递。

### `MentionItem`（skill_popup.rs）

| 字段 | 类型 | 说明 |
|------|------|------|
| `display_name` | `String` | 显示名称（截断至 24 字符） |
| `description` | `Option<String>` | 描述文本 |
| `insert_text` | `String` | 选中后插入 composer 的文本 |
| `search_terms` | `Vec<String>` | 模糊匹配的备选搜索词 |
| `path` | `Option<String>` | 技能/插件的路径标识 |
| `category_tag` | `Option<String>` | 分类标签（如 `[Skill]`、`[Plugin]`） |
| `sort_rank` | `u8` | 排序权重，值越小排序越靠前 |

### `BuiltinCommandFlags`（slash_commands.rs）

与 `CommandPopupFlags` 字段基本一致，但字段名略有差异（`windows_degraded_sandbox_active` → `allow_elevate_sandbox`）。是命令过滤的核心配置类型。

## 共享渲染机制

三个弹出组件共享 SelectionFramework 的渲染原语：

- **`GenericDisplayRow`**：统一的行数据模型，包含 name、description、match_indices（高亮位置）、category_tag、display_shortcut 等字段
- **`render_rows` / `render_rows_single_line`**：接受行列表、`ScrollState`、最大可见行数和空消息文本，完成滚动窗口计算和高亮渲染
- **`ScrollState`**：管理 `selected_idx`、滚动偏移，提供 `move_up_wrap`/`move_down_wrap`（循环滚动）、`clamp_selection`、`ensure_visible` 等方法
- **`MAX_POPUP_ROWS`**：来自 `popup_consts`，限制弹窗最大可见行数

CommandPopup 和 FileSearchPopup 使用 `render_rows`（支持描述换行），SkillPopup 使用 `render_rows_single_line`（单行模式），且额外渲染了底部 hint 行。

## 边界 Case 与注意事项

- **别名隐藏策略**：`quit` 和 `approvals` 在无过滤时被隐藏（避免重复显示），但当用户主动输入前缀（如 `/qu`）时仍然可以匹配到，确保知道别名的用户仍能使用
- **过时搜索结果丢弃**：`FileSearchPopup.set_matches` 只接受与 `pending_query` 匹配的结果，先到的过时结果被静默丢弃，防止异步竞态导致显示错误
- **debug 命令始终隐藏于弹窗**：`CommandPopup::new` 硬编码过滤所有 `debug*` 前缀命令，但 `find_builtin_command` 仍可解析它们，因此用户直接输入 `/debug-config` 仍能执行
- **SkillPopup 排序中 display_name 匹配优先**：当搜索 "pr" 时，`display_name` 中包含 "PR" 的条目排在仅在 `search_terms` 中匹配的条目之前，即使后者的 `sort_rank` 更优（如 Plugin 的 rank=0 vs Skill 的 rank=1）
- **高度计算差异**：CommandPopup 调用 `measure_rows_height` 考虑描述换行；FileSearchPopup 简单取 `matches.len().clamp(1, MAX_POPUP_ROWS)`；SkillPopup 在行数基础上额外 +2（空行 + hint 行）
- **`parse_slash_name` 的 rest_offset**：返回的偏移量是相对于原始行的字节索引，调用方可直接用 `line[rest_offset..]` 获取参数部分