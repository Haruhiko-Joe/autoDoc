# 工具执行反馈与状态指示组件（ToolFeedbackComponents）

## 概述与职责

ToolFeedbackComponents 是 Claude Code 终端 UI 中负责**工具执行反馈展示**的一组 React 组件，隶属于 `TerminalUI > UIComponents > MessageRendering` 层级。当 Claude 调用工具（如文件编辑、Bash 执行等）后，这些组件负责向用户呈现工具的执行状态——包括加载中、成功、失败、被用户拒绝、被用户中断，以及对话压缩边界等各种场景。

该模块共包含 8 个组件，约 685 行代码，覆盖了工具执行生命周期中所有可能的 UI 反馈状态。它们的同级兄弟模块包括 PermissionUI（权限审批 UI）、DesignSystem（设计系统）等，共同构成了完整的消息渲染系统。

## 组件总览

| 组件 | 文件 | 行数 | 职责 |
|------|------|------|------|
| `ToolUseLoader` | ToolUseLoader.tsx | 41 | 工具执行中的加载指示器 |
| `FallbackToolUseErrorMessage` | FallbackToolUseErrorMessage.tsx | 115 | 通用工具执行错误展示 |
| `FallbackToolUseRejectedMessage` | FallbackToolUseRejectedMessage.tsx | 15 | 通用工具拒绝消息 |
| `FileEditToolUpdatedMessage` | FileEditToolUpdatedMessage.tsx | 123 | 文件编辑成功结果展示 |
| `FileEditToolUseRejectedMessage` | FileEditToolUseRejectedMessage.tsx | 169 | 文件编辑拒绝展示 |
| `NotebookEditToolUseRejectedMessage` | NotebookEditToolUseRejectedMessage.tsx | 91 | Notebook 编辑拒绝展示 |
| `InterruptedByUser` | InterruptedByUser.tsx | 14 | 用户中断提示 |
| `CompactSummary` | CompactSummary.tsx | 117 | 对话压缩摘要展示 |

## 关键流程

### 工具执行状态指示：ToolUseLoader

`ToolUseLoader` 是工具执行过程中显示在工具名称左侧的状态圆点指示器（`BLACK_CIRCLE`）。它通过 `useBlink` Hook 实现闪烁动画效果，以视觉方式传达当前工具的执行状态。

**状态判定逻辑**（`src/components/ToolUseLoader.tsx:19-20`）：

1. `isUnresolved = true`：工具仍在执行中，圆点颜色为默认色（dimColor），闪烁动画激活（圆点与空格交替显示）
2. `isError = true`：工具执行失败，圆点显示为 `error` 色（红色），不闪烁
3. 两者均为 `false`：工具执行成功，圆点显示为 `success` 色（绿色），不闪烁

> **注意**：源码注释中特别说明了 chalk 的 dim/bold ANSI 转义序列冲突问题（`\x1b[22m` 同时用于 `</dim>` 和 `</bold>`），这导致 `<dim>` 后紧跟 `<bold>` 标签时渲染异常。组件设计通过 `minWidth={2}` 的 Box 容器避免该问题。

### 错误消息处理：FallbackToolUseErrorMessage

该组件接收工具执行的 `result` 结果，经过多层处理后展示错误信息。

**错误文本提取流程**（`src/components/FallbackToolUseErrorMessage.tsx:30-55`）：

1. 若 `result` 非字符串类型，显示通用消息 `"Tool execution failed"`
2. 从 result 中提取 `<tool_use_error>` 标签内容（通过 `extractTag` 工具函数），若无标签则使用原始 result
3. 调用 `removeSandboxViolationTags()` 移除沙盒违规标签（这些标签保留给模型看，不展示给用户）
4. 剥离 `<error>` XML 标签但保留其内容
5. 非 verbose 模式下，若包含 `InputValidationError:`，简化为 `"Invalid tool parameters"`
6. 确保错误文本以 `"Error: "` 或 `"Cancelled: "` 开头

**输出截断**：非 verbose 模式下，最多显示 `MAX_RENDERED_LINES = 10` 行，超出部分显示 `"… +N lines"` 并提示用户使用 `ctrl+o`（可配置快捷键）查看全部内容。

### 文件编辑成功展示：FileEditToolUpdatedMessage

当文件编辑工具执行成功后，该组件展示 diff 统计信息和结构化差异预览。

**渲染逻辑**（`src/components/FileEditToolUpdatedMessage.tsx:32-110`）：

1. 统计 `structuredPatch` 中的新增行数（以 `+` 开头）和删除行数（以 `-` 开头）
2. 生成统计文本，如 `"Added 5 lines, removed 3 lines"`
3. 根据 `style` 和 `previewHint` 决定渲染模式：
   - 有 `previewHint` + 非 condensed 模式 + 非 verbose：只显示 hint（如 Plan 文件场景，用户可通过 `/plan` 查看）
   - condensed 模式 + 非 verbose + 无 previewHint：只显示统计文本（子 Agent 视图）
   - 其他情况：显示统计文本 + `StructuredDiffList` 完整差异预览

差异列表宽度为 `columns - 12`，留出左侧缩进空间。

### 文件编辑拒绝展示：FileEditToolUseRejectedMessage

用户拒绝文件编辑权限请求时的展示组件，支持两种操作类型：

**`write`（新文件创建）分支**（`src/components/FileEditToolUseRejectedMessage.tsx:85-133`）：
- 使用 `HighlightedCode` 组件以 dim 样式展示被拒绝的文件内容预览
- 非 verbose 模式下截断为前 10 行（`MAX_LINES_TO_RENDER`），超出显示 `"… +N lines"`

**`update`（编辑现有文件）分支**（`src/components/FileEditToolUseRejectedMessage.tsx:135-169`）：
- 若有 `patch` 数据，使用 `StructuredDiffList` 以 dim 样式展示被拒绝的差异
- 若无 patch，仅显示拒绝文本

两个分支都以 `"User rejected {operation} to {file_path}"` 格式显示头部，非 verbose 模式下文件路径显示为相对路径（通过 `relative(getCwd(), file_path)` 转换）。

### Notebook 编辑拒绝展示：NotebookEditToolUseRejectedMessage

专门处理 Jupyter Notebook 编辑被拒绝的场景（`src/components/NotebookEditToolUseRejectedMessage.tsx:16-91`）：

- 支持三种 `edit_mode`：`replace`（默认）、`insert`、`delete`
- 显示 `"User rejected {operation} {notebook_path} at cell {cell_id}"` 格式的提示
- 非 delete 模式下，使用 `HighlightedCode` 展示被拒绝的新 cell 源码，根据 `cell_type` 选择语法高亮（markdown → `file.md`，code → `file.py`）

### 对话压缩摘要：CompactSummary

当对话历史被自动压缩（compact）或用户手动触发 "Summarize from here" 时，该组件在消息流中显示压缩边界标记（`src/components/CompactSummary.tsx:14-117`）。

**两种模式**：

1. **带 metadata 的摘要**（用户触发 "Summarize from here"）：
   - 显示 `"Summarized conversation"` 标题
   - 非 transcript 模式下显示详细信息：压缩了多少条消息、方向（`up_to` 向上 / `from` 向下）、用户提供的上下文
   - transcript 模式下直接显示摘要文本内容

2. **默认压缩摘要**（自动压缩）：
   - 显示 `"Compact summary"` 标题
   - 非 transcript 模式下附带快捷键提示（`ctrl+o` 展开历史）
   - transcript 模式下显示摘要文本

两种模式都使用 `BLACK_CIRCLE`（⬤）作为视觉标记，通过 `ConfigurableShortcutHint` 组件渲染可配置的快捷键提示。

## 函数签名与参数说明

### `ToolUseLoader({ isError, isUnresolved, shouldAnimate }: Props)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `isError` | `boolean` | 工具是否执行失败 |
| `isUnresolved` | `boolean` | 工具是否仍在执行中 |
| `shouldAnimate` | `boolean` | 是否启用闪烁动画 |

### `FallbackToolUseErrorMessage({ result, verbose }: Props)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `result` | `ToolResultBlockParam['content']` | 工具执行返回的原始结果 |
| `verbose` | `boolean` | 是否展示完整错误信息（transcript 模式） |

### `FileEditToolUpdatedMessage({ filePath, structuredPatch, firstLine, fileContent?, style?, verbose, previewHint? }: Props)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `filePath` | `string` | 被编辑的文件路径 |
| `structuredPatch` | `StructuredPatchHunk[]` | 结构化差异 hunk 列表 |
| `firstLine` | `string \| null` | 文件首行内容（用于差异展示） |
| `fileContent` | `string?` | 完整文件内容（可选） |
| `style` | `'condensed'?` | 压缩展示模式 |
| `verbose` | `boolean` | 是否详细展示 |
| `previewHint` | `string?` | Plan 文件的预览提示文本 |

### `FileEditToolUseRejectedMessage({ file_path, operation, patch?, firstLine, fileContent?, content?, style?, verbose }: Props)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `file_path` | `string` | 目标文件路径 |
| `operation` | `'write' \| 'update'` | 操作类型（新建/编辑） |
| `patch` | `StructuredPatchHunk[]?` | 编辑差异（update 操作） |
| `content` | `string?` | 文件内容（write 操作） |
| `style` | `'condensed'?` | 压缩模式 |
| `verbose` | `boolean` | 是否详细展示 |

### `NotebookEditToolUseRejectedMessage({ notebook_path, cell_id, new_source, cell_type?, edit_mode?, verbose }: Props)`

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `notebook_path` | `string` | - | Notebook 文件路径 |
| `cell_id` | `string \| undefined` | - | 目标 cell ID |
| `new_source` | `string` | - | 新的 cell 源码 |
| `cell_type` | `'code' \| 'markdown'` | - | Cell 类型 |
| `edit_mode` | `'replace' \| 'insert' \| 'delete'` | `'replace'` | 编辑模式 |
| `verbose` | `boolean` | - | 是否显示绝对路径 |

### `CompactSummary({ message, screen }: Props)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `message` | `NormalizedUserMessage` | 包含摘要内容和 `summarizeMetadata` 的消息对象 |
| `screen` | `Screen` | 当前屏幕模式（`'transcript'` 时展示完整文本） |

### `FallbackToolUseRejectedMessage()`

无参数。渲染 `InterruptedByUser` 组件，包裹在 `MessageResponse` 容器中（固定高度 1 行）。

### `InterruptedByUser()`

无参数。显示灰色的 `"Interrupted · What should Claude do instead?"` 提示文本。

## 关键依赖关系

- **`MessageResponse`**：所有反馈组件共用的消息容器包装器，提供统一的消息缩进和布局
- **`StructuredDiffList`**：结构化差异展示组件，被 `FileEditToolUpdatedMessage` 和 `FileEditToolUseRejectedMessage` 使用
- **`HighlightedCode`**：语法高亮代码展示，被 `FileEditToolUseRejectedMessage`（write 分支）和 `NotebookEditToolUseRejectedMessage` 使用
- **`useBlink`**：控制 `ToolUseLoader` 的闪烁动画
- **`useTerminalSize`**：获取终端宽度，用于计算差异展示区域宽度（`columns - 12`）
- **`useShortcutDisplay` / `ConfigurableShortcutHint`**：渲染可配置的快捷键提示

## 边界 Case 与注意事项

- **ANSI 转义序列冲突**：`ToolUseLoader` 源码中详细注释了 chalk 的 dim/bold 渲染 bug（`\x1b[22m` 同时重置 dim 和 bold），组件结构经过精心设计以避免该问题，重构时需特别小心
- **`verbose` 模式**：所有组件都区分 verbose 和非 verbose 模式。verbose 对应 transcript 视图（通过 `ctrl+o` 切换），显示完整内容；非 verbose 模式截断长内容
- **沙盒违规信息**：`FallbackToolUseErrorMessage` 会移除 `sandbox_violations` 标签的显示，但模型侧仍然可以看到这些信息
- **路径显示**：拒绝消息中的文件路径在非 verbose 模式下使用 `relative()` 转为相对路径显示，更简洁
- **condensed 模式**：`FileEditToolUpdatedMessage` 和 `FileEditToolUseRejectedMessage` 支持 condensed 风格（子 Agent 视图），此时只显示统计文本或简短拒绝消息，不展示完整 diff
- **React Compiler 编译产物**：所有文件均为 React Compiler 编译后的代码（`_c()` 缓存机制），源码逻辑在 sourcemap 注释的 base64 编码中可还原