# 全局常量定义集合（Constants）

## 概述与职责

`src/constants/` 是 Claude Code 项目的**全局常量定义层**，位于 Infrastructure → ConfigAndSettings 模块下。该目录包含 21 个文件，约 2650 行代码，为整个应用提供纯数据常量和轻量配置函数。

作为基础设施层的一部分，Constants 模块被几乎所有上层模块引用——从核心引擎（CoreEngine）的系统提示词构建，到工具系统（ToolSystem）的限制约束，再到终端 UI（TerminalUI）的样式和符号显示。它与同级模块 TypesAndSchemas（提供类型定义）和 CommonUtilities（提供工具函数）配合，共同构成项目的底层基础。

该目录中的文件均为纯数据导出或轻量计算函数，不包含业务逻辑。

## 文件总览

| 文件 | 职责 |
|------|------|
| `apiLimits.ts` | Anthropic API 的硬性限制（图片、PDF、媒体数量） |
| `betas.ts` | Beta 特性 HTTP Header 标识 |
| `common.ts` | 日期工具函数（会话开始日期、月份年份） |
| `cyberRiskInstruction.ts` | 安全相关的行为边界指令 |
| `errorIds.ts` | 错误追踪的混淆标识符 |
| `figures.ts` | 终端 UI 的 Unicode 符号常量 |
| `files.ts` | 二进制文件扩展名集合与检测函数 |
| `github-app.ts` | GitHub Action 工作流模板和 PR 内容 |
| `keys.ts` | GrowthBook 特性开关客户端 Key |
| `messages.ts` | 通用消息常量 |
| `oauth.ts` | OAuth 多环境配置（生产/测试/本地） |
| `outputStyles.ts` | 输出风格配置（默认/Explanatory/Learning） |
| `product.ts` | 产品 URL 和远程会话环境判断 |
| `prompts.ts` | 系统提示词核心构建逻辑（最大文件） |
| `spinnerVerbs.ts` | 加载动画随机动词列表（~190 个） |
| `system.ts` | 系统提示词前缀与 Attribution Header |
| `systemPromptSections.ts` | 系统提示词分段缓存框架 |
| `toolLimits.ts` | 工具结果大小限制常量 |
| `tools.ts` | 工具可用性集合（Agent/协调器/异步允许列表） |
| `turnCompletionVerbs.ts` | 回合完成提示的过去式动词 |
| `xml.ts` | XML 标签名常量（命令、终端、任务通知等） |

## 关键流程 Walkthrough

### 系统提示词构建流程

系统提示词的构建是 Constants 模块最核心的功能，由 `prompts.ts` 中的 `getSystemPrompt()` 函数驱动（`src/constants/prompts.ts:444-577`）：

1. **简单模式检查**：若设置了 `CLAUDE_CODE_SIMPLE` 环境变量，直接返回精简提示词
2. **并行获取依赖**：同时获取 Skill 命令列表、输出风格配置、环境信息
3. **构建静态部分**（可跨组织缓存）：
   - 身份介绍（`getSimpleIntroSection`）—— 包含安全行为边界 `CYBER_RISK_INSTRUCTION`
   - 系统说明（`getSimpleSystemSection`）—— 工具权限、Hook 机制、标签约定
   - 任务执行指导（`getSimpleDoingTasksSection`）—— 代码风格、安全规范、交互原则
   - 风险操作守则（`getActionsSection`）—— 不可逆操作确认机制
   - 工具使用指导（`getUsingYourToolsSection`）—— 专用工具优先于 Bash
   - 语气风格（`getSimpleToneAndStyleSection`）—— 无 emoji、简洁、代码引用格式
   - 输出效率（`getOutputEfficiencySection`）—— 简洁直达要点
4. **插入动态边界标记**：`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`（`src/constants/prompts.ts:114-115`）将静态/动态内容分离，支持全局缓存
5. **构建动态部分**（通过 `systemPromptSections.ts` 的缓存框架管理）：
   - 会话特定指导、记忆、环境信息、语言偏好、输出风格、MCP 指令等
   - 使用 `resolveSystemPromptSections()` 统一解析，支持缓存/非缓存两种模式

### 系统提示词分段缓存机制

`systemPromptSections.ts` 提供了一个轻量的缓存框架（`src/constants/systemPromptSections.ts:1-68`）：

- `systemPromptSection(name, compute)` —— 创建可缓存的分段，计算一次后缓存直到 `/clear` 或 `/compact`
- `DANGEROUS_uncachedSystemPromptSection(name, compute, reason)` —— 创建每轮重新计算的分段，会破坏 prompt cache，需注明原因
- `resolveSystemPromptSections(sections)` —— 并行解析所有分段，命中缓存则跳过计算
- `clearSystemPromptSections()` —— 清除所有缓存和 Beta Header 锁存状态

## 函数签名与参数说明

### `getSystemPrompt(tools, model, additionalWorkingDirectories?, mcpClients?)`

主系统提示词构建函数，返回 `Promise<string[]>`。

| 参数 | 类型 | 说明 |
|------|------|------|
| `tools` | `Tools` | 当前启用的工具列表 |
| `model` | `string` | 模型 ID（如 `claude-opus-4-6`） |
| `additionalWorkingDirectories` | `string[]` | 额外工作目录 |
| `mcpClients` | `MCPServerConnection[]` | MCP 服务器连接列表 |

> 源码位置：`src/constants/prompts.ts:444-577`

### `getOauthConfig(): OauthConfig`

根据环境（prod/staging/local/custom）返回完整的 OAuth 配置对象。支持通过 `CLAUDE_CODE_CUSTOM_OAUTH_URL` 覆盖（仅限白名单 URL）和 `CLAUDE_CODE_OAUTH_CLIENT_ID` 覆盖 Client ID。

> 源码位置：`src/constants/oauth.ts:186-234`

### `getAttributionHeader(fingerprint: string): string`

生成 API 请求的归属 Header，包含版本号、入口点、可选的客户端证明占位符和工作负载类型。

> 源码位置：`src/constants/system.ts:73-95`

### `getCLISyspromptPrefix(options?): CLISyspromptPrefix`

根据会话类型（交互式/非交互式）和 API 提供商返回系统提示词前缀。Vertex 始终使用默认前缀；非交互式模式根据是否有 `appendSystemPrompt` 选择不同的 Agent SDK 前缀。

> 源码位置：`src/constants/system.ts:30-46`

### `getSpinnerVerbs(): string[]`

返回加载动画动词列表。支持通过 settings 配置自定义（`replace` 模式替换、默认模式追加）。

> 源码位置：`src/constants/spinnerVerbs.ts:3-13`

## 接口/类型定义

### `OauthConfig`

OAuth 配置对象类型，包含所有认证相关的 URL 和标识符（`src/constants/oauth.ts:60-81`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `BASE_API_URL` | `string` | API 基础 URL |
| `CONSOLE_AUTHORIZE_URL` | `string` | Console 授权页 URL |
| `CLAUDE_AI_AUTHORIZE_URL` | `string` | Claude.ai 授权页 URL |
| `CLAUDE_AI_ORIGIN` | `string` | Claude.ai 的 web origin |
| `TOKEN_URL` | `string` | Token 端点 |
| `CLIENT_ID` | `string` | OAuth Client ID |
| `MCP_PROXY_URL` | `string` | MCP 代理服务 URL |
| `MCP_PROXY_PATH` | `string` | MCP 代理路径模板 |

### `OutputStyleConfig`

输出风格配置类型（`src/constants/outputStyles.ts:11-23`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 风格名称 |
| `description` | `string` | 描述 |
| `prompt` | `string` | 注入到系统提示词的指令 |
| `source` | `SettingSource \| 'built-in' \| 'plugin'` | 来源 |
| `keepCodingInstructions` | `boolean?` | 是否保留编码指导 |
| `forceForPlugin` | `boolean?` | 是否作为插件强制风格 |

## 常量分类详解

### API 限制（`apiLimits.ts`）

定义了 Anthropic API 的硬性服务端限制（`src/constants/apiLimits.ts:1-95`）：

- **图片限制**：`API_IMAGE_MAX_BASE64_SIZE`（5MB base64）、`IMAGE_TARGET_RAW_SIZE`（3.75MB 原始）、最大尺寸 2000×2000
- **PDF 限制**：`PDF_TARGET_RAW_SIZE`（20MB）、`API_PDF_MAX_PAGES`（100 页）、`PDF_EXTRACT_SIZE_THRESHOLD`（3MB，超过则提取为页面图片）、`PDF_MAX_EXTRACT_SIZE`（100MB）、`PDF_MAX_PAGES_PER_READ`（20 页/次）
- **媒体限制**：`API_MAX_MEDIA_PER_REQUEST`（100 个媒体项/请求）

### 工具限制（`toolLimits.ts`）

控制工具结果的大小约束（`src/constants/toolLimits.ts:1-57`）：

| 常量 | 值 | 说明 |
|------|------|------|
| `DEFAULT_MAX_RESULT_SIZE_CHARS` | 50,000 | 单个工具结果最大字符数，超出则持久化到磁盘 |
| `MAX_TOOL_RESULT_TOKENS` | 100,000 | 工具结果最大 Token 数（约 400KB） |
| `BYTES_PER_TOKEN` | 4 | Token 到字节的估算比率 |
| `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` | 200,000 | 单条消息中所有工具结果的总字符上限 |
| `TOOL_SUMMARY_MAX_LENGTH` | 50 | 工具摘要的最大字符长度 |

### Beta 特性标识（`betas.ts`）

每个 Beta 特性对应一个 HTTP Header 字符串，用于 API 请求中声明所需的 Beta 能力（`src/constants/betas.ts:1-52`）。关键标识包括：

- `INTERLEAVED_THINKING_BETA_HEADER` —— 交错思考
- `CONTEXT_1M_BETA_HEADER` —— 1M 上下文窗口
- `STRUCTURED_OUTPUTS_BETA_HEADER` —— 结构化输出
- `WEB_SEARCH_BETA_HEADER` —— 网页搜索
- `TOOL_SEARCH_BETA_HEADER_1P` / `_3P` —— 工具搜索（1P 和 3P 提供商使用不同 Header）
- `TOKEN_EFFICIENT_TOOLS_BETA_HEADER` —— Token 高效工具

特别注意：`BEDROCK_EXTRA_PARAMS_HEADERS` 定义了必须放在 Bedrock `extraBodyParams` 而非 Header 中的 Beta 标识；`VERTEX_COUNT_TOKENS_ALLOWED_BETAS` 限定了 Vertex countTokens API 允许的 Beta 子集。

### 工具可用性集合（`tools.ts`）

定义了不同场景下工具的可用性规则（`src/constants/tools.ts:36-112`）：

- `ALL_AGENT_DISALLOWED_TOOLS` —— Agent 不可使用的工具（如 TaskOutput、ExitPlanMode、AskUserQuestion）
- `ASYNC_AGENT_ALLOWED_TOOLS` —— 异步 Agent 允许的工具集合（文件读写、搜索、Shell 等）
- `IN_PROCESS_TEAMMATE_ALLOWED_TOOLS` —— 进程内队友额外允许的工具（任务管理、消息发送、定时任务）
- `COORDINATOR_MODE_ALLOWED_TOOLS` —— 协调器模式仅允许 Agent、TaskStop、SendMessage、SyntheticOutput

### XML 标签（`xml.ts`）

定义了消息中使用的所有 XML 标签名（`src/constants/xml.ts:1-87`），分为：

- **Skill/命令元数据**：`command-name`、`command-message`、`command-args`
- **终端输出**：`bash-input`、`bash-stdout`、`bash-stderr`、`local-command-stdout/stderr/caveat`
- **任务通知**：`task-notification`、`task-id`、`status`、`summary`、`worktree` 等
- **跨会话通信**：`teammate-message`、`channel-message`、`cross-session-message`
- **特殊用途**：`tick`（自主模式心跳）、`ultraplan`（远程并行规划）、`remote-review`（远程审查结果）、`fork-boilerplate`（fork 子 Agent 样板）

### 终端符号（`figures.ts`）

定义了终端 UI 中使用的 Unicode 符号（`src/constants/figures.ts:1-46`），包括：

- 基础指示器：`BLACK_CIRCLE`（macOS 用 ⏺，其他用 ●）、`LIGHTNING_BOLT`（↯，快速模式）
- Effort 级别：`EFFORT_LOW`（○）、`EFFORT_MEDIUM`（◐）、`EFFORT_HIGH`（●）、`EFFORT_MAX`（◉）
- MCP/会话指示器：`REFRESH_ARROW`（↻）、`CHANNEL_ARROW`（←）、`INJECTED_ARROW`（→）
- Bridge 状态：`BRIDGE_SPINNER_FRAMES`（4 帧旋转动画）

### 二进制文件扩展名（`files.ts`）

`BINARY_EXTENSIONS` 集合包含约 80 种二进制文件扩展名（`src/constants/files.ts:5-112`），覆盖图片、视频、音频、压缩包、可执行文件、文档、字体、字节码、数据库和设计文件。同时提供 `hasBinaryExtension()` 扩展名检查和 `isBinaryContent()` 内容检测两种判定方式。

### OAuth 多环境配置（`oauth.ts`）

支持三种环境配置（`src/constants/oauth.ts:84-234`）：

- **Production**：标准的 `api.anthropic.com` / `platform.claude.com` / `claude.ai` 端点
- **Staging**：仅在 `ant` 构建且启用 `USE_STAGING_OAUTH` 时可用，指向 staging 域名
- **Local**：仅在 `ant` 构建且启用 `USE_LOCAL_OAUTH` 时可用，指向 `localhost` 端口

此外支持 `CLAUDE_CODE_CUSTOM_OAUTH_URL` 环境变量覆盖，但仅允许白名单中的 FedStart/PubSec URL。OAuth scope 定义区分了 Console（`org:create_api_key`）和 Claude.ai（`user:inference`、`user:sessions:claude_code` 等）两种场景。

### 输出风格（`outputStyles.ts`）

内置两种非默认输出风格（`src/constants/outputStyles.ts:41-135`）：

- **Explanatory**：在代码实现前后提供教育性洞察（Insight 面板）
- **Learning**：引导用户亲手编写代码片段，包含 Learn by Doing 交互格式和 TODO(human) 机制

`getAllOutputStyles()` 函数按优先级合并多来源风格：built-in < plugin < user < project < managed。`getOutputStyleConfig()` 会检查是否有插件强制风格（`forceForPlugin`），有则优先使用。

## 配置项与环境变量

| 环境变量 | 用途 |
|---------|------|
| `CLAUDE_CODE_SIMPLE` | 启用精简系统提示词模式 |
| `CLAUDE_CODE_OVERRIDE_DATE` | 覆盖日期（ant-only） |
| `USER_TYPE` | 构建类型标识（`ant` 启用内部功能） |
| `USE_STAGING_OAUTH` / `USE_LOCAL_OAUTH` | 切换 OAuth 环境 |
| `CLAUDE_CODE_CUSTOM_OAUTH_URL` | 自定义 OAuth 端点（仅白名单） |
| `CLAUDE_CODE_OAUTH_CLIENT_ID` | 覆盖 OAuth Client ID |
| `CLAUDE_CODE_ENTRYPOINT` | 入口点标识（用于 Attribution Header） |
| `CLAUDE_CODE_ATTRIBUTION_HEADER` | 设为 falsy 值禁用 Attribution Header |
| `ENABLE_GROWTHBOOK_DEV` | 切换 GrowthBook 开发环境 Key |

## 边界 Case 与注意事项

- **`apiLimits.ts` 的 base64 大小计算**：`API_IMAGE_MAX_BASE64_SIZE` 是 base64 编码后的长度（5MB），而非原始字节大小。`IMAGE_TARGET_RAW_SIZE` 通过 `base64_size * 3/4` 推导，确保编码后不超限
- **`betas.ts` 中的条件 Beta Header**：`SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER` 和 `AFK_MODE_BETA_HEADER` 通过 `feature()` 门控，构建时通过死代码消除。`CLI_INTERNAL_BETA_HEADER` 仅在 ant 构建中启用
- **`prompts.ts` 的缓存边界**：`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 标记将系统提示词分为静态（全局可缓存）和动态（每会话变化）两部分。移动或删除此标记会破坏 `src/utils/api.ts` 和 `src/services/api/claude.ts` 中的缓存逻辑
- **`systemPromptSections.ts` 的缓存破坏**：`DANGEROUS_uncachedSystemPromptSection` 每轮重新计算，会破坏 prompt cache。目前仅 MCP 指令使用此模式（因 MCP 服务器可能在回合间连接/断开）
- **`cyberRiskInstruction.ts` 的变更限制**：此文件由 Safeguards 团队拥有，修改前需经过该团队审核和评估
- **`oauth.ts` 的 URL 白名单**：`ALLOWED_OAUTH_BASE_URLS` 严格限制自定义 OAuth URL 的范围，防止 OAuth token 泄露到任意端点
- **`errorIds.ts` 的 ID 分配**：新增错误类型时需使用 Next ID（当前为 346）并递增，ID 是混淆标识符用于生产环境错误追踪