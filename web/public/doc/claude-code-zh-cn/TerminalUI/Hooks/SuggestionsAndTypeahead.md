# 建议系统与自动补全 Hooks

## 概述与职责

本模块是 Claude Code 终端 UI 中的**建议系统与自动补全引擎**，位于 `TerminalUI > Hooks` 层级下。它为用户输入框（PromptInput）提供多种类型的智能补全能力：文件路径补全、斜杠命令补全、Shell 命令补全、MCP 资源补全、Agent 名称补全、Slack 频道补全，以及上下文相关的提示建议（prompt suggestion）。

同级兄弟模块包括输入处理（useTextInput、useVimInput）、历史导航（useArrowKeyHistory）、IDE 集成等 80+ 个 React Hooks。本模块由 4 个文件组成：

| 文件 | 行数 | 职责 |
|------|------|------|
| `useTypeahead.tsx` | 1384 | Tab 补全引擎主 Hook——状态机、候选排序、UI 渲染 |
| `fileSuggestions.ts` | 812 | 文件路径补全的后台索引构建与模糊匹配 |
| `unifiedSuggestions.ts` | 203 | 统一文件、MCP 资源、Agent 三类建议的生成与混合排序 |
| `usePromptSuggestion.ts` | 178 | 上下文相关的提示建议（空输入时的 ghost text） |

## 关键流程

### 1. 文件索引构建流程（fileSuggestions.ts）

这是整个建议系统的数据基础——在后台构建项目文件索引，供补全查询使用。

1. `useTypeahead` 在组件挂载时调用 `startBackgroundCacheRefresh()` 预热索引（`src/hooks/useTypeahead.tsx:494-505`）
2. `startBackgroundCacheRefresh()` 检查节流条件：若索引已存在，通过 `.git/index` 的 mtime 检测 git 状态变更，或每 5 秒刷新一次以捕获未跟踪文件（`src/hooks/fileSuggestions.ts:636-686`）
3. `getPathsForSuggestions()` 并行获取项目文件和 Claude 配置文件（`src/hooks/fileSuggestions.ts:523-570`）：
   - 优先使用 `git ls-files`（快速读取 git 索引），失败时回退到 `ripgrep --files`
   - 路径归一化为相对于 cwd 的形式
   - 应用 `.ignore` / `.rgignore` 排除规则
4. 使用 `getDirectoryNamesAsync()` 从文件列表中提取所有父目录路径（带 `/` 后缀），采用时间分片（每 ~4ms yield 一次）避免阻塞主线程（`src/hooks/fileSuggestions.ts:403-418`）
5. 将文件和目录列表加载到 Rust/nucleo 实现的 `FileIndex` 中进行模糊搜索索引构建（`src/hooks/fileSuggestions.ts:555`）
6. 通过 `pathListSignature()` 计算路径列表的 FNV-1a 采样哈希签名，跳过内容未变化时的重复构建（`src/hooks/fileSuggestions.ts:111-131`）
7. 后台异步获取未跟踪文件（`git ls-files --others`），完成后合并到索引中（`src/hooks/fileSuggestions.ts:315-376`）
8. 索引构建完成时触发 `indexBuildComplete` signal，通知 typeahead UI 重新执行上次搜索（`src/hooks/fileSuggestions.ts:46-47`）

### 2. Tab 补全主流程（useTypeahead.tsx）

用户每次输入变化时，`updateSuggestions` 按优先级依次检查应该展示哪种类型的建议：

```
输入变化 → useEffect 触发 updateSuggestions
  ├─ prompt 模式，检测行内斜杠命令 → 生成 ghost text（同步）
  ├─ bash 模式，非空输入 → 查询 Shell 历史补全 → ghost text
  ├─ 检测 @name 模式 → 团队成员 / 子 Agent 建议
  ├─ 检测 #channel 模式 → Slack 频道建议（需 MCP 服务器）
  ├─ 检测 @path 模式 → 路径补全 或 模糊文件搜索
  ├─ 以 / 开头 → 斜杠命令建议 + 参数提示
  └─ 已有 file 建议时 → 持续更新文件建议
```

> 源码位置：`src/hooks/useTypeahead.tsx:533-887`

当用户按下 Tab 键时，`handleTab` 根据当前 `suggestionType` 执行不同的应用逻辑：

- **command**：调用 `applyCommandSuggestion` 替换输入
- **file**：计算所有候选的最长公共前缀，若长于当前输入则先补全到公共前缀（类似 Shell 行为），否则应用选中项
- **directory**：用 `applyDirectorySuggestion` 替换 token，目录自动追加 `/` 并继续补全
- **shell**：调用 `applyShellSuggestion` 替换当前单词
- **agent / slack-channel**：通过 `applyTriggerSuggestion` 基于正则定位并替换触发 token
- **ghost text**（行内历史补全或命令补全）：直接替换整个输入为完整命令

> 源码位置：`src/hooks/useTypeahead.tsx:911-1134`

### 3. 统一建议生成流程（unifiedSuggestions.ts）

当用户输入 `@` 触发文件补全时，`generateUnifiedSuggestions` 混合三类来源：

1. **文件建议**：调用 `generateFileSuggestions` 获取 nucleo 模糊匹配结果（已含评分）
2. **MCP 资源建议**：将 `mcpResources` 扁平化为 `server:uri` 格式的候选
3. **Agent 建议**：从已加载的 Agent 定义中过滤匹配项

当有查询词时，文件结果保留 nucleo 评分，非文件来源用 Fuse.js 评分，然后按统一评分排序（越低越好），取前 15 个结果。

> 源码位置：`src/hooks/unifiedSuggestions.ts:111-202`

### 4. 提示建议流程（usePromptSuggestion.ts）

`usePromptSuggestion` 管理空输入时展示的上下文提示建议（由后端推测生成的 ghost text）：

1. 从 AppState 的 `promptSuggestion` 读取建议文本
2. 仅当助手未响应且输入为空时显示建议（`src/hooks/usePromptSuggestion.ts:38-39`）
3. 跟踪 `shownAt`、`acceptedAt`、`firstKeystrokeAt` 等时间戳用于遥测
4. 用户按 Tab / 右箭头接受建议时调用 `markAccepted`
5. 提交时 `logOutcomeAtSubmission` 记录接受/忽略事件，包括用时、接受方式、相似度等指标

## 函数签名与参数说明

### `useTypeahead(props: Props): UseTypeaheadResult`

Tab 补全引擎的主入口 Hook。

**Props**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `input` | `string` | 当前输入文本 |
| `cursorOffset` | `number` | 光标位置 |
| `commands` | `Command[]` | 已注册的斜杠命令列表 |
| `mode` | `string` | 输入模式：`"prompt"` 或 `"bash"` |
| `agents` | `AgentDefinition[]` | 可用的 Agent 定义 |
| `onInputChange` | `(value: string) => void` | 输入变更回调 |
| `onSubmit` | `(value: string, isSlashCommand?) => void` | 提交回调 |
| `setCursorOffset` | `(offset: number) => void` | 光标位置变更回调 |
| `setSuggestionsState` | `(f: updater) => void` | 建议状态更新器 |
| `suggestionsState` | `{suggestions, selectedSuggestion, commandArgumentHint?}` | 当前建议状态 |
| `suppressSuggestions` | `boolean` | 是否抑制所有建议 |
| `markAccepted` | `() => void` | 标记建议已接受（遥测） |
| `onModeChange` | `(mode: PromptInputMode) => void` | 模式切换回调 |

**返回值 `UseTypeaheadResult`**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `suggestions` | `SuggestionItem[]` | 当前候选列表 |
| `selectedSuggestion` | `number` | 选中索引（-1 表示无选中） |
| `suggestionType` | `SuggestionType` | 当前建议类型 |
| `maxColumnWidth` | `number \| undefined` | 建议列表固定列宽（防止筛选时布局抖动） |
| `commandArgumentHint` | `string \| undefined` | 命令参数提示文本 |
| `inlineGhostText` | `InlineGhostText \| undefined` | 行内灰色补全文本 |
| `handleKeyDown` | `(e: KeyboardEvent) => void` | 键盘事件处理器 |

> 源码位置：`src/hooks/useTypeahead.tsx:353-1383`

### `generateFileSuggestions(partialPath: string, showOnEmpty?: boolean): Promise<SuggestionItem[]>`

根据部分路径查询文件建议。支持自定义 `fileSuggestion.command` 配置、空查询时展示当前目录文件、`~` 路径展开。最多返回 15 条结果。

> 源码位置：`src/hooks/fileSuggestions.ts:715-784`

### `generateUnifiedSuggestions(query, mcpResources, agents, showOnEmpty?): Promise<SuggestionItem[]>`

统一生成文件 + MCP 资源 + Agent 三类建议，按统一评分排序。

> 源码位置：`src/hooks/unifiedSuggestions.ts:111-202`

### `extractCompletionToken(text, cursorPos, includeAtSymbol?): {token, startPos, isQuoted?} | null`

从输入文本的光标位置提取可补全的 token。支持 `@"带空格的路径"` 引号语法和 Unicode 字符（CJK、变音符号等）。

> 源码位置：`src/hooks/useTypeahead.tsx:261-325`

### `formatReplacementValue(options): string`

格式化补全替换值——根据是否有 `@` 前缀、是否需要引号、是否完整补全等条件生成最终文本。

> 源码位置：`src/hooks/useTypeahead.tsx:148-173`

### `usePromptSuggestion({inputValue, isAssistantResponding})`

返回 `{suggestion, markAccepted, markShown, logOutcomeAtSubmission}`，管理空输入时的提示建议生命周期。

> 源码位置：`src/hooks/usePromptSuggestion.ts:15-177`

## 接口/类型定义

### `SuggestionType`

建议的类型枚举（来自 `PromptInputFooterSuggestions`），决定了 Tab/Enter 的应用逻辑：
`'none' | 'command' | 'file' | 'directory' | 'shell' | 'agent' | 'slack-channel' | 'custom-title'`

### `SuggestionItem`

单个建议条目的统一结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 唯一标识（如 `file-src/index.ts`、`agent-explorer`） |
| `displayText` | `string` | 显示文本 |
| `description` | `string?` | 描述信息 |
| `metadata` | `unknown` | 附加数据（如 score、completionType、sessionId） |
| `color` | `keyof Theme?` | Agent 建议的颜色标识 |

### `InlineGhostText`

行内灰色补全文本：

| 字段 | 类型 | 说明 |
|------|------|------|
| `text` | `string` | 灰色后缀文本 |
| `fullCommand` | `string` | 完整命令（Tab 接受时使用） |
| `insertPosition` | `number` | 插入位置 |

### `SuggestionSource`（unifiedSuggestions.ts 内部）

联合类型 `FileSuggestionSource | McpResourceSuggestionSource | AgentSuggestionSource`，三类来源各自携带不同的元数据。

## 配置项与默认值

| 配置项 | 来源 | 默认值 | 说明 |
|--------|------|--------|------|
| `respectGitignore` | 项目设置 / 全局配置 | `true` | 是否在文件索引中排除 gitignore 中的文件 |
| `fileSuggestion.type` | 项目设置 | `undefined` | 设置为 `"command"` 时使用自定义命令生成文件建议 |
| `MAX_SUGGESTIONS` | 硬编码 | `15` | 文件建议最大返回数 |
| `MAX_UNIFIED_SUGGESTIONS` | 硬编码 | `15` | 统一建议最大返回数 |
| `REFRESH_THROTTLE_MS` | 硬编码 | `5000` | 文件索引刷新节流间隔 |
| debounce（文件搜索） | 硬编码 | `50ms` | 文件建议的防抖延迟 |
| debounce（Slack 频道） | 硬编码 | `150ms` | Slack 频道建议的防抖延迟 |

## 边界 Case 与注意事项

- **渐进式查询**：文件索引在构建过程中即可查询（返回部分结果），构建完成后通过 `indexBuildComplete` signal 自动重新搜索，将部分结果升级为完整结果（`src/hooks/fileSuggestions.ts:656-665`）
- **签名去重**：通过 `pathListSignature` 的 FNV-1a 采样哈希避免重复构建索引。采样间隔为 `n/500`，对 346k 文件列表仅哈希约 700 条路径。极端情况下两次采样之间的单文件重命名可能漏检，但 5 秒刷新兜底（`src/hooks/fileSuggestions.ts:101-131`）
- **Stale 结果丢弃**：所有异步操作（文件搜索、Shell 补全、Slack 频道）通过 `latestXxxRef` 模式丢弃过期结果，避免旧查询覆盖新查询
- **选中项保持**：更新建议列表时通过 `getPreservedSelection` 按 `item.id` 匹配保持用户之前的选中项（`src/hooks/useTypeahead.tsx:52-74`）
- **ghost text 双模式**：prompt 模式的 ghost text 通过 `useMemo` 同步计算（消除一帧闪烁），bash 模式通过 `useState` 异步更新
- **Unicode 支持**：token 提取正则使用 `\p{L}\p{N}\p{M}` 等 Unicode 属性类，支持 CJK、变音符号等非 ASCII 路径
- **测试环境跳过预热**：`NODE_ENV=test` 时跳过 `startBackgroundCacheRefresh` 调用，防止 CI 环境中 git ls-files 操作泄漏到后续测试
- **Overlay 注册**：补全弹窗注册为 overlay，确保 ESC 键优先关闭补全而不是取消正在运行的任务（`src/hooks/useTypeahead.tsx:1267-1279`）
- **cacheGeneration 防护**：`clearFileSuggestionCaches` 递增 generation 计数器，后台异步操作在完成时检查 generation 是否变化，防止合并过期数据（`src/hooks/fileSuggestions.ts:84-99`）