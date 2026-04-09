# LoadedThreadDiscovery — 子代理线程发现

## 概述与职责

`loaded_threads.rs` 是 TUI 应用编排层（AppOrchestrator → AppCore）中的一个纯同步工具模块，负责从 app-server 返回的扁平线程列表中**发现属于某个主线程的所有子代理线程**。

在系统架构中，当 TUI 恢复或切换到一个已有线程时，需要为 `AgentNavigationState` 和 `ChatWidget` 填充所有在该线程生命周期内派生的子代理元数据。app-server 通过 `thread/loaded/list` 接口暴露当前已加载的线程（扁平列表），而本模块的职责就是从中筛选出与指定主线程有父子血缘关系的所有后代线程。

**核心设计原则**：无 async、无 I/O、无副作用——纯函数式的树遍历，可完全隔离测试。

## 关键流程

### 广度优先生成树遍历

`find_loaded_subagent_threads_for_primary()` 的完整执行路径如下：

1. **构建索引**：将输入的 `Vec<Thread>` 转换为 `HashMap<ThreadId, Thread>`，以线程 ID 为键。解析失败的线程 ID 会被静默跳过（`loaded_threads.rs:51-56`）

2. **BFS 遍历**：以 `primary_thread_id` 为起点，维护一个 `pending` 队列和 `included` 已访问集合。每轮从队列弹出一个父线程 ID，遍历所有线程，找到满足以下条件的线程：
   - 尚未被收录（不在 `included` 中）
   - 其 `source` 字段为 `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { parent_thread_id, .. })`
   - `parent_thread_id` 等于当前正在处理的父线程 ID

   匹配的线程被加入 `included` 集合并推入 `pending` 队列，继续向下遍历（`loaded_threads.rs:58-81`）

3. **构建结果**：将 `included` 中的线程 ID 映射为 `LoadedSubagentThread` 结构体，提取 `agent_nickname` 和 `agent_role` 字段（`loaded_threads.rs:83-94`）

4. **排序**：按线程 ID 的字符串表示排序，确保输出顺序确定性，便于测试快照断言（`loaded_threads.rs:95`）

### 过滤逻辑

以下线程会被排除：
- **主线程本身**：`primary_thread_id` 只作为遍历起点，不会被加入 `included`
- **非 ThreadSpawn 来源的线程**：如 `SessionSource::Cli`、`SessionSource::Api` 等，因为它们不是子代理关系
- **父链不连通的线程**：其 `parent_thread_id` 不在以主线程为根的生成树上

## 函数签名与参数说明

### `find_loaded_subagent_threads_for_primary(threads, primary_thread_id) -> Vec<LoadedSubagentThread>`

```rust
pub(crate) fn find_loaded_subagent_threads_for_primary(
    threads: Vec<Thread>,
    primary_thread_id: ThreadId,
) -> Vec<LoadedSubagentThread>
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `threads` | `Vec<Thread>` | app-server 返回的所有已加载线程的扁平列表 |
| `primary_thread_id` | `ThreadId` | 目标主线程 ID，作为生成树的根 |

**返回值**：`Vec<LoadedSubagentThread>` — 所有属于该主线程的后代子代理线程，按线程 ID 字符串排序。

> 源码位置：`codex-rs/tui/src/app/loaded_threads.rs:46-97`

## 接口/类型定义

### `LoadedSubagentThread`

携带 TUI 注册子代理导航和渲染元数据所需的最小信息集。

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LoadedSubagentThread {
    pub(crate) thread_id: ThreadId,
    pub(crate) agent_nickname: Option<String>,
    pub(crate) agent_role: Option<String>,
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `thread_id` | `ThreadId` | 子代理线程的唯一标识 |
| `agent_nickname` | `Option<String>` | 代理昵称（如 "Scout"），用于 UI 展示 |
| `agent_role` | `Option<String>` | 代理角色（如 "explorer"），用于 UI 展示 |

> 源码位置：`codex-rs/tui/src/app/loaded_threads.rs:27-31`

### 外部依赖类型

- **`Thread`**（来自 `codex_app_server_protocol`）：app-server 返回的线程数据结构，包含 `id`、`source`、`agent_nickname`、`agent_role` 等字段
- **`SessionSource`**（来自 `codex_app_server_protocol`）：线程来源枚举，本模块只关心其 `SubAgent(SubAgentSource::ThreadSpawn { .. })` 变体
- **`ThreadId`**（来自 `codex_protocol`）：线程唯一标识符，通过 `ThreadId::from_string()` 从字符串解析

## 边界 Case 与注意事项

- **线程 ID 解析失败**：如果 `Thread.id` 无法解析为合法的 `ThreadId`，该线程会被静默跳过，不会导致 panic
- **环形引用**：文档注释指出服务端分配 UUID 并保证无环，但 `included` 集合同样提供了防护——已访问的线程不会被重复处理
- **排序仅用于确定性**：输出的排序顺序是字符串字典序，仅用于使测试快照稳定，调用方不应依赖此顺序表达语义
- **多个子线程共享同一父线程**：两个线程声明相同的 `parent_thread_id` 时，两者都会被包含在结果中
- **`crate` 可见性**：`LoadedSubagentThread` 和 `find_loaded_subagent_threads_for_primary` 均为 `pub(crate)`，仅供 TUI crate 内部使用

## 关键代码片段

BFS 遍历核心循环（`codex-rs/tui/src/app/loaded_threads.rs:58-81`）：

```rust
let mut included = HashSet::new();
let mut pending = vec![primary_thread_id];
while let Some(parent_thread_id) = pending.pop() {
    for (thread_id, thread) in &threads_by_id {
        if included.contains(thread_id) {
            continue;
        }

        let SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
            parent_thread_id: source_parent_thread_id,
            ..
        }) = &thread.source
        else {
            continue;
        };

        if *source_parent_thread_id != parent_thread_id {
            continue;
        }

        included.insert(*thread_id);
        pending.push(*thread_id);
    }
}
```

该循环在每一轮中扫描全部线程，匹配当前父线程的直接子代。由于线程数量通常很小（几十个量级），这种 O(N²) 的遍历方式在实际场景中完全可接受。