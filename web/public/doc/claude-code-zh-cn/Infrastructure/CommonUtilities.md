# 通用工具函数库（CommonUtilities）

## 概述与职责

CommonUtilities 是 Claude Code 应用的基础设施层核心模块，位于 `src/utils/` 目录下，包含 **100+ 独立工具模块**。它为整个应用提供共享的底层能力——从数据结构、字符串处理、并发控制到文件路径管理、序列化、终端渲染辅助等。

在系统架构中，本模块隶属于 **Infrastructure** 层，几乎所有上层模块（CoreEngine、Services、ToolSystem、TerminalUI 等）都直接或间接依赖本模块提供的工具函数。它是整个应用的"工具箱"，设计原则是零业务耦合、高复用、可独立测试。

---

## 关键模块分类

本模块按功能可分为以下几大类别：

### 1. 数据结构

#### CircularBuffer

固定容量的环形缓冲区，满时自动淘汰最旧元素。常用于维护滚动窗口数据（如最近 N 条日志）。

```typescript
// src/utils/CircularBuffer.ts:5-84
export class CircularBuffer<T> {
  add(item: T): void          // 添加元素，满时淘汰最旧
  addAll(items: T[]): void    // 批量添加
  getRecent(count: number): T[] // 获取最近 N 个元素
  toArray(): T[]               // 按从旧到新顺序返回所有元素
  clear(): void
  length(): number
}
```

#### Cursor / MeasuredText

复杂的文本编辑光标系统（`src/utils/Cursor.ts`），支持：
- Unicode NFC 规范化处理
- 基于 grapheme 的光标移动（正确处理 emoji、CJK 字符）
- Emacs 风格的 Kill Ring（Ctrl+Y 粘贴、Alt+Y 循环）
- Vim 模式的词分类（`isVimWordChar`、`isVimPunctuation`）
- 显示宽度感知的自动换行

Kill Ring 提供全局状态，支持连续 kill 操作的文本累积和循环 yank（`src/utils/Cursor.ts:16-111`）。

#### Stream

单次消费的异步迭代器实现（`src/utils/stream.ts:1-50`），支持 `enqueue()`/`done()`/`error()` 的生产者-消费者模式，用于流式数据传递。

#### QueryGuard

查询生命周期的同步状态机（`src/utils/QueryGuard.ts`），兼容 React 的 `useSyncExternalStore`。三个状态：`idle` → `dispatching` → `running`，防止查询重入。

---

### 2. Abort 控制器管理

提供内存安全的 AbortController 层级管理：

- **`createAbortController()`**（`src/utils/abortController.ts:16-22`）：创建预设 maxListeners 的 AbortController，避免 `MaxListenersExceededWarning`
- **`createChildAbortController()`**（`src/utils/abortController.ts:68-99`）：创建子 AbortController，父 abort 时子自动 abort，反之不影响父。使用 **WeakRef** 防止内存泄漏——被丢弃的子控制器可被 GC 回收
- **`createCombinedAbortSignal()`**（`src/utils/combinedAbortSignal.ts`）：合并多个 signal + 可选超时，返回清理函数。特别优化了 Bun 环境下 `AbortSignal.timeout` 的内存泄漏问题

---

### 3. ID 与版本生成

| 模块 | 功能 | 源码位置 |
|------|------|----------|
| `uuid.ts` | UUID 验证 + Agent ID 生成（`a{label}-{16hex}`） | `src/utils/uuid.ts` |
| `taggedId.ts` | API 兼容的 tagged ID 编码（`{tag}_{version}{base58}`） | `src/utils/taggedId.ts` |
| `semver.ts` | Semver 比较，优先使用 Bun.semver（~20x 快），退化到 npm semver | `src/utils/semver.ts` |
| `words.ts` | 随机词组 slug 生成器（`adjective-verb-noun`），用于 plan ID | `src/utils/words.ts` |

`semver.ts` 导出 `gt`、`gte`、`lt`、`lte`、`satisfies`、`order` 六个函数，在 Bun 环境下使用内置的 `Bun.semver.order()` 获得 ~20x 性能提升（`src/utils/semver.ts:19-59`）。

---

### 4. 字符串处理

#### truncate 系列

宽度感知的截断/换行工具（`src/utils/truncate.ts`），所有函数基于终端列宽（非字符数）操作，正确处理 CJK/emoji：

- `truncate(str, maxWidth, singleLine?)` — 通用截断，追加 `…`
- `truncatePathMiddle(path, maxLength)` — 路径中间截断，保留目录前缀和文件名（如 `src/components/…/MyComponent.tsx`）
- `truncateToWidth()` / `truncateStartToWidth()` — 尾部/头部截断
- `wrapText(text, width)` — 按宽度换行

#### sliceAnsi

ANSI 转义序列感知的字符串切片（`src/utils/sliceAnsi.ts`）。基于显示宽度（非代码单元）定位，正确处理：
- OSC 8 超链接序列
- 零宽组合标记（如梵文 matras、变音符号）
- 切片时自动关闭/恢复 ANSI 样式状态

#### stringUtils

通用字符串工具集（`src/utils/stringUtils.ts`）：

| 函数 | 功能 |
|------|------|
| `escapeRegExp(str)` | 转义正则特殊字符 |
| `capitalize(str)` | 首字母大写（不改变其余字符） |
| `plural(n, word, pluralWord?)` | 单复数选择 |
| `firstLineOf(s)` | 零分配获取首行 |
| `countCharInString(str, char)` | 用 indexOf 跳跃计数字符出现次数 |
| `normalizeFullWidthDigits()` | 全角数字转半角（CJK 输入法适配） |
| `safeJoinLines(lines, delimiter, maxSize)` | 安全拼接，超限自动截断 |

**`EndTruncatingAccumulator`** 类（`src/utils/stringUtils.ts:140-220`）：大字符串安全累加器，超过上限（默认 32MB）时从尾部截断，防止 `RangeError` 崩溃。

#### semanticBoolean / semanticNumber

Zod schema 预处理器，处理模型生成 JSON 时将 boolean/number 误引用为字符串的问题（`"false"` → `false`，`"30"` → `30`）。对 API schema 透明——仍声明为 `boolean`/`number` 类型（`src/utils/semanticBoolean.ts`、`src/utils/semanticNumber.ts`）。

---

### 5. 数组与集合操作

**array.ts**（`src/utils/array.ts`）：
- `intersperse(as, separator)` — 在数组元素间插入分隔符
- `count(arr, pred)` — 计数满足条件的元素
- `uniq(xs)` — 去重

**set.ts**（`src/utils/set.ts`）—— 注释标注为热路径代码，手动优化循环：
- `difference(a, b)` — 集合差集
- `intersects(a, b)` — 判断是否有交集
- `every(a, b)` — a 是否为 b 的子集
- `union(a, b)` — 集合并集

---

### 6. 文件路径管理

#### xdg.ts

XDG Base Directory 规范实现（`src/utils/xdg.ts`），提供：
- `getXDGStateHome()` — 默认 `~/.local/state`
- `getXDGCacheHome()` — 默认 `~/.cache`
- `getXDGDataHome()` — 默认 `~/.local/share`
- `getUserBinDir()` — `~/.local/bin`

所有函数支持通过 options 注入 env/homedir，便于测试。

#### systemDirectories.ts

跨平台系统目录解析（`src/utils/systemDirectories.ts`），根据 platform（windows/linux/wsl/macos）返回 HOME、DESKTOP、DOCUMENTS、DOWNLOADS 路径。Windows 使用 USERPROFILE，Linux/WSL 优先读取 XDG 环境变量。

#### cachePaths.ts

项目级缓存路径管理（`src/utils/cachePaths.ts`）。使用 `env-paths` 库 + DJB2 哈希生成稳定的项目目录名：

```typescript
CACHE_PATHS.baseLogs()           // 基础日志目录
CACHE_PATHS.errors()             // 错误日志
CACHE_PATHS.messages()           // 消息日志
CACHE_PATHS.mcpLogs(serverName)  // MCP 服务器日志（名称已消毒）
```

#### windowsPaths.ts

Windows 路径适配（`src/utils/windowsPaths.ts`）：
- `setShellIfWindows()` — 自动查找 Git Bash 并设置 `SHELL` 环境变量
- `windowsPathToPosixPath()` / `posixPathToWindowsPath()` — 路径格式双向转换，带 LRU 缓存
- 安全过滤当前目录中的可执行文件（防止恶意 `git.bat` 劫持）

#### tempfile.ts

临时文件路径生成（`src/utils/tempfile.ts`），支持 `contentHash` 模式生成稳定路径（用于 API prompt cache 场景）。

---

### 7. 并发控制

#### sequential

异步函数的串行化包装器（`src/utils/sequential.ts`）。将并发调用排队按序执行，每个调用获得正确的返回值：

```typescript
const write = sequential(async (path: string, data: string) => {
  await fs.writeFile(path, data)
})
// 并发调用会自动排队
write('file.txt', 'a')  // 先执行
write('file.txt', 'b')  // 等 a 完成后执行
```

> 源码位置：`src/utils/sequential.ts:19-56`

#### sleep / withTimeout

- **`sleep(ms, signal?, opts?)`**（`src/utils/sleep.ts:14-54`）：abort 响应式延迟。signal abort 时可选静默 resolve 或抛异常。支持 `unref` 避免阻塞进程退出
- **`withTimeout(promise, ms, message)`**（`src/utils/sleep.ts:70-84`）：Promise 超时竞赛，超时后 reject 并自动清理 timer

#### withResolvers

`Promise.withResolvers()` 的 polyfill（`src/utils/withResolvers.ts`），支持 Node 18+（原生 API 需要 Node 22+）。

---

### 8. 信号与事件

#### Signal

轻量级发布-订阅原语（`src/utils/signal.ts`），替代了代码库中约 15 处重复的 `Set<listener>` 样板代码：

```typescript
const changed = createSignal<[SettingSource]>()
const unsub = changed.subscribe((source) => console.log(source))
changed.emit('userSettings')
changed.clear()  // 移除所有订阅
```

#### cleanupRegistry

全局清理函数注册表（`src/utils/cleanupRegistry.ts`），用于优雅关闭。`registerCleanup()` 返回取消注册函数。

---

### 9. 序列化

| 模块 | 功能 |
|------|------|
| `xml.ts` | `escapeXml()`、`escapeXmlAttr()` —— XML/HTML 特殊字符转义 |
| `yaml.ts` | YAML 解析，Bun 环境用内置 `Bun.YAML`，否则懒加载 npm `yaml`（节省 ~270KB） |
| `zodToJsonSchema.ts` | Zod v4 → JSON Schema 转换，WeakMap 缓存（每个 API 请求调用 60-250 次） |

---

### 10. ANSI 转图片

- **`ansiToSvg.ts`**：ANSI 转义文本 → SVG，支持 16 色标准调色板
- **`ansiToPng.ts`**：**直接** ANSI → PNG 渲染，跳过 SVG 中间格式。使用内嵌的 Fira Code 24×48 位图字体 + node:zlib 编码 PNG。相比之前的 resvg-wasm 方案（2.36MB WASM，~224ms/次），新方案 ~5-15ms/次，零外部依赖，跨平台一致

---

### 11. 性能监控

#### slowOperations

慢操作检测框架（`src/utils/slowOperations.ts`）。通过 `using` 语法（TC39 Explicit Resource Management）自动计时：

```typescript
using _ = slowLogging`JSON.stringify(${value})`
const json = JSON.stringify(value)
// 超阈值时自动记录日志并上报 DevBar
```

提供包装版本的常用操作：`jsonStringify`、`jsonParse`、`clone`、`cloneDeep`、`writeFileSync_DEPRECATED`。

阈值配置（`src/utils/slowOperations.ts:29-44`）：
- 环境变量 `CLAUDE_CODE_SLOW_OPERATION_THRESHOLD_MS` 覆盖
- 开发模式：20ms
- 内部用户（ant）：300ms
- 外部用户：`Infinity`（不记录）

外部构建通过 `feature('SLOW_OPERATION_LOGGING')` 的死代码消除，实现零开销。

#### startupProfiler

启动性能分析（`src/utils/startupProfiler.ts`），两种模式：
1. **采样日志**：100% ant 用户 + 0.5% 外部用户，上报到 Statsig
2. **详细 profiling**：`CLAUDE_CODE_PROFILE_STARTUP=1`，输出完整时间线报告含内存快照

#### ActivityManager

用户活动和 CLI 操作的活跃时间追踪（`src/utils/activityManager.ts`），自动去重重叠的活动窗口。

---

### 12. 日志缓冲

#### bufferedWriter

可配置的写入缓冲器（`src/utils/bufferedWriter.ts`）：

```typescript
const writer = createBufferedWriter({
  writeFn: (content) => appendFileSync(logPath, content),
  flushIntervalMs: 1000,    // 定时刷新
  maxBufferSize: 100,        // 条目数上限
  maxBufferBytes: Infinity,  // 字节数上限
  immediateMode: false,      // 直写模式
})
```

溢出时通过 `setImmediate` 异步写入，避免阻塞当前 tick。支持 `flush()` 同步清空和 `dispose()` 关闭。

---

### 13. 资源清理

#### cleanup.ts

老化文件清理系统（`src/utils/cleanup.ts`），基于可配置的保留期（默认 30 天）清理：
- 消息/错误日志
- MCP 日志
- 会话文件和 tool-results
- Plan 文件、文件历史备份
- Debug 日志
- Agent worktree
- npm 缓存（仅 ant 用户，每日一次，带文件锁防并发）

所有清理操作通过 `cleanupOldMessageFilesInBackground()` 统一调度（`src/utils/cleanup.ts:575-602`）。

---

### 14. 其他工具

| 模块 | 功能 |
|------|------|
| `which.ts` | 跨平台命令查找，Bun 环境用 `Bun.which`（零进程开销） |
| `binaryCheck.ts` | 检测命令是否已安装，带会话级缓存 |
| `treeify.ts` | 对象 → 树形文本渲染，支持 Ink 主题色、循环引用检测 |
| `timeouts.ts` | Bash 操作超时常量（默认 2min / 最大 10min），支持环境变量覆盖 |
| `toolPool.ts` | 工具列表合并、去重和 coordinator 模式过滤 |
| `asciicast.ts` | Asciicast 终端录制（仅 ant 用户 + 环境变量启用） |
| `autoUpdater.ts` | 自动更新检查与安装 |
| `terminal.ts` | 终端文本渲染工具（ANSI 感知的换行和折叠） |

---

## 边界 Case 与注意事项

- **Bun/Node 双运行时适配**：多个模块（`semver.ts`、`yaml.ts`、`which.ts`）在 Bun 环境使用内置 API 获得性能提升，在 Node 环境自动退化到 npm 包。确保在两种运行时下行为一致
- **WeakRef GC 依赖**：`abortController.ts` 的子控制器回收依赖 WeakRef 和 GC 行为，在高频创建/丢弃场景下需关注内存回收及时性
- **slowOperations 的 `using` 语法**：依赖 TC39 Explicit Resource Management（`Symbol.dispose`），需要编译目标支持或转译
- **Windows 路径安全**：`windowsPaths.ts` 在查找可执行文件时会过滤当前目录下的结果，防止恶意文件劫持（CWE-427）
- **清理操作的设置校验**：如果用户设置了 `cleanupPeriodDays` 但设置文件有验证错误，清理会被完全跳过（而非使用默认值），避免意外删除用户文件
- **`EndTruncatingAccumulator` 的 32MB 上限**：Shell 命令输出超过此上限会被截断，溢出部分由 `ShellCommand` 写入磁盘