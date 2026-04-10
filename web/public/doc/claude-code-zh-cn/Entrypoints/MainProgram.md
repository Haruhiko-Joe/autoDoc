# MainProgram — CLI 程序定义与会话初始化

## 概述与职责

MainProgram 模块是 Claude Code 应用的**主程序入口核心**，由两个文件组成：

- **`src/main.tsx`**（约 4680 行）：基于 Commander.js 的完整 CLI 程序定义，包含所有命令行选项、子命令注册、权限模式初始化、MCP 客户端连接、Agent 定义加载、以及交互式/非交互式两种运行路径的分发逻辑。
- **`src/setup.ts`**（约 477 行）：会话级初始化函数，负责 worktree 创建、终端备份恢复、钩子快照捕获、会话记忆初始化和后台预取任务。

在整体架构中，MainProgram 属于 **Entrypoints（入口层）** 模块组。它由 `cli.tsx` 调用，完成初始化后启动 CoreEngine（查询引擎和 REPL 主循环）、连接 Services（认证、分析等）、并依赖 TerminalUI（Ink 渲染终端界面）。

## 关键流程

### 1. 启动与早期初始化（main.tsx 顶层 + `main()` 函数）

模块加载时立即执行三项关键的**并行预取**（`src/main.tsx:9-20`）：

1. `profileCheckpoint('main_tsx_entry')` — 标记入口时间
2. `startMdmRawRead()` — 启动 MDM（移动设备管理）子进程读取策略配置
3. `startKeychainPrefetch()` — 并行预取 macOS 钥匙串中的 OAuth 和 API Key

这三项在 import 阶段（约 135ms）期间并行执行，避免后续同步读取阻塞。

`main()` 函数（`src/main.tsx:585`）是程序入口点：
1. 设置安全环境变量（防止 Windows PATH 劫持）
2. 注册信号处理器（SIGINT、exit cursor 恢复）
3. 处理特殊 URL 方案：`cc://`（直连）、`claude assistant`、`claude ssh` 等早期 argv 重写
4. 检测交互模式 vs 非交互模式（`-p`/`--print`/`--sdk-url`/非 TTY）
5. 确定客户端类型（cli、sdk-typescript、github-action、remote 等）
6. 早期加载 `--settings` 和 `--setting-sources` 标志
7. 调用 `run()` 进入主命令处理

### 2. Commander 程序构建与 preAction 钩子（`run()` 函数）

`run()` 函数（`src/main.tsx:884`）创建 Commander 程序并注册选项：

**preAction 钩子**（`src/main.tsx:907-967`）在任何命令执行前运行：
1. 等待 MDM 设置和钥匙串预取完成
2. 调用 `init()` 完成全局初始化（配置加载、环境变量应用）
3. 设置进程标题
4. 初始化分析 sink
5. 处理 `--plugin-dir` 内联插件
6. 运行数据迁移（版本号 `CURRENT_MIGRATION_VERSION = 11`）
7. 加载远程托管设置和策略限制

### 3. 主命令 action 处理器 — 选项解析与验证阶段

主命令 action（`src/main.tsx:1006`）处理超过 50 个 CLI 选项，关键步骤包括：

**权限模式初始化**（`src/main.tsx:1389-1411`）：
- 从 `--permission-mode`、`--dangerously-skip-permissions` 等标志解析权限模式
- 支持模式：`default`、`bypassPermissions`、`auto`、`plan`
- `--dangerously-skip-permissions` 在非沙箱/有网络环境中被拒绝

**MCP 配置解析**（`src/main.tsx:1414-1523`）：
- 解析 `--mcp-config`（支持 JSON 字符串和文件路径）
- 企业策略过滤（`filterMcpServersByPolicy`）
- Claude in Chrome 集成
- 保留名检查（`claude-in-chrome`、`computer-use` 等）

**工具权限上下文初始化**（`src/main.tsx:1747-1771`）：
- `initializeToolPermissionContext()` 合并 `--allowed-tools`、`--disallowed-tools`、`--tools` 列表
- 移除过度宽泛的 Bash 权限
- auto 模式下剥离危险权限

### 4. setup() 调用与并行加载

`setup()` 与命令加载**并行执行**（`src/main.tsx:1927-1934`）：

```
setup()              ← ~28ms, 主要是 UDS socket bind
getCommands()        ← 并行执行，加载命令注册表
getAgentDefinitions()← 并行执行，加载 Agent 定义
```

> 源码位置：`src/main.tsx:1927-1934`

当 `--worktree` 启用时无法并行，因为 `setup()` 会 `process.chdir()` 改变工作目录。

### 5. 交互式 vs 非交互式分支

**非交互式路径**（`--print` 模式，`src/main.tsx:2585-2861`）：
1. 应用完整环境变量（信任隐式建立）
2. 逐服务器增量连接 MCP（`connectMcpBatch`）
3. claude.ai MCP 有 5 秒超时上限
4. 创建 `headlessStore` 作为无头状态管理
5. 调用 `runHeadless()` 执行单次查询

**交互式路径**（`src/main.tsx:2218-3808`）：
1. 创建 Ink root 渲染上下文
2. `showSetupScreens()` — 信任对话框、OAuth、引导向导
3. 会话恢复：`--continue`、`--resume`、`--from-pr`、`--teleport`
4. MCP 资源预取（与信任对话框并行）
5. 构建 `initialState: AppState`（100+ 字段的完整应用状态）
6. 调用 `launchRepl()` 启动 REPL 主循环

### 6. setup() 函数流程（setup.ts）

`setup()` 函数（`src/setup.ts:56-477`）的完整流程：

1. **Node.js 版本检查**（≥18，`src/setup.ts:70-79`）
2. **UDS 消息服务器启动**（`src/setup.ts:89-102`）— 需等待 socket bind 完成
3. **Teammate 模式快照**（Agent Swarm 功能，`src/setup.ts:105-110`）
4. **终端备份恢复**（`src/setup.ts:115-158`）：
   - iTerm2 备份检测与恢复
   - Terminal.app 备份检测与恢复
   - 仅在交互式模式下执行
5. **设置工作目录**（`setCwd(cwd)`，`src/setup.ts:161`）— 其他代码依赖的关键调用
6. **钩子配置快照**（`captureHooksConfigSnapshot()`，`src/setup.ts:166`）
7. **FileChanged 钩子监视器初始化**（`src/setup.ts:172`）
8. **Worktree 创建**（`src/setup.ts:176-285`）：
   - 验证 git 仓库或 WorktreeCreate 钩子
   - 解析 PR 编号或自定义名称
   - `createWorktreeForSession()` 创建工作树
   - 可选创建 tmux 会话
   - `process.chdir()` 到工作树路径
   - 更新项目根路径和钩子快照
9. **后台任务注册**（`src/setup.ts:287-304`）：
   - `initSessionMemory()` — 同步注册会话记忆钩子
   - `initContextCollapse()` — 上下文折叠（特性门控）
   - `lockCurrentVersion()` — 防止其他进程删除当前版本
10. **预取任务**（`src/setup.ts:307-393`）：
    - 命令和插件预加载
    - 提交归因钩子注册
    - 会话文件访问分析
    - 团队记忆同步监视器
    - API Key 预取
    - Release Notes 检查
11. **权限模式安全验证**（`src/setup.ts:396-442`）：
    - bypass 模式下的 root 用户检测
    - 内部用户的沙箱+无网络要求
12. **上一次会话遥测日志**（`src/setup.ts:449-476`）

## 函数签名

### `main(): Promise<void>`

程序主入口。解析 argv、设置环境、分发到 `run()`。

> 源码位置：`src/main.tsx:585`

### `run(): Promise<CommanderCommand>`

构建 Commander 程序、注册所有选项和子命令、解析 argv 并执行对应 action。

> 源码位置：`src/main.tsx:884`

### `setup(cwd, permissionMode, allowDangerouslySkipPermissions, worktreeEnabled, worktreeName, tmuxEnabled, customSessionId?, worktreePRNumber?, messagingSocketPath?): Promise<void>`

会话级初始化。必须在依赖 cwd 或 worktree 的代码之前调用。

| 参数 | 类型 | 说明 |
|------|------|------|
| cwd | string | 当前工作目录 |
| permissionMode | PermissionMode | 权限模式 |
| allowDangerouslySkipPermissions | boolean | 是否允许跳过权限 |
| worktreeEnabled | boolean | 是否启用 worktree |
| worktreeName | string \| undefined | 自定义 worktree 名称 |
| tmuxEnabled | boolean | 是否创建 tmux 会话 |
| customSessionId | string \| null | 自定义会话 ID |
| worktreePRNumber | number | PR 编号（自动生成 worktree 名称） |
| messagingSocketPath | string | UDS socket 路径 |

> 源码位置：`src/setup.ts:56-477`

### `startDeferredPrefetches(): void`

在 REPL 首次渲染后启动的后台预取。包括用户信息、系统上下文、云凭据、文件计数、特性标志等。在 `--bare` 模式下跳过。

> 源码位置：`src/main.tsx:388-431`

## 命令行选项分类

### 核心运行模式

| 选项 | 说明 |
|------|------|
| `-p, --print` | 非交互式模式，输出后退出 |
| `--bare` | 最小模式，跳过钩子/LSP/插件/CLAUDE.md 等 |
| `--init-only` | 仅运行 Setup 和 SessionStart 钩子后退出 |
| `--output-format` | 输出格式：text/json/stream-json |
| `--input-format` | 输入格式：text/stream-json |

### 模型与推理

| 选项 | 说明 |
|------|------|
| `--model <model>` | 指定模型（别名如 'sonnet' 或完整 ID） |
| `--effort <level>` | 推理力度：low/medium/high/max |
| `--thinking <mode>` | 思考模式：enabled/adaptive/disabled |
| `--fallback-model` | 过载时的回退模型 |
| `--agent <agent>` | 指定当前会话的 Agent |

### 权限与安全

| 选项 | 说明 |
|------|------|
| `--permission-mode <mode>` | 权限模式（default/bypassPermissions/auto/plan） |
| `--dangerously-skip-permissions` | 跳过所有权限检查（仅限沙箱） |
| `--allowed-tools` | 允许的工具白名单 |
| `--disallowed-tools` | 禁止的工具黑名单 |

### 会话管理

| 选项 | 说明 |
|------|------|
| `-c, --continue` | 继续当前目录最近的会话 |
| `-r, --resume [id]` | 按 ID 恢复会话或打开选择器 |
| `--fork-session` | 恢复时创建新会话 ID |
| `--session-id <uuid>` | 指定会话 UUID |
| `-n, --name <name>` | 设置会话显示名称 |

### MCP 与工具配置

| 选项 | 说明 |
|------|------|
| `--mcp-config <configs...>` | 加载 MCP 服务器配置 |
| `--strict-mcp-config` | 仅使用 --mcp-config 的服务器 |
| `--tools <tools...>` | 指定可用工具列表 |
| `--system-prompt` | 自定义系统提示词 |
| `--append-system-prompt` | 追加系统提示词 |

### Worktree 与远程

| 选项 | 说明 |
|------|------|
| `-w, --worktree [name]` | 创建 git worktree |
| `--tmux` | 为 worktree 创建 tmux 会话 |
| `--remote [description]` | 创建远程 CCR 会话 |
| `--teleport [session]` | 恢复 teleport 会话 |

## 子命令注册

在非 print 模式下，`run()` 注册以下子命令组（`src/main.tsx:3892-4510`）：

- **`claude mcp`**：serve/add/remove/list/get/add-json/add-from-claude-desktop/reset-project-choices
- **`claude auth`**：login/status/logout
- **`claude plugin`**：validate/list/install/uninstall/enable/disable/update + marketplace 子命令
- **`claude agents`**：列出配置的 Agent
- **`claude setup-token`**：设置长期认证令牌
- **`claude install`**：安装原生构建
- **`claude auto-mode`**（特性门控）：defaults/config/critique
- **`claude remote-control`**（特性门控）：远程控制模式
- **`claude open`**（特性门控）：cc:// URL 直连
- **`claude ssh`**（特性门控）：SSH 远程会话
- **`claude task`**（特性门控）：任务管理（create/list/get/update/dir）
- **`claude completion`**：Shell 自动补全脚本生成

## 配置项与环境变量

| 环境变量 | 说明 |
|----------|------|
| `CLAUDE_CODE_SIMPLE` | `--bare` 模式自动设置为 `1` |
| `CLAUDE_CODE_ENTRYPOINT` | 入口类型：cli/sdk-cli/mcp/local-agent 等 |
| `CLAUDE_CODE_COORDINATOR_MODE` | 启用协调器模式工具过滤 |
| `CLAUDE_CODE_PROACTIVE` | 启用主动模式 |
| `CLAUDE_CODE_SESSION_ACCESS_TOKEN` | 会话访问令牌 |
| `CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES` | SDK 模式下启用增量消息 |
| `ANTHROPIC_MODEL` | 指定模型（同 `--model`） |
| `MAX_THINKING_TOKENS` | 最大思考 token 数 |

## 边界 Case 与注意事项

- **`--bare` 模式**是一个"大开关"：它设置 `CLAUDE_CODE_SIMPLE=1` 并在代码各处通过 `isBareMode()` 跳过大量非核心功能（钩子、LSP、插件同步、归因、自动记忆、后台预取、MCP 自动发现等）。适用于脚本化/SDK 调用场景。

- **setup() 必须在 setCwd() 之后、getCommands() 之前调用**。它的内部顺序有严格依赖——`captureHooksConfigSnapshot()` 必须在 `setCwd()` 之后，worktree 创建必须在 `getCommands()` 之前（否则 `/eject` 命令不可用）。

- **print 模式跳过子命令注册**（`src/main.tsx:3875-3890`）：commander 在 `-p` 模式下直接路由到默认 action，跳过 52 个子命令的注册以节省约 65ms 启动时间。

- **信任边界**：交互式模式下，LSP 初始化、环境变量应用、git 命令预取等都**延迟到信任对话框接受后**。非交互模式隐式信任（如文档所述）。

- **MCP 连接策略**：交互式模式下 MCP 连接不阻塞 REPL 渲染；print 模式下全部等待连接（单次查询需要工具就绪）。claude.ai MCP 有 5 秒超时保护。

- **数据迁移**（`CURRENT_MIGRATION_VERSION = 11`，`src/main.tsx:325-352`）：每次启动检查版本号，执行所有累积迁移（模型名称更新、设置结构变化等）。迁移是幂等的。

- **Worktree 模式**下 `setup()` 会执行 `process.chdir()`，所有后续路径解析都基于新的工作目录。同时会重新读取设置文件并更新钩子快照。