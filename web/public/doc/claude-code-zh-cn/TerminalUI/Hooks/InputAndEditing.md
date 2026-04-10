# 文本输入与编辑行为 Hooks

## 概述与职责

本模块是 **TerminalUI > Hooks** 层中专注于文本输入与编辑行为的一组 React 自定义 Hooks。它们共同实现了 Claude Code 终端界面中用户输入的完整生命周期——从基础文本编辑、Vim 模式、粘贴处理，到历史记录导航和搜索。

在整体架构中，这些 Hooks 被 **Screens**（如 REPL 主屏幕）和 **UIComponents**（如 PromptInput）消费，它们依赖 **InkFramework** 提供的底层输入事件（`useInput`、`useStdin`），并读写 **StateAndContext** 中的全局状态。同级模块还有 IDE 集成、远程会话、建议系统等 Hooks。

模块包含 10 个 Hook，按功能可分为三组：

- **文本编辑**：`useTextInput`、`useVimInput`、`useSearchInput`、`useInputBuffer`
- **输入事件处理**：`usePasteHandler`、`useCopyOnSelect`、`useDoublePress`
- **历史导航**：`useArrowKeyHistory`、`useHistorySearch`、`useAssistantHistory`

---

## 关键流程

### 输入事件处理主链路

用户的每个按键经过以下处理链：

1. **`usePasteHandler`** 拦截输入：判断是否为粘贴事件（通过 bracketed paste 标记或输入长度阈值），若是则收集分块后合并处理（含图片检测）；否则透传给下层
2. **`useVimInput`**（若启用 Vim 模式）接收输入：在 INSERT 模式下透传给 `useTextInput`，在 NORMAL 模式下交由 Vim 状态机（`transition`）处理
3. **`useTextInput`** 处理基础文本编辑：通过 `Cursor` 对象管理光标位置和文本变更，支持 Emacs 风格快捷键（Ctrl+A/E/K/U/W/Y 等）、kill ring、多行编辑

```
用户按键 → usePasteHandler.wrappedOnInput
              ├─ 粘贴 → 收集分块 → 合并 → 图片检测 / 文本粘贴
              └─ 普通输入 → useVimInput.handleVimInput (或直接 useTextInput.onInput)
                              ├─ INSERT 模式 → useTextInput.onInput → Cursor 操作 → onChange
                              └─ NORMAL 模式 → vim transition → operator 执行
```

### 上下箭头历史导航

`useTextInput` 中的 `upOrHistoryUp()` / `downOrHistoryDown()` 优先尝试光标在多行文本内移动，只有当光标已在首行/末行时才触发历史导航回调，由 `useArrowKeyHistory` 响应：

1. 首次按上箭头时保存当前输入为"草稿"（`lastShownHistoryEntry`）
2. 以 chunk 方式异步加载历史记录（`HISTORY_CHUNK_SIZE = 10`），支持按模式过滤（bash 模式只显示 bash 命令）
3. 并发快速按键通过 `historyIndexRef` 同步追踪索引 + `pendingLoad` 批量合并磁盘读取
4. 按下箭头到底部时恢复草稿内容

> 源码位置：`src/hooks/useTextInput.ts:269-316`、`src/hooks/useArrowKeyHistory.tsx:124-181`

### Ctrl+R 模糊搜索历史

`useHistorySearch` 实现了类 shell 的 Ctrl+R 反向搜索：

1. 按 Ctrl+R 保存当前输入为原始状态，进入搜索模式
2. 用户输入搜索关键词，Hook 通过 `makeHistoryReader()` 创建异步历史迭代器，逐条匹配（`display.lastIndexOf(query)`）
3. 再次按 Ctrl+R 从当前位置继续搜索下一个匹配项
4. Enter 接受匹配项并退出搜索；Esc 取消并恢复原始输入；Ctrl+G 取消搜索
5. 搜索关键词变化时，通过 AbortController 取消上一次搜索，重新从头搜索

> 源码位置：`src/hooks/useHistorySearch.ts:73-148`

---

## 函数签名与参数说明

### `useTextInput(props: UseTextInputProps): TextInputState`

核心文本输入 Hook，处理所有基础编辑操作。

| 参数 | 类型 | 说明 |
|------|------|------|
| `value` | `string` | 当前输入文本 |
| `onChange` | `(value: string) => void` | 文本变更回调 |
| `onSubmit` | `(value: string) => void` | 提交回调（Enter） |
| `multiline` | `boolean` | 是否支持多行（`\` + Enter 或 Meta+Enter 换行） |
| `columns` | `number` | 终端列数，用于 `Cursor` 的换行计算 |
| `onHistoryUp / onHistoryDown` | `() => void` | 光标到顶/底时的历史导航回调 |
| `inputFilter` | `(input: string, key: Key) => string` | 可选的输入过滤器 |
| `inlineGhostText` | `InlineGhostText` | 内联幽灵文本（自动补全预览） |
| `maxVisibleLines` | `number` | 可见行数上限（视口裁剪） |

返回值 `TextInputState` 包含：`onInput`（输入处理函数）、`renderedValue`（含光标渲染的文本）、`offset`（当前光标偏移）、`cursorLine` / `cursorColumn`（光标位置）。

> 源码位置：`src/hooks/useTextInput.ts:38-529`

### `useVimInput(props: UseVimInputProps): VimInputState`

在 `useTextInput` 之上叠加 Vim 模式支持。

- **INSERT 模式**：透传给 `useTextInput`，同时追踪插入文本用于 dot-repeat
- **NORMAL 模式**：将按键交给 `vim/transitions.ts` 状态机处理，支持 motion/operator/text-object 组合
- Ctrl 键始终交给 `useTextInput`（保持 Emacs 快捷键可用）
- Enter 始终交给 `useTextInput`（允许 NORMAL 模式下提交）

返回值在 `TextInputState` 基础上增加 `mode: VimMode` 和 `setMode`。

> 源码位置：`src/hooks/useVimInput.ts:34-316`

### `usePasteHandler(props: PasteHandlerProps): { wrappedOnInput, pasteState, isPasting }`

粘贴事件处理器，包装 `onInput` 以拦截和处理粘贴内容。

**粘贴检测策略**（`src/hooks/usePasteHandler.ts:253-258`）：
- 输入标记为 `isPasted`（bracketed paste 模式）
- 输入长度超过 `PASTE_THRESHOLD`
- 输入包含图片文件路径
- 前一个粘贴块尚未完成（`pastePendingRef`）

**图片粘贴处理**：
- 检测拖放的图片文件路径（支持换行/空格分隔的多路径）
- macOS 下空粘贴时检查剪贴板中是否有图片
- 临时截图文件（TemporaryItems）已删除时回退到剪贴板读取

> 源码位置：`src/hooks/usePasteHandler.ts:30-285`

### `useSearchInput(options: UseSearchInputOptions): UseSearchInputReturn`

搜索框输入 Hook，提供独立的查询字符串管理和光标控制。

| 参数 | 类型 | 说明 |
|------|------|------|
| `isActive` | `boolean` | 是否激活输入监听 |
| `onExit` | `() => void` | Enter/Down 确认退出 |
| `onCancel` | `() => void` | Esc/Ctrl+G/Ctrl+C 取消退出 |
| `backspaceExitsOnEmpty` | `boolean` | 空查询时 Backspace 是否退出（默认 `true`，模拟 less/vim 的 "delete past the /"） |
| `passthroughCtrlKeys` | `string[]` | 不拦截的 Ctrl 键列表 |

支持完整的 Emacs 快捷键（Ctrl+A/E/B/F/K/U/W/Y）和 kill ring 操作。

> 源码位置：`src/hooks/useSearchInput.ts:84-364`

### `useInputBuffer(props: UseInputBufferProps): UseInputBufferResult`

输入缓冲区管理，提供 undo 功能。

| 参数 | 类型 | 说明 |
|------|------|------|
| `maxBufferSize` | `number` | 缓冲区最大条目数 |
| `debounceMs` | `number` | 快速输入去抖时间（避免每个字符都记录快照） |

- `pushToBuffer(text, cursorOffset, pastedContents?)` — 记录输入快照
- `undo()` — 返回上一个缓冲条目
- `clearBuffer()` — 清空缓冲区

> 源码位置：`src/hooks/useInputBuffer.ts:27-132`

### `useCopyOnSelect(selection, isActive, onCopied?): void`

选中自动复制，模拟 iTerm2 的 "Copy to pasteboard on selection" 行为。

- 仅在 alt-screen 模式下生效（普通终端由原生 selection 处理）
- 拖拽结束或多击选中时自动写入剪贴板
- 通过 `getGlobalConfig().copyOnSelect`（默认 `true`）可配置开关
- 跳过纯空白选区

附带 `useSelectionBgColor(selection)` 将主题的 `selectionBg` 颜色注入 Ink 的 StylePool。

> 源码位置：`src/hooks/useCopyOnSelect.ts:26-98`

### `useDoublePress(setPending, onDoublePress, onFirstPress?): () => void`

双击检测工具 Hook。返回一个函数，在 800ms（`DOUBLE_PRESS_TIMEOUT_MS`）内连续调用两次时触发 `onDoublePress`，否则触发 `onFirstPress`。

被 `useTextInput` 用于：
- **双击 Ctrl+C**：清空输入或退出
- **双击 Esc**：清空输入并保存到历史
- **双击 Ctrl+D**：输入为空时退出

> 源码位置：`src/hooks/useDoublePress.ts:8-62`

### `useArrowKeyHistory(onSetInput, currentInput, pastedContents, setCursorOffset?, currentMode?)`

上下箭头历史导航。

**性能优化**：
- 历史条目按 chunk（10 条）加载，避免大文件一次性读取
- 并发按键请求通过 `pendingLoad` 批量合并为单次磁盘读取
- `historyIndexRef` 同步追踪索引，避免 React 异步状态导致的快速按键问题

**功能细节**：
- 在 bash 模式下仅显示 bash 历史（`initialModeFilterRef`）
- 首次进入历史时保存当前输入为草稿，返回时恢复
- 浏览 2 条以上历史后显示 Ctrl+R 搜索提示

> 源码位置：`src/hooks/useArrowKeyHistory.tsx:63-228`

### `useHistorySearch(...): { historyQuery, setHistoryQuery, historyMatch, historyFailedMatch, handleKeyDown }`

Ctrl+R 风格的模糊搜索历史。

快捷键绑定（通过 keybinding 系统注册）：
- `history:search` — 启动搜索（非搜索状态下）
- `historySearch:next` — 查找下一个匹配
- `historySearch:accept` — 接受当前匹配
- `historySearch:cancel` — 取消并恢复原始输入
- `historySearch:execute` — 接受并立即提交

当 `HISTORY_PICKER` feature flag 启用时，Ctrl+R 改由模态对话框接管。

> 源码位置：`src/hooks/useHistorySearch.ts:15-303`

### `useAssistantHistory(props: Props): { maybeLoadOlder }`

管理 `claude assistant` 会话的远程历史记录分页加载。仅在 `viewerOnly` 模式下启用。

**加载策略**：
1. 挂载时通过 `fetchLatestEvents` 获取最新一页
2. 如果内容不足以填满视口，自动链式加载更多页（最多 `MAX_FILL_PAGES = 10` 页）
3. 用户滚动到顶部 40 行（`PREFETCH_THRESHOLD_ROWS`）以内时触发 `fetchOlderEvents` 预加载
4. 滚动锚定：prepend 前快照 scrollHeight，layout effect 中补偿 scrollTop，保持视口位置不变

顶部哨兵消息显示加载状态（loading/failed/start of session），UUID 稳定复用避免虚拟滚动的 remove+insert 抖动。

> 源码位置：`src/hooks/useAssistantHistory.ts:72-250`

---

## 接口/类型定义

### `TextInputState`

`useTextInput` 的返回类型（定义在 `src/types/textInputTypes.ts`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `onInput` | `(input: string, key: Key) => void` | 输入处理入口 |
| `renderedValue` | `string` | 含光标字符和幽灵文本的渲染结果 |
| `offset` | `number` | 光标在文本中的字符偏移 |
| `setOffset` | `(offset: number) => void` | 设置光标偏移 |
| `cursorLine` | `number` | 光标所在视口行号 |
| `cursorColumn` | `number` | 光标所在列号 |

### `VimInputState`

继承 `TextInputState`，增加 `mode: VimMode`（`'INSERT' | 'NORMAL'`）和 `setMode`。

### `BufferEntry`

`useInputBuffer` 的缓冲条目（`src/hooks/useInputBuffer.ts:4-9`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `text` | `string` | 输入文本快照 |
| `cursorOffset` | `number` | 光标位置 |
| `pastedContents` | `Record<number, PastedContent>` | 粘贴内容记录 |
| `timestamp` | `number` | 时间戳 |

---

## 配置项与默认值

| 配置 | 位置 | 默认值 | 说明 |
|------|------|--------|------|
| `copyOnSelect` | `getGlobalConfig()` | `true` | 选中内容时是否自动复制到剪贴板 |
| `DOUBLE_PRESS_TIMEOUT_MS` | `useDoublePress.ts:7` | `800` ms | 双击检测时间窗口 |
| `PASTE_THRESHOLD` | `imagePaste.js` | - | 判定为粘贴的输入长度阈值 |
| `CLIPBOARD_CHECK_DEBOUNCE_MS` | `usePasteHandler.ts:15` | `50` ms | 剪贴板图片检查去抖 |
| `PASTE_COMPLETION_TIMEOUT_MS` | `usePasteHandler.ts:16` | `100` ms | 粘贴块合并超时 |
| `HISTORY_CHUNK_SIZE` | `useArrowKeyHistory.tsx:13` | `10` | 历史记录分块加载大小 |
| `PREFETCH_THRESHOLD_ROWS` | `useAssistantHistory.ts:38` | `40` | 滚动预加载触发距离（行） |
| `MAX_FILL_PAGES` | `useAssistantHistory.ts:42` | `10` | 初始视口填充最大页数 |

---

## 边界 Case 与注意事项

- **SSH/tmux 环境下的 DEL 字符**：SSH 和 tmux 中 backspace 会同时产生按键事件和原始 DEL 字符（`\x7f`），`useTextInput` 在 `onInput` 中显式检测并处理这些孤立的 DEL 字符（`src/hooks/useTextInput.ts:444-464`）
- **SSH 合并 Enter**：慢速链接下 "o" + Enter 可能合并为一个 `"o\r"` 块，`useTextInput` 通过检测尾随 `\r` 触发 submit（`src/hooks/useTextInput.ts:486-499`）
- **Apple Terminal 特殊处理**：不支持自定义 Shift+Enter 绑定，通过原生 macOS modifier 检测判断 Shift 是否按下（`src/hooks/useTextInput.ts:263-265`）
- **Vim 模式下的 Escape**：INSERT→NORMAL 切换有意不纳入 keybinding 系统——Vim 用户期望 Esc 永远退出插入模式（`src/hooks/useVimInput.ts:189-195`）
- **粘贴竞态防护**：`pastePendingRef` 同步追踪粘贴状态，避免同一 stdin 块中粘贴 + 按键在 React batch 更新中导致丢失粘贴内容（`src/hooks/usePasteHandler.ts:53`）
- **Ctrl 键在 Vim NORMAL 模式**：始终交给 `useTextInput` 处理，保证 Ctrl+C/Ctrl+D 等在任何 Vim 模式下都能正常工作（`src/hooks/useVimInput.ts:184-187`）
- **`useHistorySearch` 的 feature 门控**：当 `HISTORY_PICKER` flag 启用时，Ctrl+R 由模态对话框接管，此 Hook 的搜索启动绑定被禁用（`src/hooks/useHistorySearch.ts:238-241`）