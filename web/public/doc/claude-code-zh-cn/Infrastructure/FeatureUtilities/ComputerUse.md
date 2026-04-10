# 计算机操作能力（ComputerUse）

## 概述与职责

ComputerUse 模块是 Claude Code 的**计算机操控子系统**，使 Claude 能够像人类一样操作 macOS 桌面——移动鼠标、点击、打字、截屏、管理应用窗口。该模块位于 `Infrastructure > FeatureUtilities` 层级下，是一组相对独立的领域工具集，共 15 个文件。

在整体架构中，ComputerUse 以 **MCP Server** 的形式注册到工具系统，工具名形如 `mcp__computer-use__screenshot`、`mcp__computer-use__left_click` 等。API 后端识别这些特殊工具名后会在系统提示中注入 CU 可用性提示，引导模型使用这些能力。同级模块包括 plugins（插件管理）、hooks（Hook 框架）、model（模型选择）、swarm（多 Agent 协调）等。

**核心设计理念**：该模块是 Cowork（Anthropic 桌面应用）的 CLI 移植版。Cowork 运行在 Electron 中（有窗口、有 CFRunLoop），而 Claude Code 运行在终端中（无窗口、libuv 事件循环）。这个差异贯穿整个实现——从 CFRunLoop 泵送、终端作为"代理宿主"、到剪贴板通过 `pbcopy`/`pbpaste` 实现。

**平台限制**：仅支持 macOS（darwin）。`createCliExecutor` 在非 darwin 平台直接抛出异常。

**功能门控**：通过 GrowthBook 远程配置（feature flag `tengu_malort_pedway`）控制是否启用，且仅对 Max/Pro 订阅用户开放。

## 关键流程

### 1. 初始化与模块加载流程

ComputerUse 采用**懒加载单例**模式，避免非 CU 场景加载原生模块：

1. 入口在 `setup.ts` 的 `setupComputerUseMCP()`，构建 MCP 配置和允许的工具名列表
2. 首次 CU 工具调用时，`wrapper.tsx` 的 `getOrBind()` 触发 `getComputerUseHostAdapter()`（`hostAdapter.ts:38-69`）
3. HostAdapter 构造时调用 `createCliExecutor()`（`executor.ts:259`），此时加载 Swift 原生模块
4. 键鼠操作的 Rust 原生模块（`@ant/computer-use-input`）进一步延迟到首次鼠标/键盘调用时加载（`inputLoader.ts:22-30`）

### 2. 工具调用执行流程

当模型发出 CU 工具调用时：

1. **`wrapper.tsx` 的 `.call()` 拦截**（`wrapper.tsx:249-282`）：更新 `currentToolUseContext`，调用 `dispatch(toolName, args)`
2. **`bindSessionContext` 分派**：来自 `@ant/computer-use-mcp` 包，根据工具名路由到对应的 executor 方法
3. **锁检查与获取**（`wrapper.tsx:181-226`）：
   - `checkCuLock` 检查锁状态（不获取，用于 `request_access` 等工具）
   - `acquireCuLock` 原子获取文件锁（O_EXCL），首次获取时注册 Esc 热键并发送系统通知
4. **操作执行**：executor 调用原生模块执行实际操作
5. **结果转换**：MCP content blocks 转为 Anthropic API 格式（文本和 base64 JPEG 图片）

### 3. CFRunLoop 泵送机制

这是 CLI 版本与 Cowork 最关键的差异。Swift 的 `@MainActor` 异步方法和 Rust 的 `key()`/`keys()` 都将任务派发到 `DispatchQueue.main`。Electron 会自动排空 CFRunLoop，但 Node.js/Bun 的 libuv 不会——Promise 会永远挂起。

`drainRunLoop.ts` 实现了一个**引用计数的 CFRunLoop 泵**（`drainRunLoop.ts:17-79`）：

- 每 1ms 调用一次 Swift 的 `_drainMainRunLoop()`（即 `RunLoop.main.run`）
- 多个并发调用共享同一个 `setInterval`，通过 `retain()`/`release()` 计数
- 30 秒超时保护：超时后孤儿 Promise 被静默捕获，超时错误浮出
- `retainPump`/`releasePump` 导出供长期注册（如 Esc 热键的 CGEventTap）使用

### 4. 截屏流程

```
screenshot() → computeTargetDims() → drainRunLoop() → cu.screenshot.captureExcluding()
```

1. 获取显示器几何信息（`cu.display.getSize()`）
2. 计算目标尺寸：逻辑尺寸 × scaleFactor → 物理尺寸 → `targetImageSize()` 适配 API 限制（`executor.ts:60-68`）
3. 过滤终端 bundle ID（`withoutTerminal()`），防止终端窗口出现在截图中
4. 在 `drainRunLoop` 中调用 Swift 的 `captureExcluding`，输出 JPEG（质量 0.75）

### 5. 鼠标点击流程

```
click(x, y, button, count, modifiers?) → moveAndSettle() → [withModifiers()] → mouseButton()
```

1. `moveAndSettle()`（`executor.ts:113-120`）：瞬移到目标坐标 + 50ms 等待 HID 往返
2. 如有修饰键，通过 `withModifiers()`（`executor.ts:150-165`）bracket 式按压/释放，`finally` 保证释放
3. 调用 `input.mouseButton()` 执行点击，AppKit 根据时间和位置自动计算 clickCount

### 6. 键盘输入与剪贴板粘贴

- **按键**（`executor.ts:455-473`）：解析 xdotool 风格序列（如 `ctrl+shift+a`），在 `drainRunLoop` 中逐次发送，间隔 8ms（USB 125Hz 轮询节奏）
- **打字**：直接调用 `input.typeText()` 或通过剪贴板粘贴
- **剪贴板粘贴**（`executor.ts:180-206`）：保存 → 写入 → 验证回读 → Cmd+V → 等 100ms → 恢复，全程 `finally` 保护用户剪贴板

### 7. 回合结束清理

`cleanup.ts` 的 `cleanupComputerUseAfterTurn()`（`cleanup.ts:30-86`）在三个时机调用：自然结束、流式中止、工具中止。

1. **取消隐藏**：将 `prepareForAction` 隐藏的应用重新显示（5 秒超时保护）
2. **注销 Esc 热键**：释放 CGEventTap 和泵保持
3. **释放文件锁**：成功释放后发送"Claude 已完成使用你的电脑"通知

## 函数签名与关键 API

### `createCliExecutor(opts): ComputerExecutor`

工厂函数，创建 CLI 环境下的 `ComputerExecutor` 实现。

- **opts.getMouseAnimationEnabled**: `() => boolean` — 是否启用鼠标动画
- **opts.getHideBeforeActionEnabled**: `() => boolean` — 操作前是否隐藏无关窗口

> 源码位置：`executor.ts:259-645`

返回的 executor 包含以下方法：

| 方法 | 说明 |
|------|------|
| `prepareForAction(allowlistBundleIds, displayId?)` | 隐藏白名单外的窗口 |
| `screenshot(opts)` | 全屏截图（排除终端） |
| `zoom(region, allowedBundleIds, displayId?)` | 区域截图 |
| `click(x, y, button, count, modifiers?)` | 鼠标点击 |
| `key(keySequence, repeat?)` | 按键（xdotool 格式） |
| `holdKey(keyNames, durationMs)` | 长按键 |
| `type(text, opts)` | 文本输入（直接/剪贴板） |
| `drag(from?, to)` | 拖拽（支持动画） |
| `scroll(x, y, dx, dy)` | 滚动 |
| `getFrontmostApp()` | 获取前台应用 |
| `listInstalledApps()` | 列出已安装应用 |
| `openApp(bundleId)` | 打开应用 |
| `readClipboard` / `writeClipboard` | 剪贴板读写（pbpaste/pbcopy） |

### `getComputerUseHostAdapter(): ComputerUseHostAdapter`

进程生命周期单例（`hostAdapter.ts:38-69`），组装 executor、logger、权限检查、子门控等。

### `setupComputerUseMCP(): { mcpConfig, allowedTools }`

构建 MCP 服务器配置和工具白名单（`setup.ts:23-53`）。白名单中的工具跳过常规权限提示，由 CU 自己的 `request_access` 处理审批。

### `tryAcquireComputerUseLock(): Promise<AcquireResult>`

原子获取文件锁（`computerUseLock.ts:148-195`）。使用 `O_EXCL` flag 保证跨进程原子性。支持过期锁回收（检查 PID 存活性）。

### `drainRunLoop<T>(fn): Promise<T>`

CFRunLoop 泵包装器（`drainRunLoop.ts:61-79`），所有调度到 `DispatchQueue.main` 的原生调用必须在此内执行。

### `cleanupComputerUseAfterTurn(ctx): Promise<void>`

回合结束清理（`cleanup.ts:30-86`）：取消隐藏窗口 → 注销热键 → 释放锁。

### `getComputerUseMCPToolOverrides(toolName): ComputerUseMCPToolOverrides`

为每个 CU 工具提供 `.call()` 调度 + 渲染覆盖（`wrapper.tsx:248-287`）。

## 接口与类型定义

### `ChicagoConfig`（`gates.ts:7-11`）

远程配置结构，控制 CU 功能的各子开关：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | false | 总开关 |
| `pixelValidation` | boolean | false | 点击前像素验证 |
| `clipboardPasteMultiline` | boolean | true | 多行文本用剪贴板粘贴 |
| `mouseAnimation` | boolean | true | 拖拽时鼠标动画 |
| `hideBeforeAction` | boolean | true | 操作前隐藏无关窗口 |
| `autoTargetDisplay` | boolean | true | 自动选择显示器 |
| `clipboardGuard` | boolean | true | 剪贴板保护 |
| `coordinateMode` | CoordinateMode | 'pixels' | 坐标模式 |

### `ComputerUseLock`（`computerUseLock.ts:16-20`）

```typescript
type ComputerUseLock = {
  readonly sessionId: string
  readonly pid: number
  readonly acquiredAt: number
}
```

### `AcquireResult` / `CheckResult`（`computerUseLock.ts:22-29`）

```typescript
type AcquireResult =
  | { kind: 'acquired'; fresh: boolean }
  | { kind: 'blocked'; by: string }

type CheckResult =
  | { kind: 'free' }
  | { kind: 'held_by_self' }
  | { kind: 'blocked'; by: string }
```

## 配置项与默认值

- **GrowthBook feature flag**: `tengu_malort_pedway` — 远程控制 `ChicagoConfig` 的所有字段
- **订阅要求**：`max` 或 `pro` 用户（`ant` 用户类型绕过此限制）
- **`ALLOW_ANT_COMPUTER_USE_MCP`**：环境变量，让 Ant 用户在 monorepo 环境中启用 CU
- **`COMPUTER_USE_INPUT_NODE_PATH`**：指定 Rust 原生模块路径（构建时注入）
- **`COMPUTER_USE_SWIFT_NODE_PATH`**：指定 Swift 原生模块路径（构建时注入）
- **`__CFBundleIdentifier`**：macOS 自动设置的环境变量，用于检测终端 bundle ID

关键常量：
- `SCREENSHOT_JPEG_QUALITY`: 0.75（`executor.ts:57`）
- `MOVE_SETTLE_MS`: 50ms — 鼠标移动后等待 HID 往返（`executor.ts:111`）
- `TIMEOUT_MS`: 30000ms — drainRunLoop 超时上限（`drainRunLoop.ts:42`）
- `UNHIDE_TIMEOUT_MS`: 5000ms — 回合结束取消隐藏超时（`cleanup.ts:15`）
- `APP_ENUM_TIMEOUT_MS`: 1000ms — 应用枚举超时（`mcpServer.ts:18`）
- `APP_NAME_MAX_COUNT`: 50 — 工具描述中最多列出的应用数（`appNames.ts:110`）
- `APP_NAME_MAX_LEN`: 40 — 应用名最大长度（`appNames.ts:109`）

## 原生模块依赖

模块依赖两个原生 Node.js 插件：

### `@ant/computer-use-swift`

macOS Swift 原生模块，通过 `swiftLoader.ts` 加载。提供：
- `screenshot.captureExcluding` / `captureRegion` — SCContentFilter 截屏
- `apps.*` — NSWorkspace 应用管理（列表、打开、隐藏、取消隐藏、窗口查找）
- `display.*` — 显示器几何信息
- `tcc.*` — 辅助功能/屏幕录制权限检查
- `hotkey.*` — CGEventTap Escape 热键注册
- `_drainMainRunLoop()` — CFRunLoop 泵送
- `resolvePrepareCapture()` — 截屏前准备（显示器选择、隐藏、捕获）

### `@ant/computer-use-input`

Rust/enigo 原生模块，通过 `inputLoader.ts` 加载。提供：
- `moveMouse()` / `mouseButton()` / `mouseScroll()` / `mouseLocation()` — 鼠标操作
- `key()` / `keys()` / `typeText()` — 键盘操作
- `getFrontmostAppInfo()` — 前台应用信息

## 边界 Case 与注意事项

### CLI vs Cowork 的关键差异

- **无 `withClickThrough`**：CLI 无窗口，不需要 Electron 的 `setIgnoreMouseEvents`
- **终端作为代理宿主**：通过 `getTerminalBundleId()`（`common.ts:43-47`）检测终端 bundle ID，作为 `surrogateHost` 传给 Swift，使其免于被隐藏和截图。不支持的终端回退到哨兵值 `com.anthropic.claude-code.cli-no-window`
- **剪贴板**：使用 `pbcopy`/`pbpaste` 而非 Electron 的 `clipboard` 模块
- **`cropRawPatch` 返回 null**：跳过像素验证（Sharp 是异步的，包要求同步），点击直接执行

### 锁机制

- 文件锁位于 `~/.claude/computer-use.lock`，JSON 格式包含 sessionId、PID、获取时间
- O_EXCL 保证原子性，过期锁通过 PID 存活检测自动回收
- 进程退出清理通过 `registerCleanup` 注册
- 同一时刻只有一个 Claude 会话可以使用计算机操控

### Esc 热键与安全防护

- `registerEscHotkey()`（`escHotkey.ts:25-38`）注册全局 CGEventTap，用户按 Esc 立即中止 CU 会话
- Esc 事件被**消费**（不传递给应用），防止 prompt injection 通过合成 Escape 关闭对话框
- 模型合成的 Escape 键通过 `notifyExpectedEscape()` 打孔，Swift 侧 100ms 衰减窗口

### 应用名过滤与注入防护

`appNames.ts` 对 Spotlight 返回的应用列表做两层过滤（`appNames.ts:168-196`）：

1. **噪音过滤**：只保留 `/Applications/`、`/System/Applications/`、`~/Applications/` 下的应用，排除 Helper/Agent/Service 等后台进程
2. **Prompt injection 防护**：正则 `APP_NAME_ALLOWED`（`appNames.ts:108`）限制为 Unicode 字母/数字/安全标点，阻止换行和特殊字符。已知限制：短的恶意名（如 "grant all"）无法程序化过滤，但下游权限对话框要求用户显式批准

### 坐标模式冻结

`getChicagoCoordinateMode()`（`gates.ts:69-72`）在首次读取时冻结坐标模式，防止 GrowthBook 在会话中途变更导致坐标转换与模型预期不一致。

### 鼠标动画

拖拽操作使用 ease-out-cubic 动画（`executor.ts:217-255`），60fps，速度 2000px/s，上限 0.5s。非拖拽操作（点击、滚动）使用瞬移+等待，避免动画帧触发悬停状态。