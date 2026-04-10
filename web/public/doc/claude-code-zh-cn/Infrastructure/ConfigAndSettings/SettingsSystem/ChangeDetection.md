# 设置文件变更检测与响应子系统（ChangeDetection）

## 概述与职责

ChangeDetection 是 SettingsSystem 中的文件变更检测与响应子系统，位于 `Infrastructure > ConfigAndSettings > SettingsSystem` 层级之下。它负责**实时监听所有设置文件的变更，并将变更传播到应用状态中**，确保运行中的 Claude Code 会话始终使用最新的设置。

该子系统由三个文件组成，职责清晰：

| 文件 | 行数 | 职责 |
|------|------|------|
| `changeDetector.ts` | ~489 行 | 核心监听器，使用 chokidar 监控文件系统，轮询 MDM 设置，通过 signal 通知订阅者 |
| `internalWrites.ts` | ~38 行 | 时间戳 Map，区分内部写入与外部变更，防止自身写入触发二次处理 |
| `applySettingsChange.ts` | ~93 行 | 变更响应器，重新加载设置并同步权限规则和 Hook 配置到 AppState |

同级兄弟模块包括 SettingsSystem 下的设置加载（`settings.ts`）、缓存管理（`settingsCache.ts`）、校验（`validation.ts`）、类型定义（`types.ts`）等。

## 关键流程

### 1. 初始化流程

`initialize()` 是整个子系统的入口（`changeDetector.ts:84-146`）：

1. **前置守卫**：检查是否为远程模式（`getIsRemoteMode()`），以及是否已初始化或已销毁——三者任一为真则直接返回
2. **启动 MDM 轮询**：调用 `startMdmPoll()` 开始定期检查注册表/plist 设置
3. **注册清理回调**：通过 `registerCleanup(dispose)` 确保进程退出时正确释放资源
4. **收集监听目标**：调用 `getWatchTargets()` 获取需要监听的目录、设置文件路径集合和 drop-in 目录
5. **创建 chokidar watcher**：以目录列表为监听目标，配置 `awaitWriteFinish` 防抖、`depth: 0` 只监听直接子文件、自定义 `ignored` 过滤器
6. **绑定事件处理器**：`change` → `handleChange`，`unlink` → `handleDelete`，`add` → `handleAdd`

### 2. 文件变更处理流程

当检测到设置文件变更时（`handleChange`，`changeDetector.ts:268-302`）：

1. **路径解析**：通过 `getSourceForPath()` 将文件路径映射为 `SettingSource`（如 `userSettings`、`projectSettings`、`policySettings` 等）
2. **取消挂起的删除**：如果该路径有待处理的删除定时器（delete-recreate 模式），取消它
3. **内部写入过滤**：调用 `consumeInternalWrite(path, 5000)` 检查该变更是否由 Claude Code 自身写入引起——如果是，直接跳过
4. **执行 ConfigChange Hook**：调用 `executeConfigChangeHooks()` 通知 Hook 系统，如果任何 Hook 返回阻断（exit code 2 或 `decision: 'block'`），则不应用变更
5. **广播通知**：调用 `fanOut(source)` 重置设置缓存并通过 signal 通知所有订阅者

### 3. 删除宽限期机制

文件删除使用宽限期模式处理（`handleDelete`，`changeDetector.ts:330-360`），以应对常见的 **delete-and-recreate** 模式（如自动更新、另一个会话启动）：

1. 检测到删除后，**不立即处理**，而是启动一个延迟定时器（`DELETION_GRACE_MS` ≈ 1700ms）
2. 如果在宽限期内收到 `add` 或 `change` 事件（文件被重建），则取消删除定时器，按正常变更处理
3. 宽限期结束后仍未重建，才执行 Hook 检查和 `fanOut` 通知

宽限期计算公式：`DELETION_GRACE_MS = FILE_STABILITY_THRESHOLD_MS(1000) + FILE_STABILITY_POLL_INTERVAL_MS(500) + 200 = 1700ms`，确保宽限期超过 chokidar 的 `awaitWriteFinish` 延迟。

### 4. MDM 轮询机制

MDM（Mobile Device Management）设置存储在系统注册表或 plist 中，无法通过文件系统事件监听，因此采用**轮询**方式（`startMdmPoll`，`changeDetector.ts:381-418`）：

1. 初始化时捕获 MDM 和 HKCU 设置的 JSON 快照
2. 每 **30 分钟**执行一次 `refreshMdmSettings()` 获取最新值
3. 将新快照与上一次快照进行字符串比较，如果不同则更新缓存并调用 `fanOut('policySettings')`
4. 定时器使用 `.unref()` 防止阻止进程退出

### 5. 内部写入过滤机制

`internalWrites.ts` 通过一个简单的 `Map<string, number>`（路径 → 时间戳）实现内部写入标记：

- **标记写入**：`markInternalWrite(path)` 在 Claude Code 自身写入设置文件前调用，记录当前时间戳（`internalWrites.ts:17-19`）
- **消费标记**：`consumeInternalWrite(path, windowMs)` 在检测到变更时调用，如果标记存在且在 5 秒窗口内，返回 `true` 并**删除标记**（一次性消费，避免抑制后续真实外部变更）（`internalWrites.ts:26-33`）
- **设计动机**：该模块从 `changeDetector.ts` 中抽出，是为了打破 `settings.ts → changeDetector.ts → hooks.ts → … → settings.ts` 的循环依赖

### 6. 设置变更应用流程

`applySettingsChange()` 是变更的最终消费者（`applySettingsChange.ts:33-92`）：

1. 调用 `getInitialSettings()` 从磁盘重新读取设置（此时缓存已被 `fanOut` 重置，读取的是最新数据）
2. 调用 `loadAllPermissionRulesFromDisk()` 重新加载权限规则
3. 调用 `updateHooksConfigSnapshot()` 刷新 Hook 配置快照
4. 通过 `setAppState` 更新应用状态：
   - 使用 `syncPermissionRulesFromDisk()` 同步权限上下文
   - 对 Ant 用户移除过于宽泛的 Bash 权限（`applySettingsChange.ts:51-59`）
   - 检查并处理 bypass permissions 模式禁用状态
   - 执行 plan/auto 模式转换
   - 仅在 `effortLevel` 确实发生变化且新值非 `undefined` 时才更新 `effortValue`，避免覆盖 CLI `--effort` 标志

## 函数签名与参数说明

### changeDetector.ts 导出 API

#### `initialize(): Promise<void>`
初始化文件监听系统。远程模式下为空操作，重复调用安全。

#### `dispose(): Promise<void>`
销毁 watcher、清理所有定时器和订阅。返回的 Promise 在 chokidar 的 `close()` 完成后 resolve——测试中需要 await 以避免 ENOENT。

#### `subscribe: Signal<[source: SettingSource]>['subscribe']`
订阅设置变更通知。回调接收触发变更的 `SettingSource` 参数。

#### `notifyChange(source: SettingSource): void`
手动触发变更通知，用于不涉及文件系统的编程式变更（如远程托管设置刷新）。

#### `resetForTesting(overrides?): Promise<void>`
测试专用，重置内部状态允许重新初始化，可注入时间常量覆盖以加速测试。

### internalWrites.ts 导出 API

#### `markInternalWrite(path: string): void`
标记指定路径即将发生内部写入。调用方需传入已解析的绝对路径。

#### `consumeInternalWrite(path: string, windowMs: number): boolean`
检查路径是否在 `windowMs` 时间窗口内被标记为内部写入。匹配时消费标记并返回 `true`。

#### `clearInternalWrites(): void`
清空所有内部写入标记。在 `dispose()` 时调用。

### applySettingsChange.ts 导出 API

#### `applySettingsChange(source: SettingSource, setAppState: (f: (prev: AppState) => AppState) => void): void`
将设置变更应用到应用状态。重新加载设置、权限规则和 Hook 配置，然后通过 `setAppState` 回调更新 `AppState`。

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|------|------|
| `FILE_STABILITY_THRESHOLD_MS` | 1000ms | 文件写入稳定阈值，chokidar `awaitWriteFinish` 参数 |
| `FILE_STABILITY_POLL_INTERVAL_MS` | 500ms | 文件稳定性检查轮询间隔 |
| `INTERNAL_WRITE_WINDOW_MS` | 5000ms | 内部写入标记有效窗口 |
| `MDM_POLL_INTERVAL_MS` | 30 分钟 | MDM 注册表/plist 轮询间隔 |
| `DELETION_GRACE_MS` | ~1700ms | 删除宽限期（计算值：1000 + 500 + 200） |

所有常量支持通过 `resetForTesting(overrides)` 在测试中覆盖。

## 监听范围

`getWatchTargets()`（`changeDetector.ts:180-250`）收集监听目标：

- 遍历 `SETTING_SOURCES` 中的所有来源（跳过 `flagSettings`——它来自 CLI 不会运行时变化，且可能指向包含特殊文件的 `$TMPDIR`）
- 对每个来源获取设置文件路径，按目录去重
- **只监听包含至少一个已存在文件的目录**，但会注册该目录下所有潜在设置文件路径（支持检测初始化后新创建的文件）
- 额外监听 `managed-settings.d/` drop-in 目录中的 `.json` 文件，映射为 `policySettings` 来源

chokidar 的 `ignored` 过滤器确保只处理已知设置文件和 drop-in 目录中的 JSON 文件，忽略 `.git` 目录和特殊文件类型（sockets、FIFOs 等）。

## 缓存重置策略

`fanOut()` 函数（`changeDetector.ts:437-440`）是唯一的缓存重置点——在通知订阅者**之前**调用 `resetSettingsCache()`。这种集中式设计避免了多订阅者场景下的缓存抖动：如果 N 个订阅者各自重置缓存，会导致 N 次磁盘读取；集中重置后，第一个订阅者读取时填充缓存，后续订阅者直接命中。

## 边界 Case 与注意事项

- **远程模式**：`initialize()` 在远程模式下直接返回，不启动任何监听——远程模式的设置由宿主管理
- **delete-and-recreate 模式**：编辑器保存、自动更新等场景常采用先删除再创建的方式写入文件，宽限期机制确保不会误报为设置被删除
- **Hook 阻断**：ConfigChange Hook 可以阻止变更被应用（返回 exit code 2 或 `block` decision），提供了外部控制设置变更的能力
- **循环依赖规避**：`internalWrites.ts` 被单独抽取为无依赖模块，打破 `settings.ts` 和 `changeDetector.ts` 之间的循环引用链
- **Ant 用户特殊逻辑**：`applySettingsChange` 中对 `USER_TYPE === 'ant'` 且非 `local-agent` 入口的场景，会额外移除过于宽泛的 Bash 权限规则（`applySettingsChange.ts:51-59`）
- **effortLevel 保守传播**：仅在设置值确实变化且新值非 `undefined` 时才更新 `effortValue`，避免覆盖通过 `--effort` CLI 标志设定的会话级值（`applySettingsChange.ts:74-89`）
- **定时器不阻塞退出**：MDM 轮询定时器使用 `.unref()` 确保不阻止 Node.js 进程退出