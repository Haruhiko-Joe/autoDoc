# 帮助与杂项命令集（HelpAndMiscCommands）

## 概述与职责

本模块属于 **CoreEngine → CommandSystem** 层级，是 Claude Code 斜杠命令系统中的"帮助、反馈与杂项"命令集合。它包含约 15 个命令，覆盖以下功能域：

- **用户辅助**：帮助信息、反馈提交、快速备注、正向反馈
- **会话管理**：任务列表、技能列表、建议模型配置
- **项目初始化**：CLAUDE.md 生成、验证器技能创建
- **远程交互**：会话分享、传送、自动修复 PR、Issue 管理
- **内部调试**：桥接故障注入（bridge-kick）
- **实验性特性**：简洁模式（brief）、深度规划（ultraplan）

同级模块（CommandSystem 的其他子节点）包括 `/compact`、`/config`、`/commit`、`/mcp`、`/review` 等更聚焦的命令组。本模块的命令相对松散，主要为用户提供辅助工具和内部诊断能力。

---

## 命令总览

| 命令 | 类型 | 别名 | 描述 | 门控条件 |
|------|------|------|------|----------|
| `/help` | `local-jsx` | - | 显示帮助信息和可用命令 | 始终可用 |
| `/feedback` | `local-jsx` | `/bug` | 提交 Claude Code 反馈 | 非 Bedrock/Vertex/Foundry，非 ant 用户，策略允许 |
| `/btw` | `local-jsx` | - | 不中断主对话的快速旁路提问 | 始终可用 |
| `/good-claude` | - | - | 正向反馈（已禁用存根） | `isEnabled: () => false` |
| `/tasks` | `local-jsx` | `/bashes` | 列出和管理后台任务 | 始终可用 |
| `/skills` | `local-jsx` | - | 列出可用技能 | 始终可用 |
| `/advisor` | `local` | - | 配置建议模型 | `canUserConfigureAdvisor()` |
| `/issue` | - | - | Issue 管理（已禁用存根） | `isEnabled: () => false` |
| `/autofix-pr` | - | - | 自动修复 PR（已禁用存根） | `isEnabled: () => false` |
| `/teleport` | - | - | 传送（已禁用存根） | `isEnabled: () => false` |
| `/share` | - | - | 分享会话（已禁用存根） | `isEnabled: () => false` |
| `/init` | `prompt` | - | 初始化 CLAUDE.md 和可选技能/hooks | 始终可用 |
| `/init-verifiers` | `prompt` | - | 创建验证器技能 | 始终可用 |
| `/bridge-kick` | `local` | - | 注入桥接故障用于恢复测试 | `USER_TYPE === 'ant'` |
| `/brief` | `local-jsx` | - | 切换简洁模式 | 特性门控 `KAIROS`/`KAIROS_BRIEF` + GrowthBook 配置 |
| `/ultraplan` | `local-jsx` | - | 远程深度规划（Opus 模型） | 仅 ant 内部构建 |

---

## 关键流程 Walkthrough

### 1. `/help` — 帮助信息展示

最简单的命令之一。`call` 函数渲染 `<HelpV2>` 组件，将当前可用命令列表传入：

```typescript
// src/commands/help/help.tsx:4-9
export const call: LocalJSXCommandCall = async (
  onDone,
  { options: { commands } },
) => {
  return <HelpV2 commands={commands} onClose={onDone} />
}
```

命令注册为 `local-jsx` 类型，意味着它返回 React JSX 节点，由 Ink 终端 UI 渲染。`HelpV2` 组件（定义在 `src/components/HelpV2/`）负责格式化和展示所有命令。

### 2. `/feedback` — 反馈提交

反馈命令有较复杂的启用条件，排除了以下场景（`src/commands/feedback/index.ts:12-22`）：

- 使用 Bedrock / Vertex / Foundry 等第三方 API 的用户
- 被 `DISABLE_FEEDBACK_COMMAND` 或 `DISABLE_BUG_COMMAND` 环境变量禁用
- 隐私级别为"仅必要流量"
- Anthropic 内部员工（`USER_TYPE === 'ant'`）
- 策略不允许产品反馈

该命令导出一个共享函数 `renderFeedbackComponent()`（`src/commands/feedback/feedback.tsx:8-18`），支持复用渲染 `<Feedback>` 组件。参数包括：
- `onDone` 回调
- `abortSignal` 用于取消
- `messages` 当前对话消息（作为反馈上下文附带）
- `initialDescription` 初始描述文本（从命令参数传入）
- `backgroundTasks` 当前后台任务信息

### 3. `/btw` — 快速旁路提问

`/btw` 是一个 `immediate: true` 的命令，表示无需等待模型响应即可执行。它接受一个 `<question>` 参数，创建一个**独立的侧问（side question）**会话：

- 构建独立的 `CacheSafeParams`，包含系统提示词和用户上下文（`src/commands/btw/btw.tsx:86-94`）
- 调用 `runSideQuestion()` 向模型发起独立查询
- 渲染一个带滚动功能的 `BtwSideQuestion` 组件，支持上下键滚动、Escape/Enter 关闭
- 响应以 Markdown 格式展示，不会影响主对话上下文

### 4. `/advisor` — 建议模型配置

`/advisor` 允许用户配置一个"建议者"模型，该模型在支持的场景下为主模型提供辅助建议。核心流程（`src/commands/advisor.ts:16-94`）：

1. **无参数调用**：显示当前 advisor 状态（未设置 / 已设置但不活跃 / 已设置）
2. **`/advisor unset` 或 `/advisor off`**：清除 advisor 模型配置，同时更新 `userSettings`
3. **`/advisor <model>`**：验证模型有效性，包括：
   - `normalizeModelStringForAPI()` 规范化模型标识
   - `validateModel()` 验证模型是否可用
   - `isValidAdvisorModel()` 检查是否支持作为 advisor
   - 写入 AppState 和持久化到 `userSettings`
4. 如果当前主模型不支持 advisor，会在设置成功时给出提示

### 5. `/init` — 项目初始化

这是一个 `prompt` 类型命令——它不直接执行代码，而是生成一段详细的提示词注入到对话中，让 Claude 自主完成初始化任务。

存在两个版本（`src/commands/init.ts:230-253`），通过特性门控 `NEW_INIT` 选择：

- **OLD_INIT_PROMPT**（旧版）：简单地分析代码库并创建 CLAUDE.md 文件
- **NEW_INIT_PROMPT**（新版，约 220 行）：一个完整的 8 阶段交互流程：
  1. 询问用户想设置什么（项目/个人 CLAUDE.md、技能/hooks）
  2. 使用子 Agent 扫描代码库
  3. 交互式补充信息
  4. 写入 CLAUDE.md
  5. 写入 CLAUDE.local.md（个人配置）
  6. 创建技能
  7. 建议额外优化（GitHub CLI、Linting、Hooks）
  8. 总结和后续步骤

新版仅对 ant 内部用户或设置了 `CLAUDE_CODE_NEW_INIT` 环境变量的用户可用。

命令还会调用 `maybeMarkProjectOnboardingComplete()` 标记项目引导完成。

### 6. `/init-verifiers` — 验证器技能创建

类似 `/init`，这也是一个 `prompt` 类型命令（`src/commands/init-verifiers.ts`），引导 Claude 执行 5 阶段任务：

1. **自动检测**：扫描项目类型（Web 应用、CLI 工具、API 服务）、技术栈、现有验证工具
2. **验证工具安装**：根据项目类型推荐 Playwright / Chrome DevTools / Tmux 等
3. **交互问答**：确认验证器名称、开发服务器配置、认证需求
4. **生成验证器技能**：写入 `.claude/skills/<verifier-name>/SKILL.md`
5. **确认创建**：说明验证器的使用方式

验证器命名约定：单项目用 `verifier-<type>`，多项目用 `verifier-<project>-<type>`。文件夹名中必须包含 "verifier" 以便 Verify Agent 自动发现。

### 7. `/bridge-kick` — 桥接故障注入

这是一个 **ant 内部专用** 的调试命令（`src/commands/bridge-kick.ts`），用于手动测试 Remote Control 桥接系统的恢复路径。支持的子命令（`src/commands/bridge-kick.ts:40-49`）：

| 子命令 | 作用 |
|--------|------|
| `close <code>` | 模拟 WebSocket 关闭事件 |
| `poll <status> [type]` | 下一次轮询抛出 `BridgeFatalError` |
| `poll transient` | 下一次轮询抛出 axios 风格的瞬态错误 |
| `register fail [N]` | 后续 N 次注册请求瞬态失败 |
| `register fatal` | 下一次注册返回 403 |
| `reconnect-session fail` | POST /bridge/reconnect 失败 |
| `heartbeat <status>` | 下一次心跳失败 |
| `reconnect` | 直接调用 `reconnectEnvironmentWithSession()` |
| `status` | 打印当前桥接状态 |

内部通过 `getBridgeDebugHandle()` 获取桥接调试句柄，调用 `injectFault()` 和 `fireClose()` 等方法注入故障。工作流程：连接 Remote Control → 执行子命令 → 通过 `tail -f debug.log` 观察恢复行为。

### 8. `/brief` — 简洁模式切换

特性门控命令，受 `KAIROS` / `KAIROS_BRIEF` 特性标志和 GrowthBook 远程配置 `tengu_kairos_brief_config` 控制（`src/commands/brief.ts:38-45`）。

切换流程（`src/commands/brief.ts:60-127`）：

1. 读取当前 `isBriefOnly` 状态并取反
2. **开启时**检查 `isBriefEntitled()` 权限——关闭始终允许（防止 GB 门控翻转导致用户被困）
3. 调用 `setUserMsgOptIn(newState)` 同步工具可用性（Brief Tool 仅在 brief 模式下可见）
4. 更新 AppState 的 `isBriefOnly`
5. 注入 `<system-reminder>` 元消息，明确告知模型切换状态——直接改变工具列表不够可靠，模型可能因惯性继续旧行为
6. 当 Kairos 活跃时跳过元消息注入（Kairos 系统提示词已强制要求使用 `SendUserMessage`）

### 9. `/ultraplan` — 远程深度规划

最复杂的命令之一（`src/commands/ultraplan.tsx`，约 470 行），仅对 ant 内部构建可用。它将规划任务卸载到 **Claude Code on the web**（CCR 远程会话），使用 Opus 模型进行深度规划。

核心入口 `launchUltraplan()`（`src/commands/ultraplan.tsx:234-293`）：

1. **防重入检查**：通过 `ultraplanSessionUrl` 和 `ultraplanLaunching` 状态防止重复启动
2. **空参数**：显示用法说明
3. **设置启动锁**：同步设置 `ultraplanLaunching = true`
4. **异步启动** `launchDetached()`：
   - 检查远程 Agent 资格（`checkRemoteAgentEligibility`）
   - 调用 `buildUltraplanPrompt()` 组装提示词（可选包含种子计划 `seedPlan`）
   - 通过 `teleportToRemote()` 创建远程 CCR 会话
   - 注册为 `RemoteAgentTask` 并启动轮询
5. **分离轮询** `startDetachedPoll()`（`src/commands/ultraplan.tsx:74-181`）：
   - 30 分钟超时
   - 轮询 `pollForApprovedExitPlanMode()`，监听计划审批
   - 计划批准后根据 `executionTarget` 分流：
     - `'remote'`：在 CCR 中直接执行，通知用户关注 PR 结果
     - 否则：设置 `ultraplanPendingChoice`，由 REPL 的 `UltraplanChoiceDialog` 处理"传送回本地"或其他选择
   - 失败时归档远程会话，清理状态

导出的 `stopUltraplan()` 函数（`src/commands/ultraplan.tsx:203-223`）用于中止进行中的 ultraplan，包括终止远程任务、清理 AppState、发送通知。

---

## 函数签名与关键导出

### `renderFeedbackComponent()`

```typescript
// src/commands/feedback/feedback.tsx:8-18
function renderFeedbackComponent(
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void,
  abortSignal: AbortSignal,
  messages: Message[],
  initialDescription?: string,
  backgroundTasks?: { [taskId: string]: { type: string; identity?: { agentId: string }; messages?: Message[] } }
): React.ReactNode
```

共享的 Feedback 组件渲染函数，被 `/feedback` 命令和其他需要反馈 UI 的场景复用。

### `launchUltraplan()`

```typescript
// src/commands/ultraplan.tsx:234-293
async function launchUltraplan(opts: {
  blurb: string;
  seedPlan?: string;
  getAppState: () => AppState;
  setAppState: (f: (prev: AppState) => AppState) => void;
  signal: AbortSignal;
  disconnectedBridge?: boolean;
  onSessionReady?: (msg: string) => void;
}): Promise<string>
```

Ultraplan 的共享入口，被斜杠命令、关键词触发器和计划审批对话框的"Ultraplan"按钮共用。

### `stopUltraplan()`

```typescript
// src/commands/ultraplan.tsx:203-223
async function stopUltraplan(
  taskId: string,
  sessionId: string,
  setAppState: (f: (prev: AppState) => AppState) => void
): Promise<void>
```

### `buildUltraplanPrompt()`

```typescript
// src/commands/ultraplan.tsx:63-73
function buildUltraplanPrompt(blurb: string, seedPlan?: string): string
```

组装发送给 CCR 的初始用户消息。如果有 `seedPlan`（从计划审批对话框传入），会作为待优化的草案前置。

---

## 类型与命令注册模式

所有命令都实现 `Command` 接口（`src/commands.js`），通过 `satisfies Command` 进行类型约束。主要使用三种命令类型：

| 类型 | 行为 | 典型命令 |
|------|------|----------|
| `local` | 执行同步/异步函数，返回文本结果 | `/advisor`, `/bridge-kick` |
| `local-jsx` | 返回 React JSX 节点，由 Ink 渲染 | `/help`, `/feedback`, `/btw`, `/tasks`, `/skills`, `/brief`, `/ultraplan` |
| `prompt` | 生成提示词注入对话，让 Claude 自主完成任务 | `/init`, `/init-verifiers` |

命令支持的可选属性：
- `aliases`：命令别名（如 `/feedback` 的别名 `/bug`，`/tasks` 的别名 `/bashes`）
- `immediate: true`：不等待模型响应即执行（`/btw`, `/brief`）
- `isEnabled`：动态启用条件
- `isHidden`：对用户隐藏但仍可调用
- `argumentHint`：参数提示字符串
- `supportsNonInteractive`：是否支持非交互模式

---

## 配置项与门控

### GrowthBook 特性门控

| 特性标志 | 控制目标 |
|----------|----------|
| `tengu_kairos_brief_config.enable_slash_command` | `/brief` 命令可见性 |
| `tengu_kairos_brief` | Brief Tool 可用性（5 分钟 TTL 的 kill switch） |
| `tengu_ultraplan_model` | Ultraplan 使用的模型（默认 Opus 4.6） |
| `NEW_INIT` | `/init` 使用新版 8 阶段流程 |
| `KAIROS` / `KAIROS_BRIEF` | Brief 特性总开关 |

### 环境变量

| 变量 | 作用 |
|------|------|
| `CLAUDE_CODE_USE_BEDROCK` / `VERTEX` / `FOUNDRY` | 禁用 `/feedback`（第三方 API 无法接收反馈） |
| `DISABLE_FEEDBACK_COMMAND` / `DISABLE_BUG_COMMAND` | 显式禁用反馈命令 |
| `USER_TYPE=ant` | 启用 `/bridge-kick`、新版 `/init`、`/ultraplan` |
| `CLAUDE_CODE_NEW_INIT` | 非 ant 用户启用新版 `/init` |
| `ULTRAPLAN_PROMPT_FILE` | ant 构建时覆盖 ultraplan 提示词文件路径 |

---

## 已禁用的存根命令

以下命令在当前代码中为**存根实现**（`src/commands/*/index.js` 导出 `{ isEnabled: () => false, isHidden: true, name: 'stub' }`），曾经或未来可能有完整实现：

- `/good-claude` — 正向反馈
- `/issue` — Issue 管理
- `/autofix-pr` — 自动修复 PR
- `/teleport` — 传送到远程会话
- `/share` — 分享当前会话

这些命令的 `isHidden: true` 确保它们不会出现在 `/help` 列表中。

---

## 边界 Case 与注意事项

1. **Brief 模式的单向门控**：开启 brief 需要 `isBriefEntitled()` 检查，但关闭始终允许。这是为了防止 GrowthBook 门控在会话中途翻转时用户被困在 brief 模式中（`src/commands/brief.ts:67-68`）。

2. **Ultraplan 防重入**：通过 `ultraplanLaunching`（同步）和 `ultraplanSessionUrl`（异步设置）两层状态防止重复启动。`ultraplanLaunching` 是一个短暂的"乐观锁"，在 `teleportToRemote` 完成前阻止第二次点击。

3. **Ultraplan 孤儿会话处理**：如果 `teleportToRemote` 成功但后续步骤失败，会主动归档远程会话以避免 30 分钟的孤儿进程（`src/commands/ultraplan.tsx:392-401`）。

4. **Brief 配置的 Zod 校验**：`briefConfigSchema` 使用 Zod 验证 GrowthBook 返回值，防止错误的远程配置推送导致崩溃——不合法的配置会回退到 `DEFAULT_BRIEF_CONFIG`（`src/commands/brief.ts:22-31`）。

5. **`/btw` 的独立会话**：旁路提问使用 `runSideQuestion()` 创建完全独立的模型调用，不会影响主对话历史。但它会复用当前会话的系统提示词和用户上下文以保持一致性。

6. **`/init` 的提示词注意事项**：新版 `/init` 提示词非常长（约 220 行），作为单个用户消息注入对话。这意味着它消耗大量 token，但通过 `contentLength: 0` 标记为动态内容以避免静态计算偏差。