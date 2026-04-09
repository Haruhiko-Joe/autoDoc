# Skills

## 概述与职责

Skills 模块是 Core 层中 **PluginsAndSkills** 子系统的一部分，负责将外部 `codex_core_skills` crate 桥接到核心会话中。它承担三项核心职责：

1. **技能加载**：根据当前配置构建 `SkillsLoadInput`，驱动技能发现和加载流程
2. **依赖解析**：在每个 turn（对话轮次）开始时，检查技能所需的环境变量依赖，缺失时向用户发起交互式提问
3. **文件监听**：通过节流式文件监视器监控技能目录变化，触发热重载事件

在整体架构中，Skills 模块位于 **Core → PluginsAndSkills** 层级下，与 SessionEngine 紧密协作——SessionEngine 在会话生命周期中调用 Skills 加载技能、注入提示词和工具定义。同级模块包括插件管理（Plugins）和 MCP 工具审批等扩展机制。

## 模块组成

本模块由两个源文件组成：

- **`skills.rs`**：技能加载入口和依赖解析逻辑，同时作为 `codex_core_skills` crate 的 re-export 门面
- **`skills_watcher.rs`**：基于通用 `FileWatcher` 的技能专用文件监视器

## 关键流程

### 1. 技能加载输入构建

`skills_load_input_from_config()` 从 `Config` 中提取所需信息，构造 `SkillsLoadInput` 对象：

```rust
// codex-rs/core/src/skills.rs:44-54
pub(crate) fn skills_load_input_from_config(
    config: &Config,
    effective_skill_roots: Vec<PathBuf>,
) -> SkillsLoadInput {
    SkillsLoadInput::new(
        config.cwd.clone().to_path_buf(),
        effective_skill_roots,
        config.config_layer_stack.clone(),
        config.bundled_skills_enabled(),
    )
}
```

该函数将四项关键信息传入 `SkillsLoadInput`：
- **工作目录**（`cwd`）：当前项目路径
- **有效技能根目录**（`effective_skill_roots`）：所有技能搜索路径，包含插件贡献的路径
- **配置层级栈**（`config_layer_stack`）：全局/项目/本地多层配置
- **内置技能开关**（`bundled_skills_enabled`）：是否启用内置技能

### 2. 环境变量依赖解析流程

`resolve_skill_dependencies_for_turn()` 在每个 turn 开始时被调用，确保技能所需的环境变量已就绪。这是一个三阶段流程：

**阶段一：分类已有与缺失的依赖**（`skills.rs:56-96`）

1. 获取 session 中已缓存的依赖环境变量（`sess.dependency_env()`）
2. 遍历所有依赖，使用 `HashSet` 去重
3. 对每个依赖，优先查找系统环境变量（`env::var()`）
4. 找到的值存入 `loaded_values`，未找到或读取失败的存入 `missing`

**阶段二：持久化已加载的值**

- 将从系统环境变量中成功读取的值通过 `sess.set_dependency_env()` 存入 session

**阶段三：向用户请求缺失值**（`skills.rs:98-169`）

- 对每个缺失的依赖构造一个 `RequestUserInputQuestion`
- 标记为 `is_secret: true`（值以密码形式处理）
- 通过 `sess.request_user_input()` 向用户发起交互式提问
- 用户回复后，从 `user_note:` 前缀的回答中提取实际值
- 将收集到的值存入 session 的依赖环境

问题文案示例：
> The skill "deploy" requires "AWS_ACCESS_KEY" to be set (AWS access key for deployment). This is an experimental internal feature. The value is stored in memory for this session only.

### 3. 隐式技能调用检测

`maybe_emit_implicit_skill_invocation()` 在命令执行时被调用（`skills.rs:171-230`），用于检测命令是否触发了某个技能的隐式调用：

1. 调用 `detect_implicit_skill_invocation_for_command()` 匹配当前命令与已加载技能
2. 使用 `scope:path:name` 复合键进行去重，确保同一 turn 内同一技能只上报一次
3. 通过 OTel counter（`codex.skill.injected`）和 analytics 事件上报调用信息

### 4. 技能目录文件监听

`SkillsWatcher` 封装了通用 `FileWatcher`，专门监听技能目录的文件变化：

**初始化流程**（`skills_watcher.rs:37-47`）：
1. 向 `FileWatcher` 注册一个订阅者，获取事件接收端 `rx`
2. 创建 `broadcast::channel`（容量 128）用于向下游广播技能变更事件
3. 启动异步事件循环 `spawn_event_loop`

**事件循环**（`skills_watcher.rs:77-88`）：
- 使用 `ThrottledWatchReceiver` 包装原始接收端，节流间隔为 **10 秒**（测试环境为 50ms）
- 在 Tokio 运行时中 spawn 异步任务，持续接收事件并转发为 `SkillsWatcherEvent::SkillsChanged`
- 若无可用的 Tokio 运行时则跳过监听并记录警告

**目录注册**（`skills_watcher.rs:57-75`）：
`register_config()` 方法将当前配置对应的技能根目录注册到文件监视器：
1. 从 `PluginsManager` 获取插件贡献的有效技能根路径
2. 通过 `SkillsManager.skill_roots_for_config()` 获取所有技能根目录
3. 将每个目录注册为递归监视路径

## 函数签名与参数说明

### `skills_load_input_from_config(config, effective_skill_roots) -> SkillsLoadInput`

构建技能加载输入。`pub(crate)` 可见性，供 session 初始化和 watcher 注册使用。

| 参数 | 类型 | 说明 |
|------|------|------|
| `config` | `&Config` | 当前会话配置 |
| `effective_skill_roots` | `Vec<PathBuf>` | 有效的技能搜索根目录列表 |

### `resolve_skill_dependencies_for_turn(sess, turn_context, dependencies)`

异步函数，在 turn 开始时解析技能依赖。

| 参数 | 类型 | 说明 |
|------|------|------|
| `sess` | `&Arc<Session>` | 当前会话引用 |
| `turn_context` | `&Arc<TurnContext>` | 当前 turn 上下文 |
| `dependencies` | `&[SkillDependencyInfo]` | 需要解析的依赖列表 |

### `maybe_emit_implicit_skill_invocation(sess, turn_context, command, workdir)`

异步函数，检测并上报隐式技能调用。

| 参数 | 类型 | 说明 |
|------|------|------|
| `sess` | `&Session` | 当前会话 |
| `turn_context` | `&TurnContext` | 当前 turn 上下文 |
| `command` | `&str` | 正在执行的命令 |
| `workdir` | `&Path` | 命令的工作目录 |

## 类型定义

### `SkillsWatcherEvent`

```rust
// codex-rs/core/src/skills_watcher.rs:28-30
pub enum SkillsWatcherEvent {
    SkillsChanged { paths: Vec<PathBuf> },
}
```

技能变更事件，包含发生变化的文件路径列表。当前仅有一个变体 `SkillsChanged`。

### Re-exported 类型

`skills.rs` 作为门面模块，从 `codex_core_skills` crate re-export 了大量类型和子模块：

- **类型**：`SkillDependencyInfo`、`SkillError`、`SkillLoadOutcome`、`SkillMetadata`、`SkillPolicy`、`SkillsLoadInput`、`SkillsManager`
- **函数**：`build_skill_name_counts`、`collect_env_var_dependencies`、`config_rules`、`detect_implicit_skill_invocation_for_command`、`filter_skill_load_outcome_for_product`、`render_skills_section`
- **子模块**：`injection`（含 `SkillInjections`、`build_skill_injections`、`collect_explicit_skill_mentions`）、`loader`、`manager`、`model`、`remote`、`render`、`system`

## 配置项与默认值

| 配置项 | 值 | 说明 |
|--------|------|------|
| `WATCHER_THROTTLE_INTERVAL`（生产） | 10 秒 | 文件变更事件的节流间隔 |
| `WATCHER_THROTTLE_INTERVAL`（测试） | 50 毫秒 | 测试环境的节流间隔 |
| broadcast channel 容量 | 128 | `SkillsWatcher` 内部广播通道的缓冲区大小 |

## 边界 Case 与注意事项

- **依赖去重**：`resolve_skill_dependencies_for_turn` 使用 `HashSet` 跳过重复的环境变量名，也跳过 session 中已存在的值，避免重复提问
- **秘密值处理**：所有通过用户交互获取的依赖值都标记为 `is_secret: true`，值仅存储在当前 session 的内存中，不会持久化
- **环境变量读取失败**：`env::VarError::NotPresent` 和其他错误（如非 UTF-8 值）都会将依赖归入 missing 列表，后者还会记录警告日志
- **用户回复解析**：仅从回答中提取 `user_note:` 前缀的内容作为实际值，空白回复会被忽略
- **隐式调用去重**：`maybe_emit_implicit_skill_invocation` 使用 `scope:path:name` 组合键在 turn 级别去重，同一技能在同一 turn 中只上报一次
- **Tokio 运行时缺失**：如果 `SkillsWatcher::spawn_event_loop` 在无 Tokio 运行时的上下文中被调用，事件循环不会启动，仅记录警告
- **`noop()` 构造**：`SkillsWatcher::noop()` 创建一个不监听任何路径的空 watcher，用于测试或不需要文件监听的场景