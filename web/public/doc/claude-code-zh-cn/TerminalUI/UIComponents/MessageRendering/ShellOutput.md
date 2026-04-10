# Shell 命令输出渲染系统（ShellOutput）

## 概述与职责

ShellOutput 是 Shell 命令输出的专用渲染系统，位于 `src/components/shell/` 目录下，属于 **TerminalUI → UIComponents → MessageRendering** 层级。它负责将 Bash 工具执行的输出以可读、可交互的方式呈现在终端 UI 中。

该模块由 4 个文件组成，共约 374 行代码，各自承担不同职责：

- **ExpandShellOutputContext** — 展开/折叠状态的 React Context
- **OutputLine** — 单行输出渲染（ANSI 处理、JSON 格式化、截断）
- **ShellProgressMessage** — 命令执行进度整体渲染
- **ShellTimeDisplay** — 执行耗时格式化显示

同级模块包括 PermissionUI（权限审批）、DesignSystem（设计系统）等，ShellOutput 被 MessageRendering 中的消息分发器调用，用于渲染 Bash 工具的执行结果。

## 关键流程

### 单行输出渲染流程（OutputLine）

1. 接收原始 `content` 字符串和渲染选项（`verbose`、`isError`、`isWarning`、`linkifyUrls`）
2. 通过 `useExpandShellOutput()` 检查是否处于展开上下文中，结合 `verbose` 决定 `shouldShowFull`（`src/components/shell/OutputLine.tsx:61`）
3. 调用 `tryJsonFormatContent()` 尝试对每一行做 JSON 美化（上限 10,000 字符）
4. 若启用 `linkifyUrls`，调用 `linkifyUrlsInText()` 将 URL 转为终端超链接
5. 若需截断，调用 `renderTruncatedContent()` 按终端宽度截断；否则直接使用完整内容
6. 最后通过 `stripUnderlineAnsi()` 移除下划线 ANSI 转义码，使用 `<Ansi>` 组件渲染彩色输出

### 命令进度渲染流程（ShellProgressMessage）

1. 接收 `output`（截断输出）、`fullOutput`（完整输出）、执行时间、行数等统计信息
2. 使用 `strip-ansi` 清除 ANSI 码，按换行分割得到有效行
3. **无输出时**：显示 `"Running…"` + 耗时/超时信息，使用 `OffscreenFreeze` 防止滚出屏幕后仍触发重渲染
4. **有输出时**：
   - 非 verbose 模式：显示最后 5 行（`lines.slice(-5)`），高度限制为 `Math.min(5, lines.length)`
   - verbose 模式：显示完整输出，不限制高度
5. 底部状态栏显示行数统计（`+N lines` 或 `~N lines`）、耗时和总字节数

### 展开/折叠控制流程

`ExpandShellOutputContext` 是一个布尔型 React Context（默认 `false`）。当用户通过 `!` 命令执行 Shell 时，最近一次的输出会被 `ExpandShellOutputProvider` 包裹，使子树中的 `OutputLine` 自动展示完整内容而非截断版本。这与 `MessageResponseContext` 和 `SubAgentContext` 遵循相同的设计模式。

## 函数签名与参数说明

### `OutputLine({ content, verbose, isError, isWarning, linkifyUrls })`

渲染单行 Shell 输出。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `content` | `string` | 是 | 原始输出内容（可含 ANSI 码） |
| `verbose` | `boolean` | 是 | 是否显示完整内容（不截断） |
| `isError` | `boolean` | 否 | 是否为错误输出（显示 error 颜色） |
| `isWarning` | `boolean` | 否 | 是否为警告输出（显示 warning 颜色） |
| `linkifyUrls` | `boolean` | 否 | 是否将 URL 转为可点击超链接 |

> 源码位置：`src/components/shell/OutputLine.tsx:47-104`

### `ShellProgressMessage({ output, fullOutput, elapsedTimeSeconds, totalLines, totalBytes, timeoutMs, verbose })`

渲染 Shell 命令执行进度面板。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `output` | `string` | 是 | 截断后的输出（用于普通展示） |
| `fullOutput` | `string` | 是 | 完整输出（用于 verbose 模式） |
| `elapsedTimeSeconds` | `number` | 否 | 已执行时间（秒） |
| `totalLines` | `number` | 否 | 输出总行数（含被截断部分的估计值） |
| `totalBytes` | `number` | 否 | 输出总字节数 |
| `timeoutMs` | `number` | 否 | 超时时间（毫秒） |
| `verbose` | `boolean` | 是 | 是否显示完整输出 |

> 源码位置：`src/components/shell/ShellProgressMessage.tsx:19-149`

### `ShellTimeDisplay({ elapsedTimeSeconds, timeoutMs })`

格式化显示命令执行耗时。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `elapsedTimeSeconds` | `number` | 否 | 已执行时间（秒） |
| `timeoutMs` | `number` | 否 | 超时时间（毫秒） |

显示逻辑：
- 两者都无 → 返回 `null`
- 仅有 `timeoutMs` → 显示 `(timeout 2m)`
- 仅有 `elapsedTimeSeconds` → 显示 `(1.2s)`
- 两者都有 → 显示 `(1.2s · timeout 2m)`

> 源码位置：`src/components/shell/ShellTimeDisplay.tsx:9-73`

### `tryFormatJson(line: string): string`

尝试将单行文本格式化为缩进 JSON。如果不是合法 JSON 或 round-trip 后精度丢失（大整数超过 `Number.MAX_SAFE_INTEGER`），返回原文。

> 源码位置：`src/components/shell/OutputLine.tsx:12-31`

### `tryJsonFormatContent(content: string): string`

对多行内容逐行尝试 JSON 格式化。超过 10,000 字符的内容直接跳过以避免性能问题。

> 源码位置：`src/components/shell/OutputLine.tsx:33-39`

### `linkifyUrlsInText(content: string): string`

使用正则 `/https?:\/\/[^\s"'<>\\]+/g` 匹配 HTTP(S) URL 并转为终端超链接（通过 `createHyperlink` 工具函数）。

> 源码位置：`src/components/shell/OutputLine.tsx:44-46`

### `stripUnderlineAnsi(content: string): string`

专门移除下划线 ANSI 转义码（`\e[4m` 系列）。保留其他 ANSI 格式（颜色、粗体等），因为用户反馈过全部移除会丢失有价值的格式信息。

> 源码位置：`src/components/shell/OutputLine.tsx:113-117`

## 边界 Case 与注意事项

- **OffscreenFreeze 优化**：`ShellProgressMessage` 使用 `OffscreenFreeze` 包裹输出内容。当 BashTool 每秒更新 `elapsedTimeSeconds` 时，若该区域已滚出可视区域，`OffscreenFreeze` 阻止不必要的终端重绘。代码注释记录了一个真实案例：29 行终端 + 4000 行历史 + `sleep 600` 命令在 10 分钟内触发了 507 次终端重置。

- **JSON 格式化精度保护**：`tryFormatJson` 在 round-trip 后对比原始与序列化结果（移除空白和 `\/` 转义后比较），若不一致则放弃格式化，避免大数精度丢失。

- **下划线 ANSI 泄露**：Shell 输出中的下划线 ANSI 码会"泄露"到后续渲染内容，且常规 reset 码无法阻止。因此专门使用 `stripUnderlineAnsi` 移除，而不是 `strip-ansi` 全部清除。

- **行数统计的两种模式**：当输出被 BashTool 截断（有 `totalBytes` 和 `totalLines`）时显示 `~N lines`（估算值）；未截断但超过 5 行时显示 `+N lines`（精确值）。

- **虚拟列表适配**：`OutputLine` 通过 `InVirtualListContext` 感知自身是否在虚拟滚动列表中，传递给 `renderTruncatedContent` 以调整截断策略。