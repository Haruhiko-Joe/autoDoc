# NpmCLIWrapper（@openai/codex npm 包）

## 概述与职责

`@openai/codex` 是 Codex CLI 通过 npm/bun 分发的主入口包。它**不包含**实际的 Rust 二进制文件，而是一个轻量级的启动器和分发包装层，由以下几部分组成：

1. **Node.js 启动脚本** (`bin/codex.js`)：检测宿主平台和架构，解析正确的平台特定可选依赖包，找到其中的原生 Rust 二进制文件并 spawn 执行，同时处理信号转发和退出码传播。
2. **构建/打包脚本** (`scripts/build_npm_package.py`)：将平台包的 staging、原生二进制文件打包、npm tarball 生成整合为一个自动化流程。
3. **原生依赖安装脚本** (`scripts/install_native_deps.py`)：从 GitHub Actions 工件下载 Codex 和 ripgrep 预编译二进制，填充 `vendor/` 目录。
4. **Docker 容器化** (`Dockerfile` 及辅助脚本)：提供容器化运行环境，内置网络防火墙隔离。

在系统架构中，本模块属于 **SDKs** 层，与 CLI 模块是 `composes` 关系——它包装并分发 Rust 编写的 `codex` 二进制。同层级的兄弟模块包括 TypeScript SDK (`@openai/codex-sdk`) 和 Python SDK。

## 关键流程

### 启动器二进制解析与执行流程（bin/codex.js）

这是用户执行 `codex` 命令时的完整调用链：

1. **平台检测**：读取 `process.platform` 和 `process.arch`，映射为 Rust target triple（如 `aarch64-apple-darwin`）。支持 6 个目标平台：linux x64/arm64、darwin x64/arm64、win32 x64/arm64。Android 被映射到 linux target (`bin/codex.js:27-67`)

2. **包名解析**：通过 `PLATFORM_PACKAGE_BY_TARGET` 映射表将 target triple 转换为对应的 npm 包名（如 `@openai/codex-darwin-arm64`）(`bin/codex.js:15-22`)

3. **二进制定位**（三级回退）：
   - **首选**：通过 `require.resolve()` 查找已安装的平台特定 npm 包，从其 `vendor/` 目录获取二进制 (`bin/codex.js:88-90`)
   - **回退**：检查本地 `vendor/` 目录下是否有直接放置的二进制（开发/手动安装场景）(`bin/codex.js:92`)
   - **失败**：抛出错误并根据检测到的包管理器（npm/bun）给出重装提示 (`bin/codex.js:95-103`)

4. **PATH 扩展**：如果 `vendor/<target>/path/` 目录存在（内含 `rg` 等工具），将其添加到 `PATH` 环境变量前部 (`bin/codex.js:161-166`)

5. **环境变量注入**：根据检测到的包管理器设置 `CODEX_MANAGED_BY_NPM` 或 `CODEX_MANAGED_BY_BUN` 环境变量 (`bin/codex.js:169-173`)

6. **异步 spawn 执行**：使用 `child_process.spawn`（非 `spawnSync`）启动原生二进制，`stdio: "inherit"` 直接透传标准流 (`bin/codex.js:175-178`)

7. **信号转发**：监听 `SIGINT`、`SIGTERM`、`SIGHUP`，转发给子进程实现优雅关闭 (`bin/codex.js:193-206`)

8. **退出码传播**：子进程退出时，如果是信号终止则用 `process.kill(process.pid, signal)` 重新发送信号（产生 128+N 退出码）；如果是正常退出则传播退出码 (`bin/codex.js:213-229`)

### 包管理器检测流程

`detectPackageManager()` 函数通过三种启发式方法判断用户使用的包管理器 (`bin/codex.js:140-159`)：

1. 检查 `npm_config_user_agent` 环境变量是否包含 `bun/`
2. 检查 `npm_execpath` 环境变量是否包含 `bun`
3. 检查 `__dirname` 路径是否在 `.bun/install/global` 下
4. 以上均不匹配时，如果有 `npm_config_user_agent` 返回 `"npm"`，否则返回 `null`

### npm 包构建与发布流程（build_npm_package.py）

构建脚本 `build_npm_package.py` 支持 staging 多种包类型：

1. **解析参数**：`--package`（codex/平台包/codex-sdk 等）、`--version`、`--vendor-src`、`--pack-output` 等 (`scripts/build_npm_package.py:98-140`)

2. **源文件 staging**（`stage_sources` 函数）：
   - **codex 主包**：复制 `bin/codex.js`、`bin/rg` manifest、根 README；生成 `optionalDependencies` 指向各平台包的带 tag 版本号 (`scripts/build_npm_package.py:240-313`)
   - **平台包**（如 `codex-darwin-arm64`）：生成带 `os`/`cpu` 字段约束的 package.json，版本号附加平台后缀（如 `0.6.0-darwin-arm64`）(`scripts/build_npm_package.py:253-278`)
   - **codex-sdk**：执行 `pnpm install` + `pnpm run build`，复制 `dist/` 产物 (`scripts/build_npm_package.py:342-361`)

3. **原生二进制复制**（`copy_native_binaries` 函数）：从 `--vendor-src` 指定的预编译目录，按 target triple 和组件类型复制到 staging 目录的 `vendor/` 下 (`scripts/build_npm_package.py:363-415`)

4. **npm pack**：在 staging 目录执行 `npm pack --json` 生成 tarball (`scripts/build_npm_package.py:418-447`)

### 原生依赖安装流程（install_native_deps.py）

该脚本用于开发环境和 CI 中获取预编译的原生二进制：

1. **下载 CI 工件**：调用 `gh run download` 从 GitHub Actions 指定 workflow run 下载所有平台的编译产物 (`scripts/install_native_deps.py:262-273`)

2. **安装二进制组件**：对每个组件（codex、codex-windows-sandbox-setup、codex-command-runner），解压 `.zst` 格式的压缩包到 `vendor/<target>/<dest_dir>/` (`scripts/install_native_deps.py:276-331`)

3. **获取 ripgrep**：读取 `bin/rg` DotSlash manifest 获取各平台的 ripgrep 下载 URL，并行下载、解压（支持 tar.gz/zip/zst 格式）到 `vendor/<target>/path/` (`scripts/install_native_deps.py:194-259`)

## 函数签名与参数说明

### bin/codex.js（启动器）

启动器是一个顶层 ESM 脚本，无导出函数。关键内部函数：

#### `getUpdatedPath(newDirs: string[]): string`

将新目录列表添加到 PATH 环境变量前部，使用平台对应的路径分隔符。

> 源码位置：`codex-cli/bin/codex.js:126-134`

#### `detectPackageManager(): "npm" | "bun" | null`

检测安装 Codex 的包管理器，用于错误提示和环境变量设置。

> 源码位置：`codex-cli/bin/codex.js:140-159`

### build_npm_package.py

#### `main() -> int`

入口函数。解析参数，执行 staging + 可选的 pack。

命令行参数：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `--package` | str | 否 | 要构建的包名，默认 `codex`。可选值：codex、各平台包名、codex-responses-api-proxy、codex-sdk |
| `--version` | str | 是* | 写入 package.json 的版本号 |
| `--release-version` | str | 是* | 用于正式发布的版本号（与 `--version` 二选一） |
| `--staging-dir` | Path | 否 | staging 目录，默认创建临时目录 |
| `--vendor-src` | Path | 条件 | 预编译二进制所在目录，平台包必需 |
| `--pack-output` | Path | 否 | 输出 tarball 路径 |

> 源码位置：`codex-cli/scripts/build_npm_package.py:143-221`

#### `compute_platform_package_version(version: str, platform_tag: str) -> str`

生成平台包的唯一版本号：`{version}-{platform_tag}`。这是因为 npm 不允许相同包名+版本号重复发布，而所有平台包共享 `@openai/codex` 包名。

> 源码位置：`codex-cli/scripts/build_npm_package.py:331-334`

### install_native_deps.py

#### `main() -> int`

入口函数。默认安装 codex + codex-windows-sandbox-setup + codex-command-runner + rg 组件。

命令行参数：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `--workflow-url` | str | 否 | GitHub Actions workflow URL，默认使用硬编码的已知稳定 run |
| `--component` | str | 否 | 可重复指定，限制安装的组件（codex/rg/codex-windows-sandbox-setup/codex-command-runner） |
| `root` | Path | 否 | package.json 所在目录，默认使用仓库 checkout |

> 源码位置：`codex-cli/scripts/install_native_deps.py:154-191`

#### `extract_archive(archive_path, archive_format, archive_member, dest)`

通用解压函数，支持 `zst`（通过 `zstd` CLI）、`tar.gz`、`zip` 三种格式。

> 源码位置：`codex-cli/scripts/install_native_deps.py:409-453`

## 接口/类型定义

### 平台包映射（PLATFORM_PACKAGE_BY_TARGET）

启动器中定义的 target triple 到 npm 包名的映射：

| Target Triple | npm 包名 |
|---------------|----------|
| `x86_64-unknown-linux-musl` | `@openai/codex-linux-x64` |
| `aarch64-unknown-linux-musl` | `@openai/codex-linux-arm64` |
| `x86_64-apple-darwin` | `@openai/codex-darwin-x64` |
| `aarch64-apple-darwin` | `@openai/codex-darwin-arm64` |
| `x86_64-pc-windows-msvc` | `@openai/codex-win32-x64` |
| `aarch64-pc-windows-msvc` | `@openai/codex-win32-arm64` |

> 源码位置：`codex-cli/bin/codex.js:15-22`

### 原生组件与目标目录映射（COMPONENT_DEST_DIR）

构建脚本中定义的组件在 vendor 目录下的安装位置：

| 组件 | 目标子目录 | 说明 |
|------|-----------|------|
| `codex` | `codex/` | 主 CLI 二进制 |
| `codex-responses-api-proxy` | `codex-responses-api-proxy/` | Responses API 代理 |
| `codex-windows-sandbox-setup` | `codex/` | Windows 沙箱配置工具（仅 Windows） |
| `codex-command-runner` | `codex/` | Windows 命令运行器（仅 Windows） |
| `rg` | `path/` | ripgrep 搜索工具 |

> 源码位置：`codex-cli/scripts/build_npm_package.py:89-95`

### BinaryComponent（数据类）

`install_native_deps.py` 中定义的原生二进制组件描述：

```python
@dataclass(frozen=True)
class BinaryComponent:
    artifact_prefix: str     # CI 工件文件名前缀
    dest_dir: str            # vendor/<target>/ 下的安装子目录
    binary_basename: str     # 可执行文件名（不含 .exe 后缀）
    targets: tuple[str, ...] | None = None  # 限制安装到特定 target
```

> 源码位置：`codex-cli/scripts/install_native_deps.py:36-41`

## 配置项与默认值

### package.json

| 字段 | 值 | 说明 |
|------|-----|------|
| `name` | `@openai/codex` | npm 包名 |
| `bin.codex` | `bin/codex.js` | 注册的全局命令 |
| `type` | `module` | ESM 模块 |
| `engines.node` | `>=16` | 最低 Node.js 版本要求 |
| `files` | `["bin", "vendor"]` | 发布时包含的文件 |
| `license` | `Apache-2.0` | 开源许可证 |

> 源码位置：`codex-cli/package.json`

### 环境变量

| 环境变量 | 设置者 | 说明 |
|----------|--------|------|
| `CODEX_MANAGED_BY_NPM` | 启动器 | 设为 `"1"` 表示通过 npm 安装 |
| `CODEX_MANAGED_BY_BUN` | 启动器 | 设为 `"1"` 表示通过 bun 安装 |
| `CODEX_UNSAFE_ALLOW_NO_SANDBOX` | Dockerfile | 容器内设为 `1`，跳过沙箱检查 |
| `OPENAI_ALLOWED_DOMAINS` | run_in_container.sh | 防火墙白名单域名，默认 `api.openai.com` |

### ripgrep DotSlash Manifest（bin/rg）

使用 DotSlash 格式声明各平台 ripgrep 15.1.0 的下载来源、SHA256 摘要和解压路径。`install_native_deps.py` 通过 `dotslash -- parse` 命令解析此 manifest。

> 源码位置：`codex-cli/bin/rg`

## Docker 容器化运行

### 镜像构建（Dockerfile）

基于 `node:24-slim`，安装开发工具集（git、curl、gh、ripgrep、iptables 等），以非 root 用户 (`node`) 运行。构建流程：

1. 将预打包的 `dist/codex.tgz` 复制进容器并全局安装
2. 设置 `CODEX_UNSAFE_ALLOW_NO_SANDBOX=1` 跳过沙箱（容器本身即隔离）
3. 复制防火墙初始化脚本

> 源码位置：`codex-cli/Dockerfile`

### 容器运行脚本（run_in_container.sh）

完整的容器化工作流：

1. 启动容器，挂载工作目录到 `/app` 下对应路径
2. 写入允许访问的域名列表到 `/etc/codex/allowed_domains.txt`（含域名格式校验）
3. 以 root 身份执行 `init_firewall.sh` 配置 iptables 规则
4. 删除防火墙脚本（防止后续篡改）
5. 以 `codex --full-auto` 模式执行用户命令

> 源码位置：`codex-cli/scripts/run_in_container.sh`

### 防火墙规则（init_firewall.sh）

使用 iptables + ipset 实现严格的网络隔离：

- 默认策略 `DROP`（INPUT/OUTPUT/FORWARD）
- 允许 DNS（UDP 53）、localhost、同网段通信
- 仅允许白名单域名（通过 DNS 解析为 IP 后加入 ipset）的出站流量
- 自检：验证 `example.com` 不可达且 `api.openai.com` 可达

> 源码位置：`codex-cli/scripts/init_firewall.sh`

## 边界 Case 与注意事项

- **平台包版本号策略**：所有平台包共享 `@openai/codex` 包名，通过版本号后缀（如 `0.6.0-darwin-arm64`）区分。这是因为 npm 不允许同名同版本重复发布。主包通过 `optionalDependencies` 引用各平台版本，npm 会根据 `os`/`cpu` 字段只安装当前平台的包。

- **二进制查找的回退机制**：启动器先尝试通过 npm 包解析找二进制，失败后检查本地 `vendor/` 目录。这支持了开发场景下直接将二进制放在本地 vendor 目录的用法。

- **Android 映射为 Linux**：`process.platform === "android"` 会被映射到 linux 的 target triple (`bin/codex.js:29`)，这意味着 Codex 可以在 Termux 等 Android 终端环境中运行。

- **Windows 额外组件**：Windows 平台包除了 codex 和 rg 外，还包含 `codex-windows-sandbox-setup` 和 `codex-command-runner` 两个额外二进制 (`scripts/build_npm_package.py:76-77`)。

- **异步 spawn 而非 spawnSync**：启动器刻意使用异步 spawn，这样 Node.js 事件循环可以响应信号并转发给子进程，确保 Ctrl-C 等操作能正确传播 (`bin/codex.js:120-124`)。

- **容器防火墙删除后不可恢复**：`run_in_container.sh` 在执行防火墙脚本后立即删除它 (`scripts/run_in_container.sh:86`)，防止容器内进程修改防火墙规则。