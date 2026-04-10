# 沙箱决策、输出处理与 UI 渲染

## 概述与职责

本模块是 BashTool 的"后半段"——当命令的安全校验和权限检查完成后，这些文件负责三件事：

1. **沙箱决策**：决定一条命令是否应在沙箱中执行（`shouldUseSandbox.ts`）
2. **输出语义解释**：理解不同命令退出码的真实含义（`commandSemantics.ts`），解析 sed 编辑命令用于富渲染（`sedEditParser.ts`），格式化和处理命令输出（`utils.ts`）
3. **UI 渲染**：将命令执行的全过程（进行中 → 完成/出错）渲染为终端界面（`UI.tsx`、`BashToolResultMessage.tsx`）

在系统层级中，本模块属于 **ToolSystem → ShellTools → BashTool** 的一部分。BashTool 是整个工具系统中最常用的工具之一，而本模块负责其沙箱决策和输出呈现层。同级的 PowerShellTool 会复用本模块的 `shouldUseSandbox`、`BackgroundHint` 组件和 `utils` 中的图片处理等函数。

---

## 关键流程

### 1. 沙箱决策流程（shouldUseSandbox）

`shouldUseSandbox()` 在每次 Bash 命令执行前被调用，决定是否启用沙箱隔离。判断逻辑为一条链式短路：

1. 检查 `SandboxManager.isSandboxingEnabled()` 全局开关——若关闭，直接返回 `false`
2. 检查用户是否通过 `dangerouslyDisableSandbox` 参数显式禁用，且策略允许非沙箱命令——若满足，返回 `false`
3. 检查命令是否为空——空命令不需要沙箱
4. 调用 `containsExcludedCommand()` 检查命令是否匹配用户配置的排除列表——若匹配，返回 `false`
5. 以上全不命中时，返回 `true`（启用沙箱）

> 源码位置：`src/tools/BashTool/shouldUseSandbox.ts:130-153`

### 2. 排除命令匹配流程

`containsExcludedCommand()` 是沙箱决策中最复杂的部分，它做两层检查：

**动态配置检查**（仅 `ant` 用户类型）：从 Growthbook 特性开关读取 `tengu_sandbox_disabled_commands`，匹配命令名和子字符串。

**用户配置检查**：从 `settings.sandbox.excludedCommands` 读取排除规则，对复合命令（如 `cmd1 && cmd2`）逐一检查每个子命令。关键在于匹配前会进行**不动点迭代剥离**——反复去除环境变量前缀（如 `FOO=bar`）和安全包装命令（如 `timeout 30`），直到无法再剥离为止，然后对每个候选形式进行三种模式匹配：

- **前缀匹配**（`prefix`）：命令以指定前缀开头
- **精确匹配**（`exact`）：命令完全相同
- **通配符匹配**（`wildcard`）：支持 `*` 通配符

> 源码位置：`src/tools/BashTool/shouldUseSandbox.ts:21-128`

**重要提示**：文件顶部注释明确说明 `excludedCommands` 是用户便利功能，**不是安全边界**。真正的安全控制是沙箱权限系统。

### 3. 命令退出码语义解释

`interpretCommandResult()` 对命令退出码进行语义化解释，避免将"正常的非零退出码"误判为错误：

| 命令 | 退出码 0 | 退出码 1 | 退出码 ≥2 |
|------|----------|----------|-----------|
| `grep`/`rg` | 找到匹配 | 无匹配（非错误） | 真正的错误 |
| `find` | 成功 | 部分目录不可访问 | 错误 |
| `diff` | 无差异 | 有差异（非错误） | 错误 |
| `test`/`[` | 条件为真 | 条件为假（非错误） | 错误 |
| 其他命令 | 成功 | 错误 | 错误 |

流程：从复合命令中提取**最后一个子命令**的基础命令名（因为管道中最后一个命令决定退出码），然后查表获取语义解释函数。

> 源码位置：`src/tools/BashTool/commandSemantics.ts:31-89`

### 4. sed 编辑命令解析流程

`parseSedEditCommand()` 将 `sed -i 's/pattern/replacement/flags' file` 解析为结构化的 `SedEditInfo`，使 UI 层能以"文件编辑"风格展示 sed 操作（类似 FileEditTool 的渲染效果），而非显示原始命令文本。

解析步骤：
1. 验证命令以 `sed` 开头
2. 使用 `tryParseShellCommand()` 进行 Shell 引号感知的 token 化
3. 逐个解析参数：识别 `-i`（含可选备份后缀）、`-E`/`-r`（扩展正则）、`-e`（表达式）等标志
4. 解析 `s/pattern/replacement/flags` 替换表达式，处理转义字符
5. 校验替换标志（仅允许 `g`、`p`、`i`、`m`、`I`、`M`、`1-9`）

`applySedSubstitution()` 将解析结果应用于文件内容，核心难点在于 **BRE→ERE 转换**：基础正则（BRE）和扩展正则（ERE）中元字符的转义规则相反（BRE 中 `\+` 是"一个或多个"，而 ERE/JS 中 `+` 是"一个或多个"）。通过占位符替换法完成四步转换。

> 源码位置：`src/tools/BashTool/sedEditParser.ts:49-238`（解析），`244-322`（应用替换）

### 5. 输出格式化与图片处理

`utils.ts` 提供命令输出的后处理管线：

- **`formatOutput()`**：检测输出是否为图片（base64 data URI），若是则直接返回；否则按 `getMaxOutputLength()` 截断，并附上截断行数提示
- **`resizeShellImageOutput()`**：处理图片输出的缩放——如果输出被截断（base64 被切断会导致解码失败），从磁盘文件重新读取完整数据，然后调用 `maybeResizeAndDownsampleImageBuffer()` 压缩图片（文件上限 20MB）
- **`resetCwdIfOutsideProject()`**：命令执行后检查工作目录是否越界，若越出允许范围则重置到原始目录，并记录遥测事件
- **`createContentSummary()`**：为 MCP 返回的结构化内容（含图片和文本块）生成人类可读摘要

> 源码位置：`src/tools/BashTool/utils.ts:133-165`（formatOutput），`110-131`（resizeShellImageOutput），`170-192`（resetCwdIfOutsideProject）

### 6. UI 渲染流程

UI 层由两个 React/Ink 组件协作完成命令执行的全生命周期渲染：

**UI.tsx** 提供 5 个渲染函数，覆盖工具使用的各个阶段：

| 函数 | 阶段 | 行为 |
|------|------|------|
| `renderToolUseMessage()` | 命令发起时 | sed 命令显示为文件路径；普通命令截断（≤2行/160字符） |
| `renderToolUseProgressMessage()` | 执行中 | 委托 `ShellProgressMessage` 显示实时输出和耗时 |
| `renderToolUseQueuedMessage()` | 排队等待 | 显示 "Waiting…" |
| `renderToolResultMessage()` | 执行完成 | 委托 `BashToolResultMessage` 渲染结果 |
| `renderToolUseErrorMessage()` | 出错 | 委托 `FallbackToolUseErrorMessage` |

**BackgroundHint 组件**：监听 `task:background` 快捷键（默认 `ctrl+b`，tmux 环境下需按两次），将所有前台运行的命令转为后台任务。

> 源码位置：`src/tools/BashTool/UI.tsx:31-84`（BackgroundHint），`85-130`（renderToolUseMessage）

**BashToolResultMessage.tsx** 负责最终结果的渲染，包含多层信息提取：

1. **沙箱违规提取**：从 stderr 中解析 `<sandbox_violations>` 标签内容并清理
2. **工作目录重置提示提取**：从 stderr 中分离 "Shell cwd was reset to …" 警告
3. **条件渲染**：
   - 图片输出 → 显示 `[Image data detected and sent to Claude]`
   - 有 stdout/stderr → 分别渲染为普通输出和错误输出（`OutputLine` 组件）
   - 无输出 → 显示 `(No output)` 或退出码语义解释文本
   - 后台任务 → 显示 "Running in the background" + 管理快捷键提示
   - 有超时 → 显示 `ShellTimeDisplay` 计时信息

> 源码位置：`src/tools/BashTool/BashToolResultMessage.tsx:24-65`（信息提取），`66-190`（渲染逻辑）

---

## 函数签名与参数说明

### `shouldUseSandbox(input: Partial<SandboxInput>): boolean`

判断命令是否需要在沙箱中执行。

- **input.command**：待执行的命令字符串
- **input.dangerouslyDisableSandbox**：用户是否显式禁用沙箱
- **返回值**：`true` 表示应启用沙箱

### `interpretCommandResult(command, exitCode, stdout, stderr): { isError, message? }`

解释命令退出码的语义。

- **command**：原始命令字符串（用于识别基础命令名）
- **exitCode**：命令退出码
- **返回值**：`isError` 标识是否为真正的错误，`message` 提供可选的人类可读说明

### `parseSedEditCommand(command: string): SedEditInfo | null`

解析 sed 就地编辑命令，返回结构化编辑信息或 `null`（非 sed 编辑命令）。

### `applySedSubstitution(content: string, sedInfo: SedEditInfo): string`

将 sed 替换规则应用于文件内容，返回替换后的新内容。处理 BRE/ERE 转换和 sed 特有的替换语法（`&` → 全匹配、`\&` → 字面 `&`）。

### `formatOutput(content: string): { totalLines, truncatedContent, isImage? }`

格式化命令输出，检测图片并按长度限制截断。

### `resizeShellImageOutput(stdout, outputFilePath?, outputFileSize?): Promise<string | null>`

异步缩放图片输出，处理截断恢复和尺寸压缩。

### `resetCwdIfOutsideProject(toolPermissionContext): boolean`

检查并重置越界的工作目录，返回 `true` 表示发生了重置。

---

## 接口/类型定义

### `SandboxInput`

```typescript
type SandboxInput = {
  command?: string
  dangerouslyDisableSandbox?: boolean
}
```

### `SedEditInfo`

```typescript
type SedEditInfo = {
  filePath: string        // 被编辑的文件路径
  pattern: string         // 搜索模式（正则）
  replacement: string     // 替换字符串
  flags: string           // 替换标志（g, i 等）
  extendedRegex: boolean  // 是否使用扩展正则（-E/-r 标志）
}
```

### `CommandSemantic`

```typescript
type CommandSemantic = (
  exitCode: number,
  stdout: string,
  stderr: string,
) => { isError: boolean; message?: string }
```

---

## 配置项与默认值

| 配置项 | 来源 | 说明 |
|--------|------|------|
| `sandbox.excludedCommands` | 用户 settings | 不需要沙箱的命令模式列表，支持前缀/精确/通配符 |
| `tengu_sandbox_disabled_commands` | Growthbook 特性开关 | 动态禁用沙箱的命令列表（仅 `ant` 用户类型） |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | 环境变量 | 为 truthy 时隐藏后台任务提示 |
| `MAX_COMMAND_DISPLAY_LINES` | 常量（= 2） | 非 verbose 模式下命令显示的最大行数 |
| `MAX_COMMAND_DISPLAY_CHARS` | 常量（= 160） | 非 verbose 模式下命令显示的最大字符数 |
| `MAX_IMAGE_FILE_SIZE` | 常量（= 20MB） | 图片文件读取的最大尺寸 |

---

## 边界 Case 与注意事项

- **复合命令安全**：`containsExcludedCommand()` 会将 `&&`、`;`、`|` 连接的复合命令拆分为子命令逐一检查，防止通过 `excluded_cmd && malicious_cmd` 绕过沙箱
- **环境变量/包装命令剥离**：使用不动点迭代（fixed-point）剥离环境变量前缀和安全包装命令（如 `timeout`），处理交错模式如 `timeout 300 FOO=bar bazel run`
- **sed 解析限制**：仅支持 `/` 作为分隔符、单文件、单表达式的简单 sed 命令；遇到 glob 模式、多文件、未知标志等情况会返回 `null` 放弃解析
- **BRE/ERE 正则转换**：sed 默认使用 BRE（基础正则），需要四步占位符转换才能映射到 JavaScript 的 ERE 语法
- **图片截断恢复**：命令输出默认按字符数截断，但截断的 base64 数据会解码为损坏图片。`resizeShellImageOutput()` 在检测到截断时从磁盘文件重新读取完整数据
- **tmux 快捷键冲突**：`ctrl+b` 在 tmux 中是前缀键，UI 层自动检测并提示用户需要按两次
- **退出码语义**：仅对管道/复合命令的**最后一个子命令**应用语义规则，因为 Shell 默认以最后一个命令的退出码作为整体退出码