# IntegrationUtilities — 外部平台集成工具集

## 概述与职责

IntegrationUtilities 是 Claude Code 基础设施层（Infrastructure → FeatureUtilities）中的一组外部平台集成工具，负责将 Claude Code 与操作系统、浏览器、远程环境等外部平台对接。它包含四个相对独立的子系统：

- **claudeInChrome/**：Chrome Native Host 通信与浏览器内 Claude 体验
- **deepLink/**：`claude-cli://` 协议注册、解析与终端启动
- **nativeInstaller/**：原生二进制的下载、安装与版本管理
- **teleport/**：远程环境选择与 Git Bundle 传输

在整体架构中，本模块位于 Infrastructure 层的 FeatureUtilities 下，与 ConfigAndSettings、PermissionsAndAuth、CommonUtilities 等同级子系统协作，为上层的 Entrypoints、Services、BridgeAndRemote 等模块提供平台集成基础能力。

---

## 子系统一：claudeInChrome/

### 功能概述

实现 Chrome Native Messaging 协议，让 Claude Code 作为 Chrome 扩展的 Native Host 运行，并通过 MCP 服务器为浏览器自动化工具提供后端支持。支持 7 种 Chromium 浏览器：Chrome、Brave、Arc、Edge、Chromium、Vivaldi、Opera。

### 关键流程

#### Native Host 启动与消息循环

1. `runChromeNativeHost()` 创建 `ChromeNativeHost` 实例和 `ChromeMessageReader`（`src/utils/claudeInChrome/chromeNativeHost.ts:59-82`）
2. `ChromeNativeHost.start()` 在安全的 Unix Domain Socket（或 Windows Named Pipe）上创建服务器，监听 MCP 客户端连接
3. `ChromeMessageReader` 从 stdin 异步读取 Chrome 原生消息（4 字节 LE 长度前缀 + JSON payload），最大消息 1MB
4. 消息循环处理 `ping`、`get_status`、`tool_response`、`notification` 等类型
5. MCP 客户端通过 socket 连接后，`tool_request` 从 socket 转发到 Chrome（stdout），`tool_response` 从 Chrome 转发回 socket

#### MCP 服务器启动

`runClaudeInChromeMcpServer()` 使用 `@ant/claude-for-chrome-mcp` 包创建 MCP 服务器，通过 StdioServerTransport 与父进程通信（`src/utils/claudeInChrome/mcpServer.ts:248-275`）。`createChromeContext()` 构建上下文，配置 socket 路径、OAuth 令牌、Bridge URL、设备配对、分析事件等。

#### 安装与启用判断

- `setupClaudeInChrome()` 根据是否为原生构建，创建 wrapper 脚本并安装 Native Host manifest 到所有检测到的浏览器目录（`src/utils/claudeInChrome/setup.ts:91-171`）
- `shouldEnableClaudeInChrome()` 按优先级检查：CLI flag → 环境变量 `CLAUDE_CODE_ENABLE_CFC` → 全局配置（`src/utils/claudeInChrome/setup.ts:39-68`）
- `shouldAutoEnableClaudeInChrome()` 在交互式会话中，当扩展已安装且特性门控开启时自动启用

### 核心类型与接口

#### `BrowserConfig`

定义每种浏览器在三个平台上的数据路径、Native Messaging 路径和 Windows 注册表键（`src/utils/claudeInChrome/common.ts:20-37`）。

#### `ChromiumBrowser`

```typescript
type ChromiumBrowser = 'chrome' | 'brave' | 'arc' | 'chromium' | 'edge' | 'vivaldi' | 'opera'
```

#### 关键导出函数

| 函数 | 说明 |
|------|------|
| `sendChromeMessage(message)` | 向 stdout 写入 Chrome 原生消息（4 字节长度 + JSON） |
| `runChromeNativeHost()` | 启动 Native Host 主循环 |
| `runClaudeInChromeMcpServer()` | 启动 MCP 服务器子进程 |
| `setupClaudeInChrome()` | 配置 MCP 和 Native Host，返回 mcpConfig、allowedTools、systemPrompt |
| `detectAvailableBrowser()` | 按优先级检测已安装的浏览器 |
| `openInChrome(url)` | 在检测到的浏览器中打开 URL |
| `isChromeExtensionInstalled()` | 扫描所有浏览器 Profile 检测扩展是否安装 |

### 安全设计

- Socket 目录权限 `0o700`，socket 文件权限 `0o600`（`chromeNativeHost.ts:131-190`）
- 启动时清理属于已死亡进程的陈旧 socket 文件
- 分析事件只转发白名单中的字符串键（`bridge_status`、`error_type`、`tool_name`），避免泄露页面内容

### 系统提示词

`prompt.ts` 定义了注入到 Claude 系统提示词中的浏览器自动化指南，包括 GIF 录制、控制台调试、对话框规避、Tab 管理等最佳实践。

---

## 子系统二：deepLink/

### 功能概述

实现 `claude-cli://` 自定义协议，允许从浏览器链接或外部应用直接打开 Claude Code 会话，支持预填充 prompt、指定工作目录和 GitHub 仓库。

### 关键流程

#### 协议注册（启动时后台执行）

1. `ensureDeepLinkProtocolRegistered()` 检查特性门控和设置开关（`src/utils/deepLink/registerProtocol.ts:298-348`）
2. `resolveClaudePath()` 优先使用 `~/.local/bin/claude` 稳定符号链接
3. `isProtocolHandlerCurrent()` 直接读取 OS 注册产物（symlink/desktop file/registry）验证是否需要更新
4. 按平台注册：
   - **macOS**：在 `~/Applications/` 创建 `.app` trampoline，Info.plist 声明 URL scheme，CFBundleExecutable 是到 claude 二进制的符号链接
   - **Linux**：创建 `.desktop` 文件，通过 `xdg-mime` 注册
   - **Windows**：写入 `HKCU\Software\Classes\claude-cli` 注册表项

#### 链接处理流程

1. OS 调用 `claude --handle-uri <url>`，进入 `handleDeepLinkUri()`（`src/utils/deepLink/protocolHandler.ts:36-75`）
2. `parseDeepLink()` 解析 URI，提取 `q`（prompt）、`cwd`（工作目录）、`repo`（仓库 slug）参数
3. `resolveCwd()` 按优先级解析：显式 cwd → repo MRU 查找 → 用户主目录
4. `launchInTerminal()` 检测终端模拟器并启动 Claude

#### URI 解析安全

`parseDeepLink()` 实施多层防护（`src/utils/deepLink/parseDeepLink.ts:84-153`）：

- 拒绝 ASCII 控制字符（防命令注入）
- `repo` slug 严格匹配 `owner/repo` 格式（防路径遍历）
- `q` 参数最大 5000 字符，`cwd` 最大 4096 字符
- Unicode 隐藏字符清理（防 ASCII 走私/隐藏 prompt 注入）
- 不截断超长 query（截断会改变语义），直接拒绝

### 终端检测与启动

`terminalLauncher.ts` 支持三大平台的多种终端：

| 平台 | 支持的终端 | 启动方式 |
|------|-----------|---------|
| macOS | iTerm2, Ghostty, Kitty, Alacritty, WezTerm, Terminal.app | 纯 argv（Ghostty 等）或 AppleScript（iTerm/Terminal.app） |
| Linux | ghostty, kitty, alacritty, wezterm, gnome-terminal, konsole 等 10 种 | 全部纯 argv，`spawn({ detached: true })` |
| Windows | Windows Terminal, PowerShell, cmd.exe | wt.exe 纯 argv，PowerShell/cmd 为 shell-string |

安全关键点：纯 argv 路径中用户输入**不经过 shell 解释**，只有 AppleScript 和 PowerShell/cmd 路径需要 shell 转义。每种 shell 使用专用转义函数：`shellQuote`（POSIX 单引号）、`psQuote`（PowerShell 单引号）、`cmdQuote`（cmd.exe 双引号 + 去除 `"` + `%` 转义）（`src/utils/deepLink/terminalLauncher.ts:505-557`）。

### 深度链接 Banner

当会话由外部链接打开时，`buildDeepLinkBanner()` 生成安全警告横幅（`src/utils/deepLink/banner.ts:54-75`），提示用户审查预填充的 prompt。超过 1000 字符的 prompt 会特别提示"滚动查看完整内容"。同时显示工作目录和 CLAUDE.md 的 git fetch 时效。

### 终端偏好持久化

`updateDeepLinkTerminalPreference()` 在交互式会话中捕获 `TERM_PROGRAM` 环境变量并存储到全局配置，供后续无头 deep link 处理时使用（`src/utils/deepLink/terminalPreference.ts:38-54`）。仅在 macOS 上生效。

---

## 子系统三：nativeInstaller/

### 功能概述

管理 Claude Code 原生二进制的下载、安装、版本锁定和清理。支持从 GCS Bucket（外部用户）或 Artifactory NPM Registry（内部用户）获取二进制，并提供多包管理器检测以避免冲突。

### 目录结构

```
~/.local/share/claude/versions/  — 已安装版本（每个版本一个二进制文件）
~/.cache/claude/staging/          — 下载暂存区
~/.local/state/claude/locks/      — 版本锁文件
~/.local/bin/claude               — 指向当前版本的符号链接（或 Windows 下的副本）
```

### 关键流程

#### 版本下载

1. `getLatestVersion()` 查询最新版本号：内部用户走 Artifactory `npm view`，外部用户走 GCS `/{channel}` 端点（`src/utils/nativeInstaller/download.ts:112-149`）
2. `downloadVersion()` 下载二进制：
   - 内部用户：`downloadVersionFromArtifactory()` 创建临时 npm 项目，用 `package-lock.json` 中的 integrity hash 做完整性校验，`npm ci` 安装
   - 外部用户：`downloadVersionFromBinaryRepo()` 获取 manifest.json 取得 SHA-256 校验和，下载二进制并验证
3. 下载包含 stall 检测（60 秒无数据则中断）和最多 3 次重试（仅对 stall 超时重试）

#### 版本安装

`installLatest()` 是安装入口（`src/utils/nativeInstaller/installer.ts:956-1016`）：
1. 获取最新版本，与当前版本比较
2. 获取版本锁，下载到暂存区
3. 从暂存区原子移动到安装路径（先 copy 再 rename，避免跨文件系统 EXDEV 错误）
4. 更新符号链接指向新版本
5. 标记安装方式为 `native`，禁用旧版自动更新器
6. 后台清理旧版本（保留最近 2 个）

#### PID-Based 版本锁

`pidLock.ts` 实现了基于进程 PID 的版本锁定（`src/utils/nativeInstaller/pidLock.ts`），替代旧的 mtime 锁机制：

- 锁文件存储 JSON：`{ pid, version, execPath, acquiredAt }`
- `isLockActive()` 检查 PID 是否存活 + 验证是否为 Claude 进程（防 PID 重用）
- `acquireProcessLifetimeLock()` 持有锁直到进程退出，通过 `process.on('exit/SIGINT/SIGTERM')` 清理
- 回退超时 2 小时（远短于旧的 30 天），处理网络文件系统等边界情况
- 由 GrowthBook 特性门控控制灰度发布

### 包管理器检测

`packageManagers.ts` 检测 Claude Code 的安装来源（`src/utils/nativeInstaller/packageManagers.ts:302-336`）：

| 包管理器 | 检测方式 |
|---------|---------|
| homebrew | 检查 execPath 是否在 `/Caskroom/` 下 |
| winget | 检查 execPath 是否在 `WinGet\Packages` 下 |
| mise | 检查 execPath 是否在 `mise/installs` 下 |
| asdf | 检查 execPath 是否在 `asdf/installs` 下 |
| pacman | 在 Arch 系发行版上执行 `pacman -Qo` |
| deb | 在 Debian 系发行版上执行 `dpkg -S` |
| rpm | 在 Fedora/RHEL/SUSE 系上执行 `rpm -qf` |
| apk | 在 Alpine 上执行 `apk info --who-owns` |

检测前会读取 `/etc/os-release` 判断发行版家族，避免在不匹配的系统上执行无关命令（如 Ubuntu 上的 `pacman` 可能是游戏而非包管理器）。

### 公共 API

通过 `index.ts` 桶文件导出（`src/utils/nativeInstaller/index.ts`）：

| 函数 | 说明 |
|------|------|
| `installLatest(channelOrVersion, force?)` | 下载并安装最新版本 |
| `checkInstall(force?)` | 检查安装状态，返回诊断消息 |
| `lockCurrentVersion()` | 锁定当前运行版本防止被清理 |
| `cleanupOldVersions()` | 清理旧版本，保留最近 2 个 |
| `cleanupNpmInstallations()` | 清理旧的 npm 全局安装 |
| `cleanupShellAliases()` | 清理 shell 配置中的旧别名 |
| `removeInstalledSymlink()` | 移除安装的符号链接 |

---

## 子系统四：teleport/

### 功能概述

为 Claude Code 的远程会话（CCR - Claude Code Remote）提供 API 客户端、环境管理和 Git Bundle 传输能力。

### 关键流程

#### 远程会话管理

`api.ts` 封装了 Sessions API（`/v1/sessions`）的完整 CRUD 操作（`src/utils/teleport/api.ts`）：

- `prepareApiRequest()` 获取 OAuth token 和组织 UUID
- `fetchCodeSessionsFromSessionsAPI()` 列出所有会话，将 `SessionResource` 转换为 `CodeSession` 格式
- `fetchSession(sessionId)` 获取单个会话详情
- `sendEventToRemoteSession()` 向会话发送用户消息事件
- `updateSessionTitle()` 更新会话标题
- `getBranchFromSession()` 从会话的 git_repository outcome 中提取分支名

所有 GET 请求通过 `axiosGetWithRetry()` 自动重试瞬态网络错误（5xx、无响应），采用指数退避（2s/4s/8s/16s，共 4 次重试）。4xx 客户端错误不重试。

#### 环境选择

`environments.ts` 和 `environmentSelection.ts` 管理远程执行环境：

- `fetchEnvironments()` 调用 `/v1/environment_providers` 获取可用环境列表
- `createDefaultCloudEnvironment()` 为无环境的用户创建默认的 `anthropic_cloud` 环境
- `getEnvironmentSelectionInfo()` 综合可用环境和多层级设置，确定当前选中的环境及其配置来源

环境类型（`EnvironmentKind`）：`anthropic_cloud`（Anthropic 托管）、`byoc`（自带容器）、`bridge`（桥接）。选择逻辑优先使用设置中的 `remote.defaultEnvironmentId`，否则选第一个非 bridge 环境。

#### Git Bundle 传输

`gitBundle.ts` 实现将本地仓库打包为 Git Bundle 并上传到 Files API，用于远程会话的初始文件系统种子（`src/utils/teleport/gitBundle.ts:152-292`）：

1. 清理上次崩溃遗留的临时 ref（`refs/seed/stash`、`refs/seed/root`）
2. 检查仓库是否有提交（空仓库直接返回失败）
3. `git stash create` 捕获未提交的工作进度（WIP），存为 `refs/seed/stash`
4. 三级降级打包策略：
   - `--all`：打包所有 ref（包括 stash）→ 如果超过大小限制（默认 100MB，可通过特性门控调整）
   - `HEAD`：仅当前分支 → 如果仍然过大
   - `squashed-root`：压缩为单个无父提交（仅保留树快照，无历史）
5. 上传到 `/v1/files`，返回 `fileId` 供 `seed_bundle_file_id` 使用
6. `finally` 块清理临时 bundle 文件和 ref

### 核心类型

```typescript
type SessionResource = {
  id: string; title: string | null; session_status: SessionStatus;
  environment_id: string; session_context: SessionContext; ...
}

type SessionContext = {
  sources: SessionContextSource[];  // git_repository 或 knowledge_base
  cwd: string; outcomes: Outcome[] | null;
  seed_bundle_file_id?: string; github_pr?: {...}; ...
}

type BundleUploadResult =
  | { success: true; fileId: string; bundleSizeBytes: number; scope: 'all'|'head'|'squashed'; hasWip: boolean }
  | { success: false; error: string; failReason?: 'git_error'|'too_large'|'empty_repo' }
```

---

## 边界 Case 与注意事项

- **Chrome Native Host**：Windows 使用 Named Pipe 而非 Unix socket；Opera 使用 Roaming AppData 而非 Local；stale socket 清理通过检查 PID 存活性实现
- **Deep Link**：macOS 使用 `.app` trampoline + 符号链接避免额外签名；`__CFBundleIdentifier` 环境变量用于区分 URL scheme 启动和普通终端启动
- **Native Installer**：跨文件系统安装使用 copy + rename 替代 rename（EXDEV）；PID 锁验证进程命令行包含 "claude" 以防 PID 重用；mtime 锁和 PID 锁共存，通过特性门控灰度切换
- **Teleport**：Git bundle 打包有意排除 untracked 文件；squashed-root 降级模式丢失所有 git 历史；空仓库（无任何 ref）不创建 bundle
- **协议注册失败回退**：EACCES/ENOSPC 等确定性错误写入标记文件，24 小时内不重试