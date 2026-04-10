# AutoDream —— 后台记忆巩固服务

## 概述与职责

AutoDream 是 Claude Code 的后台记忆巩固服务，属于 **Services → AssistantFeatures** 层级下的辅助功能模块。它的核心职责是：在用户正常使用 Claude Code 的过程中，**自动检测是否积累了足够的历史会话**，如果满足条件，就在后台静默启动一个 forked agent 执行"梦境"——对历史会话进行反思性整理，将有价值的信息写入持久化记忆系统。

与同级的其他 AssistantFeatures（语音输入、提示建议、MagicDocs 等）不同，AutoDream 完全在后台运行，用户不感知触发过程，仅在巩固完成后看到"Improved N memories"的通知。

该模块由 4 个文件组成：
- `config.ts` —— 功能开关
- `consolidationLock.ts` —— 文件锁与时间戳管理
- `consolidationPrompt.ts` —— 巩固提示模板
- `autoDream.ts` —— 主编排逻辑

## 关键流程

### 触发门控链（按成本递增排列）

AutoDream 的触发检查在每次 REPL 轮次结束时（通过 `stopHooks`）执行。门控按**从廉价到昂贵**的顺序依次检查，任一不满足即提前返回：

1. **功能开关门控**（`isGateOpen()`）：检查 KAIROS 模式未激活、非远程模式、自动记忆已启用、且 AutoDream 已启用（`src/services/autoDream/autoDream.ts:95-100`）
2. **时间门控**：读取锁文件的 `mtime`（即上次巩固时间），计算距今小时数，不足 `minHours`（默认 24h）则跳过（`src/services/autoDream/autoDream.ts:131-141`）
3. **扫描节流**：时间门控通过但会话门控未通过时，会反复触发扫描。通过 `SESSION_SCAN_INTERVAL_MS`（10 分钟）节流，避免每轮都执行目录扫描（`src/services/autoDream/autoDream.ts:143-150`）
4. **会话数门控**：扫描 `mtime > lastConsolidatedAt` 的会话文件（排除当前会话），不足 `minSessions`（默认 5 个）则跳过（`src/services/autoDream/autoDream.ts:153-171`）
5. **锁门控**：尝试获取文件锁，防止多进程并发执行巩固（`src/services/autoDream/autoDream.ts:177-190`）

### 巩固执行流程

所有门控通过后，执行以下流程：

1. **注册 DreamTask**：在应用状态中注册任务，UI 可展示进度（`src/services/autoDream/autoDream.ts:204-208`）
2. **构建提示**：调用 `buildConsolidationPrompt()` 生成四阶段提示（Orient → Gather → Consolidate → Prune），附加工具约束说明和待审查的会话列表（`src/services/autoDream/autoDream.ts:211-222`）
3. **启动 forked agent**：通过 `runForkedAgent()` 在后台运行，Bash 工具被限制为只读命令，文件写入权限通过 `createAutoMemCanUseTool()` 限定在记忆目录内（`src/services/autoDream/autoDream.ts:224-233`）
4. **进度追踪**：`makeDreamProgressWatcher` 监听 agent 的每个 assistant 消息，提取文本摘要、统计工具调用次数、收集被编辑/写入的文件路径（`src/services/autoDream/autoDream.ts:281-312`）
5. **完成处理**：任务标记完成，如果有文件被修改则在主会话中追加"Improved N memories"系统消息，记录遥测事件（`src/services/autoDream/autoDream.ts:235-257`）

### 失败与回滚

- **agent 执行失败**：回滚锁文件 mtime 到获取前的值，这样时间门控会再次通过，但受扫描节流约束不会立即重试（`src/services/autoDream/autoDream.ts:258-271`）
- **用户手动终止**：通过 `abortController` 信号检测，DreamTask 的 kill 逻辑已处理锁回滚，不再重复操作（`src/services/autoDream/autoDream.ts:262-265`）

## 函数签名与参数说明

### `initAutoDream(): void`

初始化 AutoDream 服务。创建闭包作用域的内部状态（`lastSessionScanAt`），注册 `runner` 函数。启动时调用一次（或测试中每个 `beforeEach` 调用以获得干净状态）。

> 源码位置：`src/services/autoDream/autoDream.ts:122-273`

### `executeAutoDream(context: REPLHookContext, appendSystemMessage?: AppendSystemMessageFn): Promise<void>`

外部入口，由 `stopHooks` 在每轮结束时调用。如果 `initAutoDream()` 尚未调用则为空操作。单轮成本：一次 GrowthBook 缓存读取 + 一次 `stat` 系统调用。

> 源码位置：`src/services/autoDream/autoDream.ts:319-324`

### `isAutoDreamEnabled(): boolean`

检查功能是否启用。优先读取用户设置 `settings.json` 中的 `autoDreamEnabled` 字段；未显式设置时回退到 GrowthBook 特性标志 `tengu_onyx_plover` 的 `enabled` 字段。

> 源码位置：`src/services/autoDream/config.ts:13-21`

### `buildConsolidationPrompt(memoryRoot: string, transcriptDir: string, extra: string): string`

构建巩固提示模板。生成包含四个阶段（Orient、Gather、Consolidate、Prune）的 Markdown 格式提示词，引用记忆目录常量 `ENTRYPOINT_NAME` 和 `MAX_ENTRYPOINT_LINES`。`extra` 参数用于追加工具约束和会话列表等运行时上下文。

> 源码位置：`src/services/autoDream/consolidationPrompt.ts:10-65`

## 锁机制详解

### 设计思路

锁文件 `.consolidate-lock` 位于记忆目录（`getAutoMemPath()`）下，巧妙地**复用文件的 mtime 作为 `lastConsolidatedAt` 时间戳**，文件内容存储持有者的 PID。这意味着读取上次巩固时间只需一次 `stat` 调用，无需额外的时间戳文件。

### `tryAcquireConsolidationLock(): Promise<number | null>`

获取锁的流程（`src/services/autoDream/consolidationLock.ts:46-84`）：

1. 读取锁文件的 `stat` 和 PID 内容
2. 如果锁存在且 mtime 在 `HOLDER_STALE_MS`（1 小时）内，检查 PID 是否仍存活：
   - 存活 → 返回 `null`（锁被占用）
   - 死亡或无法解析 → 回收锁
3. 写入当前进程 PID
4. **竞争验证**：重新读取文件确认 PID 是自己的（两个进程同时写入时，后写入者的 PID 覆盖前者，前者在验证时发现不匹配而退出）
5. 返回先前的 mtime（用于失败回滚），首次获取时返回 0

### `rollbackConsolidationLock(priorMtime: number): Promise<void>`

回滚锁到获取前状态（`src/services/autoDream/consolidationLock.ts:91-108`）：
- `priorMtime === 0`：删除锁文件（恢复到无锁状态）
- 其他值：清空 PID 内容（防止当前进程看起来仍在持有），通过 `utimes` 将 mtime 恢复到原值

### `listSessionsTouchedSince(sinceMs: number): Promise<string[]>`

扫描当前项目目录下 mtime 大于指定时间的会话文件。使用 `listCandidates()` 进行 UUID 验证（排除 `agent-*.jsonl`），基于 mtime 而非 birthtime（ext4 上 birthtime 可能为 0）。

> 源码位置：`src/services/autoDream/consolidationLock.ts:118-124`

### `recordConsolidation(): Promise<void>`

供手动 `/dream` 命令使用的时间戳记录。在提示构建时乐观调用（无完成回调），写入当前 PID 到锁文件以更新 mtime。

> 源码位置：`src/services/autoDream/consolidationLock.ts:130-140`

## 配置项与默认值

### GrowthBook 特性标志

配置通过 `tengu_onyx_plover` 特性标志远程下发，支持以下字段：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `false` | 功能总开关（`config.ts` 中读取） |
| `minHours` | number | `24` | 两次巩固之间的最小间隔小时数 |
| `minSessions` | number | `5` | 触发巩固所需的最小会话数 |

每个字段都有防御性校验：必须为正有限数，否则回退到默认值（`src/services/autoDream/autoDream.ts:73-93`）。

### 用户设置覆盖

用户可在 `settings.json` 中设置 `autoDreamEnabled: true/false` 显式覆盖 GrowthBook 的 `enabled` 状态。

### 硬编码常量

| 常量 | 值 | 说明 |
|------|------|------|
| `SESSION_SCAN_INTERVAL_MS` | 10 分钟 | 会话扫描节流间隔 |
| `HOLDER_STALE_MS` | 1 小时 | 锁文件 PID 失效时间（防 PID 复用） |
| `LOCK_FILE` | `.consolidate-lock` | 锁文件名 |

## 边界 Case 与注意事项

- **KAIROS 模式互斥**：当 `getKairosActive()` 为 true 时，AutoDream 不触发——KAIROS 模式有自己的 disk-skill dream 机制
- **远程模式禁用**：`getIsRemoteMode()` 为 true 时跳过，避免远程会话触发本地记忆巩固
- **当前会话排除**：会话门控计数时排除当前会话 ID，因为其 mtime 总是最新的，不应算作"历史会话"
- **PID 复用防护**：锁文件超过 1 小时一律视为过期，即使 PID 恰好被新进程复用也会回收
- **竞争条件处理**：两个进程同时尝试获取锁时，采用"写入后验证"策略——后写入者赢得 PID，先写入者在验证时发现不匹配自行退出
- **forked agent 工具限制**：Bash 被限制为只读命令，文件编辑/写入通过 `createAutoMemCanUseTool()` 限定在记忆目录范围内
- **闭包隔离**：所有可变状态封装在 `initAutoDream()` 的闭包中而非模块级变量，方便测试中获得干净状态
- **config.ts 轻量导入**：`isAutoDreamEnabled()` 被独立为 `config.ts` 以最小化导入链——UI 组件可以读取开关状态而不引入 forked agent、任务注册等重依赖