# 记忆存储路径解析与安全校验（PathsAndConfig）

## 概述与职责

本模块是 **MemorySystem** 的基础设施层，负责回答两个核心问题：**记忆文件应该存放在哪里？** 以及 **对这些路径的读写是否安全？**

模块由两个文件组成：
- **`paths.ts`**：自动记忆（auto memory）目录的路径计算、启用状态判断、路径归属检测
- **`teamMemPaths.ts`**：团队记忆（team memory）子目录的路径管理，增加了 symlink 解析和深度安全校验

在 MemorySystem 中，本模块处于最底层——几乎所有记忆相关的读写操作（`extractMemories`、`/remember`、`/dream`、团队同步等）都依赖它来确定目标路径并校验安全性。同级模块包括记忆检索、记忆衰减、会话记忆等组件。

---

## 关键流程

### 1. 自动记忆启用判断流程（`isAutoMemoryEnabled`）

判断当前会话是否开启自动记忆功能，采用**优先级链**（first-defined-wins）：

1. 检查 `CLAUDE_CODE_DISABLE_AUTO_MEMORY` 环境变量——`1/true` 关闭，`0/false` 强制开启
2. 检查 `CLAUDE_CODE_SIMPLE`（`--bare` 模式）——若为 true 则关闭
3. 检查远程模式（`CLAUDE_CODE_REMOTE`）——无 `CLAUDE_CODE_REMOTE_MEMORY_DIR` 时关闭（CCR 无持久存储）
4. 读取 `settings.json` 中的 `autoMemoryEnabled` 配置项
5. 默认：启用

> 源码位置：`src/memdir/paths.ts:30-55`

### 2. 自动记忆路径解析流程（`getAutoMemPath`）

计算当前项目的记忆存储目录，采用**三级解析**：

1. **环境变量覆盖**：`CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`——Cowork/SDK 场景下直接指定完整路径，绕过项目维度的路径计算
2. **Settings 覆盖**：`autoMemoryDirectory` 配置项（仅从 policy/flag/local/user 四个可信源读取，**排除 projectSettings** 防止恶意仓库利用）
3. **默认计算**：`<memoryBase>/projects/<sanitized-git-root>/memory/`
   - `memoryBase`：由 `CLAUDE_CODE_REMOTE_MEMORY_DIR` 或 `~/.claude` 决定
   - `sanitized-git-root`：通过 `findCanonicalGitRoot` 获取规范 Git 根目录（确保同一仓库的不同 worktree 共享同一记忆目录），再用 `sanitizePath` 转为安全文件名

该函数使用 `memoize` 缓存结果（以 `projectRoot` 为 key），避免渲染路径中频繁调用导致的性能问题。

> 源码位置：`src/memdir/paths.ts:223-235`

### 3. 路径安全校验流程（`validateMemoryPath`）

对候选路径进行多层安全检查，防止路径遍历攻击：

1. **Tilde 展开**：仅在 settings 场景下展开 `~/`，且拒绝展开为 `$HOME` 本身或其父目录的情况（如 `~/`、`~/.`、`~/..`）
2. **规范化**：`normalize()` 消除 `..` 和冗余分隔符
3. **黑名单拒绝**：
   - 相对路径（非 `isAbsolute`）
   - 根路径或过短路径（`length < 3`）
   - Windows 驱动器根目录（`C:`）
   - UNC 路径（`\\server\share` 或 `//`）
   - 空字节（`\0`，可在 C 系统调用中截断路径）
4. 返回 NFC 规范化的带尾部分隔符路径

> 源码位置：`src/memdir/paths.ts:109-150`

### 4. 团队记忆写入验证流程（`validateTeamMemWritePath` / `validateTeamMemKey`）

采用**两遍校验**策略防止 symlink 逃逸攻击（PSR M22186）：

**第一遍——字符串级检查（快速拒绝）：**
1. 检查空字节
2. `path.resolve()` 消除 `..` 段
3. 前缀匹配确认路径在 `teamDir` 内

**第二遍——文件系统级检查（symlink 防御）：**
1. 调用 `realpathDeepestExisting()` 向上遍历目录树，对最深存在的祖先调用 `realpath()` 解析真实路径
2. 将非存在的尾部路径重新拼接到已解析的路径上
3. 调用 `isRealPathWithinTeamDir()` 对比真实路径与真实团队目录，确认包含关系

任何异常均抛出 `PathTraversalError`，调用方可据此跳过单条记录而非中止整个批处理。

> 源码位置：`src/memdir/teamMemPaths.ts:228-256`（写路径验证）、`src/memdir/teamMemPaths.ts:109-171`（symlink 解析）

---

## 函数签名与参数说明

### paths.ts 导出函数

#### `isAutoMemoryEnabled(): boolean`
判断自动记忆是否启用。无参数，返回布尔值。遵循环境变量 → SIMPLE 模式 → 远程模式 → settings → 默认启用的优先级链。

#### `isExtractModeActive(): boolean`
判断后台记忆提取 Agent 是否在本会话运行。受两个 feature flag 控制：`tengu_passport_quail`（总开关）和 `tengu_slate_thimble`（非交互会话扩展）。调用方还需额外检查 `feature('EXTRACT_MEMORIES')`。

#### `getMemoryBaseDir(): string`
返回记忆存储的基础目录。优先使用 `CLAUDE_CODE_REMOTE_MEMORY_DIR`，否则返回 `~/.claude`。

#### `getAutoMemPath(): string`（memoized）
返回当前项目的自动记忆目录路径（带尾部分隔符）。解析优先级见上文流程 2。以 `getProjectRoot()` 为 memoize key。

#### `getAutoMemEntrypoint(): string`
返回 `MEMORY.md` 的完整路径，即 `getAutoMemPath() + 'MEMORY.md'`。

#### `getAutoMemDailyLogPath(date?: Date): string`
返回日志文件路径，格式为 `<autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md`。用于 assistant 模式（`feature('KAIROS')`），Agent 在工作时追加日志，由 `/dream` 技能定期汇总。

#### `isAutoMemPath(absolutePath: string): boolean`
判断给定绝对路径是否在自动记忆目录内。先 `normalize()` 消除 `..` 段再做前缀匹配。**不解析 symlink**——写操作应使用 `teamMemPaths.ts` 的验证函数。

#### `hasAutoMemPathOverride(): boolean`
判断 `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 是否设置了有效覆盖。用于 SDK 场景判断是否注入记忆 prompt。

### teamMemPaths.ts 导出函数

#### `isTeamMemoryEnabled(): boolean`
判断团队记忆是否启用。要求自动记忆已启用 **且** feature flag `tengu_herring_clock` 开启。

#### `getTeamMemPath(): string`
返回团队记忆目录路径：`<autoMemPath>/team/`（带尾部分隔符，NFC 规范化）。

#### `getTeamMemEntrypoint(): string`
返回团队记忆的 `MEMORY.md` 路径。

#### `isTeamMemPath(filePath: string): boolean`
字符串级路径包含检查（`resolve()` 后前缀匹配）。不解析 symlink，适用于只读判断。

#### `validateTeamMemWritePath(filePath: string): Promise<string>`
写操作前的完整路径验证（字符串级 + symlink 级双重校验）。返回解析后的绝对路径，异常抛出 `PathTraversalError`。

#### `validateTeamMemKey(relativeKey: string): Promise<string>`
验证来自服务端的相对路径 key。先通过 `sanitizePathKey()` 检查注入向量，再走双重校验流程。

#### `isTeamMemFile(filePath: string): boolean`
组合判断：团队记忆已启用 **且** 路径在团队记忆目录内。

---

## 接口/类型定义

### `PathTraversalError`

继承自 `Error` 的自定义异常类，`name` 属性为 `'PathTraversalError'`。所有路径安全校验失败时抛出此异常。调用方通过 `instanceof PathTraversalError` 捕获，通常选择跳过该条目而非中止整个操作。

> 源码位置：`src/memdir/teamMemPaths.ts:10-15`

---

## 配置项与默认值

| 配置方式 | 变量/字段 | 作用 | 默认值 |
|---------|----------|------|--------|
| 环境变量 | `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | 禁用自动记忆（`1/true` 关闭） | 未设置（启用） |
| 环境变量 | `CLAUDE_CODE_SIMPLE` | `--bare` 模式，禁用记忆 | 未设置 |
| 环境变量 | `CLAUDE_CODE_REMOTE` | 标记远程运行环境 | 未设置 |
| 环境变量 | `CLAUDE_CODE_REMOTE_MEMORY_DIR` | 远程环境下记忆基础目录 | 未设置（fallback `~/.claude`） |
| 环境变量 | `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` | 完整记忆路径覆盖（Cowork/SDK） | 未设置 |
| settings.json | `autoMemoryEnabled` | 启用/禁用自动记忆 | `true` |
| settings.json | `autoMemoryDirectory` | 自定义记忆目录路径（支持 `~/`） | 未设置（使用默认计算路径） |
| 常量 | `AUTO_MEM_DIRNAME` | 记忆子目录名 | `'memory'` |
| 常量 | `AUTO_MEM_ENTRYPOINT_NAME` | 入口文件名 | `'MEMORY.md'` |

---

## 边界 Case 与注意事项

### 安全设计要点

- **projectSettings 排除**：`autoMemoryDirectory` 不从 `.claude/settings.json`（仓库内文件）读取——恶意仓库可借此将记忆写入 `~/.ssh` 等敏感目录（`src/memdir/paths.ts:176-178`）
- **Tilde 展开限制**：仅展开 `~/path` 形式，`~`、`~/`、`~/..` 等会展开为 `$HOME` 或其父目录的形式被拒绝
- **Symlink 逃逸防御**：`path.resolve()` 不解析 symlink，攻击者可在团队目录内放置指向外部的 symlink。`realpathDeepestExisting` 通过 `realpath()` 解析实际文件系统位置来防御此攻击
- **悬挂 symlink 检测**：`ENOENT` 时通过 `lstat()` 区分"真不存在"和"悬挂 symlink"，后者是攻击向量（`writeFile` 会跟随 symlink 在外部创建目标文件）
- **Symlink 循环检测**：`ELOOP` 错误触发 `PathTraversalError`
- **Unicode 规范化攻击**：`sanitizePathKey` 检测全角字符（如 `．．／`）在 NFKC 规范化后变为 `../` 的情况
- **前缀攻击防护**：`teamDir` 以 `sep` 结尾，防止 `/foo/team-evil` 匹配 `/foo/team`

### Git Worktree 共享

`getAutoMemBase()` 使用 `findCanonicalGitRoot()` 而非普通项目根目录，确保同一仓库的不同 worktree 共享同一个记忆目录（参考 issue #24382）。

### Memoization 策略

`getAutoMemPath` 使用 lodash `memoize`，以 `getProjectRoot()` 返回值为缓存 key。这对生产环境是安全的（环境变量和 settings 在会话内稳定），但测试中需注意 mock 切换后调用 `cache.clear`。

### 写权限的微妙区分

- `isAutoMemPath()` 返回 `true` 不代表有写权限——当 `hasAutoMemPathOverride()` 为 true（Cowork 场景）时，`filesystem.ts` 的写入绕过逻辑不生效
- settings 中的 `autoMemoryDirectory` 可获得写入绕过（用户显式选择，且 projectSettings 已排除）