# MagicDocs —— 魔法文档自动维护服务

## 概述与职责

MagicDocs 是 Claude Code 的辅助功能服务之一，属于 **Services → AssistantFeatures** 层级。它实现了一种"活文档"机制：当用户在对话中读取到带有 `# MAGIC DOC:` 标记头的 Markdown 文件时，系统会在后续对话空闲时自动启动后台 Agent，将对话中产生的新知识融入文档内容。

该服务的核心价值在于——用户无需手动维护文档，只需在文件顶部加上标记头，系统就会在对话过程中自动将有价值的信息增量更新到文档中。

同级兄弟模块包括语音输入（voice）、提示建议（PromptSuggestion）、自动梦境（autoDream）等辅助功能服务。

模块由两个文件组成：
- **`magicDocs.ts`**：检测逻辑、文档跟踪注册、后台更新调度
- **`prompts.ts`**：更新提示模板的构建与变量替换

## 关键流程

### 1. 初始化与文件检测

整个服务通过 `initMagicDocs()` 启动（`magicDocs.ts:242-254`）。初始化**仅在内部用户**（`USER_TYPE === 'ant'`）环境下生效，执行两步注册：

1. 调用 `registerFileReadListener()` 向 FileReadTool 注册监听器。每当用户通过 Read 工具读取文件时，监听器会检查文件内容是否包含 Magic Doc 标记头
2. 调用 `registerPostSamplingHook()` 注册采样后钩子，在每次模型响应完成后触发文档更新检查

### 2. Magic Doc 标记头检测

`detectMagicDocHeader()` 函数（`magicDocs.ts:52-81`）负责解析文件内容，识别两种信息：

- **标题**：通过正则 `/^#\s*MAGIC\s+DOC:\s*(.+)$/im` 匹配文件首行的 `# MAGIC DOC: <title>` 格式
- **自定义指令**（可选）：紧跟标题行之后的斜体文本（`*instructions*` 或 `_instructions_`），作为文档特定的更新指令

示例文件格式：
```markdown
# MAGIC DOC: 系统架构

*重点关注模块间的依赖关系和数据流向*

（文档正文...）
```

检测成功后，文件路径会被 `registerMagicDoc()` 加入 `trackedMagicDocs` Map（以路径为 key 去重）。

### 3. 后台更新调度

`updateMagicDocs` 钩子（`magicDocs.ts:217-240`）在每次模型采样完成后触发，使用 `sequential()` 包装确保串行执行，防止并发竞争。更新需满足三个前置条件：

1. **来源限制**：`querySource` 必须为 `'repl_main_thread'`，子 Agent 对话不会触发更新
2. **空闲检测**：通过 `hasToolCallsInLastAssistantTurn()` 判断最近一轮助手回复中无工具调用——即对话处于"空闲"状态时才执行更新，避免干扰正在进行的工具操作
3. **有跟踪文档**：`trackedMagicDocs` 中至少有一个文档

条件满足后，遍历所有跟踪的文档逐一调用 `updateMagicDoc()`。

### 4. 单文档更新流程

`updateMagicDoc()` 函数（`magicDocs.ts:114-212`）是核心执行逻辑：

1. **克隆 FileStateCache**：调用 `cloneFileStateCache()` 创建隔离的文件状态缓存副本，并删除当前文档的缓存条目，确保 FileReadTool 返回实际文件内容而非 `file_unchanged` 存根（`magicDocs.ts:124-129`）
2. **读取文档最新内容**：通过 FileReadTool 读取文件。若文件已删除或不可访问（ENOENT/EACCES/EPERM），从跟踪列表中移除并返回
3. **重新检测标记头**：对最新文件内容再次运行 `detectMagicDocHeader()`。若标记头已被移除，取消跟踪
4. **构建更新提示**：调用 `buildMagicDocsUpdatePrompt()` 生成包含当前文档内容、路径、标题和自定义指令的完整提示
5. **构建权限沙箱**：创建自定义 `canUseTool` 函数（`magicDocs.ts:172-192`），**仅允许对该文档文件路径使用 Edit 工具**，其他任何工具调用或文件路径都会被拒绝
6. **启动后台 Agent**：通过 `runAgent()` 启动一个 Sonnet 模型的子 Agent，传入主对话的消息上下文（`forkContextMessages`）让 Agent 了解对话内容，设置 `isAsync: true` 异步执行

Agent 定义（`getMagicDocsAgent()`，`magicDocs.ts:99-109`）指定：
- `agentType`: `'magic-docs'`
- `tools`: 仅 `FILE_EDIT_TOOL_NAME`（Edit 工具）
- `model`: `'sonnet'`

### 5. 提示模板构建

`prompts.ts` 负责提示词的组装，支持两种模板来源：

1. **自定义模板**：`loadMagicDocsPrompt()` 尝试从 `~/.claude/magic-docs/prompt.md` 加载用户自定义模板（`prompts.ts:66-76`）
2. **默认模板**：若自定义模板不存在，回退到内置的 `getUpdatePromptTemplate()`

模板使用 `{{variable}}` 语法进行变量替换，`substituteVariables()` 函数（`prompts.ts:81-93`）通过单次正则替换实现，避免了两个潜在 bug：`$` 反向引用损坏和用户内容中包含 `{{varName}}` 导致的双重替换。

可用的模板变量：

| 变量名 | 说明 |
|--------|------|
| `{{docContents}}` | 文档当前完整内容 |
| `{{docPath}}` | 文档文件路径 |
| `{{docTitle}}` | Magic Doc 标题 |
| `{{customInstructions}}` | 从斜体行提取的自定义指令（构建为带优先级说明的段落） |

默认提示模板的核心要求包括：
- 保留 Magic Doc 标记头和斜体指令行不变
- 就地更新而非追加历史记录，保持文档反映当前代码库状态
- 遵循简洁的文档哲学：聚焦架构、模式、入口点和设计决策，而非逐行代码说明
- 仅在有实质性新信息时才编辑

## 函数签名

### `initMagicDocs(): Promise<void>`

服务初始化入口。注册文件读取监听器和采样后钩子。仅在 `USER_TYPE === 'ant'` 时生效。

> 源码位置：`magicDocs.ts:242-254`

### `detectMagicDocHeader(content: string): { title: string; instructions?: string } | null`

检测文件内容中的 Magic Doc 标记头，返回标题和可选的自定义指令，未检测到则返回 `null`。

> 源码位置：`magicDocs.ts:52-81`

### `registerMagicDoc(filePath: string): void`

将文件路径注册为跟踪的 Magic Doc（去重）。

> 源码位置：`magicDocs.ts:87-94`

### `clearTrackedMagicDocs(): void`

清空所有跟踪的 Magic Doc 记录。

> 源码位置：`magicDocs.ts:44-46`

### `buildMagicDocsUpdatePrompt(docContents, docPath, docTitle, instructions?): Promise<string>`

构建完整的更新提示，支持自定义模板加载和变量替换。

> 源码位置：`prompts.ts:98-127`

## 配置项

- **`USER_TYPE` 环境变量**：必须为 `'ant'` 才会启用 Magic Docs 功能（当前限于内部用户）
- **`~/.claude/magic-docs/prompt.md`**：可选的自定义提示模板文件，使用 `{{variable}}` 语法，覆盖默认更新逻辑

## 边界 Case 与注意事项

- **内部用户限定**：`initMagicDocs()` 检查 `USER_TYPE === 'ant'`，外部用户环境下整个服务不会初始化
- **仅主线程触发**：`querySource` 必须为 `'repl_main_thread'`，子 Agent 对话不会触发文档更新
- **空闲时才更新**：只有在助手最近回复中没有工具调用时才触发，避免在工具执行中途更新文档
- **串行执行**：`sequential()` 包装确保多个更新钩子调用不会并发执行
- **文件状态隔离**：每次更新都克隆 `FileStateCache`，避免影响主对话的文件去重缓存
- **自动清理**：文件被删除、不可访问或标记头被移除时，自动从跟踪列表中清除
- **权限沙箱**：后台 Agent 只能对目标文档路径使用 Edit 工具，无法修改其他文件或执行其他操作
- **自定义模板的变量替换**采用单次正则替换，安全处理了 `$` 特殊字符和潜在的双重替换问题