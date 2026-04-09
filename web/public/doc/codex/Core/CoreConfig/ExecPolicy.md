# ExecPolicy — 执行策略引擎

## 概述与职责

ExecPolicy 是 Codex 核心配置层（CoreConfig）中的**执行策略引擎**，负责决定 agent 请求执行的 shell 命令是否被允许、需要用户审批、还是直接拒绝。它是安全执行链的关键一环——在命令真正被沙箱执行之前，ExecPolicy 先对其进行策略评估。

**在系统架构中的位置**：ExecPolicy 隶属于 Core > CoreConfig 子系统。SessionEngine 和 ToolsOrchestration 在执行 shell 命令前会依赖 CoreConfig 读取执行策略。它与 Sandbox 模块协同工作：ExecPolicy 做"软策略"判断（允许/提示/禁止），Sandbox 做"硬隔离"（OS 级别的沙箱限制）。

**同级模块**包括 Protocol（类型定义）、SessionEngine（会话编排）、ToolsOrchestration（工具调度）等。

## 核心概念

ExecPolicy 的决策结果有三种：

| 决策 | 含义 |
|------|------|
| `Decision::Allow` | 自动放行，可能同时绕过沙箱 |
| `Decision::Prompt` | 需要用户审批 |
| `Decision::Forbidden` | 直接拒绝，命令不会执行 |

策略规则来源于 `.rules` 文件，这些文件分布在配置层级目录的 `rules/` 子目录中，按优先级从低到高合并。

## 关键流程

### 1. 策略加载流程

`load_exec_policy()` 是策略加载的入口（`codex-rs/core/src/exec_policy.rs:487-535`）：

1. 按 **低优先级到高优先级** 遍历 `ConfigLayerStack` 中的所有配置层
2. 对每个配置层，在其目录下查找 `rules/` 子目录
3. 调用 `collect_policy_files()` 收集该目录下所有 `.rules` 扩展名的文件，按文件名排序（`codex-rs/core/src/exec_policy.rs:829-879`）
4. 使用 `PolicyParser` 逐个解析这些文件的内容
5. 调用 `parser.build()` 构建最终的 `Policy` 对象
6. 如果 `config_stack.requirements()` 中包含额外的 `exec_policy` overlay，则通过 `merge_overlay` 合并

加载时对解析错误采用**容错策略**：`load_exec_policy_with_warning()` 会将 `ParsePolicy` 错误降级为警告，返回空策略而非中断启动（`codex-rs/core/src/exec_policy.rs:477-485`）。

### 2. 命令评估流程

`create_exec_approval_requirement_for_command()` 是命令评估的核心方法（`codex-rs/core/src/exec_policy.rs:226-310`）：

1. **解析命令**：调用 `commands_for_exec_policy()` 将原始命令（如 `["bash", "-lc", "prog1 && prog2"]`）拆解为独立子命令列表。支持两种解析模式：
   - `parse_shell_lc_plain_commands()`：解析 `bash -c` 风格的复合命令（标准模式）
   - `parse_shell_lc_single_command_prefix()`：处理含 heredoc 等复杂语法的回退模式（标记为 `used_complex_parsing`，禁止自动生成修订建议）

2. **策略匹配**：调用 `exec_policy.check_multiple_with_options()`，对每个子命令依次检查策略规则。未匹配任何规则的命令会走 fallback 逻辑（见下文）

3. **生成修订建议**：尝试通过 `derive_requested_execpolicy_amendment_from_prefix_rule()` 生成一条"如果用户批准，可以永久放行类似命令"的策略修订

4. **映射到审批要求**：根据综合决策结果生成 `ExecApprovalRequirement`：
   - `Decision::Forbidden` → `Forbidden { reason }`
   - `Decision::Prompt` → 先检查 `prompt_is_rejected_by_policy()`，若 AskForApproval 设置不允许提示则降级为 Forbidden；否则生成 `NeedsApproval`
   - `Decision::Allow` → `Skip`，如果有策略规则明确允许则同时设置 `bypass_sandbox = true`

### 3. 未匹配命令的 Fallback 决策

`render_decision_for_unmatched_command()` 处理未被任何 `.rules` 文件匹配的命令（`codex-rs/core/src/exec_policy.rs:538-628`）：

```
已知安全命令 (is_known_safe_command) → Allow
                ↓ 否
危险命令检测 (command_might_be_dangerous) 或 无沙箱保护 → 根据 approval_policy 决定 Prompt/Forbidden
                ↓ 否
根据 approval_policy + sandbox_policy 组合决策
```

关键逻辑分支：
- **`AskForApproval::Never`**：危险命令 + 沙箱显式禁用 → Allow（用户自己承担风险）；否则 → Forbidden
- **`AskForApproval::OnRequest`**：非限制沙箱 → Allow；限制沙箱中请求越权 → Prompt
- **`AskForApproval::UnlessTrusted`**：非安全命令一律 Prompt
- **Windows 特殊处理**：ReadOnly 沙箱在 Windows 上被视为无实际保护（`codex-rs/core/src/exec_policy.rs:552-553`）

### 4. 策略动态修订

当用户批准一条命令后，系统可以将该批准持久化为策略规则，以便后续类似命令自动放行。

**命令前缀规则修订** `append_amendment_and_update()`（`codex-rs/core/src/exec_policy.rs:312-352`）：
1. 获取更新锁（`update_lock`），防止并发写入
2. 调用 `blocking_append_allow_prefix_rule()` 将规则追加写入 `$CODEX_HOME/rules/default.rules` 文件
3. 检查当前内存中的策略是否已包含等效规则（避免重复）
4. 若无等效规则，克隆当前策略、添加新规则、通过 `ArcSwap` 原子替换

**网络规则修订** `append_network_rule_and_update()`（`codex-rs/core/src/exec_policy.rs:354-390`）：
- 流程类似，调用 `blocking_append_network_rule()` 持久化，然后更新内存策略

### 5. 修订建议生成逻辑

系统在评估命令时会智能生成"建议修订"，用于在用户审批界面提供"永久允许此类命令"的选项：

- **`try_derive_execpolicy_amendment_for_prompt_rules()`**（`codex-rs/core/src/exec_policy.rs:658-677`）：如果有策略规则触发了 Prompt，则不建议修订（因为修订无法覆盖显式策略）；否则取第一个启发式 Prompt 的命令作为修订建议
- **`try_derive_execpolicy_amendment_for_allow_rules()`**（`codex-rs/core/src/exec_policy.rs:682-698`）：当命令被允许但仅靠启发式（无策略规则匹配）时，建议修订以便绕过沙箱
- **`derive_requested_execpolicy_amendment_from_prefix_rule()`**（`codex-rs/core/src/exec_policy.rs:700-739`）：基于工具层传入的 `prefix_rule` 建议修订，但会过滤掉**被禁止的前缀**并验证添加该规则后是否能覆盖所有子命令

## 函数签名与参数说明

### `ExecPolicyManager::load(config_stack: &ConfigLayerStack) -> Result<Self, ExecPolicyError>`

从配置层栈加载策略规则，构建 `ExecPolicyManager`。解析错误降级为警告日志。

### `ExecPolicyManager::create_exec_approval_requirement_for_command(&self, req: ExecApprovalRequest<'_>) -> ExecApprovalRequirement`

评估命令的审批需求。`ExecApprovalRequest` 包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| `command` | `&[String]` | 待评估的命令参数列表 |
| `approval_policy` | `AskForApproval` | 当前的用户审批策略 |
| `sandbox_policy` | `&SandboxPolicy` | 沙箱策略类型 |
| `file_system_sandbox_policy` | `&FileSystemSandboxPolicy` | 文件系统沙箱策略 |
| `sandbox_permissions` | `SandboxPermissions` | 当前沙箱权限状态 |
| `prefix_rule` | `Option<Vec<String>>` | 工具层建议的前缀规则 |

### `ExecPolicyManager::append_amendment_and_update(&self, codex_home: &Path, amendment: &ExecPolicyAmendment) -> Result<(), ExecPolicyUpdateError>`

将命令前缀允许规则持久化到 `default.rules` 并更新内存策略。

### `ExecPolicyManager::append_network_rule_and_update(&self, codex_home: &Path, host: &str, protocol: NetworkRuleProtocol, decision: Decision, justification: Option<String>) -> Result<(), ExecPolicyUpdateError>`

将网络访问规则持久化并更新内存策略。

### `load_exec_policy(config_stack: &ConfigLayerStack) -> Result<Policy, ExecPolicyError>`

公开的策略加载函数，遍历配置层加载所有 `.rules` 文件并合并 overlay。

### `render_decision_for_unmatched_command(approval_policy, sandbox_policy, file_system_sandbox_policy, command, sandbox_permissions, used_complex_parsing) -> Decision`

为未匹配任何策略规则的命令推导决策，综合考虑安全命令检测、危险命令检测、沙箱状态等因素。

### `prompt_is_rejected_by_policy(approval_policy: AskForApproval, prompt_is_rule: bool) -> Option<&'static str>`

检查当前 `AskForApproval` 设置是否禁止向用户弹出审批提示。返回 `Some(reason)` 表示应拒绝。区分策略规则触发的提示和沙箱/升级触发的提示。

### `child_uses_parent_exec_policy(parent_config: &Config, child_config: &Config) -> bool`

判断子 agent 是否共享父 agent 的执行策略（基于配置目录和策略要求是否一致）。

## 接口/类型定义

### `ExecPolicyManager`

策略管理器，核心字段：
- `policy: ArcSwap<Policy>` — 当前生效的策略，使用 `ArcSwap` 实现无锁读、原子写
- `update_lock: tokio::sync::Mutex<()>` — 保护策略文件写入的互斥锁

实现 `Default`，默认创建空策略。

### `ExecPolicyError`

策略加载错误枚举：
- `ReadDir` — 读取规则目录失败
- `ReadFile` — 读取规则文件失败
- `ParsePolicy` — 解析规则文件失败（含文件路径和源错误）

### `ExecPolicyUpdateError`

策略更新错误枚举：
- `AppendRule` — 写入规则文件失败
- `JoinBlockingTask` — 阻塞任务 join 失败
- `AddRule` — 内存中添加规则失败

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|---|------|
| `RULES_DIR_NAME` | `"rules"` | 配置层下存放规则文件的目录名 |
| `RULE_EXTENSION` | `"rules"` | 规则文件的扩展名 |
| `DEFAULT_POLICY_FILE` | `"default.rules"` | 动态修订写入的默认规则文件 |

动态修订持久化路径为 `$CODEX_HOME/rules/default.rules`。

## 被禁止的前缀建议

`BANNED_PREFIX_SUGGESTIONS`（`codex-rs/core/src/exec_policy.rs:50-97`）定义了一组**不允许作为自动修订建议**的命令前缀。这些通常是解释器/shell 本身（如 `python3`、`bash`、`node`、`git`、`sudo` 等），因为为它们添加允许规则等同于绕过所有安全检查。完整列表覆盖：

- Python 系列（`python3`、`python`、`py`、`pypy` 等及其 `-c` 变体）
- Shell 系列（`bash`、`sh`、`zsh` 及其 `-lc`/`-c` 变体，含绝对路径）
- PowerShell 系列（`pwsh`、`powershell`、`powershell.exe` 及其 `-Command`/`-c` 变体）
- 其他：`git`、`env`、`sudo`、`node`、`perl`、`ruby`、`php`、`lua`、`osascript`

## 边界 Case 与注意事项

- **复合命令解析**：`bash -c "cmd1 && cmd2"` 会被拆解为独立子命令分别评估。如果解析回退到 heredoc 模式（`used_complex_parsing = true`），则禁止生成自动修订建议，避免不精确的规则
- **并发安全**：策略读取通过 `ArcSwap` 无锁进行；写入通过 `tokio::sync::Mutex` 串行化。先持久化到文件再更新内存，但文件写入使用 `spawn_blocking` 避免阻塞 async 运行时
- **幂等写入**：`append_amendment_and_update()` 在写入文件后会检查内存策略是否已等效包含该规则，避免重复添加
- **Windows 沙箱降级**：Windows 上的 `ReadOnly` 沙箱被视为无保护，危险命令检测更加严格
- **错误格式化**：`format_exec_policy_error_with_source()` 对 Starlark 解析错误做特殊处理，尝试提取精确的文件路径和行号信息以便用户定位问题（`codex-rs/core/src/exec_policy.rs:444-475`）
- **策略合并顺序**：低优先级层的规则先加载，高优先级层后加载，高优先级可覆盖低优先级。`requirements().exec_policy` 作为 overlay 最后合并