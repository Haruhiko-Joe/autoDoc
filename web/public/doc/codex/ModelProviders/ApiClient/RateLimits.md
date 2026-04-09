# RateLimits — 速率限制头解析与追踪

## 概述与职责

`rate_limits` 模块是 **ApiClient**（`codex-api` crate）的组成部分，负责从 HTTP 响应头中提取速率限制信息并将其结构化为 `RateLimitSnapshot`。它位于 **ModelProviders → ApiClient** 层级之下，是 Codex 系统感知 API 配额使用情况的关键基础设施。

在 Codex 的整体架构中，**ModelProviders** 层负责与各 LLM 提供商通信，**ApiClient** 是其高层抽象。每次 API 请求返回时，响应头中携带的速率限制数据由本模块解析，供上游组件（如 TUI 状态栏、重试逻辑等）使用。

同级模块包括 HttpTransport（底层传输）、ModelsManager（模型发现）、ProviderRegistry（提供商配置）等。

## 关键流程

### 1. 默认速率限制解析（单限制族）

入口函数 `parse_default_rate_limit()` 解析默认的 `x-codex-*` 头族：

1. 调用 `parse_rate_limit_for_limit(headers, None)`，`limit_id` 为 `None` 时默认使用 `"codex"` 前缀
2. 根据 limit_id 构造标准化前缀：`x-{normalized_limit}`（下划线转为连字符）
3. 分别解析 primary 和 secondary 两个时间窗口的三个头：
   - `{prefix}-primary-used-percent` / `{prefix}-secondary-used-percent` → 使用百分比（f64）
   - `{prefix}-primary-window-minutes` / `{prefix}-secondary-window-minutes` → 窗口时长（分钟）
   - `{prefix}-primary-reset-at` / `{prefix}-secondary-reset-at` → 重置时间戳
4. 解析 credits 快照（`x-codex-credits-has-credits`、`x-codex-credits-unlimited`、`x-codex-credits-balance`）
5. 解析可选的 limit name 头（`{prefix}-limit-name`）
6. 组装并返回 `RateLimitSnapshot`

> 源码位置：`codex-rs/codex-api/src/rate_limits.rs:22-97`

### 2. 多限制族批量解析

`parse_all_rate_limits()` 扫描所有响应头，自动发现并解析所有已知的速率限制族：

1. 先调用 `parse_default_rate_limit()` 获取默认的 `codex` 限制快照
2. 遍历所有响应头 key，通过 `header_name_to_limit_id()` 提取 limit_id（匹配 `x-{id}-primary-used-percent` 模式）
3. 排除默认的 `"codex"` 族（已在步骤 1 处理），使用 `BTreeSet` 去重并排序
4. 对每个发现的 limit_id 调用 `parse_rate_limit_for_limit()`，过滤掉无实际数据的快照
5. 返回所有快照的 `Vec<RateLimitSnapshot>`

> 源码位置：`codex-rs/codex-api/src/rate_limits.rs:27-50`

### 3. SSE 事件解析

`parse_rate_limit_event()` 从 JSON 格式的 SSE 事件负载中解析速率限制信息：

1. 将 JSON 字符串反序列化为 `RateLimitEvent` 结构体
2. 校验事件类型必须为 `"codex.rate_limits"`
3. 映射 primary/secondary 窗口数据
4. 提取 credits 快照和 plan_type
5. limit_id 优先取 `metered_limit_name`，其次 `limit_name`，最后默认 `"codex"`

> 源码位置：`codex-rs/codex-api/src/rate_limits.rs:130-160`

### 4. 促销消息提取

`parse_promo_message()` 从响应头 `x-codex-promo-message` 中提取服务端下发的促销/通知消息。

> 源码位置：`codex-rs/codex-api/src/rate_limits.rs:172-177`

## 函数签名与参数说明

### `parse_default_rate_limit(headers: &HeaderMap) -> Option<RateLimitSnapshot>`

解析默认的 `x-codex-*` 速率限制头族。这是最常用的入口。

- **headers**：HTTP 响应头集合
- **返回值**：解析出的快照，始终返回 `Some`（即使所有字段为 `None`）

### `parse_all_rate_limits(headers: &HeaderMap) -> Vec<RateLimitSnapshot>`

扫描并解析所有速率限制头族（包括默认的 `codex` 和任何 `codex_*` 变体）。

- **headers**：HTTP 响应头集合
- **返回值**：所有限制族的快照列表，至少包含一个默认的 `codex` 快照

### `parse_rate_limit_for_limit(headers: &HeaderMap, limit_id: Option<&str>) -> Option<RateLimitSnapshot>`

为指定的 limit_id 解析对应的头族。

- **headers**：HTTP 响应头集合
- **limit_id**：限制标识符（如 `"codex_secondary"`）。`None` 或空字符串默认为 `"codex"`
- **返回值**：始终返回 `Some`（即使窗口数据为空）

### `parse_rate_limit_event(payload: &str) -> Option<RateLimitSnapshot>`

从 JSON SSE 事件负载解析速率限制数据。

- **payload**：JSON 字符串
- **返回值**：仅当事件类型为 `"codex.rate_limits"` 时返回 `Some`

### `parse_promo_message(headers: &HeaderMap) -> Option<String>`

从 `x-codex-promo-message` 头提取促销消息。

- **返回值**：非空消息文本，或 `None`

## 接口/类型定义

### `RateLimitError`

简单的错误类型，包含 `message: String` 字段，实现了 `Display` trait。

### 内部反序列化类型（SSE 事件解析用）

| 类型 | 用途 |
|------|------|
| `RateLimitEvent` | SSE 事件顶层结构，包含 `type`（必须为 `"codex.rate_limits"`）、`plan_type`、`rate_limits`、`credits`、`metered_limit_name`、`limit_name` |
| `RateLimitEventDetails` | 包含 `primary` 和 `secondary` 两个可选的窗口 |
| `RateLimitEventWindow` | 单个窗口：`used_percent: f64`、`window_minutes: Option<i64>`、`reset_at: Option<i64>` |
| `RateLimitEventCredits` | 信用额度信息：`has_credits: bool`、`unlimited: bool`、`balance: Option<String>` |

### 外部协议类型（来自 `codex_protocol`）

- **`RateLimitSnapshot`**：最终输出结构，包含 `limit_id`、`limit_name`、`primary`/`secondary` 窗口、`credits`、`plan_type`
- **`RateLimitWindow`**：单个窗口数据，包含 `used_percent`、`window_minutes`、`resets_at`
- **`CreditsSnapshot`**：信用额度快照，包含 `has_credits`、`unlimited`、`balance`

## 头名称约定与命名规范化

模块使用一套系统化的 HTTP 头命名约定：

**头名称模式**：`x-{limit_id}-{window}-{field}`

- `{limit_id}`：如 `codex`、`codex-secondary`（头中使用连字符）
- `{window}`：`primary` 或 `secondary`
- `{field}`：`used-percent`、`window-minutes`、`reset-at`

**ID 规范化规则**（`normalize_limit_id`，`codex-rs/codex-api/src/rate_limits.rs:254-256`）：
- 输入 limit_id 中的 `_` 在构造头名称时转为 `-`（如 `codex_secondary` → 头前缀 `x-codex-secondary`）
- 解析回来时 `-` 转为 `_`（如头前缀 `x-codex-secondary` → limit_id `codex_secondary`）
- 始终小写化并去除首尾空白

**限制族发现机制**（`header_name_to_limit_id`，`codex-rs/codex-api/src/rate_limits.rs:247-252`）：
- 匹配以 `-primary-used-percent` 结尾的头
- 去掉 `x-` 前缀得到原始 limit_id

## 边界 Case 与注意事项

- **空头或零值窗口的过滤**：`parse_rate_limit_window` 在 `used_percent` 为 0、`window_minutes` 为 0 或 `None`、且 `resets_at` 为 `None` 时返回 `None`，避免产出无意义的窗口数据（`codex-rs/codex-api/src/rate_limits.rs:191-199`）
- **默认快照始终返回**：`parse_default_rate_limit` 和 `parse_rate_limit_for_limit` 始终返回 `Some`，即使所有窗口和 credits 均为 `None`。但 `parse_all_rate_limits` 对非默认族会通过 `has_rate_limit_data()` 过滤空快照
- **Credits 解析是全局的**：`parse_credits_snapshot` 始终读取固定的 `x-codex-credits-*` 头，不受 limit_id 影响。这意味着所有限制族的快照都会携带相同的 credits 数据
- **非有限浮点数被丢弃**：`parse_header_f64` 过滤掉 `NaN` 和 `Infinity`（`codex-rs/codex-api/src/rate_limits.rs:221`）
- **布尔头解析**：支持 `"true"`/`"1"` 和 `"false"`/`"0"`（大小写不敏感），其他值返回 `None`
- **SSE 事件 limit_id 回退链**：优先使用 `metered_limit_name`，其次 `limit_name`，最后默认 `"codex"`