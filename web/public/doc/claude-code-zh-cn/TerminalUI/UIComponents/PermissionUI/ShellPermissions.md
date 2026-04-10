# Shell 命令权限审批 UI 组（ShellPermissions）

## 概述与职责

ShellPermissions 是 PermissionUI 子系统中专门处理 **Shell 命令执行权限审批** 的 UI 组件集合。当 Claude Code 需要执行 Bash、PowerShell 或 sed 编辑命令时，这些组件负责向用户展示命令预览，并提供允许/拒绝/始终允许等操作选项。

在系统架构中，它位于 `TerminalUI > UIComponents > PermissionUI` 层级下，与 MessageRendering（消息渲染）、DesignSystem（设计系统）等同级模块协作。PermissionRequest 总路由组件根据工具类型将请求分发到这里的具体组件。

该模块包含以下核心部分：
- **BashPermissionRequest**：Bash 命令权限审批（最复杂，支持分类器自动审批、沙箱标识、sed 命令代理）
- **PowerShellPermissionRequest**：PowerShell 命令权限审批（Windows 平台，无沙箱支持）
- **SedEditPermissionRequest**：sed 编辑命令权限审批（以文件 diff 形式展示变更）
- **shellPermissionHelpers.tsx**：共享工具函数（建议标签生成）
- **useShellPermissionFeedback.ts**：统一反馈状态管理 Hook

## 关键流程

### Bash 命令权限审批流程

1. `BashPermissionRequest` 接收 `PermissionRequestProps`，从 `toolUseConfirm.input` 中解析出 `command` 和 `description`（`BashPermissionRequest.tsx:84-98`）
2. **sed 命令检测**：调用 `parseSedEditCommand(command)` 判断是否为 sed 编辑命令。若是，则代理给 `SedEditPermissionRequest`（`BashPermissionRequest.tsx:100-116`）
3. 非 sed 命令进入 `BashPermissionRequestInner`，依次初始化：
   - **权限解释器**：`usePermissionExplainerUI` 提供"为什么需要此权限"的 AI 解释
   - **反馈模式**：`useShellPermissionFeedback` 管理 Yes/No 输入模式切换和反馈文本
   - **可编辑前缀**：通过 `getSimpleCommandPrefix` / `getFirstWordPrefix` 同步提取命令前缀，再通过 `getCompoundCommandPrefixesStatic` 异步用 tree-sitter 精化（`BashPermissionRequest.tsx:219-254`）
   - **分类器检查**：若启用 `BASH_CLASSIFIER` 特性门控，跟踪分类器自动审批状态
   - **破坏性警告**：`getDestructiveCommandWarning` 检测危险命令并展示警告
   - **沙箱状态**：`SandboxManager.isSandboxingEnabled()` + `shouldUseSandbox()` 判断命令是否在沙箱中运行
4. 用户从选项列表中选择操作，`onSelect` 处理分支：
   - `yes`：直接允许，可附带反馈文本
   - `yes-apply-suggestions`：允许并应用后端生成的权限规则建议
   - `yes-prefix-edited`：允许并将用户编辑的前缀规则写入 `localSettings`
   - `yes-classifier-reviewed`（ANT-ONLY）：允许并将分类器描述写入 session 级规则
   - `no`：拒绝，可附带反馈文本

### PowerShell 命令权限审批流程

整体结构与 Bash 类似，但有以下关键差异：
- **无沙箱支持**：Windows 平台不支持沙箱隔离
- **无分类器选项**：`yes-classifier-reviewed` 是 Bash 专属的 ANT-ONLY 特性
- **无 sed 代理**：不需要检测 sed 命令
- 前缀提取使用 PowerShell 专用的 `getCompoundCommandPrefixesStatic`（from `utils/powershell/staticPrefix`），过滤器使用 `isAllowlistedCommand`

### SedEdit 权限审批流程

1. 从 `sedInfo.filePath` 异步读取目标文件内容（`SedEditPermissionRequest.tsx:42-51`）
2. 使用 `Suspense` 包裹内部组件等待文件读取完成
3. `SedEditPermissionRequestInner` 调用 `applySedSubstitution(oldContent, sedInfo)` 计算变更后内容（`SedEditPermissionRequest.tsx:108`）
4. 生成 diff 展示：若内容有变化，使用 `FileEditToolDiff` 渲染差异对比；若无变化，显示"Pattern did not match any content"
5. 将审批 UI 代理给 `FilePermissionDialog`（复用文件编辑权限的通用对话框），而非自己的 Select 组件

### 反馈模式交互流程（useShellPermissionFeedback）

1. 用户按 Tab 键在 Yes/No 选项上切换输入模式（`handleInputModeToggle`，`useShellPermissionFeedback.ts:51-80`）
2. 进入输入模式后，选项变为文本输入框，用户可输入反馈信息
3. 焦点切换时（`handleFocus`），若未输入文本则自动收起输入框（`useShellPermissionFeedback.ts:118-132`）
4. 拒绝时（`handleReject`），无反馈文本视为 ESC 退出，记录 escape 计数用于归因追踪（`useShellPermissionFeedback.ts:82-116`）

## 函数签名与参数说明

### `BashPermissionRequest(props: PermissionRequestProps): React.ReactNode`

Bash 命令权限审批入口组件。解析命令输入，检测 sed 命令并代理，否则渲染内部审批对话框。

> 源码位置：`src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:71-133`

### `PowerShellPermissionRequest(props: PermissionRequestProps): React.ReactNode`

PowerShell 命令权限审批组件。结构与 Bash 版本类似，但无沙箱和分类器支持。

> 源码位置：`src/components/permissions/PowerShellPermissionRequest/PowerShellPermissionRequest.tsx:22`

### `SedEditPermissionRequest(props: PermissionRequestProps & { sedInfo: SedEditInfo }): React.ReactNode`

sed 编辑命令权限审批组件。异步读取文件内容，展示 diff 预览，代理给 `FilePermissionDialog` 处理审批。

> 源码位置：`src/components/permissions/SedEditPermissionRequest/SedEditPermissionRequest.tsx:21-69`

### `bashToolUseOptions({...}): OptionWithDescription<BashToolUseOption>[]`

生成 Bash 权限对话框的操作选项列表。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| suggestions | `PermissionUpdate[]` | `[]` | 后端生成的权限规则建议 |
| decisionReason | `PermissionDecisionReason` | - | 权限决策原因（用于判断是否为分类器阻止） |
| onRejectFeedbackChange | `(value: string) => void` | - | 拒绝反馈文本变更回调 |
| onAcceptFeedbackChange | `(value: string) => void` | - | 接受反馈文本变更回调 |
| onClassifierDescriptionChange | `(value: string) => void` | - | 分类器描述编辑回调 |
| classifierDescription | `string` | - | 当前分类器生成的描述文本 |
| initialClassifierDescriptionEmpty | `boolean` | `false` | 初始描述是否为空（为空则隐藏分类器选项） |
| existingAllowDescriptions | `string[]` | `[]` | 已有的允许规则描述（去重用） |
| yesInputMode | `boolean` | `false` | Yes 选项是否处于文本输入模式 |
| noInputMode | `boolean` | `false` | No 选项是否处于文本输入模式 |
| editablePrefix | `string` | - | 可编辑的命令前缀规则（如 `npm run:*`） |
| onEditablePrefixChange | `(value: string) => void` | - | 前缀编辑回调 |

> 源码位置：`src/components/permissions/BashPermissionRequest/bashToolUseOptions.tsx:31-146`

### `powershellToolUseOptions({...}): OptionWithDescription<PowerShellToolUseOption>[]`

生成 PowerShell 权限对话框的操作选项列表。参数与 `bashToolUseOptions` 类似，但无 `classifierDescription`、`existingAllowDescriptions`、`decisionReason` 等分类器相关参数。

> 源码位置：`src/components/permissions/PowerShellPermissionRequest/powershellToolUseOptions.tsx:7-90`

### `generateShellSuggestionsLabel(suggestions, shellToolName, commandTransform?): ReactNode | null`

根据权限更新建议生成"始终允许"选项的显示标签。处理多种场景组合：纯命令规则、纯目录权限、纯 Read 规则、混合规则。

| 参数 | 类型 | 说明 |
|------|------|------|
| suggestions | `PermissionUpdate[]` | 权限更新建议列表 |
| shellToolName | `string` | Shell 工具名（`Bash` 或 `PowerShell`） |
| commandTransform | `(command: string) => string` | 可选的命令显示转换（Bash 用于去除输出重定向） |

> 源码位置：`src/components/permissions/shellPermissionHelpers.tsx:65-163`

### `useShellPermissionFeedback({...}): {...}`

Shell 权限对话框的统一反馈状态管理 Hook。

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| toolUseConfirm | `ToolUseConfirm` | 工具使用确认对象 |
| onDone | `() => void` | 完成回调 |
| onReject | `() => void` | 拒绝回调 |
| explainerVisible | `boolean` | 解释器是否可见 |

**返回值：**

| 字段 | 类型 | 说明 |
|------|------|------|
| yesInputMode | `boolean` | Yes 选项是否处于输入模式 |
| noInputMode | `boolean` | No 选项是否处于输入模式 |
| yesFeedbackModeEntered | `boolean` | 用户是否曾进入 Yes 反馈模式（持久化） |
| noFeedbackModeEntered | `boolean` | 用户是否曾进入 No 反馈模式（持久化） |
| acceptFeedback / rejectFeedback | `string` | 反馈文本 |
| focusedOption | `string` | 当前聚焦的选项 |
| handleInputModeToggle | `(option: string) => void` | Tab 键切换输入模式 |
| handleReject | `(feedback?: string) => void` | 处理拒绝操作 |
| handleFocus | `(value: string) => void` | 处理焦点变更 |

> 源码位置：`src/components/permissions/useShellPermissionFeedback.ts:16-148`

## 类型定义

### `BashToolUseOption`

```typescript
type BashToolUseOption = 'yes' | 'yes-apply-suggestions' | 'yes-prefix-edited' | 'yes-classifier-reviewed' | 'no';
```

Bash 权限对话框的选项值枚举。`yes-classifier-reviewed` 仅在 ANT-ONLY 构建中可用。

### `PowerShellToolUseOption`

```typescript
type PowerShellToolUseOption = 'yes' | 'yes-apply-suggestions' | 'yes-prefix-edited' | 'no';
```

PowerShell 权限对话框的选项值枚举。相比 Bash 少了 `yes-classifier-reviewed`。

## 边界 Case 与注意事项

- **复合命令前缀提取**：对于 `cd src && npm test` 这类复合命令，后端已通过 tree-sitter 拆分各子命令并逐一检查权限。当只有一个子命令需要审批规则时，用可编辑输入框展示；有多个规则时回退到 `yes-apply-suggestions` 一次性保存所有规则（`BashPermissionRequest.tsx:195-208`）。这解决了此前用户 settings.local.json 中积累 150+ 无效规则的问题。

- **分类器自动审批的 UI 反馈**：当 `BASH_CLASSIFIER` 特性启用且命令被自动审批时，对话框显示绿色勾号 `✓ Auto-approved` 和匹配的规则，所有选项变为 disabled 状态，用户可按 Esc 关闭（`BashPermissionRequest.tsx:427-434`）。

- **ClassifierCheckingSubtitle 性能优化**：分类器检查中的闪烁动画被提取为独立组件，避免 20fps 时钟重渲染整个对话框。此前动画与 535 行的 Inner 组件同体，且 React Compiler bailout 导致无法自动 memo 化，每次分类器检查重建 JSX 树 20-60 次（`BashPermissionRequest.tsx:36-70`）。

- **PowerShell 无沙箱**：Windows 平台不支持沙箱隔离，因此 PowerShell 权限对话框不展示沙箱相关选项或标题标注。

- **PowerShell 多行命令**：包含换行符的命令（如 `foreach` 循环）的 `editablePrefix` 初始化为 `undefined`，导致"不再询问"选项被隐藏。这是有意设计——统计数据显示 14 条多行规则中没有任何一条被二次匹配。

- **sed 编辑文件不存在**：当 sed 目标文件不存在时，`SedEditPermissionRequest` 捕获 `ENOENT` 错误，以空内容展示，并显示"File does not exist"消息（`SedEditPermissionRequest.tsx:70-78`）。

- **`shouldShowAlwaysAllowOptions()`** 控制门控：当 `allowManagedPermissionRulesOnly` 策略限制生效时，"始终允许"类选项不会展示，防止用户在受管环境下自行添加权限规则。

- **反馈模式的 escape 追踪**：拒绝时若无反馈文本（即用户按 ESC），会递增全局 `attribution.escapeCount` 计数器，用于行为归因分析（`useShellPermissionFeedback.ts:87-98`）。