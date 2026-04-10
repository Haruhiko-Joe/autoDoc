# 用户交互与协作工具集（InteractionTools）

## 概述与职责

InteractionTools 是 Claude Code 工具系统（ToolSystem）中负责**用户交互、多 Agent 协作和运行时管理**的工具子集。它位于 ToolSystem 模块内部，被 CoreEngine 的主查询循环调度执行。

在整体架构中，ToolSystem 是所有 40+ 内置工具的中央注册与执行框架。InteractionTools 承担了以下几类核心职责：

1. **技能调用**：SkillTool 桥接 SkillsAndPlugins 模块，将用户的 `/commit`、`/review-pr` 等斜杠命令路由到技能系统
2. **用户对话**：AskUserQuestionTool 和 BriefTool 实现模型与用户之间的结构化交互
3. **多 Agent 协作**：SendMessageTool、TeamCreateTool、TeamDeleteTool 构成 Agent Swarm 协议的工具层
4. **运行时配置**：ConfigTool 提供对主题、模型、权限模式等设置的读写能力
5. **定时调度**：CronCreate/Delete/ListTool 和 RemoteTriggerTool 管理本地 Cron 任务和远程触发器
6. **辅助工具**：SleepTool、REPLTool、SyntheticOutputTool、StructuredOutput 等特性门控工具

同级兄弟模块包括文件操作工具（FileRead/Write/Edit）、搜索工具（Glob/Grep）、Shell 执行工具（Bash）、Agent 子任务工具（AgentTool）等。

---

## 关键流程

### 1. SkillTool：技能调用流程

SkillTool 是用户斜杠命令（`/commit`、`/review-pr` 等）的模型侧入口。

1. 模型发出 `Skill` 工具调用，传入 `{skill: "commit", args: "-m 'Fix bug'"}`
2. `validateInput()` 规范化名称（去除前导 `/`），通过 `getAllCommands()` 查找匹配的 Command 对象（`src/tools/SkillTool/SkillTool.ts:354-430`）
3. `checkPermissions()` 检查 deny/allow 规则，对仅含安全属性的技能自动放行（`skillHasOnlySafeProperties()`），否则弹出权限确认（`src/tools/SkillTool/SkillTool.ts:432-578`）
4. `call()` 根据技能的 `context` 属性分两条路径执行：
   - **inline 模式**（默认）：调用 `processPromptSlashCommand()` 展开技能 prompt，作为 `newMessages` 注入对话流。同时通过 `contextModifier` 修改 `allowedTools`、模型和 `effort` 等上下文
   - **fork 模式**（`context: 'fork'`）：调用 `executeForkedSkill()` 在隔离的子 Agent 中执行，通过 `runAgent()` 运行完整的查询循环，收集结果后返回

> 源码位置：`src/tools/SkillTool/SkillTool.ts:580-869`

**Prompt 预算管理**：`prompt.ts` 中的 `formatCommandsWithinBudget()` 将所有可用技能列表压缩到上下文窗口的 1% 以内（`SKILL_BUDGET_CONTEXT_PERCENT = 0.01`），bundled 技能保留完整描述，其余按比例截断（`src/tools/SkillTool/prompt.ts:70-171`）。

### 2. AskUserQuestionTool：结构化提问流程

1. 模型构造 1-4 个多选题（每题 2-4 个选项），通过 `questions` 数组传入
2. `checkPermissions()` 始终返回 `ask`，触发 UI 层的交互式选择组件
3. 用户选择后，答案通过 `answers` 字段（由权限组件注入）传回 `call()`
4. `call()` 直接返回 `{questions, answers, annotations}`，`mapToolResultToToolResultBlockParam()` 格式化为 `"User has answered..."` 反馈给模型

关键设计：该工具支持 `preview` 字段（markdown 或 HTML 片段），用于 UI 布局、代码片段等可视化比较场景。HTML 预览通过 `validateHtmlPreview()` 做安全检查，禁止 `<script>`、`<style>` 和完整文档标签。

> 源码位置：`src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx:109-245`

### 3. SendMessageTool：Agent 间消息路由

这是 Agent Swarm 协议的核心通信工具，支持多种消息类型和路由模式。

**消息路由逻辑**（`src/tools/SendMessageTool/SendMessageTool.ts:741-913`）：

1. **跨会话消息**（`bridge:` / `uds:` 前缀）：通过 Remote Control 桥接或 UDS socket 发送纯文本消息到其他 Claude 实例
2. **进程内子 Agent 路由**：查找 `appState.agentNameRegistry` 或 `toAgentId()` 匹配的本地 Agent 任务。运行中的 Agent 通过 `queuePendingMessage()` 排队；已停止的通过 `resumeAgentBackground()` 自动恢复
3. **广播**（`to: "*"`）：遍历 team 文件的所有成员（排除自身），逐一写入 mailbox
4. **点对点**：直接写入目标 teammate 的 mailbox 文件
5. **结构化消息**：`shutdown_request/response`、`plan_approval_response` 等协议消息，用于团队生命周期管理

**权限控制**：跨机器的 `bridge:` 消息需要显式用户同意（`safetyCheck`），防止跨机器 prompt 注入（`src/tools/SendMessageTool/SendMessageTool.ts:585-601`）。

### 4. TeamCreate/TeamDelete：Swarm 团队生命周期

**TeamCreateTool**（`src/tools/TeamCreateTool/TeamCreateTool.ts:74-150+`）：
1. 校验当前 leader 未加入其他团队
2. 生成唯一团队名称（冲突时用 word slug 替代）
3. 创建 team 文件（`~/.claude/teams/{name}/config.json`）和任务目录（`~/.claude/tasks/{name}/`）
4. 将 leader 注册为首个 member，更新 AppState 的 `teamContext`

**TeamDeleteTool**（`src/tools/TeamDeleteTool/TeamDeleteTool.ts:32-139`）：
1. 检查是否仍有活跃（`isActive !== false`）的非 leader 成员
2. 有活跃成员时拒绝删除并提示先发送 `shutdown_request`
3. 清理 team/task 目录、颜色分配、leader 状态，清空 AppState 中的 `teamContext` 和 `inbox`

### 5. ConfigTool：运行时配置管理

支持的设置项定义在 `supportedSettings.ts` 中的 `SUPPORTED_SETTINGS` 注册表，分为两类存储：

| 存储位置 | 示例设置 |
|---------|---------|
| Global（`~/.claude.json`） | theme, editorMode, verbose, autoCompactEnabled, teammateMode |
| Settings（`settings.json`） | model, permissions.defaultMode, language, alwaysThinkingEnabled |

**读写流程**（`src/tools/ConfigTool/ConfigTool.ts:111-411`）：
1. GET：从对应存储读取值，可选 `formatOnRead` 转换
2. SET：类型校验（boolean 强转）→ 选项校验 → 异步验证（如 model API 检查）→ 写入存储 → 同步到 AppState（`appStateKey` 机制，实现即时 UI 响应）

特殊处理：`voiceEnabled` 需要运行时 GrowthBook 门控和麦克风权限检查；`remoteControlAtStartup` 需要同步 `replBridgeEnabled` 到 AppState。

### 6. Cron 定时调度系统

三个工具协作管理本地 cron 任务：

- **CronCreateTool**：接受 5 字段 cron 表达式（本地时区），支持 `recurring`（自动 30 天过期）和 `durable`（持久化到 `.claude/scheduled_tasks.json`）两种模式。最多 50 个任务（`src/tools/ScheduleCronTool/CronCreateTool.ts:56-157`）
- **CronDeleteTool**：按 ID 取消任务。teammate 只能删除自己的 cron（`src/tools/ScheduleCronTool/CronDeleteTool.ts:35-95`）
- **CronListTool**：列出所有任务。teammate 只能看到自己的（`src/tools/ScheduleCronTool/CronListTool.ts:37-97`）

启用门控：`isKairosCronEnabled()` 组合构建时 `feature('AGENT_TRIGGERS')` 和运行时 `tengu_kairos_cron` GrowthBook 门。`CLAUDE_CODE_DISABLE_CRON` 环境变量可本地覆盖。

---

## 函数签名与参数说明

### SkillTool

```typescript
// 输入
{ skill: string, args?: string }
// 输出（inline 模式）
{ success: boolean, commandName: string, allowedTools?: string[], model?: string, status?: 'inline' }
// 输出（fork 模式）
{ success: boolean, commandName: string, status: 'forked', agentId: string, result: string }
```

### AskUserQuestionTool

```typescript
// 输入
{
  questions: Array<{
    question: string,          // 问题文本
    header: string,            // 芯片标签（≤12字符）
    options: Array<{ label: string, description: string, preview?: string }>,  // 2-4 个选项
    multiSelect?: boolean      // 允许多选
  }>,  // 1-4 个问题
  answers?: Record<string, string>,      // 由 UI 权限组件注入
  annotations?: Record<string, { preview?: string, notes?: string }>
}
```

### SendMessageTool

```typescript
// 输入
{
  to: string,      // teammate 名称 / "*"（广播） / "uds:path" / "bridge:session_id"
  summary?: string, // 5-10 字摘要（纯文本消息必填）
  message: string | { type: 'shutdown_request' | 'shutdown_response' | 'plan_approval_response', ... }
}
```

### ConfigTool

```typescript
// 输入
{ setting: string, value?: string | boolean | number }
// 输出
{ success: boolean, operation?: 'get' | 'set', setting?: string, value?: unknown, previousValue?: unknown, newValue?: unknown, error?: string }
```

### CronCreateTool

```typescript
// 输入
{ cron: string, prompt: string, recurring?: boolean, durable?: boolean }
// 输出
{ id: string, humanSchedule: string, recurring: boolean, durable?: boolean }
```

---

## 接口与类型定义

### SendMessageTool 输出类型联合

```typescript
type SendMessageToolOutput = MessageOutput | BroadcastOutput | RequestOutput | ResponseOutput

type MessageRouting = {
  sender: string, senderColor?: string,
  target: string, targetColor?: string,
  summary?: string, content?: string
}
```

> 源码位置：`src/tools/SendMessageTool/SendMessageTool.ts:92-131`

### SpawnTeammateConfig / SpawnOutput

```typescript
type SpawnTeammateConfig = {
  name: string, prompt: string, team_name?: string, cwd?: string,
  use_splitpane?: boolean, plan_mode_required?: boolean,
  model?: string, agent_type?: string, description?: string,
  invokingRequestId?: string
}

type SpawnOutput = {
  teammate_id: string, agent_id: string, name: string, color?: string,
  tmux_session_name: string, tmux_pane_id: string,
  team_name?: string, plan_mode_required?: boolean
}
```

> 源码位置：`src/tools/shared/spawnMultiAgent.ts:107-136`

---

## 共享模块与工具函数

### shared/spawnMultiAgent.ts

teammate 创建的核心实现，被 TeammateTool 和 AgentTool 共同使用。支持三种 spawn 模式：

1. **Split-pane**（默认）：在 tmux 或 iTerm2 中创建分屏视图，leader 在左、teammates 在右
2. **Separate window**（legacy）：每个 teammate 独占 tmux 窗口
3. **In-process**：同一 Node.js 进程内通过 AsyncLocalStorage 隔离运行

路由决策在 `handleSpawn()` 中完成：`isInProcessEnabled()` → 进程内；否则尝试 `detectAndGetBackend()` → 失败时自动回退到进程内（仅 `auto` 模式）。

> 源码位置：`src/tools/shared/spawnMultiAgent.ts:1040-1078`

### shared/gitOperationTracking.ts

Shell 无关的 git 操作检测与遥测。通过正则匹配 `git commit/push/cherry-pick/merge/rebase` 和 `gh pr create/edit/merge/comment/close/ready`，从命令文本和输出中提取 SHA、分支名、PR 号等信息。

关键函数：
- `detectGitOperation(command, output)` → 返回 `{commit?, push?, branch?, pr?}` 供 UI 摘要使用（`src/tools/shared/gitOperationTracking.ts:135-186`）
- `trackGitOperations(command, exitCode, stdout)` → 触发 OTLP 计数器和 analytics 事件

### utils.ts

两个工具函数，用于 SkillTool 等需要向对话流注入消息的工具：

- `tagMessagesWithToolUseID(messages, toolUseID)` — 为用户消息附加 `sourceToolUseID`，使其在工具 resolve 前保持暂态
- `getToolUseIDFromParentMessage(parentMessage, toolName)` — 从 assistant 消息中提取指定工具的 `tool_use` block ID

> 源码位置：`src/tools/utils.ts:1-41`

---

## 特性门控工具

### BriefTool（SendUserMessage）

模型向用户发送可见消息的主通道，在 chat 视图模式下是模型的"嘴"。启用条件由 `isBriefEnabled()` 统一管理：需要 build-time `feature('KAIROS')` 或 `feature('KAIROS_BRIEF')` + 用户 opt-in（`--brief`、`defaultView: 'chat'`等）+ GrowthBook 门控。

支持 `attachments`（文件路径列表），bridge 模式下自动上传到 private_api 获取 `file_uuid` 供 web 预览。

> 源码位置：`src/tools/BriefTool/BriefTool.ts:136-204`

### RemoteTriggerTool

对 claude.ai CCR 触发器 API 的工具封装，支持 list/get/create/update/run 操作。OAuth token 在进程内自动注入，不暴露到 shell。受 `tengu_surreal_dali` GrowthBook 门和 `allow_remote_sessions` 策略双重门控。

> 源码位置：`src/tools/RemoteTriggerTool/RemoteTriggerTool.ts:46-161`

### SleepTool

轻量等待工具，替代 `Bash(sleep ...)`，不占用 shell 进程。接收 `<tick>` 定期检查信号，可与其他工具并发执行。

### REPLTool

REPL 模式（默认对内部用户启用）下，Read/Write/Edit/Glob/Grep/Bash/NotebookEdit/Agent 这 8 个"原始工具"被隐藏，强制通过 REPL 批量执行。`isReplModeEnabled()` 受 `CLAUDE_CODE_REPL` 和 `CLAUDE_REPL_MODE` 环境变量控制。

> 源码位置：`src/tools/REPLTool/constants.ts:23-30`

### SyntheticOutputTool（StructuredOutput）

仅在非交互式会话（SDK/CLI）中启用，用于返回符合 JSON Schema 的结构化输出。支持 Ajv 验证和 WeakMap 缓存（避免重复编译 schema）。`createSyntheticOutputTool(jsonSchema)` 工厂函数创建带自定义 schema 验证的工具实例。

> 源码位置：`src/tools/SyntheticOutputTool/SyntheticOutputTool.ts:22-163`

---

## 测试工具

### TestingPermissionTool

仅在 `NODE_ENV === 'test'` 时启用的测试工具，`checkPermissions()` 始终返回 `ask`，用于 E2E 测试权限对话框流程。

> 源码位置：`src/tools/testing/TestingPermissionTool.tsx:12-73`

---

## 边界 Case 与注意事项

- **SkillTool 并发限制**：同一时间只能运行一个技能（inline 模式展开的 prompt 需要模型处理后才能继续）
- **SendMessageTool 跨会话安全**：`bridge:` 目标的消息需要 `safetyCheck` 级别权限确认，即使在 auto 模式下也不可绕过
- **AskUserQuestionTool 通道模式禁用**：当 `--channels` 激活（用户在 Telegram/Discord 上）时自动禁用，避免交互式对话挂起
- **CronCreateTool teammate 限制**：teammate 不能创建 `durable` 类型的 cron，因为 teammate 不跨会话持久化
- **ConfigTool 语音模式**：设置 `voiceEnabled = true` 需要多重前置检查（GrowthBook 门、OAuth 认证、录音工具可用性、麦克风权限）
- **BriefTool 附件上传**：best-effort 模式——上传失败不影响本地渲染，仅 web 预览不可用
- **spawnMultiAgent 自动回退**：auto 模式下 tmux/iTerm2 不可用时静默回退到 in-process；用户显式配置 tmux 时错误会传播