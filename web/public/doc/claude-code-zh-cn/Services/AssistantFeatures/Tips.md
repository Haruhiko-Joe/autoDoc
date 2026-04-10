# 使用提示调度与展示系统（Tips）

## 概述与职责

Tips 模块是 Claude Code 的"使用提示"系统，负责在用户等待 AI 响应（spinner 旋转）期间，展示上下文相关的使用建议。它属于 **Services → AssistantFeatures** 层的辅助功能组件。

该系统由三个核心文件组成：

- **`tipRegistry.ts`**：提示注册表，定义了数十条内置提示及其上下文过滤逻辑
- **`tipScheduler.ts`**：提示调度器，基于冷却策略选择最合适的提示
- **`tipHistory.ts`**：提示历史记录，通过全局配置持久化展示记录

整体工作流程为：REPL 主屏幕在每个 AI 回合开始时调用调度器 → 调度器从注册表获取当前上下文相关的提示 → 按"最久未展示"策略选出一条 → 展示给用户并记录历史。

## 关键流程

### 提示展示完整流程

1. **触发时机**：REPL 屏幕组件 `pickNewSpinnerTip` 在每个对话回合被调用（`src/screens/REPL.tsx:1531-1552`），收集当前会话中使用过的 bash 工具和读取的文件作为上下文
2. **调度入口**：调用 `getTipToShowOnSpinner(context)`（`tipScheduler.ts:32-46`）
   - 首先检查 `spinnerTipsEnabled` 设置，若为 `false` 则不展示
   - 调用 `getRelevantTips(context)` 获取所有当前环境下相关的提示
3. **过滤逻辑**：`getRelevantTips`（`tipRegistry.ts:668-686`）执行两级过滤：
   - **相关性过滤**：并行执行每条提示的 `isRelevant(context)` 方法，根据 IDE 类型、操作系统、用户使用频率、特性开关等条件判断
   - **冷却过滤**：检查距上次展示是否已过足够多的会话数（`getSessionsSinceLastShown(tipId) >= cooldownSessions`）
4. **选择策略**：`selectTipWithLongestTimeSinceShown`（`tipScheduler.ts:10-30`）从候选提示中选出距上次展示间隔最长的一条（LRU 策略）
5. **展示与记录**：
   - 调用 `tip.content(context)` 生成提示文本（支持异步、可根据上下文动态生成）
   - 将文本设置到 `appState.spinnerTip` 在 spinner 区域展示
   - 调用 `recordShownTip(tip)` 持久化记录并上报 `tengu_tip_shown` 分析事件

### 历史记录与冷却机制

提示历史基于全局配置的 `numStartups`（应用启动次数）计数器实现，而非时间戳：

- `recordTipShown(tipId)`（`tipHistory.ts:3-9`）：将 `tipsHistory[tipId]` 设置为当前 `numStartups` 值
- `getSessionsSinceLastShown(tipId)`（`tipHistory.ts:12-17`）：返回 `numStartups - lastShown`，即自上次展示以来经过的启动次数；从未展示过的提示返回 `Infinity`

每条提示定义 `cooldownSessions` 值（如 3、10、15），表示至少间隔多少次启动才能再次展示。这确保了提示轮换展示而不会重复出现。

## 函数签名与参数说明

### `getTipToShowOnSpinner(context?: TipContext): Promise<Tip | undefined>`

主调度入口。根据当前上下文选择一条最合适的提示。

- **context**：`TipContext` 对象，包含 `theme`（当前主题）、`readFileState`（已读文件缓存）、`bashTools`（已使用的 bash 命令集合）
- **返回值**：选中的 `Tip` 对象，或 `undefined`（无可用提示或提示功能被禁用）

> 源码位置：`src/services/tips/tipScheduler.ts:32-46`

### `recordShownTip(tip: Tip): void`

记录提示已展示。同时持久化到全局配置和上报分析事件。

> 源码位置：`src/services/tips/tipScheduler.ts:48-58`

### `selectTipWithLongestTimeSinceShown(availableTips: Tip[]): Tip | undefined`

从候选提示列表中选出最久未展示的一条。使用 `getSessionsSinceLastShown` 排序，取最大值。

> 源码位置：`src/services/tips/tipScheduler.ts:10-30`

### `getRelevantTips(context?: TipContext): Promise<Tip[]>`

获取当前环境下所有相关且已过冷却期的提示。合并内置提示、内部专用提示和自定义提示。

> 源码位置：`src/services/tips/tipRegistry.ts:668-686`

### `recordTipShown(tipId: string): void`

将提示的展示记录持久化到全局配置的 `tipsHistory` 字典。

> 源码位置：`src/services/tips/tipHistory.ts:3-9`

### `getSessionsSinceLastShown(tipId: string): number`

返回自上次展示以来经过的启动次数。未展示过返回 `Infinity`。

> 源码位置：`src/services/tips/tipHistory.ts:12-17`

## 接口/类型定义

### `Tip`

从代码使用推断的接口（类型定义文件 `./types.ts` 未在代码目录中找到）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 提示唯一标识符，如 `"plan-mode-for-complex-tasks"` |
| `content` | `(context: TipContext) => Promise<string>` | 异步生成提示文本的函数，可根据上下文动态调整内容 |
| `cooldownSessions` | `number` | 冷却期，两次展示之间至少间隔的启动次数 |
| `isRelevant` | `(context?: TipContext) => Promise<boolean>` | 判断提示在当前环境是否相关 |

### `TipContext`

提示上下文对象，由 REPL 屏幕组件在调用时构造：

| 字段 | 类型 | 说明 |
|------|------|------|
| `theme` | `Theme` | 当前颜色主题，用于生成带颜色的提示文本 |
| `readFileState` | 文件状态缓存 | 当前会话已读取的文件集合 |
| `bashTools` | `Set<string>` | 当前会话已使用的 bash 工具/命令集合 |

## 提示注册表详解

### 提示分类

内置提示（`tipRegistry.ts:95-634`）分为以下几类，共约 40 条：

**新手引导类**（`cooldownSessions: 3-5`）：
- `new-user-warmup`：启动次数 <10 时，建议从小任务开始
- `plan-mode-for-complex-tasks`：7 天未使用 Plan Mode 时提醒

**功能发现类**（`cooldownSessions: 10-20`）：
- `shift-tab`、`double-esc`、`image-paste` 等键盘快捷键提示
- `memory-command`、`theme-command`、`permissions` 等命令提示
- `custom-commands`、`custom-agents` 等高级功能提示

**环境优化类**（`cooldownSessions: 10-30`）：
- `terminal-setup`、`shift-enter-setup`：终端配置建议
- `vscode-command-install`：IDE 命令行工具安装
- `colorterm-truecolor`：颜色支持优化
- `powershell-tool-env`：Windows PowerShell 工具

**多会话协作类**（`cooldownSessions: 10`）：
- `git-worktrees`：启动次数 >50 且未使用 worktree 时
- `color-when-multi-clauding`：检测到 ≥2 个并发会话时

**平台推广类**（`cooldownSessions: 15`）：
- `desktop-app`、`desktop-shortcut`、`web-app`、`mobile-app`

**插件推荐类**（`cooldownSessions: 3`）：
- `frontend-design-plugin`：检测到 HTML/CSS 文件时推荐
- `vercel-plugin`：检测到 vercel.json 或 vercel CLI 时推荐

**A/B 测试类**（`cooldownSessions: 3`）：
- `effort-high-nudge`、`subagent-fanout-nudge`、`loop-command-nudge`：通过 Growthbook 特性开关控制，支持多个文案变体

**内部专用类**（`USER_TYPE === 'ant'`）：
- `important-claudemd`、`skillify`：仅对 Anthropic 内部用户展示

### 相关性判断条件

各提示的 `isRelevant` 方法会检查多种环境条件：

| 条件类型 | 示例 |
|----------|------|
| 启动次数 | `numStartups > 10`、`numStartups < 10` |
| 功能使用情况 | `lastPlanModeUse` 距今天数、`memoryUsageCount`、`promptQueueUseCount` |
| 操作系统 | `getPlatform() === 'macos'`、`getPlatform() === 'windows'` |
| 终端/IDE | `isSupportedVSCodeTerminal()`、`env.terminal` 类型 |
| SSH 环境 | `env.isSSH()` |
| 并发会话 | `countConcurrentSessions() >= 2` |
| 用户类型 | `process.env.USER_TYPE === 'ant'`、`is1PApiCustomer()` |
| 特性开关 | `getFeatureValue_CACHED_MAY_BE_STALE('tengu_tide_elm', 'off')` |
| 已安装配置 | `shiftEnterKeyBindingInstalled`、`githubActionSetupCount` |
| 当前会话文件/工具 | 插件推荐类通过 `isMarketplacePluginRelevant` 检查 |

### 自定义提示

用户可通过设置 `spinnerTipsOverride` 配置自定义提示（`tipRegistry.ts:655-666`）：

- `spinnerTipsOverride.tips`：字符串数组，每条作为一个提示
- `spinnerTipsOverride.excludeDefault`：设为 `true` 时完全替换内置提示，否则追加

自定义提示的 `cooldownSessions` 为 0（每次都可展示），`isRelevant` 始终返回 `true`。

## 配置项与默认值

| 配置项 | 位置 | 默认值 | 说明 |
|--------|------|--------|------|
| `spinnerTipsEnabled` | Settings | `true` | 是否启用 spinner 提示 |
| `spinnerTipsOverride.tips` | Settings | `[]` | 自定义提示文本列表 |
| `spinnerTipsOverride.excludeDefault` | Settings | `false` | 是否排除内置提示 |
| `tipsHistory` | GlobalConfig | `{}` | 提示展示记录字典 |
| `numStartups` | GlobalConfig | `0` | 应用启动计数器 |

## 边界 Case 与注意事项

- **防重复展示**：REPL 中使用 `tipPickedThisTurnRef` 保证每个对话回合只选取一条提示（`src/screens/REPL.tsx:1528-1533`），避免 `resetLoadingState` 被多次调用导致重复记录
- **冷却为 0 的提示**：`vscode-command-install` 的 `cooldownSessions` 为 0，但其 `isRelevant` 通过检测 IDE 命令是否已安装来控制展示——一旦安装成功就不再显示
- **类型定义文件缺失**：`./types.ts` 未在 `src/services/tips/` 目录中找到，`Tip` 和 `TipContext` 类型定义的实际位置不在此目录内（可能位于构建产物或其他位置）
- **冷却计数基于启动次数而非时间**：`numStartups` 每次应用启动递增，因此"冷却 10 次会话"的实际时间跨度取决于用户使用频率
- **异步 content 函数**：提示文本通过异步函数生成，支持在展示时动态读取当前配置（如快捷键绑定、颜色主题、特性开关变体等）
- **A/B 测试提示**：部分提示（`effort-high-nudge`、`subagent-fanout-nudge`、`loop-command-nudge`）依赖 Growthbook 特性开关，且支持 `copy_a` / `copy_b` 两种文案变体