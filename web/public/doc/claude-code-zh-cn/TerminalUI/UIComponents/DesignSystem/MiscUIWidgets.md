# 独立通用 UI 小组件集合（MiscUIWidgets）

## 概述与职责

MiscUIWidgets 是 TerminalUI → UIComponents → DesignSystem 层级下的一组独立通用 UI 小组件集合。这些组件各自职责单一、体量小（14–147 行，共约 620 行），在终端 UI 的不同场景中被复用。它们不构成独立子系统，而是作为"原子级"构建块被上层组件（如消息渲染、权限请求、设置面板等）按需引用。

同级模块包括 MessageRendering（消息渲染系统）、PermissionUI（权限请求 UI）、DialogCollection（对话框集合）等，本模块中的组件常作为它们内部的 UI 片段被嵌入使用。

本模块包含以下 8 个组件：

| 组件 | 文件 | 行数 | 一句话描述 |
|------|------|------|-----------|
| TagTabs | `TagTabs.tsx` | ~138 | 标签式标签页切换，支持溢出滚动 |
| FilePathLink | `FilePathLink.tsx` | ~42 | 将文件路径渲染为可点击的终端超链接 |
| ClickableImageRef | `ClickableImageRef.tsx` | ~72 | 将图片引用渲染为可点击链接 |
| ConfigurableShortcutHint | `ConfigurableShortcutHint.tsx` | ~56 | 显示用户自定义快捷键提示 |
| PressEnterToContinue | `PressEnterToContinue.tsx` | ~14 | "Press Enter to continue…" 提示 |
| CtrlOToExpand | `CtrlOToExpand.tsx` | ~50 | "ctrl+o to expand" 展开操作提示 |
| ValidationErrorsList | `ValidationErrorsList.tsx` | ~146 | 将校验错误按文件分组并以树形结构展示 |
| SandboxViolationExpandedView | `SandboxViolationExpandedView.tsx` | ~98 | 沙盒违规事件的详情展开视图 |

## 关键流程

### TagTabs —— 自适应标签页渲染

TagTabs 实现了一个在有限终端宽度下自适应显示标签页的组件，核心流程如下：

1. **计算可用宽度**：从 `availableWidth` 中扣除 "Resume" 标签宽度和右侧提示宽度，得到标签区可用空间（`src/components/TagTabs.tsx:64-65`）
2. **逐标签计算宽度**：通过 `getTabWidth()` 计算每个标签的显示宽度，非 "All" 标签带 `#` 前缀，超长标签会被 `truncateTag()` 截断（`src/components/TagTabs.tsx:30-53`）
3. **滑动窗口算法**：当所有标签总宽度超出可用空间时，以当前选中标签为中心，向左右扩展可见窗口，直到空间耗尽（`src/components/TagTabs.tsx:86-111`）
4. **渲染溢出指示器**：左侧隐藏标签显示 `← N`，右侧显示 `→N (tab to cycle)`（`src/components/TagTabs.tsx:119-136`）

### FilePathLink —— 终端超链接

将绝对文件路径通过 `pathToFileURL()` 转为 `file://` URL，利用 Ink 的 `Link` 组件渲染 OSC 8 终端超链接，让 iTerm 等终端正确识别文件路径（`src/components/FilePathLink.tsx:17-41`）。支持自定义显示文本（`children`），默认显示原始路径。

### ClickableImageRef —— 图片引用链接

1. 通过 `getStoredImagePath(imageId)` 查找图片的本地存储路径
2. 检查终端是否支持超链接（`supportsHyperlinks()`）
3. 两者都满足时，渲染为可点击链接（点击后在默认查看器中打开图片）；选中态下文本加粗
4. 否则降级为纯样式文本（`src/components/ClickableImageRef.tsx:23-71`）

### CtrlOToExpand —— 智能展开提示

该组件不是简单的静态文本，而是包含上下文感知逻辑：

1. 通过 `SubAgentContext` 和 `InVirtualListContext` 两个 React Context 判断当前渲染环境
2. **在子 Agent 输出或虚拟列表中不显示**——避免提示冗余（`src/components/CtrlOToExpand.tsx:34-36`）
3. 通过 `useShortcutDisplay()` 获取用户自定义的快捷键（默认 `ctrl+o`），绑定到 `app:toggleTranscript` 动作
4. 同时导出一个纯函数 `ctrlOToExpand()` 返回 chalk 格式化的字符串版本，供非 React 上下文使用（`src/components/CtrlOToExpand.tsx:47-50`）

### ValidationErrorsList —— 树形错误展示

1. 按文件路径分组错误（`reduce` 聚合到 `errorsByFile`）
2. 对每个文件的错误调用 `buildNestedTree()` 将 dot-notation 路径（如 `permissions.allow.0`）构建为嵌套树结构，使用 lodash 的 `setWith` 避免自动数组创建（`src/components/ValidationErrorsList.tsx:12-57`）
3. 对数组索引进行可读性增强——将末尾的数字索引替换为实际的无效值（如 `"badValue"`）
4. 通过 `treeify()` 将嵌套树渲染为终端友好的树形文本
5. 去重收集所有 `suggestion` 和 `docLink`，附在树形输出之后（`src/components/ValidationErrorsList.tsx:83-104`）

### SandboxViolationExpandedView —— 沙盒违规详情

1. 通过 `useEffect` 订阅 `SandboxManager.getSandboxViolationStore()`，实时获取沙盒违规事件
2. 仅保留最近 10 条违规记录（`allViolations.slice(-10)`）
3. 在 Linux 平台或沙盒未启用时返回 null
4. 每条记录显示时间戳（自定义 `formatTime()` 格式化，避免引入 date-fns 39MB 依赖）、命令名和违规详情
5. 底部显示 "showing last N of total" 分页提示（`src/components/SandboxViolationExpandedView.tsx:20-98`）

## 函数签名与参数说明

### `TagTabs({ tabs, selectedIndex, availableWidth, showAllProjects? })`

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| tabs | `string[]` | — | 标签名称列表 |
| selectedIndex | `number` | — | 当前选中索引 |
| availableWidth | `number` | — | 终端可用宽度（字符数） |
| showAllProjects | `boolean` | `false` | 是否显示 "Resume (All Projects)" |

### `FilePathLink({ filePath, children? })`

| 参数 | 类型 | 说明 |
|------|------|------|
| filePath | `string` | 绝对文件路径 |
| children | `ReactNode` | 可选的显示文本，默认为 filePath |

### `ClickableImageRef({ imageId, backgroundColor?, isSelected? })`

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| imageId | `number` | — | 图片存储 ID |
| backgroundColor | `keyof Theme` | — | 背景色（主题色名） |
| isSelected | `boolean` | `false` | 是否处于选中态 |

### `ConfigurableShortcutHint({ action, context, fallback, description, parens?, bold? })`

| 参数 | 类型 | 说明 |
|------|------|------|
| action | `KeybindingAction` | 快捷键动作标识，如 `'app:toggleTranscript'` |
| context | `KeybindingContextName` | 快捷键上下文，如 `'Global'` |
| fallback | `string` | 用户未配置时的默认快捷键 |
| description | `string` | 动作描述文本 |
| parens | `boolean` | 是否用括号包裹 |
| bold | `boolean` | 是否加粗 |

### `ValidationErrorsList({ errors })`

| 参数 | 类型 | 说明 |
|------|------|------|
| errors | `ValidationError[]` | 校验错误列表，每项包含 `path`、`message`、`invalidValue`、`suggestion`、`docLink`、`file` |

### `PressEnterToContinue()` / `CtrlOToExpand()` / `SandboxViolationExpandedView()`

这三个组件均无需 props。

## 接口/类型定义

### `ValidationError`（外部类型，来自 `src/utils/settings/validation.js`）

被 ValidationErrorsList 消费的核心类型，包含字段：
- `path`: dot-notation 路径（如 `"permissions.allow.0"`）
- `message`: 错误消息
- `invalidValue`: 导致校验失败的值
- `suggestion`: 修复建议
- `docLink`: 相关文档链接
- `file`: 错误所在文件路径

### `SandboxViolationEvent`（外部类型，来自 `src/utils/sandbox/sandbox-adapter.js`）

被 SandboxViolationExpandedView 消费，包含字段：
- `timestamp`: `Date` 违规发生时间
- `command`: 触发违规的命令名
- `line`: 违规详情文本

## 导出的辅助组件与函数

### `SubAgentProvider`

由 `CtrlOToExpand.tsx` 导出的 React Context Provider。将子组件树标记为"子 Agent 环境"，使内部的 `CtrlOToExpand` 组件自动隐藏，避免在嵌套 Agent 输出中重复显示展开提示。

```tsx
<SubAgentProvider>
  {/* 内部的 CtrlOToExpand 不会渲染 */}
</SubAgentProvider>
```

> 源码位置：`src/components/CtrlOToExpand.tsx:14-28`

### `ctrlOToExpand()`（纯函数）

返回 chalk 格式化的 `(ctrl+o to expand)` 字符串，用于非 React 上下文（如纯文本拼接场景）。通过 `getShortcutDisplay()` 同步获取用户配置的快捷键。

> 源码位置：`src/components/CtrlOToExpand.tsx:47-50`

## 边界 Case 与注意事项

- **TagTabs 溢出处理**：当标签总宽度超过可用空间时，采用以选中标签为中心的滑动窗口策略，优先向左扩展再向右扩展。单个标签最大宽度限制为可用空间的一半（至少 20 字符）。溢出计数假设最多 99 个隐藏标签（`MAX_OVERFLOW_DIGITS = 2`）。
- **ClickableImageRef 双重降级**：当图片路径不存在或终端不支持超链接时，降级为纯样式 Text（无点击行为）。Link 组件本身也有 `fallback` 属性做进一步降级。
- **CtrlOToExpand 上下文抑制**：在 `SubAgentContext` 或 `InVirtualListContext` 为 true 时返回 null——这是为了避免在子 Agent 输出和虚拟滚动列表中出现大量重复的展开提示。
- **SandboxViolationExpandedView 平台限制**：Linux 平台或沙盒未启用时直接返回 null。违规记录只保留最近 10 条以避免内存和渲染开销。
- **ValidationErrorsList 的 dot-notation 路径处理**：使用 lodash `setWith(tree, path, value, Object)` 而非普通 `set`，是为了避免数字键被自动创建为数组。末尾的数组索引会被替换为对应的无效值以提升可读性。
- **formatTime 自实现**：SandboxViolationExpandedView 中手写了时间格式化函数而非使用 date-fns，注释明确说明是为了避免引入 39MB 依赖。
- **所有组件均使用 React Compiler 运行时**（`_c` 缓存），编译产物中的 `$[N]` 数组是自动生成的 memoization 缓存，无需手动维护。