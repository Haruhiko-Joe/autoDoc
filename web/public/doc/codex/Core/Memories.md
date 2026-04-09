# Memories（记忆管理子系统）

## 概述与职责

Memories 是 Codex Core 引擎中的记忆管理子系统，负责从历史会话中自动提取、整合、存储和引用记忆信息。它的核心目标是让模型能够跨会话记住用户的偏好、项目上下文和工作模式。

在 Core 的架构中，Memories 属于会话启动阶段的后台流水线。当一个符合条件的根会话（root session）启动时，Memories 自动在后台运行两阶段处理流水线：Phase 1 逐条提取单个会话的记忆，Phase 2 将所有提取结果整合到全局记忆工件中。此外，子系统还提供记忆引用解析（citations）、模型提示词构建（prompts）、使用追踪（usage）和文件清理（control）等能力。

同级模块包括 ModelProviders（LLM 集成）、ToolSystem（工具框架）、Config（配置管理）等，Memories 依赖 Config 中的 `MemoriesConfig` 控制行为参数，依赖 State DB 做作业调度和持久化，依赖 ModelClient 调用 LLM 进行记忆提取和摘要。

## 模块入口与启动条件

子系统的唯一入口是 `start_memories_startup_task()`（`codex-rs/core/src/memories/start.rs:14-44`）。它在以下条件全部满足时才会触发流水线：

- 会话非临时会话（`!config.ephemeral`）
- `MemoryTool` 特性开关已启用
- 会话不是子代理会话（非 `SubAgent`）
- State DB 可用

启动后通过 `tokio::spawn` 在后台异步执行，依次调用：

```rust
// codex-rs/core/src/memories/start.rs:32-43
phase1::prune(&session, &config).await;  // 清理过期记忆
phase1::run(&session, &config).await;    // Phase 1：提取
phase2::run(&session, config).await;     // Phase 2：整合
```

## 关键流程

### Phase 1：逐会话记忆提取

Phase 1 处理单个 rollout（会话回放记录），从中提取结构化的原始记忆。核心流程位于 `codex-rs/core/src/memories/phase1.rs:86-123`：

1. **认领作业（Claim）**：从 State DB 中认领一批符合条件的 rollout 作业。筛选条件包括：来源必须为交互式会话、在配置的年龄窗口内、空闲时间足够长、未被其他 worker 占用。每次最多认领 `max_rollouts_per_startup` 个。

2. **构建请求上下文**：确定使用的模型（默认 `gpt-5.4-mini`）和推理力度（`Low`），构建 `RequestContext`。

3. **并行采样**：通过 `futures::stream::buffer_unordered` 以最多 8 个并发（`CONCURRENCY_LIMIT`）执行提取任务。每个任务：
   - 加载 rollout 文件内容
   - 过滤出与记忆相关的 response item（排除 developer 消息和记忆排除的上下文片段）
   - 将 rollout 内容截断到模型上下文窗口的 70%（`CONTEXT_WINDOW_PERCENT`）
   - 使用 `stage_one_system.md` 作为系统提示词，通过 JSON schema 约束输出格式
   - 对输出进行密钥脱敏（`redact_secrets`）

4. **持久化结果**：成功的提取结果（`raw_memory` + `rollout_summary` + 可选 `rollout_slug`）写入 State DB，失败的作业标记退避重试（1 小时后重试）。

Phase 1 输出的数据结构（`codex-rs/core/src/memories/phase1.rs:69-79`）：

```rust
struct StageOneOutput {
    raw_memory: String,        // 详细的 Markdown 原始记忆
    rollout_summary: String,   // 紧凑的摘要行，用于路由和索引
    rollout_slug: Option<String>, // 可选的 slug，用于生成文件名
}
```

#### Rollout 内容过滤

`sanitize_response_item_for_memories()`（`phase1.rs:485-521`）在发送给模型前过滤 rollout 内容：
- 完全排除 `developer` 角色的消息
- 对 `user` 消息过滤掉被标记为 memory-excluded 的上下文片段
- 保留 `assistant`、`system` 消息
- 非 message 类型的 item 通过 `should_persist_response_item_for_memories` 策略判断保留

#### 过期记忆清理

`phase1::prune()`（`phase1.rs:126-147`）在 Phase 1 提取前运行，批量删除超过 `max_unused_days` 天未使用的旧记忆记录，每批最多删除 200 条。

### Phase 2：全局整合

Phase 2 将 Phase 1 产出的多条原始记忆整合为全局记忆工件。核心流程位于 `codex-rs/core/src/memories/phase2.rs:43-161`：

1. **认领全局作业**：通过 `try_claim_global_phase2_job` 获取全局唯一的整合作业锁（同一时间只有一个 Phase 2 在运行）。认领结果可能是：`Claimed`（成功）、`SkippedNotDirty`（无新数据）、`SkippedRunning`（其他 worker 正在运行）。

2. **加载输入选择**：从 State DB 获取 `Phase2InputSelection`，包含：
   - `selected`：当前选中的记忆（按使用频率和最近使用时间排序，上限 `max_raw_memories_for_consolidation`）
   - `retained_thread_ids`：上次成功 Phase 2 中也被选中的线程（标记为 "retained"）
   - `removed`：上次被选中但这次不在选中范围内的记忆（标记为 "removed"）

3. **同步文件系统**：
   - 将 `rollout_summaries/` 目录与选中的记忆同步，清除不再保留的旧摘要文件
   - 重建 `raw_memories.md`（合并所有原始记忆，按时间倒序排列）
   - 如果没有任何记忆，清理 `MEMORY.md`、`memory_summary.md` 和 `skills/` 目录

4. **启动整合 Agent**：以子代理方式运行整合 agent，配置特殊的安全策略：
   - 无需审批（`AskForApproval::Never`）
   - 无网络访问
   - 仅允许写入 `codex_home` 目录
   - 禁用协作模式和递归子代理生成
   - 使用模型 `gpt-5.3-codex`、推理力度 `Medium`

5. **监控 Agent**：通过 `watch::Receiver` 监听 agent 状态，同时每 90 秒发送心跳续租全局作业锁，防止锁过期。Agent 完成后标记作业成功并记录 token 使用量。

#### Watermark 机制

Phase 2 使用 watermark（水印）跟踪已处理的数据范围（`phase2.rs:457-467`）。`new_watermark` 取认领时的水印和所有输入中最新 `source_updated_at` 的较大值，保证水印单调递增。后续 Phase 2 运行通过比较水印判断是否有新数据（dirty vs not dirty）。

## 引用解析（Citations）

`citations.rs` 提供从模型输出中解析记忆引用的能力（`codex-rs/core/src/memories/citations.rs:6-43`）。

### `parse_memory_citation(citations: Vec<String>) -> Option<MemoryCitation>`

解析模型响应中的记忆引用标记，支持两种 XML 标签格式：

- **引用条目**：`<citation_entries>...</citation_entries>` 块中，每行格式为 `path:line_start-line_end|note=[说明]`，解析为 `MemoryCitationEntry`（包含文件路径、行范围和注释）。

- **Rollout ID**：`<rollout_ids>...</rollout_ids>` 或 `<thread_ids>...</thread_ids>` 块中，每行一个 ID，用于追踪引用来源。

### `get_thread_id_from_citations(citations: Vec<String>) -> Vec<ThreadId>`

从引用中提取有效的 `ThreadId`，用于 Phase 1 输出的使用计数更新。

## 提示词构建（Prompts）

`prompts.rs` 负责构建记忆相关的各种模型提示词（`codex-rs/core/src/memories/prompts.rs`）。使用 `codex_utils_template::Template` 渲染三个嵌入式模板：

| 模板 | 用途 |
|------|------|
| `stage_one_input.md` | Phase 1 用户消息：包含 rollout 路径、工作目录和（截断后的）rollout 内容 |
| `consolidation.md` | Phase 2 整合 agent 的提示词：包含记忆根目录和输入选择差异 |
| `read_path.md` | 读取路径的 developer instructions：包含记忆摘要（截断至 5000 tokens） |

### `build_stage_one_input_message()`（`prompts.rs:133-158`）

构建 Phase 1 的用户输入消息。关键截断逻辑：rollout 内容被限制在模型有效输入窗口的 70% 以内（默认兜底 150,000 tokens）。

### `build_memory_tool_developer_instructions()`（`prompts.rs:163-185`）

为模型的 developer instructions 构建记忆工具提示。读取 `memory_summary.md` 文件内容，截断到 5000 tokens 后嵌入模板。如果文件不存在或为空则返回 `None`。

### Phase 2 整合提示词

`build_consolidation_prompt()`（`prompts.rs:43-60`）生成的提示词包含选择差异信息：每条记忆标注为 `[added]` 或 `[retained]`，同时列出被移除的记忆，帮助整合 agent 理解变化。

## 存储层（Storage）

`storage.rs` 管理记忆的文件系统持久化（`codex-rs/core/src/memories/storage.rs`）。

### 文件布局

```
~/.codex/memories/
├── raw_memories.md           # 合并的原始记忆（Phase 2 输入）
├── rollout_summaries/        # 每个 rollout 的摘要文件
│   └── 2025-01-15T14-30-00-aB3x-fix_auth_bug.md
├── MEMORY.md                 # 整合后的记忆索引（由整合 agent 生成）
├── memory_summary.md         # 整合后的记忆摘要（由整合 agent 生成）
└── skills/                   # 技能记忆（由整合 agent 生成）
```

### Rollout 摘要文件名生成

`rollout_summary_file_stem_from_parts()`（`storage.rs:179-256`）生成文件名格式为 `{timestamp}-{short_hash}[-{slug}]`：
- **timestamp**：从 UUID v7 线程 ID 提取或使用 `source_updated_at`，格式 `YYYY-MM-DDTHH-MM-SS`
- **short_hash**：4 字符的 base62 哈希，由线程 ID 低 32 位计算
- **slug**：可选，由模型生成的描述性 slug，最长 60 字符，仅保留字母数字和下划线

### 核心操作

- **`sync_rollout_summaries_from_memories()`**：同步 `rollout_summaries/` 目录。写入保留记忆的摘要文件，删除不再保留的旧文件。若无任何保留记忆，还会清理 `MEMORY.md`、`memory_summary.md` 和 `skills/`。

- **`rebuild_raw_memories_file_from_memories()`**：重建 `raw_memories.md`。每条记忆包含 thread_id、时间戳、工作目录、rollout 路径和原始记忆内容。

## 使用追踪（Usage）

`usage.rs` 追踪模型对记忆文件的读取行为（`codex-rs/core/src/memories/usage.rs`）。

### `emit_metric_for_tool_read()`

在工具调用后触发，分析 shell 命令是否读取了记忆目录下的文件。仅对已知安全命令进行分析（通过 `is_known_safe_command` 过滤）。

追踪的文件类型（`MemoriesUsageKind`）：

| Kind | 匹配路径 | 含义 |
|------|----------|------|
| `memory_md` | `memories/MEMORY.md` | 记忆索引 |
| `memory_summary` | `memories/memory_summary.md` | 记忆摘要 |
| `raw_memories` | `memories/raw_memories.md` | 原始记忆 |
| `rollout_summaries` | `memories/rollout_summaries/` | Rollout 摘要 |
| `skills` | `memories/skills/` | 技能记忆 |

指标名称为 `codex.memories.usage`，标签包含 `kind`、`tool`（工具名）和 `success`。

## 记忆清理（Control）

`control.rs` 提供安全的记忆根目录清理功能（`codex-rs/core/src/memories/control.rs:3-33`）：

### `clear_memory_root_contents(memory_root: &Path)`

- **安全检查**：拒绝清理符号链接指向的目录（防止意外删除非预期位置的文件）
- 确保目录存在后，递归删除所有子目录和文件

## 记忆追踪文件处理（Memory Trace）

`memory_trace.rs`（`codex-rs/core/src/memory_trace.rs`）提供从外部追踪文件构建记忆的能力，独立于主启动流水线。

### `build_memories_from_trace_files()`（`memory_trace.rs:36-74`）

接收一组追踪文件路径，解析并发送到 `/v1/memories/trace_summarize` 接口进行摘要。返回 `Vec<BuiltMemory>`，每个包含 `memory_id`、`source_path`、`raw_memory` 和 `memory_summary`。

### 追踪文件解析

支持两种格式（`memory_trace.rs:112-155`）：
- **JSON 数组**：整个文件是一个 JSON 数组
- **JSONL**：每行一个 JSON 对象或数组

解析后执行归一化（`normalize_trace_items`）：
- 对包含 `payload` 字段且 `type` 为 `response_item` 的项，提取 payload 内容
- 过滤只保留合法类型：`message` 类型必须具有 `assistant`/`system`/`developer`/`user` 角色，其他类型全部保留
- 支持带 BOM 的 UTF-8 和 Latin-1 回退解码

## 配置常量

### Phase 1

| 常量 | 值 | 说明 |
|------|-----|------|
| `MODEL` | `gpt-5.4-mini` | 默认提取模型 |
| `REASONING_EFFORT` | `Low` | 推理力度 |
| `CONCURRENCY_LIMIT` | 8 | 并行提取上限 |
| `DEFAULT_STAGE_ONE_ROLLOUT_TOKEN_LIMIT` | 150,000 | rollout 截断兜底值 |
| `CONTEXT_WINDOW_PERCENT` | 70% | 上下文窗口使用比例 |
| `JOB_LEASE_SECONDS` | 3,600 | 作业租约时长 |
| `JOB_RETRY_DELAY_SECONDS` | 3,600 | 失败重试退避 |
| `THREAD_SCAN_LIMIT` | 5,000 | 最大扫描线程数 |
| `PRUNE_BATCH_SIZE` | 200 | 清理批次大小 |

### Phase 2

| 常量 | 值 | 说明 |
|------|-----|------|
| `MODEL` | `gpt-5.3-codex` | 默认整合模型 |
| `REASONING_EFFORT` | `Medium` | 推理力度 |
| `JOB_LEASE_SECONDS` | 3,600 | 作业租约时长 |
| `JOB_RETRY_DELAY_SECONDS` | 3,600 | 失败重试退避 |
| `JOB_HEARTBEAT_SECONDS` | 90 | 心跳间隔 |

## 可观测性指标

| 指标名称 | 类型 | 说明 |
|----------|------|------|
| `codex.memory.phase1` | Counter | Phase 1 作业数（按 status 分组） |
| `codex.memory.phase1.e2e_ms` | Timer | Phase 1 端到端延迟 |
| `codex.memory.phase1.output` | Counter | Phase 1 产出的原始记忆数 |
| `codex.memory.phase1.token_usage` | Histogram | Phase 1 token 用量 |
| `codex.memory.phase2` | Counter | Phase 2 作业数（按 status 分组） |
| `codex.memory.phase2.e2e_ms` | Timer | Phase 2 端到端延迟 |
| `codex.memory.phase2.input` | Counter | Phase 2 输入记忆数 |
| `codex.memory.phase2.token_usage` | Histogram | Phase 2 token 用量 |
| `codex.memories.usage` | Counter | 记忆文件读取追踪 |

## 边界 Case 与注意事项

- **密钥脱敏**：Phase 1 输出在持久化前强制经过 `redact_secrets()` 处理，确保不会将敏感信息写入记忆存储。
- **符号链接保护**：`clear_memory_root_contents()` 拒绝操作符号链接目标，避免误删。
- **整合 agent 隔离**：Phase 2 的子 agent 禁用了网络访问、协作模式、递归子 agent 和记忆生成，防止无限递归和安全风险。
- **空输出处理**：Phase 1 提取结果如果 `raw_memory` 或 `rollout_summary` 为空，标记为 `SucceededNoOutput` 而非失败。
- **作业锁竞争**：Phase 1 通过 per-thread 的租约锁保证同一 rollout 不被重复处理；Phase 2 通过全局唯一锁保证整合操作的串行化。
- **心跳续租**：Phase 2 在整合 agent 运行期间每 90 秒续租一次全局锁，如果续租失败（锁已被抢占），agent 会收到错误状态并停止。
- **记忆清空后文件清理**：当所有记忆被清除时，`sync_rollout_summaries_from_memories` 会自动删除 `MEMORY.md`、`memory_summary.md` 和 `skills/` 目录。