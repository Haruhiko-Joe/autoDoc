# 环境检测与后端注册中心（DetectionAndRegistry）

## 概述与职责

本模块是 Swarm 多 Agent 协调子系统中**后端选择的基础设施层**，由两个紧密协作的文件组成：

- **`detection.ts`**：终端环境探测器，负责判断当前进程运行在哪种终端环境中（tmux 内部、iTerm2、或普通终端）
- **`registry.ts`**：后端选择编排器，基于环境检测结果按优先级选择最合适的 Teammate 执行后端，并提供统一的 `TeammateExecutor` 入口

在整体架构中，本模块位于 **Infrastructure → FeatureUtilities → Swarm → Backends** 层级。它是 Backends 子系统的核心决策组件——上游的 TeammateLifecycle 和 TeamConfig 等模块通过 `getTeammateExecutor()` 获取执行器，而不需要关心底层使用的是 tmux 分屏、iTerm2 原生分屏还是进程内执行。

## 关键流程

### 环境检测流程（detection.ts）

detection.ts 在**模块加载时**（即 `import` 时）立即捕获两个关键环境变量并缓存：

```typescript
// src/utils/swarm/backends/detection.ts:10
const ORIGINAL_USER_TMUX = process.env.TMUX

// src/utils/swarm/backends/detection.ts:19
const ORIGINAL_TMUX_PANE = process.env.TMUX_PANE
```

**为什么要在加载时捕获？** 因为 `Shell.ts` 在初始化 Claude 自身的 socket 时会覆盖 `process.env.TMUX`。如果延迟读取，就无法准确判断用户是否从 tmux 中启动了 Claude。

检测函数使用缓存模式——首次调用计算结果，后续直接返回缓存值，因为终端环境在进程生命周期内不会改变。

**重要设计决策**：`isInsideTmux()` 仅检查 `TMUX` 环境变量，**不会**执行 `tmux display-message` 作为回退。原因是该命令只要系统上有任何 tmux 服务器在运行就会成功，而不能确认当前进程是否真的在 tmux 内部。（`src/utils/swarm/backends/detection.ts:33-35`）

### 后端优先级检测流程（registry.ts）

`detectAndGetBackend()` 实现了一套严格的优先级检测链（`src/utils/swarm/backends/registry.ts:136-254`）：

```
                         ┌─────────────────┐
                         │  开始检测        │
                         └────────┬────────┘
                                  │
                         ┌────────▼────────┐
                    Yes  │ 在 tmux 内部？   │
                   ┌─────┤                  │
                   │     └────────┬────────┘
                   │              │ No
            ┌──────▼──────┐      │
            │ TmuxBackend │ ┌────▼──────────┐
            │ (内部模式)   │ │ 在 iTerm2 中？ │
            └─────────────┘ └────┬──────┬───┘
                            Yes  │      │ No
                    ┌────────────▼─┐    │
                    │用户偏好 tmux？│    │
                    └──┬───────┬───┘    │
                  Yes  │       │ No     │
                       │  ┌────▼──────┐ │
                       │  │it2 可用？  │ │
                       │  └──┬─────┬──┘ │
                       │ Yes │     │ No │
                       │ ┌───▼────┐│   │
                       │ │ ITerm  ││   │
                       │ │Backend ││   │
                       │ └────────┘│   │
                       │     ┌─────▼───▼───┐
                       │     │ tmux 可用？   │
                       │     └──┬────────┬──┘
                       │   Yes  │        │ No
                  ┌────▼────────▼──┐  ┌──▼────────┐
                  │ TmuxBackend    │  │ 抛出错误   │
                  │ (外部会话模式)  │  │ (安装指引) │
                  └───────────────┘  └───────────┘
```

关键细节：

1. **tmux 内部优先**：如果用户已经在 tmux 会话中，直接使用 tmux 分屏，即使也在 iTerm2 中
2. **iTerm2 原生分屏**：需要 `it2` CLI 工具可用且 Python API 已启用。检测时使用 `it2 session list` 而非 `it2 --version`，因为后者即使 Python API 被禁用也会成功（`src/utils/swarm/backends/detection.ts:113-115`）
3. **用户偏好尊重**：通过 `getPreferTmuxOverIterm2()` 检查用户是否明确选择了 tmux，避免重复提示安装 it2
4. **平台适配的错误信息**：当没有可用后端时，`getTmuxInstallInstructions()` 根据 macOS/Linux/WSL/Windows 提供不同的安装指引（`src/utils/swarm/backends/registry.ts:259-285`）

### isInProcessEnabled 判断流程

`isInProcessEnabled()` 决定是否使用进程内执行模式（`src/utils/swarm/backends/registry.ts:351-389`）：

1. **非交互式会话**（`-p` 模式）：强制返回 `true`，因为没有终端 UI 就无法使用 tmux 分屏
2. **TeammateMode 为 `'in-process'`**：直接返回 `true`
3. **TeammateMode 为 `'tmux'`**：直接返回 `false`
4. **TeammateMode 为 `'auto'`**（默认）：
   - 如果之前已经触发过 in-process 回退（`inProcessFallbackActive`），保持 in-process
   - 否则检查是否在 tmux 或 iTerm2 中——如果是，使用 Pane 后端；如果都不是，使用 in-process

### 自注册模式避免循环依赖

registry.ts 通过**动态 import + 自注册**模式解决循环依赖问题：

1. registry.ts 声明两个占位变量 `TmuxBackendClass` 和 `ITermBackendClass`（`src/utils/swarm/backends/registry.ts:60-66`）
2. 暴露 `registerTmuxBackend()` 和 `registerITermBackend()` 注册函数
3. `TmuxBackend.ts` 和 `ITermBackend.ts` 在各自模块加载时调用对应的注册函数
4. `ensureBackendsRegistered()` 通过动态 `import()` 触发后端模块的加载和自注册（`src/utils/swarm/backends/registry.ts:74-79`）

这样 registry.ts 无需静态 import 后端实现类，避免了 registry ↔ backend 之间的循环依赖。

## 函数签名与参数说明

### detection.ts 导出函数

#### `isInsideTmuxSync(): boolean`
同步判断当前进程是否在 tmux 内部运行。直接返回启动时捕获的 `TMUX` 环境变量是否存在。

#### `isInsideTmux(): Promise<boolean>`
异步版本，带缓存。逻辑与同步版本相同，首次调用后缓存结果。

#### `getLeaderPaneId(): string | null`
返回启动时捕获的 Leader tmux pane ID（如 `%0`、`%1`）。不在 tmux 中时返回 `null`。

#### `isTmuxAvailable(): Promise<boolean>`
检测系统是否安装了 tmux。通过执行 `tmux -V` 判断。

#### `isInITerm2(): boolean`
同步检测是否在 iTerm2 中运行。使用三种检测方式的**或运算**：
- `TERM_PROGRAM === 'iTerm.app'`
- `ITERM_SESSION_ID` 存在
- `env.terminal === 'iTerm.app'`

#### `isIt2CliAvailable(): Promise<boolean>`
检测 `it2` CLI 是否可用且能连接 iTerm2 Python API。执行 `it2 session list`（而非 `--version`）。

#### `resetDetectionCache(): void`
重置所有缓存结果，用于测试。

### registry.ts 导出函数

#### `getTeammateExecutor(preferInProcess?: boolean): Promise<TeammateExecutor>`
**统一入口**。根据 `preferInProcess` 参数和 `isInProcessEnabled()` 结果选择执行器：
- `preferInProcess=true` 且 in-process 启用时 → 返回 `InProcessBackend`
- 否则 → 返回 `PaneBackendExecutor`（自动检测并包装合适的 PaneBackend）

#### `detectAndGetBackend(): Promise<BackendDetectionResult>`
执行完整的优先级检测流程，返回包含三个字段的检测结果：
- `backend: PaneBackend` — 检测到的后端实例
- `isNative: boolean` — 是否为原生分屏（tmux 内部或 iTerm2+it2）
- `needsIt2Setup: boolean` — 是否建议用户安装 it2

#### `isInProcessEnabled(): boolean`
判断当前会话是否应使用进程内执行模式。综合考虑 TeammateMode 配置、非交互式会话标记和环境检测结果。

#### `getResolvedTeammateMode(): 'in-process' | 'tmux'`
将可能为 `'auto'` 的 TeammateMode 解析为具体的执行模式。

#### `ensureBackendsRegistered(): Promise<void>`
确保后端类已通过动态 import 注册。轻量操作，不会触发子进程。

#### `registerTmuxBackend(backendClass) / registerITermBackend(backendClass): void`
供 `TmuxBackend.ts` / `ITermBackend.ts` 调用的自注册接口。

#### `getBackendByType(type: PaneBackendType): PaneBackend`
按类型直接创建后端实例，跳过自动检测。用于测试或用户明确指定后端的场景。

#### `markInProcessFallback(): void`
标记本次会话已回退到 in-process 模式。标记后 `isInProcessEnabled()` 在 `auto` 模式下始终返回 `true`。

#### `getCachedBackend(): PaneBackend | null` / `getCachedDetectionResult(): BackendDetectionResult | null`
获取缓存的检测结果，未检测时返回 `null`。

#### `resetBackendDetection(): void`
重置所有缓存和注册状态，用于测试。

## 接口/类型定义

本模块引用但不定义以下类型（定义在 `./types.ts`）：

| 类型 | 用途 |
|------|------|
| `PaneBackend` | Pane 后端接口，tmux 和 iTerm2 后端的统一抽象 |
| `PaneBackendType` | 后端类型字面量（`'tmux'` \| `'iterm2'`） |
| `TeammateExecutor` | Teammate 执行器接口，PaneBackend 和 InProcess 的统一抽象 |
| `BackendDetectionResult` | 检测结果，包含 `backend`、`isNative`、`needsIt2Setup` 三个字段 |

## 配置项与默认值

| 配置项 | 来源 | 默认值 | 说明 |
|--------|------|--------|------|
| `TeammateMode` | `teammateModeSnapshot` | `'auto'` | 执行模式：`'auto'`（自动检测）/ `'tmux'`（强制 Pane）/ `'in-process'`（强制进程内） |
| `preferTmuxOverIterm2` | `it2Setup` | `false` | iTerm2 环境下是否跳过 it2 检测直接使用 tmux |

相关环境变量：

| 环境变量 | 说明 |
|----------|------|
| `TMUX` | tmux 会话标识，模块加载时捕获原始值 |
| `TMUX_PANE` | tmux pane ID（如 `%0`），用于识别 Leader 所在 pane |
| `TERM_PROGRAM` | 终端程序名，值为 `'iTerm.app'` 时表示在 iTerm2 中 |
| `ITERM_SESSION_ID` | iTerm2 会话 ID，存在即表示在 iTerm2 中 |

## 边界 Case 与注意事项

- **TMUX 环境变量被覆盖**：`Shell.ts` 会在初始化时修改 `process.env.TMUX`，因此 detection.ts 必须在模块加载时捕获原始值。如果延迟读取会导致误判。

- **iTerm2 中同时有 tmux**：如果用户在 iTerm2 的 tmux 会话中启动 Claude，优先使用 tmux（因为 tmux 内部检测优先级最高），不会使用 iTerm2 原生分屏。

- **it2 --version vs it2 session list**：`it2 --version` 即使 iTerm2 的 Python API 被禁用也会成功返回，但后续的 `session split` 操作会失败。因此检测时使用 `it2 session list` 确保 API 真正可用。

- **in-process 回退不可逆**：一旦调用 `markInProcessFallback()`，在 `auto` 模式下整个会话都会保持 in-process 模式——因为环境条件不会在会话中途改变。但如果用户中途将 TeammateMode 显式切换为 `'tmux'`，该设置仍然生效。

- **非交互式会话强制 in-process**：通过 `-p` 标志启动的非交互式会话没有终端 UI，tmux 分屏无意义，因此强制使用 in-process 模式。

- **缓存策略**：所有检测结果（环境检测、后端选择、执行器实例）都采用进程生命周期缓存，保证一致性且避免重复的系统调用开销。