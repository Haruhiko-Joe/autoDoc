# ConfigCommands —— 设置与行为配置命令集

## 概述与职责

ConfigCommands 是 Claude Code **CommandSystem** 下的配置类斜杠命令集合，包含约 20 个命令，覆盖模型选择、界面主题、编辑模式、权限管理、隐私设置等维度。它们共同构成了用户自定义 Claude Code 运行时行为和界面的完整入口。

在系统架构中，ConfigCommands 属于 **CoreEngine → CommandSystem** 层。CommandSystem 是中央命令注册表（聚合 80+ 命令），ConfigCommands 是其中"配置"这一功能域的子集。每个命令遵循统一的 Command 接口：`index.ts` 声明元数据（type、description、isEnabled、isHidden、argumentHint），实现文件提供 `call()` 函数。命令类型分两种：

- **`local-jsx`**：渲染 React/Ink 组件进行交互式配置（如模型选择器、权限列表）
- **`local`**：直接返回文本结果（如 vim 模式切换、stickers 打开浏览器）

同级兄弟模块包括 QueryEngine（会话查询引擎）、QueryLoop（查询主循环）、ContextBuilder（系统提示词构建）、CostTracking（费用追踪）、InputHistory（输入历史）。

---

## 命令总览

| 命令 | 别名 | 类型 | 说明 | 可见性 |
|------|------|------|------|--------|
| `/config` | `/settings` | local-jsx | 打开配置面板 | 公开 |
| `/model` | - | local-jsx | 切换 AI 模型 | 公开 |
| `/theme` | - | local-jsx | 切换主题 | 公开 |
| `/color` | - | local-jsx | 设置会话 prompt bar 颜色 | 公开 |
| `/vim` | - | local | 切换 Vim/Normal 编辑模式 | 公开 |
| `/fast` | - | local-jsx | 切换快速模式 | claude-ai/console |
| `/effort` | - | local-jsx | 设置推理深度 | 公开 |
| `/output-style` | - | local-jsx | 已废弃，重定向到 /config | 隐藏 |
| `/keybindings` | - | local | 打开键绑定配置文件 | 需特性开关 |
| `/permissions` | `/allowed-tools` | local-jsx | 管理工具权限规则 | 公开 |
| `/privacy-settings` | - | local-jsx | 隐私设置 | 消费者订阅用户 |
| `/hooks` | - | local-jsx | 查看/配置工具事件钩子 | 公开 |
| `/sandbox-toggle` | - | local-jsx | 沙盒模式开关 | 仅支持平台 |
| `/plan` | - | local-jsx | 启用/查看/编辑计划模式 | 公开 |
| `/statusline` | - | prompt | 配置状态栏 | 公开 |
| `/env` | - | - | 已禁用（stub） | 隐藏 |
| `/remote-env` | - | local-jsx | 配置远程会话环境 | claude.ai 订阅用户 |
| `/rate-limit-options` | - | local-jsx | 限速选项菜单 | 隐藏（内部使用） |
| `/passes` | - | local-jsx | 分享免费体验周 | 有资格时可见 |
| `/stickers` | - | local | 订购 Claude Code 贴纸 | 公开 |

---

## 关键流程 Walkthrough

### 命令注册与分发

每个命令目录下的 `index.ts` 导出一个符合 `Command` 接口的对象，包含以下关键字段：

- `type`：决定命令如何执行（`local` 返回文本，`local-jsx` 渲染 React 组件，`prompt` 注入系统提示词）
- `isEnabled`：函数，判断命令在当前环境是否可用
- `isHidden`：控制是否在命令列表中显示
- `call`：实际执行逻辑

CommandSystem 的中央注册表 `commands.ts` 聚合所有命令。用户输入 `/xxx` 时，系统匹配命令名或别名，检查 `isEnabled`，然后调用 `call()`。

### /config —— 配置面板入口

`/config` 是最通用的配置命令，渲染 `Settings` 组件并默认打开 "Config" 标签页（`src/commands/config/config.tsx`）。它作为其他配置功能的聚合入口，很多子命令（如 `/output-style`）已废弃并重定向到此处。

### /model —— 模型切换流程

这是最复杂的配置命令之一（`src/commands/model/model.tsx`）：

1. **无参数调用**：渲染 `ModelPickerWrapper`，展示可选模型列表的交互式菜单
2. **带参数调用**（如 `/model sonnet`）：通过 `SetModelAndClose` 组件直接设置
   - 调用 `resolveModelAlias()` 解析模型别名
   - 验证模型是否存在于可用列表中
   - 检查是否有 1M context 权限（`has1MContextAccess`，针对 Opus/Sonnet）
   - 检测 extra usage billing 状态
   - 若模型不支持 fast mode，自动关闭 fast mode
3. **特殊参数 `show`**：通过 `ShowModelAndClose` 显示当前模型信息

模型显示名通过 `renderModelLabel()` 格式化，支持 fast mode 标记和自定义后缀。

### /fast —— 快速模式切换

快速模式（`src/commands/fast/fast.tsx`）的核心逻辑：

1. 仅对 `claude-ai` 和 `console` auth provider 可用
2. 切换时自动将模型切换到 `FAST_MODE_MODEL_DISPLAY`
3. 关闭时恢复到之前的模型
4. 支持 `on`/`off` 参数直接设置，或通过 `FastModePicker` 交互选择
5. 显示冷却状态（`FastIcon` 组件）和定价信息
6. 受特性门控 `tengu_jade_anvil_4` 控制

通过 `handleFastModeShortcut()` 可实现快捷键直接切换。

### /sandbox-toggle —— 沙盒模式配置

沙盒配置（`src/commands/sandbox-toggle/sandbox-toggle.tsx`）流程较为复杂：

1. **平台检测**：仅支持 macOS、Linux、WSL2
2. **依赖检查**：验证沙盒所需的系统依赖是否安装，输出结构化的错误/警告信息
3. **策略锁检测**：若组织策略锁定了沙盒设置，提示用户无法修改
4. **交互配置**：通过 `SandboxSettings` 组件进行开关设置
5. **排除模式**：`exclude` 子命令支持 pattern-based 的命令排除（如 `/sandbox-toggle exclude "npm *"`）
6. **持久化**：保存到 `localSettings` 文件

命令描述动态生成，包含状态图标（✓ 启用 / ○ 禁用 / ⚠ 依赖缺失）。

### /effort —— 推理深度设置

`/effort` 命令（`src/commands/effort/effort.tsx`）控制模型推理深度：

1. 支持 `low`、`medium`、`high`、`max`、`auto` 五个级别
2. `auto` 模式清除手动设置，恢复默认行为
3. 环境变量 `CLAUDE_CODE_EFFORT_LEVEL` 可覆盖手动设置
4. 通过 `setEffortValue()` 持久化设置并记录分析事件
5. 无参数时通过 `ShowCurrentEffort` 组件显示当前生效的 effort 级别

### /permissions —— 权限规则管理

`/permissions`（别名 `/allowed-tools`，`src/commands/permissions/permissions.tsx`）渲染 `PermissionRuleList` 组件，提供交互式 UI 用于创建和管理工具的 allow/deny 规则。支持对被拒绝的命令权限进行重试操作。

### /plan —— 计划模式

`/plan` 命令（`src/commands/plan/plan.tsx`）有三种使用方式：

1. **无参数**：若未在计划模式则启用计划模式（调用 `handlePlanModeTransition()`）；若已在计划模式则显示当前计划内容
2. **`/plan open`**：通过 `editFileInEditor()` 在外部编辑器中打开计划文件
3. **`/plan <description>`**：带描述启用计划模式

计划内容通过 `getPlan()` 和 `getPlanFilePath()` 获取，`PlanDisplay` 组件负责渲染计划内容和编辑器信息。

---

## 各命令详细说明

### /color —— 会话颜色

`src/commands/color/color.ts`

设置当前会话的 prompt bar 颜色。参数为颜色名或重置别名（`default`、`reset`、`none`、`gray`、`grey`）。颜色值从 `AGENT_COLORS` 列表中验证。设置后持久化到 transcript 以跨会话保持，同时更新 `AppState` 实现即时视觉反馈。

**限制**：teammate 角色无法自行设置颜色（由 team leader 分配）。

### /vim —— 编辑模式切换

`src/commands/vim/vim.ts`

在 Vim 和 Normal 编辑模式之间切换。读取当前 `editorMode`，若为 `vim` 则切换到 `normal`，反之切换到 `vim`（`emacs` 向后兼容为 `normal`）。切换后记录 `tengu_editor_mode_changed` 分析事件，并返回包含键绑定信息的文本结果。

### /keybindings —— 键绑定配置

`src/commands/keybindings/keybindings.ts`

仅在 `isKeybindingCustomizationEnabled()` 返回 true 时可用（预览特性）。执行时：
1. 若键绑定配置文件不存在，使用模板创建（`wx` 标志防止覆盖已有文件）
2. 通过 `editFileInEditor()` 在外部编辑器中打开配置文件
3. 返回文件路径和编辑器状态信息

### /privacy-settings —— 隐私设置

`src/commands/privacy-settings/privacy-settings.tsx`

仅对消费者订阅用户可用。流程：
1. 检查用户是否有 Grove（隐私计划）资格
2. 新用户展示 `GroveDialog`（条款接受流程）
3. 已有用户展示 `PrivacySettingsDialog`
4. 追踪 `grove_enabled` 切换的分析事件
5. 处理域名排除配置
6. 不符合条件的用户回退到 Web URL

### /hooks —— 钩子配置

`src/commands/hooks/hooks.tsx`

渲染 `HooksConfigMenu` 组件，展示可配置的工具事件钩子列表。传入可用的工具名称列表，记录 `tengu_hooks_command` 分析事件。

### /statusline —— 状态栏配置

`src/commands/statusline.tsx`

与其他命令不同，这是一个 `prompt` 类型命令。它不直接执行逻辑，而是委托给 `AgentTool`，使用 `subagent_type: "statusline-setup"` 的子 Agent 来配置 shell 的状态栏集成（PS1 配置）。允许的工具范围限定为 `Read(~/**)` 和 `Edit(~/.claude/settings.json)`。

### /remote-env —— 远程环境配置

`src/commands/remote-env/remote-env.tsx`

仅对 claude.ai 订阅用户且 `allow_remote_sessions` 策略启用时可见。渲染 `RemoteEnvironmentDialog` 组件，用于配置远程 teleport 会话的默认环境。

### /rate-limit-options —— 限速选项

`src/commands/rate-limit-options/rate-limit-options.tsx`

隐藏命令，供内部在用户触发限速时自动调用。渲染 `RateLimitOptionsMenu`，根据订阅类型（free/pro/max/team/enterprise）展示不同选项：
- extra-usage 选项（team/enterprise 需管理员审批）
- 升级选项（非 Max、非 team 用户）
- 当前限速层级和超额状态
- 受特性门控 `tengu_jade_anvil_4` 控制 buyFirst 行为

### /passes —— 免费体验分享

`src/commands/passes/passes.tsx`

当用户有可用的 guest pass 时显示。通过 `getCachedRemainingPasses()` 检查剩余通行证数量，`getCachedReferrerReward()` 获取推荐人奖励信息。追踪首次访问状态（`hasVisitedPasses` 标志），记录 `tengu_guest_passes_visited` 分析事件。

### /stickers —— 订购贴纸

`src/commands/stickers/stickers.ts`

最简单的命令。调用系统浏览器打开 `https://www.stickermule.com/claudecode`。不支持非交互模式。

### /output-style —— 输出风格（已废弃）

`src/commands/output-style/output-style.tsx`

标记为 `isHidden: true`，命令描述标注 "Deprecated: use /config to change output style"。实际执行时重定向用户到 `/config`。

### /env —— 环境变量（已禁用）

`src/commands/env/index.js`

完全禁用的 stub 命令：`{ isEnabled: () => false, isHidden: true, name: 'stub' }`。

---

## 接口与类型模式

所有命令的 `index.ts` 导出遵循统一的 `Command` 接口结构：

```typescript
{
  type: "local" | "local-jsx" | "prompt",
  name: string,
  description: string | (() => string),  // 支持动态描述
  isEnabled: () => boolean,
  isHidden?: boolean,
  aliases?: string[],
  argumentHint?: string,
  supportsNonInteractive?: boolean,
  call: (args, context) => Promise<CommandResult>
}
```

**动态描述**的典型案例：
- `/model`：描述中包含当前模型名（`"Set the AI model... (currently ${modelName})"`）
- `/sandbox-toggle`：描述中包含当前状态图标（✓/○/⚠）

**可见性控制**通过 `isEnabled` 和 `isHidden` 组合实现：
- `isEnabled: false` + `isHidden: true`：完全禁用（如 `/env`）
- `isEnabled: true` + `isHidden: true`：内部使用但不在列表显示（如 `/rate-limit-options`）
- `isEnabled` 依赖条件判断：按环境动态可用（如 `/fast` 仅限 claude-ai/console auth provider）

---

## 配置持久化机制

各命令的设置持久化方式不尽相同：

| 持久化方式 | 使用命令 |
|-----------|---------|
| `localSettings` 文件 | `/sandbox-toggle` |
| `transcript` 元数据 | `/color`（跨会话颜色） |
| `AppState` 全局状态 | `/color`（即时生效）、`/model`、`/fast` |
| 用户配置文件 | `/keybindings`、`/config` |
| 分析事件记录 | `/vim`、`/effort`、`/fast`、`/hooks`、`/passes`、`/privacy-settings` |
| 环境变量覆盖 | `/effort`（`CLAUDE_CODE_EFFORT_LEVEL`） |

---

## 边界 Case 与注意事项

- **`/output-style` 已废弃**：该命令被标记为隐藏并重定向到 `/config`，不应在新文档或 UI 中引用
- **`/env` 是 stub**：完全禁用，`isEnabled` 始终返回 false，不会出现在任何命令列表中
- **`/fast` 的 auth 限制**：仅对 `claude-ai` 和 `console` auth provider 可用，API 用户无法使用
- **`/sandbox-toggle` 的平台限制**：仅支持 macOS、Linux、WSL2；在不支持的平台或配置禁用时自动隐藏
- **`/keybindings` 需特性开关**：依赖 `isKeybindingCustomizationEnabled()` 预览特性门控
- **`/privacy-settings` 的资格检查**：仅消费者订阅用户可见，不符合条件时回退到 Web URL
- **`/model` 与 fast mode 的联动**：切换到不支持 fast mode 的模型时会自动关闭 fast mode
- **`/color` 的 teammate 限制**：teammate 角色不能自行设置颜色，由 team leader 统一分配
- **`/statusline` 的特殊类型**：它是唯一的 `prompt` 类型命令，通过子 Agent 执行而非直接运行代码
- **环境变量覆盖**：`/effort` 的手动设置会被 `CLAUDE_CODE_EFFORT_LEVEL` 环境变量覆盖，此时 UI 中会有相应提示