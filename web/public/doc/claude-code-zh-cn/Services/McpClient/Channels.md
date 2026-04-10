# 频道通知与权限中继系统（Channels）

## 概述与职责

频道系统是 MCP 客户端（McpClient）的子模块，位于 Services 层，负责将外部消息频道（Discord、Slack、Telegram、SMS 等）接入 Claude Code 的对话流。它解决两个核心问题：

1. **消息通知**：让 MCP 服务器作为消息频道，将用户在外部平台发送的消息推送到当前对话中
2. **远程权限审批**：当 Claude 触发权限确认对话框时，同时通过活跃频道发送审批请求，人类可在手机/频道端回复批准操作

该模块由三个文件组成：
- `channelNotification.ts` — 频道资格验证门控、消息 XML 包装
- `channelPermissions.ts` — 权限审批中继协议（ID 生成、回调管理、客户端过滤）
- `channelAllowlist.ts` — 已批准频道插件白名单（GrowthBook 远程控制）

在架构层级上，Channels 属于 **Services → McpClient** 子模块，与 ApiClient、Analytics、OAuthService 等同级服务协作。

## 关键流程

### 频道注册门控流程

当一个 MCP 服务器连接后，`gateChannelServer()` 决定是否为其注册频道通知处理器。门控按以下顺序逐层检查（`src/services/mcp/channelNotification.ts:191-316`）：

1. **Capability 检查**：服务器必须在 MCP capabilities 中声明 `experimental['claude/channel']`
2. **运行时开关**：调用 `isChannelsEnabled()` 检查 GrowthBook 特性开关 `tengu_harbor`（全局 killswitch）
3. **认证检查**：必须使用 claude.ai OAuth 认证（API key 用户被拒绝，因 console 端尚无管理界面）
4. **组织策略**：Teams/Enterprise 组织必须在 managed settings 中显式设置 `channelsEnabled: true`
5. **会话白名单**：服务器必须出现在当前会话的 `--channels` 参数列表中
6. **插件白名单**：对于 plugin 类型条目，还需验证 marketplace 来源一致性，并检查是否在批准白名单中

任一层失败返回 `{ action: 'skip', kind, reason }`，全部通过返回 `{ action: 'register' }`。

### 消息入站流程

频道服务器通过 MCP 通知协议发送 `notifications/claude/channel` 事件，消息体由 `ChannelMessageNotificationSchema` 校验（`src/services/mcp/channelNotification.ts:37-47`）：

```typescript
{
  method: 'notifications/claude/channel',
  params: {
    content: string,           // 消息文本
    meta?: Record<string, string>  // 透传元数据（thread_id, user 等）
  }
}
```

收到消息后，`wrapChannelMessage()` 将其包装为 XML 标签注入对话（`src/services/mcp/channelNotification.ts:106-116`）：

```xml
<channel source="slack" user="alice" thread_id="T123">
用户消息内容
</channel>
```

模型看到 `<channel>` 标签后，自行决定用哪个工具回复（频道的 MCP 工具如 `send_message`、`SendUserMessage`、或两者兼有）。入队后，`SleepTool` 通过 `hasCommandsInQueue()` 轮询并在 1 秒内唤醒。

**安全细节**：meta 的 key 必须匹配 `SAFE_META_KEY`（`/^[a-zA-Z_][a-zA-Z0-9_]*$/`）以防止 XML 属性注入，value 通过 `escapeXmlAttr()` 转义。

### 远程权限审批流程

当 Claude 遇到需要用户确认的工具调用时，权限中继系统允许用户通过手机频道远程批准（`src/services/mcp/channelPermissions.ts`）：

**出站（CC → 频道服务器）**：

1. Claude Code 生成权限请求，通过 `CHANNEL_PERMISSION_REQUEST_METHOD`（`notifications/claude/channel/permission_request`）发送给声明了 `claude/channel/permission` capability 的频道服务器
2. 请求包含 `request_id`（5 字母短码）、`tool_name`、`description` 和截断后的 `input_preview`（最多 200 字符）

**入站（频道服务器 → CC）**：

1. 人类在频道中回复如 `yes tbxkq`
2. **频道服务器**（非 CC）解析该回复，匹配正则 `PERMISSION_REPLY_RE`（`/^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i`）
3. 服务器发送结构化事件 `notifications/claude/channel/permission`，包含 `{ request_id, behavior: 'allow' | 'deny' }`
4. CC 在 `createChannelPermissionCallbacks()` 创建的回调 Map 中匹配 `request_id`，触发对应的 resolver

**关键设计决策**：CC 不对频道文本做正则匹配——审批必须由服务器主动发出结构化事件。这确保普通对话内容不会意外触发审批。该机制与本地 UI、Bridge、Hooks、Classifier 竞速，首个响应者通过 `claim()` 获胜。

### 白名单查询流程

`channelAllowlist.ts` 管理哪些插件被批准用作频道（`src/services/mcp/channelAllowlist.ts:37-44`）：

1. 从 GrowthBook 特性开关 `tengu_harbor_ledger` 读取原始数据
2. 用 `ChannelAllowlistSchema` 校验为 `{ marketplace, plugin }[]` 数组
3. Teams/Enterprise 组织可通过 managed settings 的 `allowedChannelPlugins` **替换**（非合并）GrowthBook 白名单
4. `getEffectiveChannelAllowlist()` 根据订阅类型决定使用哪个来源（`src/services/mcp/channelNotification.ts:127-138`）

## 函数签名与参数说明

### channelNotification.ts

#### `gateChannelServer(serverName, capabilities, pluginSource): ChannelGateResult`

核心门控函数，决定 MCP 服务器是否可注册为频道。

- **serverName** (`string`)：MCP 服务器名称
- **capabilities** (`ServerCapabilities | undefined`)：服务器声明的 MCP capabilities
- **pluginSource** (`string | undefined`)：插件来源标识（如 `slack@anthropic`）
- **返回值**：`{ action: 'register' }` 或 `{ action: 'skip', kind, reason }`

> 源码位置：`src/services/mcp/channelNotification.ts:191-316`

#### `wrapChannelMessage(serverName, content, meta?): string`

将频道消息包装为 XML 标签。

- **serverName** (`string`)：频道名称，作为 `source` 属性
- **content** (`string`)：消息内容
- **meta** (`Record<string, string>` 可选)：透传元数据，渲染为 XML 属性
- **返回值**：`<channel source="..." ...>content</channel>` 格式字符串

> 源码位置：`src/services/mcp/channelNotification.ts:106-116`

#### `findChannelEntry(serverName, channels): ChannelEntry | undefined`

在 `--channels` 列表中查找匹配的条目。server 类型精确匹配名称，plugin 类型匹配服务器名称的第二段。

> 源码位置：`src/services/mcp/channelNotification.ts:161-173`

#### `getEffectiveChannelAllowlist(sub, orgList): { entries, source }`

返回当前会话的有效白名单。Teams/Enterprise 组织如有自定义列表则替换 GrowthBook 默认列表。

> 源码位置：`src/services/mcp/channelNotification.ts:127-138`

### channelPermissions.ts

#### `isChannelPermissionRelayEnabled(): boolean`

检查 GrowthBook 特性开关 `tengu_harbor_permissions`，控制权限中继是否启用。与频道总开关独立，可单独灰度。

> 源码位置：`src/services/mcp/channelPermissions.ts:36-38`

#### `shortRequestId(toolUseID): string`

将 `toolu_*` 格式的 toolUseID 哈希为 5 字母短码。使用 25 字母表（a-z 去掉 `l`），FNV-1a 哈希 → base-25 编码。包含脏词检测，命中时用 salt 重新哈希（最多重试 10 次）。

- **空间**：25^5 ≈ 980 万个 ID，对单会话的并发权限请求绰绰有余
- **设计考量**：纯字母避免手机键盘数字/字母模式切换

> 源码位置：`src/services/mcp/channelPermissions.ts:140-152`

#### `truncateForPreview(input): string`

将工具输入 JSON 序列化并截断到 200 字符，用于手机端预览。

> 源码位置：`src/services/mcp/channelPermissions.ts:160-167`

#### `filterPermissionRelayClients(clients, isInAllowlist): T[]`

筛选可中继权限请求的 MCP 客户端。三个条件必须同时满足：已连接 + 在 `--channels` 白名单中 + 同时声明 `claude/channel` 和 `claude/channel/permission` 两个 capability。

> 源码位置：`src/services/mcp/channelPermissions.ts:177-194`

#### `createChannelPermissionCallbacks(): ChannelPermissionCallbacks`

工厂函数，创建权限回调管理器。内部维护 `pending` Map（requestId → handler），提供：

- **onResponse(requestId, handler)**：注册一个权限请求的回调，返回取消订阅函数
- **resolve(requestId, behavior, fromServer)**：解析一个待处理请求，返回是否匹配成功

生命周期与 React hook 绑定（每会话一个实例），不使用模块级状态或 AppState。

> 源码位置：`src/services/mcp/channelPermissions.ts:209-240`

### channelAllowlist.ts

#### `getChannelAllowlist(): ChannelAllowlistEntry[]`

从 GrowthBook `tengu_harbor_ledger` 读取并校验频道白名单。校验失败返回空数组。

> 源码位置：`src/services/mcp/channelAllowlist.ts:37-44`

#### `isChannelsEnabled(): boolean`

全局频道开关，检查 GrowthBook `tengu_harbor`。默认 false，5 分钟刷新周期。

> 源码位置：`src/services/mcp/channelAllowlist.ts:51-53`

#### `isChannelAllowlisted(pluginSource): boolean`

独立的白名单检查，用于 UI 预过滤（仅在可能通过门控的服务器旁显示"启用频道？"）。非安全边界——实际注册仍走完整门控。

> 源码位置：`src/services/mcp/channelAllowlist.ts:67-76`

## 接口与类型定义

### `ChannelGateResult`

门控结果联合类型（`src/services/mcp/channelNotification.ts:140-153`）：

| action | kind | 含义 |
|--------|------|------|
| `register` | — | 通过门控，注册通知处理器 |
| `skip` | `capability` | 服务器未声明 `claude/channel` |
| `skip` | `disabled` | 全局频道功能关闭 |
| `skip` | `auth` | 非 OAuth 认证（API key 用户） |
| `skip` | `policy` | 组织策略未启用频道 |
| `skip` | `session` | 不在 `--channels` 列表中 |
| `skip` | `marketplace` | 插件来源与声明不匹配 |
| `skip` | `allowlist` | 不在已批准白名单中 |

### `ChannelPermissionResponse`

```typescript
type ChannelPermissionResponse = {
  behavior: 'allow' | 'deny'
  fromServer: string  // 回复来源的频道服务器名称
}
```

### `ChannelPermissionCallbacks`

```typescript
type ChannelPermissionCallbacks = {
  onResponse(requestId: string, handler: (response: ChannelPermissionResponse) => void): () => void
  resolve(requestId: string, behavior: 'allow' | 'deny', fromServer: string): boolean
}
```

### `ChannelAllowlistEntry`

```typescript
type ChannelAllowlistEntry = {
  marketplace: string  // 如 "anthropic"
  plugin: string       // 如 "slack"
}
```

## 配置项与开关

| 开关 / 配置 | 来源 | 默认值 | 说明 |
|-------------|------|--------|------|
| `tengu_harbor` | GrowthBook | `false` | 频道功能总开关（killswitch） |
| `tengu_harbor_permissions` | GrowthBook | `false` | 权限中继独立开关 |
| `tengu_harbor_ledger` | GrowthBook | `[]` | 已批准频道插件白名单数组 |
| `channelsEnabled` | Managed Settings | — | Teams/Enterprise 组织频道启用开关 |
| `allowedChannelPlugins` | Managed Settings | — | 组织自定义白名单（替换 GrowthBook） |
| `--channels` | CLI 参数 | — | 会话级频道列表（如 `server:slack`, `plugin:telegram@anthropic`） |
| `--dangerously-load-development-channels` | CLI 参数 | — | 绕过白名单检查（仅开发用） |
| 特性门控 `KAIROS` / `KAIROS_CHANNELS` | 编译时 | — | 构建级特性开关，调用方在门控前检查 |

## 边界 Case 与注意事项

- **API key 用户被拒绝**：频道功能仅对 claude.ai OAuth 用户开放，因为 console 端尚无 `channelsEnabled` 管理界面。注释中标注"Drop this when console parity lands"
- **组织白名单替换语义**：Teams/Enterprise 设置 `allowedChannelPlugins` 后完全替换 GrowthBook 白名单，而非合并——管理员全权控制信任决策
- **server 类型条目无法通过白名单**：白名单 schema 是 `{marketplace, plugin}`，server 类型条目永远无法匹配，必须使用 `--dangerously-load-development-channels` 绕过
- **短 ID 脏词过滤**：5 个随机字母可能拼出不当词汇，`shortRequestId()` 内置屏蔽词列表并在命中时自动 rehash
- **权限中继的安全模型**：被攻破的频道服务器可以伪造审批（无需人类参与），但这被视为可接受风险——因为被攻破的频道本身已具有无限对话注入能力，自动审批只是更快而非更强（参见 PR 2956440848 讨论）
- **resolve() 先删后调**：`createChannelPermissionCallbacks` 中 `resolve()` 在调用 handler 前先从 Map 中删除条目，防止 handler 抛异常或重入时产生重复处理
- **Meta key 注入防护**：`SAFE_META_KEY` 正则比 XML 规范更严格（不允许 `:`, `.`, `-`），因为实际频道服务器只使用简单标识符如 `chat_id`、`user`