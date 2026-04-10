# PromptInput 用户输入区域

## 概述与职责

PromptInput 是 Claude Code 终端 UI 的核心交互组件，位于 REPL 屏幕底部，负责接收和处理用户的所有文本输入。它属于 **TerminalUI → UIComponents** 模块层级，是用户与 Claude 对话的唯一入口。

在整体架构中，PromptInput 与以下同级模块协作：
- **InkFramework**：基于 Ink 原语（Box、Text、useInput）构建 UI
- **Hooks**：消费 useArrowKeyHistory、useHistorySearch、useTypeahead 等核心交互 Hooks
- **Keybindings**：通过 useKeybinding/useKeybindings 注册快捷键响应
- **StateAndContext**：读写 AppState（Zustand store）获取全局状态

PromptInput 模块包含 21 个文件（约 5700 行代码），核心文件 `PromptInput.tsx` 就有 2338 行。它整合了文本编辑、Vim 模式、粘贴处理、历史搜索、语音指示器、输入截断、slash 命令补全、权限模式切换、团队协作等众多功能。

## 文件结构

| 文件 | 行数 | 职责 |
|------|------|------|
| `PromptInput.tsx` | 2338 | 核心组件，整合所有子功能 |
| `PromptInputFooter.tsx` | 190 | 底部栏容器，编排左侧状态和右侧通知 |
| `PromptInputFooterLeftSide.tsx` | 516 | 底部栏左侧：模式指示器、任务状态、PR 徽章 |
| `PromptInputFooterSuggestions.tsx` | 292 | Slash 命令/文件补全的下拉建议列表 |
| `PromptInputHelpMenu.tsx` | 357 | `?` 键触发的快捷键帮助菜单 |
| `PromptInputModeIndicator.tsx` | 92 | 输入行左侧的模式指示符（❯ / !） |
| `PromptInputQueuedCommands.tsx` | 116 | 排队命令显示区域 |
| `PromptInputStashNotice.tsx` | 24 | Stash 暂存提示 |
| `ShimmeredInput.tsx` | 142 | 带微光动画的高亮文本渲染 |
| `VoiceIndicator.tsx` | 136 | 语音输入状态指示器 |
| `Notifications.tsx` | 331 | 右侧通知区（Token 警告、IDE 状态、更新提示等） |
| `SandboxPromptFooterHint.tsx` | 63 | 沙盒操作拦截提示 |
| `IssueFlagBanner.tsx` | 11 | Issue 报告横幅（仅内部使用） |
| `HistorySearchInput.tsx` | 50 | Ctrl+R 历史搜索输入框 |
| `inputModes.ts` | 33 | 输入模式解析（`!` → bash 模式） |
| `inputPaste.ts` | 90 | 超长文本截断与占位符逻辑 |
| `useMaybeTruncateInput.ts` | 58 | 输入截断 Hook |
| `usePromptInputPlaceholder.ts` | 76 | 占位符文本 Hook |
| `useShowFastIconHint.ts` | 31 | Fast 模式图标提示 Hook |
| `useSwarmBanner.ts` | 155 | Swarm 团队协作横幅 Hook |
| `utils.ts` | 60 | Vim 模式检测、换行指引等工具函数 |

## 关键流程

### 1. 用户输入处理流程

这是最核心的数据流——从用户按键到消息提交：

1. **输入捕获**：PromptInput 根据 `isVimModeEnabled()` 选择 `VimTextInput` 或 `TextInput` 渲染文本输入框（`PromptInput.tsx:2243`）
2. **onChange 处理**：每次输入变更触发 `onChange` 回调（`PromptInput.tsx:854-901`）：
   - 检测输入 `?` 字符 → 切换帮助菜单
   - 取消进行中的 prompt suggestion 和 speculation
   - 检测模式前缀（`!` → bash 模式），调用 `getModeFromInput()`（`inputModes.ts:16-21`）
   - Tab 转换为 4 个空格
   - 将当前状态推入 undo buffer（`useInputBuffer`）
   - 取消 footer pill 选中状态
3. **Typeahead 补全**：`useTypeahead` Hook 根据输入内容生成 slash 命令、文件路径、Agent 等补全建议（`PromptInput.tsx:1106-1126`）
4. **提交**：`onSubmit` 回调处理最终提交（`PromptInput.tsx:984-1105`）：
   - 检查 prompt suggestion 自动接受逻辑
   - 处理 speculation 预测加速
   - 解析 `@name` 直接消息路由
   - 检查 suggestions dropdown 是否阻止提交
   - 路由到 leader 或 viewed agent

### 2. 粘贴处理流程

支持图片和文本两种粘贴类型：

**图片粘贴**（`PromptInput.tsx:1151-1183`）：
1. 用户按 `ctrl+v`（chat:imagePaste 快捷键）触发 `getImageFromClipboard()`
2. 生成递增的 `pasteId`，创建 `PastedContent` 对象
3. 缓存图片路径、后台存储到磁盘
4. 在输入框中插入 `[Image #N]` 占位符
5. 设置 `pendingSpaceAfterPillRef` 标志，下次输入普通字符时自动前插空格

**文本粘贴**（`PromptInput.tsx:1201-1240`）：
1. 清理 ANSI 转义码、统一换行符
2. 如果文本超过 `PASTE_THRESHOLD` 或行数超限，创建 `[...Pasted text #N +X lines...]` 占位符
3. 短文本直接插入

**超长输入截断**（`inputPaste.ts`）：
- 阈值 `TRUNCATION_THRESHOLD = 10000` 字符
- 保留前 500 + 后 500 字符，中间替换为 `[...Truncated text #N +X lines...]`
- 由 `useMaybeTruncateInput` Hook 在输入变更时自动触发

### 3. 历史搜索流程

支持两种历史导航方式：

**箭头键导航**：
1. ↑/↓ 键在光标位于首/末行时触发（`PromptInput.tsx:924-967`）
2. 只在补全建议 ≤ 1 条时启用，避免与补全导航冲突
3. 到达历史底部后继续 ↓ 进入 footer pill 导航

**Ctrl+R 增量搜索**（`HistorySearchInput.tsx`）：
1. 底部显示 `search prompts:` 搜索输入框
2. 实时匹配历史记录，匹配部分高亮显示
3. 搜索失败时提示 `no matching prompt:`
4. 选中后回填输入框并恢复模式和粘贴内容

### 4. 文本高亮系统

PromptInput 内置了一套优先级驱动的文本高亮系统（`PromptInput.tsx:601-741`），`combinedHighlights` 合并以下高亮源：

| 高亮类型 | 颜色 | 优先级 | 说明 |
|----------|------|--------|------|
| Image chip 选中 | inverse | 8 | 光标在 `[Image #N]` 起始位置时反色 |
| 历史搜索匹配 | warning（黄色） | 20 | 搜索结果中匹配的文字 |
| `/btw` 侧问题 | warning | 15 | side question 关键字 |
| `/command` | suggestion（蓝色） | 5 | 有效的 slash 命令 |
| Token budget | suggestion | 5 | Token 预算指令 |
| Slack 频道 | suggestion | 5 | `#channel` 引用 |
| `@name` 成员提及 | 成员颜色 | 5 | 团队成员提及 |
| 语音暂定文本 | dimColor | 1 | 语音输入尚未确认的文字 |
| ultrathink/ultraplan | 彩虹渐变+微光 | 10 | 特殊关键字逐字符彩虹色 |

微光效果由 `ShimmeredInput.tsx` 中的 `HighlightedInput` 组件实现，使用 `useAnimationFrame(50)` 驱动 50ms 间隔的 `ShimmerChar` 扫光动画。

### 5. Footer Pill 导航系统

底部状态栏中的"pill"（任务、团队、Bridge 等）支持键盘导航（`PromptInput.tsx:450-506, 1742-1864`）：

1. **导航顺序**：`tasks → tmux → bagel → teams → bridge → companion`
2. **进入方式**：在输入历史底部继续按 ↓
3. **导航键**：↑/↓ 在 pill 间移动；←/→ 在 teammate 列表内循环；Enter 确认选中
4. **退出方式**：↑ 到第一个 pill 时再按 ↑ 回到输入框；ESC 直接回到输入框
5. **Type-to-exit**：在 pill 选中状态下输入任意可打印字符自动回到输入框

### 6. 权限模式切换

通过 `shift+tab`（`chat:cycleMode`）在权限模式间轮转（`PromptInput.tsx:1410-1556`）：

- 循环路径：`default → plan → auto`（如果可用）
- Auto 模式首次进入时弹出 `AutoModeOptInDialog` 确认对话框（400ms 防抖延迟）
- 拒绝后该会话不再显示 auto 选项
- 查看 teammate 视图时切换的是 teammate 的权限模式

## 函数签名

### `PromptInput(props: Props): React.ReactNode`

核心组件，接收约 40 个 props。关键参数：

| 参数 | 类型 | 说明 |
|------|------|------|
| `input` | `string` | 当前输入文本（受控） |
| `onInputChange` | `(value: string) => void` | 输入变更回调 |
| `mode` | `PromptInputMode` | 当前输入模式（`prompt` / `bash`） |
| `onModeChange` | `(mode: PromptInputMode) => void` | 模式变更回调 |
| `onSubmit` | `(input, helpers, speculation?, options?) => Promise<void>` | 提交回调 |
| `pastedContents` | `Record<number, PastedContent>` | 粘贴内容（图片/文本）映射 |
| `vimMode` | `VimMode` | Vim 模式状态 |
| `commands` | `Command[]` | 可用的 slash 命令列表 |
| `agents` | `AgentDefinition[]` | 可用的 Agent 定义列表 |
| `isLoading` | `boolean` | 助手是否正在响应 |
| `stashedPrompt` | `{text, cursorOffset, pastedContents} \| undefined` | 暂存的输入 |
| `insertTextRef` | `React.MutableRefObject<...>` | STT 等外部调用的文本插入接口 |
| `voiceInterimRange` | `{start, end} \| null` | 语音输入暂定文本范围 |

> 源码位置：`PromptInput.tsx:124-189`

### `PromptInputFooter(props: Props): ReactNode`

底部状态栏组件，组装左侧状态和右侧通知。

- 当有 suggestions 时，全宽显示 `PromptInputFooterSuggestions`
- 当帮助菜单打开时，全宽显示 `PromptInputHelpMenu`
- 否则左右分栏：左侧 `PromptInputFooterLeftSide` + 右侧 `Notifications`

> 源码位置：`PromptInputFooter.tsx:63-152`

## 接口/类型定义

### `SuggestionItem`

补全建议项的数据结构（`PromptInputFooterSuggestions.tsx:9-16`）：

```typescript
type SuggestionItem = {
  id: string           // 唯一标识，前缀决定类型：'file-'、'mcp-resource-'、'agent-'
  displayText: string  // 显示文本
  tag?: string         // 可选标签（如 [MCP]）
  description?: string // 描述文本
  metadata?: unknown   // 附加数据
  color?: keyof Theme  // 自定义颜色
}
```

### `SuggestionType`

建议类型枚举：`'command' | 'file' | 'directory' | 'agent' | 'shell' | 'custom-title' | 'slack-channel' | 'none'`

### `SwarmBannerInfo`

Swarm 横幅信息（`useSwarmBanner.ts:29-32`）：

```typescript
type SwarmBannerInfo = {
  text: string          // 横幅文本（如 "@agentName" 或 tmux 连接命令）
  bgColor: keyof Theme  // 背景色主题键
} | null
```

## 配置项与默认值

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `editorMode` | `undefined`（非 vim） | 全局配置 `config.editorMode === 'vim'` 启用 Vim 模式 |
| `TRUNCATION_THRESHOLD` | 10000 字符 | 超长输入截断阈值（`inputPaste.ts:4`） |
| `PREVIEW_LENGTH` | 1000 字符 | 截断后保留的预览长度（`inputPaste.ts:5`） |
| `PASTE_THRESHOLD` | 外部定义 | 长文本粘贴转占位符的阈值 |
| `OVERLAY_MAX_ITEMS` | 5 | 全屏模式下补全建议最大显示条数（`PromptInputFooterSuggestions.tsx:18`） |
| `FOOTER_TEMPORARY_STATUS_TIMEOUT` | 5000ms | 临时通知消失时间 |
| `MIN_INPUT_VIEWPORT_LINES` | 3 | 全屏模式下输入区最小行数 |
| `PROMPT_FOOTER_LINES` | 5 | Footer 预留行数 |
| `HINT_DISPLAY_DURATION_MS` | 5000ms | Fast 模式提示显示时长 |
| `NUM_TIMES_QUEUE_HINT_SHOWN` | 3 | 排队命令提示显示次数上限 |
| `MAX_VOICE_HINT_SHOWS` | 3 | 语音提示显示次数上限 |

## 快捷键映射

PromptInput 通过 `useKeybindings` 注册了以下 Chat 上下文快捷键（`PromptInput.tsx:1660-1673`）：

| Action | 默认键位 | 说明 |
|--------|----------|------|
| `chat:undo` | `ctrl+_` | 撤销上次编辑 |
| `chat:newline` | 可配置 | 插入换行（也支持 `\` + Enter） |
| `chat:externalEditor` | `ctrl+g` | 用 `$EDITOR` 编辑当前输入 |
| `chat:stash` | `ctrl+s` | 暂存/恢复输入 |
| `chat:modelPicker` | `alt+p` | 打开模型选择器 |
| `chat:thinkingToggle` | 可配置 | 切换 thinking 模式 |
| `chat:cycleMode` | `shift+tab` | 权限模式轮转 |
| `chat:imagePaste` | `ctrl+v` | 粘贴剪贴板图片 |
| `chat:fastMode` | `alt+o` | Fast 模式选择器 |
| `chat:messageActions` | `shift+↑` | 进入消息操作光标 |
| `chat:submit` | Enter（chord 专用） | 提交输入 |

帮助菜单（`PromptInputHelpMenu.tsx`）还列出了以下模式前缀：
- `!` → bash 模式
- `/` → slash 命令
- `@` → 文件路径引用
- `&` → 后台任务
- `/btw` → 侧问题

## 边界 Case 与注意事项

- **Image chip 导航**：光标不能停留在 `[Image #N]` 占位符内部。`useEffect` 会自动将内部光标 snap 到最近的边界（`PromptInput.tsx:594-600`）。Backspace 在 chip 起始位置可删除整个占位符。

- **外部输入注入**：来自 STT（语音转文字）等外部源的输入通过 `insertTextRef` 注入。组件检测 `input !== lastInternalInputRef.current` 来识别外部变更并将光标移到末尾（`PromptInput.tsx:255-260`）。

- **Suggestion 阻止提交**：当补全建议下拉框显示时（且非目录补全），Enter 不会提交输入。用户需先 ESC 关闭补全或选择一个建议（`PromptInput.tsx:1073-1077`）。

- **Footer pill 幽灵选中**：如果选中的 pill 消失（如 bridge 断开），`footerItemSelected` 立即变为 null，随后 `useEffect` 清理 raw state，防止 pill 重现时抢夺焦点（`PromptInput.tsx:466-475`）。

- **Stash 首次使用提示**：当用户逐渐清空 20+ 字符的输入到 ≤ 5 字符时（非一次性清空），如果从未使用过 stash 功能，显示一次 `ctrl+s` 提示（`PromptInput.tsx:792-830`）。

- **Auto mode 首次确认**：进入 auto 模式前需要确认对话框。使用 400ms 防抖避免快速轮转时弹窗（`PromptInput.tsx:1458-1492`）。拒绝后 `isAutoModeAvailable` 设为 false，该会话不再出现 auto 选项。

- **Paste ID 连续性**：`nextPasteIdRef` 在 `--continue` / `--resume` 场景下从已有消息中扫描最大 ID，确保不会 ID 冲突（`PromptInput.tsx:2303-2327`）。

- **macOS Option 键检测**：macOS 上 Option 键产生特殊字符时，提示用户设置"Option as Meta"（`PromptInput.tsx:1874-1888`）。

## 关键代码片段

### 输入模式判断

```typescript
// inputModes.ts:16-21
export function getModeFromInput(input: string): HistoryMode {
  if (input.startsWith('!')) {
    return 'bash'
  }
  return 'prompt'
}
```

### Vim 模式检测

```typescript
// utils.ts:12-15
export function isVimModeEnabled(): boolean {
  const config = getGlobalConfig()
  return config.editorMode === 'vim'
}
```

### 文本输入组件选择

```typescript
// PromptInput.tsx:2243
const textInputElement = isVimModeEnabled()
  ? <VimTextInput {...baseProps} initialMode={vimMode} onModeChange={setVimMode} />
  : <TextInput {...baseProps} />;
```

### Prompt Suggestion 接受逻辑

当输入为空且存在 prompt suggestion 时，Enter 键自动接受建议。如果同时有 speculation（推测执行）处于活跃状态，直接注入推测结果跳过正常查询流程（`PromptInput.tsx:1007-1038`）。

### Swarm 横幅逻辑

`useSwarmBanner` Hook 按优先级返回横幅信息（`useSwarmBanner.ts:44-146`）：
1. **Teammate 进程**：显示 `@agentName` + 分配的颜色
2. **Leader 有 teammates**：tmux 外显示 tmux attach 命令；tmux 内或 in-process 模式显示当前查看的 teammate 名称
3. **Coordinator agent**：显示被查看 agent 的名称和颜色
4. **Standalone agent**：显示 `/rename` 设置的名称
5. **`--agent` CLI 标志**：显示 agent 名称