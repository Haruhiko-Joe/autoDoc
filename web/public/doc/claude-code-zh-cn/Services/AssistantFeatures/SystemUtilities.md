# SystemUtilities — 系统级辅助工具集合

## 概述与职责

SystemUtilities 是 **Services → AssistantFeatures** 层中的系统级辅助工具集合，包含三个独立的服务模块：

- **preventSleep**：通过 macOS `caffeinate` 命令防止系统进入空闲休眠，确保长时间运行的 API 请求和工具执行不被中断
- **diagnosticTracking**：集成 IDE MCP 客户端，追踪代码编辑前后的诊断信息变化（错误、警告等）
- **internalLogging**：仅限内部构建（`USER_TYPE=ant`），记录 Kubernetes 命名空间、容器 ID 等运行环境元数据和工具权限事件

这三个模块彼此独立，分别服务于不同的横切关注点：系统稳定性、代码质量反馈和内部可观测性。

---

## preventSleep — 防休眠服务

### 核心机制

preventSleep 采用**引用计数 + 定时重启**的设计：

1. 每次调用 `startPreventSleep()` 时引用计数 +1，首次启动时 spawn `caffeinate` 子进程
2. 每次调用 `stopPreventSleep()` 时引用计数 -1，归零时终止 `caffeinate` 进程
3. `caffeinate` 启动时附带 5 分钟超时（`-t 300`），每 4 分钟自动重启一次——这是**自愈机制**：即使 Node 进程被 SIGKILL 杀死（无法执行清理回调），孤儿 `caffeinate` 也会在超时后自动退出

```
caffeinate -i -t 300
```

- `-i`：仅阻止空闲休眠（显示器仍可关闭，是最温和的选项）
- `-t 300`：5 分钟后自动退出

> 源码位置：`src/services/preventSleep.ts:125-131`

### 函数签名

#### `startPreventSleep(): void`

递增引用计数，若为首次调用则启动 `caffeinate` 进程和重启定时器。在开始需要保持系统唤醒的工作时调用。

#### `stopPreventSleep(): void`

递减引用计数，归零时终止 `caffeinate` 进程并清除重启定时器。在工作完成时调用。

#### `forceStopPreventSleep(): void`

强制终止，忽略引用计数。用于进程退出时的清理，通过 `registerCleanup()` 注册为清理回调（`src/services/preventSleep.ts:113-118`）。

### 边界 Case 与注意事项

- **仅 macOS 生效**：所有核心函数在 `process.platform !== 'darwin'` 时直接返回，不会报错
- **进程不阻塞退出**：`caffeinate` 子进程和重启定时器都调用了 `.unref()`，不会阻止 Node 进程正常退出
- **终止使用 SIGKILL**：杀死 `caffeinate` 时使用 `SIGKILL` 而非 `SIGTERM`，确保立即终止（`src/services/preventSleep.ts:159`）
- **幂等保护**：已运行时重复调用 `spawnCaffeinate()` 或 `startRestartInterval()` 会直接返回

---

## diagnosticTracking — 诊断追踪服务

### 核心机制

`DiagnosticTrackingService` 是一个**单例服务**，通过 IDE 的 MCP 客户端（如 VS Code 扩展）收集代码诊断信息。它采用**基线对比**模式：

1. **编辑前**：调用 `beforeFileEdited()` 获取文件当前的诊断信息作为基线
2. **编辑后**：调用 `getNewDiagnostics()` 获取所有诊断，与基线对比找出**新增**的错误/警告

这使得系统能够区分「代码本身已有的问题」和「本次编辑引入的新问题」。

> 源码位置：`src/services/diagnosticTracking.ts:30-397`

### 关键流程

#### 查询生命周期

1. 每次新查询开始时，`handleQueryStart()` 被调用（`src/services/diagnosticTracking.ts:330-343`）
2. 首次调用时从 MCP 客户端列表中自动发现 IDE 客户端并初始化
3. 后续调用时重置所有追踪状态（基线、时间戳等），为新一轮编辑做准备

#### 诊断获取与对比流程

1. `beforeFileEdited(filePath)` 通过 `callIdeRpc('getDiagnostics', ...)` 获取指定文件的诊断（`src/services/diagnosticTracking.ts:135-182`）
2. 返回的诊断结果经路径规范化后存入 `baseline` Map
3. `getNewDiagnostics()` 获取全量诊断，筛选出有基线的文件，对比找出新增条目（`src/services/diagnosticTracking.ts:188-283`）
4. 支持 `_claude_fs_right:` 协议前缀——这是 diff 视图中右侧（编辑后）面板的诊断来源，优先级高于 `file://` 协议的诊断

### 类型定义

#### `Diagnostic`

| 字段 | 类型 | 说明 |
|------|------|------|
| message | `string` | 诊断消息文本 |
| severity | `'Error' \| 'Warning' \| 'Info' \| 'Hint'` | 严重程度 |
| range | `{ start: { line, character }, end: { line, character } }` | 代码位置范围 |
| source? | `string` | 产生诊断的工具（如 `typescript`） |
| code? | `string` | 诊断代码（如 `TS2345`） |

#### `DiagnosticFile`

| 字段 | 类型 | 说明 |
|------|------|------|
| uri | `string` | 文件 URI（`file://` 或 `_claude_fs_right:` 前缀） |
| diagnostics | `Diagnostic[]` | 该文件的诊断列表 |

### 函数签名

#### `DiagnosticTrackingService.getInstance(): DiagnosticTrackingService`

获取单例实例。

#### `initialize(mcpClient: MCPServerConnection): void`

注入 MCP 客户端连接，仅首次调用生效。

#### `handleQueryStart(clients: MCPServerConnection[]): Promise<void>`

查询开始时调用。首次自动从客户端列表中发现 IDE 客户端并初始化；后续调用重置追踪状态。

#### `beforeFileEdited(filePath: string): Promise<void>`

编辑文件前调用，获取并存储该文件的诊断基线。

#### `getNewDiagnostics(): Promise<DiagnosticFile[]>`

获取所有已追踪文件中新增的诊断信息（与基线对比后的增量）。

#### `ensureFileOpened(fileUri: string): Promise<void>`

确保文件已在 IDE 中打开，以便语言服务能正确生成诊断。

#### `static formatDiagnosticsSummary(files: DiagnosticFile[]): string`

将诊断结果格式化为人类可读的摘要字符串，超过 4000 字符时截断（`src/services/diagnosticTracking.ts:352-380`）。格式示例：

```
filename.ts:
  ✖ [Line 42:5] Type 'string' is not assignable to type 'number' [TS2345] (typescript)
  ⚠ [Line 10:1] 'x' is declared but never used [TS6133] (typescript)
```

### 边界 Case 与注意事项

- **静默降级**：若 IDE 未连接或不支持诊断 RPC，所有方法均静默返回空结果
- **路径规范化**：使用 `normalizePathForComparison()` 处理 Windows 大小写不敏感和路径分隔符差异
- **`_claude_fs_right:` 优先级**：当 diff 视图的右侧面板（编辑后版本）诊断发生变化时，优先使用该来源的诊断，以获取更准确的编辑后状态
- **诊断相等性判断**：基于 message、severity、source、code 和完整 range 进行深度比较（`src/services/diagnosticTracking.ts:296-306`）

---

## internalLogging — 内部环境日志

### 核心机制

此模块**仅在内部构建中启用**（`process.env.USER_TYPE === 'ant'`），用于记录 Anthropic 内部 Kubernetes 环境的元数据和工具权限上下文。所有函数在非内部环境中直接返回 `null` 或不执行任何操作。

### 函数签名

#### `getKubernetesNamespace(): Promise<string | null>`（内部，已 memoize）

从 `/var/run/secrets/kubernetes.io/serviceaccount/namespace` 读取当前 Kubernetes 命名空间。返回值如 `"default"`、`"ts"` 等。本地开发环境返回 `null`，文件不存在时返回 `"namespace not found"`。

> 源码位置：`src/services/internalLogging.ts:17-30`

#### `getContainerId(): Promise<string | null>`（导出，已 memoize）

从 `/proc/self/mountinfo` 解析 OCI 容器 ID（64 位十六进制），支持 Docker（`/docker/containers/`）和 containerd/CRI-O（`/sandboxes/`）两种路径模式。

> 源码位置：`src/services/internalLogging.ts:35-66`

#### `logPermissionContextForAnts(toolPermissionContext, moment): Promise<void>`

记录工具权限上下文事件，发送到分析系统（通过 `logEvent`）。

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| toolPermissionContext | `ToolPermissionContext \| null` | 当前工具权限上下文 |
| moment | `'summary' \| 'initialization'` | 记录时机——初始化阶段或摘要阶段 |

**发送的事件数据：**

| 字段 | 来源 | 说明 |
|------|------|------|
| moment | 参数 | 记录时机 |
| namespace | `getKubernetesNamespace()` | K8s 命名空间 |
| toolPermissionContext | 参数序列化 | 工具权限配置快照 |
| containerId | `getContainerId()` | 容器 ID |

> 源码位置：`src/services/internalLogging.ts:71-90`

### 边界 Case 与注意事项

- **环境守卫**：所有函数首先检查 `USER_TYPE !== 'ant'`，非内部环境零开销
- **Memoize 缓存**：`getKubernetesNamespace` 和 `getContainerId` 均使用 `lodash-es/memoize` 缓存，整个进程生命周期内只读取一次文件系统
- **类型安全标注**：所有传递给 `logEvent` 的字符串值都使用 `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` 类型断言，表明开发者已验证这些数据不包含代码或文件路径（防止隐私泄露）