# UpdateChecker — 版本更新检查与安装器

## 概述与职责

UpdateChecker 模块（`src/cli/update.ts`）实现了 `claude update` 命令的完整逻辑。它属于 **CLITransport** 层，是用户触发版本升级的唯一入口。该模块负责：

1. 检测当前版本与远端最新版本的差异
2. 诊断当前安装方式并发出潜在问题警告
3. 根据安装方式选择正确的更新策略并执行更新
4. 更新完成后重建补全缓存

在 CLITransport 的兄弟模块中，它与命令处理器（handlers/）、输出格式化等并列，专注于版本生命周期管理。

## 关键流程

### 完整更新流程 Walkthrough

`update()` 函数是模块唯一的导出，整个更新过程按以下顺序串行执行：

**第一步：初始化与通道确定**（`src/cli/update.ts:30-36`）

- 发送 `tengu_update_check` 分析事件
- 输出当前版本号（`MACRO.VERSION`，编译时注入的宏）
- 从用户设置中读取更新通道（`autoUpdatesChannel`），默认为 `latest`

**第二步：安装诊断**（`src/cli/update.ts:40-74`）

- 调用 `getDoctorDiagnostic()` 获取安装环境诊断信息，返回包含安装类型、配置方法、多重安装检测和警告列表的诊断对象
- 如果检测到多个安装实例（如同时存在 npm 全局和本地安装），逐一列出并标注当前正在运行的实例
- 遍历所有警告（如 PATH 指向问题），输出问题描述和修复建议

**第三步：配置同步**（`src/cli/update.ts:76-106`）

- 如果全局配置中尚未记录 `installMethod`，且安装类型不是包管理器，则自动检测并写入配置
- 安装类型映射关系：`npm-local` → `local`，`native` → `native`，`npm-global` → `global`，其余 → `unknown`

**第四步：特殊安装类型快速退出**

- **开发构建**（`src/cli/update.ts:109-115`）：直接输出警告并以退出码 1 终止
- **包管理器**（`src/cli/update.ts:118-166`）：根据具体包管理器类型（homebrew / winget / apk / 其他）给出对应的手动更新命令。对于 `pacman`、`deb`、`rpm` 等存在多个前端的包管理器，仅提示"请使用你的包管理器更新"

**第五步：配置与实际安装方式的一致性校验**（`src/cli/update.ts:168-211`）

- 将运行时检测到的安装类型与配置文件中记录的进行对比
- 如果不一致（如配置记录为 `native` 但实际运行的是 `npm-global`），输出警告并自动修正配置以匹配当前实际状态

**第六步：原生安装器更新路径**（`src/cli/update.ts:213-258`）

- 如果检测到 `native` 安装类型，调用 `installLatestNative(channel, true)` 执行更新
- 处理锁竞争（`lockFailed`）：如果另一个 Claude 进程正在运行，提示稍后重试
- 更新成功后调用 `regenerateCompletionCache()` 重建 shell 补全缓存

**第七步：npm 更新路径（回退逻辑）**（`src/cli/update.ts:260-422`）

这是非原生安装的主更新路径：

1. 如果用户未迁移到原生安装，先清理原生安装器的符号链接（`removeInstalledSymlink()`）
2. 通过 `getLatestVersion(channel)` 从 npm registry 获取最新版本号
3. 如果获取失败，输出详细的故障排查指南（网络、代理、npm 登录等）
4. 版本相同则提示已是最新
5. 根据 `diagnostic.installationType` 决定更新方法：
   - `npm-local`：调用 `installOrUpdateClaudePackage(channel)`
   - `npm-global`：调用 `installGlobalPackage()`
   - `unknown`：通过 `localInstallationExists()` 探测后回退选择
6. 根据安装结果（`InstallStatus`）输出对应信息

## 函数签名

### `update(): Promise<void>`

模块唯一的导出函数，执行完整的版本检查与更新流程。该函数不接受参数，所有配置通过设置系统和诊断系统获取。函数内部通过 `gracefulShutdown()` 终止进程，不会正常返回。

> 源码位置：`src/cli/update.ts:30-422`

## 接口/类型定义

本模块不定义自己的类型，但依赖以下外部类型：

| 类型 | 来源 | 用途 |
|------|------|------|
| `InstallStatus` | `src/utils/autoUpdater.js` | npm 安装结果枚举：`success` / `no_permissions` / `install_failed` / `in_progress` |
| `InstallMethod` | `src/utils/config.js` | 安装方式标识：`local` / `native` / `global` / `unknown` |

## 配置项与默认值

| 配置项 | 来源 | 默认值 | 说明 |
|--------|------|--------|------|
| `autoUpdatesChannel` | 用户设置（`getInitialSettings()`） | `'latest'` | 更新通道，支持 `latest`、`beta`、`stable` |
| `installMethod` | 全局配置（`getGlobalConfig()`） | 无（首次运行时自动检测写入） | 记录安装方式，用于选择更新策略 |
| `MACRO.VERSION` | 编译时宏 | — | 当前构建版本号 |
| `MACRO.PACKAGE_URL` | 编译时宏 | — | npm 包名/URL，用于 registry 查询 |

## 安装类型与更新策略映射

模块的核心设计是根据安装方式分流到不同的更新策略：

| 安装类型（`diagnostic.installationType`） | 更新策略 | 处理方式 |
|---|---|---|
| `native` | 原生安装器 | 调用 `installLatestNative()`，支持锁竞争检测 |
| `npm-local` | npm 本地安装 | 调用 `installOrUpdateClaudePackage()` |
| `npm-global` | npm 全局安装 | 调用 `installGlobalPackage()` |
| `package-manager` | 包管理器（homebrew/winget/apk等） | 仅提示手动更新命令，不自动执行 |
| `development` | 开发构建 | 拒绝更新，退出码 1 |
| `unknown` | 探测回退 | 通过 `localInstallationExists()` 判断后选择 local 或 global |

## InstallStatus 结果处理

npm 更新路径的最终结果通过 `InstallStatus` 枚举处理（`src/cli/update.ts:373-420`）：

| 状态 | 行为 |
|------|------|
| `success` | 输出成功信息，重建补全缓存 |
| `no_permissions` | 提示权限不足，给出手动更新命令或建议切换到原生安装 |
| `install_failed` | 提示安装失败，给出手动更新命令 |
| `in_progress` | 提示另一个实例正在更新，建议稍后重试 |

## 边界 Case 与注意事项

- **npm 通道映射**：当 `channel` 为 `stable` 时，npm tag 使用 `stable`；其他情况（包括 `latest` 和 `beta`）统一使用 `latest` tag（`src/cli/update.ts:269`）
- **多安装实例冲突**：诊断阶段会检测并警告多重安装，但不会阻止更新——只更新当前运行的那个实例
- **配置自动修正**：当配置记录的安装方式与实际不符时，模块会静默修正配置以匹配现实，而非按配置记录执行（"信任现实"原则）
- **锁竞争**：仅原生安装器路径处理了锁竞争（`lockFailed`），npm 路径通过 `in_progress` 状态处理类似场景
- **包管理器不自动更新**：homebrew、winget、apk 等包管理器安装的版本，模块只做版本检查和提示，不会自动执行更新，避免与包管理器的状态管理冲突
- **`gracefulShutdown` 作为流程控制**：函数通过 `gracefulShutdown(exitCode)` 终止进程而非 return，所有分支最终都走这条路径