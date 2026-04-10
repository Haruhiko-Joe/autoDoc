# 平台后端 API 客户端集合（PlatformAPIs）

## 概述与职责

PlatformAPIs 是一组独立的 HTTP 端点客户端，封装了 Claude Code 与 Anthropic 后端平台（非 Claude 模型推理 API）之间的 REST 通信。这些客户端位于 `src/services/api/` 目录下，在整体架构中属于 **Services → ApiClient** 层，为应用的启动配置、配额管理、文件传输、会话持久化、隐私设置等功能提供后端数据支持。

所有客户端共享以下通用模式：
- **认证**：通过 OAuth Bearer Token 或 API Key 进行身份验证，大部分使用 `getAuthHeaders()` / `getOAuthHeaders()` 统一获取认证头
- **401 重试**：多数客户端使用 `withOAuth401Retry()` 自动刷新过期 token 并重试
- **隐私级别检查**：非关键端点在 `isEssentialTrafficOnly()` 为 true 时跳过请求
- **错误处理**：通过 `logError()` / `logForDebugging()` 记录异常，失败时返回 null 或默认值而非抛出异常
- **磁盘缓存**：多个客户端将响应持久化到 GlobalConfig，避免每次启动重复请求

## 关键流程

### 启动配置拉取（bootstrap）

1. `fetchBootstrapData()` 在应用启动时调用
2. 校验前置条件：非 essential-only 模式、使用第一方 API 提供商、有可用的 OAuth 或 API Key
3. 向 `/api/claude_cli/bootstrap` 发送 GET 请求，支持 OAuth Bearer 和 API Key 两种认证方式（`src/services/api/bootstrap.ts:68-92`）
4. 使用 Zod schema 验证响应，提取 `client_data` 和 `additional_model_options`
5. 与本地 GlobalConfig 缓存做 deep equal 比较，仅在数据变更时写盘，避免每次启动触发配置写入（`src/services/api/bootstrap.ts:124-137`）

### 文件上传/下载（filesApi）

文件 API 客户端是所有客户端中最复杂的，支持下载、上传和列表三大操作：

**下载流程**：
1. `downloadSessionFiles()` 并行下载多个文件附件，使用 worker 池模型限制并发（默认 5）
2. 每个文件通过 `downloadFile()` 从 `/v1/files/{fileId}/content` 下载，带指数退避重试（最多 3 次）
3. `buildDownloadPath()` 构建安全的本地保存路径，拒绝路径遍历攻击（`..` 开头的路径）（`src/services/api/filesApi.ts:187-210`）
4. 文件保存到 `{cwd}/{sessionId}/uploads/` 目录下

**上传流程（BYOC 模式）**：
1. `uploadFile()` 读取本地文件，校验大小上限（500MB）
2. 手动构建 multipart/form-data 请求体，POST 到 `/v1/files`（`src/services/api/filesApi.ts:429-455`）
3. 区分可重试错误（网络错误、5xx）和不可重试错误（401/403/413），使用 `UploadNonRetriableError` 类跳出重试循环

**列表流程（1P/Cloud 模式）**：
1. `listFilesCreatedAfter()` 通过 `after_created_at` 参数过滤文件，支持基于 `after_id` 游标的分页

### 会话日志回传（sessionIngress）

会话日志系统使用乐观并发控制（OCC）模式：

1. `appendSessionLog()` 接收日志条目和会话 URL，通过 JWT token 认证
2. 每个 session 有一个 `sequential()` 包装器，确保同一会话的日志写入串行执行（`src/services/api/sessionIngress.ts:42-55`）
3. 写入时携带 `Last-Uuid` 头实现 OCC——服务端校验客户端的 last UUID 与服务端链头一致
4. 遇到 409 冲突时，从响应头 `x-last-uuid` 或重新拉取日志来恢复服务端的链头，然后重试（`src/services/api/sessionIngress.ts:90-141`）
5. 最多重试 10 次，使用指数退避（上限 8 秒）

`getTeleportEvents()` 是新的 v2 会话事件读取接口，替代旧的 `getSessionLogsViaOAuth()`：
- 使用 CCR Sessions API 的 `/v1/code/sessions/{id}/teleport-events` 端点
- 支持游标分页（每页最多 1000 条），设有 100 页安全上限防止无限循环（`src/services/api/sessionIngress.ts:311-400`）

### 配额与限额查询（usage / ultrareviewQuota）

- `fetchUtilization()` 查询 claude.ai 订阅用户的配额利用率，返回 5 小时/7 天窗口的利用率百分比和重置时间，以及额外用量信息（`src/services/api/usage.ts:33-63`）
- `fetchUltrareviewQuota()` 查询 Ultrareview 功能的已用/剩余/上限配额（`src/services/api/ultrareviewQuota.ts:19-38`）

## 函数签名与参数说明

### bootstrap.ts

#### `fetchBootstrapData(): Promise<void>`
应用启动时调用，拉取启动配置并持久化到 GlobalConfig。失败时静默处理（仅记录错误）。

### usage.ts

#### `fetchUtilization(): Promise<Utilization | null>`
查询当前用户的配额利用率。仅对 claude.ai 订阅且有 profile scope 的用户生效，否则返回空对象 `{}`。

### filesApi.ts

#### `downloadFile(fileId: string, config: FilesApiConfig): Promise<Buffer>`
下载单个文件内容。404/401/403 立即抛出，5xx/网络错误重试。

#### `downloadAndSaveFile(attachment: File, config: FilesApiConfig): Promise<DownloadResult>`
下载并保存文件到本地工作区。

#### `downloadSessionFiles(files: File[], config: FilesApiConfig, concurrency?: number): Promise<DownloadResult[]>`
批量并行下载会话文件附件。`concurrency` 默认 5。

#### `uploadFile(filePath: string, relativePath: string, config: FilesApiConfig, opts?: { signal?: AbortSignal }): Promise<UploadResult>`
上传单个文件到 Files API（BYOC 模式）。支持通过 `AbortSignal` 取消。

#### `uploadSessionFiles(files: Array<{ path: string; relativePath: string }>, config: FilesApiConfig, concurrency?: number): Promise<UploadResult[]>`
批量并行上传文件。

#### `listFilesCreatedAfter(afterCreatedAt: string, config: FilesApiConfig): Promise<FileMetadata[]>`
列出指定时间戳之后创建的所有文件，自动处理分页。

#### `parseFileSpecs(fileSpecs: string[]): File[]`
解析 CLI 参数中的文件规格（格式 `<file_id>:<relative_path>`），支持空格分隔的多规格字符串。

### sessionIngress.ts

#### `appendSessionLog(sessionId: string, entry: TranscriptMessage, url: string): Promise<boolean>`
追加一条日志到会话，返回是否成功。使用 JWT token 认证，保证同会话串行写入。

#### `getSessionLogs(sessionId: string, url: string): Promise<Entry[] | null>`
通过 JWT token 获取会话的所有日志条目（用于 hydration）。

#### `getSessionLogsViaOAuth(sessionId: string, accessToken: string, orgUUID: string): Promise<Entry[] | null>`
通过 OAuth 获取会话日志（用于 teleport 场景）。

#### `getTeleportEvents(sessionId: string, accessToken: string, orgUUID: string): Promise<Entry[] | null>`
通过 CCR v2 Sessions API 获取 teleport 事件，替代 `getSessionLogsViaOAuth`。

#### `clearSession(sessionId: string): void` / `clearAllSessions(): void`
清除单个或所有会话的本地缓存状态（lastUuid 和 sequential wrapper）。

### grove.ts

#### `getGroveSettings(): Promise<ApiResult<AccountSettings>>`
获取用户的 Grove 设置（是否启用、通知查看时间）。会话级 memoize 缓存。

#### `updateGroveSettings(groveEnabled: boolean): Promise<void>`
更新 Grove 启用状态，成功后清除 memoize 缓存。

#### `markGroveNoticeViewed(): Promise<void>`
标记 Grove 通知已查看。

#### `isQualifiedForGrove(): Promise<boolean>`
非阻塞式检查用户是否符合 Grove 资格。使用磁盘缓存（24h TTL），首次无缓存时后台拉取并返回 false。

#### `getGroveNoticeConfig(): Promise<ApiResult<GroveConfig>>`
获取 Grove 通知配置（通过 Statsig）。会话级 memoize。

#### `calculateShouldShowGrove(settingsResult, configResult, showIfAlreadyViewed): boolean`
纯函数，根据用户设置和配置计算是否应显示 Grove 对话框。

#### `checkGroveForNonInteractive(): Promise<void>`
非交互模式下的 Grove 检查。宽限期内显示提示并继续，宽限期后强制退出。

### adminRequests.ts

#### `createAdminRequest(params: AdminRequestCreateParams): Promise<AdminRequest>`
创建管理员请求（限额提升或席位升级）。针对 Team/Enterprise 中无管理权限的用户。

#### `getMyAdminRequests(requestType: AdminRequestType, statuses: AdminRequestStatus[]): Promise<AdminRequest[] | null>`
查询当前用户特定类型和状态的管理员请求。

#### `checkAdminRequestEligibility(requestType: AdminRequestType): Promise<AdminRequestEligibilityResponse | null>`
检查当前组织是否允许指定类型的管理员请求。

### referral.ts

#### `fetchReferralEligibility(campaign?: ReferralCampaign): Promise<ReferralEligibilityResponse>`
获取推荐计划资格信息。

#### `fetchReferralRedemptions(campaign?: string): Promise<ReferralRedemptionsResponse>`
获取推荐兑换记录。

#### `getCachedOrFetchPassesEligibility(): Promise<ReferralEligibilityResponse | null>`
主入口函数。非阻塞，返回磁盘缓存数据，过期时后台刷新。仅 Max 订阅用户可用。

#### `prefetchPassesEligibility(): Promise<void>`
启动时预拉取推荐资格信息。

### overageCreditGrant.ts

#### `getCachedOverageCreditGrant(): OverageCreditGrantInfo | null`
同步读取缓存的超额额度信息（1h TTL）。

#### `refreshOverageCreditGrantCache(): Promise<void>`
拉取并缓存超额额度信息。避免数据未变时的冗余写盘。

#### `invalidateOverageCreditGrantCache(): void`
使当前组织的缓存条目失效。

#### `formatGrantAmount(info: OverageCreditGrantInfo): string | null`
格式化金额用于展示（当前仅支持 USD）。

### metricsOptOut.ts

#### `checkMetricsEnabled(): Promise<MetricsStatus>`
检查当前组织是否启用了指标采集。双层缓存：磁盘 24h + 内存 1h。首次运行时阻塞等待网络，之后从缓存读取（`src/services/api/metricsOptOut.ts:128-154`）。

### firstTokenDate.ts

#### `fetchAndStoreClaudeCodeFirstTokenDate(): Promise<void>`
获取用户首次使用 Claude Code 的日期并缓存。仅在 GlobalConfig 中无记录时请求一次。

### ultrareviewQuota.ts

#### `fetchUltrareviewQuota(): Promise<UltrareviewQuotaResponse | null>`
查询 Ultrareview 配额。仅订阅用户可用，失败时返回 null。

## 接口/类型定义

### 配额相关

| 类型 | 文件 | 说明 |
|------|------|------|
| `Utilization` | usage.ts | 配额利用率，包含 5h/7d 窗口和额外用量 |
| `RateLimit` | usage.ts | 单个限额窗口：利用率百分比 + 重置时间 |
| `ExtraUsage` | usage.ts | 额外用量：启用状态、月限额、已用额度 |
| `UltrareviewQuotaResponse` | ultrareviewQuota.ts | Ultrareview 已用/上限/剩余/是否超额 |

### 文件 API 相关

| 类型 | 文件 | 说明 |
|------|------|------|
| `File` | filesApi.ts | 文件规格：fileId + relativePath |
| `FilesApiConfig` | filesApi.ts | API 客户端配置：oauthToken, baseUrl, sessionId |
| `DownloadResult` | filesApi.ts | 下载结果：路径、成功状态、字节数 |
| `UploadResult` | filesApi.ts | 上传结果（联合类型）：成功含 fileId + size，失败含 error |
| `FileMetadata` | filesApi.ts | 文件元信息：filename, fileId, size |

### Grove 相关

| 类型 | 文件 | 说明 |
|------|------|------|
| `AccountSettings` | grove.ts | 用户账户设置：grove_enabled + 通知查看时间 |
| `GroveConfig` | grove.ts | Grove 配置：启用状态、域排除、宽限期、提醒频率 |
| `ApiResult<T>` | grove.ts | 通用 API 结果包装，区分请求失败和成功 |

### 管理员请求相关

| 类型 | 文件 | 说明 |
|------|------|------|
| `AdminRequestType` | adminRequests.ts | `'limit_increase' \| 'seat_upgrade'` |
| `AdminRequestStatus` | adminRequests.ts | `'pending' \| 'approved' \| 'dismissed'` |
| `AdminRequest` | adminRequests.ts | 请求实体：uuid, status, requester, 创建时间 + 类型特定详情 |

### 超额额度相关

| 类型 | 文件 | 说明 |
|------|------|------|
| `OverageCreditGrantInfo` | overageCreditGrant.ts | 超额额度状态：available, eligible, granted, 金额 |

## 配置项与默认值

| 配置 | 来源 | 默认值 | 说明 |
|------|------|--------|------|
| `ANTHROPIC_BASE_URL` | 环境变量 | - | Files API 基础 URL |
| `CLAUDE_CODE_API_BASE_URL` | 环境变量 | - | Files API 备用基础 URL |
| Files API fallback URL | 硬编码 | `https://api.anthropic.com` | 上述环境变量均未设置时 |
| Metrics API endpoint | 硬编码 | `https://api.anthropic.com/api/claude_code/organizations/metrics_enabled` | 指标采集开关端点 |
| `FILES_API_BETA_HEADER` | 常量 | `files-api-2025-04-14,oauth-2025-04-20` | Files API beta 头 |
| 文件大小上限 | 常量 | 500MB | `MAX_FILE_SIZE_BYTES` |
| 下载/上传并发数 | 默认参数 | 5 | `DEFAULT_CONCURRENCY` |
| 下载超时 | 常量 | 60s | 单个文件下载 |
| 上传超时 | 常量 | 120s | 单个文件上传 |
| 通用 API 超时 | 各客户端 | 5s | bootstrap/usage/ultrareview 等 |
| Session ingress 重试次数 | 常量 | 10 | `MAX_RETRIES`，指数退避上限 8s |
| Files API 重试次数 | 常量 | 3 | `MAX_RETRIES`，初始 500ms |
| Grove 磁盘缓存 TTL | 常量 | 24h | `GROVE_CACHE_EXPIRATION_MS` |
| Referral 缓存 TTL | 常量 | 24h | `CACHE_EXPIRATION_MS` |
| Overage grant 缓存 TTL | 常量 | 1h | `CACHE_TTL_MS` |
| Metrics 磁盘缓存 TTL | 常量 | 24h | `DISK_CACHE_TTL_MS` |
| Metrics 内存缓存 TTL | 常量 | 1h | `CACHE_TTL_MS` |

## 边界 Case 与注意事项

- **Bootstrap 双重认证**：优先使用 OAuth（需 `user:profile` scope），回退到 API Key。Service-key OAuth token 缺少 profile scope 会导致 403，因此明确检查 `hasProfileScope()`（`src/services/api/bootstrap.ts:54-61`）
- **Session ingress 409 恢复**：当进程被 kill 后重启，前一个进程的 in-flight 请求可能推进了服务端的 UUID 链。新进程会收到 409，通过 `x-last-uuid` 响应头或重新拉取日志恢复状态（`src/services/api/sessionIngress.ts:90-141`）
- **Teleport 404 歧义**：在迁移窗口期间，404 可能意味着"会话不存在"或"端点未部署/未回填"，返回 null 让调用方回退到旧的 session-ingress 路径（`src/services/api/sessionIngress.ts:334-353`）
- **非阻塞缓存策略**：Grove（`isQualifiedForGrove`）和 Referral（`getCachedOrFetchPassesEligibility`）使用 cache-first + background-refresh 模式——首次无缓存时返回 false/null 并后台拉取，功能在下次会话才可用
- **Metrics 双层缓存**：磁盘缓存 24h + 内存缓存 1h。多个 `claude -p` 并发进程共享磁盘缓存，约每天只发 1 次 API 调用（`src/services/api/metricsOptOut.ts:128-154`）
- **配置写放大保护**：`overageCreditGrant` 和 `metricsOptOut` 在数据未变且时间戳仍新鲜时跳过写盘，防止并发进程竞争写入
- **文件路径安全**：`buildDownloadPath()` 拒绝 `..` 开头的路径防止路径遍历，并自动去除冗余前缀（`src/services/api/filesApi.ts:192-198`）
- **Grove 宽限期逻辑**：`checkGroveForNonInteractive()` 在宽限期内仅打印提示，宽限期结束后强制退出程序（`src/services/api/grove.ts:343-356`）
- **Referral 仅限 Max 订阅**：`shouldCheckForPasses()` 校验 `getSubscriptionType() === 'max'`，非 Max 用户直接跳过所有推荐功能
- **firstTokenDate 一次性**：仅在 GlobalConfig 中无记录时请求，写入后永不再更新