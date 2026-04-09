# Hooks — 生命周期钩子引擎

## 概述与职责

Hooks 模块（crate 名 `codex-hooks`）是 Codex 的**生命周期钩子引擎**，属于 Config 层的子系统。它允许用户通过 `hooks.json` 配置文件在关键的会话和工具执行节点注入自定义 shell 命令，从而实现策略拦截、自动化审计和行为定制。

在整体架构中，Hooks 与 Config 层的其他子系统（层级配置文件、AGENTS.md 指令、Feature Flags）并列。Core 引擎在执行会话启动、工具调用前后、用户提示提交和停止等关键时刻，会调用本模块来执行已注册的钩子。

该模块的主要能力包括：

- **钩子发现（Discovery）**：遍历配置层级栈中的 `hooks.json` 文件，解析出所有已声明的钩子处理器
- **钩子分发（Dispatch）**：在 5 个生命周期点（`SessionStart`、`PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`Stop`）执行匹配的 shell 命令
- **输出解析（Output Parsing）**：解析钩子命令的 JSON stdout，提取控制指令（approve/deny/block、stop、附加上下文等）
- **JSON Schema 生成**：为每个生命周期事件生成输入/输出的 JSON Schema fixture
- **旧版兼容**：支持 `legacy_notify` 风格的 fire-and-forget 钩子

## 关键流程

### 1. 初始化与钩子发现

当 `Hooks::new(config)` 被调用时，整个钩子系统完成初始化：

1. 如果配置了 `legacy_notify_argv`，通过 `notify_hook()` 创建一个旧版 `after_agent` 钩子（`src/registry.rs:44-50`）
2. 构造 `ClaudeHooksEngine`，如果 `feature_enabled` 为 `true` 且非 Windows 平台，调用 `discovery::discover_handlers()` 开始发现流程（`src/engine/mod.rs:70-101`）
3. 发现过程遍历 `ConfigLayerStack` 中的每一层（按**优先级从低到高**排列），在每层的 config 目录下查找 `hooks.json` 文件（`src/engine/discovery.rs:31-47`）
4. 解析每个 `hooks.json` 为 `HooksFile` 结构，按 5 个事件类别提取 `MatcherGroup`，每个 group 包含一个可选的正则 matcher 和一组 handler 配置（`src/engine/config.rs:1-48`）
5. 对每个 handler 进行校验：跳过 `async` 钩子、`prompt` 类型和 `agent` 类型（尚未支持），校验 matcher 正则的合法性，最终生成 `ConfiguredHandler` 列表（`src/engine/discovery.rs:115-178`）

### 2. 钩子执行流程（以 PreToolUse 为例）

```
调用方 → Hooks::run_pre_tool_use(request)
       → engine.run_pre_tool_use(request)
       → dispatcher::select_handlers()  // 按事件名和 matcher 筛选
       → dispatcher::execute_handlers() // 并发执行所有匹配的 shell 命令
           → command_runner::run_command() // 单个命令的执行
       → parse_completed()              // 解析每个命令的输出
       → 聚合结果返回 PreToolUseOutcome
```

具体步骤：

1. **选择匹配的 handler**：`select_handlers()` 根据事件名过滤，对于 `PreToolUse`/`PostToolUse`/`SessionStart`，还会使用 matcher 正则匹配工具名或来源（`src/engine/dispatcher.rs:25-43`）
2. **序列化输入 JSON**：将 request 转为对应的 `*CommandInput` 结构并序列化为 JSON 字符串
3. **并发执行**：通过 `futures::join_all` 并发启动所有匹配的 shell 命令（`src/engine/dispatcher.rs:63-83`）
4. **命令执行**：`run_command()` 通过配置的 shell（默认 `$SHELL -lc` 或 `cmd.exe /C`）执行命令，将输入 JSON 写入 stdin，等待输出，支持超时控制（`src/engine/command_runner.rs:24-101`）
5. **解析输出**：根据退出码和 stdout 内容解析控制指令——exit code 0 + JSON stdout 为正常响应，exit code 2 + stderr 为阻止/反馈信号
6. **聚合结果**：将所有 handler 的结果聚合为最终 Outcome

### 3. Matcher 匹配机制

Matcher 是一个正则表达式，用于限定钩子只在特定条件下触发（`src/events/common.rs:84-107`）：

- **`None` 或 `""`**：匹配所有事件
- **`"*"`**：特殊处理，也匹配所有事件
- **正则表达式**（如 `^Bash$`、`Edit|Write`）：对 `PreToolUse`/`PostToolUse` 匹配工具名，对 `SessionStart` 匹配来源字符串
- **`UserPromptSubmit` 和 `Stop`**：不支持 matcher，发现阶段会将其忽略（`src/events/common.rs:72-82`）

### 4. 输出解析与控制指令

钩子的 stdout 输出会被解析为 JSON 对象，包含以下控制语义（`src/engine/output_parser.rs`）：

**通用字段**（`HookUniversalOutputWire`）：
- `continue`（默认 `true`）：设为 `false` 时停止后续处理
- `stopReason`：停止原因文本
- `suppressOutput`：是否抑制输出（仅部分事件支持）
- `systemMessage`：系统级警告消息

**事件特有字段**：

| 事件 | 决策字段 | 效果 |
|------|----------|------|
| PreToolUse | `hookSpecificOutput.permissionDecision: "deny"` + `permissionDecisionReason` | 阻止工具执行 |
| PreToolUse（旧版） | `decision: "block"` + `reason` | 阻止工具执行 |
| PostToolUse | `decision: "block"` + `reason` | 向模型反馈信息 |
| PostToolUse | `hookSpecificOutput.additionalContext` | 注入额外上下文 |
| UserPromptSubmit | `decision: "block"` + `reason` | 阻止提示提交 |
| Stop | `decision: "block"` + `reason` | 阻止停止并生成继续提示 |

**快捷协议**：exit code 2 + 非空 stderr 也可触发阻止/反馈，无需 JSON 输出。

### 5. 旧版 Legacy Notify 钩子

旧版钩子通过 `legacy_notify_argv` 配置，采用 fire-and-forget 模式（`src/legacy_notify.rs:46-73`）：

1. 将原始 argv 作为命令基础
2. 将 `UserNotification::AgentTurnComplete` 序列化为 JSON 字符串追加为命令的最后一个参数
3. 不捕获 stdin/stdout/stderr，直接 spawn 后返回
4. 仅支持 `AfterAgent` 事件

## 函数签名与核心类型

### `Hooks`（公开入口）

```rust
pub struct Hooks { /* ... */ }
```

> 源码位置：`src/registry.rs:30-35`

| 方法 | 签名 | 说明 |
|------|------|------|
| `new` | `fn new(config: HooksConfig) -> Self` | 初始化钩子引擎，发现所有配置的 handler |
| `startup_warnings` | `fn startup_warnings(&self) -> &[String]` | 返回初始化阶段产生的警告 |
| `run_session_start` | `async fn run_session_start(request, turn_id) -> SessionStartOutcome` | 执行 SessionStart 钩子 |
| `run_pre_tool_use` | `async fn run_pre_tool_use(request) -> PreToolUseOutcome` | 执行 PreToolUse 钩子 |
| `run_post_tool_use` | `async fn run_post_tool_use(request) -> PostToolUseOutcome` | 执行 PostToolUse 钩子 |
| `run_user_prompt_submit` | `async fn run_user_prompt_submit(request) -> UserPromptSubmitOutcome` | 执行 UserPromptSubmit 钩子 |
| `run_stop` | `async fn run_stop(request) -> StopOutcome` | 执行 Stop 钩子 |
| `preview_*` | 各事件对应的 preview 方法 | 预览将要执行的钩子列表（不实际执行） |
| `dispatch` | `async fn dispatch(hook_payload) -> Vec<HookResponse>` | 旧版分发机制（用于 AfterAgent/AfterToolUse 事件） |

### `HooksConfig`

```rust
pub struct HooksConfig {
    pub legacy_notify_argv: Option<Vec<String>>,
    pub feature_enabled: bool,
    pub config_layer_stack: Option<ConfigLayerStack>,
    pub shell_program: Option<String>,
    pub shell_args: Vec<String>,
}
```

> 源码位置：`src/registry.rs:22-28`

### Outcome 类型

每个生命周期事件返回对应的 Outcome 结构：

- **`SessionStartOutcome`**：`hook_events`、`should_stop`、`stop_reason`、`additional_contexts`
- **`PreToolUseOutcome`**：`hook_events`、`should_block`、`block_reason`
- **`PostToolUseOutcome`**：`hook_events`、`should_stop`、`stop_reason`、`additional_contexts`、`feedback_message`
- **`UserPromptSubmitOutcome`**：`hook_events`、`should_stop`、`stop_reason`、`additional_contexts`
- **`StopOutcome`**：`hook_events`、`should_stop`、`stop_reason`、`should_block`、`block_reason`、`continuation_fragments`

## 配置格式（hooks.json）

`hooks.json` 文件的结构通过 `HooksFile` 定义（`src/engine/config.rs:4-7`）：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          {
            "type": "command",
            "command": "python3 validate_bash.py",
            "timeout": 30,
            "statusMessage": "Validating bash command..."
          }
        ]
      }
    ],
    "PostToolUse": [],
    "SessionStart": [],
    "UserPromptSubmit": [],
    "Stop": []
  }
}
```

### Handler 配置字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `type` | `"command"` / `"prompt"` / `"agent"` | — | 处理器类型（当前仅支持 `command`） |
| `command` | string | — | 要执行的 shell 命令 |
| `timeout` | number | 600 | 超时时间（秒），最小 1 秒 |
| `async` | boolean | false | 异步执行（尚未支持） |
| `statusMessage` | string | null | 执行时显示的状态消息 |

## JSON Schema Fixture 生成

模块包含一个独立的 binary `write_hooks_schema_fixtures`（`src/bin/write_hooks_schema_fixtures.rs`），用于生成 10 个 JSON Schema 文件：

- 每个生命周期事件对应 input 和 output 两个 schema
- Schema 基于 JSON Schema Draft 07 标准，通过 `schemars` crate 从 Rust 类型自动派生
- 生成的文件通过 `include_str!` 编译时嵌入到 crate 中，启动时由 `schema_loader` 解析验证
- 测试确保生成的 schema 与仓库中已提交的 fixture 文件一致

> 源码位置：`src/schema.rs:349-395`

## 边界 Case 与注意事项

- **Windows 不支持**：在 Windows 平台上，`ClaudeHooksEngine::new()` 会直接返回空 handler 列表并生成警告（`src/engine/mod.rs:83-91`）
- **fail-open 策略**：当钩子输出了不受支持的字段（如 `PreToolUse` 返回 `decision:approve`、`updatedInput`、`additionalContext`），系统标记为失败但不阻止操作
- **exit code 2 协议**：除了 JSON 输出外，钩子可以用退出码 2 + stderr 内容来触发阻止，这是一种轻量级的拦截方式
- **JSON-like 内容校验**：如果 stdout 以 `{` 或 `[` 开头但无法解析为有效 JSON，会标记为 `Failed` 而非静默忽略——防止畸形 JSON 被误当作纯文本上下文
- **SessionStart 的纯文本兼容**：`SessionStart` 和 `UserPromptSubmit` 事件特殊处理非 JSON 的纯文本 stdout 作为 `additionalContext` 注入模型上下文
- **Stop 钩子的 block 语义**：Stop 钩子的 `decision:block` 不是阻止停止本身，而是生成 `continuation_fragments` 让会话继续执行
- **声明顺序保持**：来自同一 `hooks.json` 的钩子按声明顺序执行，跨配置层按层级优先级排序（低优先级先执行）
- **并发执行**：同一事件的所有匹配 handler 通过 `futures::join_all` 并发执行
- **超时机制**：每个命令有独立的超时控制，超时后进程会被 kill（`kill_on_drop(true)`）