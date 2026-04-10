# MDM 策略读取子系统

## 概述与职责

MDMPolicy 是 Claude Code 设置系统中负责**企业级设备管理（MDM）策略读取**的子模块，位于 `Infrastructure → ConfigAndSettings → SettingsSystem` 层级下。它通过操作系统原生机制读取企业管理员下发的配置策略，使组织能够集中管控 Claude Code 的行为（如权限规则、功能开关等）。

该子系统由三个文件组成，按职责严格分层：

| 文件 | 职责 | 依赖特点 |
|------|------|----------|
| `constants.ts` | 共享常量与路径构建 | 零重依赖（仅 `os`） |
| `rawRead.ts` | 子进程 I/O，启动时尽早发起读取 | 零重依赖（仅 `child_process`、`fs`） |
| `settings.ts` | 解析、校验、缓存、优先级策略 | 依赖内部工具模块 |

三个平台的读取策略各不相同：
- **macOS**：通过 `plutil` 读取 `/Library/Managed Preferences/` 下的 plist 文件
- **Windows**：通过 `reg query` 读取 `HKLM` / `HKCU` 注册表策略键
- **Linux**：无 MDM 等价物，回退到文件方式（`managed-settings.json`）

在同级模块中，MDMPolicy 的产出被上层的 `settings.ts`（SettingsSystem 的主设置加载器）作为多来源设置合并的一个输入源使用。

## 关键流程

### 1. 启动时预读取流程

MDM 读取被设计为在应用启动**最早期**执行，以便子进程与模块加载并行运行，最大化利用启动时间：

1. `main.tsx` 模块求值时调用 `startMdmRawRead()`（`rawRead.ts:120-123`）
2. `startMdmRawRead()` 将 promise 存入模块级变量 `rawReadPromise`，仅执行一次
3. 稍后，`startMdmSettingsLoad()` 被调用（`settings.ts:67-98`），它：
   - 通过 `getMdmRawReadPromise()` 获取已发起的 promise（如果存在）
   - 否则调用 `fireRawRead()` 发起新的读取
   - await 结果后调用 `consumeRawReadResult()` 解析，写入缓存
4. 首次设置读取前调用 `ensureMdmSettingsLoaded()`（`settings.ts:104-109`）确保加载完成

```
main.tsx 模块求值        settings 首次读取
    │                        │
    ▼                        ▼
startMdmRawRead()    ensureMdmSettingsLoaded()
    │                        │
    ▼                        ▼
fireRawRead()        await mdmLoadPromise
    │                        │
    └──── rawReadPromise ────┘
                │
                ▼
      consumeRawReadResult()
                │
                ▼
         mdmCache / hkcuCache
```

### 2. macOS plist 读取流程

1. `getMacOSPlistPaths()`（`constants.ts:45-81`）按优先级构建 plist 路径列表：
   - **最高**：`/Library/Managed Preferences/<username>/com.anthropic.claudecode.plist`（用户级受管偏好）
   - **中等**：`/Library/Managed Preferences/com.anthropic.claudecode.plist`（设备级受管偏好）
   - **最低**（仅 `USER_TYPE=ant`）：`~/Library/Preferences/com.anthropic.claudecode.plist`（本地测试用）
2. `fireRawRead()`（`rawRead.ts:55-88`）对每个路径：
   - 先用 `existsSync()` 快速检查文件是否存在（避免无谓的 5ms 子进程开销）
   - 存在则调用 `/usr/bin/plutil -convert json -o - -- <path>` 将 plist 转为 JSON
3. 所有路径并行读取，取第一个成功结果（first-source-wins）

### 3. Windows 注册表读取流程

1. `fireRawRead()`（`rawRead.ts:90-113`）并行发起两个 `reg query` 命令：
   - `reg query HKLM\SOFTWARE\Policies\ClaudeCode /v Settings`
   - `reg query HKCU\SOFTWARE\Policies\ClaudeCode /v Settings`
2. `parseRegQueryStdout()`（`settings.ts:208-222`）用正则从 `reg query` 输出中提取 `REG_SZ` 或 `REG_EXPAND_SZ` 类型的值
3. 提取到的 JSON 字符串交给 `parseCommandOutputAsSettings()` 校验

### 4. First-Source-Wins 优先级策略

`consumeRawReadResult()`（`settings.ts:228-273`）实现了核心的优先级逻辑，按以下顺序尝试，**第一个有有效数据的源即为最终结果**：

1. **macOS plist**（管理员权限部署）→ 写入 `mdmCache`
2. **Windows HKLM**（管理员权限写入）→ 写入 `mdmCache`
3. **`managed-settings.json` 文件检查**（`hasManagedSettingsFile()`）→ 如果存在，跳过 HKCU
4. **Windows HKCU**（用户可写，最低优先级）→ 写入 `hkcuCache`

关键设计：HKLM 和 plist 是管理员控制的源，统一存入 `mdmCache`；HKCU 因用户可写故单独存入 `hkcuCache`，由上层合并时赋予最低优先级。文件方式的 `managed-settings.json` 优先级介于 HKLM 和 HKCU 之间。

## 函数签名与参数说明

### constants.ts

#### `getMacOSPlistPaths(): Array<{ path: string; label: string }>`

构建 macOS plist 路径列表（按优先级降序）。运行时检查 `process.env.USER_TYPE` 决定是否包含 ant-only 路径。

### rawRead.ts

#### `fireRawRead(): Promise<RawReadResult>`

发起全新的子进程读取，返回原始标准输出。按平台分支处理：macOS 用 plutil，Windows 用 reg query，Linux 返回空结果。

#### `startMdmRawRead(): void`

启动时调用一次，将 `fireRawRead()` 的 promise 缓存供后续消费。幂等——多次调用不会重复发起。

#### `getMdmRawReadPromise(): Promise<RawReadResult> | null`

获取 `startMdmRawRead()` 缓存的 promise。未调用过 `startMdmRawRead()` 时返回 `null`。

### settings.ts

#### `startMdmSettingsLoad(): void`

启动异步 MDM 加载流程，消费 raw read 结果并写入缓存。幂等。

#### `ensureMdmSettingsLoaded(): Promise<void>`

确保 MDM 设置已加载完毕。如果 `startMdmSettingsLoad()` 尚未调用会自动触发。

#### `getMdmSettings(): MdmResult`

同步返回管理员级 MDM 缓存（macOS plist / Windows HKLM），供设置流水线使用。

#### `getHkcuSettings(): MdmResult`

同步返回 Windows HKCU 缓存（用户可写，最低优先级），非 Windows 平台始终返回空。

#### `clearMdmSettingsCache(): void`

清空所有缓存，下次加载将重新读取。

#### `setMdmSettingsCache(mdm: MdmResult, hkcu: MdmResult): void`

直接更新缓存，供 changeDetector 轮询刷新后写入。

#### `refreshMdmSettings(): Promise<{ mdm: MdmResult; hkcu: MdmResult }>`

发起全新读取并解析，但**不更新缓存**，由调用方决定是否应用。用于 30 分钟轮询场景。

#### `parseCommandOutputAsSettings(stdout: string, sourcePath: string): { settings: SettingsJson; errors: ValidationError[] }`

将 JSON 字符串解析并校验为 `SettingsJson`。先过滤无效权限规则，再做 Zod schema 校验，避免一条坏规则导致整体拒绝。

#### `parseRegQueryStdout(stdout: string, valueName?: string): string | null`

从 `reg query` 标准输出中用正则提取指定值名的字符串内容。支持 `REG_SZ` 和 `REG_EXPAND_SZ` 类型。

## 类型定义

### `RawReadResult`（`rawRead.ts:24-28`）

子进程原始读取结果，三个平台的输出各占一个字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `plistStdouts` | `Array<{ stdout: string; label: string }> \| null` | macOS plist 读取结果，`null` 表示非 macOS |
| `hklmStdout` | `string \| null` | Windows HKLM reg query 输出 |
| `hkcuStdout` | `string \| null` | Windows HKCU reg query 输出 |

### `MdmResult`（`settings.ts:53`）

解析后的 MDM 设置结果：

| 字段 | 类型 | 说明 |
|------|------|------|
| `settings` | `SettingsJson` | 校验通过的设置对象 |
| `errors` | `ValidationError[]` | 校验过程中发现的错误 |

## 配置项与常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `MACOS_PREFERENCE_DOMAIN` | `com.anthropic.claudecode` | macOS 偏好域名 |
| `WINDOWS_REGISTRY_KEY_PATH_HKLM` | `HKLM\SOFTWARE\Policies\ClaudeCode` | Windows 管理员注册表路径 |
| `WINDOWS_REGISTRY_KEY_PATH_HKCU` | `HKCU\SOFTWARE\Policies\ClaudeCode` | Windows 用户注册表路径 |
| `WINDOWS_REGISTRY_VALUE_NAME` | `Settings` | 注册表值名称 |
| `PLUTIL_PATH` | `/usr/bin/plutil` | macOS plutil 二进制路径 |
| `PLUTIL_ARGS_PREFIX` | `['-convert', 'json', '-o', '-', '--']` | plutil 参数前缀 |
| `MDM_SUBPROCESS_TIMEOUT_MS` | `5000` | 子进程超时（毫秒） |

## 边界 Case 与注意事项

### 零重依赖设计

`constants.ts` 和 `rawRead.ts` 被刻意设计为零重依赖（仅依赖 Node.js 内置模块），以确保在 `main.tsx` 模块求值阶段就能安全调用 `startMdmRawRead()`，不会因为循环依赖或模块加载顺序问题而失败。

### Windows 注册表路径选择

注册表键放在 `SOFTWARE\Policies` 而非 `SOFTWARE\ClaudeCode`，这是有意为之的设计决策（`constants.ts:17-21`）。`SOFTWARE\Policies` 在 WOW64 共享键列表中，32 位和 64 位进程看到相同的值；而 `SOFTWARE` 会被重定向，32 位进程会静默读取 `WOW6432Node` 下的不同值。

### existsSync 快速路径

在 macOS 上，`fireRawRead()` 先用 `existsSync()` 检查 plist 文件是否存在（`rawRead.ts:68`），避免为不存在的文件启动 plutil 子进程（约 5ms 开销）。这是一个**同步**调用，有意为之——确保 `execFilePromise` 是第一个 `await`，从而保证子进程在事件循环首次 poll 之前就已 spawn。

### HKCU 与 managed-settings.json 的互斥

当文件方式的 `managed-settings.json`（或其 drop-in 目录中的任何 `.json` 文件）存在且非空时，HKCU 注册表源会被跳过（`settings.ts:256-258`）。这防止了同时存在文件配置和用户级注册表配置时的歧义。

### 校验容错

`parseCommandOutputAsSettings()` 在做 Zod schema 校验之前会先调用 `filterInvalidPermissionRules()` 过滤无效的权限规则（`settings.ts:192`）。这确保一条格式错误的规则不会导致整个 MDM 设置被拒绝——其余有效规则仍然生效。

### Linux 平台

Linux 上 `fireRawRead()` 直接返回空结果（`rawRead.ts:112`），MDM 策略完全依赖文件方式（`managed-settings.json`），不经过此子系统的子进程读取路径。