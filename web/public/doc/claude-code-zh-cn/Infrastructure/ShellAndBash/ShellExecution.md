# Shell 执行与子进程生命周期管理

## 概述与职责

ShellExecution 模块是 Claude Code 基础设施层中 **ShellAndBash** 子系统的核心组件，负责子进程的创建、执行、超时管理、后台化和清理。它由三个文件组成：

- **Shell.ts** — 入口层：Shell 选择（`findSuitableShell`）、命令执行（`exec`）、工作目录管理（`setCwd`）
- **ShellCommand.ts** — 子进程包装层：定义 `ShellCommand` 类型，封装流式输出收集、超时处理、后台化、磁盘输出溢出监控
- **shellConfig.ts** — Shell 配置文件管理：在 `.bashrc`/`.zshrc`/`config.fish` 中安装和清理 `claude` alias

在整体架构中，本模块位于 Infrastructure → ShellAndBash 层，被上层的 Git 操作、Bash 工具、任务系统等模块调用，是所有外部命令执行的统一出口。

---

## 关键流程

### 1. Shell 选择流程（`findSuitableShell`）

Shell 选择遵循一个优先级递降的搜索策略（`src/utils/Shell.ts:73-137`）：

1. **环境变量覆盖**：检查 `CLAUDE_CODE_SHELL`，若存在且为有效的 bash/zsh 路径则直接使用
2. **用户偏好 Shell**：读取 `SHELL` 环境变量，判断用户偏好 bash 还是 zsh
3. **路径探测**：通过 `which` 命令查找 `zsh` 和 `bash` 的实际路径
4. **候选列表构建**：以 `/bin`、`/usr/bin`、`/usr/local/bin`、`/opt/homebrew/bin` 为搜索路径，按用户偏好排序
5. **可执行性校验**：依次调用 `isExecutable()` 检查每个候选路径，优先使用 `accessSync(X_OK)`，失败则回退到实际执行 `--version` 验证（兼容 Nix 等特殊环境）
6. **兜底错误**：所有候选均不可用时抛出错误

该结果通过 `memoize` 缓存，每个会话只执行一次。

### 2. 命令执行流程（`exec`）

`exec` 是所有 Shell 命令执行的统一入口（`src/utils/Shell.ts:181-442`），流程如下：

1. **解析选项**：提取 timeout（默认 30 分钟）、进度回调、沙箱配置等
2. **获取 ShellProvider**：根据 `shellType`（bash 或 powershell）获取对应的 Provider
3. **构建命令字符串**：调用 `provider.buildExecCommand()` 构建完整命令，同时生成 cwd 追踪临时文件路径
4. **CWD 恢复**：检查当前工作目录是否仍然存在，不存在时回退到原始 CWD
5. **中止检查**：如果 `abortSignal` 已触发，直接返回 `AbortedShellCommand`
6. **沙箱包装**（可选）：调用 `SandboxManager.wrapWithSandbox()` 将命令包入沙箱
7. **输出模式选择**：
   - **文件模式**（默认）：打开文件描述符，stdout/stderr 直接写入磁盘文件，无 JS 中间处理
   - **管道模式**（有 `onStdout` 回调时）：使用 `pipe`，通过 `StreamWrapper` 实时转发数据
8. **spawn 子进程**：设置环境变量（`GIT_EDITOR=true`、`CLAUDECODE=1` 等），创建子进程
9. **包装为 ShellCommand**：调用 `wrapSpawn()` 将 `ChildProcess` 包装为带超时、后台化能力的 `ShellCommand`
10. **CWD 追踪**：命令完成后从临时文件读取新 CWD，如有变化则更新全局状态

### 3. 子进程生命周期（ShellCommandImpl）

`ShellCommandImpl`（`src/utils/ShellCommand.ts:114-382`）管理子进程从创建到清理的完整生命周期：

**状态机**：`running` → `backgrounded` | `completed` | `killed`

**超时处理**：
- 创建时启动 `setTimeout`（默认 30 分钟）
- 超时触发时：若启用了 `shouldAutoBackground`，调用 `onTimeoutCallback` 让调用方决定是否后台化；否则直接 SIGTERM 杀死进程

**后台化**（`background()`）：
- 将状态切为 `backgrounded`，清除超时定时器
- 文件模式下启动 **磁盘大小看门狗**（每 5 秒轮询文件大小），超过 `MAX_TASK_OUTPUT_BYTES` 时 SIGKILL 杀死进程——防止磁盘被填满（文档提到此前发生过 768GB 的事故）
- 管道模式下将内存缓冲区 spill 到磁盘

**中止处理**：
- 监听 `abortSignal` 的 `abort` 事件
- 特殊逻辑：如果中止原因是 `'interrupt'`（用户提交新消息），不杀死进程而是让调用方后台化它

**退出处理**（`#handleExit`）：
- 收集 stdout/stderr
- 小文件直接内联返回，大文件返回磁盘路径（`outputFilePath`）
- 被大小看门狗杀死或超时杀死时，附加对应的 stderr 信息

---

## 函数签名与参数说明

### `findSuitableShell(): Promise<string>`

查找最合适的 Shell 可执行文件路径。仅支持 bash 和 zsh。

> 源码位置：`src/utils/Shell.ts:73-137`

### `getShellConfig(): Promise<ShellConfig>`

获取（带缓存的）Shell 配置，包含 `ShellProvider` 实例。每个会话只初始化一次。

> 源码位置：`src/utils/Shell.ts:139-146`

### `exec(command, abortSignal, shellType, options?): Promise<ShellCommand>`

执行 Shell 命令的核心函数。

| 参数 | 类型 | 说明 |
|------|------|------|
| `command` | `string` | 要执行的命令字符串 |
| `abortSignal` | `AbortSignal` | 用于取消执行的中止信号 |
| `shellType` | `ShellType` | `'bash'` 或 `'powershell'` |
| `options` | `ExecOptions` | 可选配置（见下方） |

> 源码位置：`src/utils/Shell.ts:181-442`

### `setCwd(path, relativeTo?): void`

设置当前工作目录，解析符号链接以匹配 `pwd -P` 的行为。

> 源码位置：`src/utils/Shell.ts:447-474`

### `wrapSpawn(childProcess, abortSignal, timeout, taskOutput, shouldAutoBackground?, maxOutputBytes?): ShellCommand`

将 `ChildProcess` 包装为 `ShellCommand`，附加超时、中止、后台化能力。

> 源码位置：`src/utils/ShellCommand.ts:387-403`

### `createAbortedCommand(backgroundTaskId?, opts?): ShellCommand`

创建一个表示"执行前已中止"的静态 `ShellCommand`。

> 源码位置：`src/utils/ShellCommand.ts:437-445`

### `createFailedCommand(preSpawnError): ShellCommand`

创建一个表示"spawn 前就失败"的静态 `ShellCommand`（如工作目录已删除）。

> 源码位置：`src/utils/ShellCommand.ts:447-465`

---

## 接口与类型定义

### `ExecResult`

命令执行结果（`src/utils/ShellCommand.ts:13-30`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `stdout` | `string` | 标准输出内容 |
| `stderr` | `string` | 标准错误内容 |
| `code` | `number` | 退出码 |
| `interrupted` | `boolean` | 是否被 SIGKILL 中断 |
| `backgroundTaskId?` | `string` | 后台任务 ID |
| `backgroundedByUser?` | `boolean` | 是否由用户主动后台化 |
| `assistantAutoBackgrounded?` | `boolean` | 是否由助手模式自动后台化 |
| `outputFilePath?` | `string` | 输出过大时的磁盘文件路径 |
| `outputFileSize?` | `number` | 输出文件大小（字节） |
| `outputTaskId?` | `string` | 关联的任务 ID |
| `preSpawnError?` | `string` | spawn 前的错误信息 |

### `ShellCommand`

子进程包装接口（`src/utils/ShellCommand.ts:32-47`）：

| 成员 | 类型 | 说明 |
|------|------|------|
| `result` | `Promise<ExecResult>` | 命令完成的 Promise |
| `status` | `'running' \| 'backgrounded' \| 'completed' \| 'killed'` | 当前状态 |
| `background(taskId)` | `(string) => boolean` | 将命令转为后台运行 |
| `kill()` | `() => void` | 杀死进程树 |
| `cleanup()` | `() => void` | 清理流资源，防止内存泄漏 |
| `onTimeout?` | 回调注册 | 超时时触发，支持自动后台化决策 |
| `taskOutput` | `TaskOutput` | 管理所有 stdout/stderr 数据的实例 |

### `ExecOptions`

执行选项（`src/utils/Shell.ts:161-175`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `timeout?` | `number` | 超时时间（毫秒），默认 30 分钟 |
| `onProgress?` | 回调函数 | 接收最新输出行、全部行、总行数、总字节数、是否截断 |
| `preventCwdChanges?` | `boolean` | 阻止命令改变工作目录 |
| `shouldUseSandbox?` | `boolean` | 是否在沙箱中运行 |
| `shouldAutoBackground?` | `boolean` | 是否允许超时自动后台化 |
| `onStdout?` | `(data: string) => void` | 实时 stdout 回调，启用管道模式 |

---

## Shell 配置文件管理（shellConfig.ts）

`shellConfig.ts`（`src/utils/shellConfig.ts`）提供 Shell 配置文件（`.bashrc`、`.zshrc`、`config.fish`）中 `claude` alias 的管理能力：

### `getShellConfigPaths(options?): Record<string, string>`

返回各 Shell 的配置文件路径。zsh 尊重 `ZDOTDIR` 环境变量。

> 源码位置：`src/utils/shellConfig.ts:26-37`

### `filterClaudeAliases(lines): { filtered, hadAlias }`

从文件内容中过滤掉由安装器创建的 `claude` alias 行。**仅移除指向 `$HOME/.claude/local/claude` 的 alias**，保留用户自定义的 alias。使用正则 `CLAUDE_ALIAS_REGEX`（`/^\s*alias\s+claude\s*=/`）匹配。

> 源码位置：`src/utils/shellConfig.ts:45-75`

### `findClaudeAlias(options?): Promise<string | null>`

在所有 Shell 配置文件中搜索 `claude` alias，返回第一个找到的 alias 目标路径。

> 源码位置：`src/utils/shellConfig.ts:114-135`

### `findValidClaudeAlias(options?): Promise<string | null>`

在 `findClaudeAlias` 基础上额外验证 alias 目标文件是否存在且为可执行文件。

> 源码位置：`src/utils/shellConfig.ts:142-167`

---

## 配置项与默认值

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `DEFAULT_TIMEOUT` | 30 分钟 (1,800,000 ms) | 命令执行超时时间 |
| `SIZE_WATCHDOG_INTERVAL_MS` | 5,000 ms | 后台任务输出文件大小轮询间隔 |
| `MAX_TASK_OUTPUT_BYTES` | 由 `diskOutput.ts` 定义 | 后台任务输出文件大小上限，超出即 SIGKILL |
| `CLAUDE_CODE_SHELL` | 无 | 环境变量，强制指定 Shell 路径 |
| `CLAUDE_CODE_TMPDIR` | `/tmp` | 环境变量，沙箱临时目录基路径 |
| `ZDOTDIR` | `$HOME` | 环境变量，zsh 配置目录覆盖 |
| `SIGKILL` 退出码 | 137 | 被 SIGKILL 杀死的标准退出码 |
| `SIGTERM` 退出码 | 143 | 超时 SIGTERM 杀死的退出码 |

---

## 边界 Case 与注意事项

1. **CWD 不存在恢复**：如果命令执行时发现当前工作目录已被删除（如临时目录清理），会自动回退到原始 CWD（`getOriginalCwd()`）。若原始 CWD 也不存在，返回 `createFailedCommand` 而不是崩溃（`src/utils/Shell.ts:220-238`）。

2. **文件模式 vs 管道模式**：默认使用文件模式（stdout/stderr 直接写入磁盘 fd），仅当提供 `onStdout` 回调时切换到管道模式。文件模式利用 `O_APPEND` 的原子性保证 stdout/stderr 按时间顺序交错而不撕裂。Windows 上使用 `'w'` 模式而非 `'a'` 以避免 MSYS2/Cygwin 的 `FILE_WRITE_DATA` 权限问题（`src/utils/Shell.ts:289-313`）。

3. **安全性：O_NOFOLLOW**：打开输出文件时使用 `O_NOFOLLOW` 标志防止沙箱中的符号链接攻击。

4. **中止信号的 interrupt 语义**：当 `abortSignal.reason === 'interrupt'` 时（用户提交新消息），不杀死进程而是让调用方后台化——确保模型能看到部分输出（`src/utils/ShellCommand.ts:186-193`）。

5. **磁盘大小看门狗**：后台化文件模式命令后启动大小看门狗（5 秒轮询），防止无限输出填满磁盘。注释中提到此前曾发生 768GB 的磁盘填满事故（`src/utils/ShellCommand.ts:239-261`）。

6. **进程树杀死**：使用 `tree-kill` 库杀死整个进程树（包括孙子进程），而非仅杀死直接子进程（`src/utils/ShellCommand.ts:339-341`）。

7. **PowerShell 沙箱兼容**：沙箱模式下的 PowerShell 使用特殊处理——命令预编码为 Base64（`-EncodedCommand`），沙箱内壳使用 `/bin/sh` 而非 `pwsh`，避免 profile 加载导致的延迟或挂起（`src/utils/Shell.ts:247-257`）。

8. **alias 过滤精确性**：`filterClaudeAliases` 仅移除指向安装器路径的 alias，用户自定义的 `alias claude=xxx` 会被保留（`src/utils/shellConfig.ts:63-68`）。

9. **CWD 同步使用 readFileSync**：命令完成后读取新 CWD 时故意使用同步 API（`readFileSync`），确保 `await shellCommand.result` 的调用方在同一个微任务中就能看到更新后的 CWD（`src/utils/Shell.ts:370-375`）。

10. **Unicode 规范化**：macOS APFS 上 `pwd -P` 可能返回 NFD 编码的路径，代码在比较前进行 NFC 规范化，避免每次命令都误判为 CWD 变更（`src/utils/Shell.ts:403-406`）。