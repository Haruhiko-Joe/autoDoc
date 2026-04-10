# CLIBootstrap — CLI 引导入口

## 概述与职责

`CLIBootstrap` 是 Claude Code 整个应用的**最顶层入口文件**（`src/entrypoints/cli.tsx`），负责解析 `process.argv` 并执行快速路径分发。其核心设计目标是**最小化启动延迟**：对于不需要完整 CLI 栈的子命令（如 `--version`、`remote-control`、`daemon`、后台会话管理等），通过提前拦截 + 动态 `import()` 的方式，仅加载必要模块即可完成任务。只有当所有快速路径都不匹配时，才加载 `main.tsx` 进入完整的交互式 CLI 流程。

**在系统架构中的位置**：本模块属于 **Entrypoints** 层，是 CLI 模式的唯一入口。它是用户执行 `claude` 命令后第一个被运行的代码。根据分发结果，它会将控制权交给 CoreEngine（通过 `main.tsx`）、BridgeAndRemote（通过 `bridgeMain`）、TaskSystem（通过后台会话处理器）等不同子系统。同级入口还有 MCP Server 和 SDK 等其他启动模式。

## 关键流程

### 顶层初始化（模块加载时）

在 `main()` 函数被调用之前，文件顶层有三段立即执行的初始化逻辑：

1. **Corepack 修复**：设置 `COREPACK_ENABLE_AUTO_PIN = '0'`，防止 corepack 自动将 yarnpkg 写入用户的 `package.json`（`cli.tsx:5`）

2. **CCR 环境内存配置**：当 `CLAUDE_CODE_REMOTE === 'true'` 时，自动向 `NODE_OPTIONS` 追加 `--max-old-space-size=8192`，为容器环境（16GB）中的子进程设置合理的堆内存上限（`cli.tsx:9-14`）

3. **Ablation Baseline 实验**：通过 `feature('ABLATION_BASELINE')` 编译时特性门控，当环境变量 `CLAUDE_CODE_ABLATION_BASELINE` 存在时，批量启用一组简化行为开关（禁用 thinking、compact、auto memory、background tasks 等），用于 harness-science 的 L0 对照实验（`cli.tsx:21-26`）

### 快速路径分发流程

`main()` 函数是一个 `async` 函数，按优先级依次检查命令行参数，命中则提前返回，未命中则继续向下：

```
process.argv → 解析 args
  ├─ --version/-v/-V        → 打印版本号，零导入返回
  ├─ --dump-system-prompt   → 输出系统提示词（内部构建专用）
  ├─ --claude-in-chrome-mcp → 启动 Chrome MCP 服务器
  ├─ --chrome-native-host   → 启动 Chrome Native Host
  ├─ --computer-use-mcp     → 启动 Computer Use MCP 服务器
  ├─ --daemon-worker        → 启动 daemon worker 进程
  ├─ remote-control/rc/...  → 进入 Bridge 远程控制模式
  ├─ daemon                 → 启动 daemon 主管进程
  ├─ ps/logs/attach/kill/--bg → 后台会话管理
  ├─ new/list/reply         → 模板任务命令
  ├─ environment-runner     → BYOC 环境运行器
  ├─ self-hosted-runner     → 自托管运行器
  ├─ --tmux + --worktree    → tmux worktree 快速路径
  ├─ --update/--upgrade     → 重定向到 update 子命令
  ├─ --bare                 → 设置 SIMPLE 模式环境变量
  └─ 无匹配 → 加载 main.tsx 进入完整 CLI
```

### 各快速路径详解

#### 1. `--version` 快速路径（cli.tsx:37-42）

最极致的优化——**零额外导入**。直接读取编译时内联的 `MACRO.VERSION` 常量并打印。这保证了 `claude --version` 的响应是毫秒级的。

```typescript
if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    console.log(`${MACRO.VERSION} (Claude Code)`);
    return;
}
```

#### 2. `--dump-system-prompt` 快速路径（cli.tsx:53-71）

受 `feature('DUMP_SYSTEM_PROMPT')` 特性门控保护（外部构建中会被 DCE 消除）。动态加载配置、模型工具和提示词模块，渲染完整系统提示词后输出。支持通过 `--model` 参数指定模型。用于 prompt 敏感性评估。

#### 3. Chrome 集成路径（cli.tsx:72-93）

两个独立的 Chrome 浏览器集成入口：
- `--claude-in-chrome-mcp`：启动 Claude-in-Chrome MCP 服务器
- `--chrome-native-host`：启动 Chrome Native Messaging Host

另有受 `feature('CHICAGO_MCP')` 门控的 `--computer-use-mcp` 路径，启动 Computer Use MCP 服务器。

#### 4. Daemon Worker 快速路径（cli.tsx:100-106）

受 `feature('DAEMON')` 门控。`--daemon-worker` 由 daemon supervisor 内部派生，属于性能敏感路径——**不调用 `enableConfigs()`，不初始化 analytics**，保持 worker 进程精简。如果某个 worker kind 需要配置或认证，由其自身的 `run()` 函数内部处理。

#### 5. Remote Control / Bridge 快速路径（cli.tsx:112-162）

受 `feature('BRIDGE_MODE')` 门控。接受多个别名：`remote-control`、`rc`、`remote`、`sync`、`bridge`。这是最复杂的快速路径，包含完整的前置校验链：

1. 加载配置（`enableConfigs()`）
2. **认证检查**：验证 OAuth access token 存在——必须在 GrowthBook 门控检查之前，因为 GB 需要用户上下文（`cli.tsx:139-141`）
3. **功能门控检查**：`getBridgeDisabledReason()` 等待 GrowthBook 初始化并返回新鲜值（`cli.tsx:142-145`）
4. **版本检查**：`checkBridgeMinVersion()` 验证当前版本满足最低要求（`cli.tsx:146-149`）
5. **策略限制检查**：加载组织策略，验证 `allow_remote_control` 权限（`cli.tsx:153-159`）
6. 所有检查通过后调用 `bridgeMain(args.slice(1))`

#### 6. Daemon 主管快速路径（cli.tsx:165-180）

受 `feature('DAEMON')` 门控。`claude daemon [subcommand]` 启动长运行的 daemon supervisor。加载配置和 analytics sinks 后调用 `daemonMain()`。

#### 7. 后台会话管理快速路径（cli.tsx:185-209）

受 `feature('BG_SESSIONS')` 门控。根据子命令分发到不同处理器：

| 子命令 | 处理函数 | 用途 |
|--------|----------|------|
| `ps` | `bg.psHandler()` | 列出后台会话 |
| `logs` | `bg.logsHandler()` | 查看会话日志 |
| `attach` | `bg.attachHandler()` | 附加到后台会话 |
| `kill` | `bg.killHandler()` | 终止后台会话 |
| `--bg`/`--background` | `bg.handleBgFlag()` | 以后台模式启动 |

#### 8. 模板任务快速路径（cli.tsx:212-222）

受 `feature('TEMPLATES')` 门控。支持 `new`、`list`、`reply` 三个子命令。注意此路径使用 `process.exit(0)` 而非 `return`——因为 `mountFleetView` 的 Ink TUI 可能留下事件循环句柄阻止自然退出。

#### 9. Environment Runner 和 Self-Hosted Runner（cli.tsx:226-245）

分别受 `feature('BYOC_ENVIRONMENT_RUNNER')` 和 `feature('SELF_HOSTED_RUNNER')` 门控。两者都是无头（headless）运行模式，用于 BYOC 和自托管部署场景。

#### 10. tmux + worktree 快速路径（cli.tsx:248-274）

当同时存在 `--tmux`（或 `--tmux=classic`）和 `--worktree`（或 `-w`）标志时触发。加载配置后检查 worktree 模式是否启用，若启用则调用 `execIntoTmuxWorktree()` 将进程切换到 tmux worktree 环境。如果处理失败则回退到正常 CLI 流程。

#### 11. 参数修正和环境变量设置（cli.tsx:277-285）

- `--update`/`--upgrade` 被重写为 `update` 子命令，修正常见的用户输入错误
- `--bare` 标志提前设置 `CLAUDE_CODE_SIMPLE = '1'`，确保在模块加载和 commander 选项构建阶段就能生效

### 完整 CLI 加载（cli.tsx:288-298）

所有快速路径未命中后，进入完整 CLI 启动流程：

1. 启动早期输入捕获（`startCapturingEarlyInput()`）——在 CLI 完全初始化之前开始缓存用户的键盘输入
2. 动态导入 `main.tsx`（此时会触发完整的模块依赖树加载）
3. 调用 `cliMain()` 进入交互式 REPL

## 接口/类型定义

### 编译时宏

- **`MACRO.VERSION`**：构建时内联的版本号字符串，用于 `--version` 快速路径
- **`feature(flag)`**：`bun:bundle` 提供的编译时特性门控函数，返回布尔值。在构建时进行死代码消除（DCE），使外部构建不包含内部功能代码

### 使用的特性门控（Feature Flags）

| Feature Flag | 控制的快速路径 |
|-------------|--------------|
| `ABLATION_BASELINE` | 实验性 ablation 基准模式 |
| `DUMP_SYSTEM_PROMPT` | `--dump-system-prompt` 命令 |
| `CHICAGO_MCP` | `--computer-use-mcp` 命令 |
| `DAEMON` | `--daemon-worker` 和 `daemon` 子命令 |
| `BRIDGE_MODE` | `remote-control` 及其别名 |
| `BG_SESSIONS` | 后台会话管理命令 |
| `TEMPLATES` | 模板任务命令 |
| `BYOC_ENVIRONMENT_RUNNER` | `environment-runner` 子命令 |
| `SELF_HOSTED_RUNNER` | `self-hosted-runner` 子命令 |

## 配置项与默认值

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `COREPACK_ENABLE_AUTO_PIN` | 强制设为 `'0'` | 禁用 corepack 自动固定 |
| `CLAUDE_CODE_REMOTE` | - | 为 `'true'` 时设置 8GB 堆内存上限 |
| `CLAUDE_CODE_ABLATION_BASELINE` | - | 存在时启用 L0 ablation 基准实验 |
| `CLAUDE_CODE_SIMPLE` | - | `--bare` 标志存在时设为 `'1'` |
| `NODE_OPTIONS` | - | CCR 环境中被追加 `--max-old-space-size=8192` |

## 边界 Case 与注意事项

- **`--version` 严格匹配**：只有当 `args.length === 1` 时才触发版本快速路径，即 `claude --version --other-flag` 不会走快速路径，而是进入完整 CLI
- **Bridge 认证顺序依赖**：`getBridgeDisabledReason()` 依赖 GrowthBook 的用户上下文，因此 OAuth token 检查**必须**在 GrowthBook 门控检查之前执行（`cli.tsx:133-136` 注释详细说明了原因）
- **Daemon worker 无配置加载**：`--daemon-worker` 路径刻意跳过 `enableConfigs()` 和 analytics 初始化以保持精简，如果 worker 需要这些能力需自行初始化
- **模板任务强制退出**：`new`/`list`/`reply` 路径使用 `process.exit(0)` 而非 `return`，因为 Ink TUI 可能持有事件循环句柄
- **tmux worktree 降级**：如果 `execIntoTmuxWorktree()` 处理失败，会回退到正常 CLI 流程而非直接报错退出
- **`--update`/`--upgrade` 重写**：通过直接修改 `process.argv` 数组将错误的 flag 格式重定向到正确的 `update` 子命令
- **`--bare` 提前生效**：`CLAUDE_CODE_SIMPLE` 在模块 eval 阶段就必须可用，因此在快速路径检查完成后、`main.tsx` 导入前就设置
- **所有动态导入都是 `await import()`**：整个文件除了 `bun:bundle` 的 `feature` 函数外没有任何静态导入，这是实现零导入快速路径的关键设计