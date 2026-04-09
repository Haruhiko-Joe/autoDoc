# ChatComposer 状态机

## 概述与职责

`ChatComposer` 是 Codex TUI **BottomPane** 中最核心的子系统（约 8200 行，其中约 4400 行为测试），承担文本输入状态机的角色。它位于 `TUI > BottomPane > ChatComposer` 层级中，由 BottomPane 的 Orchestration 层持有并在无模态视图活跃时接收键盘事件。

`ChatComposer` 的主要职责包括：

- **可编辑输入缓冲区管理**：封装 `TextArea` 控件，管理光标、文本插入、原子元素（slash 命令标签、粘贴占位符、Mention 标签等）。
- **按键事件路由**：根据当前活跃弹窗（slash 命令、文件搜索、Mention 技能）分发到不同的处理路径。
- **提交/排队逻辑**：Enter 立即提交，Tab 在任务运行时排队，提交前自动展开大粘贴占位符并重新对齐文本元素的字节范围。
- **图片附件**：支持本地路径粘贴和远程 URL，统一使用 `[Image #N]` 编号。
- **Slash 命令派发**：裸命令（如 `/diff`）和带参数命令（如 `/plan args`）。
- **Mention 绑定**：`$skill_name` 样式的原子元素，关联到文件路径或插件路径。
- **非括号粘贴检测**：通过 `PasteBurst` 状态机将快速字符流识别为粘贴操作。
- **历史导航**：合并跨会话持久历史和当前会话本地历史，支持 ↑/↓ 回溯。
- **渲染**：实现 `Renderable` trait，将远程图片行、textarea 和 footer 组合为最终布局。

同级兄弟模块包括 Orchestration（BottomPane 容器）、FooterRendering（footer 渲染层）、ApprovalOverlay（工具调用审批）、AgentElicitation（Agent 交互表单）、SelectionFramework（弹窗渲染基础设施）和 SettingsViews（设置模态视图）。

## 核心数据结构

### `ChatComposer` 结构体

> 源码位置：`codex-rs/tui/src/bottom_pane/chat_composer.rs:280-341`

| 字段 | 类型 | 说明 |
|------|------|------|
| `textarea` | `TextArea` | 可编辑文本缓冲区，支持原子元素 |
| `textarea_state` | `RefCell<TextAreaState>` | 渲染时的滚动/视口状态 |
| `active_popup` | `ActivePopup` | 当前活跃弹窗（至多一个） |
| `history` | `ChatComposerHistory` | 历史导航（持久 + 本地） |
| `paste_burst` | `PasteBurst` | 非括号粘贴突发检测器 |
| `pending_pastes` | `Vec<(String, String)>` | 大粘贴占位符 → 实际文本的映射 |
| `attached_images` | `Vec<AttachedImage>` | 本地图片附件（占位符 + 路径） |
| `remote_image_urls` | `Vec<String>` | 远程图片 URL 列表 |
| `mention_bindings` | `HashMap<u64, ComposerMentionBinding>` | Mention 元素 ID → 目标路径的绑定 |
| `footer_mode` | `FooterMode` | 当前 footer 显示模式 |
| `config` | `ChatComposerConfig` | 功能开关（弹窗、slash 命令、图片粘贴） |
| `is_task_running` | `bool` | 是否有后台任务运行中 |
| `input_enabled` | `bool` | 是否处于可编辑状态 |

### `InputResult` 枚举

> 源码位置：`codex-rs/tui/src/bottom_pane/chat_composer.rs:222-234`

```rust
pub enum InputResult {
    Submitted { text: String, text_elements: Vec<TextElement> },
    Queued { text: String, text_elements: Vec<TextElement> },
    Command(SlashCommand),
    CommandWithArgs(SlashCommand, String, Vec<TextElement>),
    None,
}
```

每次按键处理后返回此枚举，上层据此决定是否发送消息、派发命令或忽略。

### `ActivePopup` 枚举

> 源码位置：`codex-rs/tui/src/bottom_pane/chat_composer.rs:356-361`

```rust
enum ActivePopup {
    None,
    Command(CommandPopup),
    File(FileSearchPopup),
    Skill(SkillPopup),
}
```

同一时刻至多一个弹窗可见，按键路由的第一步就是检查此状态。

### `ChatComposerConfig`

> 源码位置：`codex-rs/tui/src/bottom_pane/chat_composer.rs:247-278`

功能门控结构体，支持三个布尔开关：`popups_enabled`、`slash_commands_enabled`、`image_paste_enabled`。提供 `default()`（全部启用）和 `plain_text()`（全部禁用，用于嵌入其他表面的简单文本字段）两种预设。

## 关键流程

### 1. 按键事件路由

> 入口：`handle_key_event`（`codex-rs/tui/src/bottom_pane/chat_composer.rs:1197-1215`）

```
handle_key_event
├── input_enabled == false → 忽略
├── KeyEventKind::Release → 忽略
├── ActivePopup::Command → handle_key_event_with_slash_popup
├── ActivePopup::File → handle_key_event_with_file_popup
├── ActivePopup::Skill → handle_key_event_with_skill_popup
├── ActivePopup::None → handle_key_event_without_popup
└── 最后总是调用 sync_popups() 更新弹窗状态
```

无弹窗路径（`handle_key_event_without_popup`，行 2463）的优先级依次为：
1. 远程图片选择按键（Up/Down/Delete 操作远程图片行）
2. 快捷键提示 overlay（`?` 在空编辑器时切换）
3. Esc 退出提示模式
4. Ctrl+D 空编辑器检测
5. ↑/↓ 历史导航（仅在光标处于行末且文本与历史匹配时触发）
6. Tab → 提交/排队（非 `!` shell 命令时）
7. Enter → 提交
8. 其他键 → `handle_input_basic`

### 2. 提交与排队流程

> 核心方法：`handle_submission_with_time`（行 2164-2257）和 `prepare_submission_text`（行 2053-2156）

**提交路径**：

1. **尝试裸 slash 命令派发** → `try_dispatch_bare_slash_command`：如果首行匹配 `/name`（无参数），直接派发命令并清空 textarea
2. **粘贴突发检测** → 如果 `PasteBurst` 活跃且非 slash 上下文，将 Enter 视为粘贴换行而非提交
3. **尝试带参数 slash 命令** → `try_dispatch_slash_command_with_args`：如 `/plan some args`
4. **准备提交文本** → `prepare_submission_text`：
   - 展开 `pending_pastes` 中的大粘贴占位符（`expand_pending_pastes`）
   - trim 空白并 rebase 文本元素的字节范围（`trim_text_elements`）
   - 校验未知 slash 命令 → 显示错误信息并恢复草稿
   - 校验字符数上限（`MAX_USER_INPUT_TEXT_CHARS`）→ 超限则恢复草稿
   - 修剪不再引用的图片附件（`prune_attached_images_for_submission`）
   - 记录到本地历史（如果 `record_history` 为 true）
5. 返回 `InputResult::Submitted` 或 `InputResult::Queued`

**关键设计点**：提交后 textarea 被清空，但**故意保留 kill buffer**（行 46-48），用户可以 Ctrl+Y 恢复之前删除的文本。

### 3. 大粘贴占位符展开

> 方法：`expand_pending_pastes`（行 1656-1722）

当粘贴内容超过 1000 字符时，textarea 中插入 `[Pasted Content N chars]` 占位符作为原子元素，实际文本存入 `pending_pastes` 向量。提交时通过五个阶段一次遍历展开：

1. 按占位符索引 pending 载荷
2. 按字节顺序遍历元素
3. 命中占位符时内联真实粘贴内容
4. 非粘贴元素保留并更新字节范围
5. 拼接最后一个元素之后的尾部文本

### 4. 非括号粘贴突发检测

> 相关方法：`handle_input_basic_with_time`（行 2590-2720）、`handle_non_ascii_char`（行 1344-1411）

在不支持 bracketed paste 的终端（尤其是 Windows），粘贴表现为快速连续的字符事件。`PasteBurst` 状态机区分 ASCII 和非 ASCII 路径：

- **ASCII**：首字符暂时挂起（抑制闪烁），等待判断是否为粘贴流
- **非 ASCII（IME）**：首字符立即插入（避免输入延迟感），但仍允许后续突发检测，必要时从 textarea 回溯抓取已插入的字符

突发超时后通过 `flush_paste_burst_if_due` → `handle_paste` 路径将缓冲内容整合为显式粘贴。

### 5. 图片附件管理

> 方法：`attach_image`（行 1076-1084）、`relabel_attached_images_and_update_placeholders`（行 2748-2758）

**编号规则**：
- 远程图片占据 `[Image #1]..[Image #M]`
- 本地图片在远程之后偏移：`[Image #M+1]..[Image #N]`
- 删除远程图片后自动重编号本地占位符保持连续

**远程图片行**在 textarea 上方渲染为不可编辑的青色行（`remote_images_lines`，行 2381-2394），支持 ↑/↓ 选择和 Delete/Backspace 删除。

### 6. Slash 命令派发

两种路径：

1. **裸命令**（`try_dispatch_bare_slash_command`，行 2261-2279）：首行为 `/name`（无参数），直接返回 `InputResult::Command(cmd)`
2. **带参数**（`try_dispatch_slash_command_with_args`，行 2283-2315）：首行为 `/name args`，命令必须声明 `supports_inline_args()`，返回 `InputResult::CommandWithArgs(cmd, args, elements)`

Slash 命令还会在输入时被"元素化"：当用户键入 `/name ` 后，`sync_slash_command_elements` 将 `/name` 标记为原子元素，使其在视觉上与普通文本区分。

### 7. Mention 绑定生命周期

> 方法：`insert_selected_mention`（行 1927-1970）、`take_mention_bindings`（行 505-520）

用户键入 `$` 触发 Mention 弹窗（`SkillPopup`），选中后：
1. 将 `$skill_name` 作为原子元素插入 textarea
2. 在 `mention_bindings` 中记录 `element_id → (mention, path)` 映射
3. 提交时通过 `take_mention_bindings` 按元素在文本中的出现顺序提取有序的绑定列表
4. 历史回溯时通过 `bind_mentions_from_snapshot` 从文本中重新定位 `$token` 并恢复绑定

### 8. 弹窗同步机制

> 方法：`sync_popups`（行 2852-2918）

每次按键处理后自动调用，按优先级决定显示哪个弹窗：

1. 检查是否在浏览历史 → 是则关闭所有弹窗
2. 尝试 slash 命令弹窗（光标在首行 `/name` token 内且无 `@`/`$` token）
3. 尝试 Mention 弹窗（检测 `$token`）
4. 尝试文件搜索弹窗（检测 `@token`）
5. 以上均不满足则关闭弹窗

## 函数签名

### 构造与配置

| 方法 | 签名 | 说明 |
|------|------|------|
| `new` | `pub fn new(has_input_focus, app_event_tx, enhanced_keys_supported, placeholder_text, disable_paste_burst) -> Self` | 默认配置构造 |
| `new_with_config` | `pub(crate) fn new_with_config(..., config: ChatComposerConfig) -> Self` | 指定功能开关的构造 |
| `set_task_running` | `pub fn set_task_running(&mut self, running: bool)` | 标记任务运行状态 |
| `set_input_enabled` | `pub(crate) fn set_input_enabled(&mut self, enabled: bool, placeholder: Option<String>)` | 切换只读模式 |

### 输入处理

| 方法 | 签名 | 说明 |
|------|------|------|
| `handle_key_event` | `pub fn handle_key_event(&mut self, key_event: KeyEvent) -> (InputResult, bool)` | 主入口，返回结果和是否需要重绘 |
| `handle_paste` | `pub fn handle_paste(&mut self, pasted: String) -> bool` | 集成粘贴文本（显式粘贴和突发粘贴统一入口） |
| `handle_paste_image_path` | `pub fn handle_paste_image_path(&mut self, pasted: String) -> bool` | 尝试将粘贴路径转为图片附件 |
| `flush_paste_burst_if_due` | `pub(crate) fn flush_paste_burst_if_due(&mut self) -> bool` | UI tick 中刷新粘贴突发缓冲 |

### 内容管理

| 方法 | 签名 | 说明 |
|------|------|------|
| `set_text_content` | `pub(crate) fn set_text_content(&mut self, text, text_elements, local_image_paths)` | 替换全部内容（新草稿） |
| `set_text_content_with_mention_bindings` | `pub(crate) fn set_text_content_with_mention_bindings(&mut self, text, elements, images, bindings)` | 替换内容并恢复 mention 绑定 |
| `apply_external_edit` | `pub(crate) fn apply_external_edit(&mut self, text: String)` | 从外部编辑器应用修改 |
| `clear_for_ctrl_c` | `pub(crate) fn clear_for_ctrl_c(&mut self) -> Option<String>` | Ctrl+C 清空并记入本地历史 |
| `attach_image` | `pub fn attach_image(&mut self, path: PathBuf)` | 插入图片占位符和附件 |

### 提交相关

| 方法 | 签名 | 说明 |
|------|------|------|
| `prepare_submission_text` | `fn prepare_submission_text(&mut self, record_history: bool) -> Option<(String, Vec<TextElement>)>` | 提交前准备（展开占位符、trim、校验） |
| `prepare_inline_args_submission` | `pub(crate) fn prepare_inline_args_submission(&mut self, record_history: bool) -> Option<(String, Vec<TextElement>)>` | 带参数 slash 命令的提交准备 |
| `expand_pending_pastes` | `pub(crate) fn expand_pending_pastes(text, elements, pending_pastes) -> (String, Vec<TextElement>)` | 静态方法，展开占位符并重建元素范围 |

## 配置项与默认值

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `LARGE_PASTE_CHAR_THRESHOLD` | `1000` | 超过此字符数的粘贴使用占位符 |
| `MAX_USER_INPUT_TEXT_CHARS` | 来自 `codex_protocol` | 单次提交的最大字符数 |
| `FOOTER_SPACING_HEIGHT` | `0` | footer 与 textarea 间距 |
| `ChatComposerConfig::default()` | 全部 `true` | 弹窗、slash 命令、图片粘贴均启用 |
| `ChatComposerConfig::plain_text()` | 全部 `false` | 用于嵌入式纯文本字段 |

## Renderable 实现

> 源码位置：`codex-rs/tui/src/bottom_pane/chat_composer.rs:3415-3456`

`ChatComposer` 实现 `Renderable` trait，提供三个方法：

- **`cursor_pos`**：在非只读且未选中远程图片时返回光标坐标
- **`desired_height`**：累加远程图片行高 + textarea 高 + 边框(2) + 弹窗/footer 高度
- **`render`**：委托到 `render_with_mask`

**布局结构**（`layout_areas`，行 572-614）将给定区域分为四部分：

```
┌─────────────────────────────┐
│  composer_rect (含边框)      │
│  ┌─────────────────────────┐│
│  │ remote_images_rect      ││ ← 远程图片 [Image #1]..
│  │ textarea_rect           ││ ← 可编辑文本区
│  └─────────────────────────┘│
├─────────────────────────────┤
│  popup_rect                 │ ← 弹窗或 footer
└─────────────────────────────┘
```

**Zellij 兼容**（`render_textarea`，行 3692）：在 Zellij 会话中使用显式 `Color::Reset` 前景色防止面板边框颜色渗透，并替换 `.bold()`/`.dim()` 为硬编码颜色。

## Footer 模式选择

> 方法：`footer_mode`（行 2820-2841）

通过优先级瀑布解析有效模式：

| 优先级 | 模式 | 触发条件 |
|--------|------|----------|
| 1 | `EscHint` | Esc 键提示活跃 |
| 2 | `ShortcutOverlay` | `?` 切换的快捷键总览 |
| 3 | `QuitShortcutReminder` | 退出确认提示（有时效） |
| 4 | `ComposerEmpty` / `ComposerHasDraft` | 基于编辑器是否为空的默认模式 |

## 边界 Case 与注意事项

- **空行开头的 slash 命令被忽略**：以空格开头的输入（如 ` /diff`）被视为普通文本提交，不触发命令派发（`prepare_submission_text` 行 2089）
- **路径中包含 `/` 的命令名被跳过**：如 `/scope/pkg` 不会匹配任何内建命令（行 2293）
- **粘贴突发期间 Enter 不提交**：处于突发检测窗口内的 Enter 被视为粘贴换行（行 2192-2210）
- **`!` shell 命令时 Tab 不提交**：`is_bang_shell_command()` 检查阻止 Tab 提交 shell 命令（行 2529、2539）
- **已提交的附件不由 composer 清除**：`attached_images` 在 `Submitted` 后保留，由上层 `ChatWidget` 通过 `take_recent_submission_images()` 消耗
- **input disabled 模式**下所有按键被忽略，渲染 placeholder 文本替代 textarea，同时关闭任何活跃弹窗
- **字符数超限**时提交被抑制，草稿恢复原状，并向聊天区插入错误提示
- **历史回溯期间所有弹窗关闭**，避免 file search/mention popup 抢夺焦点