# BashTool 核心入口与编排器

## 概述与职责

BashTool 是 Claude Code 中最常用的工具之一，负责将用户/模型请求的 Shell 命令安全地执行并返回结果。它位于 **ToolSystem → ShellTools → BashTool** 层级中，实现了 `Tool` 接口，是整个 Bash 命令执行流水线的编排中枢。

本模块由四个文件组成：
- **BashTool.tsx**（1143 行）：核心入口，编排命令解析、安全校验、权限检查、沙箱执行、输出处理的完整流程
- **prompt.ts**（369 行）：生成工具的系统提示词，包含沙箱配置、Git 操作指南、命令使用规范
- **toolName.ts**：导出工具名称常量 `BASH_TOOL_NAME = 'Bash'`
- **commentLabel.ts**：从命令首行注释中提取人类可读标签

同级的兄弟模块 PowerShellTool 复用了本模块的部分共享工具函数（如 `shouldUseSandbox`、`BackgroundHint` UI 组件等）。

---

## 关键流程

### 命令执行主流程（`call` 方法）

整个命令执行经过以下编排阶段（`BashTool.tsx:624-825`）：

1. **模拟 sed 编辑拦截**：若输入包含 `_simulatedSedEdit` 字段，直接走 `applySedEdit()` 路径，绕过 Shell 执行，确保用户在权限预览中看到的内容与实际写入完全一致（`BashTool.tsx:627-629`）

2. **启动 Shell 命令**：调用 `runShellCommand()` 异步生成器，消费其产出的进度事件并通过 `onProgress` 回调推送给 UI 层（`BashTool.tsx:646-682`）

3. **结果处理**：
   - 调用 `trackGitOperations()` 追踪 Git 操作（`BashTool.tsx:683`）
   - 调用 `interpretCommandResult()` 对退出码进行语义解释（`BashTool.tsx:690`）
   - 检测 `.git/index.lock` 错误并上报（`BashTool.tsx:693-695`）
   - 非中断的错误结果抛出 `ShellError`（`BashTool.tsx:714-719`）

4. **大输出持久化**：当输出文件超过阈值时，复制到 `tool-results` 目录供 FileRead 读取，超过 64MB 则截断（`BashTool.tsx:732-753`）

5. **输出后处理**：
   - 去除空行（`stripEmptyLines`）
   - 提取并剥离 `<claude-code-hint />` 标签（零 token 侧信道协议）（`BashTool.tsx:778-784`）
   - 图片输出检测与压缩（`BashTool.tsx:785-802`）

6. **组装返回值**：构造 `Out` 对象，包含 stdout、stderr、中断状态、后台任务 ID、沙箱标志、持久化路径等（`BashTool.tsx:803-819`）

### 命令执行引擎（`runShellCommand` 异步生成器）

`runShellCommand`（`BashTool.tsx:826-1143`）是实际的命令执行引擎，以 `AsyncGenerator` 形式实现，通过 `yield` 产出进度更新，最终 `return` 执行结果：

1. **调用 `exec()`** 启动 Shell 进程，注册 `onProgress` 回调接收输出增量（`BashTool.tsx:881-898`）

2. **后台任务管理**：
   - **显式后台**：`run_in_background === true` 时立即 `spawnBackgroundTask()` 并返回（`BashTool.tsx:997-1007`）
   - **超时自动后台**：通过 `shellCommand.onTimeout` 注册回调，命令超时后自动转后台（`BashTool.tsx:973-978`）
   - **助理模式自动后台**：在 Kairos（助理模式）下，主线程命令超过 15 秒后自动后台化，保持对话响应性（`BashTool.tsx:983-993`）
   - **用户手动后台**：通过 Ctrl+B 触发，Shell 命令状态变为 `'backgrounded'`（`BashTool.tsx:1094-1103`）

3. **进度显示循环**：
   - 初始等待 2 秒（`PROGRESS_THRESHOLD_MS`），快速完成的命令不显示进度（`BashTool.tsx:1013-1028`）
   - 超过 2 秒后启动 `TaskOutput.startPolling`，进入 `Promise.race` 循环：命令完成 vs 进度信号（`BashTool.tsx:1035-1140`）
   - 注册 foreground task 以支持 Ctrl+B 后台化，渲染 `<BackgroundHint />` UI（`BashTool.tsx:1117-1128`）

4. **竞态处理**：当后台化定时器和命令完成同时触发时，优先返回完成结果，调用 `markTaskNotified()` 抑制冗余的 `<task_notification>`（`BashTool.tsx:1049-1072`）

### 提示词生成流程（prompt.ts）

`getSimplePrompt()`（`prompt.ts:275-369`）组装完整的工具系统提示词：

1. **工具偏好指引**：引导模型优先使用专用工具（Glob、Grep、Read、Edit、Write）而非 Bash 命令（`prompt.ts:280-291`）。当启用嵌入式搜索工具时跳过 Glob/Grep 引导

2. **命令使用规范**：包括文件路径引号、工作目录维护、超时配置、多命令并行/串行策略、Git 安全协议、sleep 使用限制等（`prompt.ts:331-352`）

3. **沙箱配置段**：由 `getSimpleSandboxSection()` 生成（`prompt.ts:172-273`），包含：
   - 文件系统读写限制（`denyOnly`、`allowOnly`、`denyWithinAllow`）
   - 网络限制（`allowedHosts`、`deniedHosts`、`allowUnixSockets`）
   - `dangerouslyDisableSandbox` 的使用规则
   - 临时目录统一为 `$TMPDIR`（避免跨用户 prompt cache 失效）

4. **Git 操作指南**：由 `getCommitAndPRInstructions()` 生成（`prompt.ts:42-161`），包含：
   - Git 安全协议（禁止 force push、禁止跳过 hooks、优先新提交而非 amend）
   - Commit 和 PR 创建的详细步骤
   - 内部用户（`ant`）使用精简版指向 `/commit` 和 `/commit-push-pr` 技能
   - 外部用户使用完整内联指引，包含 attribution 文本

---

## 函数签名与参数说明

### `BashTool`（`buildTool` 构建的 Tool 对象）

通过 `buildTool()` 工厂函数创建，实现 `ToolDef<InputSchema, Out, BashProgress>` 接口。

**输入 Schema**（`BashTool.tsx:227-259`）：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | `string` | 是 | 要执行的 bash 命令 |
| `timeout` | `number` | 否 | 超时时间（毫秒），上限由 `getMaxTimeoutMs()` 决定 |
| `description` | `string` | 否 | 命令的人类可读描述，用于 UI 展示 |
| `run_in_background` | `boolean` | 否 | 是否后台运行（后台任务禁用时从 schema 中移除） |
| `dangerouslyDisableSandbox` | `boolean` | 否 | 是否禁用沙箱（需用户确认） |
| `_simulatedSedEdit` | `object` | 否 | 内部字段，不暴露给模型，用于 sed 编辑预览后的精确写入 |

**输出 Schema**（`BashTool.tsx:279-294`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `stdout` | `string` | 标准输出 |
| `stderr` | `string` | 标准错误 |
| `interrupted` | `boolean` | 命令是否被中断 |
| `isImage` | `boolean?` | stdout 是否包含图片数据 |
| `backgroundTaskId` | `string?` | 后台任务 ID |
| `backgroundedByUser` | `boolean?` | 是否由用户手动后台化 |
| `assistantAutoBackgrounded` | `boolean?` | 是否被助理模式自动后台化 |
| `returnCodeInterpretation` | `string?` | 非错误退出码的语义解释 |
| `noOutputExpected` | `boolean?` | 命令是否预期无输出（如 mv、cp） |
| `persistedOutputPath` | `string?` | 大输出持久化文件路径 |
| `persistedOutputSize` | `number?` | 大输出总字节数 |

### 关键 Tool 接口方法

- **`checkPermissions(input, context)`**：委托给 `bashToolHasPermission()`，执行基于 AST 的权限规则匹配（`BashTool.tsx:539-541`）
- **`validateInput(input)`**：校验 sleep 模式阻断（需 MONITOR_TOOL 特性开启）（`BashTool.tsx:524-538`）
- **`isReadOnly(input)`**：通过 `checkReadOnlyConstraints()` 判断命令是否为只读（`BashTool.tsx:437-441`）
- **`isConcurrencySafe(input)`**：只读命令可并发执行（`BashTool.tsx:434-436`）
- **`preparePermissionMatcher({command})`**：解析命令 AST 为 hook `if` 过滤提供匹配器，确保复合命令（如 `ls && git push`）中任一子命令匹配即触发 hook（`BashTool.tsx:445-468`）
- **`mapToolResultToToolResultBlockParam(...)`**：将输出转换为 Claude API 的 `ToolResultBlockParam`，支持图片、结构化内容、大输出预览、后台任务信息等（`BashTool.tsx:555-623`）

### `extractBashCommentLabel(command: string): string | undefined`

从命令首行提取注释标签（`commentLabel.ts:8-13`）。如果命令的第一行是 `# comment`（非 shebang `#!`），返回去除 `#` 前缀后的文本。在全屏模式下用作非详细模式的工具调用标签和折叠组提示。

### `getSimplePrompt(): string`

生成完整的 BashTool 系统提示词（`prompt.ts:275-369`），包含工具偏好、使用规范、沙箱配置、Git 操作指南。

### `applySedEdit(simulatedEdit, toolUseContext, parentMessage)`

模拟 sed 编辑的直接应用（`BashTool.tsx:360-419`）。绕过 Shell 执行，确保权限预览内容与实际写入一致。处理文件编码检测、行尾风格保持、文件历史追踪、VS Code 通知等。

---

## 接口/类型定义

### `BashToolInput`

从 `fullInputSchema` 推导的输入类型，即使 `run_in_background` 从模型可见 schema 中移除，代码内部仍使用完整类型（`BashTool.tsx:264`）。

### `Out`

从 `outputSchema` 推导的输出类型，包含命令执行的所有结果字段（`BashTool.tsx:296`）。

### `BashProgress`

进度事件类型，从 `../../types/tools.js` 重新导出（`BashTool.tsx:299`），包含 `output`、`fullOutput`、`elapsedTimeSeconds`、`totalLines`、`totalBytes`、`taskId`、`timeoutMs` 等字段。

---

## 配置项与默认值

| 配置项 | 来源 | 默认值 | 说明 |
|--------|------|--------|------|
| `PROGRESS_THRESHOLD_MS` | 常量 | 2000 | 超过 2 秒才显示进度 |
| `ASSISTANT_BLOCKING_BUDGET_MS` | 常量 | 15000 | 助理模式下阻塞命令自动后台化的阈值 |
| `maxResultSizeChars` | Tool 配置 | 30000 | 工具结果持久化阈值（字符） |
| `MAX_PERSISTED_SIZE` | 常量 | 64MB | 持久化输出文件的最大字节数 |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | 环境变量 | - | 设为 truthy 禁用后台任务功能 |
| `CLAUDE_CODE_BASH_SANDBOX_SHOW_INDICATOR` | 环境变量 | - | 设为 truthy 在工具名称显示 "SandboxedBash" |
| `USER_TYPE` | 环境变量 | - | `'ant'` 时使用内部精简版 Git 指引 |
| `CLAUDE_CODE_SIMPLE` | 环境变量 | - | 设为 truthy 时省略技能引用 |

---

## 命令分类机制

BashTool.tsx 定义了多组命令集合，用于 UI 展示和行为判断：

- **`BASH_SEARCH_COMMANDS`**：搜索类命令（`find`, `grep`, `rg`, `ag` 等），UI 中折叠显示（`BashTool.tsx:60`）
- **`BASH_READ_COMMANDS`**：读取/分析类命令（`cat`, `head`, `jq`, `awk` 等），UI 中折叠显示（`BashTool.tsx:63-67`）
- **`BASH_LIST_COMMANDS`**：目录列举命令（`ls`, `tree`, `du`），摘要显示为 "Listed N directories"（`BashTool.tsx:72`）
- **`BASH_SEMANTIC_NEUTRAL_COMMANDS`**：语义中性命令（`echo`, `printf`, `true` 等），在管道分类中被跳过（`BashTool.tsx:77`）
- **`BASH_SILENT_COMMANDS`**：预期无输出的命令（`mv`, `cp`, `rm` 等），成功时显示 "Done" 而非 "(No output)"（`BashTool.tsx:81`）

`isSearchOrReadBashCommand()`（`BashTool.tsx:95-172`）解析复合命令（管道、`&&`、`;`），只有所有非中性部分都属于搜索/读取类时才标记为可折叠。

---

## 边界 Case 与注意事项

1. **`_simulatedSedEdit` 安全设计**：该字段始终从模型可见的 schema 中移除（`BashTool.tsx:249-259`），防止模型绕过权限检查，通过配对一个无害命令和任意文件写入来突破沙箱

2. **竞态条件处理**：`runShellCommand` 中，当后台化定时器（超时/助理模式/Ctrl+B）和命令完成几乎同时触发时，通过检查 `result.backgroundTaskId` 并调用 `markTaskNotified()` 来抑制冗余通知，避免重复的 `<task_notification>`（`BashTool.tsx:1049-1072`）

3. **prompt cache 优化**：`getSimpleSandboxSection()` 中将每用户的临时目录路径（如 `/private/tmp/claude-1001/`）替换为 `$TMPDIR`，确保不同用户间共享全局 prompt cache（`prompt.ts:186-190`）。`dedup()` 函数去除 SandboxManager 合并多层配置时产生的重复路径，节省约 150-200 token/请求（`prompt.ts:167-170`）

4. **CWD 重置**：非主线程中禁止 CWD 变更（`preventCwdChanges`）。主线程中如果 CWD 跑到项目目录外，`resetCwdIfOutsideProject()` 会自动重置并在 stderr 中附加提示（`BashTool.tsx:702-707`）

5. **sleep 阻断**：启用 MONITOR_TOOL 特性后，`detectBlockedSleepPattern()` 阻止 ≥2 秒的 sleep 命令执行，引导模型使用 `run_in_background` 或 Monitor 工具（`BashTool.tsx:322-337`）

6. **Undercover 模式**：对内部用户（`USER_TYPE === 'ant'`），如果启用了 undercover 模式，Git 指引中会注入额外的防泄露指令，避免在 commit 消息中暴露内部代号（`prompt.ts:43-51`）