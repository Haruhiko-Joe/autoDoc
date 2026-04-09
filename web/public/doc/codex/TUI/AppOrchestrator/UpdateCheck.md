# UpdateCheck — 版本检查与更新提示系统

## 概述与职责

UpdateCheck 是 TUI 层中的版本更新检测与用户提示模块，隶属于 **TUI → AppOrchestrator** 层级。它在主聊天会话启动之前运行，负责三件事：

1. **检测新版本**：从 GitHub Releases 或 Homebrew Cask API 获取最新版本号，与当前版本比较
2. **判断更新方式**：根据安装来源（npm、bun、brew）确定正确的升级命令
3. **展示交互提示**：在终端渲染一个选择界面，让用户决定立即更新、跳过、或永久忽略当前版本

同级兄弟模块包括 ChatSurface（主聊天界面）、Onboarding（首次运行引导）、BottomPane（底部输入区）等。UpdateCheck 与 Onboarding 类似，都是在进入主会话前拦截用户的"前置屏幕"。

该模块仅在 Release 构建中生效（`#[cfg(not(debug_assertions))]`），开发构建中不会触发版本检查。

## 模块结构

该系统由三个文件组成，各司其职：

| 文件 | 职责 |
|------|------|
| `updates.rs` | 版本获取、缓存读写、版本比较、dismissal 持久化 |
| `update_action.rs` | 检测安装方式，生成对应的升级命令 |
| `update_prompt.rs` | TUI 交互界面，渲染选择菜单并处理用户输入 |

## 关键流程

### 整体调用链

```
run_update_prompt_if_needed()
  ├── updates::get_upgrade_version_for_popup()  // 是否有可用更新？
  │     ├── get_upgrade_version()               // 读缓存 + 后台刷新
  │     └── 检查 dismissed_version              // 用户是否已忽略此版本？
  ├── update_action::get_update_action()        // 检测安装方式
  └── UpdatePromptScreen 渲染与事件循环          // 等待用户选择
        ├── UpdateNow  → 返回 RunUpdate(action)
        ├── NotNow     → 返回 Continue
        └── DontRemind → dismiss_version() + Continue
```

### 版本检查流程（updates.rs）

`get_upgrade_version()` 是版本检查的入口（`updates.rs:17-46`）：

1. 检查配置项 `config.check_for_update_on_startup`，若为 `false` 直接返回 `None`
2. 从本地缓存文件 `version.json`（位于 `config.codex_home` 目录）读取上次检查结果
3. 若缓存不存在或距上次检查超过 **20 小时**，在后台 `tokio::spawn` 异步刷新缓存——不阻塞 TUI 启动
4. 使用**上一次缓存的版本号**（而非本次网络请求结果）与当前版本比较，若有更新则返回新版本号

这意味着版本检测存在一个刻意的"延迟"：用户在新版本发布后的**第二次启动**才会看到更新提示，第一次启动仅触发后台刷新。

#### 远程版本获取策略

根据安装方式选择不同的数据源（`updates.rs:81-121`）：

- **Homebrew 安装**：请求 `https://formulae.brew.sh/api/cask/codex.json`，取 `version` 字段。因为 Homebrew 发布可能滞后于 GitHub，使用 Cask API 能避免提示用户更新到 Homebrew 尚未提供的版本
- **其他安装方式**：请求 `https://api.github.com/repos/openai/codex/releases/latest`，从 `tag_name` 中提取版本号（格式为 `rust-v{version}`）

#### 缓存文件格式

缓存写入 `{codex_home}/version.json`，结构如下：

```json
{
  "latest_version": "1.2.3",
  "last_checked_at": "2026-04-04T10:00:00Z",
  "dismissed_version": "1.2.3"
}
```

`dismissed_version` 字段记录用户选择"不再提醒"的版本号。刷新缓存时会保留已有的 `dismissed_version` 值。

### 安装方式检测（update_action.rs）

`get_update_action()` 通过环境变量和可执行文件路径判断安装来源（`update_action.rs:31-42`）：

| 判断条件 | 结果 | 升级命令 |
|----------|------|----------|
| 环境变量 `CODEX_MANAGED_BY_NPM` 存在 | `NpmGlobalLatest` | `npm install -g @openai/codex` |
| 环境变量 `CODEX_MANAGED_BY_BUN` 存在 | `BunGlobalLatest` | `bun install -g @openai/codex` |
| macOS 且路径以 `/opt/homebrew` 或 `/usr/local` 开头 | `BrewUpgrade` | `brew upgrade --cask codex` |
| 以上都不满足 | `None`（不显示更新提示） | — |

检测优先级为 npm > bun > brew。当无法确定安装方式时返回 `None`，此时即使有新版本也不会显示更新提示。

### 交互界面流程（update_prompt.rs）

`run_update_prompt_if_needed()` 是 TUI 启动时调用的入口（`update_prompt.rs:35-84`）：

1. 调用 `get_upgrade_version_for_popup()` 检查是否有未被忽略的新版本
2. 调用 `get_update_action()` 确定升级命令
3. 若两者都有值，创建 `UpdatePromptScreen` 并进入事件循环
4. 渲染三个选项供用户选择：
   - **Update now** — 显示具体命令（如 `runs npm install -g @openai/codex`）
   - **Skip** — 本次跳过，下次启动仍会提示
   - **Skip until next version** — 将当前版本记录为 dismissed，直到出现更新的版本才再次提示

#### 键盘交互

| 按键 | 行为 |
|------|------|
| `↑` / `k` | 上移高亮 |
| `↓` / `j` | 下移高亮 |
| `Enter` | 确认当前高亮选项 |
| `1` / `2` / `3` | 直接选择对应选项 |
| `Esc` / `Ctrl+C` / `Ctrl+D` | 等同于 Skip |

高亮导航支持循环滚动——在第一项按上键会跳到最后一项。

#### 选择结果处理

```rust
pub(crate) enum UpdatePromptOutcome {
    Continue,                    // 继续启动主会话
    RunUpdate(UpdateAction),     // 退出 TUI，执行升级命令
}
```

- 选择 **Update Now**：返回 `RunUpdate(action)`，调用方清理终端后执行升级命令
- 选择 **Skip**：返回 `Continue`，正常进入主会话
- 选择 **Don't Remind**：调用 `dismiss_version()` 持久化忽略记录后返回 `Continue`

## 函数签名

### updates.rs 公开 API

#### `get_upgrade_version(config: &Config) -> Option<String>`

检查并返回可用的新版本号。若无更新或配置关闭则返回 `None`。同时在后台触发缓存刷新。

#### `get_upgrade_version_for_popup(config: &Config) -> Option<String>`

在 `get_upgrade_version` 基础上额外检查 `dismissed_version`，只返回用户未忽略的新版本。供 UI 层调用。

#### `dismiss_version(config: &Config, version: &str) -> anyhow::Result<()>`

将指定版本写入缓存的 `dismissed_version` 字段，使后续调用 `get_upgrade_version_for_popup` 时跳过该版本。

### update_action.rs 公开 API

#### `UpdateAction::command_args(self) -> (&'static str, &'static [&'static str])`

返回升级命令的程序名和参数数组，如 `("npm", &["install", "-g", "@openai/codex"])`。

#### `UpdateAction::command_str(self) -> String`

返回 shell 安全的命令字符串表示（通过 `shlex::try_join` 编码）。

#### `get_update_action() -> Option<UpdateAction>`

检测当前安装方式并返回对应的 `UpdateAction`。

### update_prompt.rs 公开 API

#### `run_update_prompt_if_needed(tui: &mut Tui, config: &Config) -> Result<UpdatePromptOutcome>`

主入口函数。检查更新、显示提示界面、等待用户选择、返回结果。

## 类型定义

### `UpdateAction`（update_action.rs:3-10）

```rust
pub enum UpdateAction {
    NpmGlobalLatest,   // npm install -g @openai/codex
    BunGlobalLatest,   // bun install -g @openai/codex
    BrewUpgrade,       // brew upgrade --cask codex
}
```

### `UpdatePromptOutcome`（update_prompt.rs:30-33）

```rust
pub(crate) enum UpdatePromptOutcome {
    Continue,                    // 跳过更新，继续启动
    RunUpdate(UpdateAction),     // 退出 TUI 执行更新命令
}
```

### `VersionInfo`（updates.rs:48-55，内部类型）

缓存文件的序列化结构，包含 `latest_version`、`last_checked_at`（ISO-8601 时间戳）和可选的 `dismissed_version`。

## 配置项

| 配置项 | 来源 | 说明 |
|--------|------|------|
| `config.check_for_update_on_startup` | `Config` | 是否启用启动时版本检查，`false` 时整个模块不生效 |
| `config.codex_home` | `Config` | 缓存文件 `version.json` 的存放目录 |
| `CODEX_MANAGED_BY_NPM` | 环境变量 | 存在时标识为 npm 安装 |
| `CODEX_MANAGED_BY_BUN` | 环境变量 | 存在时标识为 bun 安装 |

## 边界 Case 与注意事项

- **仅 Release 构建生效**：`updates.rs` 和 `update_prompt.rs` 均标记 `#[cfg(not(debug_assertions))]`，开发构建中完全跳过版本检查
- **首次运行无提示**：首次启动时缓存文件不存在，`get_upgrade_version` 返回 `None`（因为没有缓存数据可比较），但会触发后台刷新。用户第二次启动时才可能看到提示
- **网络请求不阻塞**：版本检查通过 `tokio::spawn` 在后台执行，不影响 TUI 启动速度。网络失败只记录错误日志，不影响用户体验
- **Pre-release 版本被忽略**：`parse_version` 只解析纯 `major.minor.patch` 格式，含 `-beta` 等后缀的版本号解析为 `None`，不会触发更新提示
- **GitHub tag 格式要求**：Release tag 必须以 `rust-v` 为前缀（如 `rust-v1.5.0`），否则解析失败
- **无法确定安装方式时静默跳过**：若 `get_update_action()` 返回 `None`（如手动编译安装），即使检测到新版本也不会显示提示，因为无法生成可靠的升级命令
- **Dismissal 按版本精确匹配**：用户忽略 `1.2.3` 后，`1.2.4` 发布时会重新提示