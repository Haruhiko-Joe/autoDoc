# 环境检测、变量管理与 CLI 参数早期解析

## 概述与职责

本模块是 Claude Code 基础设施层（Infrastructure → ConfigAndSettings）的一部分，负责在应用启动早期完成运行时环境检测、环境变量管理和 CLI 参数预解析。它由五个文件组成，共同为上层模块提供统一的环境信息访问接口：

- **env.ts** — 同步环境检测主入口，导出 `env` 对象
- **envDynamic.ts** — 需要异步检测的环境信息（Docker、musl、JetBrains IDE 细分检测）
- **envUtils.ts** — 基础环境工具函数（配置路径、布尔判断、环境变量解析）
- **envValidation.ts** — 带上下限约束的环境变量数值校验
- **cliArgs.ts** — 在 Commander.js 之前的 CLI 标志早期解析

同级模块包括 ShellAndBash（Shell 执行）、GitOperations（Git 操作）、PermissionsAndAuth（权限认证）等，它们共同构成应用的基础设施层。

---

## 关键流程

### 环境信息初始化流程

应用启动时，`env.ts` 中的 `env` 对象被同步构建（`src/utils/env.ts:316-333`）。该对象汇聚了以下检测结果：

1. **平台归一化**：将 `process.platform` 归一为 `'win32' | 'darwin' | 'linux'` 三值枚举，非 win32/darwin 一律视为 linux
2. **终端检测**：`detectTerminal()` 按优先级依次检测 30+ 种终端/IDE 环境（Cursor、VS Code、Windsurf、JetBrains 全家族、ghostty、kitty、tmux、Windows Terminal 等）
3. **部署环境检测**：`detectDeploymentEnvironment()` 识别 25+ 种云平台和 CI/CD 环境（Codespaces、Vercel、AWS Lambda、GitHub Actions 等）
4. **异步检测**（按需）：包管理器（npm/yarn/pnpm）、运行时（bun/deno/node）、网络连通性等通过 `memoize` 缓存的异步函数提供

### 终端检测优先级链

`detectTerminal()`（`src/utils/env.ts:135-234`）的检测顺序体现了清晰的优先级设计：

1. **IDE 特征环境变量**（最高优先级）：`CURSOR_TRACE_ID`、`VSCODE_GIT_ASKPASS_MAIN` 路径匹配
2. **macOS Bundle ID**：通过 `__CFBundleIdentifier` 识别 VSCodium、Windsurf、JetBrains 全系列
3. **JetBrains JediTerm**：通过 `TERMINAL_EMULATOR` 变量检测
4. **TERM 变量**：ghostty、kitty 等通过 TERM 值判断
5. **TERM_PROGRAM**：通用终端识别
6. **会话管理器**：tmux（`TMUX`）、screen（`STY`）
7. **Linux 终端特征变量**：Konsole、GNOME Terminal、xterm 等
8. **Windows 终端**：Windows Terminal、Cygwin、ConEmu
9. **SSH 会话**、**TERM 回退**、**非交互模式**（最低优先级）

### JetBrains IDE 精细检测

在 Linux/Windows 上，`env.ts` 只能同步识别出 "JetBrains-JediTerm" 但无法区分具体 IDE。`envDynamic.ts` 通过异步方式弥补这一限制（`src/utils/envDynamic.ts:64-96`）：

1. 调用 `getAncestorCommandsAsync()` 遍历最多 10 层父进程命令行
2. 在命令行中匹配 `JETBRAINS_IDES` 列表中的 IDE 名称
3. 结果缓存到 `jetBrainsIDECache`，后续同步版本 `getTerminalWithJetBrainsDetection()` 可直接读取

应用应在初始化早期调用 `initJetBrainsDetection()` 预热缓存。

### Bare 模式检测

`isBareMode()`（`src/utils/envUtils.ts:60-65`）支持两种触发方式：

1. 环境变量 `CLAUDE_CODE_SIMPLE` 为真值
2. 命令行包含 `--bare` 标志

直接检查 `process.argv` 而非依赖 Commander.js 解析，因为多个门控点在 `main.tsx` 的 action handler 设置环境变量之前就已执行（如 `startKeychainPrefetch()`）。Bare 模式跳过 hooks、LSP、插件同步、技能目录扫描、所有 keychain/credential 读取等约 30 个门控点。

### CLI 标志早期解析

`eagerParseCliFlag()`（`src/utils/cliArgs.ts:13-29`）在 Commander.js 处理参数之前提取关键标志值，典型用例是 `--settings` 标志（影响配置加载路径，必须在 `init()` 运行前可用）。支持两种语法：
- 空格分隔：`--settings /path/to/settings.json`
- 等号分隔：`--settings=/path/to/settings.json`

---

## 函数签名与参数说明

### env.ts 导出

#### `env` 对象

全局环境信息单例（`src/utils/env.ts:316-333`）：

| 属性 | 类型 | 说明 |
|------|------|------|
| `platform` | `'win32' \| 'darwin' \| 'linux'` | 归一化平台标识 |
| `arch` | `string` | CPU 架构（`process.arch`） |
| `nodeVersion` | `string` | Node.js 版本号 |
| `terminal` | `string \| null` | 同步检测的终端标识 |
| `isCI` | `boolean` | 是否 CI 环境 |
| `hasInternetAccess` | `() => Promise<boolean>` | 网络连通性（HEAD 请求 1.1.1.1） |
| `isSSH` | `() => boolean` | 是否 SSH 会话 |
| `getPackageManagers` | `() => Promise<string[]>` | 可用包管理器列表 |
| `getRuntimes` | `() => Promise<string[]>` | 可用运行时列表 |
| `isRunningWithBun` | `() => boolean` | 是否以 Bun 运行 |
| `isWslEnvironment` | `() => boolean` | 是否 WSL 环境 |
| `isNpmFromWindowsPath` | `() => boolean` | WSL 下 npm 是否来自 Windows 路径 |
| `isConductor` | `() => boolean` | 是否通过 Conductor 应用运行 |
| `detectDeploymentEnvironment` | `() => string` | 部署环境标识 |

#### `getGlobalClaudeFile(): string`

返回全局 Claude 配置文件路径。优先使用 `~/.claude/.config.json`（旧版兼容），否则使用 `$CLAUDE_CONFIG_DIR/.claude{suffix}.json`。结果被 `memoize` 缓存。

> 源码位置：`src/utils/env.ts:14-26`

#### `getHostPlatformForAnalytics(): Platform`

返回用于分析报告的宿主平台。支持通过 `CLAUDE_CODE_HOST_PLATFORM` 环境变量覆盖，适用于容器环境中 `process.platform` 报告容器 OS 而非实际宿主的场景。

> 源码位置：`src/utils/env.ts:341-347`

#### `detectDeploymentEnvironment(): string`

识别部署环境，返回平台标识字符串。检测覆盖云开发环境（Codespaces、Gitpod、Replit）、云平台（Vercel、AWS Lambda/Fargate/ECS/EC2、GCP Cloud Run、Azure）、CI/CD（GitHub Actions、GitLab CI、CircleCI）、容器编排（Kubernetes、Docker）等。

> 源码位置：`src/utils/env.ts:240-305`

### envDynamic.ts 导出

#### `envDynamic` 对象

扩展 `env` 的动态检测信息（`src/utils/envDynamic.ts:143-151`），在 `env` 基础上新增：

| 属性 | 类型 | 说明 |
|------|------|------|
| `terminal` | `string \| null` | 覆盖 env.terminal，增加 JetBrains 缓存检测 |
| `getIsDocker` | `() => Promise<boolean>` | 是否 Docker 环境（检查 `/.dockerenv`） |
| `getIsBubblewrapSandbox` | `() => boolean` | 是否 Bubblewrap 沙箱 |
| `isMuslEnvironment` | `() => boolean` | 是否 musl libc 环境 |
| `getTerminalWithJetBrainsDetectionAsync` | `() => Promise<string \| null>` | 异步 JetBrains IDE 精确检测 |
| `initJetBrainsDetection` | `() => Promise<void>` | 预热 JetBrains 检测缓存 |

#### `isMuslEnvironment(): boolean`

检测系统是否使用 musl libc。在原生 Linux 构建中通过编译时 feature flag（`IS_LIBC_MUSL` / `IS_LIBC_GLIBC`）静态判定；在 Node.js 非打包模式下，回退到模块加载时发起的异步 `stat('/lib/libc.musl-{arch}.so.1')` 检测结果。

> 源码位置：`src/utils/envDynamic.ts:52-59`

### envUtils.ts 导出

#### `getClaudeConfigHomeDir(): string`

返回 Claude 配置目录路径：`$CLAUDE_CONFIG_DIR` 或 `~/.claude`，结果 NFC 归一化。以 `CLAUDE_CONFIG_DIR` 环境变量值为 memoize key，测试中修改环境变量会自动刷新缓存。

> 源码位置：`src/utils/envUtils.ts:7-14`

#### `isEnvTruthy(envVar: string | boolean | undefined): boolean`

判断环境变量是否为真值。识别 `'1'`、`'true'`、`'yes'`、`'on'`（大小写不敏感）。

> 源码位置：`src/utils/envUtils.ts:32-37`

#### `isEnvDefinedFalsy(envVar: string | boolean | undefined): boolean`

判断环境变量是否被**显式设置为假值**。识别 `'0'`、`'false'`、`'no'`、`'off'`。与 `isEnvTruthy` 的区别：`undefined` 返回 `false`（未定义不等于显式为假）。

> 源码位置：`src/utils/envUtils.ts:39-47`

#### `isBareMode(): boolean`

检测是否处于 bare 模式（精简启动模式）。

> 源码位置：`src/utils/envUtils.ts:60-65`

#### `parseEnvVars(rawEnvArgs: string[] | undefined): Record<string, string>`

将 `KEY=VALUE` 格式的字符串数组解析为键值对象。值中包含 `=` 时正确处理（仅按第一个 `=` 分割）。格式不合法时抛出 `Error`。

> 源码位置：`src/utils/envUtils.ts:72-90`

#### `getAWSRegion(): string`

获取 AWS 区域：`AWS_REGION` → `AWS_DEFAULT_REGION` → `'us-east-1'`。

> 源码位置：`src/utils/envUtils.ts:96-98`

#### `getDefaultVertexRegion(): string`

获取默认 Vertex AI 区域：`CLOUD_ML_REGION` 或 `'us-east5'`。

> 源码位置：`src/utils/envUtils.ts:103-105`

#### `getVertexRegionForModel(model: string | undefined): string | undefined`

根据模型名称前缀匹配获取特定的 Vertex AI 区域。通过 `VERTEX_REGION_OVERRIDES` 映射表（`src/utils/envUtils.ts:155-165`）将模型前缀映射到对应的环境变量名，支持 Claude 3.5/3.7/4.x 各系列模型的独立区域配置。前缀匹配顺序从具体到宽泛（如 `claude-opus-4-1` 在 `claude-opus-4` 之前）。

> 源码位置：`src/utils/envUtils.ts:171-183`

#### 其他工具函数

| 函数 | 说明 |
|------|------|
| `getTeamsDir()` | 返回 `{configHome}/teams` 路径 |
| `hasNodeOption(flag)` | 检查 `NODE_OPTIONS` 是否包含特定标志（精确匹配） |
| `shouldMaintainProjectWorkingDir()` | 检查 `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` |
| `isRunningOnHomespace()` | 检查是否在 Homespace 云环境 |
| `isInProtectedNamespace()` | 检查是否在受保护的 COO 命名空间（仅内部构建） |

### envValidation.ts 导出

#### `validateBoundedIntEnvVar(name, value, defaultValue, upperLimit): EnvVarValidationResult`

校验环境变量的整数值，确保在合理范围内（`src/utils/envValidation.ts:9-38`）：

- **未设置** → 返回 `defaultValue`，状态 `'valid'`
- **非正整数** → 返回 `defaultValue`，状态 `'invalid'`，附带错误消息
- **超过上限** → 返回 `upperLimit`，状态 `'capped'`，附带截断消息
- **合法值** → 返回解析值，状态 `'valid'`

```typescript
type EnvVarValidationResult = {
  effective: number       // 最终生效的值
  status: 'valid' | 'capped' | 'invalid'
  message?: string        // 非 valid 时的说明
}
```

### cliArgs.ts 导出

#### `eagerParseCliFlag(flagName: string, argv?: string[]): string | undefined`

在 Commander.js 之前解析 CLI 标志值。支持 `--flag value` 和 `--flag=value` 两种语法。

> 源码位置：`src/utils/cliArgs.ts:13-29`

#### `extractArgsAfterDoubleDash(commandOrValue: string, args?: string[]): { command: string; args: string[] }`

处理 `--` 分隔符约定。当 Commander.js 使用 `.passThroughOptions()` 时，`--` 会作为位置参数传入而非被消费，此函数修正这一行为：如果 `commandOrValue` 为 `'--'`，则从 `args` 数组中提取实际命令。

> 源码位置：`src/utils/cliArgs.ts:49-60`

---

## 配置项与环境变量

| 环境变量 | 用途 | 默认值 |
|----------|------|--------|
| `CLAUDE_CONFIG_DIR` | 覆盖配置目录路径 | `~/.claude` |
| `CLAUDE_CODE_SIMPLE` | 启用 bare 模式 | 未设置 |
| `CLAUDE_CODE_HOST_PLATFORM` | 覆盖分析报告的平台值 | 自动检测 |
| `CLAUDE_CODE_BUBBLEWRAP` | 标记 Bubblewrap 沙箱环境 | 未设置 |
| `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` | Bash 命令执行后恢复工作目录 | 未设置 |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | AWS 区域 | `us-east-1` |
| `CLOUD_ML_REGION` | Vertex AI 默认区域 | `us-east5` |
| `VERTEX_REGION_CLAUDE_*` | 各 Claude 模型的 Vertex 区域覆盖 | 回退到 `CLOUD_ML_REGION` |
| `NODE_OPTIONS` | Node.js 选项（通过 `hasNodeOption` 检查） | — |

---

## 边界 Case 与注意事项

- **memoize 缓存行为**：`env` 对象上的多数检测函数通过 `lodash-es/memoize` 缓存结果，首次调用后不再重新检测。`getClaudeConfigHomeDir` 特殊处理——以 `CLAUDE_CONFIG_DIR` 环境变量值为缓存 key，测试中修改该变量会触发重新计算。

- **musl 检测的竞态**：`isMuslEnvironment()` 在模块加载时发起异步 `stat` 检测，如果在检测完成前被调用，`muslRuntimeCache` 为 `null`，函数返回 `false`。原生构建不受此影响（编译时确定）。

- **WSL 下的 npm 路径问题**：`isNpmFromWindowsPath()` 检测 WSL 中 npm 是否来自 Windows 文件系统（`/mnt/c/` 前缀），用于避免跨文件系统调用带来的性能和兼容性问题。

- **网络检测超时**：`hasInternetAccess()` 对 `1.1.1.1` 发起 HEAD 请求，超时设为 1 秒。在离线或防火墙环境中，首次调用会有 1 秒延迟。

- **部署环境检测中的 EC2 判定**：通过读取 `/sys/hypervisor/uuid` 文件判断是否为 EC2 实例，非 Linux 或无此文件时静默忽略错误。

- **`eagerParseCliFlag` 的局限**：仅做简单的线性扫描，不处理 Commander.js 的 `--` 分隔、选项别名等复杂场景，设计上只用于少数必须在初始化前解析的关键标志。