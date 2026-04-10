# 权限规则管理 UI（PermissionRules）

## 概述与职责

权限规则管理 UI 是 Claude Code 终端界面中权限系统的核心交互模块，位于 `TerminalUI > UIComponents > PermissionUI` 层级下。它为用户提供了一个完整的权限规则管理界面，支持查看、搜索、添加和删除权限规则，以及管理工作区目录和查看被拒绝的权限请求历史。

在系统架构中，该模块属于 `PermissionUI` 子系统，与同级的 `PermissionRequest.tsx`（权限审批路由）等组件共同构成完整的权限交互体验。它依赖 `DesignSystem` 提供的 `Dialog`、`Pane`、`Tabs` 等基础 UI 组件，并通过 `src/utils/permissions/` 下的工具函数与底层权限数据模型交互。

## 模块组成

该模块由 8 个文件组成，核心组件是 `PermissionRuleList.tsx`（1178 行），其余为辅助组件：

| 文件 | 职责 |
|------|------|
| `PermissionRuleList.tsx` | 主组件，5 标签页权限管理面板 |
| `AddPermissionRules.tsx` | 添加规则的保存目标选择对话框 |
| `PermissionRuleInput.tsx` | 规则文本输入表单 |
| `PermissionRuleDescription.tsx` | 单条规则的人类可读描述渲染 |
| `WorkspaceTab.tsx` | 工作区目录列表标签页 |
| `AddWorkspaceDirectory.tsx` | 添加工作区目录对话框 |
| `RemoveWorkspaceDirectory.tsx` | 移除工作区目录确认对话框 |
| `RecentDenialsTab.tsx` | 最近被拒绝的权限请求历史标签页 |

## 关键流程

### 主界面渲染流程

`PermissionRuleList` 是整个模块的入口组件，它渲染一个包含 5 个标签页的 `Tabs` 面板（`src/components/permissions/rules/PermissionRuleList.tsx:1117`）：

1. **Recently denied**：展示自动模式分类器最近拒绝的命令（仅在有拒绝记录时作为默认标签页）
2. **Allow**：已允许的权限规则列表
3. **Ask**：需要每次确认的权限规则列表
4. **Deny**：已禁止的权限规则列表
5. **Workspace**：工作区目录配置

组件通过 `useAppState` 获取全局的 `toolPermissionContext`，并利用 `getAllowRules`、`getDenyRules`、`getAskRules` 分别提取三类规则，存储在 `Map<string, PermissionRule>` 中以 JSON 序列化键索引（`PermissionRuleList.tsx:541-575`）。

### 规则搜索与筛选流程

1. 用户在 Allow/Ask/Deny 标签页中按下 `/` 键或直接输入字符进入搜索模式（`PermissionRuleList.tsx:675-696`）
2. `useSearchInput` hook 管理搜索状态，`RulesTabContent` 组件展示搜索框
3. `getRulesOptions` 函数根据当前标签页和搜索关键词过滤规则列表，按规则字符串的字母序排序（`PermissionRuleList.tsx:577-636`）
4. 每个标签页顶部都有一个 `SearchBox` 组件，下方是 `Select` 列表展示匹配的规则

### 添加新规则流程

1. 用户在 Allow/Ask/Deny 标签页中选择 "Add a new rule..." 选项
2. `handleToolSelect` 设置 `addingRuleToTab` 状态，触发渲染 `PermissionRuleInput`（`PermissionRuleList.tsx:707-718`）
3. `PermissionRuleInput` 展示一个文本输入框，用户输入规则字符串（格式：`工具名` 或 `工具名(规则内容)`）（`PermissionRuleInput.tsx:19-100`）
4. 输入提交后，`permissionRuleValueFromString` 解析规则文本为 `PermissionRuleValue`
5. 进入 `AddPermissionRules` 组件，用户选择保存位置（`AddPermissionRules.tsx:48-150`）：
   - **Project settings (local)**：保存到 `.claude/settings.local.json`
   - **Project settings**：保存到 `.claude/settings.json`（会被提交到版本控制）
   - **User settings**：保存到 `~/.claude/settings.json`
6. 调用 `applyPermissionUpdate` 更新内存状态，`persistPermissionUpdate` 持久化到文件
7. 调用 `detectUnreachableRules` 检查新规则是否被已有规则遮蔽（shadowed），如有则显示警告

### 删除规则流程

1. 用户在规则列表中选择一条规则，触发 `RuleDetails` 组件渲染（`PermissionRuleList.tsx:75-253`）
2. 显示规则详情：规则内容、描述、来源
3. 如果规则来源是 `policySettings`（托管设置），显示"不可修改"提示，不提供删除选项
4. 否则显示确认删除对话框，用户选择 "Yes" 后调用 `deletePermissionRule` 执行删除（`PermissionRuleList.tsx:841-884`）
5. 删除后自动聚焦到相邻的规则，并记录变更信息

### 工作区目录管理流程

**添加目录**：
1. 在 Workspace 标签页选择 "Add directory..."
2. `AddWorkspaceDirectory` 展示目录路径输入框，支持路径自动补全（通过 `getDirectoryCompletions`，防抖 100ms）（`AddWorkspaceDirectory.tsx:137-200`）
3. 也可直接传入 `directoryPath` 跳过输入步骤，显示三个选项：仅本次会话 / 保存到本地设置 / 取消
4. 选择后调用 `applyPermissionUpdate` 添加目录

**移除目录**：
1. 选择已有目录触发 `RemoveWorkspaceDirectory` 对话框（`RemoveWorkspaceDirectory.tsx:16-109`）
2. 确认后调用 `applyPermissionUpdate` 以 `removeDirectories` 类型更新，目标为 `session`
3. 移除后 Claude Code 不再有权访问该目录下的文件

### 最近拒绝记录流程

`RecentDenialsTab` 展示自动模式分类器最近拒绝的命令列表（`RecentDenialsTab.tsx:19-197`）：

1. 通过 `getAutoModeDenials()` 获取拒绝记录
2. 每条记录可以被切换为"批准"或"重试"状态
3. 按 Enter 键切换批准状态（`StatusIcon` 显示绿勾/红叉）
4. 按 `r` 键标记为重试（同时自动批准）
5. 退出时，如有重试标记的命令，触发 `onRetryDenials` 回调通知父组件重新执行这些命令

## 函数签名与参数说明

### `PermissionRuleList`

```typescript
function PermissionRuleList({
  onExit,
  initialTab?,
  onRetryDenials?,
}: Props): React.ReactNode
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `onExit` | `(result?: string, options?) => void` | 退出回调，传递变更摘要文本 |
| `initialTab` | `TabType` | 初始选中标签页，默认根据是否有拒绝记录决定 |
| `onRetryDenials` | `(commands: string[]) => void` | 重试被拒绝命令的回调 |

### `AddPermissionRules`

```typescript
function AddPermissionRules({
  onAddRules, onCancel, ruleValues, ruleBehavior,
  initialContext, setToolPermissionContext,
}: Props): React.ReactNode
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `onAddRules` | `(rules, unreachable?) => void` | 规则添加成功回调，附带遮蔽检测结果 |
| `ruleValues` | `PermissionRuleValue[]` | 待添加的规则值列表 |
| `ruleBehavior` | `PermissionBehavior` | 规则行为类型：`allow` / `ask` / `deny` |
| `initialContext` | `ToolPermissionContext` | 当前权限上下文 |
| `setToolPermissionContext` | `(ctx) => void` | 更新全局权限上下文 |

### `PermissionRuleInput`

```typescript
function PermissionRuleInput({
  onCancel, onSubmit, ruleBehavior,
}: PermissionRuleInputProps): React.ReactNode
```

用户输入规则字符串，格式为 `工具名` 或 `工具名(规则内容)`。例如 `WebFetch` 或 `Bash(ls:*)`。

### `AddWorkspaceDirectory`

```typescript
function AddWorkspaceDirectory({
  onAddDirectory, onCancel, permissionContext, directoryPath?,
}: Props): React.ReactNode
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `onAddDirectory` | `(path, remember?) => void` | 添加目录回调，`remember` 表示是否持久化 |
| `directoryPath` | `string` | 预填路径，提供时跳过输入步骤直接显示选项 |

### `RemoveWorkspaceDirectory`

```typescript
function RemoveWorkspaceDirectory({
  directoryPath, onRemove, onCancel,
  permissionContext, setPermissionContext,
}: Props): React.ReactNode
```

确认移除指定目录，移除操作目标固定为 `session` 作用域。

## 接口与类型定义

### `TabType`

```typescript
type TabType = 'recent' | 'allow' | 'ask' | 'deny' | 'workspace'
```

5 个标签页的标识符。

### `PermissionRuleValue`（外部类型）

规则值的核心数据结构，包含 `toolName`（工具名称）和可选的 `ruleContent`（规则内容限定）。

### `PermissionBehavior`（外部类型）

规则行为枚举：`'allow'` | `'ask'` | `'deny'`。

### `RememberDirectoryOption`（`AddWorkspaceDirectory` 内部）

```typescript
type RememberDirectoryOption = 'yes-session' | 'yes-remember' | 'no'
```

添加目录时的保存选项。

### `DirectoryItem`（`WorkspaceTab` 内部）

```typescript
type DirectoryItem = {
  path: string
  isCurrent: boolean
  isDeletable: boolean
}
```

工作区目录列表项的数据结构。

## 关键设计决策

### React Compiler 优化

所有组件都使用了 React Compiler 的 `_c()` memoization 运行时。每个组件内部大量使用 `$[n]` 缓存数组进行细粒度的 memo 优化，避免不必要的重渲染。这是编译期自动生成的代码，不是手工编写。

### 规则遮蔽检测

添加新规则时会调用 `detectUnreachableRules` 检查规则冲突（`AddPermissionRules.tsx:94-98`）。检测结果区分两种遮蔽类型：
- `deny` 类型的遮蔽标记为 "blocked"
- 其他类型标记为 "shadowed"

每种遮蔽都附带原因（`reason`）和修复建议（`fix`），以 chalk 黄色警告形式展示。

### 托管策略规则不可编辑

来源为 `policySettings` 的规则由系统管理员通过托管设置配置，用户界面仅展示详情而不提供删除按钮（`PermissionRuleList.tsx:146-178`），并提示"联系系统管理员"。

### 退出时的变更汇总

组件维护一个 `changes` 数组记录本次会话中的所有操作。退出时将变更汇总为文本传递给 `onExit` 回调，最终显示在终端中。对于最近拒绝记录的处理，重试操作优先于批准操作——如有重试标记会触发 `shouldQuery: true` 让引擎重新执行被拒绝的命令。

## 边界 Case 与注意事项

- **无拒绝记录时**：默认标签页为 "Allow" 而非 "Recently denied"，后者仍可导航到但显示空状态提示
- **搜索模式的键盘冲突处理**：`j`/`k`/`m`/`i`/`r`/空格 等键不会触发搜索模式，因为它们是列表导航或操作的快捷键（`PermissionRuleList.tsx:690`）
- **沙盒模式对规则检测的影响**：`AddPermissionRules` 在检测遮蔽规则时会考虑沙盒的 `autoAllowBash` 设置（`AddPermissionRules.tsx:93-94`）
- **工作区目录移除的作用域**：移除操作固定为 `session` 作用域，不会修改持久化的设置文件
- **目录路径自动补全**：`AddWorkspaceDirectory` 使用 `getDirectoryCompletions` 并以 100ms 防抖，建议列表通过 `PromptInputFooterSuggestions` 展示在输入框下方