# 快捷键绑定系统（Keybindings）

## 概述与职责

快捷键绑定系统是 TerminalUI 模块的交互增强子系统，为整个终端 UI 提供**可配置的键盘快捷键**能力。它负责：

- 定义全局和上下文级别的默认按键映射
- 加载用户自定义快捷键配置（`~/.claude/keybindings.json`）并支持热重载
- 解析按键字符串（如 `ctrl+shift+k`）为结构化数据
- 将终端输入事件匹配到已注册的 action
- 支持多键 chord 组合（如 `ctrl+x ctrl+k`）
- 通过 React Context 将快捷键能力注入组件树
- Schema 校验和冲突检测

在整体架构中，Keybindings 是 **TerminalUI** 的子模块，与 Ink 渲染引擎和 UI 组件层紧密协作。TerminalUI 的同级模块包括 Entrypoints（入口层）、CoreEngine（核心引擎）、ToolSystem（工具系统）等。

## 核心类型

系统围绕以下核心类型构建（定义在 `types.js` 中，各模块广泛引用）：

- **`ParsedKeystroke`**：解析后的单个按键，包含 `key`、`ctrl`、`alt`、`shift`、`meta`、`super` 字段
- **`Chord`**：`ParsedKeystroke[]`，表示一个 chord 组合键序列
- **`ParsedBinding`**：一条完整的绑定记录，包含 `chord`（按键序列）、`action`（目标动作字符串或 `null` 表示解绑）、`context`（生效的上下文名称）
- **`KeybindingBlock`**：配置文件中的一个绑定块，包含 `context` 和 `bindings` 字典
- **`KeybindingContextName`**：上下文名称的联合类型，如 `'Global'`、`'Chat'`、`'Autocomplete'` 等

## 关键流程

### 1. 绑定加载与合并流程

应用启动时，绑定的加载遵循以下路径：

1. `KeybindingSetup` 组件在 `useState` 初始化器中同步调用 `loadKeybindingsSyncWithWarnings()`（`src/keybindings/loadUserBindings.ts:259`）
2. `loadKeybindingsSyncWithWarnings()` 首先调用 `getDefaultParsedBindings()` 解析内置默认绑定
3. 检查 `isKeybindingCustomizationEnabled()` 判断用户自定义是否启用（通过 GrowthBook feature gate `tengu_keybinding_customization_release`）
4. 若启用，同步读取 `~/.claude/keybindings.json`，解析为 `KeybindingBlock[]`
5. 用户绑定**追加**到默认绑定之后：`[...defaultBindings, ...userParsed]`——"后者胜出"的策略使用户配置自然覆盖默认值
6. 对用户配置运行校验（重复键检测、保留快捷键冲突检查等），返回 warnings

```
DEFAULT_BINDINGS  →  parseBindings()  →  [...defaults]
                                              ↓
keybindings.json  →  JSON.parse  →  validate  →  parseBindings()  →  [...defaults, ...user]
```

### 2. 按键解析流程

当用户按下一个键时（如 `ctrl+shift+k`），解析器将字符串拆解为结构化数据：

1. `parseKeystroke(input)` 按 `+` 分割字符串（`src/keybindings/parser.ts:13-75`）
2. 逐个 part 识别修饰键别名：`ctrl`/`control`、`alt`/`opt`/`option`/`meta`、`cmd`/`command`/`super`/`win`、`shift`
3. 特殊键名映射：`esc` → `escape`、`return` → `enter`、`space` → ` `、箭头符号 → 方向键名
4. 非修饰键部分成为 `key` 字段

对于 chord 组合键（如 `ctrl+x ctrl+e`），`parseChord()` 按空格分割后对每段调用 `parseKeystroke()`（`src/keybindings/parser.ts:80-84`）。特殊处理：单个空格字符 `' '` 被识别为 space 键绑定而非分隔符。

### 3. 按键匹配与 Action 解析流程

终端输入事件到达后，系统执行以下匹配逻辑：

1. **键名提取**：`getKeyName(input, key)` 将 Ink 的 `Key` 对象（布尔标志如 `key.escape`、`key.return`）映射为标准化的字符串键名（`src/keybindings/match.ts:29-47`）
2. **修饰键匹配**：`modifiersMatch()` 比较 Ink 修饰键与目标 `ParsedKeystroke`。关键细节——Ink 中 `alt` 和 `meta` 都映射到 `key.meta`（终端限制），所以配置中 `alt+k` 和 `meta+k` 效果相同（`src/keybindings/match.ts:60-79`）
3. **Escape 键 quirk**：Ink 在按下 Escape 时会设置 `key.meta=true`（终端转义序列的历史遗留），匹配时需特殊处理忽略这个 meta 标志（`src/keybindings/match.ts:96-102`）

### 4. Chord 状态机流程

chord 组合键（多键序列）通过有状态的解析器处理：

1. `resolveKeyWithChordState()` 接收当前按键和 `pending` 状态（已输入的前缀按键序列）（`src/keybindings/resolver.ts:166-244`）
2. 构建测试序列：`testChord = pending ? [...pending, currentKeystroke] : [currentKeystroke]`
3. **前缀检查**：扫描所有活跃上下文中的绑定，看当前序列是否是某个更长 chord 的前缀
4. 若是有效前缀 → 返回 `chord_started`，更新 pending 状态
5. 若完全匹配某个绑定 → 返回 `match`，清除 pending
6. 若无匹配且无更长可能 → 返回 `chord_cancelled`
7. Escape 键在 chord 进行中总是取消当前 chord

**Chord 超时**：`CHORD_TIMEOUT_MS = 1000`（1 秒），超时后自动取消未完成的 chord（`src/keybindings/KeybindingProviderSetup.tsx:30`）。

**null 解绑处理**：用户可以将某个 chord 绑定设为 `null` 来解绑。系统在计算前缀时会检查 chord 胜出者中是否还有非 null 的动作，避免已解绑的 chord 仍阻止单键绑定触发（`src/keybindings/resolver.ts:199-215`）。

### 5. React 集成流程

快捷键系统通过 React Context 注入组件树：

1. **`KeybindingSetup`**（`src/keybindings/KeybindingProviderSetup.tsx:119`）：顶层包装组件，负责初始化绑定数据、启动文件监听、管理 chord 状态。它包裹 `KeybindingProvider` 和 `ChordInterceptor`
2. **`KeybindingProvider`**（`src/keybindings/KeybindingContext.tsx:59`）：React Context Provider，向子组件暴露 `resolve`、`setPendingChord`、`getDisplayText`、`registerHandler`、`invokeAction` 等方法
3. **`ChordInterceptor`**（`src/keybindings/KeybindingProviderSetup.tsx:226`）：关键组件，注册最高优先级的 `useInput` 处理器，拦截 chord 序列的中间按键，防止它们被 PromptInput 等组件当作文本输入处理
4. **`useKeybinding` / `useKeybindings`**（`src/keybindings/useKeybinding.ts`）：组件级 Hook，注册 action 处理器。匹配成功时调用 `event.stopImmediatePropagation()` 阻止事件继续传播

```tsx
<KeybindingSetup>           // 加载绑定 + 初始化 watcher
  <KeybindingProvider>      // Context Provider
    <ChordInterceptor />    // 最高优先级输入拦截
    <REPL>                  // 应用组件
      <Component>           // 使用 useKeybinding('app:toggleTodos', handler)
      </Component>
    </REPL>
  </KeybindingProvider>
</KeybindingSetup>
```

## 函数签名与参数说明

### 按键解析（parser.ts）

#### `parseKeystroke(input: string): ParsedKeystroke`
将按键字符串解析为结构化对象。支持修饰键别名（ctrl/control、alt/opt/option/meta、cmd/command/super/win）和特殊键名映射。

#### `parseChord(input: string): Chord`
将 chord 字符串（空格分隔的多个按键步骤）解析为 `ParsedKeystroke[]`。

#### `parseBindings(blocks: KeybindingBlock[]): ParsedBinding[]`
将配置块数组扁平化为 `ParsedBinding` 列表。

#### `chordToDisplayString(chord: Chord, platform?: DisplayPlatform): string`
将 chord 转换为平台适配的显示字符串（macOS 上用 `opt` 代替 `alt`，`cmd` 代替 `super`）。

### 匹配（match.ts）

#### `getKeyName(input: string, key: Key): string | null`
从 Ink 的输入事件提取标准化键名。

#### `matchesKeystroke(input: string, key: Key, target: ParsedKeystroke): boolean`
检查 Ink 输入事件是否匹配目标按键（含修饰键比较）。

### 解析器（resolver.ts）

#### `resolveKeyWithChordState(input, key, activeContexts, bindings, pending): ChordResolveResult`
核心解析函数。返回以下状态之一：
- `{ type: 'match', action: string }` — 完全匹配
- `{ type: 'chord_started', pending: ParsedKeystroke[] }` — chord 前缀匹配
- `{ type: 'chord_cancelled' }` — chord 取消
- `{ type: 'unbound' }` — 显式解绑（action 为 null）
- `{ type: 'none' }` — 无匹配

#### `getBindingDisplayText(action, context, bindings): string | undefined`
反向查找：根据 action 名称获取其配置的快捷键显示文本。反向遍历确保用户覆盖优先。

### React Hook

#### `useKeybinding(action: string, handler: () => void, options?: Options): void`
注册单个 action 的处理器。`options.context` 默认为 `'Global'`，`options.isActive` 控制是否激活。

> 源码位置：`src/keybindings/useKeybinding.ts:33-97`

#### `useKeybindings(handlers: Record<string, () => void>, options?: Options): void`
批量注册多个 action 处理器，减少 `useInput` 调用次数。

> 源码位置：`src/keybindings/useKeybinding.ts:113-196`

#### `useShortcutDisplay(action, context, fallback): string`
React Hook，获取某个 action 的快捷键显示文本。未找到时返回 fallback 并记录遥测。

#### `useRegisterKeybindingContext(context, isActive?): void`
注册组件所在的快捷键上下文为活跃状态。活跃上下文中的绑定优先于 Global 绑定。

> 源码位置：`src/keybindings/KeybindingContext.tsx:215`

#### `getShortcutDisplay(action, context, fallback): string`
非 React 版本的快捷键显示文本获取，用于命令、服务等非组件上下文。

> 源码位置：`src/keybindings/shortcutFormat.ts:38-63`

## 默认绑定上下文

系统定义了 **17 个**快捷键上下文（`src/keybindings/schema.ts:12-32`），每个上下文有独立的绑定空间：

| 上下文 | 说明 | 典型绑定示例 |
|--------|------|-------------|
| Global | 全局生效 | `ctrl+c`(中断), `ctrl+l`(重绘), `ctrl+t`(Todo), `ctrl+o`(Transcript) |
| Chat | 聊天输入框聚焦时 | `enter`(提交), `escape`(取消), `ctrl+x ctrl+k`(终止Agent), `ctrl+g`(外部编辑器) |
| Autocomplete | 自动补全菜单可见时 | `tab`(接受), `escape`(关闭), `up/down`(导航) |
| Confirmation | 确认/权限对话框 | `y`(是), `n`(否), `enter`(确认) |
| Settings | 设置面板 | `j/k`(上下导航), `space`(切换), `enter`(保存关闭) |
| Transcript | 查看 Transcript 时 | `ctrl+e`(展开全部), `q`(退出) |
| HistorySearch | `ctrl+r` 历史搜索 | `ctrl+r`(下一个), `tab`(接受), `enter`(执行) |
| Scroll | 滚动视图 | `pageup/pagedown`, `wheelup/wheeldown`, `ctrl+shift+c`(复制选中) |
| Select | 列表选择组件 | `j/k`(导航), `enter`(选择), `escape`(取消) |

> 完整绑定定义：`src/keybindings/defaultBindings.ts:32-340`

### 平台适配

默认绑定中有两处关键的平台自适应逻辑：

1. **图片粘贴键**：Windows 上用 `alt+v`（因为 `ctrl+v` 是系统粘贴），其他平台用 `ctrl+v`（`src/keybindings/defaultBindings.ts:15`）
2. **模式切换键**：支持 VT 模式的终端用 `shift+tab`，Windows 不支持 VT 模式时回退到 `meta+m`（`src/keybindings/defaultBindings.ts:21-30`）

### 特性门控绑定

部分绑定受 feature flag 控制，仅在对应功能启用时注册：
- `KAIROS` / `KAIROS_BRIEF` → `ctrl+shift+b`（toggleBrief）
- `QUICK_SEARCH` → `ctrl+shift+f`/`cmd+shift+f`（全局搜索）、`ctrl+shift+p`/`cmd+shift+p`（快速打开）
- `TERMINAL_PANEL` → `meta+j`（切换终端面板）
- `VOICE_MODE` → `space`（按住说话）
- `MESSAGE_ACTIONS` → `shift+up`（消息操作）及 MessageActions 上下文

## 用户自定义配置

### 文件格式

用户配置文件路径：`~/.claude/keybindings.json`，格式如下：

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "$docs": "https://code.claude.com/docs/en/keybindings",
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        "ctrl+k": "chat:submit",
        "ctrl+x ctrl+e": null
      }
    }
  ]
}
```

Action 可以是：
- 预定义的 action 标识符（如 `chat:submit`、`app:toggleTodos`）
- 命令绑定：`command:<name>` 格式（如 `command:help`），仅在 Chat 上下文有效
- `null`：显式解绑默认快捷键

### 热重载

文件监听通过 chokidar 实现（`src/keybindings/loadUserBindings.ts:386-396`）：
- 监听 `add`、`change`、`unlink` 事件
- 写入稳定阈值 500ms，轮询间隔 200ms（避免编辑器保存过程中的中间状态）
- 文件删除时自动回退到默认绑定
- 变更通知通过 signal 模式发布，`KeybindingSetup` 订阅后更新 React 状态

### 模板生成

`generateKeybindingsTemplate()`（`src/keybindings/template.ts:40-52`）可生成完整的默认配置模板文件。它会自动过滤掉不可重绑定的保留快捷键（`ctrl+c`、`ctrl+d`、`ctrl+m`），避免用户配置后触发校验警告。

## Schema 校验

### Zod Schema（schema.ts）

`KeybindingsSchema`（`src/keybindings/schema.ts:214-229`）定义了完整的 JSON 配置结构：
- `$schema`、`$docs`：可选的元数据字段
- `bindings`：`KeybindingBlockSchema[]`，每个块包含 `context`（枚举）和 `bindings`（键值映射）
- Action 值支持三种形式：预定义 action 枚举、`command:` 前缀的命令绑定、`null`（解绑）

### 多层校验（validate.ts）

`validateBindings()` 运行以下校验步骤（`src/keybindings/validate.ts:425-451`）：

1. **结构校验**（`validateUserConfig`）：检查 JSON 结构、context 有效性、action 格式
2. **重复检测**（`checkDuplicates`）：同一 context 中相同键的重复绑定
3. **保留快捷键检查**（`checkReservedShortcuts`）：仅检查用户绑定，不检查默认绑定
4. **JSON 原文重复键检测**（`checkDuplicateKeysInJson`）：因为 `JSON.parse` 对重复键静默取最后一个值，需要对原始 JSON 字符串做正则扫描

校验结果以 `KeybindingWarning` 返回，包含类型（`parse_error`/`duplicate`/`reserved`/`invalid_context`/`invalid_action`）、严重程度（`error`/`warning`）、消息和建议。

## 保留快捷键

以下快捷键**不可重绑定**（`src/keybindings/reservedShortcuts.ts:16-33`）：

| 快捷键 | 原因 |
|--------|------|
| `ctrl+c` | 硬编码的中断/退出，不可重绑定 |
| `ctrl+d` | 硬编码的退出，不可重绑定 |
| `ctrl+m` | 在终端中等同于 Enter（都发送 CR），无法区分 |

终端级保留（warning 级别）：
- `ctrl+z`：Unix 进程挂起（SIGTSTP）
- `ctrl+\`：终端退出信号（SIGQUIT）

macOS 额外保留：`cmd+c/v/x`（系统剪贴板）、`cmd+q`（退出）、`cmd+w`（关闭）、`cmd+tab`（应用切换）、`cmd+space`（Spotlight）

## 边界 Case 与注意事项

- **Alt/Meta 不可区分**：终端中 Alt 和 Meta 发送相同的转义序列，Ink 统一设置 `key.meta=true`。因此 `alt+k` 和 `meta+k` 在匹配和 `keystrokesEqual()` 中被视为等价（`src/keybindings/resolver.ts:107-118`）
- **Super（Cmd/Win）是独立修饰键**：仅在支持 Kitty 键盘协议的终端中可用（kitty、WezTerm、ghostty、iTerm2），其他终端中 `cmd+` 绑定永远不会触发
- **voice:pushToTalk 的裸字母键警告**：将 `voice:pushToTalk` 绑定到不带修饰键的字母键会导致按住说话预热期间字母被输入到文本框中（`src/keybindings/validate.ts:220-243`）
- **command: 绑定限制**：命令绑定（`command:help` 等）只能放在 `Chat` 上下文中，放在其他上下文会触发警告
- **自定义功能的 feature gate**：用户自定义快捷键目前通过 GrowthBook 的 `tengu_keybinding_customization_release` 门控，未启用时始终使用默认绑定且不启动文件监听
- **Chord 状态同步**：chord 使用 ref + state 双轨管理——ref 保证 `resolve()` 中同步读取最新值，state 触发 UI 重渲染
- **ChordInterceptor 的注册顺序**：它在 `KeybindingProvider` 的 children 之前渲染，确保其 `useInput` 先于所有子组件注册，从而能拦截 chord 中间按键