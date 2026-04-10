# 配置管理与插件集成 Hooks

## 概述与职责

本模块是 **TerminalUI → Hooks** 层中负责**配置管理**和**插件集成**的一组 React 自定义 Hooks。它们为 REPL 主界面提供以下能力：

- **动态配置**：从远程（Growthbook）获取特性开关和配置值
- **用户设置**：响应式读取和监听设置文件变化
- **插件全生命周期**：加载、安装推荐、合并 MCP 资源、刷新通知
- **技能管理**：监听技能文件变化并刷新命令列表，管理技能改进调查
- **API 密钥校验**：验证 Anthropic API 密钥的有效性

在系统架构中，这些 Hooks 位于 UI 组件（Screens/UIComponents）和后端服务层（Services、SkillsAndPlugins）之间，起到**桥接**作用——将服务层的异步数据源转换为 React 组件可消费的响应式状态。同级模块还包括输入处理 Hooks（useTextInput 等）、IDE 集成 Hooks、远程会话 Hooks 等。

---

## 配置与设置

### `useDynamicConfig<T>(configName, defaultValue): T`

从 Growthbook 远程获取动态特性配置的泛型 Hook。

- 初始返回 `defaultValue`，待远程配置拉取完成后自动更新为远端值
- 内部调用 `getDynamicConfig_BLOCKS_ON_INIT()`，该函数会阻塞等待 Growthbook 初始化完成
- 测试环境下（`NODE_ENV === 'test'`）跳过远程拉取，避免测试挂起

> 源码位置：`src/hooks/useDynamicConfig.ts:8-22`

### `useSettings(): ReadonlySettings`

从 AppState 中响应式读取当前用户设置。

```typescript
export type ReadonlySettings = AppState['settings']
```

- 基于 Zustand 的 `useAppState` 选择器实现，设置变化时自动触发组件重渲染
- 设置文件在磁盘上的变化由 `settingsChangeDetector` 检测并同步到 AppState
- 应在 React 组件中替代 `getSettings_DEPRECATED()` 使用

> 源码位置：`src/hooks/useSettings.ts:15-17`

### `useSettingsChange(onChange): void`

监听设置文件变化事件，在变化时调用回调。

- **参数**：`onChange(source: SettingSource, settings: SettingsJson)` — 接收变化来源和最新设置
- 订阅 `settingsChangeDetector` 的变化通知，在回调中读取最新设置并传递给消费者
- 注意：缓存已由 `changeDetector.fanOut` 重置，此处不再重复清除以避免多订阅者间的 N-way 缓存竞争

> 源码位置：`src/hooks/useSettingsChange.ts:7-25`

---

## 插件管理

### `useManagePlugins({ enabled? }): void`

插件系统的核心管理 Hook（304 行），负责**初始加载**和**变更通知**两个职责。

#### 初始加载流程（挂载时执行一次）

1. 调用 `loadAllPlugins()` 加载所有插件，得到 `{ enabled, disabled, errors }`
2. 调用 `detectAndUninstallDelistedPlugins()` 自动卸载已下架插件
3. 检查 `getFlaggedPlugins()`，有标记插件时弹出 warning 通知
4. 依次加载插件的各类资源，每步独立 try-catch：
   - `getPluginCommands()` → 命令
   - `loadPluginAgents()` → Agent 定义
   - `loadPluginHooks()` → 钩子
5. 遍历 enabled 插件加载 MCP 和 LSP 服务器配置，统计数量
6. 调用 `reinitializeLspServerManager()` 重新初始化 LSP
7. 将 `enabled`、`disabled`、`commands`、合并后的 `errors` 写入 AppState
8. 发送 `tengu_plugins_loaded` 遥测事件，包含各类资源计数

#### 变更通知（非自动刷新）

当 `AppState.plugins.needsRefresh` 为 `true` 时，仅弹出通知提示用户执行 `/reload-plugins`。**不会自动刷新**——所有后续刷新统一走 `refreshActivePlugins()` 路径，避免之前自动刷新的缓存不一致 bug。

#### 错误处理策略

- 各资源加载独立 catch，错误归入 `errors` 数组供 Doctor UI 展示
- AppState 更新时合并保留已有 LSP 错误（`source === 'lsp-manager'`），避免覆盖
- 顶层 catch 设置空状态并记录错误

> 源码位置：`src/hooks/useManagePlugins.ts:37-304`

---

## 插件推荐

### `usePluginRecommendationBase<T>()`

插件推荐的**共享状态机**，为 LSP 推荐等具体推荐源提供统一的门控和异步保护。

**返回值**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `recommendation` | `T \| null` | 当前推荐 |
| `clearRecommendation` | `() => void` | 清除推荐（清除后 `tryResolve` 会获得新 identity，触发重新解析） |
| `tryResolve` | `(resolve: () => Promise<T \| null>) => void` | 在 useEffect 中调用，执行实际解析逻辑 |

**门控链**（按顺序短路）：
1. 远程模式 → 跳过（`getIsRemoteMode()`）
2. 已有推荐 → 跳过
3. 正在检查中（`isCheckingRef`）→ 跳过

> 源码位置：`src/hooks/usePluginRecommendationBase.tsx:24-77`

### `installPluginAndNotify(pluginId, pluginName, keyPrefix, addNotification, install)`

插件安装 + 通知的异步辅助函数。

1. 通过 `getPluginById()` 从 marketplace 查找插件数据
2. 调用传入的 `install(pluginData)` 执行实际安装
3. 成功时显示 "✓ {name} installed · restart to apply"，失败时显示错误通知
4. 通知均设置 5 秒超时自动消失

> 源码位置：`src/hooks/usePluginRecommendationBase.tsx:80-104`

### `useLspPluginRecommendation(): UseLspPluginRecommendationResult`

基于 LSP 的插件推荐 Hook，监听文件编辑事件并推荐匹配的 LSP 插件。

**触发条件**（全部满足）：
- 文件扩展名匹配某个 LSP 插件
- 对应 LSP 二进制已安装在系统上
- 插件尚未安装
- 用户未禁用推荐
- 本次会话尚未展示过推荐（`hasShownLspRecommendationThisSession`）

**推荐状态类型**：

```typescript
type LspRecommendationState = {
  pluginId: string
  pluginName: string
  pluginDescription?: string
  fileExtension: string
  shownAt: number  // 用于超时检测
} | null
```

**用户响应处理**（`handleResponse`）：

| 响应 | 行为 |
|------|------|
| `'yes'` | 调用 `installPluginAndNotify` 安装插件，注册到用户设置 |
| `'no'` | 如果展示时长 ≥ 28 秒，视为超时而非主动拒绝，递增忽略计数 |
| `'never'` | 将该插件加入 never-suggest 列表 |
| `'disable'` | 全局禁用 LSP 推荐功能 |

> 源码位置：`src/hooks/useLspPluginRecommendation.tsx:41-159`

---

## MCP 资源合并

这三个 Hook 负责将来自不同来源的 MCP 资源（初始化时传入的 + 运行时动态发现的）合并为统一注册表，供查询引擎使用。均使用 `lodash-es/uniqBy` 按 `name` 去重，且初始资源优先。

### `useMergedClients(initialClients, mcpClients): MCPServerConnection[]`

合并 MCP 服务器连接。还导出纯函数 `mergeClients()` 供非 React 上下文使用。

- 当 `mcpClients` 非空时合并两个数组并按 `name` 去重
- 否则直接返回 `initialClients`（或空数组）

> 源码位置：`src/hooks/useMergedClients.ts:5-23`

### `useMergedCommands(initialCommands, mcpCommands): Command[]`

合并命令列表，逻辑与 `useMergedClients` 一致——按 `name` 去重，MCP 命令非空时才执行合并。

> 源码位置：`src/hooks/useMergedCommands.ts:5-15`

### `useMergedTools(initialTools, mcpTools, toolPermissionContext): Tools`

合并工具注册表，逻辑较前两者复杂：

1. 调用 `assembleToolPool(toolPermissionContext, mcpTools)` 组装完整工具池——包含 `getTools()` 内置工具 + MCP deny-rule 过滤 + 去重 + MCP CLI 排除
2. 调用 `mergeAndFilterTools(initialTools, assembled, mode)` 将初始工具与组装结果合并

`assembleToolPool` 是 REPL 和 `runAgent` 共用的纯函数，确保两者使用相同的工具解析逻辑。

> 源码位置：`src/hooks/useMergedTools.ts:20-44`

---

## 技能管理

### `useSkillsChange(cwd, onCommandsChange): void`

保持命令列表在两种触发源下保持最新：

1. **技能文件变化**（文件监视器）：订阅 `skillChangeDetector`，触发时完全清除命令缓存（`clearCommandsCache()`）并重新从磁盘扫描
2. **GrowthBook 初始化/刷新**：订阅 `onGrowthBookRefresh`，仅清除 memoization 缓存（`clearCommandMemoizationCaches()`）后重新过滤。这处理了命令的特性门控依赖远程 flag 的场景——`getCommands()` 可能在 GrowthBook 初始化前执行，导致 memoized 列表使用了默认值

两种触发都是非致命的——加载错误仅被记录，不中断运行。

> 源码位置：`src/hooks/useSkillsChange.ts:24-62`

### `useSkillImprovementSurvey(setMessages)`

管理技能改进调查问卷的 UI 状态和用户交互。

**返回值**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `isOpen` | `boolean` | 问卷是否显示 |
| `suggestion` | `SkillImprovementSuggestion \| null` | 当前改进建议（包含 `skillName` 和 `updates` 数组） |
| `handleSelect` | `(selected: FeedbackSurveyResponse) => void` | 处理用户选择 |

**关键流程**：

1. 监听 `AppState.skillImprovement.suggestion`，有新建议时自动打开问卷
2. 使用 `lastSuggestionRef` 保持建议引用，即使 AppState 被清除后仍可展示
3. 用户响应 `handleSelect`：
   - 非 `'dismissed'`：调用 `applySkillImprovement()` 应用改进，完成后向消息列表插入系统消息
   - `'dismissed'`：仅关闭并记录
4. 每次交互都发送 `tengu_skill_improvement_survey` 遥测事件（包含 `event_type` 和 `_PROTO_skill_name`）

> 源码位置：`src/hooks/useSkillImprovementSurvey.ts:21-105`

---

## API 密钥验证

### `useApiKeyVerification(): ApiKeyVerificationResult`

验证 Anthropic API 密钥有效性的 Hook。

**状态类型**：

```typescript
type VerificationStatus = 'loading' | 'valid' | 'invalid' | 'missing' | 'error'
```

**返回值**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | `VerificationStatus` | 当前验证状态 |
| `reverify` | `() => Promise<void>` | 手动触发重新验证 |
| `error` | `Error \| null` | 错误详情（状态为 `'error'` 时） |

**初始化逻辑**（`useState` 惰性初始化）：

1. 如果 Anthropic Auth 未启用或是 Claude AI 订阅用户 → `'valid'`
2. 尝试获取 API Key（跳过 `apiKeyHelper` 执行，避免信任对话框之前的 RCE 风险）
3. 有 key 或配置了 `apiKeyHelper` → `'loading'`（等待后续验证）
4. 否则 → `'missing'`

**`reverify` 验证流程**：

1. 同上跳过检查
2. 预热 `apiKeyHelper` 缓存（`getApiKeyFromApiKeyHelper`）
3. 读取 API Key，无 key 则根据来源设为 `'missing'` 或 `'error'`
4. 调用 `verifyApiKey(apiKey, false)` 向 API 发起验证请求
5. 验证通过 → `'valid'`，被拒 → `'invalid'`，异常 → `'error'`（同时保存 error 对象供 UI 展示）

> 源码位置：`src/hooks/useApiKeyVerification.ts:24-84`

---

## 边界 Case 与注意事项

- **`useManagePlugins` 不会自动刷新**：当插件状态变化时仅弹出通知，用户需手动执行 `/reload-plugins`。这是有意为之——之前的自动刷新存在缓存不一致 bug（下游 memoized loader 返回旧数据）
- **LSP 推荐每会话仅一次**：通过 `hasShownLspRecommendationThisSession()` 全局标记控制，避免频繁打扰
- **超时 vs 主动拒绝**：LSP 推荐菜单 30 秒自动消失，Hook 使用 28 秒阈值区分超时和用户主动点击"否"，两者走不同的统计路径
- **API Key 安全**：初始化时故意跳过 `apiKeyHelper` 执行（`skipRetrievingKeyFromApiKeyHelper: true`），防止在信任对话框展示前通过 `settings.json` 注入命令导致 RCE
- **`useMergedTools` 的双重来源**：工具池由 `assembleToolPool`（共享纯函数）统一组装，确保 REPL 和 `runAgent` 使用相同的工具解析逻辑