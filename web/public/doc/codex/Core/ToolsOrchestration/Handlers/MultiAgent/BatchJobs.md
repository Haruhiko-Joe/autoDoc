# 批量任务编排（BatchJobs）

## 概述与职责

BatchJobs 模块是 Codex 多 Agent 系统中的**批量任务编排器**，位于 Core → ToolsOrchestration → Handlers → MultiAgent 层级下。它提供了一种 CSV 驱动的批处理模式：读取一个 CSV 文件，将每一行解析为一个独立的工作项（work item），为每个工作项生成带模板参数的指令并派生子 Agent 并行执行，最终汇总结果并导出到输出 CSV。

同级兄弟模块包括 ShellAndPatch（命令/补丁执行）、McpHandlers（MCP 工具调用）、FileAndMedia（文件浏览）等。BatchJobs 与它们共同构成了 Handlers 层的完整工具处理能力。

该模块对外暴露两个工具：
- **`spawn_agents_on_csv`**：由父 Agent 调用，启动整个批量任务
- **`report_agent_job_result`**：由子 Agent（worker）调用，向编排器提交单项执行结果

## 关键流程

### 1. 批量任务启动流程（spawn_agents_on_csv）

完整调用链如下：

1. **参数解析**：反序列化 `SpawnAgentsOnCsvArgs`，校验 `instruction` 非空（`agent_jobs.rs:232-237`）
2. **获取状态数据库**：通过 `required_state_db()` 获取 `codex_state::StateRuntime` 的 SQLite 实例，用于持久化任务进度（`agent_jobs.rs:239`）
3. **读取并解析 CSV**：异步读取文件内容，调用 `parse_csv()` 解析为 headers + rows。CSV 解析支持引号包裹、逗号转义，自动跳过 BOM 标记和全空行（`agent_jobs.rs:242-257`）
4. **构建工作项列表**：遍历每一行，用 `id_column` 指定的列值（或回退到 `row-N`）作为 item_id，自动处理重复 ID（加后缀 `-2`、`-3`...）。每行转为 JSON 对象作为 `row_json`（`agent_jobs.rs:271-308`）
5. **创建任务记录**：生成 UUID 作为 job_id，计算输出 CSV 路径，调用 `db.create_agent_job()` 将任务和所有工作项持久化（`agent_jobs.rs:310-339`）
6. **构建运行选项**：校验 Agent 嵌套深度限制、标准化并发数、构建子 Agent 的 spawn 配置（`agent_jobs.rs:342-351`）
7. **执行主循环**：调用 `run_agent_job_loop()` 驱动整个任务直到完成（`agent_jobs.rs:365-381`）
8. **导出结果**：任务完成后导出输出 CSV，构建 `SpawnAgentsOnCsvResult` 返回给调用方，包含成功/失败计数和失败摘要（最多 5 条）（`agent_jobs.rs:383-464`）

### 2. 主事件循环（run_agent_job_loop）

这是整个模块最核心的逻辑，采用经典的**事件轮询 + 状态机**模式（`agent_jobs.rs:567-789`）：

```
loop {
    1. 检查取消请求
    2. 填充空闲工作槽位（spawn 新 worker）
    3. 回收超时 worker（reap_stale_active_items）
    4. 检查已完成的 worker（find_finished_threads）
    5. 若无进展则等待状态变化（wait_for_status_change）
    6. finalize 已完成项 + 发射进度事件
}
```

**填充工作槽位**（`agent_jobs.rs:614-692`）：
- 计算可用槽位数 = `max_concurrency - active_items.len()`
- 从数据库取对应数量的 Pending 状态工作项
- 为每项调用 `build_worker_prompt()` 生成指令，通过 `agent_control.spawn_agent()` 派生子 Agent
- 特殊处理 `AgentLimitReached` 错误：将工作项退回 Pending 状态并暂停派生
- 通过 `subscribe_status()` 获取状态变更的 watch channel，避免轮询

**等待机制**（`agent_jobs.rs:916-931`）：
- 使用 `FuturesUnordered` 聚合所有活跃 worker 的状态 watch channel
- 带 250ms 超时等待任意一个 channel 变化，兼顾响应速度和 CPU 开销
- 无 watch channel 时回退到 250ms sleep 轮询

**终止条件**：
- 正常完成：`pending_items == 0 && running_items == 0 && active_items.is_empty()`
- 取消：收到取消信号后停止派生新 worker，等待所有活跃 worker 完成

### 3. Worker 指令模板渲染

`render_instruction_template()` 实现了一个简单但实用的模板引擎（`agent_jobs.rs:1030-1053`）：

- `{column_name}` → 替换为该行对应列的值
- `{{literal}}` → 转义为字面量 `{literal}`（双花括号转义）
- 未匹配的 `{unknown}` → 保持原样不替换

实现技巧：先用哨兵字符串替换 `{{` 和 `}}`，执行模板替换后再还原，避免正则表达式的复杂性。

### 4. Worker 结果上报（report_agent_job_result）

子 Agent 完成工作后调用此工具（`agent_jobs.rs:468-512`）：

1. 校验 `result` 必须是 JSON 对象
2. 调用 `db.report_agent_job_item_result()` 将结果持久化，同时验证 thread 归属
3. 若 worker 设置 `stop: true`，触发整个 job 的取消流程
4. 返回 `{ accepted: true/false }` 告知 worker 结果是否被接受

### 5. 进度报告（JobProgressEmitter）

`JobProgressEmitter` 以不超过每秒一次的频率发射进度事件（`agent_jobs.rs:113-178`）：

- 追踪 `last_processed` 和 `last_failed`，仅在有变化或超过间隔时发射
- **ETA 计算**：`eta_seconds = remaining_items / (processed_items / elapsed_seconds)`，基于线性速率估算
- 通过 `session.notify_background_event()` 发射 `agent_job_progress:` 前缀的 JSON 事件
- 支持 `force` 参数在关键节点（启动、完成、取消）强制发射

## 函数签名与参数说明

### `spawn_agents_on_csv` 工具参数（`SpawnAgentsOnCsvArgs`）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `csv_path` | String | 是 | 输入 CSV 文件路径 |
| `instruction` | String | 是 | 指令模板，`{column}` 占位符会被替换为行值 |
| `id_column` | Option\<String\> | 否 | 用作 item_id 的列名；未指定则用 `row-N` |
| `output_csv_path` | Option\<String\> | 否 | 输出 CSV 路径；默认为输入文件同目录的 `{stem}.agent-job-{id前8位}.csv` |
| `output_schema` | Option\<Value\> | 否 | 期望的结果 JSON Schema，传递给 worker 参考 |
| `max_concurrency` | Option\<usize\> | 否 | 最大并发 worker 数 |
| `max_workers` | Option\<usize\> | 否 | `max_concurrency` 的别名 |
| `max_runtime_seconds` | Option\<u64\> | 否 | 单项最大执行时间（秒），默认 30 分钟 |

> 源码位置：`agent_jobs.rs:45-55`

### `report_agent_job_result` 工具参数（`ReportAgentJobResultArgs`）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `job_id` | String | 是 | 任务 ID |
| `item_id` | String | 是 | 工作项 ID |
| `result` | Value (JSON Object) | 是 | 结构化结果 |
| `stop` | Option\<bool\> | 否 | 设为 true 可提前终止整个 job |

> 源码位置：`agent_jobs.rs:57-63`

## 接口/类型定义

### `BatchJobHandler`

实现 `ToolHandler` trait 的入口结构体（`agent_jobs.rs:37, 180-217`）。根据 `tool_name` 分发到 `spawn_agents_on_csv` 或 `report_agent_job_result` 子模块。

### `SpawnAgentsOnCsvResult`

任务完成后返回给调用方的结构（`agent_jobs.rs:66-75`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `job_id` | String | 任务唯一标识 |
| `status` | String | 最终状态（completed / failed / cancelled） |
| `output_csv_path` | String | 输出 CSV 的文件路径 |
| `total_items` | usize | 总工作项数 |
| `completed_items` | usize | 成功完成数 |
| `failed_items` | usize | 失败数 |
| `job_error` | Option\<String\> | 任务级别的错误信息 |
| `failed_item_errors` | Option\<Vec\<AgentJobFailureSummary\>\> | 最多 5 条失败项摘要 |

### `AgentJobProgressUpdate`

进度事件的 JSON 结构（`agent_jobs.rs:84-93`），包含 `total_items`、`pending_items`、`running_items`、`completed_items`、`failed_items` 和 `eta_seconds`。

### `ActiveJobItem`

内存中追踪活跃 worker 的结构（`agent_jobs.rs:106-111`），持有 `item_id`、`started_at` 时间戳和可选的状态 watch channel `status_rx`。

## 配置项与默认值

| 常量/配置 | 值 | 说明 |
|-----------|------|------|
| `DEFAULT_AGENT_JOB_CONCURRENCY` | 16 | 未指定并发数时的默认值 |
| `MAX_AGENT_JOB_CONCURRENCY` | 64 | 硬性并发上限 |
| `STATUS_POLL_INTERVAL` | 250ms | 状态轮询/等待超时间隔 |
| `PROGRESS_EMIT_INTERVAL` | 1s | 进度事件最小发射间隔 |
| `DEFAULT_AGENT_JOB_ITEM_TIMEOUT` | 30 分钟 | 单项默认超时时间 |
| `config.agent_max_threads` | 运行时配置 | 系统级最大线程数，会进一步约束并发 |
| `config.agent_max_depth` | 运行时配置 | Agent 嵌套深度限制 |
| `config.agent_job_max_runtime_seconds` | 运行时配置 | 配置文件级别的默认超时 |

> 源码位置：`agent_jobs.rs:39-43`

并发数的最终计算逻辑（`normalize_concurrency`，`agent_jobs.rs:545-553`）：
```
effective = min(max(requested ∨ 16, 1), 64, agent_max_threads ∨ ∞)
```

## 边界 Case 与注意事项

- **CSV BOM 处理**：`parse_csv()` 会自动去除首列的 UTF-8 BOM 标记（`\u{feff}`），兼容 Excel 导出的 CSV（`agent_jobs.rs:1108-1109`）
- **全空行跳过**：CSV 中所有字段为空的行会被静默跳过（`agent_jobs.rs:1115-1117`）
- **重复 ID 自动去重**：当 `id_column` 指定的列存在重复值时，自动添加 `-2`、`-3` 后缀（`agent_jobs.rs:290-295`）
- **列数校验**：每行的字段数必须与 header 列数一致，否则返回错误并指出具体行号（`agent_jobs.rs:274-281`）
- **Agent 限额回退**：`spawn_agent` 遇到 `AgentLimitReached` 时，将工作项退回 Pending 并暂停本轮派生，下一轮循环再尝试（`agent_jobs.rs:642-649`）
- **Worker 未上报结果**：子 Agent 执行完毕但未调用 `report_agent_job_result` 时，该项被标记为 Failed 并记录原因（`agent_jobs.rs:979-986`）
- **运行中断恢复**：`recover_running_items()` 在任务启动时检查数据库中状态为 Running 的工作项，判断其对应 Agent 是否仍在运行，已完成则 finalize，超时则标记失败（`agent_jobs.rs:809-887`）
- **输出 CSV 列结构**：输出 CSV 在原始输入列之后追加 10 个元数据列：`job_id`、`item_id`、`row_index`、`source_id`、`status`、`attempt_count`、`last_error`、`result_json`、`reported_at`、`completed_at`（`agent_jobs.rs:1128-1140`）
- **取消语义**：`stop: true` 由 worker 触发后，编排器停止派生新 worker 但等待所有活跃 worker 自然结束，属于优雅关闭（`agent_jobs.rs:498-503, 710-713`）
- **SQLite 依赖**：该模块强制要求 `codex_state::StateRuntime`（SQLite 后端）存在，否则返回 Fatal 错误（`agent_jobs.rs:514-520`）