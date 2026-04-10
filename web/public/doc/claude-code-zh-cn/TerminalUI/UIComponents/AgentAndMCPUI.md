# Agent 管理与 MCP 服务器管理 UI

## 概述与职责

AgentAndMCPUI 模块是 Claude Code 终端界面中负责 **Agent 生命周期管理**和 **MCP（Model Context Protocol）服务器管理**的 UI 组件集合。它隶属于 `TerminalUI > UIComponents` 层级，基于 React/Ink 终端渲染框架构建，为用户提供完整的键盘导航式交互界面。

该模块包含四个子目录和四个独立对话框组件：

| 子目录 | 职责 | 核心组件数 |
|--------|------|-----------|
| `agents/` | Agent 创建、查看、编辑、删除的完整生命周期管理 | 13 个组件 + 12 步创建向导 |
| `mcp/` | MCP 服务器连接管理、工具浏览、认证流程 | 12 个组件 |
| `skills/` | 技能菜单展示 | 1 个组件 |
| `grove/` | Anthropic 条款与隐私政策展示 | 1 个组件 |

同级兄弟模块包括 InkFramework（底层渲染引擎）、Hooks（行为逻辑）、Screens（REPL 主屏幕）、StateAndContext（全局状态）、Keybindings（快捷键系统）、InteractionModes（Vim 模式等）。

---

## Agent 管理系统

### 架构总览

Agent 管理采用**状态机驱动**的导航模式，由 `ModeState` 联合类型定义六种页面状态：`main-menu`、`list-agents`、`agent-menu`、`view-agent`、`create-agent`、`edit-agent`、`delete-confirm`。每个状态对应一个 UI 组件，通过 `previousMode` 字段实现回退导航。

```
AgentsMenu (入口，状态机调度)
  ├─ AgentsList (列表展示)
  ├─ AgentDetail (详情查看)
  ├─ AgentEditor (编辑器)
  │   ├─ ToolSelector (工具选择)
  │   ├─ ModelSelector (模型选择)
  │   └─ ColorPicker (颜色选择)
  ├─ CreateAgentWizard (创建向导)
  │   └─ 11-12 步向导流程
  └─ 删除确认对话框
```

### 关键流程：Agent 创建向导

创建向导是整个模块最复杂的流程，由 `CreateAgentWizard` 编排 11-12 个步骤（记忆步骤取决于 `isAutoMemoryEnabled()` 特性门控）。

**完整步骤流（`src/components/agents/new-agent-creation/CreateAgentWizard.tsx`）：**

1. **LocationStep**（步骤 0）：选择 Agent 存储位置——项目级 `.claude/agents/` 或用户级 `~/.claude/agents/`
2. **MethodStep**（步骤 1）：选择创建方式——"Generate with Claude"（推荐）或"Manual configuration"
3. **GenerateStep**（步骤 2）：AI 生成模式——用户描述需求后调用 Claude API 自动生成 `agentType`、`whenToUse`、`systemPrompt`，完成后跳转到步骤 6（ToolsStep）
4. **TypeStep**（步骤 3）：手动输入唯一标识符，3-50 字符，仅字母数字和连字符，由 `validateAgentType()` 校验
5. **PromptStep**（步骤 4）：编写系统提示词，支持 Ctrl+G 调用外部编辑器
6. **DescriptionStep**（步骤 5）：描述 Agent 的使用场景（"When should Claude use this agent?"）
7. **ToolsStep**（步骤 6）：通过 `ToolSelector` 选择可用工具（分类为 READ_ONLY、EDIT、EXECUTION、MCP、OTHER）
8. **ModelStep**（步骤 7）：通过 `ModelSelector` 选择 Claude 模型
9. **ColorStep**（步骤 8）：选择 Agent 标识颜色，**同时组装最终的 `finalAgent` 对象**
10. **MemoryStep**（步骤 9，可选）：选择记忆作用域（user/project/local/none），为系统提示词追加记忆指令
11. **ConfirmStepWrapper → ConfirmStep**（最终步骤）：预览完整配置，执行 `validateAgent()` 校验，支持"保存"或"保存并在编辑器中打开"

**生成模式与手动模式的分支路径：**

- 选择 "Generate with Claude" → GenerateStep（调用 API）→ 跳转到 ToolsStep（步骤 6）
- 选择 "Manual" → 直接跳转到 TypeStep（步骤 3）→ 顺序执行后续步骤

> 源码位置：`src/components/agents/new-agent-creation/wizard-steps/MethodStep.tsx`，生成跳转 `goNext()`，手动跳转 `goToStep(3)`

### 关键流程：Agent 编辑

`AgentEditor`（`src/components/agents/AgentEditor.tsx`）提供四项编辑能力：

1. **Open in editor**：调用外部编辑器打开 Agent 的 Markdown 文件
2. **Edit tools**：切换到 `ToolSelector` 子视图
3. **Edit model**：切换到 `ModelSelector` 子视图
4. **Edit color**：切换到 `ColorPicker` 子视图

编辑操作通过 `updateAgentFile()` 持久化到磁盘，并同步更新 AppState 中的 `agentDefinitions`。仅允许编辑自定义 Agent（非 built-in、非 plugin、非 flagSettings 来源）。

### Agent 文件格式与持久化

Agent 以 **Markdown + YAML frontmatter** 格式存储（`src/components/agents/agentFileUtils.ts`）：

```markdown
---
agentType: code-reviewer
whenToUse: "When reviewing pull requests"
tools: [Grep, Read, Glob]
model: claude-sonnet-4-6
color: blue
memory: project
---

You are a code review expert...
```

关键文件操作函数：

| 函数 | 说明 |
|------|------|
| `formatAgentAsMarkdown()` | 将 Agent 数据序列化为 Markdown 格式 |
| `saveAgentToFile()` | 创建新 Agent 文件，确保目录存在，使用 fsync 保证数据安全 |
| `updateAgentFile()` | 更新已有 Agent 文件内容 |
| `deleteAgentFromFile()` | 删除 Agent 文件，优雅处理 ENOENT |
| `getNewAgentFilePath()` / `getActualAgentFilePath()` | 计算文件路径 |

> 源码位置：`src/components/agents/agentFileUtils.ts:1-150`

### Agent 验证

`validateAgent()`（`src/components/agents/validateAgent.ts`）执行全面校验，返回 `AgentValidationResult`：

**错误（阻断保存）：**
- 缺少 `agentType`、`description`（whenToUse）、`systemPrompt`
- 使用了不存在的工具
- 系统提示词过短
- 标识符格式不合法

**警告（不阻断）：**
- 描述过短或过长
- 未选择任何工具
- 提示词过长
- 与其他来源的 Agent 同名（覆盖/遮蔽检测）

### AI Agent 生成

`generateAgent()`（`src/components/agents/generateAgent.ts`）调用 Claude API 自动生成 Agent 配置：

- 使用精心设计的 `AGENT_CREATION_SYSTEM_PROMPT`（6 步流程：提取核心意图、设计专家人格、架构指令、优化性能、创建标识符、生成描述）
- 传入已有标识符列表避免冲突
- 返回 `{ identifier, whenToUse, systemPrompt }`
- 支持通过 AbortController 取消生成

### 类型定义

`src/components/agents/types.ts` 定义了核心类型：

```typescript
// Agent 文件路径常量
const AGENT_PATHS = { FOLDER_NAME: '.claude', AGENTS_DIR: 'agents' }

// 导航状态机
type ModeState =
  | { mode: 'main-menu' }
  | { mode: 'list-agents'; source: SettingSource | 'all' | 'built-in' | 'plugin' }
  | { mode: 'agent-menu'; agent: AgentDefinition; previousMode: ModeState }
  | { mode: 'view-agent'; agent: AgentDefinition; previousMode: ModeState }
  | { mode: 'create-agent' }
  | { mode: 'edit-agent'; agent: AgentDefinition; previousMode: ModeState }
  | { mode: 'delete-confirm'; agent: AgentDefinition; previousMode: ModeState }

// 校验结果
type AgentValidationResult = { isValid: boolean; warnings: string[]; errors: string[] }
```

---

## MCP 服务器管理系统

### 架构总览

MCP 管理以 `MCPSettings` 为入口，通过 `MCPViewState` 联合类型管理五种视图状态：

```
MCPSettings (入口，视图状态调度)
  ├─ MCPListPanel (服务器列表，按 scope 分组)
  ├─ MCPStdioServerMenu (本地 stdio 服务器菜单)
  ├─ MCPRemoteServerMenu (远程 HTTP/SSE/Claude.ai 服务器菜单)
  ├─ MCPAgentServerMenu (Agent 内嵌 MCP 服务器菜单)
  ├─ MCPToolListView (工具列表浏览)
  └─ MCPToolDetailView (工具详情)
```

### 关键流程：服务器列表与导航

`MCPSettings`（`src/components/mcp/MCPSettings.tsx`）在挂载时：

1. 从 AppState 获取所有 MCP 客户端连接
2. 调用 `extractAgentMcpServers()` 从 Agent 定义中提取内嵌 MCP 服务器
3. 为每个服务器构建 `ServerInfo` 对象，包含传输类型和认证状态
4. 根据 `MCPViewState` 渲染对应视图

`MCPListPanel`（`src/components/mcp/MCPListPanel.tsx`）按配置作用域分组展示服务器：

- 作用域顺序：`project → local → user → enterprise`
- 每组内按字母序排列
- Claude.ai 代理服务器单独展示
- 显示配置解析警告（`McpParsingWarnings`）
- 支持键盘上下导航、Enter 选择、Esc 返回

### 关键流程：服务器认证

三种服务器类型菜单提供不同的认证流程：

**MCPStdioServerMenu**（`src/components/mcp/MCPStdioServerMenu.tsx`）：
- 本地运行的 stdio 服务器，无需网络认证
- 菜单操作：查看工具、重连、启用/禁用
- 集成 `useMcpReconnect()` 和 `useMcpToggleEnabled()` hooks

**MCPRemoteServerMenu**（`src/components/mcp/MCPRemoteServerMenu.tsx`）：
- 管理远程 HTTP/SSE/Claude.ai 代理服务器
- **标准 OAuth 流程**：调用 `performMCPOAuthFlow()`，支持手动回调 URL 输入，支持通过 AbortController 取消
- **Claude.ai 代理认证**：构建特定的认证 URL（使用组织 UUID 和服务器 ID），支持清除/撤销认证
- 按 'c' 键复制认证 URL 到剪贴板
- 菜单操作：查看工具、认证、清除认证、启用/禁用

**MCPAgentServerMenu**（`src/components/mcp/MCPAgentServerMenu.tsx`）：
- Agent frontmatter 中定义的 MCP 服务器
- 仅在 `needsAuth` 为 true 时显示认证选项
- 创建临时配置执行 OAuth 流程
- 服务器仅在 Agent 运行时连接

### 工具浏览

`MCPToolListView`（`src/components/mcp/MCPToolListView.tsx`）：
- 按服务器名过滤工具列表
- 提取工具显示名，附加注解标记（read-only 绿色、destructive 红色、open-world）
- 支持选择查看详情

`MCPToolDetailView`（`src/components/mcp/MCPToolDetailView.tsx`）：
- 异步加载工具描述（`tool.description({})`）
- 展示完整描述和注解标记

### 辅助组件

| 组件 | 位置 | 职责 |
|------|------|------|
| `MCPReconnect` | `mcp/MCPReconnect.tsx` | 自动发起重连，显示四种结果（connected/needs-auth/failed/pending） |
| `CapabilitiesSection` | `mcp/CapabilitiesSection.tsx` | 展示服务器能力摘要（tools/resources/prompts） |
| `ElicitationDialog` | `mcp/ElicitationDialog.tsx` | MCP 信息采集对话框，支持 URL 模式和表单模式（文本/数字/枚举/多选/日期字段） |
| `McpParsingWarnings` | `mcp/McpParsingWarnings.tsx` | 按作用域分组展示 MCP 配置文件的解析错误和警告 |
| `reconnectHelpers` | `mcp/utils/reconnectHelpers.tsx` | `handleReconnectResult()` 和 `handleReconnectError()` 工具函数 |

### MCP 导出索引

`src/components/mcp/index.ts` 导出所有公开组件和类型：

- 组件：`MCPSettings`、`MCPListPanel`、`MCPStdioServerMenu`、`MCPRemoteServerMenu`、`MCPAgentServerMenu`、`MCPToolListView`、`MCPToolDetailView`、`MCPReconnect`
- 类型：`ServerInfo`、`AgentMcpServerInfo`、`MCPViewState`

---

## MCP 服务器对话框组件

四个独立对话框组件位于 `src/components/` 根目录，处理 MCP 服务器的审批和导入：

### MCPServerApprovalDialog

`src/components/MCPServerApprovalDialog.tsx`

首次发现 `.mcp.json` 中的服务器时弹出审批对话框，提供三个选项：
- "Use this and all future MCP servers in this project"（`yes_all`）→ 设置 `enableAllProjectMcpServers` 标记
- "Use this MCP server"（`yes`）→ 加入 `enabledMcpjsonServers`
- "Continue without using this MCP server"（`no`）→ 加入 `disabledMcpjsonServers`

### MCPServerMultiselectDialog

`src/components/MCPServerMultiselectDialog.tsx`

批量审批多个 MCP 服务器的多选对话框。将用户选择分区为已批准和已拒绝列表，分别更新设置。按 Esc 自动拒绝所有服务器。

### MCPServerDesktopImportDialog

`src/components/MCPServerDesktopImportDialog.tsx`

从桌面端/VS Code 配置导入 MCP 服务器到 Claude Code。检测服务器名冲突并自动追加 `_1`、`_2` 后缀重命名。多选对话框选择导入目标。

### MCPServerDialogCopy

`src/components/MCPServerDialogCopy.tsx`

可复用的安全警告文本组件："MCP servers may execute code or access system resources"，附带 MCP 文档链接。被上述对话框共享引用。

---

## Skills 菜单

`SkillsMenu`（`src/components/skills/SkillsMenu.tsx`）展示所有可用技能的分组列表：

- 从命令列表中过滤出技能类型（`PromptCommand`）
- 按来源分组：policy/user/project/local/flag settings、plugin、MCP
- 每组显示来源标题和路径信息（MCP 显示服务器名，文件类显示文件系统路径）
- 估算并展示每个技能的 Token 用量
- 组内按字母序排列

---

## Grove 组件

`Grove`（`src/components/grove/Grove.tsx`）展示 Anthropic 条款与隐私政策通知：

- 根据宽限期（2025-10-08）显示不同内容
- 用户可选择：接受并 opt-in 训练改进、接受并 opt-out、延期决定
- 支持三种展示位置：`settings`、`policy_update_modal`、`onboarding`
- 返回 `GroveDecision` 类型：`'accept_opt_in' | 'accept_opt_out' | 'defer' | 'escape' | 'skip_rendering'`
- 记录分析事件

---

## 接口/类型定义

### 服务器信息类型体系

```typescript
type ServerInfo = {
  name: string;
  client: MCPServerConnection;
  scope: ConfigScope;
  transport: 'stdio' | 'sse' | 'http' | 'claudeai-proxy';
  config: McpServerConfig;
  isAuthenticated?: boolean;
}

type AgentMcpServerInfo = {
  name: string;
  transport: 'http' | 'sse';
  url: string;
  needsAuth: boolean;
}

type MCPViewState =
  | { type: 'list'; defaultTab?: string }
  | { type: 'server-menu'; server: ServerInfo }
  | { type: 'agent-server-menu'; agentServer: AgentMcpServerInfo }
  | { type: 'server-tools'; server: ServerInfo }
  | { type: 'server-tool-detail'; server: ServerInfo; toolIndex: number }
```

### 工具分类（ToolSelector）

| 分类 | 包含工具 |
|------|---------|
| READ_ONLY | Glob, Grep, FileRead, WebFetch, WebSearch 等 |
| EDIT | FileEdit, FileWrite, NotebookEdit |
| EXECUTION | Bash, Tungsten |
| MCP | 从已连接 MCP 服务器动态获取 |
| OTHER | 未归类的其余工具 |

---

## 配置项与默认值

- **Agent 存储路径**：项目级 `.claude/agents/`，用户级 `~/.claude/agents/`（由 `AGENT_PATHS` 常量定义）
- **Agent 标识符约束**：3-50 字符，仅字母数字和连字符，首尾必须为字母数字
- **MCP 服务器作用域优先级**：`project → local → user → enterprise`
- **特性门控**：`isAutoMemoryEnabled()` 控制创建向导中记忆步骤的显示

---

## 边界 Case 与注意事项

- **Agent 覆盖检测**：当同名 Agent 存在于多个来源时（如 project 和 user），`AgentsList` 会显示覆盖/遮蔽警告
- **仅自定义 Agent 可编辑**：built-in、plugin、flagSettings 来源的 Agent 只能查看，不能编辑或删除
- **生成模式跳步**：AI 生成后跳过 TypeStep/PromptStep/DescriptionStep 直接到 ToolsStep（步骤 6），因为这些字段已由 API 生成
- **MCP 认证取消**：所有 OAuth 流程都通过 AbortController 支持中途取消，按 Esc 触发
- **服务器名冲突**：桌面导入对话框使用 `_1`/`_2` 后缀自动解决名称冲突
- **ElicitationDialog 双模式**：根据 MCP 事件的 `params.mode` 分发到 URL 对话框（浏览器回调）或表单对话框（内联输入）
- **Agent MCP 服务器特殊性**：Agent 内嵌的 MCP 服务器仅在 Agent 运行时连接，预先认证后不支持重连操作