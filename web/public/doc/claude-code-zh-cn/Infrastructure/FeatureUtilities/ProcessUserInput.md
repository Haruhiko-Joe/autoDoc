# 用户输入处理管道（ProcessUserInput）

## 概述与职责

用户输入处理管道是 Claude Code 的**输入分发中枢**，负责接收用户的原始输入（文本、图片、斜杠命令、Bash 命令等），经过规范化、图片处理、附件提取后，路由到对应的处理器生成结构化消息。

在系统架构中，该模块位于 **Infrastructure → FeatureUtilities** 层，被上层的 TerminalUI（REPL 主屏幕）和 CoreEngine 调用，是用户输入从 UI 层进入查询引擎的必经之路。同级模块包括 Shell/Bash 基础设施、Git 操作、权限框架、插件系统等。

模块由 4 个文件组成：
- `processUserInput.ts` — 入口分发器，统筹协调整个管道
- `processSlashCommand.tsx` — 斜杠命令解析与执行（最大的文件，~920 行）
- `processBashCommand.tsx` — Bash 命令快捷执行
- `processTextPrompt.ts` — 普通文本提示词处理

## 关键流程

### 主入口分发流程（processUserInput → processUserInputBase）

整个管道分为两层：外层 `processUserInput()` 和内层 `processUserInputBase()`。

1. **外层 `processUserInput()`**（`processUserInput.ts:85-270`）：
   - 立即调用 `setUserInputOnProcessing()` 在 UI 上显示用户输入（isMeta 系统消息除外）
   - 调用 `processUserInputBase()` 执行核心分发逻辑
   - 如果结果的 `shouldQuery` 为 `false`，直接返回（不触发模型调用）
   - 否则执行 **UserPromptSubmit Hooks**：遍历所有注册的钩子，处理阻断（blockingError）、停止（preventContinuation）、附加上下文（additionalContexts）等

2. **内层 `processUserInputBase()`**（`processUserInput.ts:281-605`）按以下顺序分发：

```
输入 → 图片处理 → Bridge安全命令检查 → Ultraplan关键词检测
     → 附件提取 → 模式路由：
         ├─ mode="bash"  → processBashCommand()
         ├─ 以"/"开头     → processSlashCommand()
         └─ 其他          → processTextPrompt()
```

### 图片处理流程

在路由之前，管道会统一处理两类图片：

1. **内联图片块**（来自 SDK/VS Code 的 `ContentBlockParam[]` 输入）：逐个调用 `maybeResizeAndDownsampleImageBlock()` 进行缩放，同时修正 iOS 客户端的 `mediaType` → `media_type` 字段名问题（`processUserInput.ts:317-345`）

2. **粘贴图片**（来自终端的 `pastedContents`）：并行调用 `Promise.all()` 批量缩放，同时调用 `storeImages()` 持久化到磁盘以便后续 CLI 工具引用（`processUserInput.ts:353-420`）

处理后的图片元数据（尺寸、路径）会通过 `addImageMetadataMessage()` 作为 `isMeta: true` 的隐藏消息附加到结果中，供模型感知但不向用户展示。

### Bridge 安全命令检查

当输入来自远程 Bridge（`skipSlashCommands=true`），默认不执行本地斜杠命令。但如果同时设置了 `bridgeOrigin=true`，则对以 `/` 开头的输入执行安全检查（`processUserInput.ts:428-453`）：

- 通过 `isBridgeSafeCommand()` 判定的命令：允许执行（清除 skip 标志）
- 已知但不安全的命令：返回 `"/{name} isn't available over Remote Control."` 错误消息
- 未知命令：作为普通文本透传（不报错，兼容用户输入 `/shrug` 等非命令文本）

### Ultraplan 关键词路由

当满足以下全部条件时，输入会被重写为 `/ultraplan` 命令（`processUserInput.ts:467-493`）：

- `ULTRAPLAN` feature flag 开启
- 交互式 prompt 模式（非 headless/-p 模式）
- 输入不以 `/` 开头
- 当前没有活跃的 ultraplan 会话
- **原始输入**（`preExpansionInput`，展开粘贴内容之前）包含 ultraplan 关键词

使用 `preExpansionInput` 而非展开后的输入进行检测，是为了防止粘贴内容中恰好包含关键词而误触发。

## 函数签名与参数说明

### `processUserInput(options): Promise<ProcessUserInputBaseResult>`

主入口函数。

| 参数 | 类型 | 说明 |
|------|------|------|
| `input` | `string \| ContentBlockParam[]` | 用户输入，字符串或结构化内容块数组 |
| `preExpansionInput` | `string?` | 粘贴内容展开前的原始输入，用于 ultraplan 检测 |
| `mode` | `PromptInputMode` | 输入模式：`"prompt"` / `"bash"` |
| `setToolJSX` | `SetToolJSXFn` | 设置 UI 进度显示的回调 |
| `context` | `ProcessUserInputContext` | 工具使用上下文 + 本地 JSX 命令上下文 |
| `pastedContents` | `Record<number, PastedContent>?` | 粘贴的内容（图片等） |
| `ideSelection` | `IDESelection?` | IDE 当前选区信息 |
| `messages` | `Message[]?` | 当前对话消息历史 |
| `skipSlashCommands` | `boolean?` | 是否跳过斜杠命令解析（远程消息用） |
| `bridgeOrigin` | `boolean?` | 是否允许 Bridge 安全命令通过 |
| `isMeta` | `boolean?` | 是否标记为系统生成的隐藏消息 |
| `skipAttachments` | `boolean?` | 是否跳过附件提取 |

### `processSlashCommand(inputString, ...): Promise<ProcessUserInputBaseResult>`

斜杠命令处理器（`processSlashCommand.tsx:309`）。

- 调用 `parseSlashCommand()` 解析命令名和参数
- 未识别的命令：如果看起来像命令名（纯字母数字）则返回 "Unknown skill" 错误；如果像文件路径则作为普通 prompt 传递给模型
- 已识别的命令：调用 `getMessagesForSlashCommand()` 按命令类型分发

### `processBashCommand(inputString, ...): Promise<{messages, shouldQuery}>`

Bash 命令处理器（`processBashCommand.tsx:17`）。

- 根据 `isPowerShellToolEnabled()` 和 `resolveDefaultShell()` 选择 Bash 或 PowerShell 后端
- 所有用户发起的 `!` 命令都设置 `dangerouslyDisableSandbox: true`（在沙箱外执行）
- PowerShell 模块按需懒加载（~300KB chunk）

### `processTextPrompt(input, ...): {messages, shouldQuery}`

文本提示词处理器（`processTextPrompt.ts:19`）。

- 生成并设置 `promptId`（用于追踪）
- 发送 OpenTelemetry `user_prompt` 事件
- 检测否定关键词（`matchesNegativeKeyword`）和继续关键词（`matchesKeepGoingKeyword`）
- 将文本和图片内容块组合为 `UserMessage`

## 接口/类型定义

### `ProcessUserInputBaseResult`

所有处理路径的统一返回类型（`processUserInput.ts:64-83`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `messages` | `Message[]` | 生成的消息数组（用户消息、附件、系统消息等） |
| `shouldQuery` | `boolean` | 是否需要触发模型查询 |
| `allowedTools` | `string[]?` | 技能授予的额外工具权限 |
| `model` | `string?` | 技能指定的模型覆盖 |
| `effort` | `EffortValue?` | 技能指定的推理强度 |
| `resultText` | `string?` | 非交互模式（-p）下的输出文本 |
| `nextInput` | `string?` | 命令完成后预填充的下一次输入 |
| `submitNextInput` | `boolean?` | 是否自动提交 nextInput |

### `ProcessUserInputContext`

组合类型 `ToolUseContext & LocalJSXCommandContext`（`processUserInput.ts:62`），提供工具执行环境和本地 JSX 命令渲染能力。

## 斜杠命令的三种类型

`getMessagesForSlashCommand()`（`processSlashCommand.tsx:525-777`）根据命令类型采用不同执行策略：

### 1. `local-jsx` — 本地 JSX 交互命令

如 `/config`、`/permissions` 等需要终端 UI 交互的命令。通过 `command.load()` 动态加载模块，调用 `mod.call(onDone, context, args)` 启动 UI，返回的 JSX 通过 `setToolJSX` 渲染为全屏模态框。支持 `display: 'skip' | 'system'` 控制输出方式。

### 2. `local` — 本地同步命令

如 `/compact`。直接调用模块的 `call()` 方法，支持三种返回类型：
- `skip`：不产生任何消息
- `compact`：触发上下文压缩，调用 `buildPostCompactMessages()` 重建消息
- 文本：作为 `<local-command-stdout>` 包装的系统消息

### 3. `prompt` — 提示词命令（技能）

如 `/commit`、`/review-pr` 等。分为两个子路径：

- **`context: 'fork'`**（`executeForkedSlashCommand`，`processSlashCommand.tsx:62-295`）：在独立子 Agent 中执行。如果启用了 Kairos（助理模式），则**后台异步执行**——子 Agent 并行运行，完成后通过 `enqueuePendingNotification` 将结果重新入队为 isMeta 消息。否则同步执行并显示进度 UI。

- **普通 prompt 命令**（`getMessagesForPromptSlashCommand`，`processSlashCommand.tsx:827-921`）：加载技能内容、注册技能 Hooks、解析附件和 `@` 提及，将技能 prompt 作为 isMeta 消息和权限附件一起返回。在 Coordinator 模式下，仅返回技能摘要供协调器委派给 Worker。

## Hook 执行机制

外层 `processUserInput()` 在 `shouldQuery=true` 时执行 `UserPromptSubmit` Hooks（`processUserInput.ts:178-263`）：

- **阻断错误**（`blockingError`）：丢弃原始用户输入，返回系统警告消息，`shouldQuery` 置 `false`
- **阻止继续**（`preventContinuation`）：保留原始消息但不查询模型
- **附加上下文**（`additionalContexts`）：作为 `hook_additional_context` 附件消息追加
- **成功输出**（`hook_success`）：非空内容追加为附件消息

所有 Hook 输出通过 `applyTruncation()` 限制在 10,000 字符内（`processUserInput.ts:272-279`）。

## 边界 Case 与注意事项

- **`shouldQuery` 语义**：该标志决定处理结果是否触发模型调用。Bash 命令和大多数本地命令返回 `false`（结果直接展示），只有普通文本和 prompt 类技能返回 `true`
- **动态导入**：`processSlashCommand` 和 `processBashCommand` 均通过 `await import()` 懒加载，减少主入口的初始化开销
- **iOS 兼容**：Bridge 输入可能使用 `mediaType` 而非 API 要求的 `media_type`，在图片处理阶段统一修正
- **文件路径 vs 命令名**：以 `/` 开头的输入如果看起来像文件路径（如 `/var`、`/tmp`），会被当作普通 prompt 传给模型而非报 "Unknown skill" 错误（`processSlashCommand.tsx:336-381`）
- **`looksLikeCommand()`** 函数（`processSlashCommand.tsx:304-308`）通过正则 `/[^a-zA-Z0-9:\-_]/` 判断字符串是否为合法命令名，含特殊字符的视为文件路径
- **MCP 等待**：后台 forked 命令在启动前会轮询等待 MCP 服务器连接完成（最长 10 秒，每 200ms 检查一次），确保子 Agent 能访问完整的工具列表（`processSlashCommand.tsx:56-57`）