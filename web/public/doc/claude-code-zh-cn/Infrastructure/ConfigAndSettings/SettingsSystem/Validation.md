# 设置校验子系统（Validation）

## 概述与职责

设置校验子系统是 **Infrastructure → ConfigAndSettings → SettingsSystem** 中的质量守门员，负责确保所有设置文件内容在加载和编辑时都符合 `SettingsSchema` 的约束。它由五个文件组成，各自承担一个明确的职责：

- **validation.ts** — 核心校验引擎：Zod 错误格式化、字段级校验、整文件校验
- **permissionValidation.ts** — 权限规则语法校验（工具名大小写、括号匹配、MCP/Bash/文件模式规则）
- **toolValidationConfig.ts** — 各工具的特殊校验规则配置（文件模式工具、Bash 前缀工具、自定义校验）
- **validationTips.ts** — 为常见校验错误匹配修复建议和文档链接
- **validateEditTool.ts** — Edit 工具修改设置文件时的拦截校验

同级兄弟模块包括 GlobalConfig（全局配置读写）、EnvironmentAndCLI（环境检测）、Constants（常量定义）、BootstrapState（启动状态）和 Migrations（配置迁移）。校验子系统被 SettingsSystem 中的设置加载流程调用，也被 Edit 工具在运行时调用。

## 关键流程

### 流程一：设置文件加载时的校验与容错

当设置文件从磁盘加载后，系统调用 `filterInvalidPermissionRules()` 预处理权限规则：

1. 检查 `data.permissions` 下的 `allow`、`deny`、`ask` 数组（`validation.ts:234`）
2. 对每条规则调用 `validatePermissionRule()` 进行语法校验
3. **移除**不合法的规则（而非拒绝整个文件），并收集 `ValidationError[]` 作为警告
4. 清洗后的数据再交给 `SettingsSchema().safeParse()` 做完整 Zod 校验

这种"先过滤再校验"的设计确保一条坏规则不会导致整个设置文件无法使用。

### 流程二：权限规则的多层校验

`validatePermissionRule()`（`permissionValidation.ts:58-239`）对单条权限规则执行以下校验链：

1. **空值检查** — 规则不能为空
2. **括号匹配** — 使用转义感知的 `countUnescapedChar()` 计数未转义的 `(` 和 `)` 是否配对
3. **空括号检查** — `Tool()` 形式不合法，建议移除括号或添加模式
4. **MCP 规则校验** — 通过 `mcpInfoFromString()` 判断，MCP 规则不支持括号内的模式
5. **工具名校验** — 非 MCP 工具名必须以大写字母开头
6. **自定义校验** — 查询 `toolValidationConfig` 获取工具专属校验函数
7. **Bash 前缀校验** — `:*` 必须在末尾，不能孤立使用
8. **文件模式校验** — 文件工具不能使用 `:*` 语法，通配符需在路径边界

校验结果包含 `valid`、`error`、`suggestion` 和 `examples` 字段，为用户提供清晰的修复指引。

### 流程三：Edit 工具的设置文件保护

当 Edit 工具修改设置文件时，`validateInputForSettingsFileEdit()`（`validateEditTool.ts:14-45`）执行拦截：

1. 通过 `isClaudeSettingsPath()` 判断目标文件是否为 Claude 设置文件，非设置文件直接放行
2. 对编辑前的内容执行 `validateSettingsFileContent()` — 如果编辑前就不合法，**允许编辑**（避免锁死用户）
3. 如果编辑前合法，对编辑后的内容再次校验 — 不合法则**拒绝编辑**，返回错误信息和完整 JSON Schema

核心逻辑：**只有"从合法变为不合法"的编辑会被阻止**，这是一个重要的设计决策。

### 流程四：Zod 错误的人性化格式化

`formatZodError()`（`validation.ts:97-173`）将 Zod v4 的原始 `ZodError` 转换为用户友好的 `ValidationError[]`：

1. 遍历每个 `ZodIssue`，通过类型守卫函数判断错误类型
2. 根据不同的 issue code 生成定制化的错误消息：
   - `invalid_type` → `"Expected string, but received number"`
   - `invalid_value` → `"Invalid value. Expected one of: ..."`
   - `unrecognized_keys` → `"Unrecognized fields: foo, bar"`
   - `too_small` → `"Number must be greater than or equal to 0"`
3. 对根路径的 `object expected, null received` 特判为 `"Invalid or malformed JSON"`
4. 调用 `getValidationTip()` 附加修复建议和文档链接

## 函数签名与参数说明

### `formatZodError(error: ZodError, filePath: string): ValidationError[]`

将 Zod 校验错误格式化为结构化的 `ValidationError` 数组。

- **error** — Zod v4 的 `ZodError` 对象
- **filePath** — 出错文件的相对路径，用于标注在错误信息中

> 源码位置：`src/utils/settings/validation.ts:97-173`

### `validateSettingsFileContent(content: string): { isValid: true } | { isValid: false; error: string; fullSchema: string }`

校验设置文件的完整内容。先解析 JSON，再用 `SettingsSchema().strict()` 做严格校验。校验失败时附带完整 JSON Schema 供参考。

> 源码位置：`src/utils/settings/validation.ts:179-217`

### `filterInvalidPermissionRules(data: unknown, filePath: string): ValidationError[]`

在 Zod 校验前过滤掉无效的权限规则。直接修改传入的 `data` 对象（移除无效规则），返回警告列表。

> 源码位置：`src/utils/settings/validation.ts:224-265`

### `validatePermissionRule(rule: string): { valid: boolean; error?: string; suggestion?: string; examples?: string[] }`

校验单条权限规则的语法和语义。覆盖 MCP 规则、Bash 前缀规则、文件模式规则和自定义工具规则。

> 源码位置：`src/utils/settings/permissionValidation.ts:58-239`

### `validateInputForSettingsFileEdit(filePath: string, originalContent: string, getUpdatedContent: () => string): Extract<ValidationResult, { result: false }> | null`

Edit 工具的设置文件校验拦截器。返回 `null` 表示放行，返回对象表示拒绝编辑。

- **getUpdatedContent** — 惰性求值闭包，仅在需要校验编辑后内容时才调用

> 源码位置：`src/utils/settings/validateEditTool.ts:14-45`

### `getValidationTip(context: TipContext): ValidationTip | null`

根据校验错误的上下文匹配修复建议。返回 `suggestion`（修复建议文本）和 `docLink`（文档链接）。

> 源码位置：`src/utils/settings/validationTips.ts:140-164`

## 接口/类型定义

### `ValidationError`

校验错误的统一表示：

| 字段 | 类型 | 说明 |
|------|------|------|
| file | `string?` | 出错的文件路径 |
| path | `string` | 字段路径，点分表示法（如 `permissions.allow`） |
| message | `string` | 人类可读的错误描述 |
| expected | `string?` | 期望的值或类型 |
| invalidValue | `unknown?` | 实际传入的无效值 |
| suggestion | `string?` | 修复建议 |
| docLink | `string?` | 相关文档链接 |
| mcpErrorMetadata | `object?` | MCP 特有的错误元数据（scope、serverName、severity） |

> 源码位置：`src/utils/settings/validation.ts:48-72`

### `ToolValidationConfig`

工具校验配置结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| filePatternTools | `string[]` | 接受文件 glob 模式的工具列表 |
| bashPrefixTools | `string[]` | 接受 Bash 通配符和 `:*` 前缀的工具列表 |
| customValidation | `Record<string, (content) => result>` | 工具专属的自定义校验函数 |

> 源码位置：`src/utils/settings/toolValidationConfig.ts:8-24`

### `PermissionRuleSchema`

Zod schema，基于 `z.string().superRefine()` 构建，内部调用 `validatePermissionRule()` 进行校验。用于 `SettingsSchema` 中权限规则数组的元素类型定义。

> 源码位置：`src/utils/settings/permissionValidation.ts:244-262`

## 配置项与默认值

### 工具校验配置（`TOOL_VALIDATION_CONFIG`）

- **文件模式工具**：`Read`、`Write`、`Edit`、`Glob`、`NotebookRead`、`NotebookEdit` — 这些工具的权限规则参数按 glob 模式校验
- **Bash 前缀工具**：`Bash` — 支持通配符 `*` 和旧版 `:*` 前缀语法
- **WebSearch 自定义校验**：禁止使用 `*` 和 `?` 通配符
- **WebFetch 自定义校验**：必须使用 `domain:` 前缀格式，不接受完整 URL

> 源码位置：`src/utils/settings/toolValidationConfig.ts:26-88`

### 文档链接映射

`validationTips.ts` 中的 `PATH_DOC_LINKS` 按字段路径前缀映射到文档 URL：
- `permissions` → `https://code.claude.com/docs/en/iam#configuring-permissions`
- `env` → `https://code.claude.com/docs/en/settings#environment-variables`
- `hooks` → `https://code.claude.com/docs/en/hooks`

> 源码位置：`src/utils/settings/validationTips.ts:134-138`

## 边界 Case 与注意事项

- **编辑前已损坏的设置文件不会被锁死**：`validateInputForSettingsFileEdit()` 在编辑前内容就不合法时直接放行，避免用户无法修复已损坏的设置文件（`validateEditTool.ts:27-29`）

- **`filterInvalidPermissionRules` 是就地修改**：它直接修改传入的 `data` 对象而非返回新对象。调用者需注意这一副作用

- **转义感知的括号校验**：`permissionValidation.ts` 中的 `isEscaped()` 函数通过计算前导反斜杠的奇偶性来判断字符是否被转义，支持 `\(` 这样的转义括号出现在规则中

- **Bash 引号不做校验**：代码注释明确说明不校验引号平衡（`permissionValidation.ts:183-185`），因为 Bash 的引号规则过于复杂（如 `grep '"'` 中的不平衡双引号是合法的）

- **`SettingsSchema().strict()` 模式**：`validateSettingsFileContent()` 使用 strict 模式校验，即不允许 schema 中未定义的额外字段

- **Tip 匹配的顺序敏感性**：`TIP_MATCHERS` 数组使用 `find()` 返回第一个匹配项，因此更具体的 matcher 应排在前面。例如 `permissions.defaultMode` 的精确匹配排在通用 `invalid_value` 匹配之前