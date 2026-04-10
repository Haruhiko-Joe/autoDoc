# Orchestration — 桥接入口与主循环编排层

## 概述与职责

Orchestration 模块是 Bridge 子系统的**入口与主循环编排层**，负责桥接守护进程的完整生命周期管理。它位于 `BridgeAndRemote > Bridge` 层级下，与同级的 RemoteSession（远程 CCR 会话管理）、DirectConnect（直连会话管理）和 UpstreamProxy（上游代理）协作，共同构成 Remote Control 模式的核心实现。

本模块由三个文件组成，各司其职：

- **`bridgeMain.ts`**：守护进程（daemon）的主入口，实现多会话独立桥接守护进程的完整生命周期——参数解析、环境注册、轮询循环、会话派发、心跳保活、Token 刷新和优雅关闭
- **`initReplBridge.ts`**：REPL 模式的桥接引导器，读取启动状态后根据特性门控委派给 v1（env-based）或 v2（env-less）核心
- **`bridgeEnabled.ts`**：运行时特性门控层，提供订阅校验、版本兼容性检查和特性开关判断

## 关键流程

### 1. 守护进程启动流程（`bridgeMain.ts`）

`bridgeMain()` 是 `claude remote-control` 命令的主入口，启动流程分为以下阶段：

1. **参数解析**：`parseArgs()` 解析 CLI 参数（`--spawn`、`--capacity`、`--name`、`--session-id`、`--continue` 等）（`src/bridge/bridgeMain.ts:1737-1887`）
2. **前置校验**：启用配置读取（`enableConfigs`）、初始化分析 Sink、验证工作区信任状态、验证 OAuth 令牌
3. **多会话门控**：通过 GrowthBook `tengu_ccr_bridge_multi_session` 门控检查是否允许 `--spawn`/`--capacity` 等多会话参数
4. **确定 Spawn 模式**：按优先级 `resume > --spawn 参数 > 已保存偏好 > 门控默认值` 决定最终模式（`single-session`、`same-dir`、`worktree`）（`src/bridge/bridgeMain.ts:2278-2302`）
5. **环境注册**：调用 `api.registerBridgeEnvironment(config)` 向服务器注册桥接环境，获取 `environmentId` 和 `environmentSecret`（`src/bridge/bridgeMain.ts:2450-2467`）
6. **预创建会话**：默认在当前目录预创建一个空会话，让用户可以立即开始输入（`src/bridge/bridgeMain.ts:2662-2698`）
7. **写入崩溃恢复指针**：`bridge-pointer.json` 文件用于 `--continue` 恢复，每小时刷新（`src/bridge/bridgeMain.ts:2700-2729`）
8. **进入轮询循环**：调用 `runBridgeLoop()` 开始工作轮询

### 2. 主轮询循环（`runBridgeLoop`）

`runBridgeLoop()` 是桥接守护进程的核心，实现了一个带退避策略的持续轮询循环（`src/bridge/bridgeMain.ts:141-1580`）：

```
while (!loopSignal.aborted) {
    pollForWork → 解码 workSecret → switch(work.type) {
        'session':  ackWork → 决定v1/v2路径 → registerWorker → 创建worktree → spawn子进程
        'healthcheck': ackWork → 记录日志
    }
    // 容量满时进入心跳模式，定期发送 heartbeat 保持 lease 存活
}
```

**工作派发细节**：
- 每次循环调用 `api.pollForWork()` 从服务器的 Redis Stream 获取工作项
- 已完成的工作项通过 `completedWorkIds` 集合去重，避免重复派发
- 当收到 `session` 类型工作项时，先检查是否有同 ID 的活跃会话——若有，仅刷新 Token；若无且未达容量上限，才派发新会话
- CCR v2 路径：调用 `registerWorker()` 注册 worker 并获取 epoch，使用 `/v1/code/sessions/{id}` 端点
- CCR v1 路径：使用 Session-Ingress WebSocket URL

**容量管理**：
- 达到容量上限时进入**心跳模式**（`non_exclusive_heartbeat_interval_ms`），通过 `heartbeatActiveWorkItems()` 定期发送心跳保持 lease 存活（`src/bridge/bridgeMain.ts:650-731`）
- `capacityWake` 信号在会话完成时立即唤醒轮询，避免等待完整的 sleep 周期
- 心跳检测到 JWT 过期（401/403）时，通过 `api.reconnectSession()` 触发服务端重新派发

**退避策略**（双轨制）：
- **连接错误轨**（`ECONNREFUSED`、`ETIMEDOUT` 等）：初始 2s，上限 2min，放弃阈值 10min
- **通用错误轨**：初始 500ms，上限 30s，放弃阈值 10min
- 所有延迟加 ±25% 抖动（`addJitter`）
- **系统休眠检测**：若两次错误间隔超过退避上限 2 倍，判定为系统休眠/唤醒，重置错误预算

### 3. 会话生命周期管理

每个会话从派发到完成经历以下阶段：

1. **Spawn**：`safeSpawn()` 通过 `SessionSpawner` 创建子进程，传入 `sdkUrl`、`accessToken` 和可选的 `workerEpoch`（`src/bridge/bridgeMain.ts:1026-1061`）
2. **Worktree 隔离**（可选）：`worktree` 模式下，非初始会话会调用 `createAgentWorktree()` 创建隔离的 git worktree（`src/bridge/bridgeMain.ts:977-1015`）
3. **Token 刷新**：`createTokenRefreshScheduler` 在 JWT 到期前 5 分钟主动刷新。v1 直接向子进程传递新 OAuth Token，v2 通过 `reconnectSession` 触发服务端重新派发（`src/bridge/bridgeMain.ts:284-313`）
4. **超时监控**：可配置的会话超时看门狗，超时后 SIGTERM 会话进程（`src/bridge/bridgeMain.ts:1678-1697`）
5. **完成处理**：`onSessionDone` 回调清理所有状态（Map 条目、计时器、Token 刷新），调用 `stopWork` 通知服务端，清理 worktree（`src/bridge/bridgeMain.ts:442-591`）

### 4. 优雅关闭流程

关闭顺序（`src/bridge/bridgeMain.ts:1403-1580`）：

1. 停止状态显示更新
2. SIGTERM 所有活跃会话子进程
3. 等待子进程退出（30s 宽限期）
4. SIGKILL 超时未退出的进程
5. 清理 worktree
6. 调用 `stopWork` 通知服务端所有工作项已结束
7. 归档所有会话（`archiveSession`）
8. 注销环境（`deregisterEnvironment`），使 Web UI 显示桥接离线
9. 清除崩溃恢复指针

单会话模式的特殊处理：若非致命退出，跳过归档和注销，打印 `--continue` 恢复命令，保留指针文件。

### 5. REPL 桥接初始化（`initReplBridge.ts`）

`initReplBridge()` 是 REPL 模式下桥接的引导入口，被 `useReplBridge`（自动启动）和 `print.ts`（SDK `-p` 模式）调用（`src/bridge/initReplBridge.ts:110-545`）：

1. **门控检查链**：
   - `isBridgeEnabledBlocking()` — 订阅和特性门控
   - `getBridgeAccessToken()` — OAuth 令牌存在性
   - `isPolicyAllowed('allow_remote_control')` — 组织策略
   - 跨进程 OAuth 死令牌退避（3 次失败后静默跳过）（`src/bridge/initReplBridge.ts:177-187`）
   - 主动刷新过期 OAuth 令牌（`src/bridge/initReplBridge.ts:201`）
2. **v1/v2 分支**：
   - 若 `isEnvLessBridgeEnabled()` 返回 true 且非 perpetual 模式，走 **env-less（v2）路径**——动态导入 `remoteBridgeCore.js`，跳过环境注册/轮询/心跳
   - 否则走 **env-based（v1）路径**——委托 `initBridgeCore()` 处理注册、轮询等
3. **会话标题派生**：按优先级 `initialName > /rename > 最近用户消息 > 随机 slug` 确定初始标题。`onUserMessage` 回调在第 1 条和第 3 条用户消息时自动生成更精确的标题（通过 Haiku 模型）（`src/bridge/initReplBridge.ts:258-378`）

> **架构注意**：`initReplBridge.ts` 与 `replBridge.ts` 故意分离——前者导入 `sessionStorage`（间接拉入整个 React 组件树 ~1300 模块），后者（`initBridgeCore`）不依赖 `sessionStorage`，使 Agent SDK 打包不会膨胀。

### 6. Headless 桥接模式（daemon worker）

`runBridgeHeadless()` 是非交互式守护进程入口（`src/bridge/bridgeMain.ts:2810-2965`）：
- 由 `remoteControl` daemon worker 调用
- 无 readline 对话框、无 stdin 键盘监听、无 TUI、无 `process.exit()`
- 配置从调用方（`daemon.json`）传入，认证通过 IPC（supervisor 的 AuthManager）获取
- 使用简化的 `createHeadlessBridgeLogger`，所有日志路由到单行日志函数
- 致命错误抛出 `BridgeHeadlessPermanentError`，supervisor 据此决定是否重试

## 函数签名与参数说明

### `bridgeMain(args: string[]): Promise<void>`

守护进程（standalone）主入口。解析 CLI 参数，完成环境注册，进入轮询循环。进程退出时调用 `process.exit()`。

### `runBridgeLoop(config, environmentId, environmentSecret, api, spawner, logger, signal, backoffConfig?, initialSessionId?, getAccessToken?): Promise<void>`

核心轮询循环。参数说明：
- `config: BridgeConfig` — 桥接配置（目录、分支、spawn 模式、最大会话数等）
- `environmentId / environmentSecret` — 注册返回的环境凭证
- `api: BridgeApiClient` — 桥接 API 客户端（轮询、心跳、ACK、停止工作等）
- `spawner: SessionSpawner` — 会话子进程创建器
- `logger: BridgeLogger` — 日志/UI 抽象层
- `signal: AbortSignal` — 外部中止信号（SIGINT/SIGTERM）
- `getAccessToken` — 可选的异步 Token 获取器，用于 Token 刷新

### `runBridgeHeadless(opts: HeadlessBridgeOpts, signal: AbortSignal): Promise<void>`

非交互式 headless 模式入口，供 daemon worker 使用。`opts` 包含目录、spawn 模式、容量、认证获取器等。

### `initReplBridge(options?: InitBridgeOptions): Promise<ReplBridgeHandle | null>`

REPL 模式桥接初始化。返回 `ReplBridgeHandle`（控制句柄）或 `null`（门控未通过）。关键回调选项：
- `onInboundMessage` — 收到远程消息时触发
- `onPermissionResponse` — 权限响应回调
- `onInterrupt` — 中断回调
- `onStateChange` — 桥接状态变更通知
- `perpetual` — 是否为持久会话模式（跨重启连续性）
- `outboundOnly` — 是否仅转发出站事件（CCR 镜像模式）

## 接口/类型定义

### `BackoffConfig`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| connInitialMs | number | 2000 | 连接错误初始退避 |
| connCapMs | number | 120000 | 连接错误退避上限 |
| connGiveUpMs | number | 600000 | 连接错误放弃阈值 |
| generalInitialMs | number | 500 | 通用错误初始退避 |
| generalCapMs | number | 30000 | 通用错误退避上限 |
| generalGiveUpMs | number | 600000 | 通用错误放弃阈值 |
| shutdownGraceMs | number | 30000 | SIGTERM→SIGKILL 宽限期 |
| stopWorkBaseDelayMs | number | 1000 | stopWork 重试基础延迟 |

### `ParsedArgs`

CLI 参数解析结果，包含 `verbose`、`sandbox`、`spawnMode`（`'single-session' | 'same-dir' | 'worktree'`）、`capacity`、`sessionId`、`continueSession` 等字段。

### `InitBridgeOptions`

REPL 桥接初始化选项，定义了各种事件回调和初始状态。

### `BridgeHeadlessPermanentError`

表示不可重试的配置错误（工作区未信任、worktree 不可用、非 HTTPS URL），supervisor 据此停止重试。

## 配置项与默认值

### 特性门控（GrowthBook）

| 门控标识 | 用途 | 默认 |
|----------|------|------|
| `tengu_ccr_bridge` | Remote Control 总开关 | false |
| `tengu_bridge_repl_v2` | env-less 桥接路径（v2 REPL） | false |
| `tengu_bridge_repl_v2_cse_shim_enabled` | `cse_*` → `session_*` ID 转换兼容 | true |
| `tengu_ccr_bridge_multi_session` | 多会话 spawn 模式门控 | false |
| `tengu_bridge_min_version` | v1 路径最低版本要求 | '0.0.0' |
| `tengu_cobalt_harbor` | 自动连接 CCR 默认开关 | false |
| `tengu_ccr_mirror` | CCR 镜像模式（出站只读转发） | false |
| `tengu_bridge_initial_history_cap` | 初始历史消息数上限 | 200 |

### 环境变量

| 变量 | 用途 |
|------|------|
| `CLAUDE_BRIDGE_BASE_URL` | 覆盖桥接 API 基础 URL（ant 本地开发用） |
| `CLAUDE_BRIDGE_SESSION_INGRESS_URL` | WebSocket 会话入口 URL（ant 本地开发用） |
| `CLAUDE_BRIDGE_OAUTH_TOKEN` | 覆盖 OAuth Token（ant 本地开发用） |
| `CLAUDE_BRIDGE_USE_CCR_V2` | 强制使用 CCR v2 传输（ant 开发覆盖） |
| `CLAUDE_CODE_CCR_MIRROR` | 本地启用 CCR 镜像模式 |

### Spawn 模式

| 模式 | 说明 | 默认最大会话 |
|------|------|-------------|
| `single-session` | 单会话，会话结束即退出 | 1 |
| `same-dir` | 多会话共享当前目录 | 32 |
| `worktree` | 多会话，每个会话独立 git worktree | 32 |

## 边界 Case 与注意事项

- **跨进程 OAuth 死令牌退避**：当同一过期令牌（按 `expiresAt` 匹配）被 3 个进程连续尝试失败后，后续进程静默跳过，避免无效的 401 请求风暴。新 `/login` 产生的令牌有不同的 `expiresAt`，自动解除退避
- **系统休眠检测**：轮询循环中若两次错误间隔超过 `connCapMs * 2`（默认 4min），判定为系统休眠恢复，重置错误预算而非累积到放弃阈值
- **会话 ID 兼容**：v2 工作端点返回 `cse_*` 前缀的 ID，但 Sessions API 和 claude.ai 前端期望 `session_*` 前缀。`toCompatSessionId()` 负责转换，受 `tengu_bridge_repl_v2_cse_shim_enabled` 门控控制
- **`initReplBridge.ts` 的模块拆分**：从 `replBridge.ts` 拆出是为了避免 `sessionStorage` 的传递依赖（~1300 模块）污染 Agent SDK 打包体积
- **perpetual 模式**：env-less 路径尚未实现 perpetual 支持（bridge-pointer.json 跨重启连续性），此类会话回退到 env-based 路径
- **stopWork 重试**：采用 3 次指数退避（1s/2s/4s），确保服务端得知工作项已结束，防止 Redis Stream 中出现僵尸条目
- **Token 刷新分叉**：v1 会话直接向子进程传递新 OAuth Token；v2 会话不能使用 OAuth（CCR worker 端点校验 JWT 的 `session_id` 声明），必须通过 `reconnectSession` 触发服务端重新派发
- **Build-time 特性剥离**：所有 `feature('BRIDGE_MODE')` / `feature('KAIROS')` 门控使用正模式（positive ternary），确保在外部构建中内联字符串字面量被 tree-shake 移除