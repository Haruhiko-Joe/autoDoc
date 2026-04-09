# ExecPolicy — 基于 Starlark 的执行策略引擎

## 概述与职责

ExecPolicy（crate 名：`codex-execpolicy`）是 Codex 沙箱安全层的策略判定组件，负责回答一个核心问题：**某条命令是否允许执行？** 它使用一种类 Python 的 Starlark DSL 来定义前缀匹配规则，支持静态策略文件加载和运行时动态追加规则，同时提供网络访问策略控制。

在 Codex 的整体架构中，ExecPolicy 位于 **Sandbox** 模块内部。当 Core 引擎或 ToolSystem 需要通过沙箱执行 shell 命令时，Sandbox 会调用 ExecPolicy 对命令进行策略评估，根据返回的 `Decision`（Allow / Prompt / Forbidden）决定后续行为。ExecPolicy 与 Sandbox 中的其他兄弟组件（如 OS 级沙箱、exec-server、网络代理等）协同工作，共同构成 Codex 的安全执行层。

## 核心概念

### Decision（决策）

所有策略评估最终产出一个 `Decision`，定义于 `src/decision.rs:9-16`：

| 值 | 含义 |
|---|---|
| `Allow` | 命令可以直接执行，无需额外审批 |
| `Prompt` | 需要用户明确确认；在 `approval_policy="never"` 模式下会被直接拒绝 |
| `Forbidden` | 命令被无条件禁止 |

`Decision` 实现了 `Ord` trait，严格性排序为 `Allow < Prompt < Forbidden`。当多条规则同时匹配时，**取最严格的决策**。

### PrefixRule（前缀规则）

前缀规则是策略引擎的核心原语。它声明"如果命令的前 N 个 token 匹配指定模式，则施加某个决策"。定义于 `src/rule.rs:110-115`：

```rust
pub struct PrefixRule {
    pub pattern: PrefixPattern,
    pub decision: Decision,
    pub justification: Option<String>,
}
```

### PrefixPattern（前缀模式）

模式由有序 token 序列组成（`src/rule.rs:39-43`）。第一个 token 是固定字符串（用于索引查找），后续 token 可以是 `PatternToken::Single`（单一匹配）或 `PatternToken::Alts`（多选一匹配）：

```rust
pub struct PrefixPattern {
    pub first: Arc<str>,       // 第一个 token，固定字符串
    pub rest: Arc<[PatternToken]>,  // 后续 token 序列
}
```

模式匹配的逻辑很直观：命令 token 数 ≥ 模式长度，且每个位置的 token 都满足对应 `PatternToken` 的匹配条件（`src/rule.rs:46-59`）。

### NetworkRule（网络规则）

控制对特定主机的网络访问（`src/rule.rs:148-154`），支持四种协议：`Http`、`Https`、`Socks5Tcp`、`Socks5Udp`。主机名会被标准化处理（去除端口、尾部点号、转小写），不支持通配符。

### RuleMatch（匹配结果）

匹配结果分为两种变体（`src/rule.rs:63-82`）：

- **PrefixRuleMatch**：由策略规则产生的匹配，包含匹配到的前缀、决策和可选的 justification
- **HeuristicsRuleMatch**：当没有任何规则匹配时，由 heuristics fallback 函数产生的兜底决策

## 关键流程

### 命令评估流程

这是整个模块最核心的流程，入口为 `Policy::check()`（`src/policy.rs:188-198`）：

1. **精确匹配**：用命令的第一个 token 作为 key，从 `rules_by_program`（MultiMap）中查找所有关联规则，逐一尝试前缀匹配（`match_exact_rules`，`src/policy.rs:297-305`）

2. **主机可执行文件解析**（可选）：如果精确匹配无结果且 `resolve_host_executables` 选项开启，则尝试将绝对路径（如 `/usr/bin/git`）解析为 basename（如 `git`），再用 basename 去匹配规则（`match_host_executable_rules`，`src/policy.rs:307-334`）。此过程会检查 `host_executables_by_name` 白名单——如果存在白名单但路径不在列表中，则拒绝解析

3. **Heuristics 兜底**：如果仍无匹配且提供了 heuristics fallback 函数，返回一个 `HeuristicsRuleMatch`（`src/policy.rs:285-294`）

4. **聚合决策**：`Evaluation::from_matches` 取所有匹配结果中最严格的 `Decision`（`src/policy.rs:365-374`）

### Starlark 策略解析流程

策略文件使用 Starlark（一种类 Python 语言）编写，由 `PolicyParser` 解析（`src/parser.rs:39-84`）：

1. 创建 `PolicyParser`，内部持有一个 `PolicyBuilder`
2. 调用 `parse(policy_identifier, contents)` 解析一或多个策略文件
3. 内部使用 Starlark 的 `AstModule::parse` 和 `Evaluator::eval_module` 执行策略文件
4. 策略文件中的函数调用（`prefix_rule`、`network_rule`、`host_executable`）通过 `#[starlark_module]` 宏注册为内置函数，执行时通过 `Evaluator.extra` 访问 `PolicyBuilder` 并注册规则
5. 每个 `prefix_rule` 调用如果提供了 `match` / `not_match` 示例，会在解析完成后立即验证（`validate_pending_examples_from`），确保示例与规则的匹配行为一致
6. 调用 `build()` 生成最终的 `Policy` 对象

### 动态规则追加流程

通过 `amend` 模块（`src/amend.rs`）支持运行时向策略文件追加规则：

1. `blocking_append_allow_prefix_rule` / `blocking_append_network_rule` 将规则序列化为 Starlark 语法
2. 使用文件锁（advisory lock）打开策略文件
3. 先读取现有内容检查去重——如果完全相同的规则行已存在则跳过
4. 确保文件以换行符结尾后追加新规则行

> 注意：这些函数执行阻塞 I/O，在 async 上下文中应使用 `tokio::task::spawn_blocking`。

## 函数签名与 API

### `Policy` 核心方法

```rust
// 创建与构造
pub fn new(rules_by_program: MultiMap<String, RuleRef>) -> Self
pub fn from_parts(rules, network_rules, host_executables) -> Self
pub fn empty() -> Self

// 评估命令
pub fn check<F>(&self, cmd: &[String], heuristics_fallback: &F) -> Evaluation
pub fn check_with_options<F>(&self, cmd: &[String], heuristics_fallback: &F, options: &MatchOptions) -> Evaluation
pub fn check_multiple<Commands, F>(&self, commands: Commands, heuristics_fallback: &F) -> Evaluation

// 获取匹配规则（不做聚合）
pub fn matches_for_command(&self, cmd: &[String], heuristics_fallback: HeuristicsFallback) -> Vec<RuleMatch>

// 动态添加规则
pub fn add_prefix_rule(&mut self, prefix: &[String], decision: Decision) -> Result<()>
pub fn add_network_rule(&mut self, host: &str, protocol: NetworkRuleProtocol, decision: Decision, justification: Option<String>) -> Result<()>

// 策略合并
pub fn merge_overlay(&self, overlay: &Policy) -> Policy

// 网络域名编译
pub fn compiled_network_domains(&self) -> (Vec<String>, Vec<String>)  // (allowed, denied)
```

> 源码位置：`src/policy.rs:34-186`

### `PolicyParser`

```rust
pub fn new() -> Self
pub fn parse(&mut self, policy_identifier: &str, policy_file_contents: &str) -> Result<()>
pub fn build(self) -> Policy
```

> 源码位置：`src/parser.rs:49-84`

### Starlark 内置函数

在 `.codexpolicy` / `.rules` 文件中可用的函数（`src/parser.rs:348-473`）：

#### `prefix_rule`

```starlark
prefix_rule(
    pattern = ["git", "status"],           # 必填，有序 token 列表
    decision = "allow",                     # 可选，默认 "allow"
    justification = "safe read-only cmd",   # 可选，规则存在的理由
    match = [["git", "status"]],            # 可选，必须匹配的示例
    not_match = ["git commit"],             # 可选，必须不匹配的示例
)
```

- `pattern` 中每个元素可以是字符串或字符串列表（表示多选一）
- 第一个 token 如果是列表，会展开为多条独立规则（每个 alternative 一条）
- 后续 token 的列表不做笛卡尔展开，而是作为 `Alts` 原地匹配

#### `network_rule`

```starlark
network_rule(
    host = "api.github.com",    # 必填，具体主机名（不支持通配符）
    protocol = "https",          # 必填：http / https / socks5_tcp / socks5_udp
    decision = "allow",          # 必填：allow / deny / prompt
    justification = "...",       # 可选
)
```

#### `host_executable`

```starlark
host_executable(
    name = "git",                          # bare name，不含路径
    paths = ["/usr/bin/git", "/opt/homebrew/bin/git"],  # 允许的绝对路径白名单
)
```

### 动态追加 API

```rust
pub fn blocking_append_allow_prefix_rule(policy_path: &Path, prefix: &[String]) -> Result<(), AmendError>
pub fn blocking_append_network_rule(policy_path: &Path, host: &str, protocol: NetworkRuleProtocol, decision: Decision, justification: Option<&str>) -> Result<(), AmendError>
```

> 源码位置：`src/amend.rs:66-126`

## CLI 用法

模块提供 `codex-execpolicy` 二进制（`src/main.rs`），目前支持一个子命令 `check`：

```bash
codex-execpolicy check --rules <PATH> [--rules <PATH>...] [--pretty] [--resolve-host-executables] -- <COMMAND...>
```

参数说明（`src/execpolicycheck.rs:17-39`）：

| 参数 | 说明 |
|---|---|
| `-r, --rules <PATH>` | 策略文件路径，可重复指定多个 |
| `--pretty` | 美化 JSON 输出 |
| `--resolve-host-executables` | 启用绝对路径到 basename 的解析 |
| `<COMMAND...>` | 要检查的命令 token 序列 |

输出为 JSON：

```json
{
  "matchedRules": [...],
  "decision": "allow"
}
```

当无规则匹配时，`matchedRules` 为空数组，`decision` 字段省略。

## 接口/类型定义

### `MatchOptions`

```rust
pub struct MatchOptions {
    pub resolve_host_executables: bool,  // 是否启用绝对路径→basename 解析
}
```

### `Evaluation`

```rust
pub struct Evaluation {
    pub decision: Decision,
    pub matched_rules: Vec<RuleMatch>,
}
```

提供 `is_match()` 方法判断是否有真正的策略规则匹配（排除 heuristics fallback）。

### `Error` 枚举

定义于 `src/error.rs:25-51`，包含以下变体：

- `InvalidDecision` — 无效的 decision 字符串
- `InvalidPattern` — 无效的模式定义
- `InvalidExample` — 无效的示例
- `InvalidRule` — 无效的规则参数
- `ExampleDidNotMatch` — `match` 示例未能匹配任何规则（含位置信息）
- `ExampleDidMatch` — `not_match` 示例意外匹配了某条规则（含位置信息）
- `Starlark` — Starlark 解析/执行错误

## 设计要点与边界 Case

### 最严格决策优先

当命令匹配多条规则时（例如 `["git"]` 匹配 prompt，`["git", "commit"]` 匹配 forbidden），最终决策取严格性最高的那个。这一行为由 `Decision` 的 `Ord` 实现保证（`src/decision.rs:7`）。

### 主机可执行文件解析的三种情况

1. **无 `host_executable` 定义**：绝对路径自动 fallback 到 basename 规则
2. **有定义且路径在白名单中**：允许 fallback
3. **有定义但路径不在白名单中（或白名单为空）**：不允许 fallback，视为无匹配

### 精确匹配优先于 basename 解析

如果命令的绝对路径（如 `/usr/bin/git`）直接匹配了某条规则的第一个 token，则不会再进行 basename 解析（`src/policy.rs:274-283`）。

### 动态追加的幂等性

`blocking_append_allow_prefix_rule` 和 `blocking_append_network_rule` 在写入前会检查文件中是否已存在完全相同的规则行，避免重复追加（`src/amend.rs:175-177`）。

### 策略文件合并

`merge_overlay` 将 overlay 策略的规则追加到 base 策略之上，两者的规则共存，不会覆盖。网络规则和 host executable 定义也会合并（`src/policy.rs:141-165`）。

### 网络域名编译

`compiled_network_domains()` 将所有网络规则按声明顺序处理，后声明的规则会覆盖先前同一主机的决策——如果 allow 则从 denied 列表移除并加入 allowed 列表，反之亦然。`Prompt` 决策不影响任何列表（`src/policy.rs:167-186`）。

### Starlark 方言

解析器使用 `Dialect::Extended` 并启用 f-string 支持（`src/parser.rs:60-61`），允许策略文件使用 Starlark 的完整扩展语法。