# MCP Server 入口

## 概述与职责

MCP Server 是 Claude Code 的三种启动模式之一（CLI、MCP Server、SDK），位于 **Entrypoints** 层。它通过 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 将 Claude Code 的全部内置工具暴露给外部客户端，使其他 AI 应用或自动化系统能够以标准化的 JSON-RPC 协议调用 Claude Code 的工具能力（文件读写、Bash 执行、Grep 搜索等）。

在整体架构中，MCP Server 与 CLI 入口（`cli.tsx`）和 SDK 入口（`sdk/`）是同级的启动模式。它依赖 **ToolSystem** 获取工具注册表和执行工具，但不依赖 **TerminalUI**（无交互式界面）和 **CoreEngine**（不启动对话主循环）。

> 源码位置：`src/entrypoints/mcp.ts`

## 关键流程

### 服务器启动流程

1. 调用 `startMCPServer(cwd, debug, verbose)` 启动服务
2. 创建一个 **带大小限制的 LRU 文件状态缓存**（最多 100 个文件，25MB 上限），防止内存无限增长（`src/entrypoints/mcp.ts:42-45`）
3. 通过 `setCwd(cwd)` 设置工作目录
4. 创建 `@modelcontextprotocol/sdk` 的 `Server` 实例，服务名称为 `"claude/tengu"`，版本号取自编译时宏 `MACRO.VERSION`（`src/entrypoints/mcp.ts:47-57`）
5. 注册两个请求处理器：`ListTools` 和 `CallTool`
6. 创建 `StdioServerTransport` 并连接，开始通过标准输入/输出进行 JSON-RPC 通信（`src/entrypoints/mcp.ts:190-193`）

### ListTools 处理流程

当外部客户端请求工具列表时：

1. 调用 `getEmptyToolPermissionContext()` 获取空的权限上下文
2. 调用 `getTools(toolPermissionContext)` 获取所有已注册工具
3. 对每个工具进行转换：
   - 调用 `tool.prompt()` 生成工具描述文本
   - 使用 `zodToJsonSchema()` 将 Zod input schema 转为 JSON Schema
   - 对于有 `outputSchema` 的工具，仅当根级别类型为 `"object"` 时才包含（跳过 `anyOf`/`oneOf` 等联合类型，因为 MCP SDK 要求 outputSchema 根级别必须是 `type: "object"`）（`src/entrypoints/mcp.ts:68-81`）
4. 返回符合 MCP 协议的工具列表

### CallTool 处理流程

当外部客户端调用某个工具时：

1. 通过 `findToolByName()` 查找目标工具，未找到则抛出错误（`src/entrypoints/mcp.ts:105-108`）
2. 构建 `ToolUseContext` 对象，包含：
   - 新创建的 `AbortController`
   - 配置项：命令列表（仅含 `review`）、工具列表、主循环模型、禁用 thinking、无 MCP 客户端、非交互模式等
   - 空消息列表和各种 no-op 回调函数
3. 检查工具是否启用（`tool.isEnabled()`）
4. 执行输入校验（`tool.validateInput()`），校验失败则抛出带详细信息的错误
5. 调用 `tool.call()` 执行工具，传入 `hasPermissionsToUseTool` 作为权限检查函数
6. **结果处理**：
   - 如果返回值是字符串，直接作为文本内容返回
   - 如果返回值是对象，将 `.data` 字段 JSON 序列化后返回
7. **错误处理**：捕获异常后通过 `getErrorParts()` 提取错误信息，设置 `isError: true` 返回（`src/entrypoints/mcp.ts:170-186`）

## 函数签名

### `startMCPServer(cwd: string, debug: boolean, verbose: boolean): Promise<void>`

MCP 服务器的唯一入口函数。

| 参数 | 类型 | 说明 |
|------|------|------|
| `cwd` | `string` | 工作目录路径，工具执行时的根目录 |
| `debug` | `boolean` | 是否启用调试模式，传递给工具上下文 |
| `verbose` | `boolean` | 是否启用详细输出，传递给工具上下文 |

返回一个 `Promise<void>`，服务器启动后持续监听标准输入直到进程结束。

## 类型定义

### `ToolInput` / `ToolOutput`

```typescript
type ToolInput = Tool['inputSchema']   // MCP 工具输入 schema 类型
type ToolOutput = Tool['outputSchema'] // MCP 工具输出 schema 类型
```

从 MCP SDK 的 `Tool` 类型中提取，用于 schema 转换时的类型约束。

### `ToolUseContext`（构建方式）

`CallTool` 处理器中手动构建的 `ToolUseContext` 对象（`src/entrypoints/mcp.ts:112-134`），关键字段：

| 字段 | 值 | 说明 |
|------|-----|------|
| `abortController` | 新创建的实例 | 用于取消正在执行的工具 |
| `options.commands` | `[review]` | 仅注册 `review` 命令 |
| `options.thinkingConfig` | `{ type: 'disabled' }` | 禁用 thinking 模式 |
| `options.mcpClients` | `[]` | 不连接外部 MCP 服务器 |
| `options.isNonInteractiveSession` | `true` | 标记为非交互模式 |
| `messages` | `[]` | 空消息历史 |
| `readFileState` | LRU 缓存 | 带大小限制的文件状态缓存 |

其余回调（`setAppState`、`setInProgressToolUseIDs`、`setResponseLength` 等）均为 no-op 空函数。

## 配置项与默认值

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 服务名称 | `"claude/tengu"` | MCP 服务器标识 |
| 服务版本 | `MACRO.VERSION` | 编译时注入的版本号 |
| 文件缓存数量上限 | 100 | LRU 缓存最大文件数 |
| 文件缓存大小上限 | 25MB | 隐含在 `createFileStateCacheWithSizeLimit` 中 |

## 边界 Case 与注意事项

- **outputSchema 兼容性**：MCP SDK 要求 `outputSchema` 根级别为 `type: "object"`。对于使用 `z.union` 或 `z.discriminatedUnion` 定义的工具输出（转换后为 `anyOf`/`oneOf`），会被跳过不返回。相关 issue：`#8014`（`src/entrypoints/mcp.ts:72-73`）

- **非交互模式**：`isNonInteractiveSession` 设为 `true`，这意味着需要用户确认的工具行为可能会有不同表现。权限检查仍然通过 `hasPermissionsToUseTool` 执行，但由于没有 UI 层，无法进行交互式权限授予。

- **无消息上下文**：`messages` 为空数组，工具执行时无法访问对话历史。这是设计上的取舍——MCP 协议假设工具调用的所有信息都通过参数传递（`src/entrypoints/mcp.ts:110-111`）。

- **命令限制**：`MCP_COMMANDS` 仅包含 `review` 命令（`src/entrypoints/mcp.ts:33`），不暴露 CLI 模式下的全部命令。

- **输入校验 TODO**：代码中标注了 `// TODO: validate input types with zod`（`src/entrypoints/mcp.ts:136`），当前未对输入参数做 Zod schema 校验，仅依赖工具自身的 `validateInput` 方法。

- **MCP 工具透传 TODO**：两处标注了 `// TODO: Also re-expose any MCP tools`（`src/entrypoints/mcp.ts:63, 103`），表示未来计划将 Claude Code 连接的外部 MCP 工具也通过此服务器透传出去，但当前未实现。