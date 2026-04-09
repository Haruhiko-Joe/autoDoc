# PythonRuntime（codex-cli-bin）

## 概述与职责

`codex-cli-bin` 是一个 **wheel-only** 的 Python 分发包，用于将平台特定的 Codex CLI 二进制文件捆绑到 Python 生态中。它是 SDKs 层的一部分——Python SDK（`codex-app-server-sdk`）将其作为 pinned 依赖引用，从而确保 SDK 使用者无需手动安装或管理 Codex CLI 二进制文件。

在整体架构中，SDKs 模块通过 AppServer 的 WebSocket/HTTP API 与 Codex 核心交互，而 `codex-cli-bin` 则负责将底层 Rust 编译的 CLI 二进制以 Python wheel 的形式分发给 Python SDK 使用者。它的同级模块包括 TypeScript SDK（`@openai/codex-sdk`）和 npm CLI 包装器（`@openai/codex`）。

该包的设计非常精简，只包含两个核心职责：
1. **提供二进制定位函数** `bundled_codex_path()`，让 Python SDK 能找到嵌入的 Codex 可执行文件
2. **自定义 Hatch 构建钩子**，确保只能构建 wheel（禁止 sdist），并为 wheel 打上平台特定标签

## 关键流程

### 二进制定位流程

当 Python SDK 需要启动 Codex CLI 进程时，调用 `bundled_codex_path()` 获取二进制路径：

1. 根据操作系统判断可执行文件名——Windows 上为 `codex.exe`，其他平台为 `codex`（`src/codex_cli_bin/__init__.py:10`）
2. 基于当前模块文件的位置，拼接出 `<package_dir>/bin/<exe>` 的绝对路径（`src/codex_cli_bin/__init__.py:11`）
3. 检查该路径是否存在：若不存在则抛出 `FileNotFoundError`，附带明确的错误信息说明包已安装但二进制缺失（`src/codex_cli_bin/__init__.py:12-15`）
4. 返回二进制文件的 `Path` 对象

### 构建流程（Hatch Build Hook）

自定义构建钩子 `RuntimeBuildHook` 在 Hatch 构建初始化阶段介入：

1. 检查当前构建目标是否为 `sdist`——如果是，直接抛出 `RuntimeError` 阻止构建（`hatch_build.py:9-12`）
2. 对于 wheel 构建，设置 `build_data["pure_python"] = False`，标记这不是纯 Python 包（`hatch_build.py:14`）
3. 设置 `build_data["infer_tag"] = True`，让 Hatch 根据构建环境自动推断平台标签（如 `manylinux_x86_64`、`macosx_arm64` 等）（`hatch_build.py:15`）

这确保了每个 wheel 只包含对应平台的二进制，不同平台的用户通过 pip 安装时会自动获取匹配的 wheel。

## 函数签名与参数说明

### `bundled_codex_path() -> Path`

返回捆绑的 Codex CLI 二进制文件的绝对路径。

- **参数**：无
- **返回值**：`pathlib.Path`——指向 `<package>/bin/codex`（或 Windows 上的 `codex.exe`）
- **异常**：`FileNotFoundError`——当包已安装但二进制文件缺失时抛出

> 源码位置：`src/codex_cli_bin/__init__.py:9-16`

### `RuntimeBuildHook.initialize(version: str, build_data: dict[str, object]) -> None`

Hatch 构建钩子的初始化方法，在构建过程开始时被 Hatchling 调用。

- **version**：构建版本字符串（未使用，被显式 `del`）
- **build_data**：Hatch 构建元数据字典，钩子通过修改它来影响构建行为
- **异常**：`RuntimeError`——当构建目标为 sdist 时抛出

> 源码位置：`hatch_build.py:7-15`

## 接口/类型定义

### 模块导出

`__init__.py` 通过 `__all__` 导出两个符号：

| 名称 | 类型 | 说明 |
|------|------|------|
| `PACKAGE_NAME` | `str` | 包名常量，值为 `"codex-cli-bin"` |
| `bundled_codex_path` | `() -> Path` | 二进制定位函数 |

### `RuntimeBuildHook`

继承自 `hatchling.builders.hooks.plugin.interface.BuildHookInterface`，是 Hatch 构建系统的标准插件接口。通过 `pyproject.toml` 中的 `[tool.hatch.build.targets.wheel.hooks.custom]` 和 `[tool.hatch.build.targets.sdist.hooks.custom]` 配置项注册。

## 配置项与默认值

### pyproject.toml 关键配置

| 配置项 | 值 | 说明 |
|--------|----|------|
| `build-system.requires` | `hatchling>=1.24.0` | 构建后端依赖 |
| `project.name` | `codex-cli-bin` | 包名 |
| `project.version` | `0.0.0-dev` | 开发版本号，发布时由 CI 覆盖 |
| `project.requires-python` | `>=3.10` | 最低 Python 版本 |
| `project.license` | `Apache-2.0` | 开源许可 |
| `tool.hatch.build.targets.wheel.packages` | `["src/codex_cli_bin"]` | wheel 打包的 Python 包路径 |
| `tool.hatch.build.targets.wheel.include` | `["src/codex_cli_bin/bin/**"]` | 额外包含的二进制文件目录 |

## 边界 Case 与注意事项

- **wheel-only 设计**：该包故意禁止构建 sdist。原因是二进制文件是平台特定的，sdist 无法正确表达这一约束。尝试 `python -m build --sdist` 会得到明确的 `RuntimeError` 提示。

- **二进制文件不在仓库中**：`src/codex_cli_bin/bin/` 目录下的二进制文件在发布流程中由 CI 放入，不会提交到 Git 仓库。开发环境中直接调用 `bundled_codex_path()` 会抛出 `FileNotFoundError`。

- **版本号 `0.0.0-dev`**：`pyproject.toml` 中的版本号是占位值，实际发布时由 CI/CD 流水线注入真实版本。Python SDK 通过 pinned dependency 确保 CLI 版本与 SDK 版本对齐。

- **平台标签推断**：`infer_tag = True` 让 Hatch 根据当前构建机器的 OS/架构自动生成 wheel 文件名中的平台标签，因此必须在目标平台上（或对应的交叉编译环境中）构建 wheel。

- **Windows 兼容**：`bundled_codex_path()` 通过 `os.name == "nt"` 检查来适配 Windows 平台的 `.exe` 后缀，确保跨平台可用。