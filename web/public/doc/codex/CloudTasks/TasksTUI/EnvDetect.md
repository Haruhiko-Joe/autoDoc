# EnvDetect — 环境自动检测与列表

## 概述与职责

EnvDetect 模块是 CloudTasks → TasksTUI 子系统中的环境发现组件，负责**自动检测当前代码仓库所关联的云端 Code Environment**，以及为 TUI 环境选择弹窗提供完整的环境列表。

在整体架构中，CloudTasks 是 Codex 的远程云任务管理子系统，TasksTUI 是其终端交互界面。EnvDetect 为 TasksTUI 解决了一个关键问题：当用户在本地仓库中启动云任务时，自动确定应该使用哪个远程环境——无需用户手动输入环境 ID。它通过解析本地 git remote URL 提取 GitHub owner/repo 信息，然后查询后端 API 获取匹配的环境。

同级模块包括 TasksClient（API 客户端）、TasksMockClient（Mock 客户端）和 CloudRequirements（云端配置加载）。

源码位于 `codex-rs/cloud-tasks/src/env_detect.rs`。

## 关键流程

### 自动检测流程（`autodetect_environment_id`）

这是模块的核心入口，采用**两阶段回退策略**：

**阶段 1：基于仓库的精准匹配**

1. 调用 `get_git_origins()` 获取本地 git 仓库的所有 remote URL
2. 对每个 URL 调用 `parse_owner_repo()` 尝试提取 GitHub `owner/repo`
3. 对成功解析的每对 owner/repo，请求后端 `by-repo` 端点（`/wham/environments/by-repo/github/{owner}/{repo}` 或 `/api/codex/environments/by-repo/github/{owner}/{repo}`，取决于 base_url 的格式）
4. 将所有返回的环境汇总后，调用 `pick_environment_row()` 进行选择

**阶段 2：全局环境列表回退**

5. 如果阶段 1 未找到匹配环境，请求全局环境列表端点（`/wham/environments` 或 `/api/codex/environments`）
6. 对全局列表再次调用 `pick_environment_row()` 选择
7. 如果仍无可用环境，返回 `"no environments available"` 错误

> 源码位置：`codex-rs/cloud-tasks/src/env_detect.rs:25-108`

### 环境选择启发式（`pick_environment_row`）

`pick_environment_row` 实现了一套**优先级递减的选择策略**：

1. **标签精确匹配**（最高优先级）：如果调用方传入了 `desired_label`，在列表中查找 label 完全匹配（不区分大小写）的环境
2. **唯一环境**：如果列表中只有一个环境，直接返回它
3. **Pinned 标记**：查找第一个 `is_pinned == true` 的环境
4. **最高任务数**（最低优先级）：选择 `task_count` 最大的环境；如果 task_count 都为 0 或缺失，则选择列表中的第一个

每一步选择都会通过 `crate::append_error_log` 记录决策原因，便于调试。

> 源码位置：`codex-rs/cloud-tasks/src/env_detect.rs:110-145`

### TUI 环境列表（`list_environments`）

`list_environments` 为 TUI 的环境选择弹窗提供数据，与 `autodetect_environment_id` 类似的两阶段策略，但有以下差异：

1. **合并而非选择**：同时请求 by-repo 和全局列表，将结果合并到一个 `HashMap<String, EnvironmentRow>` 中，以 `id` 为 key 实现**去重**
2. **字段合并策略**：对同一 ID 的环境，保留已有的 label（仅当缺失时用新值填充），pinned 标记取 OR 逻辑
3. **优雅降级**：全局列表请求失败时，若 by-repo 已有结果则使用已有数据，否则才返回错误
4. **排序规则**：输出按 pinned 优先、label 字母序（不区分大小写）、最后按 id 排序

返回类型为 `Vec<EnvironmentRow>`，其中 `EnvironmentRow` 定义在 `crate::app` 模块：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `String` | 环境唯一标识 |
| `label` | `Option<String>` | 用户可读的环境名称 |
| `is_pinned` | `bool` | 是否被用户置顶 |
| `repo_hints` | `Option<String>` | 关联的仓库信息，如 `"openai/codex"` |

> 源码位置：`codex-rs/cloud-tasks/src/env_detect.rs:256-362`

## 函数签名与参数说明

### `autodetect_environment_id(base_url, headers, desired_label) -> Result<AutodetectSelection>`

主入口函数，自动检测并返回最合适的环境。

| 参数 | 类型 | 说明 |
|------|------|------|
| `base_url` | `&str` | 后端 API 基础 URL，函数会根据其是否包含 `/backend-api` 来拼接不同的路径前缀 |
| `headers` | `&HeaderMap` | HTTP 请求头，包含认证信息 |
| `desired_label` | `Option<String>` | 期望的环境标签名，用于精确匹配 |

返回 `AutodetectSelection { id: String, label: Option<String> }`。

### `list_environments(base_url, headers) -> Result<Vec<EnvironmentRow>>`

为 TUI 弹窗提供去重、排序后的完整环境列表。

| 参数 | 类型 | 说明 |
|------|------|------|
| `base_url` | `&str` | 后端 API 基础 URL |
| `headers` | `&HeaderMap` | HTTP 请求头 |

## 类型定义

### `CodeEnvironment`（内部类型）

从后端 API 反序列化的环境数据结构：

```rust
struct CodeEnvironment {
    id: String,
    label: Option<String>,       // serde default
    is_pinned: Option<bool>,     // serde default
    task_count: Option<i64>,     // serde default
}
```

> 源码位置：`codex-rs/cloud-tasks/src/env_detect.rs:8-17`

### `AutodetectSelection`（公开类型）

`autodetect_environment_id` 的返回值，携带选中环境的 ID 和可选标签：

```rust
pub struct AutodetectSelection {
    pub id: String,
    pub label: Option<String>,
}
```

> 源码位置：`codex-rs/cloud-tasks/src/env_detect.rs:19-23`

## 关键代码片段

### Git Remote URL 解析（`parse_owner_repo`）

该函数处理多种 GitHub URL 格式，提取 `owner/repo`：

- **SSH 格式**：`git@github.com:owner/repo.git`、`ssh://git@github.com:owner/repo`、`org-123@github.com:owner/repo`（支持任意用户名前缀）
- **HTTPS 格式**：`https://github.com/owner/repo.git`
- **其他协议**：`http://`、`git://`、裸 `github.com/`

解析逻辑：先剥离 `ssh://` 前缀，然后尝试匹配 `@github.com:` 模式（SSH），再依次尝试 HTTPS/HTTP/git 协议前缀。匹配后去除可能的前导 `/` 和尾部 `.git`，按 `/` 分割取前两段作为 owner 和 repo。

> 源码位置：`codex-rs/cloud-tasks/src/env_detect.rs:218-252`

### Git Origin 获取（`get_git_origins`）

采用双重回退策略获取 remote URL：
1. 优先使用 `git config --get-regexp remote\..*\.url` 获取所有 remote 的 URL
2. 回退到 `git remote -v` 解析输出

两种方式都通过 `uniq()` 函数排序去重后返回。

> 源码位置：`codex-rs/cloud-tasks/src/env_detect.rs:171-216`

### API 路径选择

模块根据 `base_url` 是否包含 `/backend-api` 来决定请求路径：
- 包含时使用 `/wham/environments` 系列路径（ChatGPT 后端模式）
- 不包含时使用 `/api/codex/environments` 系列路径

这一逻辑在 `autodetect_environment_id` 和 `list_environments` 中各出现两次（by-repo 和全局列表各一次）。

## 边界 Case 与注意事项

- **非 GitHub 仓库**：`parse_owner_repo` 仅识别 GitHub URL。GitLab、Bitbucket 等平台的 remote 会被静默跳过，不会报错，但也不会产生 by-repo 查询
- **全局列表请求的详细日志**：`autodetect_environment_id` 中全局列表回退路径会将完整的响应 JSON pretty-print 写入错误日志（`codex-rs/cloud-tasks/src/env_detect.rs:88-94`），这在调试时有用，但需注意日志量
- **`list_environments` 的优雅降级**：全局列表请求失败时，如果 by-repo 已有结果则正常返回（仅 warn 日志），如果完全没有数据才返回 error
- **HTTP client 构建**：每次 HTTP 请求都通过 `build_reqwest_client_with_custom_ca` 新建 client 实例（`get_json` 和 `autodetect_environment_id` 的全局列表路径各自构建），支持自定义 CA 证书
- **`pick_environment_row` 的 task_count 回退**：当多个环境都没有 task_count（默认为 0）时，`max_by_key` 会返回最后一个元素，但链式的 `.or_else(|| envs.first())` 确保始终有返回值

## 测试

测试文件 `codex-rs/cloud-tasks/tests/env_filter.rs` 包含一个集成测试 `mock_backend_varies_by_env`，验证 MockClient 在不同环境 ID 下返回不同的任务列表。该测试侧重于 mock 客户端的环境感知能力，而非 `env_detect` 模块本身的解析逻辑。