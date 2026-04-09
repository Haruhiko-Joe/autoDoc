# SchemaExport — TypeScript 与 JSON Schema 生成工具

## 概述与职责

SchemaExport 是 `codex-app-server-protocol` crate 中的**代码生成基础设施**，负责将 Rust 协议类型自动导出为 TypeScript 类型定义和 JSON Schema 文件，供 IDE 客户端（VS Code、Cursor、Windsurf）进行代码生成。

在整体架构中，SchemaExport 隶属于 **AppServer → Protocol** 层级。Protocol crate 定义了 app-server 的所有 JSON-RPC 消息类型（请求、响应、通知），而 SchemaExport 则是这些类型定义的"出口"——它确保 Rust 侧的类型变更能自动反映到 TypeScript/JSON Schema 产物中，并通过 golden-file fixture 测试防止意外回归。

同级兄弟模块包括 Transport（连接传输层）、RequestProcessing（请求分发引擎）、ServerAPIs（辅助服务模块）、ServerCore（服务器入口）、ClientLib（客户端库）和 DevTools（开发调试工具）。

该模块由三个主要部分组成：

| 组件 | 文件 | 职责 |
|------|------|------|
| **export 模块** | `src/export.rs` | TypeScript 和 JSON Schema 生成核心逻辑 |
| **schema_fixtures 模块** | `src/schema_fixtures.rs` | Golden-file fixture 管理与跨平台归一化 |
| **CLI 二进制** | `src/bin/export.rs`、`src/bin/write_schema_fixtures.rs` | 命令行入口 |
| **集成测试** | `tests/schema_fixtures.rs` | Fixture 新鲜度验证 |

## 关键流程

### 1. TypeScript 生成流程

入口函数 `generate_ts_with_options()` 执行以下步骤（`src/export.rs:105-183`）：

1. **创建目录结构**：在 `out_dir` 下创建根目录和 `v2/` 子目录，对应 v1/v2 两套 API 版本
2. **导出类型文件**：利用 `ts-rs` crate 的 `export_all_to()` 方法，将 `ClientRequest`、`ClientNotification`、`ServerRequest`、`ServerNotification` 及其关联的 response 类型导出为 `.ts` 文件
3. **过滤实验性 API**：若 `experimental_api` 标志为 `false`（默认），调用 `filter_experimental_ts()` 移除标记为实验性的方法和字段
4. **生成 index.ts**：扫描根目录和 `v2/` 子目录中的所有 `.ts` 文件，生成汇总 re-export 的 `index.ts`
5. **添加生成标记头**：多线程并行为所有 `.ts` 文件添加 `// GENERATED CODE! DO NOT MODIFY BY HAND!` 头部
6. **Prettier 格式化**：如果提供了 prettier 二进制路径，对所有生成的 `.ts` 文件执行格式化

`GenerateTsOptions` 提供了四个配置项：

```rust
pub struct GenerateTsOptions {
    pub generate_indices: bool,   // 是否生成 index.ts（默认 true）
    pub ensure_headers: bool,     // 是否添加生成标记头（默认 true）
    pub run_prettier: bool,       // 是否运行 Prettier（默认 true）
    pub experimental_api: bool,   // 是否包含实验性 API（默认 false）
}
```

### 2. JSON Schema 生成流程

入口函数 `generate_json_with_experimental()` 执行以下步骤（`src/export.rs:195-244`）：

1. **收集 Schema**：通过 `schemars` crate 的 `schema_for!` 宏为每个协议类型生成 JSON Schema，包括 JSON-RPC 信封类型（`RequestId`、`JSONRPCMessage`、`JSONRPCRequest` 等）和所有请求/响应/通知类型
2. **构建 Bundle**：`build_schema_bundle()` 将所有独立 schema 合并为一个 `codex_app_server_protocol.schemas.json` 文件，使用 `definitions` 映射组织类型定义
3. **命名空间处理**：v2 类型被放入 `definitions.v2` 命名空间下，`$ref` 引用被自动重写为命名空间路径（如 `#/definitions/v2/ThreadId`）
4. **构建扁平 v2 Bundle**：`build_flat_v2_schema()` 将 v2 命名空间展平为根级 definitions，生成 `codex_app_server_protocol.v2.schemas.json`，适用于 Python datamodel-code-generator 等只遍历单层 definitions 的工具
5. **过滤实验性 API**：移除实验性方法变体、字段和类型定义
6. **完整性验证**：`ensure_referenced_definitions_present()` 检查所有 `$ref` 引用的 definition 都存在

### 3. 实验性 API 过滤流程

过滤逻辑同时作用于 TypeScript 和 JSON Schema 两种输出：

**TypeScript 侧**（`src/export.rs:246-398`）：
- `filter_client_request_ts_contents()`：解析 `ClientRequest.ts` 中的 union 类型，移除实验性方法对应的 union arm
- `filter_experimental_type_fields_ts_contents()`：从 interface/type 定义中移除实验性字段
- `prune_unused_type_imports()`：清理因移除实验性内容而变成未使用的 import 语句
- `remove_generated_type_files()`：删除实验性方法独有的参数/响应类型文件

**JSON Schema 侧**（`src/export.rs:400-652`）：
- `filter_experimental_schema()`：从 bundle 中移除实验性字段（`properties` 和 `required`）、方法变体（`oneOf` 数组项）和类型定义
- `remove_experimental_method_type_definitions()`：递归清理命名空间中的实验性类型定义

### 4. Schema Fixture 测试流程

**写入 fixture**（`src/schema_fixtures.rs:82-109`）：
`write_schema_fixtures_with_options()` 先清空 `schema/typescript/` 和 `schema/json/` 目录，然后重新生成所有内容。

**验证 fixture 新鲜度**（`tests/schema_fixtures.rs:12-51`）：
两个集成测试分别验证 TypeScript 和 JSON fixture 是否与当前代码生成的产物一致：

- `typescript_schema_fixtures_match_generated`：在内存中生成 TypeScript fixture 树（使用 `generate_typescript_schema_fixture_subtree_for_tests()`），然后与磁盘上的 fixture 逐文件比对
- `json_schema_fixtures_match_generated`：将 JSON schema 生成到临时目录，然后与磁盘上的 fixture 比对

若不一致，测试会输出 unified diff 并提示运行 `just write-app-server-schema` 更新 fixture。

### 5. 跨平台归一化

`schema_fixtures.rs` 中的 `read_file_bytes()` 函数对读取的 fixture 文件进行归一化（`src/schema_fixtures.rs:120-146`）：

- **TypeScript 文件**：将 `\r\n` 和 `\r` 统一为 `\n`；移除 `GENERATED_TS_HEADER` 前缀，使比对不受头部变化影响
- **JSON 文件**：解析后通过 `canonicalize_json()` 重新序列化。该函数对 JSON 对象按 key 排序，对数组在能推导稳定排序键时进行排序（支持字符串、`$ref` 引用、`title` 字段作为排序键），解决不同平台上 map 迭代顺序不确定导致的 CI 失败问题

## 函数签名与参数说明

### 公开 API — TypeScript 生成

#### `generate_ts(out_dir: &Path, prettier: Option<&Path>) -> Result<()>`

使用默认选项生成 TypeScript 类型文件。等同于调用 `generate_ts_with_options()` 配合 `GenerateTsOptions::default()`。

#### `generate_ts_with_options(out_dir: &Path, prettier: Option<&Path>, options: GenerateTsOptions) -> Result<()>`

完整的 TypeScript 生成入口。

- **out_dir**：输出根目录，TypeScript 文件直接写入此目录及其 `v2/` 子目录
- **prettier**：可选的 Prettier 可执行文件路径
- **options**：生成选项（是否生成 index、是否添加头部、是否格式化、是否包含实验性 API）

> 源码位置：`src/export.rs:105-183`

### 公开 API — JSON Schema 生成

#### `generate_json_with_experimental(out_dir: &Path, experimental_api: bool) -> Result<()>`

生成 JSON Schema 文件到指定目录，产出两个 bundle 文件：
- `codex_app_server_protocol.schemas.json`：完整的命名空间化 bundle
- `codex_app_server_protocol.v2.schemas.json`：展平的 v2 专用 bundle

> 源码位置：`src/export.rs:195-244`

#### `generate_internal_json_schema(out_dir: &Path) -> Result<()>`

仅生成内部使用的 schema（目前只有 `RolloutLine`），不包含在公开 bundle 中。

> 源码位置：`src/export.rs:189-193`

### 公开 API — Fixture 管理

#### `write_schema_fixtures_with_options(schema_root: &Path, prettier: Option<&Path>, options: SchemaFixtureOptions) -> Result<()>`

重新生成 `schema/typescript/` 和 `schema/json/` 下的所有 fixture 文件。先清空目标目录再写入，确保不留残余。

> 源码位置：`src/schema_fixtures.rs:87-109`

#### `read_schema_fixture_subtree(schema_root: &Path, label: &str) -> Result<BTreeMap<PathBuf, Vec<u8>>>`

读取指定子目录（如 `"typescript"` 或 `"json"`）下的所有 fixture 文件，返回相对路径到归一化内容的映射。

> 源码位置：`src/schema_fixtures.rs:43-50`

#### `generate_typescript_schema_fixture_subtree_for_tests() -> Result<BTreeMap<PathBuf, Vec<u8>>>`

纯内存生成 TypeScript fixture 树，用于集成测试中与磁盘 fixture 比对。不写入任何文件。

> 源码位置：`src/schema_fixtures.rs:53-76`

## CLI 二进制

### `export` 二进制

```
codex-app-server-protocol-export -o <DIR> [-p <PRETTIER_BIN>] [--experimental]
```

生成 TypeScript 绑定和 JSON Schema 到指定输出目录。

- `-o, --out <DIR>`：输出目录（必填）
- `-p, --prettier <PRETTIER_BIN>`：可选的 Prettier 路径
- `--experimental`：包含实验性 API

> 源码位置：`src/bin/export.rs:1-34`

### `write_schema_fixtures` 二进制

```
codex-app-server-protocol-write-schema-fixtures [--schema-root <DIR>] [-p <PRETTIER_BIN>] [--experimental]
```

重新生成 vendored schema fixture 文件。schema-root 默认为 crate 目录下的 `schema/`。

- `--schema-root <DIR>`：fixture 根目录，包含 `typescript/` 和 `json/` 子目录
- `-p, --prettier <PRETTIER_BIN>`：可选的 Prettier 路径
- `--experimental`：包含实验性 API

> 源码位置：`src/bin/write_schema_fixtures.rs:1-42`

## 关键类型定义

### `GeneratedSchema`

内部类型，表示一个已生成的 JSON Schema 及其元数据（`src/export.rs:54-73`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `namespace` | `Option<String>` | 命名空间（如 `"v2"`），用于 bundle 中的层级组织 |
| `logical_name` | `String` | 类型的逻辑名称（如 `"ThreadStartParams"`） |
| `value` | `Value` | JSON Schema 内容 |
| `in_v1_dir` | `bool` | 是否来自 v1 目录布局 |

### `SchemaFixtureOptions`

Fixture 生成选项（`src/schema_fixtures.rs:23-26`）：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `experimental_api` | `bool` | `false` | 是否在 fixture 中包含实验性 API |

## 配置项与常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `GENERATED_TS_HEADER` | `"// GENERATED CODE! DO NOT MODIFY BY HAND!\n\n"` | TypeScript 文件头标记 |
| `IGNORED_DEFINITIONS` | `["Option<()>"]` | 从 JSON Schema bundle 中排除的定义 |
| `JSON_V1_ALLOWLIST` | `["InitializeParams", "InitializeResponse"]` | v1 目录中允许纳入 JSON bundle 的类型 |
| `SPECIAL_DEFINITIONS` | `["ClientNotification", "ClientRequest", ...]` | 作为顶级信封类型处理，不合并到 definitions |
| `FLAT_V2_SHARED_DEFINITIONS` | `["ClientRequest", "ServerNotification"]` | 在扁平 v2 bundle 中保留的共享根类型 |
| `V1_CLIENT_REQUEST_METHODS` | `["getConversationSummary", "gitDiffToRemote", "getAuthStatus"]` | 从 ClientRequest JSON Schema 中移除的 v1 方法 |

## 边界 Case 与注意事项

- **跨平台一致性**：`canonicalize_json()` 对 JSON 数组排序时采用保守策略——只在每个元素都能推导排序键时才排序，否则保持原序。这避免了修改 `prefixItems` 等语义依赖顺序的数组。排序键的推导支持基本类型、`$ref` 和 `title` 字段（`src/schema_fixtures.rs:148-222`）

- **Bazel 兼容**：fixture 读取时通过 `std::fs::metadata()` 而非 `DirEntry::file_type()` 判断文件类型，以正确处理 Bazel runfiles 中的符号链接（`src/schema_fixtures.rs:238-240`）。测试中通过 `codex_utils_cargo_bin::find_resource!` 定位 schema 根目录，兼容 manifest-only 模式

- **命名空间 $ref 重写**：v2 类型的 `$ref` 引用会被自动重写（如 `#/definitions/ThreadId` → `#/definitions/v2/ThreadId`）。共享根类型（如 `ClientRequest`）中引用 v2 类型时，也会通过 `rewrite_refs_to_known_namespaces()` 正确指向命名空间路径，防止出现悬空引用

- **定义冲突检测**：`detect_numbered_definition_collisions()` 会在发现如 `Foo` 和 `Foo2` 同时存在时 panic，提示使用 `#[schemars(rename = "...")]` 解决命名冲突（`src/export.rs:1469-1484`）

- **扁平 v2 Bundle 的完整性**：`build_flat_v2_schema()` 在展平后会执行两项检查——确认不再有 `#/definitions/v2/` 前缀的引用（`ensure_no_ref_prefix`），以及所有 `$ref` 引用的 definition 都已存在（`ensure_referenced_definitions_present`）

- **TypeScript 解析器的局限性**：实验性 API 过滤使用自定义的 TypeScript 文本解析（`ScanState` / `Depth` 状态机追踪括号嵌套），而非完整的 AST 解析。这对于生成代码的固定格式是足够的，但不适用于任意 TypeScript 源码