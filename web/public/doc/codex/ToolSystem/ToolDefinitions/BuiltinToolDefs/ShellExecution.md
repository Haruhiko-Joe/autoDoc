# Shell 执行工具定义（ShellExecution）

## 概述与职责

`local_tool.rs` 是 BuiltinToolDefs 模块中负责 **Shell 和命令执行类工具定义** 的工厂模块。它位于 ToolSystem → ToolDefinitions → BuiltinToolDefs 层级下，与 agent_tool、apply_patch_tool、code_mode 等兄弟模块并列，共同组成 Codex 内置工具的完整定义集合。

该模块不执行任何命令——它只负责 **构建工具的 JSON Schema 定义**（`ToolSpec`），这些定义最终通过 RegistryPlan 注册到工具系统中，供 LLM 以函数调用方式使用。

模块提供以下 5 个公开工厂函数和 2 个配置结构体，覆盖了 PTY 命令执行、会话交互、数组式 Shell 调用、字符串式 Shell 命令和权限请求等场景。

## 配置结构体

### `CommandToolOptions`

控制 `exec_command` 和 `shell_command` 工具的行为开关（`local_tool.rs:8-12`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `allow_login_shell` | `bool` | 是否允许 LLM 控制 login shell 语义（`-l/-i`） |
| `exec_permission_approvals_enabled` | `bool` | 是否启用细粒度权限审批参数 |

### `ShellToolOptions`

控制 `shell` 工具的行为开关（`local_tool.rs:14-17`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `exec_permission_approvals_enabled` | `bool` | 是否启用细粒度权限审批参数 |

## 工厂函数总览

| 函数 | 产出工具名 | 核心用途 |
|------|-----------|---------|
| `create_exec_command_tool` | `exec_command` | PTY 命令执行，支持 login shell、TTY、yield 和 token 限制 |
| `create_write_stdin_tool` | `write_stdin` | 向已运行的 exec 会话写入输入并读取输出 |
| `create_shell_tool` | `shell` | 数组式命令执行（`execvp` 语义） |
| `create_shell_command_tool` | `shell_command` | 字符串式 Shell 脚本执行 |
| `create_request_permissions_tool` | `request_permissions` | 请求额外的文件系统或网络权限 |

## 关键流程

### exec_command 工具构建流程

`create_exec_command_tool(options)` 是最复杂的工厂函数（`local_tool.rs:19-105`），构建过程如下：

1. **基础参数定义**：创建 `BTreeMap` 包含 6 个核心参数——`cmd`（必填，Shell 命令字符串）、`workdir`（工作目录）、`shell`（Shell 二进制路径）、`tty`（是否分配 TTY）、`yield_time_ms`（输出等待超时）、`max_output_tokens`（输出 token 上限）
2. **条件参数注入**：若 `options.allow_login_shell` 为 true，额外插入 `login` 布尔参数（控制 `-l/-i` 语义，默认 true）
3. **审批参数扩展**：调用 `create_approval_parameters()` 注入 `sandbox_permissions`、`justification`、`prefix_rule` 等权限相关参数
4. **平台适配描述**：通过 `cfg!(windows)` 条件编译，Windows 上追加破坏性文件系统操作的安全指引
5. **组装 ToolSpec**：构建 `ResponsesApiTool` 并包装为 `ToolSpec::Function`，设置 `output_schema` 为统一的 exec 输出 schema

### shell 与 shell_command 的区别

这两个工具提供不同粒度的命令执行方式：

- **`shell`**（`local_tool.rs:156-217`）：`command` 参数是 **字符串数组**（`JsonSchema::Array`），对应 `execvp()` 语义。LLM 需要显式指定可执行文件和参数，例如 `["bash", "-lc", "ls"]`。还支持 `timeout_ms` 参数
- **`shell_command`**（`local_tool.rs:219-291`）：`command` 参数是 **单个字符串**（`JsonSchema::String`），作为脚本传给用户默认 Shell 执行。支持与 `exec_command` 相同的 `login` 条件参数

两者在 Windows 上都提供丰富的 PowerShell 用法示例（如 `Get-ChildItem`、`Select-String`、`Get-Process` 等），并追加破坏性操作安全指引。

### write_stdin 会话交互

`create_write_stdin_tool()`（`local_tool.rs:107-154`）生成的 `write_stdin` 工具用于与 `exec_command` 创建的长时间运行会话交互：

1. 通过 `session_id`（必填）定位目标会话
2. 通过 `chars` 参数发送输入（可为空以仅轮询输出）
3. 与 `exec_command` 共享相同的 `yield_time_ms` 和 `max_output_tokens` 控制参数
4. 使用相同的 `unified_exec_output_schema()` 作为输出格式

### 权限审批机制

模块实现了两层权限控制：

**内联审批参数**（`create_approval_parameters`，`local_tool.rs:360-411`）：注入到 `exec_command`、`shell`、`shell_command` 的参数列表中，让 LLM 在调用命令时声明所需的沙箱权限级别：
- `sandbox_permissions`：权限模式选择——`use_default`（默认）、`with_additional_permissions`（请求额外权限，仅在 `exec_permission_approvals_enabled` 时可用）、`require_escalated`（请求脱离沙箱）
- `justification`：仅在 `require_escalated` 时填写，向用户解释为何需要提权
- `prefix_rule`：建议的命令前缀模式（如 `["git", "pull"]`），用于未来自动放行类似命令
- `additional_permissions`：仅在 `exec_permission_approvals_enabled` 时出现，包含 `permission_profile_schema` 定义的细粒度权限

**独立权限请求工具**（`create_request_permissions_tool`，`local_tool.rs:293-319`）：生成独立的 `request_permissions` 工具，允许 LLM 在执行命令前预先请求权限。参数包括 `reason`（原因说明）和 `permissions`（权限配置）。

### 权限配置 Schema

`permission_profile_schema()`（`local_tool.rs:413-422`）定义了统一的权限配置结构：

```
permissions
├── network
│   └── enabled: bool        // 是否请求网络访问
└── file_system
    ├── read: string[]       // 需要读取权限的绝对路径列表
    └── write: string[]      // 需要写入权限的绝对路径列表
```

## 统一输出 Schema

`exec_command` 和 `write_stdin` 共享 `unified_exec_output_schema()`（`local_tool.rs:326-358`）定义的输出格式：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `output` | string | 是 | 命令输出文本，可能被截断 |
| `wall_time_seconds` | number | 是 | 等待输出的实际耗时（秒） |
| `exit_code` | number | 否 | 进程退出码（仅在命令执行完毕时返回） |
| `session_id` | number | 否 | 会话 ID（进程仍在运行时返回，可传给 `write_stdin`） |
| `chunk_id` | string | 否 | 分块标识符 |
| `original_token_count` | number | 否 | 截断前的近似 token 数 |

## 平台适配：Windows 安全指引

`windows_destructive_filesystem_guidance()`（`local_tool.rs:460-464`）在 Windows 平台通过 `cfg!(windows)` 条件编译追加到 `exec_command`、`shell`、`shell_command` 的工具描述中。核心规则：

1. **禁止跨 Shell 组合破坏性命令**——不得在 PowerShell 中枚举路径后传给 `cmd /c` 执行删除/移动，应端到端使用同一 Shell，优先用 `Remove-Item` / `Move-Item` 配合 `-LiteralPath`
2. **递归操作前验证路径**——执行递归删除或移动前，必须确认解析后的绝对路径在预期工作区内

## 边界 Case 与注意事项

- **`strict: false`**：所有工具均设置 `strict: false`，意味着 LLM 可以省略非必填参数而不会被拒绝
- **`shell` 工具无 `output_schema`**：`shell` 和 `shell_command` 工具不定义 `output_schema`（值为 `None`），而 `exec_command` 和 `write_stdin` 共享统一输出 schema
- **`login` 参数受控**：`login` 参数仅在 `allow_login_shell` 为 true 时才出现在工具定义中，这是一个运行时配置决策
- **`additional_permissions` 条件出现**：细粒度权限参数仅在 `exec_permission_approvals_enabled` 为 true 时注入，`sandbox_permissions` 的描述文本也会随之调整
- 模块包含单元测试（`local_tool.rs:466-468`），测试代码位于独立文件 `local_tool_tests.rs`