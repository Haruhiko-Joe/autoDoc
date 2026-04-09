# SystemSkills — 内嵌系统技能安装器

## 概述与职责

`codex-skills` 是 Codex 工具系统（ToolSystem）中的一个 Rust crate，负责将内置的 Skill 定义（如 skill-creator、imagegen 等）在**编译时嵌入二进制文件**，并在**运行时按需安装**到磁盘上的 `CODEX_HOME/skills/.system` 目录。它使用基于指纹（fingerprint）的缓存机制，避免每次启动时重复写入未变更的文件。

在整体架构中，该模块属于 **ToolSystem** 层级。上游调用方是 `codex-core-skills` crate 中的 `SkillsManager`，后者在初始化时根据配置决定是安装还是卸载系统技能。

**同级模块**包括 MCP 工具桥接、内置工具（shell exec、apply-patch、file-search 等）、技能加载器、以及工具审批/建议管线。

## 关键流程

### 1. 编译时：嵌入技能资源

通过 `include_dir` 宏，将 `src/assets/samples/` 目录下的所有文件在编译时打包进二进制：

```rust
const SYSTEM_SKILLS_DIR: Dir = include_dir::include_dir!("$CARGO_MANIFEST_DIR/src/assets/samples");
```

> 源码位置：`codex-rs/skills/src/lib.rs:12`

`build.rs` 负责声明 `cargo:rerun-if-changed` 指令，递归遍历 `src/assets/samples` 下的所有文件和目录（`codex-rs/skills/build.rs:10-12`、`14-27`），确保资源文件变更时触发重新编译。

当前嵌入的系统技能包括 5 个：
- **skill-creator** — 创建或更新技能的向导
- **skill-installer** — 从 GitHub 安装技能
- **plugin-creator** — 创建插件
- **imagegen** — 图像生成
- **openai-docs** — OpenAI 文档参考

### 2. 运行时：安装流程（`install_system_skills`）

`install_system_skills(codex_home)` 是整个模块的核心入口，被 `SkillsManager::new_with_restriction_product()` 在启动时调用（`codex-rs/core-skills/src/manager.rs:77`）。

完整流程如下：

1. **路径解析**：将 `codex_home` 规范化为绝对路径，派生出 `skills/` 根目录和 `.system` 子目录路径
2. **确保目录存在**：`fs::create_dir_all()` 创建 `CODEX_HOME/skills/`
3. **指纹检查**：计算嵌入资源的指纹，与磁盘上的 marker 文件比对
   - 若指纹匹配 → **跳过安装**，直接返回 `Ok(())`
   - 若指纹不匹配或 marker 不存在 → 继续安装
4. **清理旧目录**：若 `.system` 目录已存在，执行 `fs::remove_dir_all()` 完整删除
5. **写入新文件**：调用 `write_embedded_dir()` 递归写入所有嵌入的文件和目录结构
6. **写入 marker**：将新指纹写入 `.codex-system-skills.marker` 文件

> 源码位置：`codex-rs/skills/src/lib.rs:47-78`

### 3. 指纹计算（`embedded_system_skills_fingerprint`）

指纹用于判断嵌入资源是否与磁盘上的版本一致：

1. 递归遍历 `SYSTEM_SKILLS_DIR`，收集所有条目（`codex-rs/skills/src/lib.rs:101-118`）：
   - **目录**：记录路径，内容哈希为 `None`
   - **文件**：记录路径，并用 `DefaultHasher` 对文件内容计算哈希
2. 按路径排序，确保指纹的确定性
3. 将 salt（`"v1"`）和所有 `(path, contents_hash)` 对依次喂入 `DefaultHasher`
4. 输出十六进制哈希字符串

> 源码位置：`codex-rs/skills/src/lib.rs:87-98`

salt 值 `SYSTEM_SKILLS_MARKER_SALT`（当前为 `"v1"`）允许在不改变任何资源文件的情况下强制全量重装——只需更新 salt 即可。

### 4. 递归写入（`write_embedded_dir`）

将 `include_dir::Dir` 结构完整还原到磁盘：

- 对每个子目录：创建目录后递归处理
- 对每个文件：确保父目录存在，然后 `fs::write()` 写入内容

> 源码位置：`codex-rs/skills/src/lib.rs:123-154`

### 5. 卸载流程

当 `bundled_skills_enabled` 为 `false` 时，`SkillsManager` 调用 `uninstall_system_skills()`（定义在 `codex-rs/core-skills/src/system.rs:6-9`），直接 `remove_dir_all` 删除 `.system` 目录。

## 函数签名

### `install_system_skills(codex_home: &Path) -> Result<(), SystemSkillsError>`

安装嵌入的系统技能到 `CODEX_HOME/skills/.system`。指纹匹配时跳过安装。

- **codex_home**：Codex 主目录的路径（通常是 `~/.codex` 或 `$CODEX_HOME`）
- **返回值**：成功返回 `Ok(())`，IO 失败返回 `SystemSkillsError::Io`

### `system_cache_root_dir(codex_home: &Path) -> PathBuf`

返回系统技能在磁盘上的缓存根目录，即 `CODEX_HOME/skills/.system`。

- 尝试将路径规范化为绝对路径；若失败则回退到简单的 `join` 拼接

## 类型定义

### `SystemSkillsError`

```rust
#[derive(Debug, Error)]
pub enum SystemSkillsError {
    #[error("io error while {action}: {source}")]
    Io {
        action: &'static str,
        source: std::io::Error,
    },
}
```

> 源码位置：`codex-rs/skills/src/lib.rs:156-164`

统一的错误类型，包含操作描述（`action`）和底层 IO 错误。每个可能失败的 IO 操作都有描述性的 action 字符串（如 `"create skills root dir"`、`"write system skill file"` 等），便于排查问题。

## 常量与配置项

| 常量 | 值 | 说明 |
|------|------|------|
| `SKILLS_DIR_NAME` | `"skills"` | `CODEX_HOME` 下技能目录名称 |
| `SYSTEM_SKILLS_DIR_NAME` | `".system"` | 系统技能子目录名（以 `.` 开头，区别于用户技能） |
| `SYSTEM_SKILLS_MARKER_FILENAME` | `".codex-system-skills.marker"` | 指纹 marker 文件名 |
| `SYSTEM_SKILLS_MARKER_SALT` | `"v1"` | 指纹计算的 salt，修改此值可强制全量重装 |

> 源码位置：`codex-rs/skills/src/lib.rs:14-17`

## 内嵌技能结构

每个内嵌技能遵循统一的目录规范：

```
skill-name/
├── SKILL.md              # 技能定义（必需），含 YAML frontmatter
├── agents/
│   └── openai.yaml       # UI 展示元数据（推荐）
├── scripts/              # 可执行脚本（可选）
├── references/           # 参考文档（可选）
├── assets/               # 图标等静态资源（可选）
└── LICENSE.txt           # 许可证（可选）
```

`SKILL.md` 的 frontmatter 包含 `name` 和 `description` 字段，是技能发现和触发的关键元数据。

## 边界 Case 与注意事项

- **指纹使用 `DefaultHasher`**：Rust 标准库的 `DefaultHasher` 不保证跨版本稳定性。这意味着 Rust 编译器升级后，即使资源未变更，首次启动也可能触发全量重装。这在实践中是无害的。
- **全量替换策略**：安装不是增量更新——检测到变更后会先 `remove_dir_all` 再全量写入。对于少量文件这是合理的，但如果未来嵌入大量技能需要关注性能。
- **`build.rs` 的 `rerun-if-changed`**：递归声明了所有文件变更触发重编译，确保任何资源修改都会更新嵌入内容。
- **路径规范化回退**：`system_cache_root_dir` 在绝对路径转换失败时使用简单 `join` 回退，保证总能返回可用路径。
- **`.system` 前缀命名**：以 `.` 开头的目录名将系统技能与用户自定义技能在视觉和逻辑上隔离开来。