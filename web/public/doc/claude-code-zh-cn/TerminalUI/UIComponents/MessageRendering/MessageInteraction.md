# 消息导航、选中与操作系统（MessageInteraction）

## 概述与职责

MessageInteraction 模块是 Claude Code 终端 UI 中**消息交互层**的核心基础设施，位于 `TerminalUI → UIComponents → MessageRendering` 层级下。它由两个文件组成：

- **`messageActions.tsx`**（449 行）：定义消息导航与操作的底层机制——判断哪些消息可以被选中、提取工具调用信息、注册操作快捷键、渲染操作栏
- **`MessageSelector.tsx`**（830 行）：实现"Rewind"（回退）面板——允许用户选择历史消息节点，回退对话和/或代码状态、生成摘要

两者协同工作：`messageActions` 让用户在消息列表中通过键盘导航和选中单条消息执行快捷操作（复制、编辑、展开/折叠）；`MessageSelector` 则提供一个完整的回退选择器 UI，支持会话恢复、代码回退和摘要生成。

同级模块包括 `PermissionUI`（权限审批 UI）、`DesignSystem`（设计系统原语）、`PromptInput`（输入区域）等，共同构成 UIComponents 组件库。

---

## 关键流程

### 消息导航与操作流程（messageActions.tsx）

1. **可导航性判断**：当虚拟消息列表需要确定哪些消息可以被键盘光标选中时，调用 `isNavigableMessage()` 进行两层过滤：
   - 第一层（tier-1）：基于消息在 virtual list 中的渲染高度（height > 0），由外部处理
   - 第二层（tier-2）：`isNavigableMessage` 按消息类型和内容进一步过滤——排除空文本、合成消息、元消息、非用户作者的 XML 包裹内容、以及不可操作的系统消息子类型（如 `api_metrics`、`turn_duration`）

2. **进入光标模式**：用户触发 `enterCursor()`（通过 `MessageActionsNav` 接口），光标定位到当前可见消息，`MessageActionsSelectedContext` 变为 `true`，被选中的消息行获得高亮背景

3. **键盘操作分发**：`useMessageActions` hook 创建一组稳定的 handler 映射到快捷键命名空间 `messageActions:*`（prev/next/prevUser/nextUser/top/bottom/escape/ctrlc 以及动态 action key）。当用户按键时：
   - 导航键：调用 `navRef` 上的导航方法移动光标
   - 动作键（enter/c/p）：根据 `MESSAGE_ACTIONS` 数组中的定义，检查该 action 是否对当前消息类型适用（`isApplicable`），然后执行对应操作
   - escape：折叠已展开的消息或退出光标模式；ctrl+c 直接退出

4. **操作栏渲染**：`MessageActionsBar` 组件根据当前光标状态过滤出适用的操作，渲染为底部操作提示栏（如 `enter expand · c copy · p copy path · ↑↓ navigate · esc back`）

### 消息回退流程（MessageSelector.tsx）

1. **打开选择器**：用户触发 Rewind 功能，`MessageSelector` 组件挂载，记录分析事件 `tengu_message_selector_opened`

2. **消息列表构建**：通过 `selectableUserMessagesFilter` 过滤出真正由用户发送的消息（排除工具结果、合成消息、元消息、命令输出等），追加一个虚拟的 `(current)` 节点作为列表末尾

3. **消息选择**：用户通过 `messageSelector:up/down/top/bottom/select` 快捷键在最多 `MAX_VISIBLE_MESSAGES`（7 条）的滑动窗口中浏览和选择消息。每条消息旁展示文件变更的 diff 统计（通过 `computeDiffStatsBetweenMessages` 计算增删行数）

4. **恢复选项确认**：选中消息后进入确认阶段，根据 `fileHistory` 是否可用，提供不同选项：
   - **Restore code and conversation**（`both`）：同时回退代码文件和对话历史
   - **Restore conversation**（`conversation`）：仅恢复对话到选定点
   - **Restore code**（`code`）：仅回退文件到选定点的快照
   - **Summarize from here**（`summarize`）：对选定点之后的消息生成摘要，支持附带用户上下文
   - **Summarize up to here**（`summarize_up_to`）：对选定点之前的消息生成摘要（仅内部版本可用）
   - **Never mind**：取消操作

5. **执行恢复**：`onSelectRestoreOption` 根据选项调用 `onRestoreCode`、`onRestoreMessage` 或 `onSummarize` 回调，处理错误并关闭选择器

---

## 函数签名与参数说明

### messageActions.tsx 导出

#### `isNavigableMessage(msg: NavigableMessage): boolean`

判断消息是否可被键盘光标选中。过滤逻辑按消息类型分支：
- `assistant`：需要是非空文本或支持 `PRIMARY_INPUT` 提取的工具调用
- `user`：排除 meta/compact summary、合成消息、XML 包裹内容
- `system`：排除 `api_metrics`、`stop_hook_summary`、`turn_duration` 等不可操作子类型
- `grouped_tool_use` / `collapsed_read_search`：始终可导航
- `attachment`：仅 `queued_command`、`diagnostics`、`hook_blocking_error`、`hook_error_during_execution` 可导航

> 源码位置：`src/components/messageActions.tsx:18-64`

#### `toolCallOf(msg: NavigableMessage): { name: string; input: Record<string, unknown> } | undefined`

从消息中提取工具调用信息。支持 `assistant` 类型（直接 tool_use block）和 `grouped_tool_use` 类型（取第一个子消息的 tool_use）。

> 源码位置：`src/components/messageActions.tsx:122-141`

#### `stripSystemReminders(text: string): string`

剥离文本开头的所有 `<system-reminder>...</system-reminder>` XML 标签，返回清理后的纯净文本。用于判断用户消息是否以 `<` 开头（XML 包裹的非用户内容）。

> 源码位置：`src/components/messageActions.tsx:399-408`

#### `copyTextOf(msg: NavigableMessage): string`

根据消息类型提取可复制的文本内容：
- `user`：清理 system-reminder 后的文本
- `assistant`：文本内容，或工具调用的 primary input
- `grouped_tool_use`：所有工具结果文本，以双换行连接
- `collapsed_read_search`：展开所有子消息的工具结果
- `system`：content / error / subtype
- `attachment`：queued_command 的 prompt 文本

> 源码位置：`src/components/messageActions.tsx:409-441`

#### `useMessageActions(cursor, setCursor, navRef, caps): { enter, handlers }`

核心 hook，组装消息操作的完整键盘处理逻辑。返回 `enter`（进入光标模式）和 `handlers`（快捷键 → handler 映射）。使用 ref 保持 handler 稳定，避免每次消息追加时重新注册快捷键。

> 源码位置：`src/components/messageActions.tsx:217-271`

#### `MessageActionsKeybindings({ handlers, isActive }): null`

必须挂载在 `<KeybindingSetup>` 内部的组件，将 handlers 注册到快捷键系统。

> 源码位置：`src/components/messageActions.tsx:274-293`

#### `MessageActionsBar({ cursor }): ReactNode`

底部操作提示栏组件，根据当前光标状态显示可用操作及其快捷键。

> 源码位置：`src/components/messageActions.tsx:296-398`

### MessageSelector.tsx 导出

#### `MessageSelector(props: Props): ReactNode`

完整的 Rewind 面板组件。

**Props：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `messages` | `Message[]` | 完整消息列表 |
| `onPreRestore` | `() => void` | 恢复前的准备回调 |
| `onRestoreMessage` | `(message: UserMessage) => Promise<void>` | 恢复对话回调 |
| `onRestoreCode` | `(message: UserMessage) => Promise<void>` | 恢复代码回调 |
| `onSummarize` | `(message: UserMessage, feedback?: string, direction?: PartialCompactDirection) => Promise<void>` | 摘要生成回调 |
| `onClose` | `() => void` | 关闭选择器回调 |
| `preselectedMessage` | `UserMessage?` | 跳过消息列表直接进入确认步骤 |

> 源码位置：`src/components/MessageSelector.tsx:46-401`

#### `selectableUserMessagesFilter(message: Message): message is UserMessage`

类型守卫函数，过滤出可在 Rewind 列表中选择的用户消息。排除条件：
- 非 `user` 类型
- tool_result 消息
- 合成消息（`isSyntheticMessage`）
- meta 消息、compact summary、仅在 transcript 中可见的消息
- 包含命令输出 XML 标签的消息（`<bash-stdout>`、`<local-command-stdout>` 等）

> 源码位置：`src/components/MessageSelector.tsx:767-792`

#### `messagesAfterAreOnlySynthetic(messages: Message[], fromIndex: number): boolean`

检查给定索引之后的消息是否全为合成/无实质内容。用于判断是否需要确认步骤——如果用户发送后立即取消，后续只有合成消息，可以跳过确认。

> 源码位置：`src/components/MessageSelector.tsx:799-829`

---

## 接口/类型定义

### `NavigableType`

```typescript
type NavigableType = 'user' | 'assistant' | 'grouped_tool_use' | 'collapsed_read_search' | 'system' | 'attachment';
```

可导航消息的类型联合，定义了哪些 `RenderableMessage` 子类型可以出现在导航光标中。

> 源码位置：`src/components/messageActions.tsx:10-11`

### `MessageActionsState`

```typescript
type MessageActionsState = {
  uuid: string;           // 当前选中消息的唯一标识
  msgType: NavigableType; // 消息类型
  expanded: boolean;      // 是否展开（用于 grouped_tool_use 等可折叠消息）
  toolName?: string;      // 工具调用名称（如有）
};
```

描述光标当前选中消息的状态，驱动操作栏和快捷键的行为判断。

> 源码位置：`src/components/messageActions.tsx:192-197`

### `MessageActionsNav`

```typescript
type MessageActionsNav = {
  enterCursor: () => void;       // 进入光标模式
  navigatePrev: () => void;      // 上移
  navigateNext: () => void;      // 下移
  navigatePrevUser: () => void;  // 跳到上一条用户消息
  navigateNextUser: () => void;  // 跳到下一条用户消息
  navigateTop: () => void;       // 跳到顶部
  navigateBottom: () => void;    // 跳到底部
  getSelected: () => NavigableMessage | null; // 获取当前选中消息
};
```

导航接口，由 VirtualMessageList 实现，通过 ref 暴露给 `useMessageActions`。

> 源码位置：`src/components/messageActions.tsx:198-207`

### `MessageActionCaps`

```typescript
type MessageActionCaps = {
  copy: (text: string) => void;                    // 复制到剪贴板
  edit: (msg: NormalizedUserMessage) => Promise<void>; // 编辑用户消息
};
```

操作能力接口，由上层组件注入具体实现。

> 源码位置：`src/components/messageActions.tsx:142-145`

### `RestoreOption`

```typescript
type RestoreOption = 'both' | 'conversation' | 'code' | 'summarize' | 'summarize_up_to' | 'nevermind';
```

Rewind 面板中的恢复选项枚举。

> 源码位置：`src/components/MessageSelector.tsx:31`

### `DiffStats`

从 `src/utils/fileHistory.js` 导入的类型，包含 `filesChanged: string[]`、`insertions: number`、`deletions: number`，用于展示代码变更统计。

---

## Context 与共享状态

### `MessageActionsSelectedContext`

```typescript
const MessageActionsSelectedContext = React.createContext(false);
```

布尔值 Context，表示当前消息行是否被光标选中。消费者通过 `useSelectedMessageBg()` 获取高亮背景色。

> 源码位置：`src/components/messageActions.tsx:208`

### `InVirtualListContext`

```typescript
const InVirtualListContext = React.createContext(false);
```

布尔值 Context，标记当前组件是否处于虚拟列表内部。用于让内部组件区分自己是在 virtual list 中渲染还是在其他位置（如对话框中）。

> 源码位置：`src/components/messageActions.tsx:209`

---

## 配置项与默认值

### PRIMARY_INPUT 映射表

定义了 12 种工具的"主要输入"提取规则，用于 `copy primary input`（快捷键 `p`）操作：

| 工具名 | label | 提取字段 |
|--------|-------|----------|
| Read | path | `file_path` |
| Edit | path | `file_path` |
| Write | path | `file_path` |
| NotebookEdit | path | `notebook_path` |
| Bash | command | `command` |
| Grep | pattern | `pattern` |
| Glob | pattern | `pattern` |
| WebFetch | url | `url` |
| WebSearch | query | `query` |
| Task | prompt | `prompt` |
| Agent | prompt | `prompt` |
| Tmux | command | 拼接 `tmux` + `args` 数组 |

> 源码位置：`src/components/messageActions.tsx:70-119`

### MESSAGE_ACTIONS 操作定义

4 个预定义操作，按优先级匹配：

| 快捷键 | 操作 | 适用消息类型 | 行为 |
|--------|------|-------------|------|
| `enter` | expand/collapse | grouped_tool_use, collapsed_read_search, attachment, system | 切换展开状态，光标保持（`stays: true`） |
| `enter` | edit | user | 编辑用户消息 |
| `c` | copy | 所有可导航类型 | 复制消息文本到剪贴板 |
| `p` | copy {label} | grouped_tool_use, assistant | 仅当工具在 PRIMARY_INPUT 中时可用，复制工具的主要输入值 |

> 源码位置：`src/components/messageActions.tsx:158-187`

### MAX_VISIBLE_MESSAGES

MessageSelector 中消息列表的最大可见条数，固定为 **7**。列表通过滑动窗口方式展示，选中项居中。

> 源码位置：`src/components/MessageSelector.tsx:45`

---

## 边界 Case 与注意事项

- **handler 稳定性**：`useMessageActions` 使用 ref 包装 `cursor` 和 `caps`，确保 handler 对象引用稳定。这避免了每次消息列表变化时触发 `useKeybindings` 重新注册。

- **escape 的两阶段退出**：按 `escape` 时，如果消息处于展开状态会先折叠再退出光标模式；而 `ctrl+c` 跳过折叠步骤直接退出——这是为了避免在流式输出期间需要按三次才能中断（折叠 → 退出光标 → 取消流）。

- **`summarize_up_to` 仅内部可用**：代码中通过 `"external" === 'ant'` 条件判断（`src/components/MessageSelector.tsx:121`），该选项只在内部构建版本中显示。

- **文件历史局限**：Rewind 功能只能回退通过 Edit/Write 工具修改的文件，**不包括通过 Bash 命令或手动编辑的文件变更**（UI 中有明确警告提示）。

- **`isNavigableMessage` 的 XML 前缀过滤**：用户消息如果在剥离 system-reminder 后以 `<` 开头，会被视为 XML 包裹的命令扩展/bash 输出而非真实用户输入，不可导航。这与 VirtualMessageList 的 sticky-prompt 过滤逻辑保持一致。

- **React Compiler 优化**：两个文件大量使用 `_c()` 缓存机制（React Compiler 产物），通过 memo cache sentinel 模式避免不必要的重渲染，这是性能优化的编译产物而非手写代码。

- **`computeDiffStatsBetweenMessages` 的 diff 统计**：遍历两个消息之间的所有 tool_use_result，从 `FileEditOutput` 和 `FileWriteToolOutput` 的 `structuredPatch` 中提取增删行数。对于新建文件（`type === 'create'`），insertions 等于文件总行数。