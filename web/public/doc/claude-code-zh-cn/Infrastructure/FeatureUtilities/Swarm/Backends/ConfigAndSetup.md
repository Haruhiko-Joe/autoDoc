# 后端配置、安装引导与模式快照

## 概述与职责

本模块隶属于 **Infrastructure → FeatureUtilities → Swarm → Backends** 层级，是多 Agent 协调（Swarm）子系统中终端后端的配置与安装基础设施。它由三个文件组成，各自承担明确职责：

- **it2Setup.ts**：it2 CLI 工具的检测、安装和验证工具链，以及用户后端偏好的持久化管理
- **teammateModeSnapshot.ts**：会话启动时捕获 TeammateMode 的快照机制，保证会话内模式一致性
- **It2SetupPrompt.tsx**：基于 React/Ink 的交互式安装引导 UI，引导用户完成 it2 安装和 Python API 启用

在 Swarm 架构中，这三个模块为 `registry.ts`（后端自动检测与注册）和 `ITermBackend`（iTerm2 分屏后端）提供前置依赖——只有 it2 安装就绪且 TeammateMode 确定后，Swarm 才能选择正确的终端后端来分屏创建 Teammate。

同级兄弟模块包括 PermissionSync（跨 Agent 权限协调）、TeammateLifecycle（Teammate 全生命周期管理）和 TeamConfig（团队配置与辅助工具）。

---

## 关键流程

### 1. Python 包管理器检测与 it2 安装流程

这是用户首次在 iTerm2 中使用 Swarm 功能时触发的核心流程。

1. **检测包管理器**：`detectPythonPackageManager()` 按优先级依次检查 `uv` → `pipx` → `pip` → `pip3`，通过 `which` 命令判断可用性（`it2Setup.ts:40-72`）
2. **安装 it2**：`installIt2()` 根据检测到的包管理器执行对应安装命令（`it2Setup.ts:90-144`）：
   - `uvx`：执行 `uv tool install it2`（全局隔离环境）
   - `pipx`：执行 `pipx install it2`（隔离环境）
   - `pip`：执行 `pip install --user it2`，失败则回退到 `pip3`
   - **安全措施**：所有安装命令的 `cwd` 强制设为 `homedir()`，避免读取项目级 `pip.conf`/`uv.toml` 被恶意重定向到攻击者的 PyPI 服务器
3. **验证连通性**：`verifyIt2Setup()` 执行 `it2 session list` 测试与 iTerm2 的 Python API 连接（`it2Setup.ts:152-195`）
4. **持久化状态**：验证通过后调用 `markIt2SetupComplete()` 将 `iterm2It2SetupComplete: true` 写入全局配置，后续不再弹出安装引导

### 2. TeammateMode 快照捕获流程

该流程保证会话内 Teammate 执行模式不受运行时配置变更影响。

1. **CLI 覆盖设置**（可选）：如果用户通过 `--teammate-mode` CLI 参数指定模式，在会话启动前调用 `setCliTeammateModeOverride()` 存入模块级变量（`teammateModeSnapshot.ts:25-27`）
2. **快照捕获**：`captureTeammateModeSnapshot()` 在 `main.tsx` 中被早期调用（`teammateModeSnapshot.ts:56-69`）：
   - 若存在 CLI 覆盖 → 使用覆盖值
   - 否则 → 从全局配置读取 `teammateMode`，默认为 `'auto'`
3. **运行时读取**：后续所有调用 `getTeammateModeFromSnapshot()` 均返回启动时的快照值，忽略配置变更
4. **运行时清除**（可选）：用户在 UI 中手动切换模式时，调用 `clearCliTeammateModeOverride(newMode)` 同时清除 CLI 覆盖并更新快照

### 3. 交互式安装引导 UI 流程

`It2SetupPrompt` 组件是一个多步骤状态机，状态流转如下：

```
initial → installing → install-failed ─→ (retry) → installing
    │          │                    └──→ use-tmux / cancelled
    │          └─→ api-instructions → verifying → success → onDone('installed')
    │                                      └──→ failed → (retry) / use-tmux / cancelled
    └─→ use-tmux / cancelled
```

1. **initial**：组件挂载时自动调用 `detectPythonPackageManager()` 检测可用包管理器，展示三个选项——"Install it2 now"、"Use tmux instead"（仅 tmux 可用时显示）、"Cancel"
2. **installing**：用户选择安装后进入此状态，显示 Spinner + 安装进度
3. **api-instructions**：安装成功后，提示用户在 iTerm2 中启用 Python API（`iTerm2 → Settings → General → Magic → Enable Python API`），按 Enter 继续验证
4. **verifying**：执行 `verifyIt2Setup()` 验证连通性
5. **success**：验证通过，调用 `markIt2SetupComplete()` 持久化，1.5 秒后回调 `onDone('installed')`
6. **install-failed / failed**：提供重试、切换 tmux、取消三个选项

用户可以在任何非阻塞步骤通过 Esc 取消，通过 Ctrl+C/D 退出。

---

## 函数签名与参数说明

### it2Setup.ts

#### `detectPythonPackageManager(): Promise<PythonPackageManager | null>`

检测系统可用的 Python 包管理器。按 `uv` → `pipx` → `pip` → `pip3` 优先级检测。返回 `'uvx' | 'pipx' | 'pip'` 或 `null`。

> 源码位置：`src/utils/swarm/backends/it2Setup.ts:40-72`

#### `isIt2CliAvailable(): Promise<boolean>`

通过 `which it2` 检查 it2 CLI 是否已安装且在 PATH 中。

> 源码位置：`src/utils/swarm/backends/it2Setup.ts:79-82`

#### `installIt2(packageManager: PythonPackageManager): Promise<It2InstallResult>`

使用指定包管理器安装 it2。返回 `{ success, error?, packageManager? }`。

> 源码位置：`src/utils/swarm/backends/it2Setup.ts:90-144`

#### `verifyIt2Setup(): Promise<It2VerifyResult>`

验证 it2 是否已正确配置，通过执行 `it2 session list` 测试与 iTerm2 的 Python API 连接。返回值中 `needsPythonApiEnabled` 标记是否需要用户手动启用 Python API。

> 源码位置：`src/utils/swarm/backends/it2Setup.ts:152-195`

#### `getPythonApiInstructions(): string[]`

返回启用 iTerm2 Python API 的操作指引文本数组。

> 源码位置：`src/utils/swarm/backends/it2Setup.ts:200-208`

#### `markIt2SetupComplete(): void`

将 `iterm2It2SetupComplete: true` 写入全局配置，防止再次弹出安装引导。幂等操作——已标记时不重复写入。

> 源码位置：`src/utils/swarm/backends/it2Setup.ts:214-223`

#### `setPreferTmuxOverIterm2(prefer: boolean): void`

将用户的后端偏好（`preferTmuxOverIterm2`）持久化到全局配置。当用户选择 "Use tmux instead" 时被调用。

> 源码位置：`src/utils/swarm/backends/it2Setup.ts:229-238`

#### `getPreferTmuxOverIterm2(): boolean`

读取全局配置中的 `preferTmuxOverIterm2` 偏好，默认为 `false`。

> 源码位置：`src/utils/swarm/backends/it2Setup.ts:243-245`

### teammateModeSnapshot.ts

#### `setCliTeammateModeOverride(mode: TeammateMode): void`

设置 CLI 模式覆盖。必须在 `captureTeammateModeSnapshot()` 之前调用。

> 源码位置：`src/utils/swarm/backends/teammateModeSnapshot.ts:25-27`

#### `captureTeammateModeSnapshot(): void`

在会话启动时捕获 TeammateMode。CLI 覆盖优先于全局配置，配置缺失时默认为 `'auto'`。

> 源码位置：`src/utils/swarm/backends/teammateModeSnapshot.ts:56-69`

#### `getTeammateModeFromSnapshot(): TeammateMode`

获取当前会话的 TeammateMode 快照。如果在 `captureTeammateModeSnapshot()` 之前调用，会记录错误并触发延迟捕获。

> 源码位置：`src/utils/swarm/backends/teammateModeSnapshot.ts:75-87`

#### `clearCliTeammateModeOverride(newMode: TeammateMode): void`

清除 CLI 覆盖并用新模式更新快照。在用户通过 UI 切换模式时调用，避免 CLI 覆盖遮蔽用户的新选择。

> 源码位置：`src/utils/swarm/backends/teammateModeSnapshot.ts:43-49`

---

## 接口与类型定义

### `PythonPackageManager`

```typescript
type PythonPackageManager = 'uvx' | 'pipx' | 'pip'
```

Python 包管理器类型，按安装优先级排列。注意 `'uvx'` 实际对应 `uv tool install` 命令（非 `uvx run`），保留该名称是为了类型兼容。

### `It2InstallResult`

```typescript
type It2InstallResult = {
  success: boolean
  error?: string
  packageManager?: PythonPackageManager
}
```

### `It2VerifyResult`

```typescript
type It2VerifyResult = {
  success: boolean
  error?: string
  needsPythonApiEnabled?: boolean  // true 表示需要用户手动启用 Python API
}
```

### `TeammateMode`

```typescript
type TeammateMode = 'auto' | 'tmux' | 'in-process'
```

Teammate 执行模式：`auto` 由 `registry.ts` 自动检测最佳后端，`tmux` 强制使用 Tmux 后端，`in-process` 使用同进程内执行。

### `It2SetupPrompt Props`

```typescript
type Props = {
  onDone: (result: 'installed' | 'use-tmux' | 'cancelled') => void
  tmuxAvailable: boolean
}
```

`onDone` 回调通知父组件安装结果；`tmuxAvailable` 控制是否显示 "Use tmux instead" 选项。

---

## 配置项与持久化

本模块通过 `getGlobalConfig()` / `saveGlobalConfig()` 读写以下全局配置字段：

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `iterm2It2SetupComplete` | `boolean` | `undefined` | 标记 it2 安装引导是否已完成 |
| `preferTmuxOverIterm2` | `boolean` | `undefined`（等同 `false`） | 用户是否偏好 tmux 而非 iTerm2 分屏 |
| `teammateMode` | `TeammateMode` | `'auto'` | Teammate 执行模式，由快照模块在启动时读取 |

---

## 边界 Case 与注意事项

- **安全防护**：`installIt2()` 将所有安装命令的工作目录强制设为用户 home 目录（`it2Setup.ts:96`），防止项目级 `pip.conf` 或 `uv.toml` 将包源重定向到恶意 PyPI 服务器
- **pip 回退**：当 `pip` 安装失败时，会自动尝试 `pip3`（`it2Setup.ts:118-125`），兼容 macOS 等系统中 `pip` 指向 Python 2 的情况
- **快照初始化顺序**：`captureTeammateModeSnapshot()` 必须在 `main.tsx` 中 CLI 参数解析之后、会话逻辑开始之前调用。如果 `getTeammateModeFromSnapshot()` 在捕获前被调用，会记录错误并触发延迟捕获作为防御措施（`teammateModeSnapshot.ts:76-84`）
- **模式不可变语义**：快照一旦捕获，`getTeammateModeFromSnapshot()` 在整个会话生命周期内返回一致值。唯一例外是 `clearCliTeammateModeOverride()` 被显式调用时更新快照
- **安装引导的状态管理**：`It2SetupPrompt` 在 `installing` 和 `verifying` 状态下禁用键盘快捷键（Esc/N），防止用户在异步操作进行中意外取消
- **验证成功后的延时回调**：`onDone('installed')` 通过 `setTimeout` 延迟 1.5 秒触发（`It2SetupPrompt.tsx:75`），让用户有时间看到成功提示