# ExecPolicyLegacy — 旧版执行策略验证器

## 概述与职责

ExecPolicyLegacy（crate 名 `codex-execpolicy-legacy`）是 Codex 沙箱安全层（Sandbox）中的**命令执行策略引擎**，负责在 agent 执行 shell 命令之前，验证该命令是否符合预定义的安全策略。它通过基于正则表达式的模式匹配和详细的参数解析，判断一个 `exec` 调用是"安全的"、"被禁止的"还是"无法验证的"。

在系统架构中，ExecPolicyLegacy 属于 **Sandbox** 模块的子组件。Core 和 ToolSystem 通过 Sandbox 执行 shell 命令时，Sandbox 会调用此 crate 来做策略裁决。该 crate 正在被更新的 ExecPolicy crate 逐步取代。

该 crate 同时提供**库**（`codex_execpolicy_legacy`）和**CLI 二进制**（`codex-execpolicy-legacy`），CLI 用于独立测试和调试策略文件。

## 关键流程

### 策略加载与解析

策略文件使用 **Starlark 语言**（Python 方言）编写，通过 `PolicyParser` 解析：

1. `PolicyParser::parse()` 使用 Starlark 的 `AstModule::parse()` 解析策略源码（`src/policy_parser.rs:37-71`）
2. 解析时向 Starlark 环境注入预定义的参数匹配器常量（如 `ARG_RFILE`、`ARG_WFILE`、`ARG_SED_COMMAND` 等）和内建函数（`define_program`、`forbid_substrings`、`forbid_program_regex`、`opt`、`flag`）
3. Starlark 脚本执行时，每次调用 `define_program()` 都会构建一个 `ProgramSpec` 并添加到 `PolicyBuilder` 中
4. 最终 `PolicyBuilder::build()` 生成 `Policy` 对象，包含程序规格映射表、禁止程序正则列表和禁止子串正则

默认策略通过 `include_str!("default.policy")` 在编译时嵌入（`src/lib.rs:40`），`build.rs` 会在策略文件变化时触发重编译。

### 命令校验主流程

当收到一个 `ExecCall`（程序名 + 参数列表）时，`Policy::check()` 按以下顺序执行（`src/policy.rs:44-86`）：

1. **禁止程序检查**：遍历 `forbidden_program_regexes`，若程序名匹配任一正则，返回 `MatchedExec::Forbidden`
2. **禁止子串检查**：遍历所有参数，若任一参数包含 `forbidden_substrings_pattern` 中的子串，返回 `MatchedExec::Forbidden`
3. **规格匹配**：在 `programs` MultiMap 中查找与程序名对应的所有 `ProgramSpec`，依次尝试匹配。同一个程序名可以有多个 spec（如 `sed` 有两种变体），只要一个匹配成功即返回

### ProgramSpec 参数解析

`ProgramSpec::check()` 对参数逐一分类（`src/program.rs:94-195`）：

1. **选项解析**：以 `-` 开头的参数查找 `allowed_options` 表。`Flag` 类型直接记录，`Value` 类型则消费下一个参数作为值
2. **位置参数收集**：非选项参数收集为 `PositionalArg`，带原始索引
3. **必选选项校验**：确认所有 `required=True` 的选项都已出现
4. **位置参数模式匹配**：调用 `resolve_observed_args_with_patterns()` 将位置参数与 `arg_patterns` 对齐
5. **Forbidden 标记**：若 spec 本身标记了 `forbidden` 原因，匹配成功也返回 `Forbidden`

### 位置参数解析算法

`resolve_observed_args_with_patterns()`（`src/arg_resolver.rs:15-145`）实现了一个基于前缀/可变参数/后缀的三段匹配算法：

1. 将 `arg_patterns` 按基数分区：固定基数的模式先归入 `prefix_patterns`，遇到第一个变长模式（`AtLeastOne` 或 `ZeroOrMore`）后归入 `vararg_pattern`，其后的固定基数模式归入 `suffix_patterns`
2. 最多允许一个变长模式（多个则报 `MultipleVarargPatterns` 错误）
3. 依次匹配前缀参数、可变参数、后缀参数，对每个参数调用 `ArgType::validate()` 进行类型校验

### 文件路径安全检查

`ExecvChecker::check()` 在命令匹配成功后进一步验证文件路径（`src/execv_checker.rs:44-98`）：

1. 遍历所有参数和选项值，对 `ReadableFile` 类型检查路径是否在允许的可读目录内，对 `WriteableFile` 类型检查是否在允许的可写目录内
2. 相对路径通过 `ensure_absolute_path()` 结合 cwd 转为绝对路径
3. 尝试用 `system_path` 中的可执行路径替代程序名（如用 `/bin/ls` 替代 `ls`），防止 PATH 劫持

## 函数签名与公开 API

### `get_default_policy() -> starlark::Result<Policy>`

加载编译时嵌入的默认策略文件，返回解析后的 `Policy` 对象。

> 源码位置：`src/lib.rs:42-45`

### `Policy::check(&self, exec_call: &ExecCall) -> Result<MatchedExec>`

核心校验入口。传入待执行的命令，返回匹配结果。

- 返回 `MatchedExec::Match { exec: ValidExec }` 表示命令通过策略
- 返回 `MatchedExec::Forbidden { cause, reason }` 表示命令被禁止
- 返回 `Err(Error)` 表示无法找到匹配规格

> 源码位置：`src/policy.rs:44-86`

### `ExecvChecker::check(&self, valid_exec: ValidExec, cwd: &Option<OsString>, readable_folders: &[PathBuf], writeable_folders: &[PathBuf]) -> Result<String>`

对已匹配成功的命令进行文件路径安全检查。返回最终应使用的可执行文件路径。

> 源码位置：`src/execv_checker.rs:44-98`

### `PolicyParser::new(policy_source: &str, unparsed_policy: &str) -> Self`

创建策略解析器。`policy_source` 是策略来源标识（用于报错），`unparsed_policy` 是 Starlark 格式的策略内容。

> 源码位置：`src/policy_parser.rs:30-35`

### `parse_sed_command(sed_command: &str) -> Result<()>`

验证 sed 命令是否为"可证安全"的格式。当前仅接受 `N,Mp` 形式的行范围打印命令。

> 源码位置：`src/sed_command.rs:4-17`

## 接口/类型定义

### `ExecCall`

```rust
pub struct ExecCall {
    pub program: String,
    pub args: Vec<String>,
}
```

表示一个待验证的命令调用。`program` 是程序名（如 `"ls"`），`args` 是参数列表。

> 源码位置：`src/exec_call.rs:5-9`

### `MatchedExec`

```rust
pub enum MatchedExec {
    Match { exec: ValidExec },
    Forbidden { cause: Forbidden, reason: String },
}
```

策略匹配的两种结果：通过或禁止。

> 源码位置：`src/program.rs:69-73`

### `ValidExec`

```rust
pub struct ValidExec {
    pub program: String,
    pub flags: Vec<MatchedFlag>,
    pub opts: Vec<MatchedOpt>,
    pub args: Vec<MatchedArg>,
    pub system_path: Vec<String>,
}
```

通过策略的命令，已将参数分类为标志、带值选项和位置参数，并携带类型信息。`system_path` 提供可信路径列表以防 PATH 劫持。`might_write_files()` 方法可判断命令是否可能写入文件。

> 源码位置：`src/valid_exec.rs:6-18`

### `ArgMatcher`

```rust
pub enum ArgMatcher {
    Literal(String),    // 精确字面值
    OpaqueNonFile,      // 非文件的不透明值
    ReadableFile,       // 单个可读文件
    WriteableFile,      // 单个可写文件
    ReadableFiles,      // 一个或多个可读文件（AtLeastOne）
    ReadableFilesOrCwd, // 零个或多个可读文件（ZeroOrMore）
    PositiveInteger,    // 正整数
    SedCommand,         // 安全的 sed 命令
    UnverifiedVarargs,  // 任意数量未验证参数（ZeroOrMore）
}
```

策略文件中用于匹配位置参数的模式。每个变体有对应的基数（`One`/`AtLeastOne`/`ZeroOrMore`）和 `ArgType`。在 Starlark 环境中以全大写常量暴露（如 `ARG_RFILE`、`ARG_WFILE`）。

> 源码位置：`src/arg_matcher.rs:20-48`

### `ArgType`

```rust
pub enum ArgType {
    Literal(String),
    OpaqueNonFile,
    ReadableFile,
    WriteableFile,
    PositiveInteger,
    SedCommand,
    Unknown,
}
```

参数的具体类型，提供 `validate()` 方法对值进行类型校验，以及 `might_write_file()` 用于判断是否涉及文件写入。

> 源码位置：`src/arg_type.rs:15-29`

### `Opt` 与 `OptMeta`

```rust
pub struct Opt {
    pub opt: String,       // 选项名，如 "-n" 或 "--help"
    pub meta: OptMeta,     // Flag 或 Value(ArgType)
    pub required: bool,    // 是否必选
}

pub enum OptMeta {
    Flag,                  // 无值标志
    Value(ArgType),        // 带值选项
}
```

> 源码位置：`src/opt.rs:19-37`

### `Error`

包含 20 余种错误变体的枚举，覆盖策略匹配过程中所有失败场景，支持 `Serialize` 以便 JSON 输出。关键变体包括：

| 变体 | 含义 |
|------|------|
| `NoSpecForProgram` | 策略中未定义该程序 |
| `UnknownOption` | 参数中包含未声明的选项 |
| `ReadablePathNotInReadableFolders` | 可读文件路径不在允许的目录内 |
| `WriteablePathNotInWriteableFolders` | 可写文件路径不在允许的目录内 |
| `SedCommandNotProvablySafe` | sed 命令不是可证安全的格式 |
| `MissingRequiredOptions` | 缺少必选选项 |

> 源码位置：`src/error.rs:15-96`

## 默认策略文件

内嵌的 `default.policy`（`src/default.policy`）使用 Starlark 语法定义了以下程序的安全规则：

| 程序 | 关键约束 |
|------|----------|
| `ls` | 允许 `-1`/`-a`/`-l` 标志，参数为可读文件或 cwd |
| `cat` | 允许 `-b`/`-n`/`-t`，至少一个可读文件，不允许无参数调用 |
| `cp` | 允许 `-r`/`-R`/`--recursive`，源为可读文件列表，目标为可写文件 |
| `head` | 允许 `-c`/`-n`（正整数值），参数为可读文件 |
| `printenv` | 两种变体：无参数（打印全部）或恰好一个不透明值参数 |
| `pwd` | 允许 `-L`/`-P`，无位置参数 |
| `rg` | 丰富的选项支持，第一个参数为搜索模式，后续为可读文件 |
| `sed` | 两种变体（带/不带 `-e`），使用 `ARG_SED_COMMAND` 限制为安全命令 |
| `which` | 允许 `-a`/`-s`，至少一个可读文件参数 |

每个程序可定义 `should_match` 和 `should_not_match` 示例，通过 `Policy::check_each_good_list_individually()` 和 `check_each_bad_list_individually()` 进行自验证。

## CLI 工具

二进制 `codex-execpolicy-legacy` 提供两个子命令（`src/main.rs:38-52`）：

- **`check <command...>`**：直接传入程序和参数进行校验
- **`check-json <json>`**：传入 `{"program": "...", "args": [...]}` 格式的 JSON

输出为 JSON，`result` 字段为 `"safe"`（安全）、`"match"`（匹配但可能写文件）、`"forbidden"`（禁止）或 `"unverified"`（无法验证）。配合 `--require-safe` 标志时，非安全结果会使用不同的退出码（12=匹配但写文件，13=无法验证，14=禁止）。

## 边界 Case 与注意事项

- **`--`（双破折号）不支持**：当前解析器遇到 `--` 会直接报错 `DoubleDashNotSupportedYet`（`src/program.rs:117-119`）
- **选项捆绑（option bundling）未实现**：虽然 `ProgramSpec` 有 `option_bundling` 字段，但解析逻辑中未使用，`-al` 不会被展开为 `-a -l`
- **combined format 未实现**：`--option=value` 格式同样未实现，策略文件中标注为 PLANNED
- **sed 安全命令极度保守**：`parse_sed_command` 仅接受 `N,Mp` 格式（行范围打印），其他所有 sed 命令均拒绝。这是为了防范 GNU sed 的 `e` 标志导致任意命令执行
- **同名程序多规格**：一个程序名可关联多个 `ProgramSpec`（如 `printenv` 和 `sed` 各有两种变体），匹配时按注册顺序尝试，返回最后一个错误
- **PATH 劫持防护**：`system_path` 机制允许指定可信的可执行文件路径（如 `/bin/ls`），`ExecvChecker` 会优先使用这些路径