# 流式文本解析器（StreamParsing）

## 概述与职责

`codex-utils-stream-parser` 是 SharedUtils 层的一个工具 crate，专为 **逐字符增量处理 LLM 流式响应** 而设计。它提供了一组可组合的流式解析器，能够在不缓冲完整响应的前提下，实时完成以下任务：

- **UTF-8 字节流重组**：将可能跨 chunk 边界拆分的多字节码点正确拼接
- **引用标签检测与剥离**：识别并提取 `<oai-mem-citation>` 内联标签
- **计划块提取**：解析 `<proposed_plan>` 行级标签块，分离计划内容与普通文本
- **通用内联隐藏标签解析**：支持任意自定义标签的流式提取
- **助手文本聚合**：将引用剥离和计划解析组合为单一处理管道

该 crate 被 ModelProviders 和 Core 等上层模块用于实时处理从 LLM API 返回的流式文本。

## 核心 trait 与数据结构

### `StreamTextParser` trait

所有文本级解析器的统一接口，定义于 `src/stream_text.rs:27-36`：

```rust
pub trait StreamTextParser {
    type Extracted;
    fn push_str(&mut self, chunk: &str) -> StreamTextChunk<Self::Extracted>;
    fn finish(&mut self) -> StreamTextChunk<Self::Extracted>;
}
```

- `push_str()`：喂入一段新的文本 chunk，返回**可立即渲染的可见文本**和**提取出的隐藏载荷**
- `finish()`：流结束时刷出所有缓冲状态（含自动关闭未闭合的标签）

### `StreamTextChunk<T>`

每次 `push_str()` 或 `finish()` 调用的返回值（`src/stream_text.rs:2-8`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `visible_text` | `String` | 剥除隐藏标签后可以安全渲染给用户的文本 |
| `extracted` | `Vec<T>` | 从该 chunk 中提取出的隐藏载荷列表 |

提供 `is_empty()` 方法快速判断是否有任何产出。

## 关键流程 Walkthrough

### 完整处理管道

助手文本的典型处理路径为：

```
原始字节流 → Utf8StreamParser → AssistantTextStreamParser
                                    ├── CitationStreamParser（剥离引用标签）
                                    └── ProposedPlanParser（提取计划块，仅 plan_mode 时启用）
```

1. **字节到字符串**：`Utf8StreamParser` 接收 `&[u8]` 字节 chunk，缓冲跨 chunk 的不完整码点，将完整的 UTF-8 文本交给内层解析器
2. **引用剥离**：`CitationStreamParser` 识别 `<oai-mem-citation>...</oai-mem-citation>` 标签，将标签内容提取到 `extracted`，从 `visible_text` 中移除
3. **计划块解析**（可选）：如果启用了 `plan_mode`，`ProposedPlanParser` 进一步识别 `<proposed_plan>` 行级块，将计划内容提取为 `ProposedPlanSegment` 序列

### 内联标签匹配机制

`InlineHiddenTagParser` 是引用解析的核心引擎（`src/inline_hidden_tag.rs:36-198`），其状态机运作如下：

1. **正常扫描态**（`active` 为 `None`）：将文本追加到 `pending` 缓冲区，搜索任意已注册标签的开标签
   - 找到开标签 → 将开标签之前的文本输出为 `visible_text`，进入标签内态
   - 未找到完整开标签，但 `pending` 尾部可能是某个开标签的前缀 → 保留尾部前缀，释放前面的可见文本
2. **标签内态**（`active` 为 `Some`）：搜索对应闭标签
   - 找到闭标签 → 将标签内文本作为 `ExtractedInlineTag` 输出，回到正常态
   - 未找到，但尾部可能是闭标签前缀 → 将确认安全的文本追加到 `active.content`，保留尾部
3. **EOF**：若标签仍未关闭，自动关闭并将缓冲内容作为提取结果返回

关键细节：
- **不支持嵌套**：在标签内态遇到另一个开标签时，开标签被视为标签内容的一部分
- **多标签竞争**：同一位置有多个标签匹配时，优先选择位置靠前、长度更长的开标签（`src/inline_hidden_tag.rs:72-88`）
- **前缀匹配函数** `longest_suffix_prefix_len()`（`src/inline_hidden_tag.rs:200-208`）确保跨 chunk 的部分标签不会被过早释放为可见文本

### 行级标签解析机制

`TaggedLineParser`（`src/tagged_line_parser.rs`）用于 `<proposed_plan>` 等**必须独占一行**的标签。与内联标签不同，它的匹配规则是：

1. 每行开头进入 **标签检测模式**（`detect_tag = true`），逐字符缓冲当前行
2. 如果当前行内容是某个标签的前缀 → 继续缓冲
3. 如果缓冲内容无法匹配任何标签前缀 → 释放缓冲，切回普通文本模式
4. 行结束（遇到 `\n`）时做最终判定：
   - 整行（去除首尾空白后）完全匹配某个开/闭标签 → 产出 `TagStart` / `TagEnd`
   - 否则 → 产出 `Normal` 或 `TagDelta`（如果当前在标签块内）
5. **带额外文本的标签行会被拒绝**：如 `<proposed_plan> extra` 被视为普通文本（`src/tagged_line_parser.rs:239-248`）

## 各解析器详解

### `Utf8StreamParser<P>`

泛型包装器，将字节流 (`&[u8]`) 转为字符串流，交给内层 `P: StreamTextParser` 处理（`src/utf8_stream.rs:44-178`）。

**核心方法**：

| 方法 | 签名 | 说明 |
|------|------|------|
| `new` | `(inner: P) -> Self` | 包装一个内层解析器 |
| `push_bytes` | `(&mut self, chunk: &[u8]) -> Result<StreamTextChunk<P::Extracted>, Utf8StreamParserError>` | 喂入字节 chunk |
| `finish` | `(&mut self) -> Result<...>` | 刷出缓冲并调用内层 `finish` |
| `into_inner` | `(self) -> Result<P, ...>` | 取回内层解析器（有残留字节时报错） |
| `into_inner_lossy` | `(self) -> P` | 丢弃残留字节，无条件取回内层 |

**错误处理**：
- 遇到非法 UTF-8 字节时，**整个 chunk 被回滚**（`src/utf8_stream.rs:80-86`），内层解析器不会看到该 chunk 的任何部分，调用者可自行决定恢复策略
- EOF 时仍有不完整码点会返回 `IncompleteUtf8AtEof`

### `CitationStreamParser`

`<oai-mem-citation>` 标签的便捷解析器，是 `InlineHiddenTagParser<CitationTag>` 的薄包装（`src/citation.rs:22-63`）。

- 实现 `StreamTextParser`，`Extracted` 类型为 `String`（引用文本内容）
- 标签内容被提取到 `extracted`，标签本身从 `visible_text` 中移除

**便捷函数** `strip_citations(text: &str) -> (String, Vec<String>)`（`src/citation.rs:69-76`）：一次性处理完整字符串，返回 `(可见文本, 引用列表)`。

### `InlineHiddenTagParser<T>`

通用内联标签解析器（`src/inline_hidden_tag.rs:36-198`），支持同时注册多种标签类型。

**构造**：接收 `Vec<InlineTagSpec<T>>`，每个 spec 定义：

| 字段 | 类型 | 说明 |
|------|------|------|
| `tag` | `T` | 标签类型标识 |
| `open` | `&'static str` | 开标签字面量 |
| `close` | `&'static str` | 闭标签字面量 |

开标签和闭标签均不可为空，否则构造时 panic。

**提取产物** `ExtractedInlineTag<T>`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `tag` | `T` | 匹配到的标签类型 |
| `content` | `String` | 标签之间的文本内容 |

### `ProposedPlanParser`

`<proposed_plan>` 块的解析器（`src/proposed_plan.rs:28-61`），基于 `TaggedLineParser`。

- 实现 `StreamTextParser`，`Extracted` 类型为 `ProposedPlanSegment`
- `visible_text` 仅包含计划块之外的普通文本
- `extracted` 包含**所有**段落（包括 `Normal` 段，用于保持顺序信息）

**`ProposedPlanSegment` 枚举**：

| 变体 | 说明 |
|------|------|
| `Normal(String)` | 计划块之外的普通文本 |
| `ProposedPlanStart` | 遇到 `<proposed_plan>` 行 |
| `ProposedPlanDelta(String)` | 计划块内的文本内容 |
| `ProposedPlanEnd` | 遇到 `</proposed_plan>` 行 |

**便捷函数**：
- `strip_proposed_plan_blocks(text: &str) -> String`：移除计划块，返回剩余可见文本
- `extract_proposed_plan_text(text: &str) -> Option<String>`：提取**最后一个**计划块的内容（遇到新的 `ProposedPlanStart` 会重置已收集内容）

### `AssistantTextStreamParser`

组合管道，将引用剥离和计划解析串联为统一接口（`src/assistant_text.rs:24-73`）。

**构造**：`AssistantTextStreamParser::new(plan_mode: bool)`
- `plan_mode = false`：仅剥离引用，`plan_segments` 始终为空
- `plan_mode = true`：先剥离引用，再将可见文本交给 `ProposedPlanParser` 处理

**返回值** `AssistantTextChunk`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `visible_text` | `String` | 用户可见文本 |
| `citations` | `Vec<String>` | 提取的引用内容 |
| `plan_segments` | `Vec<ProposedPlanSegment>` | 计划段落序列 |

**数据流向**（`src/assistant_text.rs:38-43`）：
```
输入 chunk → CitationStreamParser.push_str()
          → citation_chunk.visible_text → ProposedPlanParser.push_str()（仅 plan_mode）
          → 合并为 AssistantTextChunk
```

## 边界 Case 与注意事项

- **跨 chunk 的标签**：所有解析器均正确处理标签被拆分到多个 chunk 的情况。例如 `"<oai-mem-"` 在一个 chunk、`"citation>..."` 在下一个 chunk
- **EOF 自动关闭**：未闭合的标签在 `finish()` 时自动关闭，缓冲内容作为提取结果返回
- **部分前缀在 EOF 的处理**：如果 `pending` 中的尾部看起来像标签开头但流就此结束，`finish()` 会将其作为普通可见文本输出（`src/citation.rs:144-150` 的测试验证了这一点）
- **不支持嵌套标签**：内联解析器在已打开一个标签后遇到同类开标签时，会将其视为标签内容的一部分而非新的嵌套标签（`src/citation.rs:171-178`）
- **行级标签严格匹配**：`<proposed_plan>` 必须独占一行（允许首尾空白），带有额外文本的行不会被识别为标签
- **UTF-8 错误回滚**：`Utf8StreamParser` 在遇到非法字节时回滚整个 chunk，保证内层解析器状态一致性
- **该 crate 无外部依赖**：`Cargo.toml` 仅声明了 `pretty_assertions` 作为开发依赖