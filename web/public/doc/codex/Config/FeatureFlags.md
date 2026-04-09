# FeatureFlags — 特性标志注册表与解析引擎

## 概述与职责

`codex-features` 是 Codex 的**集中式特性标志管理中心**，位于 Config 层级之下，为整个系统提供统一的特性开关能力。它定义了约 50 个特性标志，每个标志都有明确的生命周期阶段（`UnderDevelopment → Experimental → Stable → Deprecated → Removed`）、默认启用状态和配置键名。

该模块的核心职责包括：

- **特性注册**：通过静态数组 `FEATURES` 维护所有特性的元数据（ID、配置键、生命周期阶段、默认值）
- **分层解析**：从 base 配置、profile 配置和运行时覆盖三个层级，按优先级依次叠加，计算出最终的有效特性集合
- **遗留别名迁移**：将旧版配置键名（如 `connectors` → `apps`、`collab` → `multi_agent`）自动映射到新的规范键名，并生成弃用通知
- **依赖规范化**：自动处理特性间的隐含依赖关系（如 `SpawnCsv` 隐含启用 `Collab`）
- **指标上报**：通过 OpenTelemetry 发射 `codex.feature.state` 计数器，记录与默认值不同的特性状态

在整体架构中，`Config` 模块管理所有层级的配置文件，而 `FeatureFlags` 则是 Config 下专门负责特性标志解析的子模块。Core、TUI、ToolSystem、Sandbox 等几乎所有顶层模块都依赖 Config（进而依赖 FeatureFlags）来决定功能的启用与禁用。

## 关键流程

### 特性集解析流程（`Features::from_sources`）

这是最核心的入口函数，负责从多个配置源构建最终的特性集合（`src/lib.rs:400-424`）：

1. **初始化默认值**：调用 `Features::with_defaults()` 遍历 `FEATURES` 数组，将所有 `default_enabled = true` 的特性加入启用集合
2. **依次应用 base 和 profile 配置**：对每个 `FeatureConfigSource`，先处理遗留的顶层配置字段（`include_apply_patch_tool` 等），再通过 `apply_map()` 处理 `[features]` 表中的键值对
3. **应用运行时覆盖**：`FeatureOverrides` 中的值具有最高优先级
4. **规范化依赖**：调用 `normalize_dependencies()` 确保特性间的依赖约束被满足

```
默认值 → base 配置覆盖 → profile 配置覆盖 → 运行时覆盖 → 依赖规范化
```

### 配置键解析流程（`feature_for_key`）

当收到一个配置键名时（`src/lib.rs:486-493`）：

1. 先在 `FEATURES` 数组中查找精确匹配的 `spec.key`
2. 若未找到，退回到 `legacy::feature_for_key()` 在别名表 `ALIASES` 中查找
3. 若匹配到遗留别名，记录日志并返回对应的 `Feature` 枚举值

### 依赖规范化（`normalize_dependencies`）

在所有配置层叠加完成后执行（`src/lib.rs:430-441`）：

- `SpawnCsv` 启用时自动启用 `Collab`（单向依赖）
- `CodeModeOnly` 启用时自动启用 `CodeMode`（单向依赖）
- `JsReplToolsOnly` 需要 `JsRepl` 先启用，否则会被强制禁用并打印警告

### 遗留别名迁移（`legacy.rs`）

`legacy.rs` 维护了一个 `ALIASES` 常量数组，将 9 个旧配置键映射到对应的 `Feature` 枚举（`src/legacy.rs:11-48`）。例如：

| 旧键名 | 映射到的 Feature |
|--------|-----------------|
| `connectors` | `Apps` |
| `collab` | `Collab` |
| `web_search` | `WebSearchRequest` |
| `memory_tool` | `MemoryTool` |
| `include_apply_patch_tool` | `ApplyPatchFreeform` |
| `request_permissions` | `ExecPermissionApprovals` |

此外，`LegacyFeatureToggles` 结构体处理三个曾经是顶层配置字段（而非 `[features]` 表内）的遗留开关：`include_apply_patch_tool`、`experimental_use_freeform_apply_patch` 和 `experimental_use_unified_exec_tool`（`src/legacy.rs:64-92`）。

### 指标上报（`emit_metrics`）

`emit_metrics` 方法遍历所有非 `Removed` 阶段的特性，对于当前启用状态与默认值不同的特性，向 OpenTelemetry 发射 `codex.feature.state` 计数器，附带 `feature` 和 `value` 标签（`src/lib.rs:340-356`）。这使运维团队能监控特性标志的实际使用情况。

## 核心类型定义

### `Feature` 枚举

定义了所有特性标志的唯一标识（`src/lib.rs:72-187`），约 50 个变体，涵盖：

- **工具类**：`ShellTool`、`JsRepl`、`CodeMode`、`UnifiedExec`、`ApplyPatchFreeform`、`ImageGeneration` 等
- **沙箱类**：`UseLegacyLandlock`、`WindowsSandbox`、`ExecPermissionApprovals`
- **协作/多 Agent**：`Collab`、`MultiAgentV2`、`SpawnCsv`、`CollaborationModes`
- **UI/体验**：`Personality`、`FastMode`、`RealtimeConversation`、`PreventIdleSleep`、`Steer`
- **扩展性**：`Apps`、`Plugins`、`ToolSearch`、`ToolSuggest`、`CodexHooks`
- **Web 搜索**：`WebSearchRequest`、`WebSearchCached`、`SearchTool`（后两者已弃用/移除）
- **可观测性**：`RuntimeMetrics`、`GeneralAnalytics`

### `Stage` 枚举

表示特性的生命周期阶段（`src/lib.rs:24-40`）：

| 阶段 | 含义 | 默认可启用 |
|------|------|-----------|
| `UnderDevelopment` | 开发中，不对外暴露 | 否（测试强制） |
| `Experimental` | 实验性，通过 `/experimental` 菜单可由用户切换；附带 `name`、`menu_description`、`announcement` | 否 |
| `Stable` | 稳定，保留标志用于临时开关 | 是（但非必须） |
| `Deprecated` | 已弃用 | — |
| `Removed` | 已移除但保留配置键以向后兼容 | — |

`Experimental` 变体携带三个静态字符串字段，用于 TUI 的 `/experimental` 菜单渲染。

### `FeatureSpec` 结构体

特性注册表的单条记录（`src/lib.rs:516-521`）：

```rust
pub struct FeatureSpec {
    pub id: Feature,           // 枚举标识
    pub key: &'static str,     // 配置文件中的键名
    pub stage: Stage,          // 生命周期阶段
    pub default_enabled: bool, // 默认是否启用
}
```

### `Features` 结构体

持有已解析的有效特性集合（`src/lib.rs:219-223`）：

- `enabled: BTreeSet<Feature>` — 当前启用的特性集合
- `legacy_usages: BTreeSet<LegacyFeatureUsage>` — 本次解析中检测到的遗留键使用记录

### `FeatureConfigSource` / `FeatureOverrides`

分别代表一个配置层级的输入源和运行时覆盖（`src/lib.rs:225-237`）。`FeatureConfigSource` 包含可选的 `FeaturesToml`（即 `[features]` TOML 表）以及三个遗留顶层字段。`FeatureOverrides` 仅包含 `include_apply_patch_tool` 和 `web_search_request` 两个可选覆盖。

### `FeaturesToml`

可直接从 TOML 反序列化的 `[features]` 表（`src/lib.rs:508-512`），内部是 `BTreeMap<String, bool>`，支持 `serde(flatten)` 进行自由形式的键值解析。

## 函数签名

### `Features::from_sources(base, profile, overrides) -> Features`

主入口。按 base → profile → overrides 三层叠加构建最终特性集。

### `Features::with_defaults() -> Features`

根据 `FEATURES` 数组中所有 `default_enabled = true` 的条目初始化特性集。

### `Features::enabled(&self, f: Feature) -> bool`

查询某特性是否启用。

### `Features::apps_enabled(&self, auth_manager) -> bool`（async）

检查 Apps 功能是否可用——需同时满足 `Feature::Apps` 已启用**且**用户持有 ChatGPT 认证（`src/lib.rs:276-286`）。

### `Features::emit_metrics(&self, otel: &SessionTelemetry)`

向 OpenTelemetry 上报所有与默认值不同的非 Removed 特性状态。

### `feature_for_key(key: &str) -> Option<Feature>`

将配置键名解析为 `Feature` 枚举，支持规范键和遗留别名。

### `unstable_features_warning_event(...) -> Option<Event>`

检查是否有 `UnderDevelopment` 阶段的特性被显式启用，如果有则生成一条包含配置文件路径的警告事件（`src/lib.rs:866-906`）。

## 配置项

特性标志通过 `config.toml` 中的 `[features]` 表配置：

```toml
[features]
js_repl = true
code_mode = true
```

也可通过 CLI 的 `--enable <key>` 参数动态启用。所有合法的 key 即为 `FEATURES` 数组中每个 `FeatureSpec.key` 的值。

环境和平台相关的默认值：
- `unified_exec`：非 Windows 平台默认启用（`!cfg!(windows)`）
- `prevent_idle_sleep`：在 macOS/Linux/Windows 上为 `Experimental` 阶段，其他平台为 `UnderDevelopment`

## 边界 Case 与注意事项

- **`TuiAppServer` 的特殊处理**：`apply_map` 中对 `tui_app_server` 键直接 `continue`，完全忽略该配置项，因为 TUI 现在始终使用 app-server 实现（`src/lib.rs:374-376`）
- **Apps 需要双重条件**：`Feature::Apps` 启用只是必要条件，还需要 ChatGPT 认证（`is_chatgpt_auth`），API Key 认证不足以启用 Apps
- **遗留键使用不会记录警告如果键名与规范键相同**：`record_legacy_usage` 会检查 `alias == feature.key()` 并提前返回（`src/lib.rs:329-334`）
- **Web 搜索弃用**：`web_search_request` 和 `web_search_cached` 都标记为 `Deprecated`，因为 web 搜索已默认启用；遗留配置会生成特殊的弃用通知，引导用户使用新的顶层 `web_search` 配置字段
- **未知键名**：`apply_map` 遇到无法识别的键名时通过 `tracing::warn!` 记录警告，但不会中断解析
- **测试强制约束**：测试用例要求所有 `UnderDevelopment` 阶段的特性必须 `default_enabled = false`，所有 `default_enabled = true` 的特性必须处于 `Stable` 或 `Removed` 阶段