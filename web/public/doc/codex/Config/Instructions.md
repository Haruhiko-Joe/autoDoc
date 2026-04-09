# Instructions — 用户与技能指令管理

## 概述与职责

`codex-instructions` 是 Codex **Config 层**中的一个独立 crate，负责定义和序列化注入到系统 prompt 中的用户指令（AGENTS.md）与技能指令（Skill）。它是连接配置文件加载和 prompt 组装的桥梁——上游模块读取磁盘上的 AGENTS.md 文件或技能定义文件后，通过本 crate 提供的类型将其格式化为 LLM 能理解的带标记文本片段，最终作为 `ResponseItem::Message` 注入对话历史。

在整体架构中，该模块位于 **Config** 子系统下，与 Core、TUI、AppServer 等依赖 Config 的上层模块间接关联。同级模块包括特性标志（feature flags）、生命周期钩子（hooks）、层级配置文件管理等。

**crate 名称**：`codex-instructions`（`Cargo.toml` 中 `name = "codex-instructions"`）  
**依赖**：`codex-protocol`（提供 `ResponseItem`、`ContentItem` 等协议模型）、`serde`（序列化/反序列化）

## 关键流程

### AGENTS.md 指令注入流程

1. 上游模块读取某个目录下的 AGENTS.md 文件，构造 `UserInstructions { directory, text }`
2. 调用 `serialize_to_text()` 将其格式化为带 marker 的文本块：
   ```
   # AGENTS.md instructions for <directory>

   <INSTRUCTIONS>
   <text>
   </INSTRUCTIONS>
   ```
3. 通过 `impl From<UserInstructions> for ResponseItem`，自动转换为 `role: "user"` 的 `ResponseItem::Message`，注入对话历史

### Skill 指令注入流程

1. 上游模块加载技能文件，构造 `SkillInstructions { name, path, contents }`
2. 通过 `impl From<SkillInstructions> for ResponseItem`，先调用 `SKILL_FRAGMENT.wrap()` 将内容包裹在 `<skill>...</skill>` 标签中，内部包含 `<name>`、`<path>` 子标签和正文内容
3. 最终生成格式如下的消息：
   ```
   <skill>
   <name>demo-skill</name>
   <path>skills/demo/SKILL.md</path>
   body content...
   </skill>
   ```

### 片段匹配流程

当对话历史中需要识别某条消息是否为指令片段时，调用 `ContextualUserFragmentDefinition::matches_text()`：
1. 对文本前后去除空白
2. 检查是否以 `start_marker` 开头（大小写不敏感）且以 `end_marker` 结尾（大小写不敏感）
3. 返回布尔值，用于下游过滤或分类对话条目

## 函数签名与参数说明

### `UserInstructions::serialize_to_text(&self) -> String`

将用户指令序列化为带 AGENTS.md marker 的完整文本块。

- **`self.directory`**：AGENTS.md 文件所在的目录路径，出现在标题行中
- **`self.text`**：AGENTS.md 的实际内容
- **返回值**：格式化后的字符串，包含 `# AGENTS.md instructions for <dir>` 标题和 `<INSTRUCTIONS>...</INSTRUCTIONS>` 包裹的内容

> 源码位置：`codex-rs/instructions/src/user_instructions.rs:20-28`

### `ContextualUserFragmentDefinition::matches_text(&self, text: &str) -> bool`

判断给定文本是否匹配该片段定义的 start/end marker（大小写不敏感比较）。

- **`text`**：待检测的文本
- **返回值**：`true` 表示文本以 `start_marker` 开头且以 `end_marker` 结尾

> 源码位置：`codex-rs/instructions/src/fragment.rs:23-33`

### `ContextualUserFragmentDefinition::wrap(&self, body: String) -> String`

用 start/end marker 包裹给定内容体。

- **`body`**：要包裹的内容
- **返回值**：`"{start_marker}\n{body}\n{end_marker}"` 格式的字符串

> 源码位置：`codex-rs/instructions/src/fragment.rs:43-45`

### `ContextualUserFragmentDefinition::into_message(self, text: String) -> ResponseItem`

将文本包装为 `role: "user"` 的 `ResponseItem::Message`。

- **`text`**：消息的文本内容
- **返回值**：`ResponseItem::Message`，其中 `content` 为单个 `ContentItem::InputText`

> 源码位置：`codex-rs/instructions/src/fragment.rs:47-55`

## 接口/类型定义

### `UserInstructions`

```rust
pub struct UserInstructions {
    pub directory: String,  // AGENTS.md 所在目录
    pub text: String,       // 指令内容
}
```

支持 `Serialize`/`Deserialize`，serde 重命名为 `user_instructions`，字段使用 `snake_case`。实现了 `From<UserInstructions> for ResponseItem`，可直接 `.into()` 转为对话消息。

> 源码位置：`codex-rs/instructions/src/user_instructions.rs:12-17`

### `SkillInstructions`

```rust
pub struct SkillInstructions {
    pub name: String,      // 技能名称，如 "demo-skill"
    pub path: String,      // 技能文件路径，如 "skills/demo/SKILL.md"
    pub contents: String,  // 技能指令正文
}
```

同样支持 serde，重命名为 `skill_instructions`。实现了 `From<SkillInstructions> for ResponseItem`，转换时使用 `<skill>` XML 标签包裹。

> 源码位置：`codex-rs/instructions/src/user_instructions.rs:37-43`

### `ContextualUserFragmentDefinition`

```rust
#[derive(Clone, Copy)]
pub struct ContextualUserFragmentDefinition {
    start_marker: &'static str,
    end_marker: &'static str,
}
```

定义一种"上下文片段"的 marker 对。通过 `const fn new()` 构造，支持 `matches_text()`（检测）、`wrap()`（包裹）和 `into_message()`（生成消息）三种操作。该类型是 `Copy` 的，可零开销传递。

> 源码位置：`codex-rs/instructions/src/fragment.rs:9-13`

## 预定义常量

| 常量 | 类型 | start_marker | end_marker | 用途 |
|------|------|-------------|------------|------|
| `AGENTS_MD_FRAGMENT` | `ContextualUserFragmentDefinition` | `"# AGENTS.md instructions for "` | `"</INSTRUCTIONS>"` | 标识 AGENTS.md 用户指令消息 |
| `SKILL_FRAGMENT` | `ContextualUserFragmentDefinition` | `"<skill>"` | `"</skill>"` | 标识技能指令消息 |
| `USER_INSTRUCTIONS_PREFIX` | `&str` | — | — | 等于 `AGENTS_MD_START_MARKER`，即 `"# AGENTS.md instructions for "`，供外部模块快速前缀匹配 |

> 源码位置：`codex-rs/instructions/src/fragment.rs:58-61`，`codex-rs/instructions/src/user_instructions.rs:10`

## 公开导出

`lib.rs` 重新导出以下符号供外部 crate 使用：

- `AGENTS_MD_FRAGMENT` — AGENTS.md 片段定义
- `SKILL_FRAGMENT` — 技能片段定义
- `ContextualUserFragmentDefinition` — 片段定义类型
- `SkillInstructions` — 技能指令数据结构
- `USER_INSTRUCTIONS_PREFIX` — AGENTS.md 前缀字符串
- `UserInstructions` — 用户指令数据结构

> 源码位置：`codex-rs/instructions/src/lib.rs:1-11`

## 边界 Case 与注意事项

- **大小写不敏感匹配**：`matches_text()` 使用 `eq_ignore_ascii_case` 进行 marker 比较，因此 `# agents.md instructions for` 和 `# AGENTS.md instructions for` 都能匹配（`codex-rs/instructions/src/fragment.rs:27`）。
- **前后空白容忍**：`matches_text()` 在检测前会 `trim_start()` 和 `trim_end()`，即文本前后有空白字符不影响匹配结果。
- **溢出保护**：end marker 长度检查使用 `saturating_sub` 防止文本短于 marker 时的下溢（`codex-rs/instructions/src/fragment.rs:30`）。
- **消息角色固定为 `"user"`**：`into_message()` 生成的 `ResponseItem` 角色硬编码为 `"user"`，这意味着指令在对话历史中表现为用户消息而非系统消息。
- **`id`、`end_turn`、`phase` 均为 `None`**：生成的 `ResponseItem::Message` 不携带这些可选字段。