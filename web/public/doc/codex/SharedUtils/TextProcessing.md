# 文本处理工具集（TextProcessing）

## 概述与职责

文本处理工具集是 SharedUtils 层中的基础设施模块，为 Codex 工作空间内的多个 crate 提供字符串操作和文本处理能力。它由四个独立的 Rust crate 组成：

| Crate | 职责 |
|-------|------|
| `codex-utils-string` | 底层字符串工具：token 估算、中间截断、UUID 提取、指标标签清洗、Markdown 位置后缀转换 |
| `codex-utils-output-truncation` | 面向工具输出的截断策略层，基于 `TruncationPolicy`（字节/token 两种模式）处理 `FunctionCallOutputContentItem` |
| `codex-utils-fuzzy-match` | 大小写不敏感的子序列模糊匹配，用于文件搜索的候选排序 |
| `codex-utils-template` | 严格的 `{{ placeholder }}` 模板引擎，用于 prompt 和文本资产的渲染 |

在整体架构中，这些 crate 属于 **SharedUtils** 子系统，被 Core（agent 核心）、ToolSystem（工具框架）、TUI（终端界面）等上层模块广泛引用。例如，当 agent 执行 shell 命令后需要将超长输出截断以适应 LLM 上下文窗口时，就会调用 `output-truncation` crate；TUI 的文件搜索功能则使用 `fuzzy-match` 进行候选过滤和排名。

---

## 子模块一：codex-utils-string — 底层字符串工具

### Token 估算与中间截断

该 crate 的核心能力是**token 感知的中间截断**——在 LLM 上下文预算有限时，保留文本的头部和尾部，截去中间部分并插入标记。

#### 关键常量与估算函数

使用固定比例 `APPROX_BYTES_PER_TOKEN = 4` 进行字节↔token 的近似换算（`codex-rs/utils/string/src/truncate.rs:4`）：

- `approx_token_count(text) -> usize`：将字节数向上取整除以 4，估算 token 数
- `approx_bytes_for_tokens(tokens) -> usize`：token 数 × 4，得到字节预算
- `approx_tokens_from_byte_count(bytes) -> u64`：同 `approx_token_count` 但返回 `u64`

#### 截断函数

**`truncate_middle_chars(s, max_bytes) -> String`**（`codex-rs/utils/string/src/truncate.rs:7`）

按**字节预算**截断，中间替换为 `…{N} chars truncated…` 标记。预算按 50/50 分配给头尾两段。

**`truncate_middle_with_token_budget(s, max_tokens) -> (String, Option<u64>)`**（`codex-rs/utils/string/src/truncate.rs:15`）

按**token 预算**截断。先将 token 预算转为字节预算，然后执行相同的中间截断逻辑。返回值的第二个元素：若发生了截断则为 `Some(原始 token 数)`，否则为 `None`。

截断的内部流程（`truncate_with_byte_estimate`，`codex-rs/utils/string/src/truncate.rs:38-69`）：

1. 调用 `split_budget` 将字节预算对半拆分为 `left_budget` 和 `right_budget`
2. 调用 `split_string` 在 **UTF-8 字符边界**上切出前缀和后缀，计算被移除的字符数
3. 生成截断标记（token 模式显示 `…N tokens truncated…`，字节模式显示 `…N chars truncated…`）
4. 拼接 `前缀 + 标记 + 后缀` 返回

`split_string`（`codex-rs/utils/string/src/truncate.rs:86-124`）通过单次遍历 `char_indices()` 实现：前缀取满足字节预算的最长前段，后缀从字节倒数位置开始，中间字符计入 `removed_chars`。对多字节 UTF-8 字符（如 emoji）能正确处理边界。

### 字节边界安全切片

**`take_bytes_at_char_boundary(s, maxb) -> &str`**（`codex-rs/utils/string/src/lib.rs:11`）

取字符串的前 `maxb` 字节（前缀），保证不会切断 UTF-8 字符。

**`take_last_bytes_at_char_boundary(s, maxb) -> &str`**（`codex-rs/utils/string/src/lib.rs:28`）

取字符串的后 `maxb` 字节（后缀），同样保证 UTF-8 安全。

### UUID 提取

**`find_uuids(s) -> Vec<String>`**（`codex-rs/utils/string/src/lib.rs:75`）

使用 `regex_lite` 提取字符串中所有标准格式（8-4-4-4-12）的 UUID。正则表达式通过 `OnceLock` 实现惰性编译、全局复用。

### 指标标签清洗

**`sanitize_metric_tag_value(value) -> String`**（`codex-rs/utils/string/src/lib.rs:50`）

将任意字符串转为合法的 metric tag 值：
- 仅保留 ASCII 字母数字和 `.` `_` `-` `/`，其余字符替换为 `_`
- 去除首尾下划线
- 结果为空或无字母数字字符时返回 `"unspecified"`
- 截断到最大 256 字符

### Markdown 位置后缀转换

**`normalize_markdown_hash_location_suffix(suffix) -> Option<String>`**（`codex-rs/utils/string/src/lib.rs:89`）

将 GitHub 风格的 Markdown 锚点后缀（如 `#L74C3-L76C9`）转换为终端友好的格式（如 `:74:3-76:9`）。解析规则：

- `#L{line}` → `:{line}`
- `#L{line}C{col}` → `:{line}:{col}`
- `#L{start_line}C{start_col}-L{end_line}C{end_col}` → `:{start_line}:{start_col}-{end_line}:{end_col}`
- 格式不匹配时返回 `None`

---

## 子模块二：codex-utils-output-truncation — 输出截断策略

### 概述

该 crate 构建在 `codex-utils-string` 之上，为 agent 工具输出（`FunctionCallOutputContentItem`）提供基于 `TruncationPolicy` 的截断能力。`TruncationPolicy` 是 `codex-protocol` 中定义的枚举，有两个变体：

- `TruncationPolicy::Bytes(usize)`：按字节预算截断
- `TruncationPolicy::Tokens(usize)`：按 token 预算截断

### 公开 API

**`truncate_text(content, policy) -> String`**（`codex-rs/utils/output-truncation/src/lib.rs:22`）

根据策略调用底层截断函数：`Bytes` 模式调用 `truncate_middle_chars`，`Tokens` 模式调用 `truncate_middle_with_token_budget`。

**`formatted_truncate_text(content, policy) -> String`**（`codex-rs/utils/output-truncation/src/lib.rs:12`）

在 `truncate_text` 基础上，当文本被截断时在最前面添加 `Total output lines: {N}` 行，帮助 LLM 理解原始输出的规模。

**`formatted_truncate_text_content_items_with_policy(items, policy) -> (Vec<..>, Option<usize>)`**（`codex-rs/utils/output-truncation/src/lib.rs:29`）

处理 `FunctionCallOutputContentItem` 列表的**合并截断**策略：
1. 将所有 `InputText` 项合并为一个字符串（用换行连接）
2. 对合并后的文本执行 `formatted_truncate_text`
3. 输出中文本项变为单个截断项，图像项保留在末尾
4. 返回值第二个元素为合并文本的近似 token 数（仅在截断时有值）

**`truncate_function_output_items_with_policy(items, policy) -> Vec<..>`**（`codex-rs/utils/output-truncation/src/lib.rs:73`）

处理 `FunctionCallOutputContentItem` 列表的**逐项截断**策略：
1. 维护一个递减的剩余预算
2. 依次处理每个文本项：预算充足时保留原文，预算不足时对当前项截断，预算耗尽后的文本项被跳过
3. 图像项始终保留，不消耗预算
4. 被跳过的文本项在末尾以 `[omitted {N} text items ...]` 汇总

**`approx_tokens_from_byte_count_i64(bytes: i64) -> i64`**（`codex-rs/utils/output-truncation/src/lib.rs:132`）

`i64` 版本的字节→token 换算，非正数返回 0。

### 两种截断策略的适用场景

- **`formatted_truncate_text_content_items_with_policy`**（合并模式）：当需要将多段文本作为一个整体呈现给 LLM 时使用，所有文本合并后统一截断，保留头尾上下文
- **`truncate_function_output_items_with_policy`**（逐项模式）：当输出包含多个独立文本片段（可能夹杂图像）时使用，按顺序分配预算，先到先得

---

## 子模块三：codex-utils-fuzzy-match — 模糊子序列匹配

### 核心算法

**`fuzzy_match(haystack, needle) -> Option<(Vec<usize>, i32)>`**（`codex-rs/utils/fuzzy-match/src/lib.rs:12`）

在 `haystack` 中查找 `needle` 的子序列匹配（大小写不敏感），返回匹配字符在原始 `haystack` 中的位置索引和评分。

**匹配流程**：

1. **小写展开**：将 `haystack` 的每个字符通过 `char::to_lowercase()` 展开，同时维护一个 `lowered_to_orig_char_idx` 映射表——记录展开后每个字符对应的**原始字符索引**。这是处理 Unicode 大小写展开（如 `İ` → `i̇` 双字符）的关键。
2. **子序列扫描**：遍历小写化的 needle，在小写化的 haystack 中依次找到每个字符，记录匹配位置
3. **结果映射**：通过映射表将匹配位置转回原始 `haystack` 的字符索引，去重排序后返回

**评分规则**（分数越小越好）：

```
score = max(0, (last_hit - first_hit + 1) - needle_len)
if first_hit == 0: score -= 100   // 前缀匹配奖励
```

- 匹配越紧凑，分数越低（更好）
- 从字符串开头开始匹配额外减 100 分
- 空 needle 匹配任何字符串，返回 `i32::MAX`（最低优先级）

**边界行为**：
- `ß` 不会匹配 `ss`——因为 `to_lowercase()` 不展开 `ß`，只有 `to_uppercase()` 才会
- `İ`（带点大写 I）的小写展开为 `i̇`（两个字符），映射表确保返回的索引仍指向原始位置 0

**`fuzzy_indices(haystack, needle) -> Option<Vec<usize>>`**（`codex-rs/utils/fuzzy-match/src/lib.rs:72`）

便捷包装，仅返回匹配位置索引（丢弃评分），用于不需要排序的高亮场景。

---

## 子模块四：codex-utils-template — 严格模板引擎

### 概述

一个最小化的模板系统，专为 prompt 和文本资产的占位符替换设计。语法严格，不支持条件、循环等逻辑——只做插值。

### 语法

| 语法 | 含义 |
|------|------|
| `{{ name }}` | 占位符，渲染时替换为对应变量值（名称前后空格会被 trim） |
| `{{{{` | 转义，输出字面量 `{{` |
| `}}}}` | 转义，输出字面量 `}}` |

### 类型定义

#### `Template`（`codex-rs/utils/template/src/lib.rs:116`）

解析后的模板对象，内部由 `Segment` 序列（`Literal` 或 `Placeholder`）和去重的占位符名称集合（`BTreeSet<String>`）组成。可复用——解析一次、多次渲染。

#### 错误类型

**`TemplateParseError`**（`codex-rs/utils/template/src/lib.rs:14`）：

| 变体 | 含义 |
|------|------|
| `EmptyPlaceholder { start }` | `{{   }}` 占位符名称为空 |
| `NestedPlaceholder { start }` | `{{ outer {{ inner }} }}` 占位符内嵌套了 `{{` |
| `UnmatchedClosingDelimiter { start }` | 出现了孤立的 `}}` |
| `UnterminatedPlaceholder { start }` | `{{ name` 缺少闭合的 `}}` |

**`TemplateRenderError`**（`codex-rs/utils/template/src/lib.rs:49`）：

| 变体 | 含义 |
|------|------|
| `MissingValue { name }` | 模板中的占位符未提供值 |
| `ExtraValue { name }` | 提供了模板中不存在的变量 |
| `DuplicateValue { name }` | 同一变量被提供了两次 |

**`TemplateError`**（`codex-rs/utils/template/src/lib.rs:74`）：统一包装类型，包含 `Parse` 和 `Render` 两个变体。

### 公开 API

**`Template::parse(source) -> Result<Template, TemplateParseError>`**（`codex-rs/utils/template/src/lib.rs:122`）

解析模板字符串。内部逐字符扫描，遇到 `{{{{` / `}}}}` 输出字面量，遇到 `{{` 进入占位符解析，遇到孤立 `}}` 报错。

**`Template::placeholders() -> impl ExactSizeIterator<Item = &str>`**（`codex-rs/utils/template/src/lib.rs:170`）

返回模板中所有占位符名称（去重、按字母排序）。

**`Template::render(variables) -> Result<String, TemplateRenderError>`**（`codex-rs/utils/template/src/lib.rs:174`）

使用提供的键值对渲染模板。**严格模式**——变量必须与占位符**完全匹配**：多了、少了、重复了都会报错。

**`render(template, variables) -> Result<String, TemplateError>`**（`codex-rs/utils/template/src/lib.rs:212`）

一步到位的便捷函数，内部先 `parse` 再 `render`。

### 关键设计决策

1. **严格匹配**：禁止多余或缺失的变量，避免 prompt 模板中的 silent failure
2. **无逻辑**：不支持条件/循环/过滤器，降低模板注入风险，符合 prompt 模板的简单需求
3. **可复用解析**：`Template` 对象可缓存并多次渲染，避免重复解析开销

---

## 边界 Case 与注意事项

- **Token 估算是近似值**：固定 4 字节/token 的比例对英文文本大致成立，但对中文、emoji 等多字节字符会有偏差。这是有意的权衡——用简单快速的估算代替真实 tokenizer 调用
- **截断标记本身占用空间**：`…N tokens truncated…` 标记会额外消耗若干字节，实际输出可能略微超过预算
- **UTF-8 边界安全**：所有截断操作都在字符边界上进行，不会产生非法 UTF-8
- **模糊匹配的 Unicode 局限**：使用 `char::to_lowercase()` 而非完整的 Unicode case folding，某些语言特定的大小写映射（如 `ß`/`SS`）不被视为匹配
- **模板转义**：要在输出中包含字面量 `{{`，需写 `{{{{`（四个大括号），这与某些模板引擎（如 Jinja2 用 `{% raw %}`）的约定不同