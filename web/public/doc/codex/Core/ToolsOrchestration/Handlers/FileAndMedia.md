# 文件浏览与图片查看

## 概述与职责

本模块包含两个工具处理器：**ListDirHandler** 和 **ViewImageHandler**，分别负责文件系统目录浏览和图片文件查看。它们位于 Codex 系统的 **Core → ToolsOrchestration → Handlers** 层级中，作为模型可调用的内置工具，让 AI Agent 能够感知文件系统结构和查看图片内容。

两个处理器都实现了 `ToolHandler` trait，由工具注册表（ToolRegistry）统一调度。ListDirHandler 返回文本格式的目录列表，ViewImageHandler 将图片编码为 base64 data URL 注入到模型的输入上下文中。

---

## ListDirHandler — 目录列表

### 功能概述

ListDirHandler 以递归方式列出指定目录的内容，支持可配置的递归深度、分页偏移和条目限制。输出为带缩进的文本格式，使用类型后缀标识条目类型（目录 `/`、符号链接 `@`、特殊文件 `?`）。

### 参数定义

`ListDirArgs` 结构体（`list_dir.rs:36-45`）：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `dir_path` | `String` | — | 必填，必须为绝对路径 |
| `offset` | `usize` | 1 | 1-indexed 起始条目编号，不可为 0 |
| `limit` | `usize` | 25 | 返回的最大条目数，不可为 0 |
| `depth` | `usize` | 2 | 递归遍历深度，不可为 0 |

### 关键流程

#### 请求处理流程

1. **参数解析与校验**（`list_dir.rs:54-98`）：从 `ToolPayload::Function` 中反序列化参数，校验 `offset > 0`、`limit > 0`、`depth > 0`，以及 `dir_path` 必须为绝对路径。任一校验失败则返回 `FunctionCallError::RespondToModel` 错误信息供模型理解。

2. **目录遍历**（`collect_entries`，`list_dir.rs:147-205`）：使用 BFS 策略（`VecDeque`）遍历目录树。对每一层：
   - 调用 `tokio::fs::read_dir` 异步读取目录内容
   - 获取每个条目的文件类型（`FileType`）并映射为 `DirEntryKind`
   - 构建相对路径和显示名称
   - **层内排序**：在每层目录内按名称排序后再入队，保证同一父目录下的条目有序
   - 遇到子目录且 `remaining_depth > 1` 时将其加入队列继续遍历

3. **全局排序与分页**（`list_dir_slice`，`list_dir.rs:108-145`）：
   - 收集完所有条目后按 `name`（规范化的相对路径）做全局字典序排序
   - 根据 `offset`（1-indexed）和 `limit` 切片
   - 如果切片之后仍有剩余条目，追加 `"More than {n} entries found"` 提示

4. **格式化输出**（`format_entry_line`，`list_dir.rs:225-235`）：
   - 按 `depth * 2` 个空格缩进（`INDENTATION_SPACES = 2`）
   - 追加类型后缀：目录 `/`、符号链接 `@`、其他 `?`、普通文件无后缀
   - 输出首行为 `"Absolute path: {path}"`

#### 名称截断保护

条目名称超过 `MAX_ENTRY_LENGTH`（500 字符）时，通过 `codex_utils_string::take_bytes_at_char_boundary` 在字符边界处截断，避免破坏 UTF-8 编码（`list_dir.rs:207-223`）。

### 内部类型

```rust
// list_dir.rs:246-251
enum DirEntryKind {
    Directory,
    File,
    Symlink,
    Other,
}
```

`DirEntryKind` 通过 `From<&FileType>` 实现从标准库类型转换，优先检测顺序为：符号链接 → 目录 → 文件 → 其他（`list_dir.rs:253-265`）。

### 输出示例

对于一个包含嵌套目录的文件系统，depth=3 的输出类似：

```
Absolute path: /project/src
entry.txt
link@
nested/
  child.txt
  deeper/
    grandchild.txt
```

---

## ViewImageHandler — 图片查看

### 功能概述

ViewImageHandler 读取指定路径的图片文件，校验格式，将其编码为 base64 data URL，以 `InputImage` 内容项的形式返回给模型。这使得支持多模态输入的模型能够"看到"图片内容。

### 参数定义

`ViewImageArgs` 结构体（`view_image.rs:29-32`）：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `path` | `String` | — | 必填，图片文件路径 |
| `detail` | `Option<String>` | `None` | 可选，仅支持 `"original"` 值 |

### 关键流程

1. **模态能力检查**（`view_image.rs:47-56`）：首先检查当前模型是否支持图片输入（`InputModality::Image`）。不支持时直接返回错误信息 `"view_image is not allowed because you do not support image inputs"`。

2. **参数解析与 detail 校验**（`view_image.rs:80-88`）：`detail` 参数只接受两种值——省略（使用默认缩放行为）或 `"original"`（原始分辨率）。其他值一律报错，不会静默回退。

3. **路径解析与文件校验**（`view_image.rs:90-112`）：
   - 通过 `turn.resolve_path()` 解析为绝对路径（`AbsolutePathBuf`）
   - 通过文件系统抽象层获取元数据，确认路径存在
   - 校验目标是文件而非目录

4. **图片读取与编码**（`view_image.rs:113-143`）：
   - 通过文件系统抽象读取文件字节
   - 根据 `detail` 参数和模型能力决定图片处理模式：
     - `PromptImageMode::Original`：保持原始分辨率（需模型支持 + 用户显式请求）
     - `PromptImageMode::ResizeToFit`：缩放到适合模型输入的尺寸（默认）
   - 调用 `codex_utils_image::load_for_prompt_bytes` 处理图片并生成 data URL

5. **事件通知与返回**（`view_image.rs:146-159`）：
   - 发送 `ViewImageToolCallEvent` 事件到会话事件流，携带 `call_id` 和文件路径
   - 返回 `ViewImageOutput`，包含 `image_url`（base64 data URL）和可选的 `image_detail`

### ViewImageOutput

`ViewImageOutput`（`view_image.rs:163-200`）实现了 `ToolOutput` trait，提供三种输出格式：

- **`to_response_item`**：构建 `FunctionCallOutput` 响应项，包含 `FunctionCallOutputContentItem::InputImage`，将图片作为模型的输入内容项
- **`code_mode_result`**：返回 JSON 对象 `{ "image_url": "...", "detail": ... }`，供 code-mode 使用
- **`log_preview`**：返回 data URL 字符串用于日志

### original detail 的启用条件

`original` detail 模式需要同时满足两个条件（`view_image.rs:126-135`）：

1. `can_request_original_image_detail()` 返回 `true`（由 feature flag 和模型信息共同决定）
2. 用户在参数中显式指定 `detail: "original"`

两个条件缺一不可，否则均回退到 `ResizeToFit` 默认行为。

---

## 边界 Case 与注意事项

### ListDirHandler

- **offset 是 1-indexed 的**：传入 0 会报错而非被当作起始位置
- **超大 limit 安全**：`limit` 使用 `usize::MAX` 时不会发生整数溢出，内部通过 `min(limit, remaining)` 保护（测试验证于 `list_dir_tests.rs:187-207`）
- **排序策略**：全局按规范化相对路径字典序排序，子目录内容紧跟父目录排列。路径分隔符统一为 `/`（即使在 Windows 上）
- **空目录**：返回空列表，不报错

### ViewImageHandler

- **模型不支持图片时直接拒绝**，而非静默降级
- **detail 参数严格校验**：只接受 `None` 或 `"original"`，不会将未知值静默重解释
- **依赖文件系统抽象层**：通过 `turn.environment.get_filesystem()` 读取文件，而非直接 I/O，便于测试和沙箱隔离
- **图片处理错误会透传**：格式不支持或文件损坏时，`load_for_prompt_bytes` 的错误信息会直接返回给模型