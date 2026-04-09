# ShellCommand — Shell 命令解析与安全分析

## 概述与职责

`codex-shell-command` 是 Codex 工具系统（ToolSystem）中的基础设施 crate，负责**解析 shell 命令字符串**并**判断命令的安全等级**。它是 Codex 工具审批流水线的核心依赖：当 AI Agent 请求执行一条 shell 命令时，系统需要先回答两个问题——"这条命令到底在做什么？"以及"可以自动放行还是需要用户确认？"——这两个问题的答案都由本模块提供。

在整体架构中，`codex-shell-command` 被 ToolSystem 和 Sandbox 等多个上层 crate 引用。它的同级兄弟模块包括 shell 执行工具（apply-patch、file-search 等）和 MCP 工具桥接层。

模块主要包含四个子系统：

1. **Bash 解析器**（`bash.rs`）：基于 tree-sitter-bash 的结构化命令解析
2. **PowerShell 解析器**（`powershell.rs`）：PowerShell 命令提取与可执行文件发现
3. **命令安全分类**（`command_safety/`）：安全/危险命令的判定引擎
4. **命令元数据提取**（`parse_command.rs`）：将原始命令解析为 `ParsedCommand` 枚举，提供人类可读的命令摘要

## 关键流程

### 1. 命令安全判定流程

当工具审批流水线收到一条命令 `["bash", "-lc", "git status && ls"]` 时，安全判定分两条路径同时进行：

**安全命令判定（`is_known_safe_command`）**：

1. 将 `zsh` 统一映射为 `bash` 以简化匹配（`is_safe_command.rs:11-19`）
2. 首先检查 Windows 专用安全列表 `is_safe_command_windows()`
3. 尝试将命令作为直接可执行命令检查 `is_safe_to_call_with_exec()`
4. 如果是 `bash -lc "..."` 形式，调用 `parse_shell_lc_plain_commands()` 将脚本拆解为多个简单命令
5. 验证**每一个**子命令都在安全列表中——只有全部通过，复合命令才被判定为安全

**危险命令判定（`command_might_be_dangerous`）**：

1. 在 Windows 上首先检查 Windows 专用危险列表（URL 打开、force delete 等）
2. 检查直接执行时是否危险（如 `rm -rf`、`sudo rm -f`）
3. 如果是 `bash -lc "..."` 形式，拆解脚本后检查**任意一个**子命令是否危险——只要一个危险，整体即为危险

### 2. Bash 脚本解析流程

`bash.rs` 使用 tree-sitter-bash 进行结构化解析：

1. `try_parse_shell()` 使用 tree-sitter-bash 语法将脚本解析为 AST（`bash.rs:13-20`）
2. `try_parse_word_only_commands_sequence()` 遍历 AST，只允许预定义的安全节点类型（`program`、`list`、`pipeline`、`command`、`word`、`string` 等）和安全操作符（`&&`、`||`、`;`、`|`）
3. 遇到括号、重定向、变量替换、命令替换等结构时立即返回 `None`，拒绝解析
4. 成功时返回 `Vec<Vec<String>>`——每个子命令的参数列表

这种保守的解析策略确保了只有能被完全理解的简单命令才会进入安全白名单匹配。

### 3. PowerShell 命令安全判定流程（Windows）

Windows 环境下，安全判定使用了一个**长驻 PowerShell 子进程**进行真实的 AST 解析：

1. `windows_safe_commands.rs` 提取 PowerShell 可执行文件和脚本内容
2. 将脚本发送到 `powershell_parser.rs` 维护的缓存子进程
3. 子进程运行 `powershell_parser.ps1`（通过 `include_str!` 内嵌），使用 `System.Management.Automation.Language.Parser` 进行真实的 PowerShell AST 解析
4. 解析结果通过 JSON 协议返回（请求/响应各占一行，脚本以 UTF-16LE base64 编码传输）
5. 回到 Rust 侧后，对解析出的每个命令单独进行安全白名单匹配

### 4. 命令元数据提取流程

`parse_command()` 将任意命令解析为语义化的 `ParsedCommand` 枚举，用于向用户展示命令摘要：

1. 标准化 token：去除 `yes |` 前缀、展开 `bash -lc "..."` 包装
2. 按连接符（`&&`、`||`、`|`、`;`）拆分为独立的命令段
3. 追踪 `cd` 命令以计算相对路径
4. 对每个命令段调用 `summarize_main_tokens()` 进行模式匹配，识别出 `Search`、`Read`、`ListFiles` 或 `Unknown` 类型
5. 反复执行 `simplify_once()` 化简，去除无意义的 `echo`、`true`、`nl -ba` 等辅助命令
6. 去重连续相同的命令，若存在任何 `Unknown` 段则将整条命令合并为单个 `Unknown`

## 函数签名与参数说明

### 公开 API

#### `is_safe_command::is_known_safe_command(command: &[String]) -> bool`

判断命令是否可以自动放行（无需用户确认）。支持直接命令和 `bash -lc "..."` 包装。

> 源码位置：`src/command_safety/is_safe_command.rs:10`

#### `is_dangerous_command::command_might_be_dangerous(command: &[String]) -> bool`

判断命令是否应被标记为危险（需要额外警告）。检测 `rm -rf`、`sudo` 包装、URL 打开等模式。

> 源码位置：`src/command_safety/is_dangerous_command.rs:7`

#### `parse_command::parse_command(command: &[String]) -> Vec<ParsedCommand>`

将命令解析为语义化的 `ParsedCommand` 枚举列表，用于生成人类可读的命令摘要。返回值会进行去重和化简处理。

> 源码位置：`src/parse_command.rs:30`

#### `bash::try_parse_shell(shell_lc_arg: &str) -> Option<Tree>`

使用 tree-sitter-bash 解析 bash 脚本，返回语法树。

> 源码位置：`src/bash.rs:13`

#### `bash::parse_shell_lc_plain_commands(command: &[String]) -> Option<Vec<Vec<String>>>`

解析 `bash -lc "..."` 或 `zsh -lc "..."` 形式的命令，仅当脚本完全由安全操作符连接的简单命令组成时返回 `Some`。

> 源码位置：`src/bash.rs:115`

#### `bash::extract_bash_command(command: &[String]) -> Option<(&str, &str)>`

从 `[shell, flag, script]` 格式中提取 shell 名称和脚本内容。接受 `bash`/`zsh`/`sh` 配合 `-c`/`-lc` 标志。

> 源码位置：`src/bash.rs:97`

#### `powershell::extract_powershell_command(command: &[String]) -> Option<(&str, &str)>`

从 PowerShell 调用中提取可执行文件名和脚本内容。识别 `pwsh`/`powershell` 及 `-Command`/`-c` 标志。

> 源码位置：`src/powershell.rs:41`

#### `powershell::prefix_powershell_script_with_utf8(command: &[String]) -> Vec<String>`

为 PowerShell 脚本添加 UTF-8 输出编码前缀，确保控制台输出使用 UTF-8。

> 源码位置：`src/powershell.rs:13`

## 接口/类型定义

### `ShellType`（内部枚举）

```rust
enum ShellType { Zsh, Bash, PowerShell, Sh, Cmd }
```

标识检测到的 shell 类型，用于路由解析逻辑。

> 源码位置：`src/shell_detect.rs:4-10`

### `PowershellParseOutcome`（内部枚举）

```rust
enum PowershellParseOutcome {
    Commands(Vec<Vec<String>>),  // 成功解析出命令列表
    Unsupported,                  // 解析成功但包含不支持的结构
    Failed,                       // 解析失败
}
```

PowerShell AST 解析的三种结果。`Unsupported` 与 `Failed` 在安全判定中都被视为"不安全"。

> 源码位置：`src/command_safety/powershell_parser.rs:37-42`

## 安全白名单与黑名单

### Unix 安全命令白名单

以下命令被无条件视为安全（`is_safe_command.rs:56-80`）：

`cat`、`cd`、`cut`、`echo`、`expr`、`false`、`grep`、`head`、`id`、`ls`、`nl`、`paste`、`pwd`、`rev`、`seq`、`stat`、`tail`、`tr`、`true`、`uname`、`uniq`、`wc`、`which`、`whoami`

Linux 额外安全：`numfmt`、`tac`

### 条件安全命令

| 命令 | 条件 | 被拒绝的标志 |
|------|------|-------------|
| `base64` | 不能有输出重定向 | `-o`、`--output` |
| `find` | 不能有执行/删除/写入选项 | `-exec`、`-execdir`、`-ok`、`-okdir`、`-delete`、`-fls`、`-fprint` 等 |
| `rg` | 不能有外部命令调用 | `--pre`、`--hostname-bin`、`--search-zip`、`-z` |
| `git` | 仅允许只读子命令+只读标志 | `--output`、`--ext-diff`、`--exec`；全局选项如 `-c`、`--git-dir` 等 |
| `sed` | 仅允许 `sed -n Np` 或 `sed -n M,Np` 格式 | 其他所有形式 |

### Windows PowerShell 安全白名单（`windows_safe_commands.rs:179-206`）

`echo`/`Write-Output`/`Write-Host`、`dir`/`ls`/`Get-ChildItem`、`cat`/`Get-Content`、`Select-String`、`Measure-Object`、`Get-Location`/`pwd`、`Test-Path`、`Resolve-Path`、`Select-Object`、`Get-Item`、`git`（只读子命令）、`rg`（无危险标志）

### 危险命令检测

**Unix**（`is_dangerous_command.rs:153-165`）：
- `rm -f` 或 `rm -rf`
- `sudo` + 任何危险命令（递归检查）

**Windows**（`windows_dangerous_commands.rs`）：
- URL 打开：`Start-Process`/`Invoke-Item` + URL、`cmd /c start` + URL、浏览器/explorer + URL
- ShellExecute 调用：`rundll32 url.dll,FileProtocolHandler`、`mshta` + URL
- Force delete：`Remove-Item -Force`、`del /f`、`erase /f`、`rd /s /q`、`rmdir /s /q`

## 配置项与默认值

本模块没有外部配置文件或环境变量。所有安全列表和危险列表都以常量形式硬编码在源码中。

PowerShell UTF-8 输出前缀为固定值：
```
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
```

> 源码位置：`src/powershell.rs:11`

## 边界 Case 与注意事项

- **zsh 被映射为 bash**：安全检查中 `zsh` 会被统一替换为 `bash` 处理（`is_safe_command.rs:12-18`），这意味着两者共享相同的安全规则
- **shell 脚本只认三参数形式**：只有 `[shell, flag, script]` 恰好三个元素才会被识别为 shell 包装。四参数形式 `["bash", "-lc", "git", "status"]` 会被拒绝（`bash.rs:98`）
- **保守拒绝策略**：bash 解析器遇到任何不在白名单中的 AST 节点（括号、重定向、变量替换等）都会返回 `None`，进而导致命令不被自动放行
- **PowerShell 解析器进程缓存**：每个 PowerShell 可执行文件变体（`pwsh.exe` vs `powershell.exe`）维护一个独立的长驻子进程，通过 `LazyLock<Mutex<HashMap>>` 全局缓存（`powershell_parser.rs:28-29`）。子进程异常退出时会自动重启一次
- **Git 全局选项攻击防护**：`-c`、`--git-dir`、`--exec-path`、`--namespace`、`--config-env` 等 git 全局选项会重定向配置/仓库/helper 查找路径，可能导致执行恶意代码，因此即使子命令是只读的也会被拒绝（`is_dangerous_command.rs:58-77`）
- **`parse_command` 的有损性**：命令元数据提取是有损的——它旨在生成人类可读的摘要而非精确重建，源码注释中明确提到了这一点（`parse_command.rs:28-29`）
- **双引号中的变量展开被拒绝**：`"$HOME"` 或 `"${USER}"` 形式的字符串会导致 bash 解析器返回 `None`，因为变量展开使得静态分析无法确定实际值