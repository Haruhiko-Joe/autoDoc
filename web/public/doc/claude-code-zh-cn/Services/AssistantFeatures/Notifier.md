# Notifier — 桌面通知服务

## 概述与职责

Notifier 是 Claude Code 的桌面通知服务模块，位于 **Services → AssistantFeatures** 层级下。当长时间操作（如模型推理、工具执行）完成时，该模块负责向用户发送系统通知提醒。

核心职责：
- 根据用户配置的通知渠道（`auto`/`iterm2`/`kitty`/`ghostty`/`terminal_bell` 等）分发通知
- 在 `auto` 模式下自动检测当前终端类型并选择最佳通知方式
- 执行用户配置的通知钩子（hooks）
- 记录通知方式的分析事件，用于遥测统计

## 关键流程

### 通知发送主流程

`sendNotification()` 是唯一的公开入口，完整调用链如下：

1. 读取全局配置 `getGlobalConfig()` 获取用户偏好的通知渠道 `preferredNotifChannel`（`src/services/notifier.ts:22-23`）
2. 调用 `executeNotificationHooks(notif)` 执行用户配置的通知钩子（`src/services/notifier.ts:25`）
3. 调用内部 `sendToChannel()` 根据渠道类型分发通知（`src/services/notifier.ts:27`）
4. 通过 `logEvent()` 记录分析事件 `tengu_notification_method_used`，包含配置的渠道、实际使用的方法和终端类型（`src/services/notifier.ts:29-35`）

### 渠道分发逻辑

`sendToChannel()` 根据 `channel` 值进行 switch 分发（`src/services/notifier.ts:40-75`）：

| 渠道值 | 行为 | 返回标识 |
|--------|------|----------|
| `auto` | 委托给 `sendAuto()` 自动检测 | 取决于检测结果 |
| `iterm2` | 调用 `terminal.notifyITerm2()` | `"iterm2"` |
| `iterm2_with_bell` | 同时调用 iTerm2 通知 + 响铃 | `"iterm2_with_bell"` |
| `kitty` | 调用 `terminal.notifyKitty()`，附带随机 ID | `"kitty"` |
| `ghostty` | 调用 `terminal.notifyGhostty()` | `"ghostty"` |
| `terminal_bell` | 调用 `terminal.notifyBell()` | `"terminal_bell"` |
| `notifications_disabled` | 不做任何操作 | `"disabled"` |
| 其他 | 不做任何操作 | `"none"` |

所有通知发送逻辑都包裹在 try-catch 中，异常时返回 `"error"` 而不会抛出。

### Auto 自动检测流程

当渠道设为 `auto` 时，`sendAuto()` 根据 `env.terminal` 环境变量自动选择通知方式（`src/services/notifier.ts:77-104`）：

| 终端标识 | 选择的通知方式 |
|----------|----------------|
| `Apple_Terminal` | 先检测 bell 是否禁用，若禁用则使用 `terminal_bell`；否则返回 `no_method_available` |
| `iTerm.app` | iTerm2 原生通知 |
| `kitty` | Kitty 终端通知 |
| `ghostty` | Ghostty 终端通知 |
| 其他终端 | `no_method_available` |

### Apple Terminal Bell 检测

`isAppleTerminalBellDisabled()` 是一个较复杂的辅助函数，用于判断 macOS Terminal.app 的当前配置文件是否禁用了响铃（`src/services/notifier.ts:110-156`）：

1. 通过 `osascript` 获取前台窗口当前使用的配置文件名称
2. 通过 `defaults export com.apple.Terminal -` 导出 Terminal 的完整 plist 配置
3. **延迟加载** `plist` 库解析 XML 配置（约 280KB，仅在 Apple Terminal + auto 模式下加载）
4. 从解析后的 `Window Settings` 中查找对应配置文件的 `Bell` 字段
5. 仅当 `Bell === false` 时返回 `true`，所有异常或缺失情况都安全回退为 `false`

## 函数签名

### `sendNotification(notif: NotificationOptions, terminal: TerminalNotification): Promise<void>`

公开的通知发送入口。

- **notif.message** (`string`)：通知正文内容，必填
- **notif.title** (`string`, 可选)：通知标题，默认为 `"Claude Code"`
- **notif.notificationType** (`string`)：通知类型标识，用于钩子和分析
- **terminal** (`TerminalNotification`)：终端通知能力接口，由 UI 层的 `useTerminalNotification` hook 提供

> 源码位置：`src/services/notifier.ts:18-36`

## 类型定义

### `NotificationOptions`

```typescript
export type NotificationOptions = {
  message: string
  title?: string
  notificationType: string
}
```

> 源码位置：`src/services/notifier.ts:12-16`

## 边界 Case 与注意事项

- **Apple Terminal 的反直觉逻辑**：在 `sendAuto()` 中，Apple Terminal 只有在 bell 被**禁用**时才发送 `terminal_bell` 通知。如果 bell 未被禁用，反而返回 `no_method_available`。这意味着当系统检测到用户已经在配置中关闭了 bell 时，模块仍会尝试用 bell 通知——因为此时 bell 不会发出声音，但可能仍会触发视觉提示（`src/services/notifier.ts:84-91`）。

- **plist 延迟加载**：`plist` 库（约 280KB，含 xmlbuilder 和 @xmldom 依赖）仅在 Apple Terminal + auto 模式下动态 `import()`，避免对其他终端用户造成不必要的加载开销（`src/services/notifier.ts:138`）。

- **Kitty ID 随机生成**：每次 Kitty 通知都会生成一个 0-9999 的随机整数作为通知 ID（`src/services/notifier.ts:106-108`），存在极低概率的 ID 冲突。

- **静默错误处理**：`sendToChannel()` 的 catch 块不会抛出异常，仅返回 `"error"` 字符串。通知失败不会影响主流程。`isAppleTerminalBellDisabled()` 内部同样捕获所有异常并回退为 `false`。

- **钩子先于通知执行**：`executeNotificationHooks()` 在 `sendToChannel()` 之前调用，即使通知渠道被禁用（`notifications_disabled`），钩子仍会执行。

- **依赖注入设计**：通知的实际发送能力通过 `TerminalNotification` 接口注入，而非模块内部直接操作终端。这使得通知服务与具体的终端渲染解耦，便于测试。