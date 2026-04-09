# DeviceCodeLogin — 设备码授权流程

## 概述与职责

DeviceCodeLogin 模块实现了 OAuth 2.0 **设备码授权流程**（Device Code Flow），专为无浏览器的 headless / 终端环境设计。它是 **Auth → Login** 子系统的一部分，与浏览器 OAuth 登录流（`server.rs`）并列，提供了一种替代的认证路径。

在整个 Codex 架构中，Auth 系统为 Core、ModelProviders、AppServer、CloudTasks 等模块提供认证凭据。Login 是 Auth 的核心认证库，而 DeviceCodeLogin 是 Login 中面向终端场景的授权通道。同级模块包括 ChatGPTClient（后端 API 客户端）、KeyringStore（OS 钥匙串抽象）和 Secrets（加密秘钥管理）。

**核心职责**：
1. 向认证服务器请求设备码（user code）和轮询标识（device_auth_id）
2. 在终端中显示验证 URL 和一次性码，引导用户在浏览器中完成授权
3. 按固定间隔轮询 token 端点，等待用户完成浏览器端授权（最长 15 分钟）
4. 授权成功后，通过与浏览器流相同的 PKCE/token exchange 机制换取 tokens
5. 校验 workspace 权限并持久化凭据

> 源文件：`codex-rs/login/src/device_code_auth.rs`

## 关键流程 Walkthrough

### 完整登录流程（`run_device_code_login`）

入口函数 `run_device_code_login`（`:224-228`）编排了整个流程，分为三个阶段：

#### 阶段一：请求设备码

1. `request_device_code()` 构建 HTTP 客户端（支持自定义 CA 证书），从 `ServerOptions.issuer` 拼接 API 地址（`:159-171`）
2. 内部调用 `request_user_code()` 向 `{base_url}/api/accounts/deviceauth/usercode` 发送 POST 请求，携带 `client_id`（`:62-96`）
3. 服务端返回 `device_auth_id`（轮询标识）、`user_code`（用户码）、`interval`（轮询间隔秒数）
4. 拼接验证 URL 为 `{base_url}/codex/device`，构建 `DeviceCode` 结构体返回

#### 阶段二：用户终端交互

`print_device_code_prompt()` 在终端打印带 ANSI 颜色的引导信息（`:148-157`），包括：
- Codex 版本号（编译时从 `CARGO_PKG_VERSION` 注入）
- 浏览器验证链接（蓝色高亮）
- 一次性授权码（蓝色高亮，标注 15 分钟过期）
- 反钓鱼安全提示（灰色）

#### 阶段三：轮询与 Token 交换

`complete_device_code_login()` 完成后半段流程（`:173-222`）：

1. **轮询等待授权**：`poll_for_token()` 向 `{base_url}/api/accounts/deviceauth/token` 反复 POST 请求，携带 `device_auth_id` 和 `user_code`（`:99-146`）
   - **成功（2xx）**：服务端返回 `authorization_code`、`code_challenge`、`code_verifier`，跳出循环
   - **403/404**：表示用户尚未完成授权，按 `interval` 秒间隔重试（但不超过剩余超时时间）
   - **其他错误状态码**：立即返回错误
   - **超时**：累计等待超过 15 分钟后返回超时错误

2. **PKCE Token 交换**：用服务端返回的 `code_verifier` 和 `code_challenge` 构建 `PkceCodes`，调用 `crate::server::exchange_code_for_tokens()` 完成标准 OAuth token 交换（`:190-204`），获取 `id_token`、`access_token`、`refresh_token`

3. **Workspace 校验**：调用 `ensure_workspace_allowed()` 检查 token 中的 workspace 是否满足 `forced_chatgpt_workspace_id` 约束（`:206-211`）

4. **持久化凭据**：调用 `persist_tokens_async()` 将 tokens 写入本地存储，存储模式由 `cli_auth_credentials_store_mode` 控制（文件/钥匙串/自动选择）（`:213-222`）

## 函数签名与参数说明

### `request_device_code(opts: &ServerOptions) -> io::Result<DeviceCode>`

发起设备码请求的公开接口。返回包含验证 URL 和用户码的 `DeviceCode` 结构体，供调用方自行展示。

- **opts**：包含 `issuer`（认证服务器地址）、`client_id`（OAuth 客户端 ID）等配置

> 源码位置：`codex-rs/login/src/device_code_auth.rs:159-171`

### `complete_device_code_login(opts: ServerOptions, device_code: DeviceCode) -> io::Result<()>`

以已获取的 `DeviceCode` 完成登录的后半段流程（轮询 → token 交换 → 持久化）。与 `request_device_code` 分离设计，允许调用方在两个阶段之间插入自定义逻辑（如 TUI 展示）。

- **opts**：服务器配置（所有权转移）
- **device_code**：第一阶段返回的设备码信息

> 源码位置：`codex-rs/login/src/device_code_auth.rs:173-222`

### `run_device_code_login(opts: ServerOptions) -> io::Result<()>`

端到端便捷入口，依次调用 `request_device_code` → `print_device_code_prompt` → `complete_device_code_login`。适用于无需自定义中间展示逻辑的场景。

> 源码位置：`codex-rs/login/src/device_code_auth.rs:224-228`

## 接口/类型定义

### `DeviceCode`（公开）

```rust
pub struct DeviceCode {
    pub verification_url: String,  // 用户需在浏览器中访问的验证页面 URL
    pub user_code: String,         // 用户需输入的一次性授权码
    device_auth_id: String,        // 内部轮询标识（非公开）
    interval: u64,                 // 轮询间隔（秒，非公开）
}
```

> 源码位置：`codex-rs/login/src/device_code_auth.rs:18-24`

### 内部请求/响应类型

| 类型 | 用途 | 关键字段 |
|------|------|----------|
| `UserCodeReq` | 请求用户码的 POST body | `client_id` |
| `UserCodeResp` | 用户码响应 | `device_auth_id`, `user_code`, `interval` |
| `TokenPollReq` | 轮询 token 的 POST body | `device_auth_id`, `user_code` |
| `CodeSuccessResp` | 轮询成功响应 | `authorization_code`, `code_challenge`, `code_verifier` |

## 配置项与依赖

本模块不直接读取环境变量或配置文件，所有配置通过 `ServerOptions` 传入：

| 字段 | 类型 | 说明 |
|------|------|------|
| `issuer` | `String` | OAuth 认证服务器基础 URL |
| `client_id` | `String` | OAuth 客户端 ID |
| `codex_home` | `PathBuf` | Codex 主目录，用于凭据持久化路径 |
| `forced_chatgpt_workspace_id` | `Option<String>` | 强制限定的 workspace ID，非空时将校验 token |
| `cli_auth_credentials_store_mode` | `AuthCredentialsStoreMode` | 凭据存储模式（文件/钥匙串/自动） |

**跨模块依赖**：
- `crate::pkce::PkceCodes`：PKCE 验证码对
- `crate::server::exchange_code_for_tokens`：标准 OAuth token 交换（与浏览器流共享）
- `crate::server::ensure_workspace_allowed`：JWT workspace 校验
- `crate::server::persist_tokens_async`：token 持久化
- `codex_client::build_reqwest_client_with_custom_ca`：支持自定义 CA 的 HTTP 客户端构建器

## 边界 Case 与注意事项

- **服务端不支持设备码流**：当 `usercode` 端点返回 404 时，模块返回专门的 `NotFound` 错误，提示用户改用浏览器登录或检查服务器 URL（`:82-87`）
- **轮询间隔防溢出**：当剩余超时时间小于 `interval` 时，`sleep_for` 会被截断到剩余时间，避免超出 15 分钟窗口（`:136`）
- **`interval` 字段反序列化**：服务端可能以字符串形式返回轮询间隔，`deserialize_interval` 自定义反序列化器处理了 string → u64 的转换（`:46-52`）
- **`user_code` 字段别名**：`UserCodeResp` 同时接受 `user_code` 和 `usercode` 两种 JSON 键名（`:29`），兼容不同服务端实现
- **PKCE 码由服务端提供**：与浏览器流中客户端本地生成 PKCE 不同，设备码流中 `code_verifier` 和 `code_challenge` 由服务端在轮询成功时返回（`:55-59`），这是因为设备码流的授权过程发生在服务端侧
- **两阶段 API 设计**：`request_device_code` 和 `complete_device_code_login` 的分离设计允许上层（如 TUI）在获取设备码后自定义展示逻辑，而非强制使用内置的终端打印
- **安全提示**：终端输出中包含反钓鱼警告，提醒用户不要分享设备码