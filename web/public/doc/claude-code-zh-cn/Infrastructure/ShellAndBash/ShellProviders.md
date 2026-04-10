# Shell 提供者抽象层与具体实现

## 概述与职责

ShellProviders 模块是 Claude Code 执行 Shell 命令的核心抽象层，位于 Infrastructure → ShellAndBash 层级中。它定义了统一的 `ShellProvider` 接口，并提供了 Bash 和 PowerShell 两种具体实现，使上层命令执行引擎无需关心底层 Shell 差异。

该模块的核心职责包括：

- **Shell 抽象接口**：通过 `ShellProvider` 统一命令构建、进程启动参数和环境变量覆盖
- **Bash 提供者**：环境快照加载、extglob 安全禁用、tmux 隔离、stdin 重定向、pwd 追踪
- **PowerShell 提供者**：Base64 编码命令传输、exit code 精确捕获、沙箱模式适配
- **环境快照系统**：启动时捕获用户 Shell 配置（函数/别名/选项），注入内置工具覆盖（rg/bfs/ugrep）
- **辅助工具**：默认 Shell 解析、输出长度限制、PowerShell 工具启用检测

同级兄弟模块 GitOperations 通过 Shell 子进程执行 Git 命令，PermissionsAndAuth 在命令执行前进行权限校验。

## 关键流程

### Shell 命令执行全流程

1. 上层调用方选择 Shell 类型（通过 `resolveDefaultShell()` 或配置）
2. 创建对应的 `ShellProvider` 实例（`createBashShellProvider` 或 `createPowerShellProvider`）
3. 调用 `buildExecCommand()` 构建完整的命令字符串，返回 `commandString` 和 `cwdFilePath`
4. 调用 `getSpawnArgs()` 获取 spawn 参数数组（如 `['-c', '-l', cmd]`）
5. 调用 `getEnvironmentOverrides()` 获取需要注入的环境变量
6. 使用以上结果 spawn 子进程执行命令
7. 命令结束后读取 `cwdFilePath` 获取更新后的工作目录

### Bash 命令构建流程（`buildExecCommand`）

这是最核心的流程，`bashProvider.ts:77-198` 按以下顺序拼接命令链：

1. **检查快照文件可用性**：通过 `access()` 验证快照文件是否存在，不存在则回退到 login shell 模式（`:85-102`）
2. **处理 Windows 兼容性**：`rewriteWindowsNullRedirect()` 将模型可能生成的 `2>nul`（CMD 风格）重写为 POSIX 格式，避免创建名为 `nul` 的文件
3. **引用和管道处理**：`quoteShellCommand()` 安全引用命令，`rearrangePipeCommand()` 将 stdin 重定向从 `eval` 层移到管道第一个命令
4. **拼接命令链**（通过 `&&` 连接）：
   - `source <snapshot>` — 加载环境快照（`:161-167`）
   - 会话环境脚本 — 注入 session start hooks 捕获的变量（`:170-173`）
   - `shopt -u extglob` / `setopt NO_EXTENDED_GLOB` — 禁用扩展 glob 防止安全漏洞（`:176-179`）
   - `eval <quoted_command>` — 使用 eval 实现别名展开（`:184`）
   - `pwd -P >| <cwd_file>` — 记录命令执行后的物理路径（`:186`）
5. **Shell Prefix 包装**：如果设置了 `CLAUDE_CODE_SHELL_PREFIX`，用前缀脚本包装整个命令（`:190-195`）

### 环境快照创建流程（`ShellSnapshot.ts`）

`createAndSaveSnapshot()` 在 `BashShellProvider` 创建时异步执行（`:413-582`）：

1. **确定配置文件**：根据 shell 类型选择 `.zshrc` / `.bashrc` / `.profile`
2. **生成快照脚本**：
   - `source` 用户配置文件（`:363`）
   - 捕获用户定义的函数（过滤 `_` 前缀的补全函数，保留 `__` 前缀的辅助函数）（`:203-232`）
   - 捕获 shell 选项（`shopt -p` / `setopt`）（`:235-247`）
   - 捕获别名（Windows 过滤 winpty 别名）（`:249-263`）
   - 注入 Claude Code 内置工具覆盖（rg/find/grep）（`:269-340`）
   - 导出当前 PATH（`:333-337`）
3. **执行快照脚本**：通过 `execFile` 在 login shell 中运行，10 秒超时（`:456-571`）
4. **保存与清理**：快照保存到 `~/.claude/shell-snapshots/`，注册进程退出时清理回调

### PowerShell 命令构建流程

`powershellProvider.ts:35-97` 的构建策略与 Bash 显著不同：

1. **拼接 exit code 捕获逻辑**：在用户命令后追加 `$_ec` 计算逻辑，优先使用 `$LASTEXITCODE`（原生 exe 退出码），回退到 `$?`（cmdlet 结果）（`:55-66`）
2. **pwd 追踪**：`(Get-Location).Path | Out-File` 写入当前目录（`:65`）
3. **沙箱模式分支**：
   - **沙箱模式**：使用 `encodePowerShellCommand()` 将命令 Base64 编码为 UTF-16LE，通过 `-EncodedCommand` 传递，避免外层 shellquote 损坏特殊字符（`:86-93`）
   - **非沙箱模式**：直接返回 PS 命令字符串，由 `getSpawnArgs()` 添加 `-NoProfile -NonInteractive -Command` 标志（`:94, 99-101`）

## 函数签名与参数说明

### `ShellProvider` 接口（`shellProvider.ts:5-33`）

```typescript
type ShellProvider = {
  type: ShellType              // 'bash' | 'powershell'
  shellPath: string            // shell 可执行文件路径
  detached: boolean            // 子进程是否 detach（Bash: true, PowerShell: false）

  buildExecCommand(command: string, opts: {
    id: number | string        // 命令唯一标识，用于 cwd 追踪文件命名
    sandboxTmpDir?: string     // 沙箱临时目录
    useSandbox: boolean        // 是否启用沙箱
  }): Promise<{ commandString: string; cwdFilePath: string }>

  getSpawnArgs(commandString: string): string[]

  getEnvironmentOverrides(command: string): Promise<Record<string, string>>
}
```

### `createBashShellProvider(shellPath, options?)`（`bashProvider.ts:58-255`）

- **shellPath**：Shell 可执行文件路径（如 `/bin/bash`、`/bin/zsh`）
- **options.skipSnapshot**：跳过环境快照创建（用于测试等场景）
- **返回**：`Promise<ShellProvider>`

### `createPowerShellProvider(shellPath)`（`powershellProvider.ts:27-123`）

- **shellPath**：PowerShell 可执行文件路径
- **返回**：`ShellProvider`（同步创建，无快照步骤）

### `buildPowerShellArgs(cmd)`（`powershellProvider.ts:11-13`）

公共辅助函数，返回 PowerShell 标准调用参数 `['-NoProfile', '-NonInteractive', '-Command', cmd]`。同时供 hooks 系统复用。

### `resolveDefaultShell()`（`resolveDefaultShell.ts:12-14`）

从 settings 读取 `defaultShell`，默认返回 `'bash'`。即使在 Windows 上也不自动切换到 PowerShell，避免影响已有 bash hooks 的用户。

### `isPowerShellToolEnabled()`（`shellToolUtils.ts:17-22`）

运行时门控，决定 PowerShell 工具是否可用：
- 非 Windows 平台：始终返回 `false`
- Windows + Anthropic 内部用户：默认开启（可通过 `CLAUDE_CODE_USE_POWERSHELL_TOOL=0` 关闭）
- Windows + 外部用户：默认关闭（需设置 `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` 开启）

### `getMaxOutputLength()`（`outputLimits.ts:6-14`）

读取环境变量 `BASH_MAX_OUTPUT_LENGTH`，默认 30,000 字符，上限 150,000 字符。通过 `validateBoundedIntEnvVar` 做边界校验。

## 接口/类型定义

### `ShellType`（`shellProvider.ts:1-2`）

```typescript
const SHELL_TYPES = ['bash', 'powershell'] as const
type ShellType = 'bash' | 'powershell'
```

### `SHELL_TOOL_NAMES`（`shellToolUtils.ts:6`）

Shell 相关工具名称常量数组，包含 `BASH_TOOL_NAME` 和 `POWERSHELL_TOOL_NAME`，用于工具注册表的可见性控制。

## 配置项与默认值

| 配置项 | 来源 | 默认值 | 说明 |
|--------|------|--------|------|
| `BASH_MAX_OUTPUT_LENGTH` | 环境变量 | 30,000 | Shell 输出截断长度（上限 150,000） |
| `CLAUDE_CODE_USE_POWERSHELL_TOOL` | 环境变量 | `1`(ant) / `0`(外部) | PowerShell 工具开关 |
| `CLAUDE_CODE_SHELL_PREFIX` | 环境变量 | 无 | Shell 命令前缀包装脚本 |
| `settings.defaultShell` | settings.json | `'bash'` | 默认 Shell 类型 |
| `DEFAULT_HOOK_SHELL` | 常量 | `'bash'` | Hook 默认使用的 Shell |
| `SNAPSHOT_CREATION_TIMEOUT` | 常量 | 10,000ms | 快照创建超时时间 |

## 边界 Case 与注意事项

### 快照文件消失的降级处理

快照文件可能在会话中途被 tmpdir 清理删除。`buildExecCommand` 每次执行时通过 `access()` 检查快照文件是否存在（`bashProvider.ts:93-102`）。如果消失，清除 `lastSnapshotFilePath`，使 `getSpawnArgs` 自动添加 `-l` 标志切换到 login shell 模式。`source` 命令后的 `|| true` 则守护检查与实际 source 之间的竞态窗口。

### extglob 安全禁用

扩展 glob 模式（bash `extglob`、zsh `EXTENDED_GLOB`）可以被恶意文件名利用——在安全验证之后才展开。禁用命令放在 source 用户配置之后，确保覆盖用户可能开启的 extglob（`bashProvider.ts:39-56`）。当设置了 `CLAUDE_CODE_SHELL_PREFIX` 时，由于实际执行的 shell 可能与 `shellPath` 不同，会同时包含 bash 和 zsh 的禁用命令。

### PowerShell exit code 捕获的权衡

PowerShell 5.1 中，原生 exe 将 stderr 通过 PS 重定向（如 `git push 2>&1`）时会错误地设置 `$? = $false`。因此优先使用 `$LASTEXITCODE`，但这导致 `native-ok; cmdlet-fail` 场景返回 0 而非 1。这是有意的权衡——git/npm/curl 的 stderr 输出是更常见的场景（`powershellProvider.ts:55-64`）。

### Base64 编码防止引号损坏

在沙箱模式下，sandbox runtime 的 `shellquote.quote()` 会将含单引号的字符串切换到双引号模式并转义 `!$?` 为 `\!$?`，导致 PowerShell 解析失败。Base64 编码（`[A-Za-z0-9+/=]`）不包含任何会被引号层损坏的字符（`powershellProvider.ts:16-25`）。

### 内置工具覆盖策略

快照系统对 `rg`、`find`、`grep` 的覆盖策略不同（`ShellSnapshot.ts:65-179`）：
- **rg**：仅在系统无 rg 时才注入（`if ! command -v rg`），尊重用户的自定义配置
- **find/grep**：始终覆盖（当嵌入式搜索工具可用时），因为 bfs/ugrep 是 drop-in 替代且提供更一致的快速行为
- 覆盖前会先 `unalias` 对应命令，防止 macOS Homebrew 用户的 `alias find=gfind` 绕过函数定义

### Windows 特殊处理

- `rewriteWindowsNullRedirect()` 将模型生成的 `2>nul`（Windows CMD 风格）重写为 POSIX 格式，避免在 Git Bash 中创建名为 `nul` 的文件（`bashProvider.ts:127`）
- 快照创建时，Windows 环境下过滤 winpty 别名，避免无 TTY 环境下的 "stdin is not a tty" 错误（`ShellSnapshot.ts:255-256`）
- cwd 文件路径区分 POSIX 路径（Shell 内部写入用）和原生 Windows 路径（Node.js 读取用）（`bashProvider.ts:113-121`）

## 关键代码片段

### Bash 命令链拼接核心（`bashProvider.ts:156-197`）

```typescript
const commandParts: string[] = []
if (snapshotFilePath) {
  commandParts.push(`source ${quote([finalPath])} 2>/dev/null || true`)
}
const sessionEnvScript = await getSessionEnvironmentScript()
if (sessionEnvScript) { commandParts.push(sessionEnvScript) }
const disableExtglobCmd = getDisableExtglobCommand(shellPath)
if (disableExtglobCmd) { commandParts.push(disableExtglobCmd) }
commandParts.push(`eval ${quotedCommand}`)
commandParts.push(`pwd -P >| ${quote([shellCwdFilePath])}`)
let commandString = commandParts.join(' && ')
```

每个部分通过 `&&` 连接，保证前一步失败时后续不会执行。使用 `eval` 包装用户命令，使得 source 后的别名能在第二轮解析中展开。

### argv[0] 调度的 Shell 函数模板（`ShellSnapshot.ts:35-59`）

```typescript
function createArgv0ShellFunction(
  funcName: string, argv0: string, binaryPath: string, prependArgs: string[] = [],
): string {
  // Bun 二进制根据 argv[0] 分发到内嵌工具（rg/bfs/ugrep）
  // zsh/Windows 使用 ARGV0 环境变量，bash 使用 exec -a
  // 子 shell 中用 exec -a 直接替换进程，主 shell 则包裹在 () 中保护 PID
}
```

这个模板生成的 Shell 函数会根据运行环境（zsh/bash/Windows）选择不同的 argv[0] 设置方式，确保 Bun 二进制能正确识别要执行的嵌入式工具。