# Init —— 进程级初始化逻辑

## 概述与职责

`init.ts` 是 Claude Code 应用的**进程级初始化入口**，位于 `Entrypoints` 层。它在 CLI、MCP Server、SDK 等任何启动模式下都会被调用，负责在业务逻辑运行前完成所有必要的环境准备工作——包括配置系统启用、TLS/代理网络配置、遥测初始化、OAuth 预取、远程设置加载、清理回调注册等。

整个初始化逻辑通过 `lodash-es/memoize` 包装，**确保在同一进程中只执行一次**，即使被多个入口路径重复调用也不会产生副作用。

该模块导出两个函数：
- `init()` —— 主初始化函数，处理所有非遥测的启动准备
- `initializeTelemetryAfterTrust()` —— 遥测初始化，需在用户信任确认后单独调用

## 关键流程

### 主初始化流程 (`init`)

`init()` 是一个被 `memoize` 包裹的异步函数，按以下顺序执行（`src/entrypoints/init.ts:57-238`）：

1. **配置系统启用**：调用 `enableConfigs()` 验证并激活配置系统（第 65 行）
2. **安全环境变量应用**：调用 `applySafeConfigEnvironmentVariables()`，在信任对话框之前只应用安全的环境变量（第 74 行）
3. **TLS 证书配置**：调用 `applyExtraCACertsFromConfig()` 将 `settings.json` 中的 `NODE_EXTRA_CA_CERTS` 应用到 `process.env`。注释特别说明必须在首次 TLS 握手之前完成，因为 Bun 的 BoringSSL 会在启动时缓存证书库（第 79 行）
4. **优雅关闭注册**：调用 `setupGracefulShutdown()` 确保退出时刷新所有资源（第 87 行）
5. **1P 事件日志初始化**：通过动态 `import()` 懒加载 `firstPartyEventLogger` 和 `growthbook`，启动第一方事件日志记录，并注册 GrowthBook 配置刷新回调（第 94-105 行）
6. **OAuth 账户信息预取**：fire-and-forget 方式调用 `populateOAuthAccountInfoIfNeeded()`，处理 VSCode 扩展登录后可能缺失的 OAuth 信息（第 110 行）
7. **IDE 检测**：异步初始化 JetBrains IDE 检测，填充缓存供后续同步访问（第 114 行）
8. **Git 仓库检测**：异步检测当前 GitHub 仓库信息，为 gitDiff PR 链接填充缓存（第 118 行）
9. **远程托管设置 / 策略限制加载**：根据资格条件初始化远程设置和策略限制的加载 Promise，包含超时保护防止死锁（第 123-128 行）
10. **首次启动时间记录**：调用 `recordFirstStartTime()`（第 132 行）
11. **mTLS 配置**：调用 `configureGlobalMTLS()` 配置全局双向 TLS 设置（第 137 行）
12. **代理配置**：调用 `configureGlobalAgents()` 配置全局 HTTP Agent（代理和/或 mTLS）（第 146 行）
13. **API 预连接**：调用 `preconnectAnthropicApi()`，与 Anthropic API 提前进行 TCP+TLS 握手（约 100-200ms），与后续操作重叠执行。仅在直连模式下生效，代理/mTLS/云供应商等场景跳过（第 159 行）
14. **上游代理初始化**（仅 CCR 远程模式）：当 `CLAUDE_CODE_REMOTE` 环境变量为真时，启动本地 CONNECT 中继代理，支持凭证注入。失败时 fail-open 继续运行（第 167-183 行）
15. **Windows Shell 设置**：调用 `setShellIfWindows()` 在 Windows 上配置 git-bash（第 186 行）
16. **清理回调注册**：注册 LSP 服务器管理器关闭回调和 Swarm 团队清理回调（第 189-200 行）
17. **Scratchpad 目录初始化**：如果启用了 scratchpad 功能，创建对应目录（第 203-209 行）

### 遥测初始化流程 (`initializeTelemetryAfterTrust`)

遥测初始化被故意分离到单独的函数中，因为它**必须在用户确认信任之后才能执行**（`src/entrypoints/init.ts:247-286`）：

1. **远程设置路径**（`isEligibleForRemoteManagedSettings() === true`）：
   - 对于 SDK/headless 模式且启用了 beta tracing 的情况，先进行急切初始化以确保 tracer 就绪
   - 等待远程托管设置加载完成
   - 重新应用环境变量（`applyConfigEnvironmentVariables()`）以包含远程设置
   - 然后初始化遥测

2. **直接路径**（非远程设置用户）：直接调用 `doInitializeTelemetry()`

### 遥测内部实现 (`doInitializeTelemetry` + `setMeterState`)

`doInitializeTelemetry` 通过模块级 `telemetryInitialized` 标志位防止重复初始化（`src/entrypoints/init.ts:288-303`）。失败时重置标志位允许重试。

`setMeterState` 懒加载 OpenTelemetry 模块（约 400KB），初始化 OTLP 遥测（指标、日志、追踪），然后创建 `AttributedCounter` 工厂函数，将 meter 注入全局状态（`src/entrypoints/init.ts:305-340`）。`AttributedCounter` 每次调用 `add()` 时都会获取最新的遥测属性，确保属性始终是最新的。

## 函数签名

### `init(): Promise<void>`

主初始化函数，通过 `memoize` 确保只执行一次。

- **返回值**：`Promise<void>`
- **幂等性**：由 `memoize` 保证，重复调用返回首次执行的 Promise
- **错误处理**：`ConfigParseError` 会被捕获并展示配置错误对话框；非交互模式下直接输出到 stderr 并退出

> 源码位置：`src/entrypoints/init.ts:57-238`

### `initializeTelemetryAfterTrust(): void`

在信任确认后初始化 OpenTelemetry 遥测。内部异步但函数本身同步返回（fire-and-forget 模式，错误被捕获并记录日志）。

- **调用时机**：用户接受信任对话框之后
- **前置条件**：`init()` 已完成
- **幂等性**：内部通过 `telemetryInitialized` 标志位防止重复初始化

> 源码位置：`src/entrypoints/init.ts:247-286`

## 配置项与错误处理

### 环境变量

| 环境变量 | 作用 | 使用位置 |
|---------|------|---------|
| `CLAUDE_CODE_REMOTE` | 标识 CCR 远程模式，触发上游代理初始化 | 第 167 行 |
| `NODE_EXTRA_CA_CERTS` | 自定义 CA 证书路径（通过 settings.json 配置） | 第 79 行 |

### 错误处理策略

- **ConfigParseError**：配置解析失败时，交互模式下动态加载 `InvalidConfigDialog` 展示错误 UI；非交互模式下输出到 stderr 并调用 `gracefulShutdownSync(1)` 退出（`src/entrypoints/init.ts:215-237`）
- **上游代理初始化失败**：fail-open 策略，记录警告日志后继续运行（第 177-182 行）
- **遥测初始化失败**：记录错误日志后静默继续，不影响主流程（第 253-258, 272-276, 279-283 行）

## 边界 Case 与注意事项

- **memoize 保证单次执行**：`init` 使用 `lodash-es/memoize` 包装，无论被调用多少次都只执行一次。但注意 `memoize` 缓存的是 Promise，如果首次调用抛出非 `ConfigParseError` 异常，后续调用会返回同一个 rejected Promise
- **遥测延迟加载**：OpenTelemetry 模块（约 400KB）和 gRPC 导出器（约 700KB via `@grpc/grpc-js`）均通过动态 `import()` 懒加载，避免影响启动速度
- **信任分界线**：`applySafeConfigEnvironmentVariables()` 和 `applyConfigEnvironmentVariables()` 是分开调用的——前者在信任对话框之前，后者在信任确认且远程设置加载后。这意味着某些配置的环境变量只有在信任确认后才会生效
- **TLS 证书时序要求**：`applyExtraCACertsFromConfig()` 必须在任何 TLS 连接之前调用，因为 Bun 的 BoringSSL 在启动时缓存证书库
- **CCR 上游代理仅在远程模式激活**：上游代理初始化通过 `CLAUDE_CODE_REMOTE` 环境变量门控，且模块通过动态 import 懒加载，非 CCR 启动不承担模块加载开销
- **1P 事件日志的 GrowthBook 联动**：注册了 `onGrowthBookRefresh` 回调，当特性开关配置 `tengu_1p_event_batch_config` 变更时自动重建日志 provider，但内部有变更检测避免无谓重建
- **Swarm 团队清理**：注册了退出清理回调，自动清理会话期间创建的 Swarm 团队资源，解决了 gh-32730 中子 Agent 创建的团队文件残留问题