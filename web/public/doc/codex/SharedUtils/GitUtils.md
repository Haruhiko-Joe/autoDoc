# GitUtils — Git 仓库操作工具库

## 概述与职责

`codex-git-utils` 是 Codex 项目中的底层 Git 操作工具 crate，属于 **SharedUtils** 模块群。它为上层模块（Core、ToolSystem 等）提供了一组与 Git 仓库交互的基础能力，包括：

- **补丁应用与暂存**：将 unified diff 通过 `git apply` 应用到工作区，支持预检（dry-run）和回退（revert）
- **分支 merge-base 计算**：确定 HEAD 与指定分支的共同祖先
- **Ghost Commit 快照**：捕获仓库完整状态（含未跟踪文件）为悬空提交，并支持恢复
- **仓库信息收集**：获取远程 URL、HEAD 哈希、分支名、最近提交记录、与远程的 diff
- **跨平台符号链接**：统一 Unix/Windows 的符号链接创建

该 crate 不依赖 `git2`（libgit2），所有 Git 操作均通过调用系统 `git` 二进制完成。异步函数使用 tokio，同步函数使用 `std::process::Command`。

## 关键流程

### 1. 补丁应用流程 (`apply_git_patch`)

入口函数 `apply_git_patch` 接收 `ApplyGitRequest`，流程如下：

1. 通过 `git rev-parse --show-toplevel` 解析仓库根目录（`src/apply.rs:126-142`）
2. 将 diff 内容写入临时文件（`src/apply.rs:144-149`）
3. 若为 **revert 模式**且非预检，先调用 `stage_paths()` 暂存工作区文件以避免 index 不匹配
4. 构建 `git apply --3way` 命令；可通过环境变量 `CODEX_APPLY_GIT_CFG` 注入额外 git 配置
5. 若为 **preflight 模式**，使用 `git apply --check` 做干运行，不修改工作区
6. 执行命令后，调用 `parse_git_apply_output()` 解析 stdout/stderr，将路径分为三类：`applied`、`skipped`、`conflicted`

解析器（`src/apply.rs:347-589`）使用大量正则匹配 `git apply` 的各种输出格式（包括三方合并失败、二进制补丁错误、index 不匹配等），最终按 **conflicts > applied > skipped** 的优先级去重。

### 2. Ghost Commit 创建流程 (`create_ghost_commit`)

Ghost Commit 是一种"悬空提交"——它不更新任何 ref，因此不会出现在用户的分支历史中。用于实现 Codex 的 undo 功能。

1. 校验 Git 仓库有效性，解析仓库根目录和子目录前缀（`src/ghost_commits.rs:305-309`）
2. 解析当前 HEAD 作为 parent commit
3. 通过 `git status --porcelain=2 -z --untracked-files=all` 捕获工作区快照（`src/ghost_commits.rs:514-675`）：
   - 解析 tracked 文件（modified/renamed/unmerged）
   - 收集 untracked 文件和目录
   - 排除 `node_modules`、`.venv`、`__pycache__` 等默认忽略目录
   - 排除超过阈值的大文件（默认 10 MiB）和大目录（默认 200 文件）
4. 使用临时 index 文件构建快照树，不干扰用户的真实 index：
   - `GIT_INDEX_FILE=/tmp/index git read-tree HEAD` — 以 HEAD 为基础
   - `GIT_INDEX_FILE=/tmp/index git add --all -- <paths>` — 添加变更文件
   - `GIT_INDEX_FILE=/tmp/index git write-tree` — 写入 tree 对象
   - `GIT_INDEX_FILE=/tmp/index git commit-tree <tree> -p <parent> -m "codex snapshot"` — 创建提交
5. 返回 `GhostCommit`，其中记录了 commit ID、parent 以及创建时已存在的未跟踪文件/目录列表

### 3. Ghost Commit 恢复流程 (`restore_ghost_commit`)

1. 捕获当前工作区的未跟踪文件快照
2. 调用 `git restore --source <commit> --worktree -- <prefix>` 恢复工作区到快照状态（`src/ghost_commits.rs:467-494`）
   - **故意不使用 `--staged`**，以保留用户手动暂存的更改，确保数据安全
3. 删除快照创建后新增的未跟踪文件/目录，但保留快照时已存在的文件

### 4. 仓库信息收集 (`collect_git_info`)

所有 git 命令带 5 秒超时（`src/info.rs:41`），防止在大仓库上阻塞。

1. 先通过 `git rev-parse --git-dir` 检查是否在 Git 仓库中
2. 使用 `tokio::join!` **并行**执行三个查询（`src/info.rs:78-82`）：
   - `git rev-parse HEAD` — 获取 commit hash
   - `git rev-parse --abbrev-ref HEAD` — 获取分支名
   - `git remote get-url origin` — 获取远程 URL

### 5. Diff to Remote (`git_diff_to_remote`)

计算本地与远程之间的差异：

1. 通过 `branch_ancestry()` 构建分支祖先链：当前分支 → 默认分支 → 包含 HEAD 的远程分支
2. 对每个候选分支，查找最近的远程 SHA 并计算与 HEAD 的距离（`src/info.rs:459-535`）
3. 选择距离最近的远程 SHA，执行 `git diff --no-textconv --no-ext-diff <sha>`
4. 额外将未跟踪文件的 diff 也拼接进来（通过 `git diff --no-index -- /dev/null <file>`）

### 6. Merge-base 计算 (`merge_base_with_head`)

1. 校验仓库并解析 HEAD 和目标分支 ref
2. 检查本地分支是否有上游（upstream），若上游比本地 **领先**，则优先使用上游 ref 作为 merge-base 的参考（`src/branch.rs:68-117`）
3. 执行 `git merge-base HEAD <preferred_ref>` 返回共同祖先 SHA

## 函数签名与参数说明

### 补丁模块 (`apply`)

#### `apply_git_patch(req: &ApplyGitRequest) -> io::Result<ApplyGitResult>`

应用 unified diff 到仓库。

- `req.cwd: PathBuf` — 工作目录
- `req.diff: String` — unified diff 文本
- `req.revert: bool` — 是否反向应用（`-R`）
- `req.preflight: bool` — 是否只做检查不实际修改

> 源码位置：`src/apply.rs:41-124`

#### `extract_paths_from_patch(diff_text: &str) -> Vec<String>`

从 diff 文本中提取所有涉及的文件路径。支持引号包裹和 C 风格转义路径。

> 源码位置：`src/apply.rs:194-212`

#### `stage_paths(git_root: &Path, diff: &str) -> io::Result<()>`

对 diff 涉及的且在磁盘上存在的文件执行 `git add`。为 revert 模式的前置步骤。

> 源码位置：`src/apply.rs:320-342`

#### `parse_git_apply_output(stdout: &str, stderr: &str) -> (Vec<String>, Vec<String>, Vec<String>)`

解析 `git apply` 输出，返回 `(applied, skipped, conflicted)` 三组路径。

> 源码位置：`src/apply.rs:347-589`

### Ghost Commit 模块 (`ghost_commits`)

#### `create_ghost_commit(options: &CreateGhostCommitOptions) -> Result<GhostCommit, GitToolingError>`

创建一个不更新 ref 的快照提交。

#### `create_ghost_commit_with_report(options: &CreateGhostCommitOptions) -> Result<(GhostCommit, GhostSnapshotReport), GitToolingError>`

同上，但额外返回快照报告（跳过的大文件/大目录信息）。

> 源码位置：`src/ghost_commits.rs:302-424`

#### `restore_ghost_commit(repo_path: &Path, commit: &GhostCommit) -> Result<(), GitToolingError>`

恢复工作区到 ghost commit 记录的状态，同时清理新增的未跟踪文件。

#### `restore_to_commit(repo_path: &Path, commit_id: &str) -> Result<(), GitToolingError>`

恢复工作区到任意 commit ID 对应的状态（不清理未跟踪文件）。

### 分支模块 (`branch`)

#### `merge_base_with_head(repo_path: &Path, branch: &str) -> Result<Option<String>, GitToolingError>`

返回 HEAD 与指定分支（本地或远程更新版本）的 merge-base SHA。当仓库无 HEAD 或分支不存在时返回 `Ok(None)`。

> 源码位置：`src/branch.rs:15-48`

### 信息模块 (`info`)

#### `collect_git_info(cwd: &Path) -> Option<GitInfo>` (async)

并行收集 commit hash、分支名、远程 URL。所有命令带 5 秒超时。

#### `get_git_remote_urls(cwd: &Path) -> Option<BTreeMap<String, String>>` (async)

返回仓库的 fetch remote 映射，如 `{"origin": "https://..."}`。

#### `get_head_commit_hash(cwd: &Path) -> Option<GitSha>` (async)

返回当前 HEAD 的 commit SHA。

#### `get_has_changes(cwd: &Path) -> Option<bool>` (async)

通过 `git status --porcelain` 检测工作区是否有变更。

#### `recent_commits(cwd: &Path, limit: usize) -> Vec<CommitLogEntry>` (async)

返回最近 `limit` 个提交的 SHA、时间戳和 subject。

#### `git_diff_to_remote(cwd: &Path) -> Option<GitDiffToRemote>` (async)

返回距离最近的远程 SHA 及与之的 diff。

#### `default_branch_name(cwd: &Path) -> Option<String>` (async)

检测仓库默认分支名。优先检查 remote symbolic-ref，回退到 `git remote show`，最后尝试本地 `main`/`master`。

#### `local_git_branches(cwd: &Path) -> Vec<String>` (async)

返回排序后的本地分支列表，默认分支排在最前。

#### `current_branch_name(cwd: &Path) -> Option<String>` (async)

返回当前签出的分支名。

#### `get_git_repo_root(base_dir: &Path) -> Option<PathBuf>`

通过向上遍历目录查找 `.git` 入口来确定仓库根目录。不调用 `git` 二进制。

#### `resolve_root_git_project_for_trust(cwd: &Path) -> Option<PathBuf>`

用于信任检查。对 worktree 场景，解析到主仓库根目录（通过解析 `.git` 文件中的 `gitdir:` 指向）。

> 源码位置：`src/info.rs:621-647`

### 平台模块 (`platform`)

#### `create_symlink(source: &Path, link_target: &Path, destination: &Path) -> Result<(), GitToolingError>`

跨平台符号链接创建。Unix 上直接调用 `std::os::unix::fs::symlink`；Windows 上根据源文件是否为符号链接目录选择 `symlink_dir` 或 `symlink_file`。

> 源码位置：`src/platform.rs:1-37`

## 接口/类型定义

### `GhostCommit`

```rust
pub struct GhostCommit {
    id: CommitID,                             // 快照 commit 的 SHA
    parent: Option<CommitID>,                 // 创建时的 HEAD SHA
    preexisting_untracked_files: Vec<PathBuf>, // 快照时已存在的未跟踪文件
    preexisting_untracked_dirs: Vec<PathBuf>,  // 快照时已存在的未跟踪目录
}
```

> 源码位置：`src/lib.rs:67-116`

### `GitSha`

透明包装的 `String` 类型，表示 Git SHA 值。实现了 `Serialize`/`Deserialize`/`JsonSchema`/`TS`。

> 源码位置：`src/lib.rs:55-64`

### `GitInfo`

| 字段 | 类型 | 说明 |
|------|------|------|
| `commit_hash` | `Option<GitSha>` | 当前 HEAD 的 SHA |
| `branch` | `Option<String>` | 当前分支名（detached HEAD 时为 None） |
| `repository_url` | `Option<String>` | origin 远程 URL |

> 源码位置：`src/info.rs:43-54`

### `CommitLogEntry`

| 字段 | 类型 | 说明 |
|------|------|------|
| `sha` | `String` | 提交 SHA |
| `timestamp` | `i64` | Unix 时间戳（秒） |
| `subject` | `String` | 提交消息首行 |

> 源码位置：`src/info.rs:197-204`

### `ApplyGitRequest` / `ApplyGitResult`

请求与结果结构体，详见上文函数签名部分。

### `GhostSnapshotConfig`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `ignore_large_untracked_files` | `Option<i64>` | `Some(10_485_760)` | 超过此字节数的未跟踪文件不纳入快照 |
| `ignore_large_untracked_dirs` | `Option<i64>` | `Some(200)` | 含超过此数量文件的未跟踪目录不纳入快照 |
| `disable_warnings` | `bool` | `false` | 是否禁用警告报告 |

> 源码位置：`src/ghost_commits.rs:64-79`

### `GitToolingError`

基于 `thiserror` 的错误枚举，覆盖以下场景：

- `GitCommand` — git 命令执行失败（含命令字符串、退出状态、stderr）
- `GitOutputUtf8` — git 输出非 UTF-8
- `NotAGitRepository` — 不在 Git 仓库中
- `NonRelativePath` / `PathEscapesRepository` — 路径安全校验失败
- `PathPrefix` / `Walkdir` / `Io` — 底层错误透传

> 源码位置：`src/errors.rs:1-35`

## 配置项与默认值

- **`CODEX_APPLY_GIT_CFG`**：环境变量，逗号分隔的 `key=value` 对，作为 `git -c` 参数传递给 `git apply`。默认不设置。
- **`GIT_COMMAND_TIMEOUT`**：info 模块中所有异步 git 命令的超时时间，硬编码为 **5 秒**（`src/info.rs:41`）
- **默认忽略目录名**：`node_modules`、`.venv`、`venv`、`env`、`.env`、`dist`、`build`、`.pytest_cache`、`.mypy_cache`、`.cache`、`.tox`、`__pycache__`（`src/ghost_commits.rs:35-48`）
- **大文件阈值**：10 MiB（`src/ghost_commits.rs:29`）
- **大目录阈值**：200 个文件（`src/ghost_commits.rs:27`）
- **Ghost Commit 作者**：`Codex Snapshot <codex-snapshot@openai.com>`（`src/ghost_commits.rs:889+`）

## 边界 Case 与注意事项

- **Detached HEAD**：`collect_git_info` 在 detached HEAD 时 `branch` 返回 `None`（`rev-parse --abbrev-ref HEAD` 返回 "HEAD" 时被过滤）
- **空仓库（无提交）**：`resolve_head` 在无 HEAD 时返回 `Ok(None)`，ghost commit 创建时不设 parent、不执行 `read-tree`
- **Worktree 支持**：`get_git_repo_root` **不支持** `git worktree add` 创建的外部 checkout（`src/info.rs:28-30`）；但 `resolve_root_git_project_for_trust` 能正确追踪 worktree 的 `.git` 文件回到主仓库
- **Ghost Commit 恢复时不使用 `--staged`**：这是有意设计，避免清除用户手动暂存的内容，优先数据安全
- **临时 index**：ghost commit 创建使用独立的临时 index 文件，不干扰用户的暂存区
- **命令行长度限制**：`add_paths_to_index` 将路径分块（每块 64 个）执行 `git add`，避免大仓库下参数过长
- **Windows 符号链接**：`create_symlink` 在 Windows 上区分文件和目录符号链接，需要对应的权限
- **`GIT_OPTIONAL_LOCKS=0`**：异步 git 命令设置此环境变量，避免在只读查询中获取锁
- **补丁解析器支持 C 风格转义路径**：`extract_paths_from_patch` 和 `parse_git_apply_output` 都能处理 Git 对含特殊字符路径的引号/转义输出