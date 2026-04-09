# LMStudioProvider

## 概述与职责

`codex-lmstudio` 是 Codex ModelProviders 层中负责**本地 LM Studio 模型集成**的 crate。它为 Codex 的 `--oss` 模式提供支持，允许用户通过本地运行的 LM Studio 服务器使用开源模型，而无需依赖云端 API。

在 ModelProviders 体系中，该模块与 Ollama 并列，属于本地模型 provider。它的上级模块是 **ModelProviders**，同级兄弟包括 OpenAI Responses API 客户端、Realtime API 客户端和 Ollama provider。

该 crate 的核心职责：
- 连接并检测本地 LM Studio 服务器的可用性
- 查询服务器上已有的模型列表
- 在模型缺失时自动通过 `lms` CLI 工具下载模型
- 在后台异步加载模型以备使用

## 关键流程

### OSS 模式启动流程 (`ensure_oss_ready`)

这是该模块的入口函数，当用户使用 `--oss` 标志启动 Codex 时被调用。完整流程如下：

1. **确定模型名称**：从 `Config.model` 读取用户指定的模型，若未指定则使用默认值 `openai/gpt-oss-20b`（`src/lib.rs:7`）
2. **连接 LM Studio 服务器**：调用 `LMStudioClient::try_from_provider()` 构建客户端，该过程会从配置中查找 `lmstudio` provider 的 `base_url`，并通过 `check_server()` 验证服务器健康状态（`src/client.rs:15-44`）
3. **检查模型可用性**：调用 `fetch_models()` 获取服务器上的模型列表。若目标模型不在列表中，则调用 `download_model()` 下载（`src/lib.rs:22-32`）
4. **后台加载模型**：通过 `tokio::spawn` 在后台异步调用 `load_model()`，避免阻塞主流程（`src/lib.rs:35-43`）

### 健康检查流程 (`check_server`)

向 `{base_url}/models` 发送 GET 请求，根据 HTTP 状态码判断服务器是否可用。失败时返回包含安装指引的错误信息：`"LM Studio is not responding. Install from https://lmstudio.ai/download and run 'lms server start'."`（`src/client.rs:46-62`）

### 模型加载流程 (`load_model`)

向 `{base_url}/responses` 发送一个 `max_output_tokens: 1` 的最小请求，以触发 LM Studio 将模型加载到内存。这是一种"预热"技巧——通过发送一个几乎不产生输出的请求，促使服务器提前完成模型加载（`src/client.rs:65-92`）。

### 模型下载流程 (`download_model`)

1. 通过 `find_lms()` 定位 `lms` CLI 工具——先查 PATH，再检查平台特定的备用路径：
   - Unix: `~/.lmstudio/bin/lms`
   - Windows: `~/.lmstudio/bin/lms.exe`
2. 执行 `lms get --yes <model>` 命令下载模型，stdout 继承到当前进程以显示下载进度（`src/client.rs:168-190`）

## 函数签名与参数说明

### `ensure_oss_ready(config: &Config) -> std::io::Result<()>`

OSS 模式的顶层入口。确保本地 LM Studio 环境就绪，包括服务器可达、模型已下载并开始后台加载。

- **config**：Codex 全局配置，从中读取 `model`（可选的模型名称）和 `model_providers`（provider 配置）
- **返回值**：成功返回 `Ok(())`，服务器不可达时返回错误

> 源码位置：`src/lib.rs:13-46`

### `LMStudioClient::try_from_provider(config: &Config) -> std::io::Result<Self>`

从 Codex 配置构建客户端实例。从 `config.model_providers` 中查找 ID 为 `"lmstudio"` 的 provider，提取其 `base_url`，创建带 5 秒连接超时的 HTTP 客户端，并执行健康检查。

- **config**：Codex 全局配置
- **返回值**：健康检查通过时返回 `LMStudioClient`，否则返回 IO 错误

> 源码位置：`src/client.rs:15-44`

### `LMStudioClient::fetch_models() -> io::Result<Vec<String>>`

查询 LM Studio 服务器上可用的模型列表。向 `/models` 端点发送 GET 请求，解析返回 JSON 中 `data` 数组内每个对象的 `id` 字段。

> 源码位置：`src/client.rs:95-124`

### `LMStudioClient::load_model(model: &str) -> io::Result<()>`

通过发送最小推理请求预热模型加载。

- **model**：模型标识符，如 `"openai/gpt-oss-20b"`

> 源码位置：`src/client.rs:65-92`

### `LMStudioClient::download_model(model: &str) -> io::Result<()>`

通过 `lms` CLI 下载指定模型。

- **model**：要下载的模型标识符

> 源码位置：`src/client.rs:168-190`

## 接口/类型定义

### `LMStudioClient`

```rust
#[derive(Clone)]
pub struct LMStudioClient {
    client: reqwest::Client,    // HTTP 客户端，5 秒连接超时
    base_url: String,           // LM Studio 服务器根 URL
}
```

该结构体实现了 `Clone`，因此可以安全地在 `tokio::spawn` 的异步任务中共享使用。

> 源码位置：`src/client.rs:7-10`

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| `DEFAULT_OSS_MODEL` | `"openai/gpt-oss-20b"` | `--oss` 模式的默认模型 |
| `LMSTUDIO_OSS_PROVIDER_ID` | `"lmstudio"` | 配置中 provider 的标识符（来自 `codex-model-provider-info`） |

## 配置项与默认值

该模块不直接管理配置文件，而是从 `codex-core::config::Config` 中读取：

- **`config.model`**：用户通过 `-m` 指定的模型名。未指定时使用 `DEFAULT_OSS_MODEL`（`openai/gpt-oss-20b`）
- **`config.model_providers["lmstudio"].base_url`**：LM Studio 服务器地址（必填），通常为 `http://localhost:1234/v1`
- **HTTP 连接超时**：硬编码为 5 秒（`src/client.rs:33`）

## 边界 Case 与注意事项

- **模型查询失败不阻断启动**：`fetch_models()` 失败时仅记录 warning 日志，不会导致 `ensure_oss_ready` 返回错误。这意味着即使模型列表查询失败，Codex 仍会尝试继续运行，错误将在后续实际推理调用时暴露（`src/lib.rs:29-31`）
- **模型加载是 fire-and-forget**：`load_model` 在后台 tokio task 中执行，其结果仅记录日志。如果加载失败，不会影响 `ensure_oss_ready` 的返回值（`src/lib.rs:35-43`）
- **`download_model` 使用同步 `std::process::Command`**：模型下载通过阻塞式子进程执行，这会占用当前 tokio 工作线程。对于大模型下载这可能是一个潜在的性能问题
- **`lms` CLI 查找逻辑**：先查 PATH，再查 `~/.lmstudio/bin/lms`。如果 LM Studio 安装在非标准路径，将无法找到
- **网络沙箱兼容**：测试代码中检查了 `CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR` 环境变量，在网络被禁用的沙箱环境中跳过网络相关测试