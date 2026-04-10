# Git 版本控制操作与 GitHub 集成

## 概述与职责

GitOperations 模块是 Claude Code 基础设施层（Infrastructure）的核心组成部分，为整个应用提供 Git 版本控制操作和 GitHub 集成能力。该模块封装了从底层 Git 文件系统读取到高层 worktree 管理的完整操作栈，被上层服务（上下文构建、权限校验、Issue 提交、Agent 子任务等）广泛依赖。

模块由以下几个子系统组成：

- **`git.ts`**：Git 命令封装层，提供仓库发现、状态查询、分支/远程信息获取等核心操作
- **`git/` 目录**：基于文件系统的 Git 状态读取（避免 spawn 子进程），包含配置解析、HEAD/ref 解析、文件监听缓存
- **`gitDiff.ts`**：差异分析引擎，支持全局 diff 统计和单文件 PR 级别 diff
- **`gitSettings.ts`**：Git 相关行为的用户设置隔离层
- **`github/`**：GitHub CLI（`gh`）认证状态检测
- **`githubRepoPathMapping.ts`**：GitHub 仓库路径的本地映射管理
- **`worktree.ts` / `worktreeModeEnabled.ts`**：Git worktree 的完整生命周期管理（创建、恢复、清理）

## 关键流程

### 1. Git 仓库发现与身份解析

模块通过两层机制定位 Git 仓库根目录：

1. **`findGitRoot(startPath)`** 从给定路径向上遍历目录树，查找 `.git` 目录或文件（worktree/submodule 使用 `.git` 文件）。使用 LRU 缓存（最多 50 条）避免重复遍历（`src/utils/git.ts:27-86`）。

2. **`findCanonicalGitRoot(startPath)`** 在 `findGitRoot` 基础上，通过 `.git` 文件 → `gitdir:` → `commondir` 链条解析到主仓库工作目录（`src/utils/git.ts:123-183`）。这确保同一仓库的所有 worktree 共享同一项目身份。

```
worktree/.git (file) → gitdir: /main-repo/.git/worktrees/wt-1
                        → commondir: ../..   → /main-repo/.git
                        → 主仓库根: /main-repo
```

**安全校验**（`src/utils/git.ts:142-170`）：`resolveCanonicalRoot` 会验证 worktree 结构的合法性——确认 `worktreeGitDir` 是 `<commonDir>/worktrees/` 的直接子目录，并且 `gitdir` 文件中的回链指向当前 `.git`，防止恶意仓库通过伪造 `commondir` 绕过信任对话框。

### 2. 基于文件系统的 Git 状态读取（零子进程）

`git/gitFilesystem.ts` 实现了一套完全基于文件读取的 Git 状态获取机制，避免了 `git` 子进程的启动开销（约 15ms/次）。

**`GitFileWatcher` 类**（`src/utils/git/gitFilesystem.ts:333-496`）是核心缓存层：

1. 启动时解析 `.git` 目录位置，使用 `fs.watchFile` 监听三个文件：
   - `.git/HEAD` — 分支切换、detached HEAD
   - `.git/config`（commonDir 中）— remote URL 变更
   - `.git/refs/heads/<当前分支>` — 新提交

2. 文件变更时将所有缓存标记为 `dirty`，下次访问时重新从磁盘读取

3. 分支切换时自动更新监听的 ref 文件，并延迟到滚动空闲期再执行 I/O

该缓存对外暴露四个接口：`getCachedBranch()`、`getCachedHead()`、`getCachedRemoteUrl()`、`getCachedDefaultBranch()`。

**ref 解析**（`src/utils/git/gitFilesystem.ts:203-266`）：`resolveRef()` 先检查 loose ref 文件，再回退到 `packed-refs`，并支持 symref 链式跟踪。所有读取都经过 `isSafeRefName()` 和 `isValidGitSha()` 校验，防止路径遍历和命令注入（`src/utils/git/gitFilesystem.ts:98-131`）。

### 3. Git Diff 分析

`gitDiff.ts` 提供两级 diff 能力：

**全局 diff（`fetchGitDiff()`）**（`src/utils/gitDiff.ts:49-108`）：
1. 检测是否处于 merge/rebase/cherry-pick/revert 等暂态（通过检查 `MERGE_HEAD` 等文件是否存在），如果是则跳过
2. 先用 `--shortstat` 做 O(1) 内存探测，如果文件数超过 500 则只返回统计总数（避免加载数百 MB 数据）
3. 正常路径使用 `--numstat` 获取每文件增删行数
4. 补充未追踪文件（通过 `ls-files --others --exclude-standard`）
5. Hunks 延迟获取（`fetchGitDiffHunks()`），仅在 DiffDialog 打开时触发

**单文件 diff（`fetchSingleFileGitDiff()`）**（`src/utils/gitDiff.ts:405-441`）：
1. 使用 merge-base 与默认分支做 diff（产生类似 PR 的视图）
2. 支持 `CLAUDE_CODE_BASE_REF` 环境变量覆盖 base ref
3. 未追踪文件生成合成 diff（全部为新增行）

**性能限制常量**：

| 常量 | 值 | 说明 |
|------|------|------|
| `GIT_TIMEOUT_MS` | 5000ms | git 命令超时 |
| `MAX_FILES` | 50 | perFileStats 最大文件数 |
| `MAX_DIFF_SIZE_BYTES` | 1MB | 跳过超大文件 diff |
| `MAX_LINES_PER_FILE` | 400 | 每文件最大 diff 行数 |
| `MAX_FILES_FOR_DETAILS` | 500 | 超过则跳过逐文件统计 |

### 4. Worktree 生命周期管理

`worktree.ts` 实现了完整的 Git worktree 管理，用于 Agent 子任务隔离和并行开发。

**创建流程（`getOrCreateWorktree()`）**（`src/utils/worktree.ts:235-375`）：
1. **快速恢复路径**：直接读取 `<worktreePath>/.git` 文件获取 HEAD SHA（无子进程），如果存在则立即返回
2. **新建路径**：
   - 确定 base 分支：PR 编号 → `fetch origin pull/N/head`；否则检查 `origin/<default>` 是否已存在本地（跳过 6-8s 的 fetch），不存在时才 fetch
   - 使用 `git worktree add -B worktree-<slug> <path> <base>` 创建
   - 支持 sparse-checkout（通过 `settings.worktree.sparsePaths` 配置）
3. **创建后设置（`performPostCreationSetup()`）**（`src/utils/worktree.ts:510-623`）：
   - 复制 `settings.local.json` 到 worktree
   - 配置 `core.hooksPath` 指向主仓库的 hooks 目录（`.husky` 或 `.git/hooks`）
   - 按配置符号链接目录（如 `node_modules`）避免磁盘膨胀
   - 复制 `.worktreeinclude` 指定的 gitignored 文件
   - 安装提交归属 hook

**清理流程**：
- **`cleanupWorktree()`**：清理当前会话 worktree，执行 `git worktree remove --force`，删除临时分支
- **`cleanupStaleAgentWorktrees(cutoffDate)`**（`src/utils/worktree.ts:1058-1136`）：周期性清理过期的临时 worktree。仅处理匹配临时模式（`agent-a*`、`wf_*`、`bridge-*`、`job-*`）的 slug，跳过有未提交变更或未推送提交的 worktree

**slug 安全校验（`validateWorktreeSlug()`）**（`src/utils/worktree.ts:66-87`）：
防止路径遍历攻击——slug 经 `path.join` 拼接，`..` 段会逃出 worktrees 目录。每个 `/` 分隔的段必须匹配 `[a-zA-Z0-9._-]+`，最长 64 字符。

### 5. 远程 URL 规范化与仓库哈希

`normalizeGitRemoteUrl()` 将 SSH 和 HTTPS 格式的远程 URL 统一为 `host/owner/repo` 小写格式（`src/utils/git.ts:283-321`）：

```
git@github.com:owner/repo.git     → github.com/owner/repo
https://github.com/owner/repo.git → github.com/owner/repo
http://proxy@127.0.0.1:PORT/git/owner/repo → github.com/owner/repo  (CCR 代理)
```

特别处理了 CCR git 代理 URL：本地地址 + `/git/` 前缀时，3 段路径视为 GHE 格式，2 段假定 github.com。

`getRepoRemoteHash()` 返回规范化 URL 的 SHA256 前 16 字符，用于不暴露仓库名的日志场景。

## 函数签名与参数说明

### git.ts — 核心 Git 操作

| 函数 | 签名 | 说明 |
|------|------|------|
| `findGitRoot` | `(startPath: string) => string \| null` | 向上查找 `.git`，返回仓库根路径 |
| `findCanonicalGitRoot` | `(startPath: string) => string \| null` | 解析到主仓库根（穿透 worktree） |
| `getIsGit` | `() => Promise<boolean>` | 当前目录是否在 Git 仓库内 |
| `getHead` | `() => Promise<string>` | 获取 HEAD commit SHA |
| `getBranch` | `() => Promise<string>` | 获取当前分支名 |
| `getDefaultBranch` | `() => Promise<string>` | 获取默认分支名（main/master） |
| `getRemoteUrl` | `() => Promise<string \| null>` | 获取 origin 远程 URL |
| `getGitState` | `() => Promise<GitRepoState \| null>` | 并行获取完整仓库状态快照 |
| `getIsClean` | `(options?: { ignoreUntracked?: boolean }) => Promise<boolean>` | 工作区是否干净 |
| `stashToCleanState` | `(message?: string) => Promise<boolean>` | 暂存所有变更（含未追踪文件） |
| `preserveGitStateForIssue` | `() => Promise<PreservedGitState \| null>` | 为 Issue 提交保存完整 Git 状态 |
| `isCurrentDirectoryBareGitRepo` | `() => boolean` | 检测裸仓库/沙箱逃逸攻击 |

### gitDiff.ts — 差异分析

| 函数 | 签名 | 说明 |
|------|------|------|
| `fetchGitDiff` | `() => Promise<GitDiffResult \| null>` | 获取工作区对 HEAD 的 diff 统计 |
| `fetchGitDiffHunks` | `() => Promise<Map<string, StructuredPatchHunk[]>>` | 按需获取 diff hunks |
| `fetchSingleFileGitDiff` | `(absoluteFilePath: string) => Promise<ToolUseDiff \| null>` | 单文件 PR 级 diff |
| `parseGitNumstat` | `(stdout: string) => NumstatResult` | 解析 `--numstat` 输出 |
| `parseGitDiff` | `(stdout: string) => Map<string, StructuredPatchHunk[]>` | 解析 unified diff 为结构化 hunks |
| `parseShortstat` | `(stdout: string) => GitDiffStats \| null` | 解析 `--shortstat` 输出 |

### worktree.ts — Worktree 管理

| 函数 | 签名 | 说明 |
|------|------|------|
| `createWorktreeForSession` | `(sessionId, slug, tmuxName?, options?) => Promise<WorktreeSession>` | 创建会话 worktree |
| `createAgentWorktree` | `(slug: string) => Promise<{worktreePath, ...}>` | 创建轻量 Agent worktree |
| `removeAgentWorktree` | `(path, branch?, root?, hook?) => Promise<boolean>` | 移除 Agent worktree |
| `cleanupWorktree` | `() => Promise<void>` | 清理当前会话 worktree |
| `keepWorktree` | `() => Promise<void>` | 保留 worktree 不删除 |
| `cleanupStaleAgentWorktrees` | `(cutoffDate: Date) => Promise<number>` | 清理过期临时 worktree |
| `hasWorktreeChanges` | `(path, headCommit) => Promise<boolean>` | 检测 worktree 是否有变更 |
| `execIntoTmuxWorktree` | `(args: string[]) => Promise<{handled, error?}>` | tmux + worktree 快速路径 |
| `validateWorktreeSlug` | `(slug: string) => void` | 校验 slug 安全性（抛出异常） |

## 接口/类型定义

### `GitRepoState`（`src/utils/git.ts:463-470`）

仓库状态快照，由 `getGitState()` 返回：

| 字段 | 类型 | 说明 |
|------|------|------|
| `commitHash` | `string` | HEAD commit SHA |
| `branchName` | `string` | 当前分支名 |
| `remoteUrl` | `string \| null` | origin 远程 URL |
| `isHeadOnRemote` | `boolean` | HEAD 是否有对应的上游 |
| `isClean` | `boolean` | 工作区是否干净 |
| `worktreeCount` | `number` | worktree 数量 |

### `PreservedGitState`（`src/utils/git.ts:528-545`）

Issue 提交的 Git 状态保存，支持在远程容器中重放：

| 字段 | 类型 | 说明 |
|------|------|------|
| `remote_base_sha` | `string \| null` | merge-base SHA |
| `remote_base` | `string \| null` | 远程 base 分支 |
| `patch` | `string` | merge-base 到当前状态的 patch |
| `untracked_files` | `Array<{path, content}>` | 未追踪文件内容 |
| `format_patch` | `string \| null` | git format-patch 输出（保留提交链） |
| `head_sha` | `string \| null` | 当前 HEAD SHA |
| `branch_name` | `string \| null` | 当前分支名 |

### `WorktreeSession`（`src/utils/worktree.ts:140-154`）

活跃 worktree 会话信息：

| 字段 | 类型 | 说明 |
|------|------|------|
| `originalCwd` | `string` | 原始工作目录 |
| `worktreePath` | `string` | worktree 路径 |
| `worktreeName` | `string` | worktree slug |
| `worktreeBranch` | `string?` | worktree 分支名 |
| `originalBranch` | `string?` | 原始分支名 |
| `originalHeadCommit` | `string?` | 创建时的 HEAD SHA |
| `sessionId` | `string` | 会话 ID |
| `hookBased` | `boolean?` | 是否通过 hook 创建 |
| `creationDurationMs` | `number?` | 创建耗时 |
| `usedSparsePaths` | `boolean?` | 是否使用 sparse-checkout |

### `GitDiffResult` / `ToolUseDiff`（`src/utils/gitDiff.ts:16-33, 386-395`）

diff 结果的结构化表示，`GitDiffResult` 用于全局 diff 轮询，`ToolUseDiff` 用于工具调用时的单文件 diff。

## 配置项与默认值

| 配置项 | 来源 | 默认值 | 说明 |
|--------|------|--------|------|
| `includeGitInstructions` | settings.json | `true` | 是否在提示词中包含 Git 指令 |
| `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` | 环境变量 | 未设置 | 设为 truthy 值禁用 Git 指令 |
| `CLAUDE_CODE_BASE_REF` | 环境变量 | 未设置 | 覆盖单文件 diff 的 base ref |
| `worktree.sparsePaths` | settings.json | `[]` | worktree 的 sparse-checkout 路径 |
| `worktree.symlinkDirectories` | settings.json | `[]` | 符号链接到 worktree 的目录（如 `node_modules`） |

## 边界 Case 与注意事项

- **裸仓库安全检测**：`isCurrentDirectoryBareGitRepo()`（`src/utils/git.ts:876-926`）检测沙箱逃逸攻击——攻击者在 cwd 放置 `HEAD`、`objects/`、`refs/` 伪造裸仓库，使 git 执行恶意 hooks。如果 `.git/HEAD` 不存在或非普通文件，则检查 cwd 中是否有裸仓库指标。

- **V8 sliced string 内存泄漏**：`parseGitDiff()` 中使用 `'' + line` 强制创建新字符串（`src/utils/gitDiff.ts:282`），打断 V8 sliced string 对父字符串（可能数 MB）的引用。

- **Worktree commondir 安全**：恶意仓库可通过伪造 `.git` 文件和 `commondir` 指向任意路径。`resolveCanonicalRoot` 执行双重验证：worktreeGitDir 必须在 `<commonDir>/worktrees/` 下，且 `gitdir` 回链必须指向当前 `.git`（`src/utils/git.ts:149-170`）。

- **Shallow clone 降级**：`preserveGitStateForIssue()` 检测到浅克隆时自动降级到 HEAD-only 模式（`src/utils/git.ts:732-747`）。

- **Transient Git 状态跳过**：diff 计算在 merge/rebase/cherry-pick/revert 期间被跳过（`src/utils/gitDiff.ts:307-326`），因为工作区包含的是传入变更而非用户编辑。

- **gitSettings.ts 的存在原因**：`git.ts` 被 VS Code 扩展依赖，必须不引入 `settings.ts`（后者会拉入 `@opentelemetry/api` + `undici`，VS Code 中禁止）。同时 `settings.ts → git/gitignore.ts → git.ts` 存在循环依赖。因此 Git 相关设置查询被隔离到 `gitSettings.ts`（`src/utils/gitSettings.ts:1-8`）。

- **`copyWorktreeIncludeFiles` 的性能优化**：使用 `--directory` 标志让 git 将完全 gitignored 的目录折叠为单条记录（如 `node_modules/`），在大仓库中将约 500k 条目/7s 降至数百条/100ms（`src/utils/worktree.ts:410-417`）。

- **Worktree 分支名展平**：嵌套 slug（如 `user/feature`）被展平为 `user+feature`（`src/utils/worktree.ts:217-219`），避免 git ref 的 D/F 冲突和 worktree 嵌套删除问题。

- **`gh auth token` vs `gh auth status`**：`ghAuthStatus.ts` 使用 `auth token`（仅读本地配置）而非 `auth status`（发起网络请求），且 stdout 设为 `ignore` 防止 token 泄露到进程内存（`src/utils/github/ghAuthStatus.ts:15-16`）。