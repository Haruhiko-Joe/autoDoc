# 会话生命周期管理（SessionManagement）

## 概述与职责

会话管理模块是 Claude Code 基础设施层（Infrastructure → FeatureUtilities）中的核心子系统，负责会话从创建到销毁的完整生命周期。它由 12 个源文件组成，围绕一个中心职责展开：**管理对话数据的持久化、恢复和运行时状态**。

该模块的核心引擎是 `sessionStorage.ts`（~5100 行），其他文件分别处理会话初始化（Hook 执行）、会话恢复（状态重建）、运行时状态通知、活动心跳、环境变量注入、鉴权、文件访问监控、标题生成、URL 解析等辅助功能。

在整体架构中，该模块被 CoreEngine（查询引擎记录对话）、Entrypoints（启动时初始化会话）、TerminalUI（REPL 恢复会话）、BridgeAndRemote（远程会话持久化）等上层模块广泛依赖。

## 关键流程

### 1. 会话写入流程（消息持久化）

这是整个模块最核心的流程，由 `sessionStorage.ts` 中的 `Project` 类驱动。

1. 外部调用 `recordTranscript(messages)` 提交一批新消息（`src/utils/sessionStorage.ts:1408-1449`）
2. `recordTranscript` 通过 `getSessionMessages()` 获取已记录的 UUID 集合，过滤重复消息
3. 将新消息传递给 `Project.insertMessageChain()`（`src/utils/sessionStorage.ts:993-1083`），该方法：
   - 若 `sessionFile` 为 null 且包含 user/assistant 消息，调用 `materializeSessionFile()` 创建会话文件
   - 为每条消息构建 `TranscriptMessage`（附加 sessionId、cwd、version、gitBranch 等元数据）
   - 通过 `parentUuid` 链维护消息的父子关系
   - 调用 `appendEntry()` 写入
4. `appendEntry()`（`src/utils/sessionStorage.ts:1128-1265`）根据条目类型分发：
   - 元数据类型（custom-title、tag、agent-name 等）直接入队
   - 消息类型检查 UUID 去重后入队，并同步到远程（Session Ingress 或 CCR v2）
5. **写入队列机制**：所有写入先进入 `writeQueues`（按文件分组），通过 `scheduleDrain()` 以 100ms 间隔（远程模式 10ms）批量刷盘，调用 `appendToFile()` 以 JSONL 格式追加写入

```
recordTranscript → insertMessageChain → appendEntry → enqueueWrite → scheduleDrain → drainWriteQueue → appendToFile
```

### 2. 会话加载流程（Resume/Continue）

从磁盘 JSONL 文件重建对话链：

1. 调用 `loadTranscriptFile(filePath)`（`src/utils/sessionStorage.ts:3472`）
2. **大文件优化**：对于 >5MB 的文件，使用 `readTranscriptForLoad()`（`sessionStoragePortable.ts:717-793`）进行单次前向分块读取：
   - 在 fd 级别跳过 `attribution-snapshot` 行（节省内存）
   - 遇到 `compact_boundary` 时截断累积器（丢弃已压缩的旧内容）
   - 扫描边界前的元数据（agent-setting、mode、pr-link 等）
3. 解析 JSONL 为 Entry 数组，按类型分发到不同 Map 中
4. **Legacy 兼容**：处理旧版 progress 条目的 `parentUuid` 链断裂问题（`progressBridge`）
5. 调用 `applyPreservedSegmentRelinks()` 重新链接压缩后保留的消息段
6. 调用 `applySnipRemovals()` 应用 Snip 操作的消息删除
7. 计算叶子节点 UUID 集合
8. 通过 `buildConversationChain()` 从叶子节点沿 `parentUuid` 链反向遍历重建对话

### 3. 会话启动与 Hook 执行

`sessionStart.ts` 处理两类启动 Hook：

1. **`processSessionStartHooks(source)`**（`src/utils/sessionStart.ts:35-175`）：
   - `source` 可为 `'startup'`、`'resume'`、`'clear'`、`'compact'`
   - 在 `--bare` 模式下跳过所有 Hook
   - 加载插件 Hook（受 `allowManagedHooksOnly` 策略限制）
   - 执行 `SessionStart` Hook，收集返回的消息、附加上下文、文件监听路径
   - 特殊处理 `initialUserMessage`（通过 `pendingInitialUserMessage` 侧通道传递）

2. **`processSetupHooks(trigger)`**（`src/utils/sessionStart.ts:177-232`）：
   - `trigger` 为 `'init'` 或 `'maintenance'`
   - 类似流程，但执行 `Setup` Hook

### 4. 会话恢复流程

`sessionRestore.ts` 提供从已保存会话重建应用状态的完整管线：

1. `processResumedConversation(result, opts, context)`（`src/utils/sessionRestore.ts:409-551`）是主入口：
   - 匹配 coordinator/normal 模式
   - 非 fork 时复用原会话 ID（`switchSession`）
   - 调用 `restoreSessionMetadata()` 恢复元数据缓存
   - 调用 `restoreWorktreeForResume()` 恢复 worktree 工作目录
   - 调用 `adoptResumedSessionFile()` 将 JSONL 文件指针指向已有文件
   - 恢复 Agent 定义和模型覆盖
   - 持久化当前模式
   - 计算初始 `AppState`（attribution、agent context、agent definitions）

2. `restoreSessionStateFromLog(result, setAppState)`（`src/utils/sessionRestore.ts:99-150`）恢复运行时状态：
   - 文件历史快照
   - Attribution 状态
   - Context-collapse 提交日志
   - TodoWrite 状态（从 transcript 中提取最后一个 TodoWrite 工具调用）

## 函数签名与参数说明

### sessionStorage.ts — 核心持久化

#### `recordTranscript(messages, teamInfo?, startingParentUuidHint?, allMessages?): Promise<UUID | null>`
主消息录制入口。过滤已记录消息后调用 `insertMessageChain`。返回最后一个录制的 chain participant UUID。

#### `loadTranscriptFile(filePath, opts?): Promise<{messages, summaries, customTitles, ...}>`
从 JSONL 文件加载完整会话数据。返回按类型分组的 Map 集合。`opts.keepAllLeaves` 控制是否保留所有分支叶子节点。

#### `buildConversationChain(messages, leafMessage): TranscriptMessage[]`
从叶子消息沿 `parentUuid` 链反向遍历构建对话数组（根→叶顺序）。检测循环引用。

#### `saveCustomTitle(sessionId, customTitle, fullPath?, source?): Promise<void>`
保存用户自定义标题到 JSONL 并更新内存缓存。

#### `saveWorktreeState(worktreeSession): void`
记录 worktree 状态供 `--resume` 恢复。传 `null` 表示退出 worktree。

#### `restoreSessionMetadata(meta): void`
将恢复的元数据（标题、标签、Agent 信息、模式等）写入内存缓存。

#### `hydrateRemoteSession(sessionId, ingressUrl): Promise<boolean>`
从远程 Session Ingress 拉取日志并写入本地 JSONL 文件。

#### `hydrateFromCCRv2InternalEvents(sessionId): Promise<boolean>`
从 CCR v2 内部事件恢复会话（包括前台和子 Agent 事件）。

### sessionRestore.ts — 会话恢复

#### `processResumedConversation(result, opts, context): Promise<ProcessedResume>`
处理已加载的对话数据用于恢复/继续。协调模式匹配、会话 ID 设置、Agent 恢复、状态计算。

#### `restoreWorktreeForResume(worktreeSession): void`
恢复 worktree 工作目录。若目录已不存在则清除缓存状态。

### sessionStart.ts — 会话初始化

#### `processSessionStartHooks(source, options?): Promise<HookResultMessage[]>`
执行 SessionStart Hook 并收集结果消息。`source` 指明触发场景（startup/resume/clear/compact）。

### sessionState.ts — 运行时状态

#### `notifySessionStateChanged(state, details?): void`
通知会话状态变更（idle/running/requires_action），触发监听器和 SDK 事件。

### sessionTitle.ts — 标题生成

#### `generateSessionTitle(description, signal): Promise<string | null>`
调用 Haiku 模型生成 3-7 词的会话标题。使用 JSON Schema 约束输出格式。

## 接口/类型定义

### `SessionState`（`sessionState.ts:1`）
```typescript
type SessionState = 'idle' | 'running' | 'requires_action'
```
会话运行时三态。`requires_action` 表示等待用户操作（如权限确认）。

### `RequiresActionDetails`（`sessionState.ts:15-24`）
携带阻塞原因的上下文信息：工具名称、操作描述、tool_use_id、request_id、原始输入。

### `SessionExternalMetadata`（`sessionState.ts:32-45`）
推送到外部系统的会话元数据：权限模式、Ultraplan 模式、模型、待处理操作、任务摘要等。

### `SessionActivityReason`（`sessionActivity.ts:20`）
```typescript
type SessionActivityReason = 'api_call' | 'tool_exec'
```
活动跟踪的原因类型。

### `ParsedSessionUrl`（`sessionUrl.ts:4-10`）
```typescript
type ParsedSessionUrl = {
  sessionId: UUID; ingressUrl: string | null;
  isUrl: boolean; jsonlFile: string | null; isJsonlFile: boolean;
}
```
解析后的会话恢复标识符，支持 UUID、URL 和 JSONL 文件路径三种形式。

### `AgentMetadata` / `RemoteAgentMetadata`（`sessionStorage.ts:264-318`）
子 Agent 和远程 Agent 的元数据类型，用于恢复时重建 Agent 上下文。

## 配置项与默认值

| 配置/环境变量 | 默认值 | 说明 |
|---|---|---|
| `ENABLE_SESSION_PERSISTENCE` | - | 启用远程 Session Ingress 持久化 |
| `CLAUDE_CODE_REMOTE_SEND_KEEPALIVES` | - | 启用远程心跳发送 |
| `CLAUDE_CODE_SESSION_ACCESS_TOKEN` | - | 会话入口鉴权令牌（最高优先级） |
| `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR` | - | Legacy FD 鉴权路径 |
| `CLAUDE_SESSION_INGRESS_TOKEN_FILE` | `/home/claude/.claude/remote/.session_ingress_token` | 令牌文件路径 |
| `CLAUDE_ENV_FILE` | - | 父进程传递的环境脚本文件（如 venv 激活） |
| `CLAUDE_CODE_SKIP_PROMPT_HISTORY` | - | 跳过会话持久化 |
| `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` | - | 向 SDK 事件流发送状态变更 |
| `CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP` | - | 禁用大文件预压缩跳过优化 |
| `cleanupPeriodDays` (settings) | - | 设为 0 时禁用持久化 |
| 写入队列刷新间隔 | 100ms（本地）/ 10ms（远程） | `Project.FLUSH_INTERVAL_MS` |
| 活动心跳间隔 | 30s | `SESSION_ACTIVITY_INTERVAL_MS` |
| Transcript 读取块大小 | 1MB | `TRANSCRIPT_READ_CHUNK_SIZE` |
| 预压缩跳过阈值 | 5MB | `SKIP_PRECOMPACT_THRESHOLD` |
| Head/Tail 读取缓冲区 | 64KB | `LITE_READ_BUF_SIZE` |
| 最大 Transcript 读取字节 | 50MB | `MAX_TRANSCRIPT_READ_BYTES` |

## 边界 Case 与注意事项

### 延迟写入（Lazy Materialization）
会话文件在第一条 user/assistant 消息到达时才创建（`materializeSessionFile`）。此前的元数据条目（mode、agentSetting）缓存在内存 `pendingEntries` 中。这防止了元数据-only 的空会话文件泛滥。

### 元数据 Tail 窗口漂移
`readLiteMetadata` 只读取文件末尾 64KB。如果大量消息追加后将 custom-title 推出窗口，`--resume` 列表会显示 firstPrompt 而非用户设置的标题。`reAppendSessionMetadata()` 在退出时和压缩后重新追加元数据到文件末尾解决此问题。

### ParentUuid 链完整性
- **Legacy progress 条目**：旧版 transcript 中 progress 消息参与了 parentUuid 链。加载时通过 `progressBridge` Map 桥接跨越 progress 的链断裂（`loadTranscriptFile:3623-3641`）
- **并行工具结果恢复**：流式生成 N 个并行 tool_use 时产生 DAG 拓扑。`recoverOrphanedParallelToolResults()` 后处理恢复被单链遍历遗漏的兄弟 assistant 和 tool_result 消息
- **Compact boundary 压缩段保留**：`applyPreservedSegmentRelinks()` 处理 preservedSegment 的 head→anchor 链接重写和 usage 归零

### 鉴权令牌优先级（`sessionIngressAuth.ts`）
三级降级：环境变量 `CLAUDE_CODE_SESSION_ACCESS_TOKEN` → 文件描述符（FD + 回退到 well-known 文件）→ 永不。Session Key（`sk-ant-sid`）使用 Cookie 认证，JWT 使用 Bearer 认证。

### Worktree 恢复陷阱
`restoreWorktreeForResume()` 使用 `process.chdir` 作为存在性检查——如果目录已被删除则 catch 异常并清除状态，避免 `--resume` 进入不存在的目录。`exitRestoredWorktree()` 在 `/resume` 切换会话前撤销 worktree 恢复。

### 环境脚本注入（`sessionEnvironment.ts`）
Hook 执行后的环境变量通过写入 `~/.claude/session-env/{sessionId}/` 目录下的 `.sh` 文件持久化。排序规则：`setup` → `sessionstart` → `cwdchanged` → `filechanged`，同类型按 hook 索引排序。结果缓存在内存中，`invalidateSessionEnvCache()` 清除缓存。

### 文件访问追踪（`sessionFileAccessHooks.ts`）
注册 `PostToolUse` Hook 追踪对会话记忆文件、memdir 文件和团队记忆文件的访问。按工具类型（Read/Edit/Write/Grep/Glob）和文件类型分别上报遥测事件。受 `TEAMMEM` 和 `MEMORY_SHAPE_TELEMETRY` 特性门控。

## 关键代码片段

### 写入队列调度 — `Project.scheduleDrain()`
```typescript
// src/utils/sessionStorage.ts:618-631
private scheduleDrain(): void {
  if (this.flushTimer) { return; }
  this.flushTimer = setTimeout(async () => {
    this.flushTimer = null
    this.activeDrain = this.drainWriteQueue()
    await this.activeDrain
    this.activeDrain = null
    if (this.writeQueues.size > 0) { this.scheduleDrain() }
  }, this.FLUSH_INTERVAL_MS)
}
```
定时器触发批量写入，100MB 单批上限，按文件分组串行追加。

### 活动心跳引用计数 — `startSessionActivity()`
```typescript
// src/utils/sessionActivity.ts:92-115
export function startSessionActivity(reason: SessionActivityReason): void {
  refcount++
  activeReasons.set(reason, (activeReasons.get(reason) ?? 0) + 1)
  if (refcount === 1) {
    oldestActivityStartedAt = Date.now()
    if (activityCallback !== null && heartbeatTimer === null) {
      startHeartbeatTimer()
    }
  }
}
```
引用计数从 0→1 时启动 30 秒心跳定时器；归零时停止心跳、启动空闲检测。

### 会话标识符解析 — `parseSessionIdentifier()`
```typescript
// src/utils/sessionUrl.ts:20-64
export function parseSessionIdentifier(resumeIdentifier: string): ParsedSessionUrl | null {
  if (resumeIdentifier.toLowerCase().endsWith('.jsonl')) { /* JSONL 文件 */ }
  if (validateUuid(resumeIdentifier)) { /* 纯 UUID */ }
  try { const url = new URL(resumeIdentifier); /* URL */ }
  catch { /* 无效 */ }
  return null
}
```
支持三种恢复标识符：`.jsonl` 文件路径、UUID 字符串、远程会话 URL。