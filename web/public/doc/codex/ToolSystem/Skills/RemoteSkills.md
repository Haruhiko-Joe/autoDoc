# RemoteSkills — 远程技能归档管理

## 概述与职责

RemoteSkills 模块是 **Skills** 子系统（`codex-core-skills` crate）中负责与 ChatGPT 后端 API 交互的远程技能客户端。它提供两项核心能力：

1. **列出远程技能**：按作用域（scope）和产品界面（product surface）过滤，获取可用的远程技能列表
2. **导出并安装远程技能**：将单个技能下载为 zip 归档，解压到本地 `$CODEX_HOME/skills/{id}/` 目录，并在解压过程中实施路径遍历保护

在整体架构中，该模块位于 **ToolSystem → Skills** 层级下，是技能生命周期管理的一部分。同级模块包括 ToolDefinitions（工具定义与注册）、SystemSkills（内置技能安装）、ApplyPatch、FileSearch、ShellCommand 等。RemoteSkills 依赖 **Auth** 模块提供的 ChatGPT 认证凭据（非 API Key），通过 bearer token 和 `chatgpt-account-id` 请求头完成鉴权。

> **注意**：代码注释标注此模块为"低级客户端，保留供未来接入使用，尚未被任何活跃产品面使用"（`codex-rs/core-skills/src/remote.rs:14-15`）。

## 关键流程

### 1. 列出远程技能（`list_remote_skills`）

**入口**：`list_remote_skills()` — `codex-rs/core-skills/src/remote.rs:89-145`

1. 校验认证：调用 `ensure_chatgpt_auth()` 确认传入的 `auth` 是 ChatGPT 认证而非 API Key（`:51-61`）
2. 构建请求 URL：`{base_url}/hazelnuts`，拼接查询参数 `product_surface`（必选）、`scope`（可选）、`enabled`（可选）
3. 使用 `build_reqwest_client()` 创建 HTTP 客户端，设置 30 秒超时（`REMOTE_SKILLS_API_TIMEOUT`）
4. 附加认证头：`Authorization: Bearer {token}` + 可选的 `chatgpt-account-id` header
5. 发送 GET 请求，解析 JSON 响应体（注意：API 返回的字段名是 `hazelnuts`，通过 `#[serde(rename)]` 映射为 `skills`）
6. 将内部 `RemoteSkill` 转换为公开的 `RemoteSkillSummary`（包含 `id`、`name`、`description`）返回

### 2. 导出远程技能（`export_remote_skill`）

**入口**：`export_remote_skill()` — `codex-rs/core-skills/src/remote.rs:147-202`

1. 校验 ChatGPT 认证（同上）
2. 构建下载 URL：`{base_url}/hazelnuts/{skill_id}/export`
3. 发送 GET 请求，获取响应 body 的原始字节
4. 通过 `is_zip_payload()` 验证下载内容是否为合法的 zip 文件（检查 `PK` 魔数签名，`:217-221`）
5. 创建输出目录 `$CODEX_HOME/skills/{skill_id}/`
6. 在阻塞线程（`spawn_blocking`）中调用 `extract_zip_to_dir()` 解压归档
7. 返回 `RemoteSkillDownloadResult`，包含 `id` 和解压后的本地路径

### 3. Zip 解压与路径安全

**解压流程** — `extract_zip_to_dir()` — `codex-rs/core-skills/src/remote.rs:223-251`

1. 使用 `zip::ZipArchive` 打开内存中的 zip 数据
2. 遍历所有条目，跳过目录条目
3. 对每个文件名调用 `normalize_zip_name()` 进行路径规范化
4. 调用 `safe_join()` 将规范化后的路径与输出目录拼接，**同时进行路径遍历防护**
5. 创建父目录并写入文件内容

**路径规范化** — `normalize_zip_name()` — `:253-270`

- 去除 `./` 前缀
- 尝试去除 `prefix_candidates` 中匹配的前缀目录（通常是 `skill_id/`），使解压后的文件直接位于目标目录下而非嵌套一层
- 空路径返回 `None`（被跳过）

**路径遍历防护** — `safe_join()` — `:204-215`

- 逐一检查路径的每个组件，**只允许 `Component::Normal`**
- 拒绝 `..`（Parent）、`/`（RootDir）、`.`（CurDir）、前缀（Prefix，Windows 盘符）等一切非正常组件
- 任何非法组件立即报错，防止 zip 条目逃逸到目标目录之外

## 函数签名与参数说明

### `list_remote_skills`

```rust
pub async fn list_remote_skills(
    chatgpt_base_url: String,
    auth: Option<&CodexAuth>,
    scope: RemoteSkillScope,
    product_surface: RemoteSkillProductSurface,
    enabled: Option<bool>,
) -> Result<Vec<RemoteSkillSummary>>
```

| 参数 | 说明 |
|------|------|
| `chatgpt_base_url` | ChatGPT 后端 API 的基础 URL，尾部斜杠会被去除 |
| `auth` | ChatGPT 认证凭据，必须为 ChatGPT 类型（非 API Key），`None` 会报错 |
| `scope` | 技能作用域过滤器 |
| `product_surface` | 产品界面过滤器 |
| `enabled` | 可选的启用状态过滤，`None` 表示不过滤 |

### `export_remote_skill`

```rust
pub async fn export_remote_skill(
    chatgpt_base_url: String,
    codex_home: PathBuf,
    auth: Option<&CodexAuth>,
    skill_id: &str,
) -> Result<RemoteSkillDownloadResult>
```

| 参数 | 说明 |
|------|------|
| `chatgpt_base_url` | ChatGPT 后端 API 的基础 URL |
| `codex_home` | Codex 主目录路径，技能将被解压到 `{codex_home}/skills/{skill_id}/` |
| `auth` | ChatGPT 认证凭据 |
| `skill_id` | 要导出的远程技能 ID |

## 类型定义

### `RemoteSkillScope`

技能作用域枚举，映射为 API 查询参数：

| 变体 | 查询参数值 |
|------|-----------|
| `WorkspaceShared` | `workspace-shared` |
| `AllShared` | `all-shared` |
| `Personal` | `personal` |
| `Example` | `example` |

### `RemoteSkillProductSurface`

产品界面枚举，映射为 API 查询参数：

| 变体 | 查询参数值 |
|------|-----------|
| `Chatgpt` | `chatgpt` |
| `Codex` | `codex` |
| `Api` | `api` |
| `Atlas` | `atlas` |

### `RemoteSkillSummary`

列表接口返回的技能摘要，包含 `id: String`、`name: String`、`description: String`。

### `RemoteSkillDownloadResult`

导出接口返回的结果，包含 `id: String`（技能 ID）和 `path: PathBuf`（解压后的本地目录路径）。

## 配置项与默认值

| 配置 | 值 | 说明 |
|------|---|------|
| `REMOTE_SKILLS_API_TIMEOUT` | 30 秒 | 所有远程 API 请求的超时时间（`codex-rs/core-skills/src/remote.rs:12`） |
| 解压目标路径 | `$CODEX_HOME/skills/{skill_id}/` | 下载的技能归档会被解压到此目录 |

## 边界 Case 与注意事项

- **仅支持 ChatGPT 认证**：传入 `None` 或 API Key 认证会立即报错。这是因为远程技能 API 是 ChatGPT 后端服务，不接受 OpenAI API Key 认证方式。
- **API 字段命名**：后端返回的 JSON 使用 `hazelnuts` 作为技能列表的字段名（而非 `skills`），通过 `#[serde(rename = "hazelnuts")]` 映射（`:78`）。这是一个内部代号。
- **zip 魔数校验**：下载后会检查 payload 是否以 `PK\x03\x04`、`PK\x05\x06` 或 `PK\x07\x08` 开头，覆盖了 zip 文件的标准本地文件头、中央目录结束记录和数据描述符三种签名。
- **路径遍历防护**：`safe_join()` 是关键的安全屏障。即使远程服务器返回的 zip 中包含 `../../etc/passwd` 这样的恶意路径，也会被拦截。
- **前缀剥离**：zip 归档内部的文件路径可能带有 `{skill_id}/` 前缀（如 `abc123/SKILL.md`），`normalize_zip_name()` 会将其剥离为 `SKILL.md`，避免产生 `skills/{id}/{id}/SKILL.md` 的冗余嵌套。
- **目录条目被跳过**：解压时只处理文件条目，目录结构通过 `create_dir_all` 按需创建。
- **阻塞操作隔离**：zip 解压通过 `tokio::task::spawn_blocking` 在独立线程中执行，避免阻塞异步运行时。
- **模块当前未激活**：注释明确指出这是一个预留的低级客户端，暂未被任何活跃产品面实际调用。