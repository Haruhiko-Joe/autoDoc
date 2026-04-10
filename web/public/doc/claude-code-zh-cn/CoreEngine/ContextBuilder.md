# ContextBuilder — 系统提示词上下文构建器

## 概述与职责

`ContextBuilder`（`src/context.ts`）负责为每一轮对话组装**系统级上下文信息**，是 CoreEngine 的核心组成部分。它生成两类上下文：

- **System Context**（`getSystemContext`）：Git 仓库状态 + 可选的缓存打破注入
- **User Context**（`getUserContext`）：CLAUDE.md 配置文件内容 + 当前日期

两者均通过 `lodash/memoize` 缓存，在整个会话期间**只计算一次**。计算结果以键值对形式注入到每轮查询的 system prompt 中。

在整体架构中，本模块属于 **CoreEngine** 层，与 Entrypoints（初始化后启动查询引擎）和 Services（API 通信、压缩等）协同工作。同级模块包括 QueryEngine（消息流处理主循环）、query.ts（消息规范化与 Token 管理）等。

## 关键流程

### getSystemContext 流程

1. 检查是否处于远程模式（`CLAUDE_CODE_REMOTE`）或 Git 指令被禁用，若是则跳过 Git 状态采集（`src/context.ts:124-128`）
2. 调用 `getGitStatus()` 并行执行 5 条 Git 命令，收集分支、主分支、工作区状态、最近 5 条提交、用户名
3. 若 `status` 输出超过 2000 字符，截断并附加提示信息（`src/context.ts:85-89`）
4. 检查 `BREAK_CACHE_COMMAND` feature flag，若开启且存在注入内容，则附加 `cacheBreaker` 字段（`src/context.ts:131-148`）
5. 返回包含 `gitStatus` 和可选 `cacheBreaker` 的键值对对象

### getUserContext 流程

1. 判断是否禁用 CLAUDE.md：环境变量 `CLAUDE_CODE_DISABLE_CLAUDE_MDS` 为 truthy，或 bare 模式且无显式 `--add-dir` 目录时跳过（`src/context.ts:165-167`）
2. 调用 `getMemoryFiles()` → `filterInjectedMemoryFiles()` → `getClaudeMds()` 加载并合并多目录的 CLAUDE.md 内容（`src/context.ts:170-172`）
3. 通过 `setCachedClaudeMdContent()` 缓存结果，供 yoloClassifier 等模块读取（避免循环依赖）（`src/context.ts:176`）
4. 返回包含 `claudeMd`（可选）和 `currentDate` 的键值对对象

### 缓存打破机制

`systemPromptInjection` 是一个模块级变量，通过 `setSystemPromptInjection()` 设置。设置时会**立即清除** `getUserContext` 和 `getSystemContext` 的 memoize 缓存（`src/context.ts:32-33`），迫使下次调用重新计算。此功能受 `BREAK_CACHE_COMMAND` feature flag 门控，仅在内部调试场景使用。

## 函数签名与参数说明

### `getSystemContext(): Promise<{ [k: string]: string }>`

收集系统级上下文。使用 memoize 缓存，会话内只执行一次。

- **返回值**：键值对对象，可能包含：
  - `gitStatus`：格式化的 Git 状态摘要（分支、主分支、用户名、工作区状态、最近提交）
  - `cacheBreaker`：格式为 `[CACHE_BREAKER: <injection>]` 的调试注入内容

> 源码位置：`src/context.ts:116-150`

### `getUserContext(): Promise<{ [k: string]: string }>`

收集用户级上下文。使用 memoize 缓存，会话内只执行一次。

- **返回值**：键值对对象，包含：
  - `claudeMd`（可选）：合并后的 CLAUDE.md 配置内容
  - `currentDate`：格式为 `Today's date is YYYY-MM-DD.`

> 源码位置：`src/context.ts:155-189`

### `getGitStatus(): Promise<string | null>`

并行执行 Git 命令收集仓库状态，使用 memoize 缓存。

- **返回值**：格式化的多行字符串，包含分支信息、工作区状态、最近提交；测试环境或非 Git 目录返回 `null`
- **并行执行的 Git 命令**：`getBranch()`、`getDefaultBranch()`、`git status --short`、`git log --oneline -n 5`、`git config user.name`

> 源码位置：`src/context.ts:36-111`

### `getSystemPromptInjection(): string | null`

读取当前缓存打破注入值。

> 源码位置：`src/context.ts:25-27`

### `setSystemPromptInjection(value: string | null): void`

设置缓存打破注入值，并**立即清除** `getUserContext` 和 `getSystemContext` 的缓存。

- **value**：注入字符串，或 `null` 表示清除

> 源码位置：`src/context.ts:29-34`

## 配置项与默认值

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `MAX_STATUS_CHARS` | 常量 `2000` | `git status` 输出最大字符数，超出则截断 |
| `CLAUDE_CODE_REMOTE` | 环境变量 | 为 truthy 时跳过 Git 状态采集（远程模式无需此开销） |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS` | 环境变量 | 为 truthy 时完全禁用 CLAUDE.md 加载 |
| `NODE_ENV=test` | 环境变量 | 测试环境下 `getGitStatus` 直接返回 `null`，避免循环依赖 |
| `--bare` 模式 | CLI 参数 | 跳过 CLAUDE.md 自动发现，但仍尊重 `--add-dir` 显式指定的目录 |
| `BREAK_CACHE_COMMAND` | Feature flag | 门控缓存打破注入功能，仅内部使用 |

## 边界 Case 与注意事项

- **memoize 语义**：两个主函数均为 memoize 缓存，意味着会话期间 Git 状态和 CLAUDE.md 内容**不会自动更新**。Git 状态文本中会显式提示用户"this status is a snapshot in time, and will not update during the conversation"
- **缓存清除**：唯一的缓存清除路径是调用 `setSystemPromptInjection()`，它会使用 `cache.clear?.()` 可选链调用（兼容 lodash memoize 的 cache 接口）
- **bare 模式与 --add-dir 的交互**：bare 模式并非完全禁用 CLAUDE.md，而是"跳过未显式请求的内容"。如果用户通过 `--add-dir` 指定了额外目录，CLAUDE.md 仍会被加载（`src/context.ts:167`）
- **循环依赖规避**：`setCachedClaudeMdContent()` 的存在是为了让 yoloClassifier 能读取 CLAUDE.md 内容，同时避免 `permissions/filesystem → permissions → yoloClassifier` 的循环导入链
- **Git 命令使用 `--no-optional-locks`**：避免在只读查询时获取 Git 锁，防止与用户并行操作冲突
- **诊断日志**：所有关键步骤均记录了 `logForDiagnosticsNoPII` 日志（含耗时），便于性能排查，但不包含 PII 信息