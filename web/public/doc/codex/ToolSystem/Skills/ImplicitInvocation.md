# 隐式技能调用检测（Implicit Invocation）

## 概述与职责

隐式技能调用检测模块位于 **ToolSystem → Skills** 层级下，是 `codex-core-skills` crate 的一部分。它的核心职责是：**当用户在 shell 中执行命令时，自动判断该命令是否间接触发了某个 skill**——即使用户没有显式提及该 skill 的名称。

该模块解决的问题场景是：用户可能通过 `python3 scripts/fetch_comments.py` 执行了某个 skill 目录下的脚本，或通过 `cat SKILL.md` 阅读了某个 skill 的文档文件。这些操作虽然没有直接调用 skill，但在语义上属于对该 skill 的使用，系统需要识别并关联到对应的 `SkillMetadata`。

源码位于 `codex-rs/core-skills/src/invocation_utils.rs`，测试位于 `codex-rs/core-skills/src/invocation_utils_tests.rs`。

## 关键流程

### 整体检测流程

入口函数 `detect_implicit_skill_invocation_for_command()` 接收三个参数：已加载的技能信息 `SkillLoadOutcome`、原始命令字符串、以及当前工作目录。流程如下：

1. **路径规范化**：将工作目录通过 `normalize_path()` 转为绝对路径（`codex-rs/core-skills/src/invocation_utils.rs:34`）
2. **命令分词**：使用 `shlex::split()` 对命令进行 POSIX shell 词法分析；若分词失败则回退到简单的空白分割（`invocation_utils.rs:45-48`）
3. **脚本执行检测**：优先检查命令是否是「脚本运行器 + skill 目录下的脚本文件」模式
4. **文档读取检测**：若脚本检测未命中，再检查命令是否是「文件阅读器 + SKILL.md 路径」模式

```
命令字符串 → shlex 分词 → 尝试脚本执行检测 → 尝试文档读取检测 → Option<SkillMetadata>
```

### 脚本执行检测（detect_skill_script_run）

判断逻辑分两步：

**第一步：识别脚本运行 token**（`script_run_token()`，`invocation_utils.rs:50-80`）

- 检查第一个 token 的 basename（去除路径前缀和 `.exe` 后缀）是否属于已知的脚本运行器列表：
  `python`, `python3`, `bash`, `zsh`, `sh`, `node`, `deno`, `ruby`, `perl`, `pwsh`
- 跳过以 `-` 开头的 flag 参数和 `--` 分隔符
- 找到第一个非 flag 参数后，检查其扩展名是否属于：`.py`, `.sh`, `.js`, `.ts`, `.rb`, `.pl`, `.ps1`

**第二步：路径匹配**（`detect_skill_script_run()`，`invocation_utils.rs:82-103`）

- 将脚本路径解析为绝对路径（相对路径基于 workdir 拼接）
- 从脚本路径开始，**逐级向上遍历祖先目录**，在 `implicit_skills_by_scripts_dir` 索引中查找匹配
- 这意味着 `scripts/sub/deep/file.py` 也能匹配到注册在 `scripts/` 目录的 skill

### 文档读取检测（detect_skill_doc_read）

判断逻辑（`invocation_utils.rs:105-130`）：

1. 检查第一个 token 的 basename 是否属于文件阅读器列表：
   `cat`, `sed`, `head`, `tail`, `less`, `more`, `bat`, `awk`
2. 遍历命令中所有非 flag 参数，将每个 token 解析为绝对路径
3. 在 `implicit_skills_by_doc_path` 索引中查找是否有匹配的 SKILL.md 路径

## 函数签名与参数说明

### `build_implicit_skill_path_indexes(skills: Vec<SkillMetadata>) -> (HashMap<PathBuf, SkillMetadata>, HashMap<PathBuf, SkillMetadata>)`

构建两个路径索引，返回一个元组：

- **第一个 HashMap**（`by_scripts_dir`）：key 是 skill 目录下 `scripts/` 子目录的规范化路径，value 是对应的 `SkillMetadata`
- **第二个 HashMap**（`by_skill_doc_path`）：key 是 `SKILL.md` 文件的规范化路径，value 是对应的 `SkillMetadata`

这两个索引被存储在 `SkillLoadOutcome` 的 `implicit_skills_by_scripts_dir` 和 `implicit_skills_by_doc_path` 字段中。

> 源码位置：`invocation_utils.rs:8-27`

### `detect_implicit_skill_invocation_for_command(outcome: &SkillLoadOutcome, command: &str, workdir: &Path) -> Option<SkillMetadata>`

主入口函数，检测一条 shell 命令是否隐式触发了某个 skill。

| 参数 | 类型 | 说明 |
|------|------|------|
| `outcome` | `&SkillLoadOutcome` | 已加载的技能结果，包含路径索引 |
| `command` | `&str` | 原始 shell 命令字符串 |
| `workdir` | `&Path` | 命令的工作目录，用于解析相对路径 |

返回 `Some(SkillMetadata)` 表示命中了某个 skill，`None` 表示未检测到隐式调用。

> 源码位置：`invocation_utils.rs:29-43`

## 内部辅助函数

| 函数 | 职责 |
|------|------|
| `tokenize_command(command: &str) -> Vec<String>` | 使用 shlex 进行 POSIX shell 分词，失败时回退到空白分割 |
| `script_run_token(tokens: &[String]) -> Option<&str>` | 从分词结果中提取脚本路径 token（需同时满足运行器和扩展名条件） |
| `command_reads_file(tokens: &[String]) -> bool` | 判断命令的首个 token 是否为已知的文件阅读器 |
| `command_basename(command: &str) -> String` | 提取路径的文件名部分（如 `/usr/bin/python3` → `python3`） |
| `normalize_path(path: &Path) -> PathBuf` | 尝试 `std::fs::canonicalize()`，失败时返回原始路径 |

## 接口/类型依赖

该模块依赖两个核心类型（定义在 `codex-rs/core-skills/src/model.rs`）：

- **`SkillMetadata`**：技能元数据，包含 `name`、`description`、`path_to_skills_md`（SKILL.md 路径）、`scope` 等字段
- **`SkillLoadOutcome`**：技能加载结果，持有两个 `Arc<HashMap<PathBuf, SkillMetadata>>` 索引字段供本模块查询

## 边界 Case 与注意事项

- **shlex 分词失败回退**：当命令包含未闭合引号等非法 shell 语法时，`shlex::split()` 返回 `None`，模块会回退到简单的空白分割，确保不会因为分词失败而完全丢失检测能力
- **Windows 兼容**：`script_run_token()` 会去除运行器名称的 `.exe` 后缀，因此 `python3.exe` 也能被正确识别
- **flag 跳过逻辑**：在识别脚本路径时，会跳过所有 `-` 开头的参数和 `--` 分隔符。但这也意味着 `python3 -c "print(1)"` 中的 `"print(1)"` 因为没有脚本扩展名而不会被误判
- **路径规范化**：所有路径比较前都会通过 `std::fs::canonicalize()` 规范化，解析符号链接和 `..` 组件。如果文件不存在（canonicalize 失败），则使用原始路径——这在测试环境中是常见情况
- **祖先目录遍历**：脚本检测不要求脚本直接位于 `scripts/` 目录下，子目录中的脚本也会被匹配（通过 `script_path.ancestors()` 逐级向上查找）
- **优先级**：脚本执行检测优先于文档读取检测。如果一条命令同时满足两种模式，只会返回脚本执行的匹配结果