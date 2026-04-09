# Onboarding

## 概述与职责

Onboarding 模块是 Codex TUI 的首次运行与认证引导系统，负责在用户进入主聊天会话之前完成一系列必要的准备步骤。它位于 TUI 层，是用户启动 Codex 后最先看到的交互界面。

在整体架构中，Onboarding 属于 **TUI** 组件的子模块，与 **Auth**（认证凭证管理）和 **Config**（配置管理）协同工作。TUI 的同级模块包括 Core（代理引擎）、CLI（命令行入口）、AppServer（HTTP/WebSocket 服务）等。

该模块由四个核心部分组成：
- **欢迎界面**（Welcome）：展示品牌动画和欢迎信息
- **认证流程**（Auth）：支持 ChatGPT 浏览器登录、设备码登录和 API Key 三种方式
- **目录信任确认**（Trust Directory）：对项目级配置进行安全确认
- **工作目录选择**（CWD Prompt）：让用户确认或切换会话工作目录

## 关键流程

### Onboarding 主流程

整个 Onboarding 以步骤（Step）为单位线性推进，由 `OnboardingScreen` 统一编排：

1. **构建步骤列表**：根据 `OnboardingScreenArgs` 中的 `show_login_screen`、`show_trust_screen` 等标志，有条件地添加 Welcome、Auth、TrustDirectory 步骤（`codex-rs/tui/src/onboarding/onboarding_screen.rs:80-146`）
2. **事件循环驱动**：`run_onboarding_app()` 使用 `tokio::select!` 同时监听 TUI 键盘/绘制事件和 AppServer 通知（如登录完成），直到所有步骤完成或用户退出（`codex-rs/tui/src/onboarding/onboarding_screen.rs:434-529`）
3. **步骤状态机**：每个步骤实现 `StepStateProvider` trait，返回 `Hidden`、`InProgress` 或 `Complete` 三种状态。屏幕只渲染到当前第一个 `InProgress` 步骤为止，已完成的步骤也会保留在画面上（`codex-rs/tui/src/onboarding/onboarding_screen.rs:148-176`）
4. **返回结果**：最终输出 `OnboardingResult`，包含目录信任决策和是否应该退出程序

### 认证流程状态机

认证模块（`AuthModeWidget`）是 Onboarding 中最复杂的部分，其核心是 `SignInState` 枚举驱动的状态机：

```
PickMode → ChatGptContinueInBrowser → ChatGptSuccessMessage → ChatGptSuccess
         → ChatGptDeviceCode → ChatGptSuccessMessage → ChatGptSuccess
         → ApiKeyEntry → ApiKeyConfigured
```

**ChatGPT 浏览器登录**：
1. 用户在 PickMode 选择 "Sign in with ChatGPT"
2. 异步调用 `LoginAccountParams::Chatgpt` 向 AppServer 发起登录请求（`codex-rs/tui/src/onboarding/auth.rs:753-795`）
3. 收到 `auth_url` 后尝试自动打开浏览器，进入 `ChatGptContinueInBrowser` 状态显示链接
4. 等待 AppServer 推送 `AccountLoginCompleted` 通知确认登录结果（`codex-rs/tui/src/onboarding/auth.rs:806-831`）

**设备码登录（Headless）**：
1. 用户选择 "Sign in with Device Code"，适用于无浏览器的远程/headless 环境
2. 调用 `request_device_code()` 获取一次性验证码和验证 URL（`codex-rs/tui/src/onboarding/auth/headless_chatgpt_login.rs:36-122`）
3. 在界面显示验证码和链接，用户在另一台设备上完成验证
4. 通过 `complete_device_code_login()` 轮询等待验证完成
5. 如果 `request_device_code` 返回 `NotFound` 错误，自动降级到浏览器登录模式（`codex-rs/tui/src/onboarding/auth/headless_chatgpt_login.rs:56-66`）
6. 验证成功后，通过 `load_local_chatgpt_auth()` 读取本地凭证，并发送 `ChatgptAuthTokens` 给 AppServer 完成会话登录

**API Key 登录**：
1. 用户选择 "Provide your own API key"，进入 `ApiKeyEntry` 状态
2. 如果检测到 `OPENAI_API_KEY` 环境变量，自动预填充（`codex-rs/tui/src/onboarding/auth.rs:662-690`）
3. 用户输入/粘贴 API key 后按 Enter，异步发送 `LoginAccountParams::ApiKey` 给 AppServer 保存（`codex-rs/tui/src/onboarding/auth.rs:692-736`）

### 本地 ChatGPT 凭证加载

`load_local_chatgpt_auth()` 从本地 `auth.json` 文件中读取 ChatGPT 登录凭证（`codex-rs/tui/src/local_chatgpt_auth.rs:14-52`）：

1. 调用 `load_auth_dot_json()` 读取文件
2. 验证认证模式不是 API Key（排除非 ChatGPT 登录）
3. 提取 `access_token` 和 `chatgpt_account_id`（优先使用 `tokens.account_id`，回退到 `id_token.chatgpt_account_id`）
4. 如果指定了 `forced_chatgpt_workspace_id`，校验 workspace 匹配
5. 从 JWT id_token 中提取 `chatgpt_plan_type`（转为小写）

### 目录信任确认

`TrustDirectoryWidget` 在用户首次在某个目录运行 Codex 时显示（`codex-rs/tui/src/onboarding/trust_directory.rs`）：

1. 提示用户当前工作目录路径，警告不受信任目录的 prompt injection 风险
2. 用户选择 "Yes, continue" 时，调用 `resolve_root_git_project_for_trust()` 解析 git 根目录，然后通过 `set_project_trust_level()` 将其标记为 `Trusted`（`codex-rs/tui/src/onboarding/trust_directory.rs:144-153`）
3. 用户选择 "No, quit" 则退出应用

### 工作目录选择

`run_cwd_selection_prompt()` 在恢复（resume）或分叉（fork）已有会话时显示（`codex-rs/tui/src/cwd_prompt.rs:76-118`），让用户选择：
- **Session 目录**：上次会话记录的工作目录（默认高亮）
- **Current 目录**：当前终端的工作目录

## 函数签名与参数说明

### `run_onboarding_app(args, app_server, tui) -> Result<OnboardingResult>`

Onboarding 主入口，驱动整个引导流程的事件循环。

- **args: `OnboardingScreenArgs`**：控制哪些步骤需要展示
- **app_server: `Option<AppServerSession>`**：可选的 AppServer 连接，用于接收登录通知
- **tui: `&mut Tui`**：终端 UI 句柄

> 源码位置：`codex-rs/tui/src/onboarding/onboarding_screen.rs:434-529`

### `load_local_chatgpt_auth(codex_home, auth_credentials_store_mode, forced_chatgpt_workspace_id) -> Result<LocalChatgptAuth, String>`

从本地存储加载 ChatGPT 认证凭证。

- **codex_home: `&Path`**：Codex 配置目录路径
- **auth_credentials_store_mode: `AuthCredentialsStoreMode`**：凭证存储方式
- **forced_chatgpt_workspace_id: `Option<&str>`**：强制要求的 workspace ID，不匹配则返回错误

> 源码位置：`codex-rs/tui/src/local_chatgpt_auth.rs:14-52`

### `run_cwd_selection_prompt(tui, action, current_cwd, session_cwd) -> Result<CwdPromptOutcome>`

显示工作目录选择提示，返回用户选择。

- **action: `CwdPromptAction`**：`Resume`（恢复会话）或 `Fork`（分叉会话），影响提示文案
- **current_cwd / session_cwd: `&Path`**：两个候选目录路径

> 源码位置：`codex-rs/tui/src/cwd_prompt.rs:76-118`

### `mark_url_hyperlink(buf, area, url)`

将 ratatui Buffer 中 cyan+underlined 样式的单元格标记为 OSC 8 终端超链接。解决了 ratatui 逐行渲染导致跨行 URL 无法被终端识别为可点击链接的问题。

- 内部会过滤 URL 中的 ESC（`\x1B`）和 BEL（`\x07`）字符，防止终端转义注入

> 源码位置：`codex-rs/tui/src/onboarding/auth.rs:53-79`

## 接口/类型定义

### `SignInState`

认证流程的核心状态枚举：

| 变体 | 说明 |
|------|------|
| `PickMode` | 选择认证方式的初始菜单 |
| `ChatGptContinueInBrowser(ContinueInBrowserState)` | 等待用户在浏览器中完成 ChatGPT 登录 |
| `ChatGptDeviceCode(ContinueWithDeviceCodeState)` | 等待用户在其他设备上输入验证码 |
| `ChatGptSuccessMessage` | 登录成功，展示注意事项和使用说明 |
| `ChatGptSuccess` | 最终成功状态（用户已确认） |
| `ApiKeyEntry(ApiKeyInputState)` | API Key 输入界面 |
| `ApiKeyConfigured` | API Key 已保存成功 |

### `StepState`

通用步骤状态枚举，由 `StepStateProvider` trait 返回：

| 变体 | 说明 |
|------|------|
| `Hidden` | 该步骤不显示（如已登录用户的 Welcome 步骤） |
| `InProgress` | 当前活跃步骤，接收用户输入 |
| `Complete` | 步骤已完成，但仍保留在界面上 |

### `LocalChatgptAuth`

本地 ChatGPT 凭证结构体：

| 字段 | 类型 | 说明 |
|------|------|------|
| `access_token` | `String` | ChatGPT 访问令牌 |
| `chatgpt_account_id` | `String` | ChatGPT 账户 ID / workspace ID |
| `chatgpt_plan_type` | `Option<String>` | 套餐类型（小写），如 `"business"` |

### `CwdPromptOutcome` / `CwdSelection`

工作目录选择结果：

| 类型 | 变体 | 说明 |
|------|------|------|
| `CwdPromptOutcome` | `Selection(CwdSelection)` | 用户做出了选择 |
| | `Exit` | 用户按 Ctrl+C/D 退出 |
| `CwdSelection` | `Session` | 使用上次会话的工作目录 |
| | `Current` | 使用当前终端工作目录 |

### `TrustDirectorySelection`

目录信任确认结果：`Trust`（信任并继续）或 `Quit`（退出）。

## 配置项与默认值

- **`OnboardingScreenArgs.show_login_screen`**：是否展示登录步骤。需要 `app_server_request_handle` 不为 `None` 才实际添加
- **`OnboardingScreenArgs.show_trust_screen`**：是否展示目录信任确认
- **`forced_login_method`**（`ForcedLoginMethod`）：`Api` 或 `Chatgpt`，强制限定登录方式。设为 `Chatgpt` 时 API Key 选项被禁用并显示提示
- **`forced_chatgpt_workspace_id`**：强制要求的 ChatGPT workspace ID，加载本地凭证时如果不匹配会被拒绝
- **`config.animations`**：控制是否启用 Welcome 界面的 ASCII 动画和认证流程中的 shimmer 效果
- **Welcome 动画尺寸阈值**：终端宽度 < 60 列或高度 < 37 行时自动跳过动画（`codex-rs/tui/src/onboarding/welcome.rs:23-24`）

## 边界 Case 与注意事项

- **设备码登录的降级机制**：如果 `request_device_code()` 返回 `ErrorKind::NotFound`（通常意味着设备码端点不可用），会自动降级为浏览器登录模式，而非直接报错
- **取消操作的并发安全**：设备码登录使用 `Arc<Notify>` 作为取消令牌，所有状态更新都会通过 `device_code_attempt_matches()` 验证当前 cancel handle 是否匹配，防止过期的异步任务覆盖新的登录尝试（`codex-rs/tui/src/onboarding/auth/headless_chatgpt_login.rs:193-202`）
- **API Key 环境变量预填充**：进入 API Key 输入界面时，会检测 `OPENAI_API_KEY` 环境变量并预填充。用户开始输入或按 Backspace 时会清除预填充值
- **OSC 8 超链接安全**：`mark_url_hyperlink()` 会过滤 URL 中的 ESC 和 BEL 控制字符，防止恶意 URL 注入终端转义序列
- **ChatGPT 登录成功后的画面清除**：在 `ChatGptSuccessMessage` 状态下会执行一次完整的终端重置（SGR Reset + clear），解决登录流程可能残留的样式污染问题（`codex-rs/tui/src/onboarding/onboarding_screen.rs:464-493`）
- **Windows 沙箱提示**：在 Windows 平台上，如果沙箱级别为 `Disabled`，信任确认界面会额外显示 "create a sandbox" 提示
- **目录信任解析**：信任操作会通过 `resolve_root_git_project_for_trust()` 向上查找 git 仓库根目录，以避免对子目录重复授信。如果不在 git 仓库中，则直接信任当前目录
- **按 Esc 退出认证会终止应用**：在认证步骤按 Ctrl+C/D 退出时，程序不会停留在未认证状态的主界面，而是设置 `should_exit = true` 直接退出（`codex-rs/tui/src/onboarding/onboarding_screen.rs:280-284`）

## 关键代码片段

### 步骤状态驱动的渲染逻辑

`OnboardingScreen` 的渲染根据每个步骤的状态决定显示范围——遇到第一个 `InProgress` 步骤后停止：

```rust
fn current_steps(&self) -> Vec<&Step> {
    let mut out: Vec<&Step> = Vec::new();
    for step in self.steps.iter() {
        match step.get_step_state() {
            StepState::Hidden => continue,
            StepState::Complete => out.push(step),
            StepState::InProgress => {
                out.push(step);
                break;
            }
        }
    }
    out
}
```

> 源码位置：`codex-rs/tui/src/onboarding/onboarding_screen.rs:163-176`

### 设备码登录的取消令牌验证

确保异步登录回调只在对应的登录尝试仍然活跃时才更新状态：

```rust
fn device_code_attempt_matches(state: &SignInState, cancel: &Arc<Notify>) -> bool {
    matches!(
        state,
        SignInState::ChatGptDeviceCode(state)
            if state.cancel.as_ref().is_some_and(|existing| Arc::ptr_eq(existing, cancel))
    )
}
```

> 源码位置：`codex-rs/tui/src/onboarding/auth/headless_chatgpt_login.rs:193-202`