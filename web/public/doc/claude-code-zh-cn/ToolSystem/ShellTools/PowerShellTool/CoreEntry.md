# PowerShellTool 核心入口与展示层

## 概述与职责

PowerShellTool 是 Claude Code 工具系统中负责 Windows PowerShell 命令执行的核心工具，与 BashTool 对称，提供从参数校验到结果渲染的完整命令执行流水线。它位于 `ToolSystem → ShellTools → PowerShellTool` 层级下，与同级的 BashTool 共同构成 Shell 命令执行能力。

本模块由 5 个文件组成，各自职责清晰：

| 文件 | 行数 | 职责 |
|------|------|------|
| `PowerShellTool.tsx` | 1000 | 核心入口，编排完整的命令执行流程 |
| `UI.tsx` | 130 | React/Ink 渲染组件，处理命令显示、进度和结果 |
| `prompt.ts` | 145 | 生成 PowerShell 特化的工具提示词 |
| `toolName.ts` | 2 | 导出工具名称常量，打破循环依赖 |
| `commandSemantics.ts` | 143 | 外部可执行文件的非零退出码语义解释 |

PowerShellTool 大量复用 BashTool 的基础设施：`shouldUseSandbox`（沙箱判定）、`BackgroundHint`（后台提示 UI）、以及 `utils.js` 中的图片处理、路径重置等工具函数。

## 关键流程

### 命令执行主流程

PowerShellTool 的核心执行链由 `buildTool()` 构建的工具定义驱动，主要经过以下阶段：

1. **输入校验（`validateInput`）**：检查 Windows 沙箱策略合规性（`isWindowsSandboxPolicyViolation`），以及 `Start-Sleep` 阻塞模式检测（`detectBlockedSleepPattern`）。超过 2 秒的 sleep 会被拦截并建议使用 `run_in_background`（`PowerShellTool.tsx:352-374`）

2. **权限检查（`checkPermissions`）**：委托给 `powershellPermissions.ts` 中的 `powershellToolHasPermission`，执行基于 cmdlet 级别的权限匹配（`PowerShellTool.tsx:375-377`）

3. **命令执行（`call`）**：核心方法，构造执行上下文后调用 `runPowerShellCommand` 异步生成器。通过 `Promise.race` 在命令结果和进度更新之间轮询（`PowerShellTool.tsx:437-658`）

4. **输出处理**：包括 Claude Code hints 提取与剥离、大结果持久化存储（>64MB 截断）、图片检测与压缩、退出码语义解释、以及 stderr/cwd 重置消息拼接

5. **结果映射（`mapToolResultToToolResultBlockParam`）**：将内部 `Out` 类型转换为 Anthropic SDK 所需的 `ToolResultBlockParam` 格式，处理图片内容块、大输出预览、后台任务信息等特殊情况（`PowerShellTool.tsx:383-436`）

### runPowerShellCommand 生成器详解

`runPowerShellCommand` 是一个 `AsyncGenerator`，负责实际的命令派发和进度汇报：

```
输入参数 → 检测 pwsh 可用性 → exec() 派发命令 → 进度轮询循环 → 返回 ExecResult
```

关键步骤（`PowerShellTool.tsx:663-1000`）：

1. **PowerShell 路径检测**：通过 `getCachedPowerShellPath()` 获取 pwsh 路径。若不可用，返回友好错误而非抛异常（code=0 + stderr 提示）

2. **exec() 调用**：调用 `Shell.exec()` 执行命令，传入超时、进度回调、沙箱配置等。沙箱仅在非 Windows 平台启用——Windows 原生环境下 bwrap/sandbox-exec 不可用（`PowerShellTool.tsx:731-751`）

3. **后台任务管理**：支持三种后台化路径：
   - **显式后台**（`run_in_background: true`）：立即 spawn 后台任务并返回（`PowerShellTool.tsx:845-857`）
   - **超时自动后台**（`onTimeout`）：命令超时时自动转后台（`PowerShellTool.tsx:824-828`）
   - **助手模式自动后台**（`KAIROS` feature flag）：主线程命令超过 15 秒自动后台，保持对话响应性（`PowerShellTool.tsx:833-840`）

4. **进度循环**：每秒 yield 一次进度更新，包含 `fullOutput`、已用时间、总行数/字节数等。超过 2 秒后注册前台任务并显示 `BackgroundHint`（Ctrl+B 提示）

5. **中断处理**：用户提交新消息时（`abortController.signal.reason === 'interrupt'`），将正在执行的命令转为后台任务而非直接 kill（`PowerShellTool.tsx:926-937`）

6. **竞态处理**：当后台化已触发但命令恰好完成时，通过 `markTaskNotified` 抑制重复的 `<task_notification>`，并重建 `outputFilePath`（`PowerShellTool.tsx:886-908`）

### Windows 沙箱策略

PowerShellTool 对 Windows 原生环境有特殊处理（`PowerShellTool.tsx:207-222`）：

- Windows 原生平台无法使用 bwrap/sandbox-exec 沙箱
- 如果企业策略要求沙箱（`SandboxManager.isSandboxEnabledInSettings()`）且禁止非沙箱命令，PowerShellTool 将**拒绝执行**而非静默绕过
- 此检查同时存在于 `validateInput`（为工具运行器提供清晰错误）和 `call()`（覆盖直接调用者如 `promptShellExecution.ts`）

## 函数签名与参数说明

### PowerShellTool（工具定义）

通过 `buildTool()` 构建，注册名为 `'PowerShell'` 的工具。

**输入 Schema（`PowerShellToolInput`）**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | `string` | 是 | 要执行的 PowerShell 命令 |
| `timeout` | `number` | 否 | 超时毫秒数，上限由 `getMaxBashTimeoutMs()` 决定 |
| `description` | `string` | 否 | 命令的简短描述 |
| `run_in_background` | `boolean` | 否 | 是否后台运行（当 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` 启用时从 schema 中移除） |
| `dangerouslyDisableSandbox` | `boolean` | 否 | 危险：禁用沙箱模式 |

**输出 Schema（`Out`）**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `stdout` | `string` | 标准输出 |
| `stderr` | `string` | 标准错误输出 |
| `interrupted` | `boolean` | 命令是否被中断 |
| `returnCodeInterpretation` | `string?` | 非零退出码的语义解释（如 robocopy exit 1 = "Files copied successfully"）|
| `isImage` | `boolean?` | stdout 是否包含图片数据 |
| `persistedOutputPath` | `string?` | 大输出持久化文件路径 |
| `persistedOutputSize` | `number?` | 持久化输出的原始大小（字节）|
| `backgroundTaskId` | `string?` | 后台任务 ID |
| `backgroundedByUser` | `boolean?` | 是否由用户手动后台化（Ctrl+B）|
| `assistantAutoBackgrounded` | `boolean?` | 是否由助手模式自动后台化 |

### `detectBlockedSleepPattern(command: string): string | null`

检测命令中的 `Start-Sleep` 阻塞模式。匹配 `Start-Sleep N`、`Start-Sleep -Seconds N`、`sleep N`（内置别名），仅检查第一条语句。小于 2 秒的 sleep 不拦截。返回描述字符串或 `null`。

> 源码位置：`PowerShellTool.tsx:189-205`

### `interpretCommandResult(command, exitCode, stdout, stderr): { isError, message? }`

根据命令语义规则解释退出码。通过启发式方法提取命令名（取最后一个管道段），查询 `COMMAND_SEMANTICS` 映射表。

> 源码位置：`commandSemantics.ts:130-142`

### `getPrompt(): Promise<string>`

生成 PowerShell 工具的完整提示词，包含版本特化语法指导、使用注意事项、命令链接语法等。

> 源码位置：`prompt.ts:73-145`

## 接口/类型定义

### `CommandSemantic`

```typescript
type CommandSemantic = (
  exitCode: number,
  stdout: string,
  stderr: string,
) => { isError: boolean; message?: string }
```

退出码语义解释函数类型。接收退出码和标准输出/错误，返回是否为错误及可选的人类可读消息。

> 源码位置：`commandSemantics.ts:20-27`

### `PowerShellProgress`

进度更新数据结构（类型定义在 `src/types/tools.ts`，在 `PowerShellTool.tsx:259-260` 重导出），包含 `output`、`fullOutput`、`elapsedTimeSeconds`、`totalLines`、`totalBytes`、`timeoutMs`、`taskId` 等字段。

## commandSemantics：退出码语义解释

`commandSemantics.ts` 解决了一个关键问题：PowerShell 中调用的外部可执行文件（非 PowerShell 原生 cmdlet）使用非零退出码传递信息而非表示失败。

**已注册的命令语义**（`commandSemantics.ts:62-94`）：

| 命令 | 退出码含义 |
|------|-----------|
| `grep` / `rg` | 0=有匹配，1=无匹配，2+=错误 |
| `findstr` | 同 grep 语义 |
| `robocopy` | 0-7=成功（位域），8+=错误。exit 1="文件已复制"，exit 0="已同步" |

**故意排除的命令**：`diff`（5.1 别名为 Compare-Object，PS Core 可能解析为 diff.exe）、`fc`（5.1 别名为 Format-Custom）、`find`（Windows find.exe vs Unix find.exe 语义不同）。

**命令提取逻辑**：`heuristicallyExtractBaseCommand` 对命令行按 `;` 和 `|` 分割，取最后一段（因为管道最后一段决定退出码），剥离 `&`/`.` 调用运算符和 `.exe` 后缀后小写化查表（`commandSemantics.ts:100-125`）。

## prompt.ts：版本感知的提示词生成

`prompt.ts` 根据检测到的 PowerShell 版本生成差异化的语法指导（`prompt.ts:51-71`）：

| 版本 | 关键差异 |
|------|---------|
| **Desktop（5.1）** | 无 `&&`/`||`，无三元/空合并运算符，`2>&1` 会包裹 ErrorRecord，默认 UTF-16 LE 编码 |
| **Core（7+）** | 支持 `&&`/`||`、三元、空合并、空条件运算符，默认 UTF-8 无 BOM |
| **未知** | 按 5.1 保守策略 |

提示词还包含：PowerShell 语法要点（变量前缀、转义字符、here-string 格式）、交互命令禁止列表（`Read-Host`、`Get-Credential` 等）、后台运行指引和 sleep 使用规范。

## UI.tsx：React/Ink 渲染组件

`UI.tsx` 导出 5 个渲染函数，全部遵循 Tool 接口规范（`UI.tsx:19-130`）：

| 函数 | 职责 |
|------|------|
| `renderToolUseMessage` | 渲染命令文本，非 verbose 模式下截断至 2 行/160 字符 |
| `renderToolUseProgressMessage` | 渲染执行中进度，委托 `ShellProgressMessage` 组件显示输出、耗时、行数等 |
| `renderToolUseQueuedMessage` | 渲染排队等待状态（"Waiting…"）|
| `renderToolResultMessage` | 渲染执行结果——区分图片数据、stdout/stderr、后台运行、中断、语义退出码等 6 种状态 |
| `renderToolUseErrorMessage` | 渲染错误信息，委托 `FallbackToolUseErrorMessage` |

结果渲染的状态优先级：图片数据 → stdout/stderr → 后台运行提示（含键盘快捷键 ↓）→ 中断提示 → 语义退出码解释 → "(No output)"。

## toolName.ts：循环依赖破解

```typescript
export const POWERSHELL_TOOL_NAME = 'PowerShell' as const
```

独立为单文件（`toolName.ts:1-2`），是因为 `prompt.ts` 需要引用工具名称，而 `PowerShellTool.tsx` 又导入 `prompt.ts`。如果名称定义在 `PowerShellTool.tsx` 中，`prompt.ts → PowerShellTool.tsx` 会形成循环依赖。

## 边界 Case 与注意事项

- **pwsh 未安装**：`runPowerShellCommand` 返回 `code: 0` + stderr 提示而非抛异常，确保 `call()` 不会因 `ShellError` 误报退出码（`PowerShellTool.tsx:718-728`）
- **exec 失败**：同样返回 `code: 0` + stderr，与 BashTool 的 `createFailedCommand(code: 1)` 策略不同，这导致需要 `isPreFlightSentinel` 守卫防止 `trackGitOperations` 误计未执行的命令（`PowerShellTool.tsx:502-505`）
- **大输出持久化**：超过 `getMaxOutputLength()` 的输出写入磁盘文件。超过 64MB 时先截断再硬链接/复制到 tool-results 目录（`PowerShellTool.tsx:596-617`）
- **EOL 处理**：强制使用 `\n` 而非 `os.EOL`——Windows 的 `\r\n` 会破坏 Ink 终端渲染（`PowerShellTool.tsx:48`）
- **`isReadOnly` 限制**：同步的 `Tool.isReadOnly()` 接口无法执行异步 AST 解析，因此对多命令管道只能保守返回 `false`。真正的只读自动放行发生在异步的 `powershellToolHasPermission` 中（`PowerShellTool.tsx:300-316`）
- **后台化竞态**：后台化定时器触发但命令恰好完成时，通过 `markTaskNotified` 抑制重复通知，并清理 `backgroundTaskId` 确保模型看到完整的命令结果（`PowerShellTool.tsx:886-908`）