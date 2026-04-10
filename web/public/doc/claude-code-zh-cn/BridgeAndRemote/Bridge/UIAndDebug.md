# 终端状态展示与调试工具（UIAndDebug）

## 概述与职责

UIAndDebug 模块是 Bridge（远程控制桥接）系统的**终端展示层与调试辅助层**，由四个文件组成：

- **bridgeUI.ts** — 桥接日志器工厂，管理终端实时状态渲染（状态行、QR 码、会话列表、闪烁动画）
- **bridgeStatusUtil.ts** — 状态展示辅助函数集（URL 构建、时间格式化、Shimmer 动画计算、活动缩写等）
- **bridgeDebug.ts** — Ant-only 故障注入机制，用于手动测试桥接恢复路径
- **debugUtils.ts** — 调试日志工具（密钥脱敏、API 错误描述提取、日志截断）

在整体架构中，本模块属于 **BridgeAndRemote → Bridge** 子系统。Bridge 系统实现了 Remote Control 模式——在本地环境注册后轮询云端工作、管理子进程会话。UIAndDebug 负责将桥接运行状态实时展示在终端，并提供开发阶段的故障注入和调试日志能力。同级模块包括 RemoteSession（CCR 会话管理）、DirectConnect（直连会话）和 UpstreamProxy（容器侧代理）。

## 关键流程

### 1. 桥接日志器的创建与状态渲染

`createBridgeLogger()` 是本模块的核心入口，返回一个 `BridgeLogger` 对象，封装了所有终端输出逻辑。其内部维护一个**状态机**，状态类型定义在 `bridgeStatusUtil.ts:10-15`：

```
idle → attached → titled → reconnecting → failed
```

渲染流程如下：

1. `printBanner()` 被调用时，构建连接 URL、生成 QR 码、启动 connecting 旋转动画（`src/bridge/bridgeUI.ts:295-320`）
2. 首次 `updateIdleStatus()` 停止 connecting 动画，切换到 `idle` 状态，显示绿色 "Ready" 指示器（`src/bridge/bridgeUI.ts:376-386`）
3. 当会话连接时，`setAttached()` 切换到 `attached` 状态，显示青色 "Connected"，并在单会话模式下切换 QR 码为会话专属 URL（`src/bridge/bridgeUI.ts:388-405`）
4. `renderStatusLine()` 是核心渲染函数，负责组合所有 UI 元素：QR 码、状态指示、会话列表、工具活动、页脚链接（`src/bridge/bridgeUI.ts:188-292`）

**终端行管理**：通过 `statusLineCount` 跟踪当前状态区占用的终端行数，每次重绘前用 ANSI 转义序列上移光标并擦除（`clearStatusLines()`），再重新写入。`countVisualLines()` 考虑了终端宽度换行和多字节字符，确保行数计算准确（`src/bridge/bridgeUI.ts:95-115`）。

### 2. 多会话模式的状态展示

当 `sessionMax > 1` 时，UI 进入多会话展示模式：

1. 显示容量行："Capacity: 2/5 · New sessions will be created in an isolated worktree"
2. 以子弹列表展示每个活跃会话的标题（可点击的 OSC 8 超链接）和当前活动摘要
3. `addSession()` / `removeSession()` / `setSessionTitle()` / `updateSessionActivity()` 管理 `sessionDisplayInfo` Map（`src/bridge/bridgeUI.ts:494-521`）
4. QR 码和页脚链接保持在环境级 URL（而非会话级），方便用户创建更多会话

### 3. Shimmer 闪烁动画

`bridgeStatusUtil.ts` 提供了一套基于视觉列位置的 shimmer 动画系统：

1. `computeGlimmerIndex()` 根据 tick 计数和消息宽度计算当前高亮位置，实现从右到左的反向扫描效果（`src/bridge/bridgeStatusUtil.ts:61-67`）
2. `computeShimmerSegments()` 将文本按高亮位置拆分为 `{ before, shimmer, after }` 三段（`src/bridge/bridgeStatusUtil.ts:79-111`）
3. 使用 grapheme segmenter 进行字素级分割，正确处理 emoji、CJK 字符等多字节文本
4. 动画间隔由 `SHIMMER_INTERVAL_MS = 150ms` 控制

### 4. 故障注入机制（Ant-only）

`bridgeDebug.ts` 提供了一套仅限内部员工使用的故障注入系统，用于手动测试桥接的恢复路径：

1. 通过 REPL 中的 `/bridge-kick` 命令触发
2. `registerBridgeDebugHandle()` 注册桥接实例的调试句柄，暴露 `fireClose`、`forceReconnect`、`injectFault`、`wakePollLoop` 等操作（`src/bridge/bridgeDebug.ts:38-52`）
3. `injectBridgeFault()` 将故障描述压入队列（`src/bridge/bridgeDebug.ts:70-75`）
4. `wrapApiForFaultInjection()` 包装 `BridgeApiClient`，在每次 API 调用前检查队列，匹配则抛出对应错误（`src/bridge/bridgeDebug.ts:84-135`）
5. 故障分两类：`fatal`（抛 `BridgeFatalError` → 触发 teardown）和 `transient`（抛普通 `Error` → 触发重试/退避）

可注入故障的 API 方法：`pollForWork`、`registerBridgeEnvironment`、`reconnectSession`、`heartbeatWork`。

### 5. 密钥脱敏与错误描述

`debugUtils.ts` 确保调试日志不泄露敏感信息：

1. `redactSecrets()` 用正则匹配 JSON 中的敏感字段名（`session_ingress_token`、`environment_secret`、`access_token`、`secret`、`token`），对长度 ≥ 16 的值保留前 8 后 4 字符、中间用 `...` 替代，短值直接替换为 `[REDACTED]`（`src/bridge/debugUtils.ts:26-34`）
2. `debugBody()` 先脱敏再截断到 2000 字符限制（`src/bridge/debugUtils.ts:46-53`）
3. `describeAxiosError()` 从 axios 错误中提取服务器响应体的 `message` 或 `error.message` 字段，拼接到错误描述中（`src/bridge/debugUtils.ts:60-82`）

## 函数签名与参数说明

### bridgeUI.ts

#### `createBridgeLogger(options): BridgeLogger`

创建桥接日志器实例，管理所有终端输出。

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.verbose` | `boolean` | 是否输出详细日志（环境 ID、spawn 模式等） |
| `options.write` | `(s: string) => void` | 可选的输出函数，默认 `process.stdout.write` |

返回的 `BridgeLogger` 对象包含以下方法：

| 方法 | 说明 |
|------|------|
| `printBanner(config, environmentId)` | 打印启动 banner，生成 QR 码，启动 connecting 动画 |
| `logSessionStart(sessionId, prompt)` | 记录会话开始（仅 verbose 模式） |
| `logSessionComplete(sessionId, durationMs)` | 记录会话完成及耗时 |
| `logSessionFailed(sessionId, error)` | 记录会话失败 |
| `updateIdleStatus()` | 切换到空闲状态（停止动画，显示 "Ready"） |
| `setAttached(sessionId)` | 切换到已连接状态 |
| `updateReconnectingStatus(delayStr, elapsedStr)` | 显示重连中状态（含旋转动画） |
| `updateFailedStatus(error)` | 显示失败状态 |
| `updateSessionStatus(sessionId, elapsed, activity, trail)` | 更新会话活动状态 |
| `toggleQr()` | 切换 QR 码显示/隐藏 |
| `updateSessionCount(active, max, mode)` | 更新会话计数和 spawn 模式 |
| `addSession(sessionId, url)` / `removeSession(sessionId)` | 管理多会话列表条目 |
| `setSessionTitle(sessionId, title)` | 设置会话标题 |
| `refreshDisplay()` | 强制重绘状态区 |

### bridgeStatusUtil.ts

| 函数 | 签名 | 说明 |
|------|------|------|
| `timestamp()` | `() => string` | 返回 `HH:MM:SS` 格式时间戳 |
| `abbreviateActivity(summary)` | `(string) => string` | 将活动摘要截断到 30 字符宽度 |
| `buildBridgeConnectUrl(environmentId, ingressUrl?)` | `(string, string?) => string` | 构建环境连接 URL：`{baseUrl}/code?bridge={envId}` |
| `buildBridgeSessionUrl(sessionId, environmentId, ingressUrl?)` | `(string, string, string?) => string` | 构建会话 URL：`{sessionUrl}?bridge={envId}` |
| `computeGlimmerIndex(tick, messageWidth)` | `(number, number) => number` | 计算 shimmer 动画当前高亮列位置 |
| `computeShimmerSegments(text, glimmerIndex)` | `(string, number) => { before, shimmer, after }` | 按视觉列位置拆分文本为三段 |
| `getBridgeStatus(state)` | `({error, connected, sessionActive, reconnecting}) => BridgeStatusInfo` | 从连接状态推导标签和颜色 |
| `wrapWithOsc8Link(text, url)` | `(string, string) => string` | 用 OSC 8 转义序列包装终端超链接 |

### bridgeDebug.ts

| 函数 | 签名 | 说明 |
|------|------|------|
| `registerBridgeDebugHandle(h)` | `(BridgeDebugHandle) => void` | 注册当前桥接实例的调试句柄 |
| `clearBridgeDebugHandle()` | `() => void` | 清除调试句柄和故障队列 |
| `getBridgeDebugHandle()` | `() => BridgeDebugHandle \| null` | 获取当前调试句柄 |
| `injectBridgeFault(fault)` | `(BridgeFault) => void` | 向队列中添加故障注入 |
| `wrapApiForFaultInjection(api)` | `(BridgeApiClient) => BridgeApiClient` | 包装 API 客户端，拦截调用并注入故障 |

### debugUtils.ts

| 函数 | 签名 | 说明 |
|------|------|------|
| `redactSecrets(s)` | `(string) => string` | 脱敏 JSON 字符串中的密钥字段 |
| `debugTruncate(s)` | `(string) => string` | 折叠换行并截断到 2000 字符 |
| `debugBody(data)` | `(unknown) => string` | 脱敏 + 截断，适用于 JSON 可序列化数据 |
| `describeAxiosError(err)` | `(unknown) => string` | 从 axios 错误中提取详细描述 |
| `extractHttpStatus(err)` | `(unknown) => number \| undefined` | 提取 HTTP 状态码 |
| `extractErrorDetail(data)` | `(unknown) => string \| undefined` | 从响应体中提取错误消息 |
| `logBridgeSkip(reason, debugMsg?, v2?)` | `(string, string?, boolean?) => void` | 记录桥接初始化跳过事件（含 analytics） |

## 接口/类型定义

### `StatusState`（bridgeStatusUtil.ts:10-15）

桥接状态机的五种状态：

| 状态 | 含义 |
|------|------|
| `idle` | 空闲等待连接，显示绿色 "Ready" |
| `attached` | 会话已连接，显示青色 "Connected" |
| `titled` | 已连接且有标题（单会话模式下主状态行显示会话标题） |
| `reconnecting` | 重连中，显示黄色旋转动画 |
| `failed` | 失败，显示红色错误 |

### `BridgeFault`（bridgeDebug.ts:22-36）

故障注入描述：

| 字段 | 类型 | 说明 |
|------|------|------|
| `method` | `'pollForWork' \| 'registerBridgeEnvironment' \| 'reconnectSession' \| 'heartbeatWork'` | 要注入故障的 API 方法 |
| `kind` | `'fatal' \| 'transient'` | 故障类型——fatal 触发 teardown，transient 触发重试 |
| `status` | `number` | HTTP 状态码 |
| `errorType` | `string?` | 可选的错误类型标识 |
| `count` | `number` | 剩余注入次数，每次消费递减 |

### `BridgeDebugHandle`（bridgeDebug.ts:38-52）

调试句柄接口，暴露给 `/bridge-kick` 命令：

| 方法 | 说明 |
|------|------|
| `fireClose(code)` | 直接触发 WebSocket 关闭处理器，测试 ws_closed → 重连升级 |
| `forceReconnect()` | 强制调用 `reconnectEnvironmentWithSession()`（等价于 SIGUSR2） |
| `injectFault(fault)` | 向队列添加故障 |
| `wakePollLoop()` | 唤醒处于 at-capacity 睡眠中的轮询循环 |
| `describe()` | 返回 env/session ID，方便 debug.log 过滤 |

### `BridgeStatusInfo`（bridgeStatusUtil.ts:114-121）

状态标签与颜色的组合类型，供 UI 组件（包括 React/Ink 侧的 bridge.tsx）使用。

## 配置项与常量

| 常量 | 值 | 位置 | 说明 |
|------|------|------|------|
| `TOOL_DISPLAY_EXPIRY_MS` | `30000` | bridgeStatusUtil.ts:18 | 工具活动行在最后一次 tool_start 后的可见时长 |
| `SHIMMER_INTERVAL_MS` | `150` | bridgeStatusUtil.ts:21 | Shimmer 动画 tick 间隔 |
| `DEBUG_MSG_LIMIT` | `2000` | debugUtils.ts:9 | 调试日志截断字符上限 |
| `REDACT_MIN_LENGTH` | `16` | debugUtils.ts:25 | 低于此长度的密钥值直接替换为 `[REDACTED]` |
| `SECRET_FIELD_NAMES` | 见下 | debugUtils.ts:11-17 | 需脱敏的 JSON 字段名列表 |
| `QR_OPTIONS` | `{ type: 'utf8', errorCorrectionLevel: 'L', small: true }` | bridgeUI.ts:30-34 | QR 码生成参数 |

`SECRET_FIELD_NAMES`：`session_ingress_token`、`environment_secret`、`access_token`、`secret`、`token`。

## 边界 Case 与注意事项

- **状态守卫**：`renderStatusLine()` 在 `reconnecting` 和 `failed` 状态下直接返回，不清除状态行——这防止了 `toggleQr()` 或 `setSpawnModeDisplay()` 在这些状态下意外擦除旋转动画或错误信息（`src/bridge/bridgeUI.ts:189-194`）
- **Worktree 模式隐藏分支**：当 `spawnMode === 'worktree'` 时，状态行不显示分支名，因为每个会话有独立分支，显示桥接的分支会产生误导（`src/bridge/bridgeUI.ts:220`）
- **故障注入仅限 Ant**：`wrapApiForFaultInjection()` 仅在 `USER_TYPE === 'ant'` 时被调用，外部构建零开销（`src/bridge/bridgeDebug.ts:83`）
- **模块级状态**：`bridgeDebug.ts` 使用模块级的 `debugHandle` 和 `faultQueue`——这是有意为之，因为每个 REPL 进程只有一个桥接实例，且 `/bridge-kick` 命令无法访问 `initBridgeCore` 的闭包（`src/bridge/bridgeDebug.ts:19`）
- **脱敏策略的阈值**：长度 < 16 的密钥值被完全替换为 `[REDACTED]`，避免短 token 通过前缀/后缀泄露（`src/bridge/debugUtils.ts:28-29`）
- **OSC 8 链接兼容性**：`wrapWithOsc8Link()` 生成的终端超链接对 `stringWidth` 和 `strip-ansi` 透明，不影响行宽计算（`src/bridge/bridgeStatusUtil.ts:157-163`）
- **ANT-ONLY 调试行**：当 `USER_TYPE === 'ant'` 且有 debug log 路径时，状态区顶部会额外显示一行日志路径提示（`src/bridge/bridgeUI.ts:224-228`）