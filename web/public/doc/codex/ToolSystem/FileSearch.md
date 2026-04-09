# FileSearch — 模糊文件搜索引擎

## 概述与职责

`codex-file-search` 是 Codex 工具系统（ToolSystem）中的文件搜索组件，提供对项目目录树的**模糊文件名搜索**能力。它遍历项目目录（自动遵循 `.gitignore` 规则），将所有文件路径送入 `nucleo` 模糊匹配引擎，返回按相关度排序的匹配结果，并可选地提供字符级匹配索引以支持高亮显示。

该模块同时支持两种使用方式：
- **库模式**（`codex_file_search`）：供 TUI 等上层组件集成，支持实时查询更新和流式结果推送
- **CLI 模式**（`codex-file-search` 二进制）：独立命令行工具，支持 JSON 输出和终端高亮

在架构层级中，FileSearch 是 ToolSystem 的子模块之一，与 shell 执行、apply-patch 等内置工具并列，由 Core 引擎在需要时调用。

## 关键流程

### 一次性搜索流程（`run` 函数）

这是最简单的使用方式，适用于 CLI 和不需要实时更新的场景：

1. 调用 `run()` 传入搜索模式、根目录列表和选项（`src/lib.rs:291-307`）
2. 内部创建一个 `RunReporter`（基于 `Condvar` 的同步 reporter）
3. 调用 `create_session()` 启动搜索会话
4. 立即调用 `session.update_query()` 提交查询
5. `RunReporter.wait_for_complete()` 阻塞等待直到目录遍历和匹配全部完成
6. 返回 `FileSearchResults`（匹配列表 + 总匹配数）

### 会话式搜索流程（`create_session` + `update_query`）

这是供 TUI 使用的交互式 API，支持用户输入变化时**增量更新**搜索结果：

1. 调用 `create_session()` 创建搜索会话（`src/lib.rs:158-211`）
2. 内部启动**两个后台线程**：
   - **Walker 线程**（`walker_worker`）：遍历文件系统，将发现的路径注入 `nucleo`
   - **Matcher 线程**（`matcher_worker`）：监听信号，驱动 `nucleo` 执行匹配，推送结果
3. 调用方通过 `session.update_query("pattern")` 更新查询，触发 `WorkSignal::QueryUpdated`
4. Matcher 线程收到信号后调用 `nucleo.pattern.reparse()`，若新查询是旧查询的前缀则使用 `append` 模式优化
5. 每次 `nucleo.tick()` 检测到结果变化时，构建 `FileSearchSnapshot` 并通过 `SessionReporter::on_update()` 推送
6. 当目录遍历完成且 nucleo 处理完毕后，调用 `SessionReporter::on_complete()`

### 目录遍历细节（Walker）

Walker 使用 `ignore` crate 的 `WalkBuilder` 并行遍历文件树（`src/lib.rs:411-481`）：

- 使用 `require_git(true)` 确保 `.gitignore` 规则仅在 git 仓库内生效，避免祖先目录的 `.gitignore`（如 `~/.gitignore` 含 `*`）意外屏蔽所有文件
- 启用 `hidden(false)` 以包含隐藏文件
- 启用 `follow_links(true)` 跟踪符号链接
- 当 `respect_gitignore = false` 时，完全禁用所有 git 忽略规则
- 每遍历 1024 个条目检查一次取消标志（`CHECK_INTERVAL`），支持中途取消
- 每个发现的路径通过 `Injector::push()` 注入 nucleo，使用相对路径作为匹配输入

### Matcher 事件循环

Matcher 线程运行一个基于 `crossbeam_channel::select!` 的事件循环（`src/lib.rs:483-604`），处理四种信号：

| 信号 | 来源 | 行为 |
|------|------|------|
| `QueryUpdated(query)` | 用户调用 `update_query` | 重新解析模式，立即触发 tick |
| `NucleoNotify` | nucleo 内部回调 | 10ms 去抖后触发 tick |
| `WalkComplete` | Walker 线程结束 | 标记遍历完成，触发最终 tick |
| `Shutdown` | Session drop | 退出事件循环 |

去抖策略：`QueryUpdated` 立即触发（0ms 延迟），`NucleoNotify` 延迟 10ms（`TICK_TIMEOUT_MS`），防止频繁唤醒。

## 函数签名与参数说明

### `run(pattern_text, roots, options, cancel_flag) -> Result<FileSearchResults>`

同步的一次性搜索入口。

| 参数 | 类型 | 说明 |
|------|------|------|
| `pattern_text` | `&str` | 模糊搜索模式 |
| `roots` | `Vec<PathBuf>` | 搜索根目录列表 |
| `options` | `FileSearchOptions` | 搜索配置 |
| `cancel_flag` | `Option<Arc<AtomicBool>>` | 可选的取消标志，设为 `true` 可中止搜索 |

> 源码位置：`src/lib.rs:291-307`

### `create_session(search_directories, options, reporter, cancel_flag) -> Result<FileSearchSession>`

创建一个可复用的搜索会话，返回 `FileSearchSession`。

| 参数 | 类型 | 说明 |
|------|------|------|
| `search_directories` | `Vec<PathBuf>` | 搜索根目录列表（至少一个） |
| `options` | `FileSearchOptions` | 搜索配置 |
| `reporter` | `Arc<dyn SessionReporter>` | 结果回调接口 |
| `cancel_flag` | `Option<Arc<AtomicBool>>` | 可选取消标志，多个 session 可共享同一标志 |

> 源码位置：`src/lib.rs:158-211`

### `FileSearchSession::update_query(pattern_text: &str)`

更新当前查询模式。调用后 matcher 线程会重新执行匹配并通过 reporter 推送更新。支持前缀追加优化（如 `"fo"` → `"foo"` 可增量匹配）。

> 源码位置：`src/lib.rs:143-148`

### `cmp_by_score_desc_then_path_asc(score_of, path_of) -> impl FnMut`

返回一个比较闭包，用于按分数降序、路径升序排序匹配结果。

> 源码位置：`src/lib.rs:320-333`

### `file_name_from_path(path: &str) -> String`

提取路径的最后一个组件（文件名），若为空则返回原始路径。

> 源码位置：`src/lib.rs:77-82`

## 接口/类型定义

### `FileMatch`

单个匹配结果。

| 字段 | 类型 | 说明 |
|------|------|------|
| `score` | `u32` | nucleo 返回的相关度分数 |
| `path` | `PathBuf` | 相对于搜索根目录的路径 |
| `match_type` | `MatchType` | `File` 或 `Directory` |
| `root` | `PathBuf` | 匹配到的搜索根目录 |
| `indices` | `Option<Vec<u32>>` | 匹配字符的索引（升序去重），仅在 `compute_indices=true` 时有值 |

提供 `full_path()` 方法返回 `root.join(path)` 的完整路径。序列化时 `indices` 为 `None` 则省略。

> 源码位置：`src/lib.rs:53-74`

### `MatchType`

```rust
pub enum MatchType {
    File,
    Directory,
}
```

序列化为小写字符串 `"file"` / `"directory"`。

### `FileSearchSnapshot`

会话模式下推送的增量快照。

| 字段 | 类型 | 说明 |
|------|------|------|
| `query` | `String` | 当前查询模式 |
| `matches` | `Vec<FileMatch>` | 当前 top-N 匹配结果 |
| `total_match_count` | `usize` | 全部匹配数（可能大于 matches 长度） |
| `scanned_file_count` | `usize` | 已扫描的文件总数 |
| `walk_complete` | `bool` | 目录遍历是否已完成 |

> 源码位置：`src/lib.rs:90-97`

### `SessionReporter` trait

会话模式的回调接口，需实现 `Send + Sync + 'static`。

| 方法 | 说明 |
|------|------|
| `on_update(&self, snapshot: &FileSearchSnapshot)` | 当去抖后的 top-N 结果变化时调用 |
| `on_complete(&self)` | 当搜索空闲或被取消时调用，每次 `update_query` 至少调用一次 |

> 源码位置：`src/lib.rs:129-135`

### `Reporter` trait

CLI 模式的输出接口，用于 `run_main` 函数。

| 方法 | 说明 |
|------|------|
| `report_match(&self, file_match: &FileMatch)` | 输出单个匹配结果 |
| `warn_matches_truncated(...)` | 结果被截断时的警告 |
| `warn_no_search_pattern(...)` | 未提供搜索模式时的提示 |

> 源码位置：`src/lib.rs:213-217`

## 配置项与默认值

### `FileSearchOptions`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `limit` | `NonZero<usize>` | 20（库）/ 64（CLI） | 最大返回结果数 |
| `exclude` | `Vec<String>` | `[]` | 排除模式列表，使用 `ignore` crate 的 override 语法 |
| `threads` | `NonZero<usize>` | 2 | Walker 工作线程数 |
| `compute_indices` | `bool` | `false` | 是否计算字符级匹配索引 |
| `respect_gitignore` | `bool` | `true` | 是否遵循 `.gitignore` 规则 |

> 源码位置：`src/lib.rs:99-127`

### CLI 参数（`Cli` 结构体）

| 参数 | 短名 | 默认值 | 说明 |
|------|------|--------|------|
| `--json` | - | `false` | 以 JSON 格式输出结果 |
| `--limit` | `-l` | 64 | 最大结果数 |
| `--cwd` | `-C` | 当前目录 | 搜索目录 |
| `--compute-indices` | - | `false` | 计算匹配索引（终端模式下显示粗体高亮） |
| `--threads` | - | 2 | 工作线程数 |
| `--exclude` / `-e` | `-e` | `[]` | 排除模式（可多次指定） |
| `<pattern>` | - | 无 | 搜索模式（位置参数，可选） |

> 源码位置：`src/cli.rs:1-42`

## 边界 Case 与注意事项

- **线程数默认为 2 而非 CPU 核数**：代码注释指出，经验表明文件遍历 I/O 是瓶颈，超过 2 个线程收益有限（`src/cli.rs:27-30`）

- **无搜索模式时的回退行为**：若未提供 `pattern`，CLI 不执行搜索，而是调用 `ls -al`（Unix）或 `cmd /c`（Windows）列出搜索目录内容（`src/lib.rs:237-258`）

- **Session Drop 与取消标志的区别**：`FileSearchSession` 在 drop 时设置自身的 `shutdown` 标志并发送 `Shutdown` 信号，但**不会**设置共享的 `cancel_flag`。这意味着多个 session 可以共享同一个 `cancel_flag`，drop 某个 session 不会影响兄弟 session（`src/lib.rs:151-156`，测试 `dropping_session_does_not_cancel_siblings_with_shared_cancel_flag`）

- **`require_git(true)` 的作用**：`ignore` crate 默认会读取遍历路径所有祖先目录的 `.gitignore`，这与 git 本身的行为不一致。设置 `require_git(true)` 后，仅在 git 仓库内才会应用 `.gitignore` 规则，防止用户根目录的 `.gitignore`（如含 `*`）意外屏蔽所有文件（`src/lib.rs:399-407`）

- **多根目录支持**：`search_directories` 支持传入多个根目录，`get_file_path()` 使用最深匹配（组件数最多的 root）来确定相对路径（`src/lib.rs:380-397`）

- **前缀追加优化**：当新查询是旧查询的前缀扩展时（如 `"fo"` → `"foo"`），`nucleo.pattern.reparse()` 使用 `append=true` 进行增量匹配而非全量重算（`src/lib.rs:507`）

- **匹配索引排序保证**：`indices` 字段中的索引保证唯一且升序排列，调用方可直接用于单遍 O(N) 高亮渲染，CLI 的 `StdioReporter` 中有示例实现（`src/main.rs:43-57`）