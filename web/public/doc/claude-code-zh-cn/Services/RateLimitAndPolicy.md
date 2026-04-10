# 速率限制与策略管理

## 概述与职责

RateLimitAndPolicy 模块是 **Services（后端服务集成层）** 中负责 API 配额管理和组织策略执行的核心子系统。它承担以下五项关键职责：

1. **速率限制消息生成**：根据当前配额状态，生成面向用户的错误/警告消息
2. **速率限制模拟（Mock）**：供 Anthropic 内部员工测试各种限制场景，无需触及真实 API 配额
3. **Claude.ai 订阅限制检查**：从 API 响应头中提取配额状态，实现预警和限制通知
4. **策略限制执行**：从服务端获取组织级策略限制，控制 CLI 功能的可用性
5. **超额额度（Overage）管理**：处理订阅配额用尽后的超额额度状态转换

该模块在系统中的角色是"看门人"——在 CoreEngine 调用 API 通信时，本模块从响应头中提取限额信息；当限额接近或超出时，向 TerminalUI 提供合适的警告/错误消息。策略限制则在 CLI 启动时加载，并通过后台轮询保持同步。

## 关键流程

### 1. API 响应配额状态提取流程

这是整个限额系统的核心数据流，每次 API 调用后都会执行：

1. API 响应到达后，调用 `extractQuotaStatusFromHeaders()` 处理响应头（`src/services/claudeAiLimits.ts:454-485`）
2. 如果 mock 模式激活，`processRateLimitHeaders()` 会用模拟头覆盖真实响应头（`src/services/rateLimitMocking.ts:19-27`）
3. 从头中提取原始利用率（`extractRawUtilization()`），用于状态栏展示
4. `computeNewLimitsFromHeaders()` 解析统一限额头，构建 `ClaudeAILimits` 对象（`src/services/claudeAiLimits.ts:376-436`）
5. 如果状态为 `allowed` 或 `allowed_warning`，检查是否需要触发预警（先检查服务端 `surpassed-threshold` 头，再回退到客户端时间相对阈值计算）
6. 通过 `isEqual` 比较新旧状态，有变化时调用 `emitStatusChange()` 通知所有监听器

### 2. 预警触发机制（Early Warning）

预警系统采用**两级检测策略**，确保用户在配额用尽前收到通知：

**第一级：服务端头部检测**（`getHeaderBasedEarlyWarning()`，`src/services/claudeAiLimits.ts:255-294`）
- 检查 `anthropic-ratelimit-unified-{5h|7d|overage}-surpassed-threshold` 头
- 如果存在，说明服务端已判定用户超过警告阈值

**第二级：客户端时间相对计算**（`getTimeRelativeEarlyWarning()`，`src/services/claudeAiLimits.ts:301-340`）
- 当服务端未发送阈值头时的回退方案
- 根据 `EARLY_WARNING_CONFIGS` 中的阈值配置判断：如果用户在时间窗口的早期就消耗了大量配额，触发预警
- 5 小时窗口：使用 90%+ 且时间仅过去 72% 以下时预警
- 7 天窗口：有三级阈值（25%/15%、50%/35%、75%/60%）

### 3. 消息生成决策流程

`getRateLimitMessage()` 是消息生成的核心决策函数（`src/services/rateLimitMessages.ts:45-104`）：

```
输入 ClaudeAILimits → 检查超额使用中？
  ├─ 是 → 超额接近限额(allowed_warning)？→ 返回 warning
  │       否则 → 返回 null（正常超额使用不需要消息）
  └─ 否 → 状态是 rejected？
           ├─ 是 → 返回 error（调用 getLimitReachedText 生成具体消息）
           └─ 否 → 状态是 allowed_warning？
                    ├─ 是 → 利用率 < 70%？→ null（防止重置后的假警告）
                    │       Team/Enterprise 有超额且非账单管理员？→ null（会无缝转超额）
                    │       否则 → 返回 warning（调用 getEarlyWarningText）
                    └─ 否 → null
```

消息按严重程度分流：error 消息在 `AssistantTextMessages` 中展示，warning 消息在 UI footer 中展示。

### 4. 策略限制加载与执行流程

策略限制的完整生命周期（`src/services/policyLimits/index.ts`）：

1. **初始化**：CLI 启动时调用 `initializePolicyLimitsLoadingPromise()` 创建加载 Promise（带 30 秒超时防止死锁）
2. **加载**：`loadPolicyLimits()` → `fetchAndLoadPolicyLimits()` → `fetchWithRetry()`（最多 5 次重试+指数退避）
3. **缓存策略**：
   - 内存中的 `sessionCache` 用于快速同步读取
   - 磁盘文件 `~/.claude/policy-limits.json` 用于跨会话持久化
   - 使用 SHA-256 校验和作为 ETag 实现 HTTP 304 缓存
4. **后台轮询**：每 1 小时执行一次 `pollPolicyLimits()`，捕获会话中策略变更
5. **查询**：`isPolicyAllowed(policy)` 同步返回布尔值，采用 fail-open 策略
6. **特例**：在 essential-traffic-only 模式下，`allow_product_feedback` 策略在缓存不可用时 fail-closed

### 5. Mock 限制模拟流程

供内部测试的完整模拟流程（`src/services/mockRateLimits.ts`）：

1. 通过 `/mock-limits` 命令或 `setMockRateLimitScenario()` 激活模拟
2. 所有函数在入口处检查 `process.env.USER_TYPE === 'ant'`，确保仅 Anthropic 员工可用
3. `applyMockHeaders()` 在真实响应头上覆盖模拟头
4. `checkMockRateLimitError()` 在 API 调用前检查是否应抛出模拟 429 错误（`src/services/rateLimitMocking.ts:42-132`）
   - 对 Opus 专属限制，仅在实际使用 Opus 模型时抛出
   - 对 fast mode 限制，仅在 fast mode 激活时抛出，并支持自动过期

## 函数签名与参数说明

### rateLimitMessages.ts — 消息生成

#### `getRateLimitMessage(limits: ClaudeAILimits, model: string): RateLimitMessage | null`

核心消息决策函数。根据限额状态返回带有 `message` 和 `severity`（'error' | 'warning'）的对象，或 null。

#### `getRateLimitErrorMessage(limits: ClaudeAILimits, model: string): string | null`

仅返回 error 级别的消息文本。用于 `errors.ts` 中的错误处理。

#### `getRateLimitWarning(limits: ClaudeAILimits, model: string): string | null`

仅返回 warning 级别的消息文本。用于 UI footer 展示。

#### `getUsingOverageText(limits: ClaudeAILimits): string`

生成进入超额模式时的通知文本，如 `"You're now using extra usage · Your session limit resets in 4 hours"`。

#### `isRateLimitErrorMessage(text: string): boolean`

通过前缀匹配判断一段文本是否为速率限制错误消息。使用导出的 `RATE_LIMIT_ERROR_PREFIXES` 常量避免 UI 组件中的脆弱字符串匹配。

### claudeAiLimits.ts — 限额状态管理

#### `checkQuotaStatus(): Promise<void>`

启动时的配额预检查。发送一个最小 API 请求（1 token），从响应头提取当前配额状态。在非交互模式（`-p`）和 essential-traffic-only 模式下跳过。

#### `extractQuotaStatusFromHeaders(headers: Headers): void`

从 API 响应头中提取配额状态，更新全局 `currentLimits`，触发状态变更通知。这是每次 API 调用后的主入口。

#### `extractQuotaStatusFromError(error: APIError): void`

从 429 错误中提取配额状态。即使响应头不完整，也会将状态设为 `rejected`。

#### `getRawUtilization(): RawUtilization`

返回原始的每窗口利用率数据（5 小时和 7 天），供状态栏脚本使用。

#### `getRateLimitDisplayName(type: RateLimitType): string`

将内部 `RateLimitType` 映射为用户可读名称（如 `'five_hour'` → `'session limit'`）。

### claudeAiLimitsHook.ts — React Hook

#### `useClaudeAiLimits(): ClaudeAILimits`

React Hook，订阅 `statusListeners` 集合中的限额状态变更，触发组件重渲染。

> 源码位置：`src/services/claudeAiLimitsHook.ts:8-23`

### rateLimitMocking.ts — Mock 门面

#### `processRateLimitHeaders(headers: Headers): Headers`

处理响应头的门面函数。mock 激活时覆盖真实头，否则直接返回。

#### `checkMockRateLimitError(currentModel: string, isFastModeActive?: boolean): APIError | null`

检查是否应抛出模拟 429 错误。考虑模型匹配（Opus 限制仅对 Opus 模型生效）和 fast mode 状态。

### policyLimits/index.ts — 策略限制

#### `isPolicyAllowed(policy: string): boolean`

**同步**检查某策略是否被允许。采用 fail-open 策略：无缓存、不认识的策略名均返回 `true`。

#### `loadPolicyLimits(): Promise<void>`

CLI 初始化时调用。获取策略限制、写入缓存、启动后台轮询。

#### `waitForPolicyLimitsToLoad(): Promise<void>`

等待初始加载完成。其他系统可 await 此函数确保策略就绪。

#### `isPolicyLimitsEligible(): boolean`

判断当前用户是否需要检查策略限制。仅 first-party Anthropic 用户、Console 用户（API key）、Team/Enterprise OAuth 用户满足条件。

#### `refreshPolicyLimits(): Promise<void>`

认证状态变更后（如登录）刷新策略限制。清除缓存后重新获取。

## 接口/类型定义

### `ClaudeAILimits`（`src/services/claudeAiLimits.ts:122-136`）

核心限额状态类型，贯穿整个模块：

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | `'allowed' \| 'allowed_warning' \| 'rejected'` | 当前配额状态 |
| `unifiedRateLimitFallbackAvailable` | `boolean` | 是否有模型降级可用（Opus→Sonnet） |
| `resetsAt` | `number?` | 限额重置时间（Unix 时间戳秒） |
| `rateLimitType` | `RateLimitType?` | 触发限制的类型 |
| `utilization` | `number?` | 当前利用率（0-1） |
| `overageStatus` | `QuotaStatus?` | 超额额度状态 |
| `overageResetsAt` | `number?` | 超额额度重置时间 |
| `overageDisabledReason` | `OverageDisabledReason?` | 超额被禁用的原因 |
| `isUsingOverage` | `boolean?` | 当前是否在使用超额额度 |
| `surpassedThreshold` | `number?` | 服务端返回的已超过的阈值 |

### `RateLimitType`

```typescript
type RateLimitType = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage'
```

五种限额窗口：5 小时会话限制、7 天周限制、Opus 专属周限制、Sonnet 专属周限制、超额额度限制。

### `OverageDisabledReason`（`src/services/claudeAiLimits.ts:107-121`）

描述超额额度被禁用的 12 种具体原因，包括组织级禁用（`org_level_disabled`）、信用额度耗尽（`out_of_credits`）、成员级禁用（`member_level_disabled`）等。

### `MockScenario`（`src/services/mockRateLimits.ts:60-81`）

定义 19 种可模拟的限额场景，覆盖从正常使用到各种限额触达、超额状态、Opus/Sonnet 专属限制等。

### `PolicyLimitsResponse`（`src/services/policyLimits/types.ts:8-16`）

```typescript
{ restrictions: Record<string, { allowed: boolean }> }
```

策略限制响应格式。键为策略名（如 `allow_product_feedback`），值表示是否允许。

## 配置项与默认值

### 预警阈值配置

| 窗口 | 阈值 | 说明 |
|------|------|------|
| 5 小时 | utilization ≥ 90%, timePct ≤ 72% | 时间窗口前 72% 就用了 90% 配额 |
| 7 天 | utilization ≥ 75%, timePct ≤ 60% | 第一级预警 |
| 7 天 | utilization ≥ 50%, timePct ≤ 35% | 第二级预警 |
| 7 天 | utilization ≥ 25%, timePct ≤ 15% | 第三级预警 |

### 策略限制常量

| 常量 | 值 | 说明 |
|------|------|------|
| `FETCH_TIMEOUT_MS` | 10000 | API 请求超时（10 秒） |
| `DEFAULT_MAX_RETRIES` | 5 | 最大重试次数 |
| `POLLING_INTERVAL_MS` | 3600000 | 后台轮询间隔（1 小时） |
| `LOADING_PROMISE_TIMEOUT_MS` | 30000 | 加载 Promise 超时（30 秒，防死锁） |
| `CACHE_FILENAME` | `policy-limits.json` | 磁盘缓存文件名（位于 `~/.claude/`） |

### 环境变量

- `USER_TYPE`：值为 `'ant'` 时启用 mock 限额功能和内部增强消息
- `CLAUDE_MOCK_HEADERLESS_429`：非交互模式下模拟无头 429 错误

### 消息前缀匹配

`RATE_LIMIT_ERROR_PREFIXES` 定义了 5 种速率限制消息前缀（`src/services/rateLimitMessages.ts:21-27`），UI 组件通过这些前缀识别速率限制消息，避免脆弱的字符串硬编码。

## 边界 Case 与注意事项

### 预警抑制逻辑

- **低利用率过滤**：当 `utilization < 0.7`（70%）时，即使 API 返回 `allowed_warning`，也不显示警告。这是为了防止周限额重置后，API 短暂发送带有陈旧数据的 `allowed_warning` 状态（`src/services/rateLimitMessages.ts:72-78`）
- **Team/Enterprise 静默转超额**：非账单管理员的 Team/Enterprise 用户，如果组织启用了超额额度，不显示接近限额的警告——他们会无缝过渡到超额模式

### 策略限制的 Fail-Open 设计

策略限制系统全链路 fail-open：API 超时、格式错误、认证失败都不会阻止 CLI 正常使用。**唯一例外**是 essential-traffic-only 模式下的 `allow_product_feedback` 策略——缓存不可用时默认拒绝，防止 HIPAA 合规组织的数据泄露（`src/services/policyLimits/index.ts:502-503`）。

### Mock 系统的安全边界

所有 mock 函数在入口处检查 `process.env.USER_TYPE !== 'ant'` 后直接 return，确保外部用户无法激活模拟功能。Mock 状态完全存储在内存中，不持久化。

### Opus 限制的模型感知

当 Opus 专属限制被触发时，模拟系统仅在用户实际使用 Opus 模型时抛出 429。这模拟了真实 API 的行为——用户可以降级到 Sonnet 继续工作（`src/services/rateLimitMocking.ts:78-87`）。

### 超额额度状态机

超额额度存在以下状态转换：
- `allowed`：正常使用超额额度
- `allowed_warning`：接近超额消费上限
- `rejected`：超额额度也已耗尽

当 `isUsingOverage=true`（订阅 rejected + 超额 allowed/allowed_warning）时，`getUsingOverageText()` 生成一次性通知，告知用户已切换到超额模式。

### 策略缓存的一致性

策略限制使用 SHA-256 校验和实现 ETag 缓存（`computeChecksum()`，`src/services/policyLimits/index.ts:152-159`）。对象的键会递归排序后再序列化，确保相同内容始终产生相同的哈希值，避免因 JSON 键序不同导致缓存失效。