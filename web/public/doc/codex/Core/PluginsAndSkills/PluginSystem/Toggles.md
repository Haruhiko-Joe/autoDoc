# 插件启用/禁用切换提取（Toggles）

## 概述与职责

`toggles` 模块是插件系统（PluginSystem）中的一个功能聚焦的工具模块，负责从配置编辑操作中**提取插件的启用/禁用状态变更**。它位于 Core → PluginsAndSkills → PluginSystem 层级下，为配置编辑流程的下游处理提供结构化的 `plugin_id → enabled` 映射。

当用户或系统对配置进行写入操作时，写入内容以 key-path/value 键值对的形式到达。该模块解析这些键值对，识别出其中与插件启用状态相关的变更，并将结果汇总为一个 `BTreeMap<String, bool>`，供配置编辑流程的后续环节使用。

## 关键流程

### `collect_plugin_enabled_candidates` 解析流程

该模块只导出一个公开函数 `collect_plugin_enabled_candidates`（`codex-rs/core/src/plugins/toggles.rs:4-43`），它接收一个配置编辑迭代器，遍历所有编辑项，通过对 key-path 按 `.` 分割后的段数进行模式匹配，识别三种不同格式的插件启用状态写入：

**1. 直接写入格式：`plugins.<id>.enabled`（三段路径）**

key-path 分割后恰好为三段 `["plugins", "<plugin_id>", "enabled"]`，且 value 是布尔值时匹配。直接从 value 提取布尔值作为启用状态。

```rust
// codex-rs/core/src/plugins/toggles.rs:14-20
[plugins, plugin_id, enabled]
    if plugins == "plugins" && enabled == "enabled" && value.is_boolean() =>
{
    if let Some(enabled) = value.as_bool() {
        pending_changes.insert(plugin_id.clone(), enabled);
    }
}
```

示例：key = `"plugins.sample@test.enabled"`, value = `true` → 记录 `sample@test → true`

**2. 嵌套对象写入格式：`plugins.<id>`（两段路径）**

key-path 分割后为两段 `["plugins", "<plugin_id>"]`，value 是一个包含 `"enabled"` 字段的 JSON 对象时匹配。从 value 对象中提取 `enabled` 布尔字段。

```rust
// codex-rs/core/src/plugins/toggles.rs:21-25
[plugins, plugin_id] if plugins == "plugins" => {
    if let Some(enabled) = value.get("enabled").and_then(JsonValue::as_bool) {
        pending_changes.insert(plugin_id.clone(), enabled);
    }
}
```

示例：key = `"plugins.other@test"`, value = `{"enabled": false, "ignored": true}` → 记录 `other@test → false`

**3. 批量写入格式：`plugins`（单段路径）**

key-path 仅为 `"plugins"` 一段，value 是一个 JSON 对象，其中每个键是 plugin_id，值是包含 `"enabled"` 字段的对象。遍历所有条目，逐一提取。

```rust
// codex-rs/core/src/plugins/toggles.rs:26-37
[plugins] if plugins == "plugins" => {
    let Some(entries) = value.as_object() else {
        continue;
    };
    for (plugin_id, plugin_value) in entries {
        let Some(enabled) = plugin_value.get("enabled").and_then(JsonValue::as_bool)
        else {
            continue;
        };
        pending_changes.insert(plugin_id.clone(), enabled);
    }
}
```

示例：key = `"plugins"`, value = `{"nested@test": {"enabled": true}, "skip@test": {"name": "skip"}}` → 仅记录 `nested@test → true`（`skip@test` 因缺少 `enabled` 字段被跳过）

**不匹配的路径**会被静默忽略（`_ => {}`），不会产生错误。

## 函数签名与参数说明

### `collect_plugin_enabled_candidates`

```rust
pub fn collect_plugin_enabled_candidates<'a>(
    edits: impl Iterator<Item = (&'a String, &'a JsonValue)>,
) -> BTreeMap<String, bool>
```

- **`edits`**：一个迭代器，每项为 `(key_path, value)` 元组。`key_path` 是点分隔的配置路径字符串（如 `"plugins.my-plugin.enabled"`），`value` 是对应的 JSON 值。
- **返回值**：`BTreeMap<String, bool>`，键为 plugin_id（如 `"sample@test"`），值为启用状态（`true`/`false`）。使用 `BTreeMap` 保证输出按 plugin_id 字典序排列。

## 边界 Case 与注意事项

- **后写优先（Last-Write-Wins）**：当同一个 plugin_id 在多条编辑中出现时，后出现的写入会覆盖先前的值。这由 `BTreeMap::insert` 的覆盖语义自然实现。测试 `collect_plugin_enabled_candidates_uses_last_write_for_same_plugin`（`:83-99`）验证了这一行为：先写 `true` 再写 `false`，最终结果为 `false`。

- **静默跳过无效条目**：如果 value 不是布尔值（对于直接写入格式）、不包含 `"enabled"` 字段（对于嵌套格式）、或 `"enabled"` 字段不是布尔值，该条目会被静默跳过，不会报错也不会插入到结果中。

- **批量写入中非对象 value 被跳过**：当 key 为 `"plugins"` 但 value 不是 JSON 对象时（如 `"plugins": "string"`），会直接 `continue` 跳过。

- **plugin_id 的命名惯例**：从测试用例可以看出，plugin_id 通常采用 `name@scope` 格式（如 `"sample@test"`、`"nested@test"`），但模块本身不对 plugin_id 格式做任何校验。

- **泛型迭代器输入**：函数通过 `impl Iterator` 接受任意迭代器，调用方可以灵活传入数组、Vec、HashMap 迭代器等不同来源的配置编辑数据。