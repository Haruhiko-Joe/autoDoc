# SetupErrors — 沙盒 Setup 管线的共享错误基础设施

## 概述与职责

`SetupErrors` 模块是 Windows 沙盒 Setup 管线的**统一错误处理层**，位于 `Sandbox → WindowsSandbox → SetupOrchestration` 层级之下。它为整个 Setup 流程（包含 CLI 端的 Orchestrator 和提权后的 Helper 进程）提供结构化的错误定义、持久化报告机制和遥测安全的消息清洗功能。

在 `WindowsSandbox` 的兄弟模块中，`SetupOrchestration` 负责多阶段提权设置流程的编排，而本模块则为该流程中可能出现的各类失败提供标准化的错误码、可序列化的错误报告以及跨进程的错误传递机制。

> 源文件：`codex-rs/windows-sandbox-rs/src/setup_error.rs`

## 关键流程

### 错误产生与传播流程

1. Setup 管线中的代码通过 `failure()` 函数创建包含 `SetupErrorCode` 和描述信息的 `anyhow::Error`
2. 在 Helper 进程（提权端）中，失败时通过 `write_setup_error_report()` 将 `SetupErrorReport` 序列化为 JSON 写入 `{codex_home}/.sandbox/setup_error.json`
3. Orchestrator（CLI 端）通过 `read_setup_error_report()` 读取该 JSON 文件，解析为 `SetupErrorReport` 后转为 `SetupFailure` 进行处理
4. Setup 成功时通过 `clear_setup_error_report()` 清除报告文件

### 遥测消息清洗流程

1. `SetupFailure::metric_message()` 被调用以获取可安全发送到遥测系统的错误消息
2. 内部先通过 `redact_home_paths()` 读取 `USERNAME`（Windows）和 `USER`（Unix）环境变量
3. `redact_username_segments()` 将错误消息按路径分隔符（`\` 和 `/`）拆分为段，逐段匹配用户名并替换为 `<user>`（Windows 上不区分大小写）
4. 最后调用外部的 `sanitize_metric_tag_value()` 进行通用的 metric tag 清洗

## 核心类型

### `SetupErrorCode` 枚举

约 24 个变体的枚举，按故障来源分为两组：

**Orchestrator 侧（7 个）**——在 CLI 进程中发生的失败：

| 变体 | 含义 |
|------|------|
| `OrchestratorSandboxDirCreateFailed` | 创建 `.sandbox` 目录失败 |
| `OrchestratorElevationCheckFailed` | 检测当前进程是否提权失败 |
| `OrchestratorPayloadSerializeFailed` | 序列化提权请求载荷失败 |
| `OrchestratorHelperLaunchFailed` | 启动 Helper 进程失败 |
| `OrchestratorHelperLaunchCanceled` | 用户取消了 UAC 提示 |
| `OrchestratorHelperExitNonzero` | Helper 非零退出且无结构化报告 |
| `OrchestratorHelperReportReadFailed` | 读取 `setup_error.json` 失败 |

**Helper 侧（17 个）**——在提权 Helper 进程中发生的失败：

| 变体 | 含义 |
|------|------|
| `HelperRequestArgsFailed` | 请求载荷解码/校验失败 |
| `HelperSandboxDirCreateFailed` | 创建 `.sandbox` 目录失败 |
| `HelperLogFailed` | 写入 Setup 日志失败 |
| `HelperUserProvisionFailed` | 用户配置阶段失败（兜底类别） |
| `HelperUsersGroupCreateFailed` | 创建沙盒用户本地组失败 |
| `HelperUserCreateOrUpdateFailed` | 创建/更新沙盒用户账户失败 |
| `HelperDpapiProtectFailed` | DPAPI 密码保护失败 |
| `HelperUsersFileWriteFailed` | 写入沙盒用户密钥文件失败 |
| `HelperSetupMarkerWriteFailed` | 写入 Setup 标记文件失败 |
| `HelperSidResolveFailed` | SID 解析或 PSID 转换失败 |
| `HelperCapabilitySidFailed` | 加载/转换能力 SID 失败 |
| `HelperFirewallComInitFailed` | COM 初始化（防火墙配置）失败 |
| `HelperFirewallPolicyAccessFailed` | 访问防火墙策略/规则集失败 |
| `HelperFirewallRuleCreateOrAddFailed` | 创建/更新/添加防火墙规则失败 |
| `HelperFirewallRuleVerifyFailed` | 验证防火墙规则作用域失败 |
| `HelperReadAclHelperSpawnFailed` | 启动 ACL Helper 子进程失败 |
| `HelperSandboxLockFailed` | ACL 锁定沙盒目录失败 |
| `HelperUnknownError` | 未映射/意外错误（兜底） |

枚举通过 `#[serde(rename_all = "snake_case")]` 支持 JSON 序列化，`as_str()` 方法返回对应的 snake_case 字符串用于 metric tag。

### `SetupFailure` 错误类型

```rust
pub struct SetupFailure {
    pub code: SetupErrorCode,
    pub message: String,
}
```

实现了 `Display`（格式为 `"{code}: {message}"`）和 `Error` trait，可嵌入 `anyhow::Error` 进行传播。

- `new(code, message)` — 构造实例
- `from_report(report)` — 从 `SetupErrorReport` 转换
- `metric_message()` — 返回经过 PII 脱敏的消息，可安全用于遥测

> 源码位置：`codex-rs/windows-sandbox-rs/src/setup_error.rs:111-132`

### `SetupErrorReport` 序列化载体

```rust
pub struct SetupErrorReport {
    pub code: SetupErrorCode,
    pub message: String,
}
```

派生 `Serialize`/`Deserialize`，是跨进程错误传递的 JSON 载体——Helper 进程写入、Orchestrator 进程读取。

> 源码位置：`codex-rs/windows-sandbox-rs/src/setup_error.rs:105-109`

## 函数签名与参数说明

### `failure(code, message) -> anyhow::Error`

快捷构造函数，将 `SetupFailure` 包装为 `anyhow::Error` 返回，方便在 `?` 链中使用。

> 源码位置：`codex-rs/windows-sandbox-rs/src/setup_error.rs:142-144`

### `extract_failure(err: &anyhow::Error) -> Option<&SetupFailure>`

从 `anyhow::Error` 中尝试 downcast 出 `SetupFailure` 引用，用于在错误处理层提取结构化错误码。

> 源码位置：`codex-rs/windows-sandbox-rs/src/setup_error.rs:146-148`

### `setup_error_path(codex_home: &Path) -> PathBuf`

返回错误报告文件的路径：`{codex_home}/.sandbox/setup_error.json`。

### `write_setup_error_report(codex_home, report) -> Result<()>`

将 `SetupErrorReport` 序列化为格式化 JSON 并写入磁盘。会自动创建 `.sandbox` 目录（如不存在）。

> 源码位置：`codex-rs/windows-sandbox-rs/src/setup_error.rs:163-171`

### `read_setup_error_report(codex_home) -> Result<Option<SetupErrorReport>>`

读取并反序列化错误报告。文件不存在时返回 `Ok(None)` 而非报错。

> 源码位置：`codex-rs/windows-sandbox-rs/src/setup_error.rs:173-183`

### `clear_setup_error_report(codex_home) -> Result<()>`

删除错误报告文件。文件不存在视为成功（幂等操作）。

> 源码位置：`codex-rs/windows-sandbox-rs/src/setup_error.rs:154-161`

### `sanitize_setup_metric_tag_value(value: &str) -> String`

公开的消息清洗入口。先进行用户名脱敏，再调用 `codex_utils_string::sanitize_metric_tag_value` 进行通用清洗。

> 源码位置：`codex-rs/windows-sandbox-rs/src/setup_error.rs:186-188`

## PII 脱敏机制

`redact_home_paths` 和 `redact_username_segments` 两个内部函数实现了路径中用户名的自动脱敏：

1. 从环境变量 `USERNAME`（Windows 主用）和 `USER`（Unix 主用）获取当前用户名
2. 将输入字符串按 `\` 和 `/` 分割为路径段
3. 逐段与用户名列表比较——Windows 上不区分大小写，Unix 上区分
4. 匹配的段被替换为 `<user>`

**示例**：`"C:\Users\Alice\file.txt"` → `"C:\Users\<user>\file.txt"`

这确保了发送到遥测系统的错误消息不会泄露用户名等 PII 信息。

> 源码位置：`codex-rs/windows-sandbox-rs/src/setup_error.rs:190-247`

## 边界 Case 与注意事项

- **幂等清理**：`clear_setup_error_report` 在文件不存在时返回 `Ok(())`，调用方无需预检查
- **跨进程通信**：`SetupErrorReport` 是 Helper 和 Orchestrator 之间通过文件系统传递错误信息的桥梁，而非 `SetupFailure`——后者不可序列化
- **脱敏仅限路径段**：用户名出现在非路径上下文中（如 `"user Alice failed"`）不会被脱敏，因为匹配逻辑基于路径分隔符分段
- **环境变量缺失**：如果 `USERNAME` 和 `USER` 均未设置或为空，脱敏逻辑会跳过，原始消息直接传入通用清洗
- **外部依赖**：`sanitize_metric_tag_value` 来自 `codex_utils_string` crate，负责通用的 metric tag 字符清洗（本模块不重复实现）