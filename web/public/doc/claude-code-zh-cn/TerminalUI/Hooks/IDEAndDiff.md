# IDE 集成与差异展示 Hooks

## 概述与职责

本模块是 **TerminalUI → Hooks** 层的一组 React 自定义 Hooks，负责在 Claude Code 终端界面与外部 IDE（如 VS Code）之间建立双向通信通道，并提供 Git 差异数据的获取与展示能力。

通信底层基于 **MCP（Model Context Protocol）客户端**实现——IDE 扩展作为一个特殊的 MCP Server 注册到系统中，通过 SSE 或 WebSocket 传输协议与终端交互。本模块包含 7 个 Hook，按职责分为两组：

- **IDE 通信组**：`useIDEIntegration`（核心编排）、`useIdeSelection`（选区同步）、`useIdeAtMentioned`（@mention 事件）、`useIdeConnectionStatus`（连接状态）、`useIdeLogging`（日志转发）
- **差异展示组**：`useDiffInIDE`（将文件差异发送到 IDE）、`useDiffData`（计算和缓存 Git 差异数据）

同级兄弟模块还包括输入处理、历史导航、远程会话、后台任务、权限控制、建议系统等其他 Hook 子模块。

---

## 关键流程

### IDE 连接建立流程

1. `useIDEIntegration` 在组件挂载时调用 `initializeIdeIntegration()`（来自 `utils/ide.js`），传入 `addIde` 回调
2. `addIde` 回调收到 `DetectedIDEInfo` 后，检查是否满足自动连接条件（全局配置 `autoConnectIde`、CLI flag、支持的终端、环境变量 `CLAUDE_CODE_SSE_PORT` / `CLAUDE_CODE_AUTO_CONNECT_IDE` 等）
3. 条件满足时，通过 `setDynamicMcpConfig` 将 IDE 注册为一个动态 MCP Server（类型为 `ws-ide` 或 `sse-ide`），配置包含 URL、认证 Token、IDE 名称等
4. 如果已有 IDE 连接（`prev?.ide` 存在），则跳过重复注册

> 源码位置：`src/hooks/useIDEIntegration.tsx:27-54`

### IDE 选区同步流程

1. `useIdeSelection` 从 `mcpClients` 列表中通过 `getConnectedIdeClient()` 查找 IDE 客户端
2. 检测 IDE 客户端是否发生变更（断开重连等），变更时重置选区状态并重新注册处理器
3. 向 IDE 的 MCP 客户端注册 `selection_changed` 通知处理器
4. 收到通知后，解析选区的起止位置，计算选中行数（如果光标在行首则不计入该行），回调 `onSelect` 传出 `IDESelection`

> 源码位置：`src/hooks/useIdeSelection.ts:59-149`

### IDE 中展示差异流程

1. `useDiffInIDE` 判断是否满足展示条件：IDE 扩展支持 Diff 功能、全局配置 `diffTool === 'auto'`、文件非 `.ipynb`
2. 满足条件后，读取原始文件内容，通过 `getPatchForEdits()` 计算编辑后的新内容
3. 处理 WSL↔Windows 路径转换（如果 IDE 运行在 Windows 而终端在 WSL 中）
4. 通过 `callIdeRpc('openDiff', ...)` 发送 RPC 请求，将原始路径和新内容传给 IDE 展示差异
5. 等待 IDE 返回结果，支持三种响应：
   - `FILE_SAVED`：用户在 IDE 中保存了修改后的文件，取回用户编辑后的内容
   - `TAB_CLOSED`：用户关闭了 Diff 标签页，使用 Claude 提议的新内容
   - `DIFF_REJECTED`：用户拒绝了差异，保持原始内容不变
6. 根据响应重新计算 `FileEdit[]`（调用 `computeEditsFromContents`），回调 `onChange` 通知上层

> 源码位置：`src/hooks/useDiffInIDE.ts:216-327`

---

## 函数签名与参数说明

### `useIDEIntegration(props: UseIDEIntegrationProps): void`

核心编排 Hook，初始化 IDE 集成。

| 参数 | 类型 | 说明 |
|------|------|------|
| `autoConnectIdeFlag` | `boolean?` | CLI 传入的自动连接标志 |
| `ideToInstallExtension` | `IdeType \| null` | 需要安装扩展的 IDE 类型 |
| `setDynamicMcpConfig` | `Dispatch<SetStateAction<...>>` | 设置动态 MCP 配置的状态更新函数 |
| `setShowIdeOnboarding` | `Dispatch<SetStateAction<boolean>>` | 控制 IDE 引导页显示 |
| `setIDEInstallationState` | `Dispatch<SetStateAction<...>>` | 更新扩展安装状态 |

> 源码位置：`src/hooks/useIDEIntegration.tsx:8-14`

### `useIdeSelection(mcpClients, onSelect): void`

跟踪 IDE 编辑器中的文本选区变化。

- **mcpClients**：`MCPServerConnection[]` — 当前所有 MCP 客户端连接
- **onSelect**：`(selection: IDESelection) => void` — 选区变化时的回调

> 源码位置：`src/hooks/useIdeSelection.ts:59-62`

### `useIdeAtMentioned(mcpClients, onAtMentioned): void`

监听 IDE 中的 @mention 事件。当用户在 IDE 中 @mention 一个文件时，将文件路径和行范围传递给终端。

- **onAtMentioned**：`(atMentioned: IDEAtMentioned) => void` — 收到 @mention 时的回调
- 行号自动从 0-based（IDE）转换为 1-based（终端）

> 源码位置：`src/hooks/useIdeAtMentioned.ts:33-76`

### `useIdeConnectionStatus(mcpClients?): IdeConnectionResult`

返回当前 IDE 连接状态和 IDE 名称。

- **返回值**：`{ status: IdeStatus, ideName: string | null }`
- `status` 可能为 `'connected'`、`'disconnected'`、`'pending'` 或 `null`（无 IDE 客户端）

> 源码位置：`src/hooks/useIdeConnectionStatus.ts:11-33`

### `useIdeLogging(mcpClients): void`

将 IDE 扩展的日志事件转发到 Claude Code 的分析系统。事件名前缀自动添加 `tengu_ide_`。

> 源码位置：`src/hooks/useIdeLogging.ts:18-41`

### `useDiffInIDE(props: Props): { closeTabInIDE, showingDiffInIDE, ideName, hasError }`

将文件编辑差异发送到 IDE 展示，返回控制句柄。

| 参数 | 类型 | 说明 |
|------|------|------|
| `onChange` | `(option, input) => void` | 用户接受/拒绝差异后的回调 |
| `toolUseContext` | `ToolUseContext` | 工具执行上下文，含 MCP 客户端和 abort 信号 |
| `filePath` | `string` | 目标文件路径 |
| `edits` | `FileEdit[]` | 待应用的编辑列表 |
| `editMode` | `'single' \| 'multiple'` | 单 hunk 或多 hunk 模式 |

| 返回值字段 | 类型 | 说明 |
|------------|------|------|
| `closeTabInIDE` | `() => void` | 关闭 IDE 中的 Diff 标签页 |
| `showingDiffInIDE` | `boolean` | 当前是否在 IDE 中展示差异 |
| `ideName` | `string` | 连接的 IDE 名称 |
| `hasError` | `boolean` | 是否发生错误 |

> 源码位置：`src/hooks/useDiffInIDE.ts:46-164`

### `useDiffData(): DiffData`

获取当前 Git 工作目录的差异数据，组件挂载时异步加载。

- **返回值**：`{ stats, files, hunks, loading }`
- 单文件超过 400 行标记为 `isTruncated`，无 hunk 数据的非二进制文件标记为 `isLargeFile`
- 文件列表按路径字母序排列

> 源码位置：`src/hooks/useDiffData.ts:34-110`

---

## 接口/类型定义

### `IDESelection`（`useIdeSelection.ts:24-29`）

```typescript
type IDESelection = {
  lineCount: number       // 选中的行数
  lineStart?: number      // 选区起始行号
  text?: string           // 选中的文本内容
  filePath?: string       // 所在文件路径
}
```

### `IDEAtMentioned`（`useIdeAtMentioned.ts:10-14`）

```typescript
type IDEAtMentioned = {
  filePath: string        // @mention 的文件路径
  lineStart?: number      // 起始行（1-based）
  lineEnd?: number        // 结束行（1-based）
}
```

### `IdeStatus`（`useIdeConnectionStatus.ts:4`）

```typescript
type IdeStatus = 'connected' | 'disconnected' | 'pending' | null
```

### `DiffFile` / `DiffData`（`useDiffData.ts:12-28`）

```typescript
type DiffFile = {
  path: string
  linesAdded: number
  linesRemoved: number
  isBinary: boolean
  isLargeFile: boolean    // 差异过大，无 hunk 数据
  isTruncated: boolean    // 超过 400 行限制
  isNewFile?: boolean
  isUntracked?: boolean
}

type DiffData = {
  stats: GitDiffStats | null
  files: DiffFile[]
  hunks: Map<string, StructuredPatchHunk[]>
  loading: boolean
}
```

---

## 配置项与默认值

| 配置 | 来源 | 说明 |
|------|------|------|
| `autoConnectIde` | 全局配置 `getGlobalConfig()` | 是否自动连接 IDE |
| `diffTool` | 全局配置 `getGlobalConfig()` | 值为 `'auto'` 时启用 IDE 内差异展示 |
| `CLAUDE_CODE_SSE_PORT` | 环境变量 | IDE 扩展的 SSE 端口，存在即触发自动连接（适配 tmux/screen 场景） |
| `CLAUDE_CODE_AUTO_CONNECT_IDE` | 环境变量 | 显式控制自动连接，设为 falsy 值可强制禁用 |
| `MAX_LINES_PER_FILE` | 代码常量 | 值为 `400`，单文件差异超出此行数标记为截断 |

---

## 边界 Case 与注意事项

- **IDE 客户端变更检测**：`useIdeSelection` 通过 `useRef` 跟踪当前 IDE 客户端引用，客户端变更时自动重置选区并重新注册通知处理器，避免处理已断开连接的消息（`src/hooks/useIdeSelection.ts:73-83`）
- **行号基数转换**：`useIdeAtMentioned` 将 IDE 的 0-based 行号转为 1-based（`lineStart + 1`），`useIdeSelection` 中的选区如果 `end.character === 0` 则不计入该行
- **WSL 路径转换**：`useDiffInIDE` 检测 WSL 环境且 IDE 运行在 Windows 时，使用 `WindowsToWSLConverter` 转换文件路径（`src/hooks/useDiffInIDE.ts:272-282`）
- **竞态保护**：`useDiffData` 使用 `cancelled` 标志防止组件卸载后更新状态；`useDiffInIDE` 使用 `isUnmounted` ref 和 `isCleanedUp` 标志防止重复清理
- **Diff 标签页命名**：格式为 `✻ [Claude Code] {filename} ({6位UUID}) ⧉`，UUID 确保同一文件的多次编辑不冲突
- **Notebook 文件排除**：`.ipynb` 文件不支持 IDE 内差异展示，走终端内置流程
- **清理机制**：`showDiffInIDE` 同时监听 `abortController.signal`（用户取消）和 `process.beforeExit`（进程退出），确保 IDE 中的 Diff 标签页被关闭