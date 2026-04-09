# 配置与构建辅助工具集（ConfigAndBuildHelpers）

## 概述与职责

ConfigAndBuildHelpers 是 Codex 项目 **SharedUtils** 层下的一组杂项工具 crate，为 CLI 入口、TUI 界面、测试基础设施等上层模块提供基础能力。它不包含核心业务逻辑，而是将常见的横切关注点（CLI 参数解析、沙箱策略展示、OSS 提供商就绪检查、插件命名空间解析、格式转换、时间格式化、测试二进制定位、TLS 初始化）收拢到可复用的小 crate 中。

在整体架构中，本模块与兄弟模块（路径处理、PTY 管理、图像处理、字符串工具等）共同构成 SharedUtils 层，被 Core、CLI、TUI、Config 等上层模块广泛依赖。

本文档涵盖 9 个子 crate：

| crate | 路径 | 一句话职责 |
|-------|------|-----------|
| `codex-utils-cli` | `codex-rs/utils/cli/` | CLI 参数类型与配置覆盖 |
| `codex-utils-approval-presets` | `codex-rs/utils/approval-presets/` | 内置审批 + 沙箱策略预设 |
| `codex-utils-sandbox-summary` | `codex-rs/utils/sandbox-summary/` | 沙箱策略摘要格式化与配置摘要生成 |
| `codex-utils-oss` | `codex-rs/utils/oss/` | Ollama / LM Studio 就绪检查 |
| `codex-utils-plugins` | `codex-rs/utils/plugins/` | 插件命名空间解析与 MCP connector 辅助 |
| `codex-utils-json-to-toml` | `codex-rs/utils/json-to-toml/` | JSON → TOML 值转换 |
| `codex-utils-elapsed` | `codex-rs/utils/elapsed/` | 耗时格式化 |
| `codex-utils-cargo-bin` | `codex-rs/utils/cargo-bin/` | 测试二进制与资源定位（Cargo / Bazel 兼容） |
| `codex-utils-rustls-provider` | `codex-rs/utils/rustls-provider/` | 一次性 rustls 加密 provider 初始化 |

---

## codex-utils-cli：CLI 参数类型与配置覆盖

> 源码：`codex-rs/utils/cli/src/`

### 导出一览

```rust
pub use ApprovalModeCliArg;
pub use CliConfigOverrides;
pub use SandboxModeCliArg;
pub mod format_env_display;
```

### ApprovalModeCliArg

`clap::ValueEnum` 枚举，用于 `--approval-mode` CLI 选项。定义了四种审批模式，并实现 `From<ApprovalModeCliArg> for AskForApproval` 将 CLI 值映射到协议层类型（`codex-rs/utils/cli/src/approval_mode_cli_arg.rs:7-38`）：

| CLI 值 | 协议层映射 | 含义 |
|--------|-----------|------|
| `untrusted` | `UnlessTrusted` | 仅信任命令（ls、cat 等）免审批，其余需用户确认 |
| `on-failure`（已弃用） | `OnFailure` | 命令执行失败时才请求审批 |
| `on-request` | `OnRequest` | 由模型决定何时请求审批 |
| `never` | `Never` | 永不请求审批，失败直接返回模型 |

### SandboxModeCliArg

`clap::ValueEnum` 枚举，用于 `--sandbox` / `-s` 选项。三个变体对应 `SandboxMode`（`codex-rs/utils/cli/src/sandbox_mode_cli_arg.rs:14-18`）：

- `read-only` → 只读
- `workspace-write` → 工作区可写
- `danger-full-access` → 完全访问（危险）

该类型有意不携带 `WorkspaceWrite` 的高级子选项（可写根目录、网络等），用户如需微调可通过 `-c` 覆盖或 `config.toml`。

### CliConfigOverrides

支持 `-c key=value` / `--config key=value` 的通用配置覆盖机制（`codex-rs/utils/cli/src/config_override.rs:18-89`）。嵌入方式为 `#[clap(flatten)]`。

**关键流程**：

1. `parse_overrides()` 遍历所有原始字符串，按第一个 `=` 拆分 key/value
2. value 先尝试按 TOML 语法解析（支持数组、内联表、布尔等）；若失败则去引号后作为字符串字面量
3. key 经过 `canonicalize_override_key()` 规范化——例如 `use_legacy_landlock` 自动映射为 `features.use_legacy_landlock`
4. `apply_on_value()` 将解析后的 `(path, value)` 逐个写入目标 `toml::Value` 树，按点号路径自动创建中间层级

使用示例：
```
-c model="o3"
-c 'sandbox_permissions=["disk-full-read-access"]'
-c shell_environment_policy.inherit=all
```

### format_env_display

格式化环境变量映射为展示字符串，所有值替换为 `*****` 以隐藏敏感信息（`codex-rs/utils/cli/src/format_env_display.rs:3-21`）。无变量时返回 `"-"`。

---

## codex-utils-approval-presets：内置审批预设

> 源码：`codex-rs/utils/approval-presets/src/lib.rs`

定义 `ApprovalPreset` 结构体和 `builtin_approval_presets()` 工厂函数，将审批策略与沙箱策略打包成可供 TUI 和 MCP Server 共享的预设列表。

```rust
pub struct ApprovalPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub approval: AskForApproval,
    pub sandbox: SandboxPolicy,
}
```

三个内置预设（`codex-rs/utils/approval-presets/src/lib.rs:22-46`）：

| id | label | 审批策略 | 沙箱策略 |
|----|-------|---------|---------|
| `read-only` | Read Only | `OnRequest` | 只读 |
| `auto` | Default | `OnRequest` | 工作区可写（等同 Agent mode） |
| `full-access` | Full Access | `Never` | `DangerFullAccess` |

---

## codex-utils-sandbox-summary：沙箱与配置摘要

> 源码：`codex-rs/utils/sandbox-summary/src/`

### summarize_sandbox_policy

将 `SandboxPolicy` 枚举渲染为人类可读的单行摘要（`codex-rs/utils/sandbox-summary/src/sandbox_summary.rs:4-51`）：

- `DangerFullAccess` → `"danger-full-access"`
- `ReadOnly` → `"read-only"`，网络开启时追加 `(network access enabled)`
- `ExternalSandbox` → `"external-sandbox"`，同上
- `WorkspaceWrite` → `"workspace-write [workdir, /tmp, $TMPDIR, <extra roots>]"`，列出所有可写目录，可选追加网络标记

### create_config_summary_entries

基于 `Config` 生成键值对列表，用于 TUI 启动时展示当前生效配置（`codex-rs/utils/sandbox-summary/src/config_summary.rs:7-39`）。固定字段包括 `workdir`、`model`、`provider`、`approval`、`sandbox`；当 wire API 为 Responses 时额外输出 `reasoning effort` 和 `reasoning summaries`。

---

## codex-utils-oss：OSS 提供商就绪检查

> 源码：`codex-rs/utils/oss/src/lib.rs`

为 Ollama 和 LM Studio 两个本地开源模型提供商提供统一接口（`codex-rs/utils/oss/src/lib.rs:8-38`）：

### get_default_model_for_oss_provider

根据 provider ID 返回默认模型名称。未知 provider 返回 `None`。

### ensure_oss_provider_ready

异步函数。确保指定 OSS 提供商可用（模型已下载、服务可达）：
- **LM Studio**：调用 `codex_lmstudio::ensure_oss_ready(config)`
- **Ollama**：先检查 responses API 支持（`ensure_responses_supported`），再调用 `ensure_oss_ready`
- 未知 provider：跳过

---

## codex-utils-plugins：插件命名空间与 MCP Connector

> 源码：`codex-rs/utils/plugins/src/`

### plugin_namespace（插件命名空间解析）

通过向上遍历目录祖先查找 `.codex-plugin/plugin.json` 清单文件，从中提取插件名称（`codex-rs/utils/plugins/src/plugin_namespace.rs:35-42`）。

- 常量 `PLUGIN_MANIFEST_PATH = ".codex-plugin/plugin.json"`
- `plugin_namespace_for_skill_path(path)` 从 skill 文件路径向上查找最近的插件清单，返回其 `name` 字段；若 `name` 为空则回退到目录名

### mcp_connector（MCP Connector 辅助）

提供 connector ID 黑名单过滤与名称消毒（`codex-rs/utils/plugins/src/mcp_connector.rs`）：

- `is_connector_id_allowed(connector_id)` — 检查 connector 是否被允许：排除以 `connector_openai_` 为前缀的 ID，以及硬编码的黑名单。对 first-party chat 来源使用独立的更小黑名单
- `sanitize_name(name)` — 将名称规范化为小写下划线格式（非字母数字字符替换为下划线），空字符串回退为 `"app"`

### mention_syntax（提及符号常量）

定义工具和插件在纯文本中的提及符号（`codex-rs/utils/plugins/src/mention_syntax.rs`）：
- `TOOL_MENTION_SIGIL = '$'` — 工具提及
- `PLUGIN_TEXT_MENTION_SIGIL = '@'` — 插件提及

---

## codex-utils-json-to-toml：JSON 到 TOML 转换

> 源码：`codex-rs/utils/json-to-toml/src/lib.rs`

单函数 crate，提供 `json_to_toml(v: serde_json::Value) -> toml::Value`（`codex-rs/utils/json-to-toml/src/lib.rs:5-28`）。

转换规则：

| JSON 类型 | TOML 类型 | 备注 |
|-----------|-----------|------|
| `null` | `String("")` | TOML 无 null，映射为空字符串 |
| `bool` | `Boolean` | 直接映射 |
| `number`(整数) | `Integer` | 优先 `as_i64()` |
| `number`(浮点) | `Float` | 回退 `as_f64()` |
| `number`(其他) | `String` | 兜底 `to_string()` |
| `string` | `String` | 直接映射 |
| `array` | `Array` | 递归转换 |
| `object` | `Table` | 递归转换 |

---

## codex-utils-elapsed：耗时格式化

> 源码：`codex-rs/utils/elapsed/src/lib.rs`

提供紧凑的人类可读时间格式化（`codex-rs/utils/elapsed/src/lib.rs:6-31`）：

### format_elapsed / format_duration

| 时长范围 | 输出格式 | 示例 |
|----------|---------|------|
| < 1 秒 | `{millis}ms` | `250ms` |
| 1 秒 ~ 60 秒 | `{sec:.2}s` | `1.50s` |
| ≥ 60 秒 | `{min}m {sec:02}s` | `1m 15s` |

`format_elapsed(start_time: Instant)` 是便捷包装，内部调用 `format_duration(duration)`。

---

## codex-utils-cargo-bin：测试二进制与资源定位

> 源码：`codex-rs/utils/cargo-bin/src/lib.rs`

解决 Cargo 和 Bazel 两套构建系统下**测试时定位兄弟二进制和数据文件**的问题。

### cargo_bin(name) → Result<PathBuf, CargoBinError>

核心函数（`codex-rs/utils/cargo-bin/src/lib.rs:39-69`），解析流程：

1. 尝试环境变量 `CARGO_BIN_EXE_{name}`（以及 `-` 替换为 `_` 的变体）
2. 若在 Bazel 环境（`RUNFILES_MANIFEST_ONLY` 已设置），通过 runfiles `rlocation` 解析路径
3. 否则尝试 Cargo 环境的绝对路径
4. 最终回退到 `assert_cmd::Command::cargo_bin()` 作为兜底

### find_resource! 宏

用于定位测试数据文件。Bazel 下通过编译期 `BAZEL_PACKAGE` 环境变量 + runfiles 解析；Cargo 下直接基于 `CARGO_MANIFEST_DIR` 拼接。

### repo_root()

返回仓库根目录的绝对路径。通过 `repo_root.marker` 文件向上回溯 4 层目录获得。

### 辅助函数

- `runfiles_available()` — 检测是否在 Bazel 运行环境中
- `resolve_bazel_runfile()` / `resolve_cargo_runfile()` — 分别在两种构建系统下解析资源文件路径
- `normalize_runfile_path()` — 去除 `.` 和 `..` 组件，规范化路径

### 错误类型 CargoBinError

| 变体 | 含义 |
|------|------|
| `CurrentExe` | 无法读取当前可执行文件路径 |
| `CurrentDir` | 无法读取当前工作目录 |
| `ResolvedPathDoesNotExist` | 环境变量指向的路径不存在 |
| `NotFound` | 所有查找策略均失败 |

---

## codex-utils-rustls-provider：TLS 加密 Provider 初始化

> 源码：`codex-rs/utils/rustls-provider/src/lib.rs`

单函数 crate，解决 rustls 在依赖图中同时启用 `ring` 和 `aws-lc-rs` 时无法自动选择 provider 的问题。

```rust
pub fn ensure_rustls_crypto_provider()
```

使用 `std::sync::Once` 保证全进程只执行一次，将 `ring` 注册为默认 provider（`codex-rs/utils/rustls-provider/src/lib.rs:7-12`）。

---

## 边界 Case 与注意事项

- **CliConfigOverrides 的 TOML 解析回退**：当 `-c model=o3` 中 `o3` 无法被 TOML 解析（裸字符串非法）时，自动剥离引号后作为字符串处理。这使得用户无需手动加引号即可设置字符串值
- **canonicalize_override_key 的别名映射**：`use_legacy_landlock` 会被自动重写为 `features.use_legacy_landlock`，这是一个向后兼容的便捷映射
- **cargo_bin 的 Cargo/Bazel 双模式**：Bazel 下 `CARGO_BIN_EXE_*` 不是绝对路径而是 rlocation path，需通过 runfiles API 解析；Cargo 下则是绝对路径。该函数透明处理两种情况
- **MCP connector 黑名单的来源区分**：first-party chat originator 和普通来源使用不同的黑名单，前者更宽松（仅封禁 1 个 connector），后者封禁 6 个
- **sandbox summary 的 WorkspaceWrite 展示**：始终包含 `workdir`，`/tmp` 和 `$TMPDIR` 的展示取决于 `exclude_slash_tmp` 和 `exclude_tmpdir_env_var` 标志
- **rustls provider 的全局性**：`install_default()` 是进程级操作，`Once` 保证幂等。返回值被丢弃（`let _ =`），因为如果已有 provider 安装则忽略错误