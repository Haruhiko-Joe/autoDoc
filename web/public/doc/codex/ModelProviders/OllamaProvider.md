# OllamaProvider — Ollama 本地模型集成

## 概述与职责

`codex-ollama` 是 Codex 的本地模型集成 crate，属于 **ModelProviders** 层的一部分，与 OpenAI API 客户端、Realtime API 等并列。它封装了与本地 [Ollama](https://github.com/ollama/ollama) 服务器的全部交互逻辑，主要职责包括：

- **服务器健康探测**：检测本地 Ollama 服务是否可达，支持原生 API 和 OpenAI 兼容端点两种模式
- **版本兼容性校验**：确保 Ollama 版本 >= 0.13.4，满足 Responses API 的最低要求
- **模型发现**：查询本地已安装的模型列表
- **模型拉取**：以流式方式下载模型，并通过可插拔的 Reporter 接口报告进度
- **URL 规范化**：在 OpenAI 兼容端点（`/v1`）和 Ollama 原生端点之间自动转换

当用户使用 `--oss` 标志启动 Codex 时，系统通过 `ensure_oss_ready()` 入口函数自动完成"检查服务 → 检查模型 → 按需拉取"的完整流程。

## 关键流程

### OSS 模式启动流程（`ensure_oss_ready`）

这是该 crate 最核心的入口，定义在 `src/lib.rs:22-49`：

1. 确定目标模型：优先使用用户通过 `-m` 指定的模型，否则使用默认值 `gpt-oss:20b`
2. 调用 `OllamaClient::try_from_oss_provider(config)` 构建客户端——该步骤同时完成服务器可达性验证
3. 通过 `fetch_models()` 查询本地已有模型
4. 若目标模型不在列表中，调用 `pull_with_reporter()` 自动下载

```rust
// src/lib.rs:30-39
let ollama_client = crate::OllamaClient::try_from_oss_provider(config).await?;
match ollama_client.fetch_models().await {
    Ok(models) => {
        if !models.iter().any(|m| m == model) {
            let mut reporter = crate::CliProgressReporter::new();
            ollama_client.pull_with_reporter(model, &mut reporter).await?;
        }
    }
    ...
}
```

### 客户端构建与服务器探测

`OllamaClient::try_from_provider()` (`src/client.rs:59-78`) 执行以下步骤：

1. 从 `ModelProviderInfo` 中提取 `base_url`
2. 调用 `is_openai_compatible_base_url()` 判断是否为 `/v1` 结尾的 OpenAI 兼容 URL
3. 调用 `base_url_to_host_root()` 将 URL 规范化为 Ollama 原生根路径（如 `http://localhost:11434/v1` → `http://localhost:11434`）
4. 创建带 5 秒连接超时的 `reqwest::Client`
5. 调用 `probe_server()` 探测服务——根据 URL 类型选择不同端点：
   - OpenAI 兼容模式：`GET /v1/models`
   - 原生模式：`GET /api/tags`

若服务不可达，返回包含安装说明的错误信息。

### Responses API 版本校验

`ensure_responses_supported()` (`src/lib.rs:62-76`) 独立于 OSS 流程，可对任意 Ollama provider 做版本检查：

1. 构建客户端并调用 `fetch_version()`（请求 `GET /api/version`）
2. 解析返回的 semver 版本号（自动去除 `v` 前缀）
3. 版本 `0.0.0`（开发版）始终放行，`>= 0.13.4` 放行，否则返回错误

### 模型拉取流程

`pull_model_stream()` (`src/client.rs:157-212`) 实现流式拉取：

1. 向 `POST /api/pull` 发送 `{"model": "<name>", "stream": true}`
2. 使用 `async_stream` 读取 NDJSON 响应流
3. 逐行解析为 `PullEvent`：
   - `{"status": "..."}` → `PullEvent::Status`
   - `{"digest": "...", "total": N, "completed": M}` → `PullEvent::ChunkProgress`
   - `{"status": "success"}` → `PullEvent::Success`（终止流）
   - `{"error": "..."}` → `PullEvent::Error`（终止流）

高层 `pull_with_reporter()` (`src/client.rs:215-246`) 封装了这个流，将事件逐个推送到 `PullProgressReporter`。值得注意的是，Ollama 即使拉取失败也会返回 HTTP 200，错误只能从事件流中检测。

## 函数签名与参数说明

### 公开函数

#### `ensure_oss_ready(config: &Config) -> io::Result<()>`

OSS 模式的一站式入口。确保本地 Ollama 服务可达并且目标模型已下载。

> 源码位置：`src/lib.rs:22-49`

#### `ensure_responses_supported(provider: &ModelProviderInfo) -> io::Result<()>`

校验指定 provider 对应的 Ollama 服务版本是否支持 Responses API（>= 0.13.4）。版本端点不可用或无法解析时视为通过。

> 源码位置：`src/lib.rs:62-76`

### `OllamaClient` 方法

| 方法 | 可见性 | 签名 | 说明 |
|------|--------|------|------|
| `try_from_oss_provider` | `pub` | `(config: &Config) -> io::Result<Self>` | 从全局配置中查找 OSS provider 并构建客户端 |
| `try_from_provider` | `pub(crate)` | `(provider: &ModelProviderInfo) -> io::Result<Self>` | 从 provider 定义构建客户端并探测服务 |
| `fetch_models` | `pub` | `(&self) -> io::Result<Vec<String>>` | 查询 `GET /api/tags` 返回本地模型名列表 |
| `fetch_version` | `pub` | `(&self) -> io::Result<Option<Version>>` | 查询 `GET /api/version` 返回 semver 版本 |
| `pull_model_stream` | `pub` | `(&self, model: &str) -> io::Result<BoxStream<'static, PullEvent>>` | 启动模型拉取并返回事件流 |
| `pull_with_reporter` | `pub` | `(&self, model: &str, reporter: &mut dyn PullProgressReporter) -> io::Result<()>` | 拉取模型并驱动进度报告器 |

## 接口/类型定义

### `PullEvent`（`src/pull.rs:7-21`）

模型拉取过程中的事件枚举：

```rust
pub enum PullEvent {
    Status(String),                    // 状态消息，如 "verifying"、"writing"
    ChunkProgress {                    // 分层下载进度
        digest: String,                //   层的 SHA256 摘要
        total: Option<u64>,            //   该层总字节数
        completed: Option<u64>,        //   已完成字节数
    },
    Success,                           // 拉取成功
    Error(String),                     // 错误消息
}
```

### `PullProgressReporter` trait（`src/pull.rs:25-27`）

```rust
pub trait PullProgressReporter {
    fn on_event(&mut self, event: &PullEvent) -> io::Result<()>;
}
```

观察者模式接口，供不同 UI 层实现各自的进度展示。目前有两个实现：

- **`CliProgressReporter`**：向 stderr 输出内联进度条，显示下载速度（MB/s）和百分比，自动抑制 "pulling manifest" 噪声消息
- **`TuiProgressReporter`**：当前直接委托给 `CliProgressReporter`，预留了未来 TUI 专属渲染的扩展点

### `OllamaClient` 结构体（`src/client.rs:25-29`）

```rust
pub struct OllamaClient {
    client: reqwest::Client,       // HTTP 客户端（5s 连接超时）
    host_root: String,             // Ollama 服务根 URL，如 "http://localhost:11434"
    uses_openai_compat: bool,      // 是否通过 /v1 兼容端点连接
}
```

## 配置项与默认值

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `DEFAULT_OSS_MODEL` | `"gpt-oss:20b"` | `--oss` 模式未指定 `-m` 时使用的默认模型 |
| Ollama base URL | `http://localhost:11434/v1`（由 `OLLAMA_OSS_PROVIDER_ID` 对应的 provider 配置决定） | 用户可在 `config.toml` 中覆盖 |
| 连接超时 | 5 秒 | `reqwest::Client` 的 `connect_timeout` |
| 最低 Responses API 版本 | `0.13.4` | 低于此版本的 Ollama 会被拒绝 |

## URL 处理逻辑

`src/url.rs` 提供两个工具函数，处理 Ollama 原生 API 和 OpenAI 兼容 API 之间的 URL 映射：

- **`is_openai_compatible_base_url(base_url)`**：判断 URL 是否以 `/v1` 结尾
- **`base_url_to_host_root(base_url)`**：将 `/v1` 后缀剥离，得到 Ollama 原生 API 根路径

例如 `http://localhost:11434/v1` → `http://localhost:11434`。这保证了无论用户配置的是哪种风格的 URL，`fetch_models()`、`fetch_version()`、`pull_model_stream()` 等方法都能正确拼接原生 API 路径。

## 边界 Case 与注意事项

- **Ollama 拉取错误隐藏在 HTTP 200 中**：`pull_model_stream` 收到 HTTP 200 后仍需检查事件流中的 `error` 字段，因为 Ollama 即使模型不存在也会返回 200 状态码（`src/client.rs:229-235`）
- **版本 `0.0.0` 特殊处理**：开发版本的 Ollama 返回 `0.0.0`，此时跳过版本检查直接放行（`src/lib.rs:56`）
- **版本端点容错**：`fetch_version()` 在端点不可用、HTTP 非 200、或版本字符串无法解析时均返回 `Ok(None)` 而非报错，`ensure_responses_supported` 对此也视为通过
- **模型查询失败非致命**：`ensure_oss_ready` 中 `fetch_models()` 失败仅记录 warn 日志，不阻断启动流程（`src/lib.rs:42-45`）
- **`TuiProgressReporter` 是占位实现**：当前直接委托给 `CliProgressReporter`，代码注释明确标注待未来替换为专属 TUI 渲染
- **`wiremock` 作为生产依赖**：`wiremock` 出现在 `[dependencies]` 而非 `[dev-dependencies]`，可能是为了在其他 crate 的测试中复用 mock 能力