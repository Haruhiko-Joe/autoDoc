# 文件操作权限审批 UI 组（FilePermissions）

## 概述与职责

FilePermissions 是 Claude Code 终端 UI 中专门处理**文件操作权限审批**的组件群，隶属于 `TerminalUI → UIComponents → PermissionUI` 层级。当 Claude 需要读取、编辑或写入文件时，这些组件负责向用户展示操作预览（包括结构化 diff）并收集审批决策。

该模块由四个子目录组成：
- **FilePermissionDialog/**：共享的权限对话框框架，提供通用 UI 骨架和状态管理
- **FileEditPermissionRequest/**：文件编辑（Edit 工具）的权限审批组件
- **FileWritePermissionRequest/**：文件写入/创建（Write 工具）的权限审批组件
- **FilesystemPermissionRequest/**：文件读取、Glob、Grep 等只读操作的权限审批组件

同级兄弟模块包括 MessageRendering（消息渲染）、DesignSystem（设计系统）、DialogCollection（对话框集合）等，它们共同构成 UIComponents 组件库。

## 关键流程

### 权限审批总流程

1. 上游 `PermissionRequest.tsx` 根据工具类型分发到具体的权限请求组件（FileEdit/FileWrite/Filesystem）
2. 具体组件解析工具输入，构造预览内容（diff 或参数展示），然后委托给共享的 `FilePermissionDialog` 渲染对话框
3. `FilePermissionDialog` 调用 `useFilePermissionDialog` hook 管理选项列表和状态，调用 `useDiffInIDE` 集成 IDE diff 预览
4. 用户选择选项后（Yes / Yes for session / No），通过 `PERMISSION_HANDLERS` 映射表分发到对应的处理函数
5. 处理函数调用 `toolUseConfirm.onAllow()` 或 `toolUseConfirm.onReject()` 完成审批，同时记录分析事件

### 选项生成逻辑

`getFilePermissionOptions()` 根据以下上下文动态生成选项列表（`permissionOptions.tsx:53-69`）：

1. **Yes（accept-once）**：单次批准，可附带反馈指令
2. **Yes for session（accept-session）**：会话级批准，行为因路径而异：
   - 若文件在 `.claude/` 目录内 → 显示 "allow Claude to edit its own settings for this session"
   - 若在工作目录内 → 显示 "allow all edits during this session"
   - 若在工作目录外 → 显示 "allow all edits in {dirName}/ during this session"
   - 读操作 → 不显示快捷键提示，措辞为 "during this session"
3. **No（reject）**：拒绝操作，可附带反馈指令

用户可按 Tab 键切换到反馈输入模式，在批准或拒绝时附带文字指令（如 "and tell Claude what to do next"）。

### IDE Diff 集成流程

当用户连接了 IDE 时，`FilePermissionDialog` 可将编辑内容发送到 IDE 进行 diff 预览：

1. 各组件通过 `IDEDiffSupport` 接口提供 `getConfig()` 和 `applyChanges()` 方法
2. `FilePermissionDialog` 调用 `useDiffInIDE` hook（`FilePermissionDialog.tsx:150-154`）
3. 如果 IDE 正在显示 diff（`showingDiffInIDE === true`），渲染 `ShowInIDEPrompt` 替代终端内预览
4. 用户在 IDE 中编辑后确认，`applyChanges()` 将修改后的 edits 映射回工具输入

## 函数签名与参数说明

### `FilePermissionDialog<T extends ToolInput>`

通用文件权限对话框组件（`FilePermissionDialog/FilePermissionDialog.tsx:48-64`）。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| toolUseConfirm | ToolUseConfirm | - | 工具使用确认上下文 |
| toolUseContext | ToolUseContext | - | 工具使用上下文信息 |
| onDone | () => void | - | 审批完成回调 |
| onReject | () => void | - | 拒绝操作回调 |
| title | string | - | 对话框标题（如 "Edit file"） |
| subtitle | ReactNode | - | 副标题（通常为相对路径） |
| question | string \| ReactNode | 'Do you want to proceed?' | 提示问题文本 |
| content | ReactNode | - | 预览内容（diff 组件或参数展示） |
| path | string \| null | - | 目标文件路径 |
| parseInput | (input: unknown) => T | - | 工具输入解析函数 |
| operationType | FileOperationType | 'write' | 操作类型：'read' \| 'write' \| 'create' |
| completionType | CompletionType | 'tool_use_single' | 日志事件分类 |
| ideDiffSupport | IDEDiffSupport\<T\> | - | IDE diff 集成配置（可选） |
| workerBadge | WorkerBadgeProps | - | Worker 标识（teammate 模式下使用） |
| languageName | string | - | 覆盖自动检测的语言名称 |

该组件还会自动检测目标文件是否为符号链接，若链接目标在工作目录外则显示警告（`FilePermissionDialog.tsx:162-167`）。

### `useFilePermissionDialog<T extends ToolInput>(props): UseFilePermissionDialogResult<T>`

核心状态管理 hook（`useFilePermissionDialog.ts:53-212`），返回：

| 字段 | 类型 | 说明 |
|------|------|------|
| options | PermissionOptionWithLabel[] | 当前可用的选项列表 |
| onChange | (option, input, feedback?) => void | 选项选择处理函数 |
| acceptFeedback / rejectFeedback | string | 批准/拒绝反馈文本 |
| focusedOption | string | 当前聚焦的选项 |
| yesInputMode / noInputMode | boolean | 是否处于反馈输入模式 |
| handleInputModeToggle | (value: string) => void | Tab 键切换输入模式 |

该 hook 还通过 `useKeybindings` 注册了 `confirm:cycleMode` 快捷键，用于快速选择 session 级批准。

### `PERMISSION_HANDLERS`

权限决策处理器映射（`usePermissionHandler.ts:178-185`）：

```typescript
{
  'accept-once':    handleAcceptOnce,    // 单次批准 → onAllow(input, [], feedback?)
  'accept-session': handleAcceptSession, // 会话批准 → generateSuggestions() + onAllow(input, suggestions)
  'reject':         handleReject,        // 拒绝 → onReject(feedback?)
}
```

`handleAcceptSession` 的特殊逻辑：若 scope 为 `'claude-folder'` 或 `'global-claude-folder'`，使用预定义的 `CLAUDE_FOLDER_PERMISSION_PATTERN` 生成权限规则；否则调用 `generateSuggestions()` 根据路径和操作类型生成会话级权限更新。

## 接口/类型定义

### `PermissionOption`

权限选项联合类型（`permissionOptions.tsx:41-48`）：

```typescript
type PermissionOption =
  | { type: 'accept-once' }
  | { type: 'accept-session'; scope?: 'claude-folder' | 'global-claude-folder' }
  | { type: 'reject' }
```

### `FileOperationType`

文件操作类型（`permissionOptions.tsx:52`）：`'read' | 'write' | 'create'`

### `IDEDiffSupport<TInput>`

IDE diff 集成接口（`ideDiffConfig.ts:20-23`）：

```typescript
interface IDEDiffSupport<TInput extends ToolInput> {
  getConfig(input: TInput): IDEDiffConfig      // 从工具输入提取 diff 配置
  applyChanges(input: TInput, modifiedEdits: FileEdit[]): TInput  // 将 IDE 编辑结果映射回工具输入
}
```

### `IDEDiffConfig`

IDE diff 配置（`ideDiffConfig.ts:9-13`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| filePath | string | 目标文件路径 |
| edits | FileEdit[] | 编辑列表（old_string/new_string/replace_all） |
| editMode | 'single' \| 'multiple' | 编辑模式 |

## 三个具体权限请求组件

### FileEditPermissionRequest

处理 `FileEditTool`（Edit 工具）的权限审批（`FileEditPermissionRequest.tsx:28`）。

- 使用 `FileEditTool.inputSchema.parse()` 解析输入，提取 `file_path`、`old_string`、`new_string`、`replace_all`
- 预览内容：通过 `FileEditToolDiff` 展示结构化 diff
- 对话框标题："Edit file"，副标题为文件相对路径
- 提问文本："Do you want to make this edit to **{filename}**?"
- completionType: `"str_replace_single"`
- 支持 IDE diff：通过 `createSingleEditDiffConfig()` 生成配置，`applyChanges()` 将编辑后的 old_string/new_string/replace_all 映射回输入

### FileWritePermissionRequest

处理 `FileWriteTool`（Write 工具）的权限审批（`FileWritePermissionRequest.tsx:38`）。

- 使用 `FileWriteTool.inputSchema.parse()` 解析输入，提取 `file_path` 和 `content`
- 通过 `readFileSync` 读取原文件内容以区分创建和覆盖场景
- 文件已存在 → 标题 "Overwrite file"，提问 "Do you want to overwrite **{filename}**?"
- 文件不存在 → 标题 "Create file"，提问 "Do you want to create **{filename}**?"
- 预览内容：`FileWriteToolDiff` 组件（`FileWriteToolDiff.tsx:16`）——若文件存在则用 `getPatchForDisplay` + `StructuredDiff` 展示结构化 diff；若为新文件则用 `HighlightedCode` 展示完整内容
- completionType: `"write_file_single"`
- 支持 IDE diff：`getConfig()` 读取原文件内容构造 diff 配置

### FilesystemPermissionRequest

处理 Read、Glob、Grep 等文件系统操作的权限审批（`FilesystemPermissionRequest.tsx:19`）。

- 通过 `tool.getPath(input)` 提取操作路径；若无法提取路径则回退到 `FallbackPermissionRequest`
- 根据 `tool.isReadOnly(input)` 判断操作类型：只读 → "Read file"，可写 → "Edit file"
- 预览内容：调用 `tool.renderToolUseMessage()` 展示工具调用参数
- operationType 根据 isReadOnly 设置为 `'read'` 或 `'write'`
- completionType: `"tool_use_single"`
- **不支持 IDE diff**（没有传递 `ideDiffSupport`）

## 边界 Case 与注意事项

- **符号链接检测**：`FilePermissionDialog` 在非读操作时会通过 `safeResolvePath()` 检测目标文件是否为符号链接，若链接目标在工作目录外会显示黄色警告 "This will modify {target} (outside working directory) via a symlink"（`FilePermissionDialog.tsx:75-89`）
- **`.claude/` 目录特殊处理**：`isInClaudeFolder()` 和 `isInGlobalClaudeFolder()` 使用大小写无关比较，支持跨平台路径分隔符（`permissionOptions.tsx:15-40`）
- **反馈模式持久化**：`yesFeedbackModeEntered` / `noFeedbackModeEntered` 状态在 collapse 后仍然保持，用于分析事件追踪用户是否曾进入过反馈模式（`useFilePermissionDialog.ts:69-71`）
- **文件读取容错**：`FileWritePermissionRequest` 使用 `isENOENT` 判断文件不存在，其他异常直接抛出（`FileWritePermissionRequest.tsx:57-67`）
- **React Compiler 优化**：所有组件均使用 React Compiler 运行时（`_c` 缓存机制）进行细粒度 memoization，避免不必要的重渲染
- **会话级权限只影响内存状态**：`accept-session` 选项始终可用，不受 `allowManagedPermissionRulesOnly` 设置限制，因为它只修改内存中的会话权限，不持久化到配置文件