# 上下文管理（ContextManagement）

## 概述与职责

上下文管理模块是 Codex Core 的"记忆中枢"，负责维护发送给模型的完整对话上下文窗口。它处理以下核心问题：

- **会话历史追踪**：记录用户消息、模型回复、工具调用及其输出，维护一份有序的 `ResponseItem` 列表
- **历史规范化**：确保工具调用/输出配对完整，移除孤立项，在模型不支持图片时剥离图片内容
- **上下文压缩（Compaction）**：当 token 使用量接近上下文窗口上限时，通过摘要替换旧消息来缩减历史
- **线程回滚截断**：按"用户轮次"边界截断 rollout，支持 fork 和回滚语义
- **上下文消息构建**：在每轮对话开始时注入环境信息（cwd、shell、日期、网络配置）、项目文档（AGENTS.md）、权限指令等
- **全局消息历史持久化**：将用户消息写入 `~/.codex/history.jsonl`，支持并发锁和大小限制

在系统架构中，该模块位于 **Core** 层内部，是连接用户输入和模型 API 调用之间的桥梁。它被 Core 的主循环在每轮对话（turn）中调用，确保发送给模型的 prompt 始终完整、合规且在 token 限制内。同级模块包括 ToolSystem（工具调用）、ModelProviders（模型 API）等。

## 子模块组成

该模块由以下文件/目录构成：

| 文件/目录 | 职责 |
|-----------|------|
| `context_manager/history.rs` | `ContextManager` 核心结构体，管理 `Vec<ResponseItem>` 历史和 token 计量 |
| `context_manager/normalize.rs` | 历史规范化：补全缺失输出、移除孤立输出、剥离不支持的图片 |
| `context_manager/updates.rs` | 构建每轮的设置更新消息（环境 diff、权限变更、模型切换等） |
| `message_history.rs` | 全局 `history.jsonl` 文件的持久化读写 |
| `contextual_user_message.rs` | 识别和解析"上下文用户消息"片段（环境、AGENTS.md、技能等） |
| `environment_context.rs` | `EnvironmentContext` 结构体，序列化为 XML 注入到 prompt |
| `project_doc.rs` | 发现并加载 `AGENTS.md` 项目文档 |
| `instructions/mod.rs` | 重导出 `UserInstructions` 类型 |
| `thread_rollout_truncation.rs` | 按用户轮次边界截断 rollout |
| `original_image_detail.rs` | 重导出图片 detail 规范化工具 |

## 关键流程

### 1. 每轮初始上下文构建

每轮对话开始时，`Codex::build_initial_context()` 组装两类消息注入历史（`codex-rs/core/src/codex.rs:3566-3743`）：

1. **developer 消息**（合并为一条）：依次收集模型切换指令、权限策略、用户自定义 developer 指令、memory 工具指令、协作模式指令、实时模式指令、人格指令、Apps/Skills/Plugins 描述、commit 归属指令
2. **contextual user 消息**（合并为一条）：用户指令（`UserInstructions`）和环境上下文（`EnvironmentContext` 的 XML 序列化）

这些消息通过 `updates::build_developer_update_item()` 和 `updates::build_contextual_user_message()` 构造为 `ResponseItem::Message`。

### 2. 稳态设置更新（Diff 模式）

首次之后的每轮不再注入完整上下文，而是通过 `updates::build_settings_update_items()` 进行差分更新（`context_manager/updates.rs:196-231`）：

1. 取出上一轮快照 `reference_context_item`（`TurnContextItem`）
2. 逐项比较环境上下文、权限策略、协作模式、实时状态、人格设定
3. 仅将发生变化的部分构建为更新消息

这避免了每轮重复注入大量不变的指令内容。

### 3. 历史记录与截断

`ContextManager::record_items()` 接收新的 `ResponseItem` 并追加到内部列表（`context_manager/history.rs:96-111`）：

1. 过滤掉 system 消息和非 API 消息
2. 对工具调用输出（`FunctionCallOutput`、`CustomToolCallOutput`）按 `TruncationPolicy` 截断过长输出
3. 策略乘以 1.2 作为序列化预算，通过 `truncate_function_output_items_with_policy` 截断

### 4. 历史规范化

在 `for_prompt()` 准备发送给模型时，执行三步规范化（`context_manager/history.rs:352-361`）：

1. **`ensure_call_outputs_present`**（`normalize.rs:14-120`）：扫描所有 `FunctionCall`/`CustomToolCall`/`ToolSearchCall`/`LocalShellCall`，为缺失输出的调用补入 `"aborted"` 占位输出
2. **`remove_orphan_outputs`**（`normalize.rs:122-195`）：移除没有对应调用项的孤立输出
3. **`strip_images_when_unsupported`**（`normalize.rs:295-345`）：当模型不支持 `InputModality::Image` 时，将图片替换为文本占位符

### 5. Token 估算

`ContextManager` 提供多种 token 计量方法：

- **`estimate_token_count()`**（`history.rs:131-138`）：基于字节启发式估算全部历史 + base instructions 的 token 数
- **`get_total_token_usage()`**（`history.rs:300-318`）：结合 API 返回的实际 token 数和本地新增项的估算值
- **`estimate_response_item_model_visible_bytes()`**（`history.rs:519-545`）：对单个 `ResponseItem` 估算模型可见字节数，对加密推理内容和 base64 图片做特殊处理

图片估算逻辑值得注意：
- 普通图片使用固定估算值 `RESIZED_IMAGE_BYTES_ESTIMATE = 7373` 字节（约 1844 tokens）
- `detail: "original"` 的图片会解码后按 32px patch 网格计算实际 token 数
- 结果缓存在 LRU cache 中避免重复计算（`ORIGINAL_IMAGE_ESTIMATE_CACHE`，容量 32）

### 6. 轮次回滚

`drop_last_n_user_turns()` 实现了线程回滚语义（`history.rs:228-251`）：

1. 定位所有"用户轮次边界"——普通 user 消息或 inter-agent 指令消息
2. 从末尾删除 N 个轮次之后的所有项
3. 回滚时通过 `trim_pre_turn_context_updates()` 同时清除轮次前的上下文更新消息（developer/contextual user）
4. 如果被裁剪的 developer 消息是混合的 `build_initial_context` bundle，则清除 `reference_context_item` 以强制下轮重新完整注入

### 7. Rollout 截断

`thread_rollout_truncation.rs` 提供两种 rollout 截断策略：

- **`truncate_rollout_before_nth_user_message_from_start()`**（`thread_rollout_truncation.rs:99-117`）：保留前 N 个用户消息之前的内容，用于限制子 agent 可见历史
- **`truncate_rollout_to_last_n_fork_turns()`**（`thread_rollout_truncation.rs:122-137`）：仅保留最后 N 个 fork 轮次，用于 fork/resume 场景

两者都处理 `ThreadRolledBack` 标记，确保截断基于回滚后的有效历史。

### 8. 消息历史持久化

`message_history.rs` 将用户消息持久化到 `~/.codex/history.jsonl`（`message_history.rs:84-165`）：

1. 根据 `HistoryPersistence` 配置决定是否写入
2. 使用 `O_APPEND` + 文件锁（`try_lock` + 重试，最多 10 次）保证并发安全
3. 每条记录格式：`{"session_id":"<uuid>","ts":<unix_seconds>,"text":"<message>"}`
4. 写入后检查文件大小，超限时按软上限（80%）裁剪最老的行
5. Unix 下确保文件权限为 `0o600`

## 函数签名与公开 API

### `ContextManager`

```rust
pub(crate) struct ContextManager {
    items: Vec<ResponseItem>,
    token_info: Option<TokenUsageInfo>,
    reference_context_item: Option<TurnContextItem>,
}
```

| 方法 | 说明 |
|------|------|
| `new() -> Self` | 创建空历史 |
| `record_items(items, policy)` | 记录新项并截断过长输出 |
| `for_prompt(input_modalities) -> Vec<ResponseItem>` | 规范化后返回可发送给模型的历史（消耗 self） |
| `raw_items() -> &[ResponseItem]` | 返回原始历史项引用 |
| `estimate_token_count(turn_context) -> Option<i64>` | 启发式估算总 token 数 |
| `get_total_token_usage(server_reasoning_included) -> i64` | 获取含 API 报告值的总 token 用量 |
| `drop_last_n_user_turns(num_turns)` | 回滚最后 N 个用户轮次 |
| `remove_first_item()` / `remove_last_item()` | 移除首/尾项，同时清理配对项 |
| `replace_last_turn_images(placeholder) -> bool` | 将最后一轮工具输出中的图片替换为文本 |
| `set_reference_context_item(item)` | 设置上下文快照基线 |

### `build_settings_update_items()`

```rust
pub(crate) fn build_settings_update_items(
    previous: Option<&TurnContextItem>,
    previous_turn_settings: Option<&PreviousTurnSettings>,
    next: &TurnContext,
    shell: &Shell,
    exec_policy: &Policy,
    personality_feature_enabled: bool,
) -> Vec<ResponseItem>
```

比较前后轮上下文，返回需要注入的 diff 消息列表。

### 消息历史

```rust
pub async fn append_entry(text: &str, conversation_id: &ThreadId, config: &Config) -> Result<()>
pub fn lookup(log_id: u64, offset: usize, config: &Config) -> Option<HistoryEntry>
pub async fn history_metadata(config: &Config) -> (u64, usize)
```

## 类型定义

### `EnvironmentContext`

```rust
pub(crate) struct EnvironmentContext {
    pub cwd: Option<PathBuf>,
    pub shell: Shell,
    pub current_date: Option<String>,
    pub timezone: Option<String>,
    pub network: Option<NetworkContext>,
    pub subagents: Option<String>,
}
```

序列化为 XML 格式注入 prompt，包裹在 `<environment_context>...</environment_context>` 标签中。支持 `diff_from_turn_context_item()` 方法进行差分更新，仅发送变化的字段。

### `TotalTokenUsageBreakdown`

```rust
pub(crate) struct TotalTokenUsageBreakdown {
    pub last_api_response_total_tokens: i64,
    pub all_history_items_model_visible_bytes: i64,
    pub estimated_tokens_of_items_added_since_last_successful_api_response: i64,
    pub estimated_bytes_of_items_added_since_last_successful_api_response: i64,
}
```

提供 token 使用的详细分解，区分 API 报告值和本地估算值。

### `HistoryEntry`

```rust
pub struct HistoryEntry {
    pub session_id: String,
    pub ts: u64,
    pub text: String,
}
```

`history.jsonl` 中每行的结构。`session_id` 字段实际存储的是 thread ID（出于向后兼容保留字段名）。

### 上下文用户消息片段

`contextual_user_message.rs` 定义了多种片段类型用于标识可注入的上下文内容：

| 片段 | 标签 | 用途 |
|------|------|------|
| `ENVIRONMENT_CONTEXT_FRAGMENT` | `<environment_context>` | 环境信息 |
| `USER_SHELL_COMMAND_FRAGMENT` | `<user_shell_command>` | 用户 shell 命令 |
| `TURN_ABORTED_FRAGMENT` | `<turn_aborted>` | 轮次中止通知 |
| `SUBAGENT_NOTIFICATION_FRAGMENT` | `<subagent_notification>` | 子 agent 通知 |
| `AGENTS_MD_FRAGMENT` | 来自 `codex_instructions` | AGENTS.md 内容 |
| `SKILL_FRAGMENT` | 来自 `codex_instructions` | 技能定义 |

其中 `AGENTS_MD_FRAGMENT` 和 `SKILL_FRAGMENT` 在 memory 生成时被排除（`is_memory_excluded_contextual_user_fragment`），因为它们是 prompt 脚手架而非对话内容。

## 配置项与默认值

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `config.include_environment_context` | - | 是否注入环境上下文 |
| `config.include_permissions_instructions` | - | 是否注入权限策略指令 |
| `config.history.persistence` | `SaveAll` | 历史持久化策略（`SaveAll` / `None`） |
| `config.history.max_bytes` | - | history.jsonl 最大字节数 |
| `config.project_doc_max_bytes` | - | 项目文档最大加载字节数，为 0 时禁用 |
| `config.project_doc_fallback_filenames` | `[]` | AGENTS.md 的备选文件名列表 |
| `HISTORY_SOFT_CAP_RATIO` | `0.8` | 超限裁剪时的软上限比例 |
| `RESIZED_IMAGE_BYTES_ESTIMATE` | `7373` | 标准图片的字节估算值（约 1844 tokens） |
| `ORIGINAL_IMAGE_PATCH_SIZE` | `32` | original detail 图片的 patch 大小 |

### 项目文档搜索规则

1. 从 cwd 向上查找 `project_root_markers`（默认 `.git`）确定项目根
2. 从项目根到 cwd 的每个目录中，按 `AGENTS.override.md` > `AGENTS.md` > 自定义 fallback 名的优先级搜索
3. 将所有找到的文件内容按路径顺序拼接

## 边界 Case 与注意事项

- **轮次边界判定**：`is_user_turn_boundary()` 不仅匹配普通 user 消息，还匹配 assistant 角色的 `InterAgentCommunication` 指令消息（`history.rs:691-698`）。这意味着回滚操作同时影响 inter-agent 通信
- **混合 bundle 回滚**：当回滚裁剪了包含 `build_initial_context` 输出的 developer 消息时，`reference_context_item` 被清除为 `None`，下一轮被迫从完整注入重新开始，而非做 diff 更新
- **GhostSnapshot 处理**：`record_items()` 允许 `GhostSnapshot` 进入历史，但 `for_prompt()` 会在最终输出中过滤掉它们。`GhostSnapshot` 的模型可见字节估算为 0
- **历史文件锁竞争**：`message_history.rs` 使用 advisory file lock，重试 10 次、每次间隔 100ms。如果仍无法获取锁则返回 `WouldBlock` 错误
- **Token 估算精度**：`estimate_token_count()` 基于字节的粗略下界，不使用实际 tokenizer。加密推理内容通过 base64 解码长度估算实际 token 数（`estimate_reasoning_length`：`len * 3/4 - 650`）
- **图片 token 估算缓存**：`ORIGINAL_IMAGE_ESTIMATE_CACHE` 使用 SHA1 作为 key 的 LRU 缓存（容量 32），对 original detail 图片解码计算一次后复用
- **项目文档预算**：当 `project_doc_max_bytes` 预算用完时，后续文件会被截断而非跳过，并产生 warn 日志