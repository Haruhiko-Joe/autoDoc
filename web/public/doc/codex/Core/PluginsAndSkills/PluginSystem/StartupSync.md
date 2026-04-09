# StartupSync — 策展插件仓库启动同步

## 概述与职责

StartupSync 模块是 PluginSystem 子系统的一部分，负责在 Codex 启动时将 OpenAI 官方策展插件仓库（`openai/plugins`）从 GitHub 同步到本地。它位于 **Core → PluginsAndSkills → PluginSystem** 层级中，与插件发现、Manifest 解析、Marketplace 集成等兄弟模块协作，为整个插件系统提供本地可用的策展插件源。

该模块承担两项核心职责：

1. **本地仓库同步**：通过 git 浅克隆（首选）或 GitHub HTTP zipball（备选）将远端插件仓库拉取到 `$CODEX_HOME/.tmp/plugins/`
2. **远程插件状态同步**：编排一次性的远程插件同步任务（`start_startup_remote_plugin_sync_once`），在策展 Marketplace 就绪后从 ChatGPT 后端拉取用户的插件启用/禁用状态

> 源码位置：`codex-rs/core/src/plugins/startup_sync.rs`

## 关键流程

### 1. 本地仓库同步主流程

入口函数 `sync_openai_plugins_repo()` 采用**双传输通道 + 自动降级**策略：

```
sync_openai_plugins_repo
  └── sync_openai_plugins_repo_with_transport_overrides
        ├── [首选] sync_openai_plugins_repo_via_git
        │     失败时 ──▶ emit metric("git", "failure")
        └── [备选] sync_openai_plugins_repo_via_http
```

每次同步尝试（无论成功还是失败）都会通过 OpenTelemetry 发射 counter 指标，标记 `transport`（"git" / "http"）和 `status`（"success" / "failure"）。发射两类指标：每次尝试的 `CURATED_PLUGINS_STARTUP_SYNC_METRIC` 和最终结果的 `CURATED_PLUGINS_STARTUP_SYNC_FINAL_METRIC`（`startup_sync.rs:356-382`）。

### 2. Git 同步路径

`sync_openai_plugins_repo_via_git()` 的执行步骤（`startup_sync.rs:92-127`）：

1. **查询远端 SHA**：`git ls-remote https://github.com/openai/plugins.git HEAD` 获取远端 HEAD 的 commit SHA
2. **比对本地 SHA**：优先从本地 `.git` 目录读取（`git rev-parse HEAD`），回退到 `.tmp/plugins.sha` 文件
3. **短路优化**：若远端 SHA == 本地 SHA 且 `.git` 目录存在，直接返回，跳过克隆
4. **准备暂存目录**：在 `.tmp/` 下创建 `plugins-clone-*` 临时目录，同时清理超龄（>10分钟）的旧临时目录
5. **浅克隆**：`git clone --depth 1` 到临时目录，设置 `GIT_OPTIONAL_LOCKS=0` 避免锁竞争
6. **SHA 校验**：验证克隆后的 HEAD SHA 与预期一致
7. **Manifest 验证**：确认 `.agents/plugins/marketplace.json` 存在
8. **原子激活**：将临时目录移动到最终路径（带备份/回滚机制）
9. **写入 SHA 文件**：持久化 SHA 到 `.tmp/plugins.sha`

所有 git 命令通过 `run_git_command_with_timeout()` 执行，超时时间为 30 秒（`startup_sync.rs:534-586`）。该函数以 100ms 间隔轮询子进程状态，超时后执行 kill 并收集 stderr 输出。

### 3. HTTP 备选路径

`sync_openai_plugins_repo_via_http()` 在 git 不可用或失败时启动（`startup_sync.rs:129-153`）：

1. **获取远端 SHA**：通过 GitHub REST API 两步完成：
   - `GET /repos/openai/plugins` → 获取 `default_branch`
   - `GET /repos/openai/plugins/git/ref/heads/{branch}` → 获取 HEAD SHA
2. **短路优化**：SHA 匹配且本地目录存在时直接返回
3. **下载 zipball**：`GET /repos/openai/plugins/zipball/{sha}`
4. **解压提取**：使用 `zip` crate 解压，自动跳过 GitHub zipball 的顶层目录前缀（如 `openai-plugins-{sha}/`），在 Unix 平台保留文件权限
5. **后续步骤**与 git 路径相同：Manifest 验证 → 原子激活 → 写入 SHA

HTTP 请求统一使用 `application/vnd.github+json` Accept 头和 `x-github-api-version: 2022-11-28` 版本头（`startup_sync.rs:678-684`），超时 30 秒。

### 4. 原子激活与回滚

`activate_curated_repo()` 实现了安全的目录替换（`startup_sync.rs:394-448`）：

- 若目标路径已存在旧仓库：
  1. 创建 `plugins-backup-*` 临时目录
  2. 将旧仓库 `rename` 到备份位置
  3. 将新仓库 `rename` 到目标位置
  4. 若步骤 3 失败，尝试从备份回滚；若回滚也失败，保留备份目录并在错误信息中报告其路径
- 若目标路径不存在：直接 `rename` 即可

### 5. 远程插件状态同步

`start_startup_remote_plugin_sync_once()` 编排一次性的远程状态同步（`startup_sync.rs:155-210`）：

1. **幂等性保证**：检查 marker 文件 `.tmp/app-server-remote-plugin-sync-v1` 是否存在，存在则直接返回（双重检查：同步检查 + spawn 后异步检查）
2. **等待前置条件**：以 50ms 间隔轮询，等待 `marketplace.json` 和 `plugins.sha` 两个文件就绪，超时 5 秒
3. **执行同步**：通过 `PluginsManager.sync_plugins_from_remote()` 以 `additive_only=true` 模式同步（只新增，不删除）
4. **写入 marker**：成功后写入 marker 文件（内容为 `ok\n`），防止下次启动重复执行
5. **失败容忍**：同步失败仅记录警告日志，下次启动会重试

## 函数签名与参数说明

### 公开接口（`pub(crate)`）

#### `curated_plugins_repo_path(codex_home: &Path) -> PathBuf`
返回策展插件仓库的本地路径：`{codex_home}/.tmp/plugins`

#### `read_curated_plugins_sha(codex_home: &Path) -> Option<String>`
从 `{codex_home}/.tmp/plugins.sha` 读取并返回经 trim 的 SHA 字符串。文件不存在或内容为空时返回 `None`。

#### `sync_openai_plugins_repo(codex_home: &Path) -> Result<String, String>`
主同步入口。成功返回远端 HEAD SHA，失败返回错误描述。

### 模块内接口（`pub(super)`）

#### `start_startup_remote_plugin_sync_once(manager: Arc<PluginsManager>, codex_home: PathBuf, config: Config, auth_manager: Arc<AuthManager>)`
启动一次性远程插件同步后台任务。通过 `tokio::spawn` 异步执行，不阻塞调用方。

## 类型定义

### `GitHubRepositorySummary`（内部）
GitHub 仓库 API 响应的反序列化目标，仅提取 `default_branch` 字段。

### `GitHubGitRefSummary` / `GitHubGitRefObject`（内部）
GitHub Git Ref API 响应的反序列化目标，提取 `object.sha` 字段用于获取 HEAD commit SHA。

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|-----|------|
| `CURATED_PLUGINS_RELATIVE_DIR` | `.tmp/plugins` | 本地仓库相对 codex_home 的路径 |
| `CURATED_PLUGINS_SHA_FILE` | `.tmp/plugins.sha` | SHA 追踪文件路径 |
| `CURATED_PLUGINS_GIT_TIMEOUT` | 30s | git 命令超时 |
| `CURATED_PLUGINS_HTTP_TIMEOUT` | 30s | HTTP 请求超时 |
| `CURATED_PLUGINS_STALE_TEMP_DIR_MAX_AGE` | 10min | 临时目录过期阈值（防止与并发 Codex 进程竞争） |
| `STARTUP_REMOTE_PLUGIN_SYNC_MARKER_FILE` | `.tmp/app-server-remote-plugin-sync-v1` | 远程同步完成标记文件 |
| `STARTUP_REMOTE_PLUGIN_SYNC_PREREQUISITE_TIMEOUT` | 5s | 等待 marketplace 就绪的超时 |

## 边界 Case 与注意事项

- **并发安全**：临时目录使用 `tempfile` crate 保证名称唯一性，10 分钟过期阈值高于正常同步时间，避免清理掉另一个 Codex 进程正在使用的临时目录
- **SHA 不匹配保护**：git 路径会在克隆后验证 HEAD SHA 是否与 `ls-remote` 查询结果一致，防止 clone 过程中远端更新导致不一致
- **Manifest 验证**：无论 git 还是 HTTP 路径，激活前都会验证 `.agents/plugins/marketplace.json` 存在，缺失则中止同步
- **Zipball 顶层目录剥离**：GitHub zipball 的条目都带有 `{owner}-{repo}-{sha}/` 前缀，`extract_zipball_to_dir()` 通过跳过第一个路径组件来处理（`startup_sync.rs:716-729`）
- **路径遍历防御**：使用 `entry.enclosed_name()` 确保 zip 条目不会逃逸到提取根目录之外（`startup_sync.rs:709-714`）
- **Unix 权限保留**：仅在 Unix 平台上通过 `apply_zip_permissions()` 恢复 zip 条目中记录的文件权限模式
- **远程同步的 additive_only 模式**：`sync_plugins_from_remote` 以 `additive_only=true` 调用，意味着只会安装/启用来自后端的插件，不会卸载本地已有的插件
- **marker 文件的幂等性**：远程同步通过 marker 文件实现"最多执行一次"语义（per codex_home），但 marker 写入失败不会阻止同步结果生效

## 关键代码片段

双传输降级策略的核心逻辑：

```rust
// startup_sync.rs:70-90
match sync_openai_plugins_repo_via_git(codex_home, git_binary) {
    Ok(remote_sha) => {
        emit_curated_plugins_startup_sync_metric("git", "success");
        emit_curated_plugins_startup_sync_final_metric("git", "success");
        Ok(remote_sha)
    }
    Err(err) => {
        emit_curated_plugins_startup_sync_metric("git", "failure");
        warn!(error = %err, "git sync failed; falling back to GitHub HTTP");
        let result = sync_openai_plugins_repo_via_http(codex_home, api_base_url);
        let status = if result.is_ok() { "success" } else { "failure" };
        emit_curated_plugins_startup_sync_metric("http", status);
        emit_curated_plugins_startup_sync_final_metric("http", status);
        result
    }
}
```

原子激活时的备份/回滚处理（`startup_sync.rs:414-437`）：

```rust
// 将旧仓库移到备份位置
std::fs::rename(repo_path, &backup_repo_path)?;
// 将新仓库移入目标位置
if let Err(err) = std::fs::rename(staged_repo_path, repo_path) {
    // 激活失败——尝试回滚
    let rollback_result = std::fs::rename(&backup_repo_path, repo_path);
    // 若回滚也失败，保留备份目录供人工恢复
}
```