# JavaScript REPL 引擎（JsRepl）

## 概述与职责

JsRepl 是 Codex 的内嵌 JavaScript 执行引擎，允许 LLM 模型在对话过程中直接运行 JavaScript 代码片段。它位于 **Core → ToolsOrchestration** 层级下，作为一个内置工具（`js_repl`）被工具路由器调度执行。

该模块由两大部分组成：

1. **Rust 侧的 `JsReplManager`**（`mod.rs`）：管理 Node.js 子进程的生命周期、通过 JSON Lines 协议与内核通信、处理超时/错误/重置逻辑
2. **JavaScript 侧的 `kernel.js`**：在 Node.js `vm` 模块中构建一个持久化 REPL 环境，支持 ESM 模块、变量跨 cell 持久化、AST 级别的表达式检测

同级兄弟模块包括 shell 执行、apply-patch、MCP 工具、多 Agent 工具等其他工具处理器。

## 关键流程

### 1. 会话启动与内核初始化

当模型首次调用 `js_repl` 工具时，`JsReplHandle` 通过 `OnceCell` 懒初始化一个 `JsReplManager` 实例（`mod.rs:90-97`）。Manager 创建临时目录并准备好内核脚本，但 **不立即启动 Node 进程**——内核在第一次 `execute()` 调用时按需启动。

启动流程（`start_kernel`，`mod.rs:1002-1159`）：

1. 调用 `resolve_compatible_node()` 查找并验证 Node.js 版本（需 >= `node-version.txt` 指定版本）
2. 将 `kernel.js` 和 `meriyah.umd.min.js` 写入临时目录
3. 构建环境变量（包括 `CODEX_JS_TMP_DIR`、`CODEX_JS_REPL_NODE_MODULE_DIRS`、`CODEX_THREAD_ID` 等）
4. 通过沙箱系统（SandboxManager）配置安全策略后，以 `node --experimental-vm-modules kernel.js` 启动子进程
5. 启动两个 tokio 任务分别读取 stdout（JSON Lines 消息流）和 stderr（诊断日志）

### 2. 代码执行流程

`execute()` 方法是核心入口（`mod.rs:836-1000`）：

1. **获取执行锁**：通过 `Semaphore(1)` 确保同一时刻只有一个代码片段在执行
2. **确保内核运行**：若内核未启动则启动之，并标记 `TopLevelExecState::FreshKernel`
3. **生成请求 ID**：使用 UUID 创建唯一 exec_id，注册 oneshot channel 等待结果
4. **发送 `exec` 消息**：通过 stdin 发送 JSON 消息 `{ type: "exec", id, code, timeout_ms }`
5. **等待结果**：带超时等待 oneshot channel，默认 30 秒

超时处理：超时后整个内核被 reset（kill 并清空状态），下次执行自动重启。

### 3. kernel.js 中的 REPL Cell 模型

kernel.js 的核心设计是一个 **ESM cell 链**——每次 `exec` 都编译为一个独立的 `SourceTextModule`，通过 `@prev` 合成模块桥接前一个 cell 的命名空间（`kernel.js:1569-1687`）。

具体步骤：

1. **AST 解析**：使用 Meriyah 解析器将代码解析为 EST（`kernel.js:959-967`），收集所有顶级绑定（`collectBindings`，`kernel.js:524-562`）
2. **代码插桩**：
   - 为变量声明、函数声明、类声明插入 `markCommittedBindings` 标记，用于在部分执行失败时精确恢复已初始化的绑定
   - 通过 `import.meta.__codexInternalMarkCommittedBindings` 注入标记函数，随后立即删除以防止用户代码伪造
3. **构建模块源码**（`buildModuleSource`，`kernel.js:959-1047`）：
   - 如有前一个 cell，生成 `import * as __prev from "@prev"` 并重新声明所有已知绑定
   - 追加 `export { ... }` 导出合并后的绑定集
4. **链接与执行**：通过 `vm.SourceTextModule` 的 `link()` + `evaluate()` 运行代码
5. **console 捕获**：用 `withCapturedConsole` 替换 `console.log/info/warn/error/debug`，将所有输出收集到 `logs` 数组（`kernel.js:1166-1191`）

### 4. 失败 Cell 的绑定恢复

当 cell 执行抛出异常时，kernel.js 不会丢弃所有状态（`kernel.js:1651-1681`）：

- **词法绑定**（`const`/`let`/`class`）：通过尝试读取模块命名空间来判断是否已初始化
- **`var`/`function` 绑定**：仅在显式的声明站标记（`markCommittedBindings`）触发后才保留
- 通过 `collectCommittedBindings`（`kernel.js:1068-1095`）计算出应保留的绑定集合，更新 `previousModule` 和 `previousBindings`

### 5. `codex.tool()` 桥接机制

kernel.js 暴露了 `codex.tool(toolName, args)` API（`kernel.js:1444-1478`），允许 JS 代码调用其他 Codex 工具：

1. JS 侧构建 `{ type: "run_tool", id, exec_id, tool_name, arguments }` 消息并通过 stdout 发送
2. 注册一个 Promise resolver 到 `pendingTool` Map
3. Rust 侧在 `read_stdout` 循环中收到 `RunTool` 消息后，spawn 一个 tokio 任务执行（`mod.rs:1395-1466`）
4. Rust 侧通过 `ToolRouter::dispatch_tool_call_with_code_mode_result()` 路由到实际的工具处理器
5. 结果通过 `HostToKernel::RunToolResult` 写回 stdin，kernel.js 中 `handleToolResult` 解析后 resolve Promise

**安全限制**：`js_repl` 不能调用自身（`is_js_repl_internal_tool` 检查，`mod.rs:1768-1770`）。

### 6. `codex.emitImage()` 图片发射

类似 `codex.tool()`，但专门用于将图片数据传递给模型（`kernel.js:1480-1539`）：

- 支持 data URL 字符串、`{ bytes, mimeType }` 对象、`input_image` 类型对象等多种输入格式
- 图片通过 `emit_image` 消息发送到 Rust 侧，验证后作为 `FunctionCallOutputContentItem::InputImage` 附加到执行结果中
- 使用"观察追踪"模式：如果调用者没有 `await` 这个操作，未处理的错误会在 cell 完成前自动抛出

## 函数签名与关键 API

### Rust 侧

#### `JsReplHandle::with_node_path(node_path: Option<PathBuf>, node_module_dirs: Vec<PathBuf>) -> Self`
创建一个延迟初始化的 REPL 句柄。`node_path` 指定 Node 可执行文件路径，`node_module_dirs` 指定模块搜索目录。

> 源码位置：`mod.rs:79-88`

#### `JsReplHandle::manager(&self) -> Result<Arc<JsReplManager>, FunctionCallError>`
获取或创建 `JsReplManager` 单例。

> 源码位置：`mod.rs:90-97`

#### `JsReplManager::execute(&self, session, turn, tracker, args: JsReplArgs) -> Result<JsExecResult, FunctionCallError>`
执行一段 JS 代码。内部获取 Semaphore 锁保证串行执行。

> 源码位置：`mod.rs:836-1000`

#### `JsReplManager::reset(&self) -> Result<(), FunctionCallError>`
杀死当前内核进程并清空所有状态，下次执行时重新启动。

> 源码位置：`mod.rs:804-811`

#### `JsReplManager::interrupt_turn_exec(&self, turn_id: &str) -> Result<bool, FunctionCallError>`
中断指定 turn 的执行。如果当前内核正在为该 turn 执行代码，则重置内核。

> 源码位置：`mod.rs:813-823`

### JS 侧（暴露在 VM context 中）

#### `codex.tool(toolName: string, args?: object | string) -> Promise<any>`
调用其他 Codex 工具并返回结果。

> 源码位置：`kernel.js:1444-1478`

#### `codex.emitImage(imageLike: string | object) -> Thenable<void>`
向模型发射一张图片。接受 data URL、`{ bytes, mimeType }` 对象、或 `{ type: "input_image", image_url }` 对象。

> 源码位置：`kernel.js:1480-1539`

#### `codex.cwd` / `codex.homeDir` / `codex.tmpDir`
只读属性，分别为当前工作目录、用户主目录、临时目录路径。

> 源码位置：`kernel.js:1440-1443`

## 类型定义

### `JsReplArgs`（Rust）

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | `String` | 要执行的 JS 代码 |
| `timeout_ms` | `Option<u64>` | 执行超时（毫秒），默认 30000 |

> 源码位置：`mod.rs:104-110`

### `JsExecResult`（Rust）

| 字段 | 类型 | 说明 |
|------|------|------|
| `output` | `String` | console 输出文本 |
| `content_items` | `Vec<FunctionCallOutputContentItem>` | 附加内容项（如 emitImage 产生的图片） |

> 源码位置：`mod.rs:112-116`

### Host ↔ Kernel JSON 协议消息

**Host → Kernel（`HostToKernel`，`mod.rs:1786-1797`）**：
- `exec`：发送代码执行请求
- `run_tool_result`：返回工具调用结果
- `emit_image_result`：返回图片发射确认

**Kernel → Host（`KernelToHost`，`mod.rs:1772-1784`）**：
- `exec_result`：返回执行结果（`{ id, ok, output, error }`）
- `run_tool`：请求调用外部工具
- `emit_image`：请求发射图片

### `TopLevelExecState`（Rust）

状态机跟踪内核当前的顶层执行状态（`mod.rs:136-151`）：
- `Idle`：空闲
- `FreshKernel { turn_id, exec_id }`：刚启动的内核，尚未或刚提交执行
- `ReusedKernelPending { turn_id, exec_id }`：复用已有内核，执行已注册但未提交
- `Submitted { turn_id, exec_id }`：已提交到内核管道

## 配置项与环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CODEX_JS_REPL_NODE_PATH` | 指定 Node.js 可执行文件路径 | 自动搜索 `node` |
| `CODEX_JS_REPL_NODE_MODULE_DIRS` | 模块搜索路径（路径分隔符分隔） | 当前工作目录 |
| `CODEX_JS_TMP_DIR` | 临时目录路径（自动设置） | Manager 的 `tmp_dir` |
| `CODEX_THREAD_ID` | 线程 ID，用于生成内部绑定名的盐值 | `"session"` |

Node.js 版本要求由 `node-version.txt` 文件定义（`mod.rs:55`）。Node 解析优先级为：`CODEX_JS_REPL_NODE_PATH` 环境变量 → 配置文件中的 `js_repl_node_path` → `$PATH` 中的 `node`（`mod.rs:1946-1965`）。

## 模块安全限制

kernel.js 内置了多层安全措施：

- **拒绝危险内置模块**：`process`、`child_process`、`worker_threads` 被禁止 import（`kernel.js:102-109`）
- **仅支持 `.js` 和 `.mjs` 文件导入**：路径类模块仅允许这两种扩展名（`kernel.js:362-366`）
- **不支持目录导入**：必须指向具体文件
- **裸包解析限制**：裸包（如 `"lodash"`）必须解析到对应 `node_modules` 内部，跨越的 parent 查找会被忽略（`kernel.js:297-298`）
- **沙箱执行**：整个 Node 进程通过 Codex 沙箱系统启动，继承文件系统和网络沙箱策略
- **致命错误处理**：未捕获异常和未处理 rejection 会触发 `scheduleFatalExit`，同步写回错误消息后终止进程（`kernel.js:1135-1156, 1708-1714`）

## 边界 Case 与注意事项

- **串行执行**：`exec_lock`（Semaphore(1)）保证同一时刻只有一个 exec 在运行，但工具调用可以并行进行
- **内核复用**：内核进程跨多次 exec 复用，只有在 reset/timeout/fatal error 时才重启
- **内部绑定名冲突**：内部标记变量使用 `__codex_internal_commit_{salt}_{counter}` 格式，用线程 ID 作为盐值避免意外冲突（`kernel.js:570-576`）
- **`var` 提升的部分恢复**：在失败 cell 中，`for...of`/`for...in` 中的 `var` 声明如果循环体从未执行则不会被保留——这是有意的权衡（`kernel.js:927-939`）
- **stderr 缓冲**：最近 20 行 stderr 被保留在环形缓冲区中（上限 4KB），用于超时或崩溃时的诊断信息
- **静态 import 限制**：顶层 `import` 语句仅支持 `@prev`（前一 cell 的命名空间），其他包必须使用动态 `await import("pkg")`（`kernel.js:1619-1621`）
- **`codex.emitImage()` 未观察错误**：如果 `emitImage` 没有被 `await`，其错误会在 cell 执行结束时自动作为未处理错误抛出（`kernel.js:1626-1635`）