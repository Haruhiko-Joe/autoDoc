# ExperimentalApi — 实验性 API 注解与门控系统

## 概述与职责

`ExperimentalApi` 模块是 `codex-app-server-protocol` 协议层的实验性功能门控基础设施。它定义了一套 trait + 注册表机制，使协议中的请求/响应类型能够**自描述**其是否使用了实验性功能。当客户端发送的消息包含实验性字段或变体时，服务端可以检查客户端是否声明了 `experimentalApi` 能力，未声明则拒绝请求。

在系统架构中，该模块位于 **AppServer → Protocol** 层，是所有协议类型共享的基础 crate 的一部分。它与 `codex-experimental-api-macros` derive 宏配合使用——宏负责自动生成 trait 实现，本模块负责定义 trait 契约、字段注册表和容器类型的 blanket 实现。

同级模块包括协议的 JSON-RPC 消息类型定义、v1/v2 API 版本枚举、线程/会话数据模型、TypeScript/JSON Schema 导出工具等。

## 关键流程

### 实验性功能检测流程

1. 协议类型（enum 或 struct）通过 `#[derive(ExperimentalApi)]` 自动实现 `ExperimentalApi` trait
2. 枚举变体上标注 `#[experimental("reason")]` 表示该变体是实验性的；结构体字段标注 `#[experimental(nested)]` 表示需要递归检查内部值
3. 当服务端收到客户端消息并反序列化为协议类型后，调用 `.experimental_reason()` 方法
4. 如果返回 `Some(reason)`，说明消息使用了实验性功能，服务端检查客户端是否具有 `experimentalApi` 能力
5. 若客户端未声明该能力，使用 `experimental_required_message(reason)` 生成错误消息拒绝请求

### 字段注册流程

`ExperimentalField` 结构体通过 `inventory::collect!` 宏注册到全局静态注册表中。derive 宏为每个标注了 `#[experimental(...)]` 的字段/变体生成 `inventory::submit!` 调用，运行时通过 `experimental_fields()` 函数可以枚举所有已注册的实验性字段——这可用于文档生成、能力协商或诊断输出。

## 核心类型与接口

### `ExperimentalApi` trait

```rust
pub trait ExperimentalApi {
    fn experimental_reason(&self) -> Option<&'static str>;
}
```

> 源码位置：`codex-rs/app-server-protocol/src/experimental_api.rs:5-9`

核心 trait。实现者在自身包含实验性功能时返回 `Some("reason")`，否则返回 `None`。`reason` 是一个稳定标识符，约定格式为：

- **方法级门控**：`<method>`（如 `"enum/unit"`）
- **字段级门控**：`<method>.<field>`

### `ExperimentalField` struct

```rust
pub struct ExperimentalField {
    pub type_name: &'static str,
    pub field_name: &'static str,
    pub reason: &'static str,
}
```

> 源码位置：`codex-rs/app-server-protocol/src/experimental_api.rs:12-20`

描述某个类型上的一个实验性字段的元数据。通过 `inventory` crate 实现编译期全局注册，无需手动维护列表。

| 字段 | 类型 | 说明 |
|------|------|------|
| `type_name` | `&'static str` | 拥有该字段的类型名称 |
| `field_name` | `&'static str` | 字段或变体名称 |
| `reason` | `&'static str` | 门控标识符，与 `experimental_reason()` 返回值一致 |

### `experimental_fields() -> Vec<&'static ExperimentalField>`

> 源码位置：`codex-rs/app-server-protocol/src/experimental_api.rs:25-27`

收集并返回所有通过 `inventory` 注册的 `ExperimentalField`。可用于运行时内省所有实验性功能点。

### `experimental_required_message(reason: &str) -> String`

> 源码位置：`codex-rs/app-server-protocol/src/experimental_api.rs:30-32`

生成统一格式的错误消息：`"{reason} requires experimentalApi capability"`。确保所有实验性门控拒绝响应使用一致的措辞。

## Blanket 实现

模块为四种常见容器类型提供了 blanket 实现，使门控检查能自动穿透容器：

| 类型 | 行为 | 源码位置 |
|------|------|----------|
| `Option<T>` | 值为 `None` 返回 `None`，`Some(v)` 委托给内部值 | `:34-38` |
| `Vec<T>` | 遍历元素，返回**第一个**实验性 reason | `:40-44` |
| `HashMap<K, V, S>` | 遍历所有 value，返回第一个实验性 reason | `:46-50` |
| `BTreeMap<K, V>` | 遍历所有 value，返回第一个实验性 reason | `:52-56` |

这些实现使得 `#[experimental(nested)]` 标注的字段无论是 `Option`、`Vec` 还是 `Map` 类型，都能正确递归检测实验性使用。

## 与 derive 宏的协作

本模块与 `codex-experimental-api-macros` crate 配合工作。从测试代码可以看到两种注解模式（`codex-rs/app-server-protocol/src/experimental_api.rs:67-99`）：

**枚举变体标注** — 直接标记某个变体为实验性：
```rust
#[derive(ExperimentalApi)]
enum MyEnum {
    #[experimental("my_enum/new_variant")]
    NewVariant,
    StableVariant(u8),  // 未标注，始终返回 None
}
```

**结构体嵌套标注** — 字段本身实现了 `ExperimentalApi`，需要递归检查：
```rust
#[derive(ExperimentalApi)]
struct MyStruct {
    #[experimental(nested)]
    inner: Option<MyEnum>,
}
```

注意 `nested` 模式不直接指定 reason 字符串，而是委托给内部类型的 `experimental_reason()` 返回值。

## 边界 Case 与注意事项

- **短路求值**：`Vec`、`HashMap`、`BTreeMap` 的实现使用 `find_map`，找到第一个实验性 reason 即返回，不会继续遍历。如果一个集合中有多个不同 reason 的实验性元素，只会报告第一个。
- **HashMap 遍历顺序不确定**：由于 `HashMap` 的迭代顺序不固定，同一个 map 中存在多个实验性值时，返回哪个 reason 是不确定的。这在实践中不影响正确性——只要返回了任意一个 reason，门控就会生效。
- **仅检查 value**：Map 类型的实现只检查 value，不检查 key。key 类型不需要实现 `ExperimentalApi`。
- **`inventory` 的链接要求**：`inventory` crate 依赖链接器的特定行为来收集跨 crate 的注册项。确保所有使用了 `#[derive(ExperimentalApi)]` 的 crate 都被正确链接到最终二进制中，否则 `experimental_fields()` 可能遗漏部分注册项。