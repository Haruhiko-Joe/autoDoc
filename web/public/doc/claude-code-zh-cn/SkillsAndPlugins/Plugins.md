# 插件注册与管理系统

## 概述与职责

插件系统（`src/plugins/`）是 Claude Code **内置插件**（Built-in Plugins）的注册与生命周期管理模块。它位于 **SkillsAndPlugins** 层级下，与 `skills/` 目录中的技能系统并列——两者共同实现 Claude Code 的领域能力扩展。

与直接编译进 CLI 的 bundled skills 不同，内置插件具有以下特性：

- 出现在 `/plugin` UI 中的"Built-in"分区
- 用户可手动启用/禁用，状态持久化到用户设置
- 一个插件可包含多个组件：技能（skills）、hooks、MCP 服务器

插件 ID 采用 `{name}@builtin` 格式，与市场插件（`{name}@{marketplace}`）明确区分。

该模块由两个文件组成：
- **`builtinPlugins.ts`**：核心注册表与查询 API
- **`bundled/index.ts`**：启动时初始化入口，为未来插件迁移预留

## 关键流程

### 插件注册流程

1. CLI 启动时调用 `initBuiltinPlugins()`（`src/plugins/bundled/index.ts:20`）
2. 该函数内部调用 `registerBuiltinPlugin()` 将每个插件定义写入模块级 `Map`
3. 当前尚无内置插件注册，`initBuiltinPlugins()` 为空实现——这是一个为将 bundled skills 迁移为可切换插件而预留的脚手架

### 插件启用/禁用判定流程

`getBuiltinPlugins()` 是核心查询函数（`builtinPlugins.ts:57-102`），其判定逻辑如下：

1. 遍历 `BUILTIN_PLUGINS` Map 中所有已注册的插件定义
2. **可用性过滤**：如果插件定义了 `isAvailable()` 且返回 `false`，该插件被完全隐藏
3. **启用状态判定**（三级优先级）：
   - 用户设置 `settings.enabledPlugins[pluginId]`（最高优先级）
   - 插件定义的 `defaultEnabled` 字段
   - 缺省值 `true`（即默认启用）
4. 将每个插件封装为 `LoadedPlugin` 对象，按启用/禁用分组返回

```typescript
// 启用状态的三级优先级判定  builtinPlugins.ts:73-76
const isEnabled =
  userSetting !== undefined
    ? userSetting === true
    : (definition.defaultEnabled ?? true)
```

### 技能转换为命令流程

`getBuiltinPluginSkillCommands()` 将已启用插件中的技能暴露为 `Command` 对象（`builtinPlugins.ts:108-121`）：

1. 调用 `getBuiltinPlugins()` 获取已启用插件列表
2. 遍历每个插件的 `skills` 数组
3. 通过 `skillDefinitionToCommand()` 将 `BundledSkillDefinition` 转换为 `Command`

转换时有一个关键设计决策：`Command.source` 设置为 `'bundled'` 而非 `'builtin'`（`builtinPlugins.ts:145-149`）。这是因为在 Command 体系中，`'builtin'` 表示硬编码的斜杠命令（如 `/help`、`/clear`），而 `'bundled'` 才能确保技能出现在 Skill tool 的列表中、被正确记录分析名称、并免于 prompt 截断。用户可切换的特性通过 `LoadedPlugin.isBuiltin` 标记来追踪。

## 函数签名与参数说明

### `registerBuiltinPlugin(definition: BuiltinPluginDefinition): void`

注册一个内置插件到全局注册表。应在 `initBuiltinPlugins()` 中调用。

> 源码位置：`src/plugins/builtinPlugins.ts:28-32`

### `isBuiltinPluginId(pluginId: string): boolean`

检查插件 ID 是否以 `@builtin` 结尾，判断其是否为内置插件。

> 源码位置：`src/plugins/builtinPlugins.ts:37-39`

### `getBuiltinPluginDefinition(name: string): BuiltinPluginDefinition | undefined`

按名称查询插件定义。用于 `/plugin` UI 展示插件包含的技能/hooks/MCP 服务器列表，无需市场查询。

> 源码位置：`src/plugins/builtinPlugins.ts:46-50`

### `getBuiltinPlugins(): { enabled: LoadedPlugin[]; disabled: LoadedPlugin[] }`

返回所有已注册的内置插件，按启用/禁用状态分组。不可用的插件（`isAvailable()` 返回 `false`）被完全忽略。

> 源码位置：`src/plugins/builtinPlugins.ts:57-102`

### `getBuiltinPluginSkillCommands(): Command[]`

返回所有已启用内置插件中的技能，转换为 `Command` 对象数组。禁用插件的技能不会出现。

> 源码位置：`src/plugins/builtinPlugins.ts:108-121`

### `clearBuiltinPlugins(): void`

清空插件注册表，仅用于测试。

> 源码位置：`src/plugins/builtinPlugins.ts:126-128`

### `initBuiltinPlugins(): void`

CLI 启动时调用的初始化入口。当前为空实现，预留给未来的插件注册。

> 源码位置：`src/plugins/bundled/index.ts:20-23`

## 接口/类型定义

### `BuiltinPluginDefinition`（定义于 `src/types/plugin.ts:18-35`）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | 是 | 插件名称，用于构造 `{name}@builtin` ID |
| `description` | `string` | 是 | 显示在 `/plugin` UI 中的描述 |
| `version` | `string` | 否 | 版本号 |
| `skills` | `BundledSkillDefinition[]` | 否 | 插件提供的技能列表 |
| `hooks` | `HooksSettings` | 否 | 插件提供的 hooks 配置 |
| `mcpServers` | `Record<string, McpServerConfig>` | 否 | 插件提供的 MCP 服务器 |
| `isAvailable` | `() => boolean` | 否 | 可用性检查（如依赖系统能力），返回 `false` 则完全隐藏 |
| `defaultEnabled` | `boolean` | 否 | 用户未设置偏好时的默认启用状态，缺省为 `true` |

### `LoadedPlugin`（定义于 `src/types/plugin.ts:48-68`）

插件加载后的运行时表示。内置插件构建 `LoadedPlugin` 时的特殊赋值：
- `path` 设为 `'builtin'` 哨兵值（无文件系统路径）
- `source` 和 `repository` 均设为 `{name}@builtin`
- `isBuiltin` 设为 `true`

## 边界 Case 与注意事项

- **Command.source 的 `'bundled'` vs `'builtin'` 区别**：这是最容易混淆的设计点。在 Command 命名空间中，`'builtin'` 专指 `/help`、`/clear` 等硬编码命令，而插件技能必须使用 `'bundled'` 才能正确进入 Skill tool 的调度链路。"内置插件"的可切换属性由 `LoadedPlugin.isBuiltin` 标记，而非 `Command.source`
- **当前无注册插件**：`initBuiltinPlugins()` 目前为空实现。注释中明确说明这是为迁移 bundled skills 而预留的基础设施。添加新插件只需在该函数中调用 `registerBuiltinPlugin()`
- **与 `src/skills/bundled/` 的分界**：文件注释明确指出，具有复杂设置逻辑或自动启用逻辑的特性（如 chrome 集成）应放在 `skills/bundled/` 中，而非作为内置插件。内置插件适用于需要用户显式切换的功能
- **设置读取使用了 `getSettings_DEPRECATED()`**：启用状态的持久化依赖已标记为废弃的设置 API，未来可能需要迁移