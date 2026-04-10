# 远程配置同步与设置管理（SyncAndSettings）

## 概述与职责

SyncAndSettings 模块是 Claude Code **Services 层**的子系统，负责三类远程数据的同步管理：

1. **remoteManagedSettings** — 企业级远程托管安全策略，由管理员在服务端配置，客户端拉取并应用
2. **settingsSync** — 用户个人设置和记忆文件的双向同步（本地 CLI ↔ 云端 CCR）
3. **teamMemorySync** — 团队共享记忆的双向同步，以 GitHub 仓库为作用域，含客户端敏感信息扫描

三个子服务共享相似的架构模式：OAuth/API Key 认证、HTTP 请求重试与指数退避、fail-open 容错（同步失败不阻塞启动）、ETag/Checksum 缓存验证。它们分别对应不同的 API 端点和数据流向，服务于不同的业务场景。

---

## 子模块一：remoteManagedSettings（远程托管策略配置）

### 职责

为企业客户从服务端拉取管理员下发的安全策略和配置。这些配置由企业管理员在 Console/Claude.ai 后台设置，客户端定期拉取后覆盖本地策略层（`policySettings`）。

### 资格判定

资格检查在 `syncCache.ts` 中实现（`isRemoteManagedSettingsEligible()`，`src/services/remoteManagedSettings/syncCache.ts:49-112`）：

- **Console 用户（API Key）**：拥有实际 API Key（非 apiKeyHelper）即可
- **OAuth 用户**：仅 Enterprise/C4E 和 Team 订阅类型有资格；外部注入 Token（`subscriptionType === null`）默认放行，由服务端决定
- **第三方 Provider / 自定义 Base URL / Cowork 环境**：不参与

资格结果通过 `setEligibility()` 缓存到 `syncCacheState.ts` 的模块变量中，避免重复执行认证链。

### 关键流程：启动加载

1. **`initializeRemoteManagedSettingsLoadingPromise()`**：在 `init.ts` 中提前调用，创建一个 Promise 供其他系统（如权限初始化）等待远程配置就绪。含 30 秒超时防止死锁

2. **`loadRemoteManagedSettings()`**（`index.ts:514-555`）：
   - Cache-first：先尝试从磁盘缓存（`~/.claude/remote-settings.json`）加载并立即 unblock 等待者
   - 发起 HTTP 请求拉取最新配置（含重试逻辑）
   - 对比新旧配置，若包含"危险设置"变更则弹出安全确认对话框
   - 成功后启动每小时一次的后台轮询
   - 通过 `settingsChangeDetector.notifyChange('policySettings')` 触发热重载

3. **后台轮询**（`startBackgroundPolling()`，`index.ts:612-628`）：每 60 分钟调用 `pollRemoteSettings()` 检查是否有配置变更，变更时触发热重载

### HTTP 缓存机制

- 客户端从配置内容计算 SHA-256 checksum（`computeChecksumFromSettings()`，`index.ts:131-137`），排序后序列化以匹配 Python 服务端的 `json.dumps(sort_keys=True)`
- 请求时携带 `If-None-Match` 头，服务端返回 304 则复用缓存
- 配置持久化到 `~/.claude/remote-settings.json`，文件权限 `0o600`

### 安全检查

`securityCheck.tsx` 在新配置包含"危险设置"（如权限变更）且与缓存不同时，弹出 `ManagedSettingsSecurityDialog` 阻塞式对话框：

- 用户接受 → 应用新配置
- 用户拒绝 → 调用 `gracefulShutdownSync(1)` 退出进程
- 非交互模式 → 跳过检查

### 类型定义

| 类型 | 说明 |
|------|------|
| `RemoteManagedSettingsResponse` | API 响应结构：`uuid`, `checksum`, `settings` |
| `RemoteManagedSettingsFetchResult` | 拉取结果：`success`, `settings`（null 表示 304）, `skipRetry` |
| `SecurityCheckResult` | `'approved' \| 'rejected' \| 'no_check_needed'` |

### 配置项与常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `SETTINGS_TIMEOUT_MS` | 10000 | HTTP 请求超时 |
| `DEFAULT_MAX_RETRIES` | 5 | 最大重试次数 |
| `POLLING_INTERVAL_MS` | 3600000 | 后台轮询间隔（1 小时） |
| `LOADING_PROMISE_TIMEOUT_MS` | 30000 | 加载 Promise 超时（防死锁） |

---

## 子模块二：settingsSync（用户设置双向同步）

### 职责

在用户的本地 CLI 环境和云端 CCR（Claude Code Remote）之间同步设置文件和记忆文件，使用户在不同设备上拥有一致的配置体验。

### 数据模型

同步数据采用扁平的 key-value 存储（`src/services/settingsSync/types.ts:61-67`）：

```
~/.claude/settings.json          → 全局用户设置
~/.claude/CLAUDE.md              → 全局用户记忆
projects/{hash}/.claude/settings.local.json  → 项目级设置
projects/{hash}/CLAUDE.local.md  → 项目级记忆
```

其中 `{hash}` 是 Git remote URL 的哈希值，由 `getRepoRemoteHash()` 计算。

### 关键流程：上传（CLI → 云端）

`uploadUserSettingsInBackground()`（`index.ts:60-111`）在 `main.tsx preAction` 中触发：

1. 前置检查：`UPLOAD_USER_SETTINGS` feature flag + GrowthBook `tengu_enable_settings_sync_push` + 交互模式 + OAuth 认证
2. 拉取远程当前 entries
3. 通过 `buildEntriesFromLocalFiles()` 读取本地文件（含 500KB 大小限制）
4. 用 `lodash pickBy` 计算差集（仅上传变更的 key）
5. PUT 增量 entries 到 `/api/claude_code/user_settings`

### 关键流程：下载（云端 → CCR）

`downloadUserSettings()`（`index.ts:129-135`）在 CCR 模式的 `runHeadless()` 中 fire-and-forget 调用，并在插件安装前 await：

1. 首次调用发起请求，后续调用共享同一个 Promise（`downloadPromise` 单例缓存）
2. 拉取远程 entries 后通过 `applyRemoteEntriesToLocal()` 写入本地
3. 写入设置文件前调用 `markInternalWrite()` 防止变更检测误触发
4. 写入后分别清除 `settingsCache` 和 `memoryFileCaches`

`redownloadUserSettings()`（`index.ts:152-155`）供 `/reload-plugins` 命令使用，绕过启动缓存重新拉取，无重试（用户可手动重试）。

### 认证要求

仅支持第一方 OAuth 认证（`isUsingOAuth()`，`index.ts:212-221`），需要 `user:inference` scope。不要求 `user:profile` scope——CCR 的 file-descriptor token 只携带 `user:inference`。

### 类型定义

| 类型 | 说明 |
|------|------|
| `UserSyncData` | 完整响应：`userId`, `version`, `lastModified`, `checksum`, `content.entries` |
| `SettingsSyncFetchResult` | 拉取结果，`isEmpty` 标识 404 |
| `SettingsSyncUploadResult` | 上传结果，含 `checksum` 和 `lastModified` |

### 常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `SETTINGS_SYNC_TIMEOUT_MS` | 10000 | HTTP 超时 |
| `DEFAULT_MAX_RETRIES` | 3 | 最大重试次数 |
| `MAX_FILE_SIZE_BYTES` | 512000 | 单文件大小限制（500KB） |

---

## 子模块三：teamMemorySync（团队记忆同步与安全扫描）

### 职责

在团队成员之间共享仓库级别的记忆文件（team memory），以 GitHub 仓库（`owner/repo`）为作用域。包含完整的**客户端敏感信息扫描**机制，防止凭据泄露到共享内存中。

### 架构组件

- **index.ts** — 核心同步引擎（pull / push / 冲突解决）
- **watcher.ts** — 文件系统监听器，检测本地变更并触发推送
- **secretScanner.ts** — 基于 gitleaks 规则的客户端密钥扫描器
- **teamMemSecretGuard.ts** — 写入拦截守卫，集成到 FileWriteTool / FileEditTool

### 同步状态管理

所有可变状态封装在 `SyncState` 对象中（`index.ts:100-127`）：

```typescript
type SyncState = {
  lastKnownChecksum: string | null      // 服务端 ETag
  serverChecksums: Map<string, string>  // 每个 key 的 sha256 hash
  serverMaxEntries: number | null       // 从 413 响应学到的服务端上限
}
```

由 watcher 创建并贯穿所有同步调用，测试中可独立实例化。

### 关键流程：Pull（服务端 → 本地）

`pullTeamMemory()`（`index.ts:770-867`）：

1. 检查 OAuth 认证和 GitHub remote
2. 带 ETag 的条件 GET 请求（304 = 无变更）
3. 解析响应中的 `entryChecksums`，更新 `serverChecksums`
4. 调用 `writeRemoteEntriesToLocal()` 并行写入本地：
   - 每个 key 经过 `validateTeamMemKey()` 路径遍历防护
   - 跳过大小超过 250KB 的条目
   - 对比磁盘现有内容，相同则跳过写入（保持 mtime）
5. 写入后清除 `memoryFileCaches`

### 关键流程：Push（本地 → 服务端）

`pushTeamMemory()`（`index.ts:889-1146`）实现了复杂的 delta push + 乐观锁冲突解决：

1. **读取本地文件**：`readLocalTeamMemory()` 递归读取 team memory 目录
2. **密钥扫描（PSR M22174）**：每个文件调用 `scanForSecrets()` 检测凭据，含凭据的文件被跳过
3. **计算 delta**：对比 `localHashes` 和 `serverChecksums`，仅上传差异
4. **分批上传**：`batchDeltaByBytes()` 将 delta 按 200KB 分批（避免网关 413）
5. **冲突解决**：收到 412 时，调用 `fetchTeamMemoryHashes()` 轻量探测服务端校验和，重新计算 delta 后重试（最多 2 次）

冲突策略：**local-wins**——本地编辑覆盖服务端同 key 的内容，因为触发 push 的用户正在活跃编辑。

### 文件监听器（watcher.ts）

`startTeamMemoryWatcher()`（`watcher.ts:252-305`）：

1. 前置检查：`TEAMMEM` feature flag + `isTeamMemoryEnabled()` + OAuth + GitHub remote
2. 初始 pull 从服务端获取最新内容
3. 启动 `fs.watch({ recursive: true })` 监听 team memory 目录
4. 文件变更触发 2 秒防抖后的 `pushTeamMemory()`
5. **永久失败抑制**：`no_oauth`、4xx（非 409/429）等不可恢复错误后停止重试，直到检测到文件删除（ENOENT）才清除抑制

使用 `fs.watch` 而非 chokidar 的原因：chokidar 4+ 删除了 fsevents，Bun 的 `fs.watch` fallback 使用 kqueue 需要每文件一个 fd——500+ 团队记忆文件会耗尽 fd。`recursive: true` 在 macOS 上使用 FSEvents（O(1) fd），在 Linux 上使用 inotify（O(subdirs)）。

### 密钥扫描器（secretScanner.ts）

基于 gitleaks 的高置信度规则子集，覆盖 30+ 种凭据类型（`src/services/teamMemorySync/secretScanner.ts:48-224`）：

| 类别 | 示例规则 |
|------|---------|
| 云服务商 | AWS Access Token、GCP API Key、Azure AD Client Secret |
| AI API | Anthropic API Key、OpenAI API Key、HuggingFace Token |
| 版本控制 | GitHub PAT/Fine-grained PAT/App Token、GitLab PAT |
| 通信 | Slack Bot/User/App Token、Twilio、SendGrid |
| 开发工具 | NPM Token、PyPI Token、Pulumi、Postman |
| 可观测性 | Grafana API Key/Cloud Token、Sentry Token |
| 支付 | Stripe Access Token、Shopify Token |
| 加密 | PEM 私钥 |

核心设计：
- 规则在首次扫描时惰性编译（`getCompiledRules()`）
- `scanForSecrets()` 返回匹配的规则 ID 和标签，**不返回匹配到的实际内容**
- `redactSecrets()` 可对内容进行脱敏替换（仅替换捕获组，保留边界字符）
- Anthropic API Key 前缀在运行时拼接（`['sk', 'ant', 'api'].join('-')`），避免在打包产物中出现字面量

### 写入拦截守卫（teamMemSecretGuard.ts）

`checkTeamMemSecrets()`（`teamMemSecretGuard.ts:15-44`）集成到 FileWriteTool 和 FileEditTool 的 `validateInput` 中：

1. 检查 `TEAMMEM` feature flag（关闭时完全惰性）
2. 检查写入路径是否在 team memory 目录内（`isTeamMemPath()`）
3. 对内容调用 `scanForSecrets()`
4. 发现密钥时返回错误消息，阻止写入

### 类型定义

| 类型 | 说明 |
|------|------|
| `TeamMemoryData` | 完整响应：`organizationId`, `repo`, `version`, `checksum`, `content.entries`, `content.entryChecksums` |
| `TeamMemorySyncPushResult` | push 结果：含 `conflict`, `skippedSecrets`, `errorType`, `httpStatus` |
| `TeamMemoryHashesResult` | 轻量 hashes 探测结果（用于 412 冲突解决） |
| `SkippedSecretFile` | 被跳过的含密钥文件：`path`, `ruleId`, `label` |

### 常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `TEAM_MEMORY_SYNC_TIMEOUT_MS` | 30000 | HTTP 超时（团队记忆通常更大） |
| `MAX_FILE_SIZE_BYTES` | 250000 | 单文件大小限制 |
| `MAX_PUT_BODY_BYTES` | 200000 | 单次 PUT 请求体上限（避免网关 413） |
| `MAX_RETRIES` | 3 | fetch 重试次数 |
| `MAX_CONFLICT_RETRIES` | 2 | 412 冲突重试次数 |
| `DEBOUNCE_MS` | 2000 | 文件变更防抖时间 |

---

## 边界 Case 与注意事项

- **Fail-open 设计**：三个子服务在同步失败时均不阻塞应用启动或正常使用，仅记录日志
- **循环依赖规避**：`syncCacheState.ts` 被刻意拆分为不依赖 `auth.ts` 的"叶子模块"，因为 `settings.ts → syncCache → auth.ts → settings.ts` 会形成循环。认证相关的 `isRemoteManagedSettingsEligible()` 保留在 `syncCache.ts` 中
- **非交互模式**：远程安全设置检查对话框在非交互模式下自动跳过
- **团队记忆不传播删除**：删除本地文件不会从服务端删除对应条目，下次 pull 时会恢复。这是设计选择，防止误删
- **Anthropic API Key 前缀运行时拼接**：为了通过打包产物的 excluded-strings 检查，API Key 前缀不以字面量形式存在于代码中
- **团队记忆的 serverMaxEntries 无客户端默认值**：服务端上限可按组织调整，客户端仅在收到 413 响应后学习并缓存这个上限