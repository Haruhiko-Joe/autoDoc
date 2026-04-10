# 交互模式增强（InteractionModes）

## 概述与职责

InteractionModes 是 TerminalUI 层的交互增强模块集合，为终端 UI 提供四种独立的交互能力扩展：

- **vim/**：完整的 Vim 编辑模式状态机，支持 motions、operators、text objects 和模式切换
- **voice/**：语音输入功能的启用状态检测（GrowthBook 特性开关 + OAuth 认证双重校验）
- **outputStyles/**：从用户/项目目录加载自定义 Markdown 输出样式配置
- **moreright/**：提供 `useMoreRight` React Hook 处理右侧溢出内容的横向滚动（外部构建为 stub）

在整体架构中，InteractionModes 属于 **TerminalUI** 子系统。它的同级模块包括 Ink 渲染引擎、144 个 UI 组件库、REPL 主屏幕等。TerminalUI 上游接收 CoreEngine 推送的模型流式响应和工具执行结果，下游驱动 CoreEngine 处理用户输入。

---

## 一、Vim 编辑模式（src/vim/）

### 架构总览

Vim 模块实现了一个完整的 **有限状态机（FSM）**，将终端输入编辑器升级为类 Vim 的模态编辑体验。整个模块由 5 个文件组成，各司其职：

| 文件 | 职责 |
|------|------|
| `types.ts` | 状态机类型定义、键位常量、工厂函数 |
| `motions.ts` | 纯函数：将 motion 键解析为目标光标位置 |
| `operators.ts` | 纯函数：执行 delete/change/yank 等操作符 |
| `textObjects.ts` | 纯函数：查找文本对象边界（iw, a", ib 等） |
| `transitions.ts` | 状态转移表：根据当前状态和输入决定下一步 |

### 状态机设计

Vim 状态分为两个顶层模式（`src/vim/types.ts:49-51`）：

```typescript
export type VimState =
  | { mode: 'INSERT'; insertedText: string }
  | { mode: 'NORMAL'; command: CommandState }
```

- **INSERT 模式**：跟踪已输入文本（用于 dot-repeat 重放）
- **NORMAL 模式**：内嵌一个 `CommandState` 子状态机，解析多键命令序列

#### CommandState 子状态机

`CommandState` 是 Vim 模块的核心，定义了 11 种子状态（`src/vim/types.ts:59-75`）：

```
idle ──┬─[d/c/y]──► operator
       ├─[1-9]────► count
       ├─[fFtT]───► find
       ├─[g]──────► g
       ├─[r]──────► replace
       └─[><]─────► indent

operator ─┬─[motion]──► execute
           ├─[0-9]────► operatorCount
           ├─[ia]─────► operatorTextObj
           └─[fFtT]───► operatorFind
```

每个状态携带刚好够用的上下文数据。例如 `operator` 状态记录操作符类型（`Operator`）和计数，`operatorTextObj` 还额外记录作用域（`inner`/`around`）。TypeScript 的 discriminated union 确保 switch 分支穷尽处理。

#### 持久状态

`PersistentState`（`src/vim/types.ts:81-86`）跨命令存活，记录：

| 字段 | 类型 | 说明 |
|------|------|------|
| `lastChange` | `RecordedChange \| null` | 上次修改操作（用于 `.` dot-repeat） |
| `lastFind` | `{ type, char } \| null` | 上次 find 操作（用于 `;`/`,` 重复） |
| `register` | `string` | 寄存器内容（复制/删除的文本） |
| `registerIsLinewise` | `boolean` | 寄存器内容是否为整行模式 |

### 关键流程 Walkthrough

#### 流程 1：执行 `d2w`（删除两个单词）

1. **idle** → 用户按 `d` → `isOperatorKey('d')` 匹配 → 转移到 `operator` 状态，`op = 'delete'`, `count = 1`
2. **operator** → 用户按 `2` → 转移到 `operatorCount` 状态，`digits = '2'`
3. **operatorCount** → 用户按 `w` → `SIMPLE_MOTIONS.has('w')` 匹配 → `effectiveCount = 1 * 2 = 2` → 调用 `executeOperatorMotion('delete', 'w', 2, ctx)`
4. `executeOperatorMotion` 调用 `resolveMotion('w', cursor, 2)` 计算目标位置
5. `getOperatorRange` 计算操作范围（特殊处理：`cw`/`cW` 修改到词尾而非下一个词首）
6. `applyOperator('delete', from, to, ctx)` 执行删除：截取文本存入寄存器，更新文本和光标
7. 记录 `RecordedChange` 供 dot-repeat 使用

#### 流程 2：文本对象操作 `ciw`（修改内部单词）

1. **idle** → `c` → `operator` 状态
2. **operator** → `i` → `isTextObjScopeKey('i')` 匹配 → `operatorTextObj` 状态，`scope = 'inner'`
3. **operatorTextObj** → `w` → `TEXT_OBJ_TYPES.has('w')` 匹配 → 调用 `executeOperatorTextObj`
4. `findTextObject` 使用 grapheme segmenter 安全地找到词边界（`src/vim/textObjects.ts:60-116`）
5. 对 inner word：只包含词本身；对 around word：包含周围空白
6. `applyOperator('change', ...)` 删除范围并进入 INSERT 模式

### 函数签名

#### motions.ts

##### `resolveMotion(key: string, cursor: Cursor, count: number): Cursor`

将 motion 键解析为目标光标位置。纯计算，不修改任何状态。通过循环调用 `applySingleMotion` 实现 count 次重复，遇到边界（光标不再移动）时提前退出。

支持的 motion 键：`h` `l` `j` `k` `w` `b` `e` `W` `B` `E` `0` `^` `$` `G` `gj` `gk`

> 源码位置：`src/vim/motions.ts:13-25`

##### `isInclusiveMotion(key: string): boolean`

判断 motion 是否为 inclusive（操作范围包含目标字符）。`e`、`E`、`$` 为 inclusive。

##### `isLinewiseMotion(key: string): boolean`

判断 motion 是否为 linewise（操作范围扩展到整行）。`j`、`k`、`G`、`gg` 为 linewise。注意 `gj`/`gk` 是 characterwise exclusive。

#### operators.ts

##### `executeOperatorMotion(op, motion, count, ctx): void`

执行操作符 + motion 组合。计算 motion 目标位置，确定操作范围，应用操作符。

##### `executeOperatorFind(op, findType, char, count, ctx): void`

执行操作符 + find（如 `df,`）。使用 `Cursor.findCharacter` 定位目标字符。

##### `executeOperatorTextObj(op, scope, objType, count, ctx): void`

执行操作符 + 文本对象（如 `ci"`）。调用 `findTextObject` 查找对象边界。

##### `executeLineOp(op, count, ctx): void`

执行整行操作（`dd`/`cc`/`yy`）。通过计算逻辑行边界确定范围，特殊处理：
- 删除最后一行时包含前置换行符避免尾部空行
- `change` 时替换为空行并进入 INSERT 模式

##### `executeX(count, ctx): void` / `executeReplace(char, count, ctx): void` / `executeToggleCase(count, ctx): void`

单字符操作：删除（`x`）、替换（`r`）、大小写切换（`~`）。均以 grapheme 为单位操作，正确处理 emoji 等多码点字符。

##### `executePaste(after, count, ctx): void`

粘贴操作（`p`/`P`）。区分 linewise 和 characterwise 模式：linewise 在行间插入，characterwise 在光标位置插入。

##### `executeIndent(dir, count, ctx): void`

缩进操作（`>>`/`<<`）。使用两空格缩进，反向缩进时优先移除两空格，退而处理 tab 或部分空白。

> 源码位置：`src/vim/operators.ts:348-392`

#### transitions.ts

##### `transition(state: CommandState, input: string, ctx: TransitionContext): TransitionResult`

状态转移主入口。根据当前 `CommandState.type` 分发到对应的 `from*` 函数。返回值包含可选的 `next`（新状态）和 `execute`（要执行的操作）。

> 源码位置：`src/vim/transitions.ts:59-88`

#### textObjects.ts

##### `findTextObject(text, offset, objectType, isInner): TextObjectRange`

查找文本对象边界。支持三类：
- **词对象**（`w`/`W`）：使用 grapheme segmenter 遍历，区分 word char / punctuation / whitespace
- **引号对象**（`"` `'` `` ` ``）：在当前行内配对引号（0-1, 2-3, 4-5...）
- **括号对象**（`()` `[]` `{}` `<>`）：使用深度计数器向前/向后扫描匹配

> 源码位置：`src/vim/textObjects.ts:38-58`

### 接口/类型定义

#### `OperatorContext`（`src/vim/operators.ts:26-37`）

操作符执行所需的上下文，由调用方注入：

| 字段 | 类型 | 说明 |
|------|------|------|
| `cursor` | `Cursor` | 当前光标对象 |
| `text` | `string` | 当前文本内容 |
| `setText` | `(text: string) => void` | 更新文本回调 |
| `setOffset` | `(offset: number) => void` | 设置光标偏移量 |
| `enterInsert` | `(offset: number) => void` | 进入 INSERT 模式 |
| `getRegister` / `setRegister` | — | 寄存器读写 |
| `getLastFind` / `setLastFind` | — | 上次 find 操作读写 |
| `recordChange` | `(change: RecordedChange) => void` | 记录操作供 dot-repeat |

#### `TransitionContext`（`src/vim/transitions.ts:43-46`）

扩展 `OperatorContext`，额外提供 `onUndo` 和 `onDotRepeat` 回调。

#### `TransitionResult`（`src/vim/transitions.ts:51-54`）

状态转移结果：`next` 表示新的 `CommandState`（不设则回 idle），`execute` 为需要执行的操作函数。

### 配置项与默认值

- `MAX_VIM_COUNT = 10000`：count 前缀上限，防止 `99999dd` 等极端操作（`src/vim/types.ts:182`）
- 初始状态为 INSERT 模式（`createInitialVimState` 返回 `{ mode: 'INSERT', insertedText: '' }`）
- 缩进单位为 2 个空格（硬编码在 `executeIndent` 中）

### 边界 Case 与注意事项

- **grapheme 安全**：所有字符操作（`x`、`r`、`~`、word motion）使用 `firstGrapheme`/`lastGrapheme` 和 Intl Segmenter 处理多码点字符，避免截断 emoji
- **Image chip 保护**：`getOperatorRange` 中调用 `snapOutOfImageRef` 确保 `dw`/`cw`/`yw` 不会切割 `[Image #N]` 占位符
- **`cw` 特殊行为**：`cw`/`cW` 修改到当前词尾（非下一个词首），与 Vim 原版一致（`src/vim/operators.ts:441-450`）
- **`r<BS>` 取消**：replace 状态收到空字符串输入时回到 idle，避免误删字符（`src/vim/transitions.ts:446`）
- **linewise 粘贴**：寄存器内容以 `\n` 结尾时自动识别为 linewise 模式，粘贴时在行间插入

---

## 二、语音输入启用检测（src/voice/）

### 概述

`voiceModeEnabled.ts` 提供三个函数，分层检测语音输入功能是否可用。语音功能依赖 claude.ai 的 `voice_stream` 端点，因此需要 Anthropic OAuth 认证（API Key、Bedrock、Vertex、Foundry 均不支持）。

### 函数签名

#### `isVoiceGrowthBookEnabled(): boolean`

GrowthBook 特性开关检查。检测 `tengu_amber_quartz_disabled` flag 是否被翻转为 `true`（紧急关闭）。默认 `false` 意味着缓存缺失时语音功能保持可用——新安装不需要等待 GrowthBook 初始化。

前置条件：需要通过 `feature('VOICE_MODE')` 编译时特性门控。外部构建中此门控为 `false`，直接返回 `false`。

> 源码位置：`src/voice/voiceModeEnabled.ts:16-23`

#### `hasVoiceAuth(): boolean`

认证检查。依次验证：
1. `isAnthropicAuthEnabled()` — 当前认证提供商是否为 Anthropic（排除 Bedrock/Vertex/Foundry）
2. `getClaudeAIOAuthTokens()` — 是否存在有效的 OAuth access token（macOS 上首次调用触发 `security` 命令，~20-50ms，后续走缓存）

> 源码位置：`src/voice/voiceModeEnabled.ts:32-44`

#### `isVoiceModeEnabled(): boolean`

完整运行时检查，组合 `hasVoiceAuth()` && `isVoiceGrowthBookEnabled()`。适用于命令执行时（如 `/voice` 命令、ConfigTool、VoiceModeNotice）。React 渲染路径应使用 `useVoiceEnabled()` Hook（对认证部分做了 memoize）。

> 源码位置：`src/voice/voiceModeEnabled.ts:52-54`

### 边界 Case 与注意事项

- 仅做**状态检测**，不包含语音流的建立和音频处理逻辑
- `isAnthropicAuthEnabled()` 只检查认证提供商，不检查 token 是否存在——两层检查缺一不可
- token 缓存约每小时刷新一次，刷新时有一次 ~20-50ms 的 keychain 访问开销

---

## 三、自定义输出样式加载（src/outputStyles/）

### 概述

`loadOutputStylesDir.ts` 从文件系统加载 Markdown 格式的自定义输出样式配置，让用户和项目可以定义 Claude 的输出风格（如"简洁模式"、"详细模式"）。

### 加载路径与优先级

| 来源 | 路径 | 优先级 |
|------|------|--------|
| 用户级 | `~/.claude/output-styles/*.md` | 低 |
| 项目级 | `.claude/output-styles/*.md` | 高（覆盖用户级同名样式） |

### 关键流程

1. 调用 `loadMarkdownFilesForSubdir('output-styles', cwd)` 扫描用户和项目目录
2. 对每个 `.md` 文件：
   - 文件名（去 `.md`）作为默认样式名
   - 解析 frontmatter 的 `name`（可选覆盖）和 `description`
   - 解析 `keep-coding-instructions` 布尔标志（支持 `true`/`"true"`/`false`/`"false"`）
   - 如果 frontmatter 设置了 `force-for-plugin`，记录警告（该选项仅对插件输出样式有效）
   - 文件正文（`content.trim()`）作为样式 prompt
3. 返回 `OutputStyleConfig[]` 数组

### 函数签名

#### `getOutputStyleDirStyles(cwd: string): Promise<OutputStyleConfig[]>`

加载输出样式的主函数。使用 `lodash-es/memoize` 缓存结果——同一 `cwd` 只加载一次。

返回值每个元素包含：`name`、`description`、`prompt`、`source`、`keepCodingInstructions`

> 源码位置：`src/outputStyles/loadOutputStylesDir.ts:26-92`

#### `clearOutputStyleCaches(): void`

清除所有缓存：`getOutputStyleDirStyles` 的 memoize 缓存、`loadMarkdownFilesForSubdir` 的缓存、以及插件输出样式缓存。在配置变更后需要调用。

> 源码位置：`src/outputStyles/loadOutputStylesDir.ts:94-98`

### 边界 Case 与注意事项

- memoize 基于 `cwd` 参数，切换工作目录后需手动调用 `clearOutputStyleCaches()`
- frontmatter 中 `description` 支持多种格式（字符串、数组等），通过 `coerceDescriptionToString` 统一处理
- 单个文件解析失败不影响其他文件，错误被 `logError` 记录后跳过

---

## 四、右侧溢出滚动 Hook（src/moreright/）

### 概述

`useMoreRight.tsx` 导出一个 React Hook `useMoreRight`，用于处理终端 UI 中内容超出右侧边界时的横向滚动交互。

**重要**：当前仓库中的文件是**外部构建的 stub 实现**——所有方法都是空操作（no-op）。真正的实现仅存在于内部构建中。

### 函数签名

#### `useMoreRight(args): { onBeforeQuery, onTurnComplete, render }`

**参数**（`src/moreright/useMoreRight.tsx:9-14`）：

| 参数 | 类型 | 说明 |
|------|------|------|
| `enabled` | `boolean` | 是否启用横向滚动功能 |
| `setMessages` | `(action) => void` | 消息列表更新函数 |
| `inputValue` | `string` | 当前输入框内容 |
| `setInputValue` | `(s: string) => void` | 更新输入框内容 |
| `setToolJSX` | `(args) => void` | 设置工具渲染 JSX |

**返回值**（`src/moreright/useMoreRight.tsx:15-19`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `onBeforeQuery` | `(input, all, n) => Promise<boolean>` | 查询前拦截器（stub 返回 `true` 表示继续） |
| `onTurnComplete` | `(all, aborted) => Promise<void>` | 轮次完成回调 |
| `render` | `() => null` | 渲染函数（stub 返回 `null`） |

### 边界 Case 与注意事项

- Stub 文件自包含、无相对 import，确保在 `scripts/external-stubs/` 目录下也能通过类型检查
- 内部构建通过文件覆盖（overlay）机制替换此 stub 为真实实现
- 所有类型标注为 `any`（别名 `M`），避免依赖内部类型定义