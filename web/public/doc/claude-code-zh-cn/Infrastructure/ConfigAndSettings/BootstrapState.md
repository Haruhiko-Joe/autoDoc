# BootstrapState — 应用启动全局状态管理

## 概述与职责

`BootstrapState` 是 Claude Code 的**全局状态中枢**，由单文件 `src/bootstrap/state.ts`（约 1760 行）实现。它定义了一个包含 80+ 字段的 `State` 类型，涵盖应用运行所需的几乎所有全局状态——从工作目录、模型配置、费用统计，到 OpenTelemetry 计量器、Hook 注册表、功能开关等。

在整体架构中，该模块位于 **Infrastructure → ConfigAndSettings** 层级下，是 import DAG 的叶子节点（不依赖其他 `src/` 模块，仅依赖外部包和少量 type import）。这个设计是刻意的：几乎所有模块都依赖它，因此它必须保持零循环依赖。文件中多处警告注释（`DO NOT ADD MORE STATE HERE`、`THINK THRICE BEFORE MODIFYING`）体现了对该模块修改的审慎态度。

**核心设计模式**：模块级单例 `STATE` 对象 + getter/setter 函数封装。所有状态访问必须通过导出的函数，不直接暴露 `STATE` 引用。部分状态变更通过 signal 机制通知订阅者。

## 关键流程

### 1. 状态初始化

应用启动时，`getInitialState()` 函数创建完整的初始状态对象（`src/bootstrap/state.ts:260-426`）：

1. 解析当前工作目录，调用 `realpathSync()` 解析符号链接并 NFC 规范化
2. 对 CloudStorage 挂载点的 EPERM 异常做降级处理——回退到原始 `cwd()`
3. 用默认值初始化所有 80+ 个字段（计数器归零、集合为空、可选值为 null/undefined）
4. 通过 `randomUUID()` 生成唯一的 `sessionId`

```typescript
// src/bootstrap/state.ts:429
const STATE: State = getInitialState()
```

`STATE` 是模块级常量，整个进程生命周期内只有这一个实例。

### 2. 会话管理流程

会话管理是该模块最具业务逻辑的部分，支持三种操作：

**regenerateSessionId**（`src/bootstrap/state.ts:435-450`）：生成新会话 ID，可选地将当前会话设为父会话。清理旧会话的 plan slug 缓存，重置 `sessionProjectDir`。

**switchSession**（`src/bootstrap/state.ts:468-479`）：原子性切换活跃会话。`sessionId` 和 `sessionProjectDir` 始终一起变更，防止状态不一致（注释引用了 bug CC-34）。切换后通过 signal 通知所有订阅者。

**onSessionSwitch**（`src/bootstrap/state.ts:489`）：基于 `createSignal` 的订阅机制，允许其他模块（如 `concurrentSessions.ts`）监听会话切换事件，保持 PID 文件等外部状态同步。

### 3. 交互时间追踪的批处理优化

为了避免每次按键都调用 `Date.now()`，交互时间更新采用延迟刷新策略（`src/bootstrap/state.ts:665-689`）：

1. `updateLastInteractionTime()` 默认只设置 `interactionTimeDirty = true`（脏标记）
2. Ink 渲染框架在每个渲染周期前调用 `flushInteractionTime()` 批量刷新
3. 对于渲染周期外的场景（如 React `useEffect`），传入 `immediate = true` 立即更新

### 4. Beta Header Latch 机制

四个 `*HeaderLatched` 字段实现了"一旦激活就不回退"的 sticky-on 逻辑（`src/bootstrap/state.ts:226-248`）：

- `afkModeHeaderLatched`：AFK 模式 beta header
- `fastModeHeaderLatched`：快速模式 beta header
- `cacheEditingHeaderLatched`：缓存编辑 beta header
- `thinkingClearLatched`：thinking 清除 latch

设计意图：避免用户在模式间切换时反复 bust prompt cache（约 50-70K token）。一旦某个 beta header 被首次发送，后续请求持续携带该 header，直到 `/clear` 或 `/compact` 显式重置（`clearBetaHeaderLatches`，`src/bootstrap/state.ts:1744-1749`）。

### 5. 滚动排空（Scroll Drain）机制

为防止后台定时器与滚动动画争抢事件循环，实现了滚动排空协议（`src/bootstrap/state.ts:787-824`）：

1. `markScrollActivity()` 设置 `scrollDraining = true`，并启动 150ms 防抖定时器
2. 后台 interval 通过 `getIsScrollDraining()` 检查，在滚动期间跳过工作
3. `waitForScrollIdle()` 为一次性耗时操作提供异步等待接口

该状态刻意不放在 `STATE` 对象中——它是临时热路径标记，防抖定时器自清理，不需要测试重置。

## 状态字段分类

`State` 类型的 80+ 个字段可按职责分为以下几组：

### 工作目录与项目标识

| 字段 | 类型 | 说明 |
|------|------|------|
| `originalCwd` | `string` | 启动时的原始工作目录（解析符号链接后） |
| `projectRoot` | `string` | 稳定的项目根目录，中途 worktree 切换不影响此值 |
| `cwd` | `string` | 当前工作目录，可能随 `setCwdState` 变化 |
| `sessionProjectDir` | `string \| null` | 会话 transcript 所在目录，null 则从 `originalCwd` 推导 |
| `additionalDirectoriesForClaudeMd` | `string[]` | `--add-dir` 参数指定的额外目录 |

### 费用与性能统计

| 字段 | 类型 | 说明 |
|------|------|------|
| `totalCostUSD` | `number` | 累计 API 费用（美元） |
| `totalAPIDuration` | `number` | 累计 API 调用耗时 |
| `totalAPIDurationWithoutRetries` | `number` | 不含重试的 API 耗时 |
| `totalToolDuration` | `number` | 累计工具执行耗时 |
| `totalLinesAdded` / `totalLinesRemoved` | `number` | 累计代码变更行数 |
| `modelUsage` | `Record<string, ModelUsage>` | 按模型名分组的 token 使用量 |
| `turnHookDurationMs` / `turnToolDurationMs` / `turnClassifierDurationMs` | `number` | 当前 turn 内的分类耗时统计 |

### 会话与身份

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `SessionId` | 当前会话 UUID |
| `parentSessionId` | `SessionId \| undefined` | 父会话 ID（如 plan mode → implementation 的血缘追踪） |
| `clientType` | `string` | 客户端类型，默认 `'cli'` |
| `sessionSource` | `string \| undefined` | 会话来源标识 |
| `isInteractive` | `boolean` | 是否为交互式会话 |

### OpenTelemetry 遥测

| 字段 | 类型 | 说明 |
|------|------|------|
| `meter` | `Meter \| null` | OTel Meter 实例 |
| `meterProvider` / `tracerProvider` / `loggerProvider` | Provider 类型 | OTel 各 provider |
| `eventLogger` | Logger | OTel 事件日志器 |
| `sessionCounter` / `locCounter` / `costCounter` 等 | `AttributedCounter \| null` | 8 个具名计数器，由 `setMeter` 统一初始化 |
| `statsStore` | `{ observe } \| null` | 统计数据存储接口 |

### 模型配置

| 字段 | 类型 | 说明 |
|------|------|------|
| `mainLoopModelOverride` | `ModelSetting \| undefined` | `--model` CLI 参数或用户更新后的模型覆盖 |
| `initialMainLoopModel` | `ModelSetting` | 启动时的初始模型 |
| `modelStrings` | `ModelStrings \| null` | 模型展示字符串（不应直接使用，通过 `modelStrings.ts` 访问） |
| `hasUnknownModelCost` | `boolean` | 是否遇到未知费用的模型 |

### Hook 注册表

| 字段 | 类型 | 说明 |
|------|------|------|
| `registeredHooks` | `Partial<Record<HookEvent, RegisteredHookMatcher[]>> \| null` | 注册的 Hook 回调，支持 SDK callback 和 plugin native hook 两种来源 |

### 认证与令牌

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionIngressToken` | `string \| null \| undefined` | 会话入口令牌 |
| `oauthTokenFromFd` | `string \| null \| undefined` | 通过文件描述符传入的 OAuth token |
| `apiKeyFromFd` | `string \| null \| undefined` | 通过文件描述符传入的 API key |

### 缓存与 Latch

| 字段 | 类型 | 说明 |
|------|------|------|
| `promptCache1hAllowlist` / `promptCache1hEligible` | 各类型 | Prompt cache 1h TTL 白名单和资格判定（会话内稳定） |
| `afkModeHeaderLatched` / `fastModeHeaderLatched` / `cacheEditingHeaderLatched` / `thinkingClearLatched` | `boolean \| null` | Sticky-on beta header latch，防止 prompt cache bust |
| `systemPromptSectionCache` | `Map<string, string \| null>` | 系统提示词分段缓存 |
| `cachedClaudeMdContent` | `string \| null` | CLAUDE.md 内容缓存，打破 yoloClassifier 循环依赖 |
| `pendingPostCompaction` | `boolean` | compaction 标记，消费一次后自动重置 |

### 功能开关与 Session-Only 标记

| 字段 | 类型 | 说明 |
|------|------|------|
| `kairosActive` | `boolean` | Kairos 功能是否激活 |
| `strictToolResultPairing` | `boolean` | 严格工具结果配对模式（HFI 使用） |
| `sessionBypassPermissionsMode` | `boolean` | 会话内绕过权限模式（不持久化） |
| `sessionTrustAccepted` | `boolean` | 会话内信任标记（home 目录运行时） |
| `sessionPersistenceDisabled` | `boolean` | 禁用会话持久化到磁盘 |
| `isRemoteMode` | `boolean` | `--remote` 模式 |
| `scheduledTasksEnabled` | `boolean` | 定时任务是否启用 |

## 关键函数签名

### 会话管理

```typescript
// 获取/重新生成会话 ID
export function getSessionId(): SessionId
export function regenerateSessionId(options?: { setCurrentAsParent?: boolean }): SessionId

// 原子切换会话（sessionId + projectDir 一起变更）
export function switchSession(sessionId: SessionId, projectDir?: string | null): void

// 订阅会话切换事件
export const onSessionSwitch: (cb: (id: SessionId) => void) => () => void
```

### 费用与统计

```typescript
export function addToTotalCostState(cost: number, modelUsage: ModelUsage, model: string): void
export function resetCostState(): void
export function setCostStateForRestore(params: { totalCostUSD, totalAPIDuration, ... }): void

// Token 统计（从 modelUsage 聚合计算）
export function getTotalInputTokens(): number
export function getTotalOutputTokens(): number
export function getTotalCacheReadInputTokens(): number
```

### OTel 计量器初始化

```typescript
// 一次性初始化 meter 和所有 8 个计数器
export function setMeter(
  meter: Meter,
  createCounter: (name: string, options: MetricOptions) => AttributedCounter
): void
```

> 源码位置：`src/bootstrap/state.ts:948-987`

`setMeter` 接受一个 counter 工厂函数而非直接创建，这是因为 `AttributedCounter` 是对 OTel Counter 的包装（支持附加属性），具体创建逻辑由调用方提供。

### Hook 注册

```typescript
// 合并注册（可多次调用，同一事件的 matcher 累加）
export function registerHookCallbacks(
  hooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>>
): void

// 只清除 plugin hook，保留 SDK callback hook
export function clearRegisteredPluginHooks(): void
```

> 源码位置：`src/bootstrap/state.ts:1419-1461`

### 滚动排空

```typescript
export function markScrollActivity(): void        // 标记滚动发生
export function getIsScrollDraining(): boolean     // 后台 interval 检查点
export function waitForScrollIdle(): Promise<void> // 一次性操作的异步等待
```

### 测试重置

```typescript
// 仅在 NODE_ENV=test 下可调用，重置所有状态到初始值
export function resetStateForTests(): void
```

## 类型定义

### `ChannelEntry`

频道注册表条目，区分插件频道和服务器频道：

```typescript
export type ChannelEntry =
  | { kind: 'plugin'; name: string; marketplace: string; dev?: boolean }
  | { kind: 'server'; name: string; dev?: boolean }
```

`dev` 标记来自 `--dangerously-load-development-channels` 参数，用于绕过白名单校验。

### `AttributedCounter`

对 OTel Counter 的轻量包装，支持附加维度属性：

```typescript
export type AttributedCounter = {
  add(value: number, additionalAttributes?: Attributes): void
}
```

### `SessionCronTask`

会话内临时 cron 任务（不写入磁盘，进程退出即销毁）：

```typescript
export type SessionCronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring?: boolean
  agentId?: string  // 非空时，任务由子 agent 而非主 REPL 处理
}
```

### `InvokedSkillInfo`

已调用技能的追踪信息，用于 compaction 后保持技能上下文：

```typescript
export type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: string | null
}
```

key 为 `${agentId ?? ''}:${skillName}` 的复合键，防止跨 agent 覆盖。

## 边界 Case 与注意事项

1. **Bootstrap 隔离规则**：该文件是 import DAG 的叶子节点。ESLint 规则 `custom-rules/bootstrap-isolation` 禁止它导入 `src/` 下的模块（仅允许 type import 和显式豁免的 `crypto.js`）。这确保了它不会引入循环依赖。

2. **`projectRoot` vs `originalCwd` vs `cwd`**：三个"目录"字段语义不同——`projectRoot` 在启动后不再变化（`EnterWorktreeTool` 不更新它），用于项目标识；`originalCwd` 可被 worktree 启动参数修改；`cwd` 跟随用户的当前工作目录变化。

3. **NFC 规范化**：所有目录路径的 setter（`setOriginalCwd`、`setProjectRoot`、`setCwdState`）都会对输入做 `.normalize('NFC')`，确保 macOS 上 Unicode 路径的一致性。

4. **`preferThirdPartyAuthentication()`**：非交互模式下默认使用第三方认证，但 VS Code 扩展 (`claude-vscode`) 除外——它虽然是非交互的，但认证行为应与第一方一致。

5. **错误日志环形缓冲**：`inMemoryErrorLog` 最多保留 100 条，超出时移除最早的记录（`src/bootstrap/state.ts:1215-1224`）。

6. **Slow Operations 仅 ant 用户可见**：`addSlowOperation` 在 `USER_TYPE !== 'ant'` 时直接返回，且条目有 10 秒 TTL 和最多 10 条的限制。返回值通过引用稳定性优化避免不必要的 React 重渲染。

7. **`setUseCoworkPlugins` 的副作用**：它是唯一一个 setter 会触发 `resetSettingsCache()` 的字段（`src/bootstrap/state.ts:1256-1258`），因为 cowork 模式影响设置的加载路径。

8. **`consumePostCompaction()` 的消费语义**：调用一次后自动重置为 `false`，确保 "post-compaction" 标记只对紧随其后的第一次 API 调用生效。