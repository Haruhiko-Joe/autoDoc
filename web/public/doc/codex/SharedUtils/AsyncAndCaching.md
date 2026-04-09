# 异步并发原语与缓存

## 概述与职责

本模块属于 **SharedUtils** 层，为 Codex 工作区中的其他 crate 提供三组基础异步 / 并发工具：

| crate | 职责 |
|-------|------|
| `codex-async-utils` | 提供 `OrCancelExt` trait，让任意 `Future` 能与 `CancellationToken` 竞速 |
| `codex-utils-readiness` | 提供 `ReadinessFlag`，基于 token 授权的异步就绪信号，支持订阅与广播 |
| `codex-utils-cache` | 提供 `BlockingLruCache`，Tokio mutex 保护的 LRU 缓存，附带 SHA-1 内容寻址辅助函数 |

同级兄弟模块还包括路径处理、PTY 管理、图像处理、字符串工具等其他 SharedUtils 组件。

---

## OrCancelExt — Future 取消扩展

### 核心思想

`OrCancelExt` 是一个扩展 trait，为所有 `Future + Send` 自动实现。它提供 `.or_cancel(token)` 方法，在底层使用 `tokio::select!` 让 future 与 `CancellationToken` 竞速执行：

- future 先完成 → 返回 `Ok(value)`
- token 先被取消（或已处于取消状态）→ 返回 `Err(CancelErr::Cancelled)`

### 类型定义

```rust
#[derive(Debug, PartialEq, Eq)]
pub enum CancelErr {
    Cancelled,
}

#[async_trait]
pub trait OrCancelExt: Sized {
    type Output;
    async fn or_cancel(self, token: &CancellationToken) -> Result<Self::Output, CancelErr>;
}
```

> 源码位置：`codex-rs/async-utils/src/lib.rs:5-15`

### 关键流程

1. 调用者在任意 future 上链式调用 `.or_cancel(&token)`
2. 内部通过 `tokio::select!` 同时 await future 本身和 `token.cancelled()`（`codex-rs/async-utils/src/lib.rs:26-29`）
3. 哪个分支先就绪，就走对应路径返回

### 边界 Case

- 如果 token **已经**处于取消状态，`token.cancelled()` 立即就绪，future 会被丢弃（即使它本身也已就绪，`tokio::select!` 的随机性可能导致任一分支胜出）。测试 `returns_err_when_token_already_cancelled` 验证了此行为。
- trait bound 要求 `F: Future + Send` 且 `F::Output: Send`，因此不适用于非 `Send` 的 future。

---

## ReadinessFlag — 异步就绪信号

### 核心思想

`ReadinessFlag` 实现了一种 **一次性、不可逆** 的就绪信号。多个参与者可以通过 `subscribe()` 获取 token，任意持有 token 的参与者都可以通过 `mark_ready(token)` 将标志设置为就绪。其他协程可以通过 `wait_ready()` 异步等待就绪事件。

这种设计确保只有经过授权（持有有效 token）的参与者才能触发就绪信号。

### 接口定义

```rust
pub trait Readiness: Send + Sync + 'static {
    fn is_ready(&self) -> bool;
    async fn subscribe(&self) -> Result<Token, ReadinessError>;
    async fn mark_ready(&self, token: Token) -> Result<bool, ReadinessError>;
    async fn wait_ready(&self);
}
```

> 源码位置：`codex-rs/utils/readiness/src/lib.rs:20-41`

### 内部结构

```rust
pub struct ReadinessFlag {
    ready: AtomicBool,                  // 原子标志，支持廉价读取
    next_id: AtomicI32,                 // Token ID 生成器，从 1 开始（0 保留）
    tokens: Mutex<HashSet<Token>>,      // 活跃订阅集合
    tx: watch::Sender<bool>,           // 广播就绪事件给异步等待者
}
```

> 源码位置：`codex-rs/utils/readiness/src/lib.rs:43-52`

### 关键流程

#### 订阅流程 (`subscribe`)

1. 快速路径：检查 `ready` 原子标志，如果已就绪直接返回 `Err(FlagAlreadyReady)`
2. 获取 `tokens` 锁（带 1 秒超时），在锁内再次检查就绪状态（防止 `mark_ready` 在检查和插入之间翻转标志）
3. 通过 `next_id.fetch_add(1)` 生成新 token，跳过 0 值并确保不与已有 token 重复（`codex-rs/utils/readiness/src/lib.rs:130-135`）
4. 将 token 插入 `HashSet` 并返回

#### 标记就绪流程 (`mark_ready`)

1. 快速路径：如果已就绪或 token 为 0，直接返回 `false`
2. 在锁内移除该 token；如果 token 无效或已使用，返回 `false`
3. 设置 `ready = true`，清空所有剩余 token（`codex-rs/utils/readiness/src/lib.rs:151-157`）
4. 通过 `watch::Sender` 广播就绪事件

#### 等待就绪流程 (`wait_ready`)

1. 快速路径：调用 `is_ready()` 检查
2. 创建 `watch` 接收端，先检查当前值
3. 循环 await `rx.changed()`，直到观察到 `true`（`codex-rs/utils/readiness/src/lib.rs:178-182`）

#### `is_ready()` 的隐式就绪语义

`is_ready()` 不仅读取标志，还有一个重要的副作用：如果没有任何订阅者（`tokens` 集合为空），它会**自动将标志设为就绪**（`codex-rs/utils/readiness/src/lib.rs:102-111`）。这意味着一个从未被订阅的 `ReadinessFlag`，在首次调用 `is_ready()` 时就会变为就绪。

### 错误类型

| 变体 | 含义 |
|------|------|
| `ReadinessError::TokenLockFailed` | 获取 token 锁超时（1 秒），通常表示死锁或严重竞争 |
| `ReadinessError::FlagAlreadyReady` | 标志已就绪，无法再订阅 |

### 边界 Case

- Token ID 0 被保留，永远不会被授权（`mark_ready` 对 `token.0 == 0` 直接返回 `false`）
- Token ID 使用 `i32`，存在回绕可能，代码通过循环 + `HashSet::insert` 确保唯一性
- `mark_ready` 成功后会清空所有剩余 token，即使有多个订阅者，也只需要一个 token 即可触发就绪
- 锁获取使用 1 秒超时（`LOCK_TIMEOUT`），超时返回 `TokenLockFailed` 错误

---

## BlockingLruCache — 同步 LRU 缓存

### 核心思想

`BlockingLruCache` 将 `lru::LruCache` 包装在 Tokio `Mutex` 中，提供同步 API（非 async fn），通过 `tokio::task::block_in_place` 获取锁。关键设计决策：**当代码运行在 Tokio runtime 之外时，所有缓存操作优雅降级为 no-op**，直接执行计算而不缓存结果。

### 函数签名

#### `BlockingLruCache::new(capacity: NonZeroUsize) -> Self`

创建指定容量的缓存。

#### `BlockingLruCache::try_with_capacity(capacity: usize) -> Option<Self>`

当 `capacity` 为 0 时返回 `None`，非零时返回 `Some(Self)`。

#### `get_or_insert_with(&self, key: K, value: impl FnOnce() -> V) -> V`

核心方法。命中缓存返回克隆值；未命中则调用 `value()` 闭包计算，存入缓存并返回。无 runtime 时直接调用闭包。

> 源码位置：`codex-rs/utils/cache/src/lib.rs:30-44`

#### `get_or_try_insert_with<E>(&self, key: K, value: impl FnOnce() -> Result<V, E>) -> Result<V, E>`

与上面相同，但闭包可能失败。失败时不缓存，直接传播错误。

#### `get<Q>(&self, key: &Q) -> Option<V>`

查询缓存，返回值的克隆。无 runtime 时始终返回 `None`。

#### `insert(&self, key: K, value: V) -> Option<V>`

插入条目，返回旧值（如有）。

#### `remove<Q>(&self, key: &Q) -> Option<V>`

移除并返回条目。

#### `clear(&self)`

清空所有缓存条目。

#### `with_mut<R>(&self, callback: impl FnOnce(&mut LruCache<K, V>) -> R) -> R`

直接操作底层 `LruCache`。无 runtime 时会创建一个临时的无限容量缓存传给回调（回调结束后丢弃）。

> 源码位置：`codex-rs/utils/cache/src/lib.rs:107-114`

#### `blocking_lock(&self) -> Option<MutexGuard<'_, LruCache<K, V>>>`

直接获取锁。无 runtime 时返回 `None`。

### 关键内部机制：`lock_if_runtime`

```rust
fn lock_if_runtime<K, V>(m: &Mutex<LruCache<K, V>>) -> Option<MutexGuard<'_, LruCache<K, V>>> {
    tokio::runtime::Handle::try_current().ok()?;
    Some(tokio::task::block_in_place(|| m.blocking_lock()))
}
```

> 源码位置：`codex-rs/utils/cache/src/lib.rs:122-128`

此函数是所有缓存操作的基础。它先通过 `Handle::try_current()` 检查当前是否在 Tokio runtime 中：
- **是** → 使用 `block_in_place` + `blocking_lock` 同步获取锁（`block_in_place` 允许在多线程 runtime 中阻塞当前线程而不死锁）
- **否** → 返回 `None`，调用方跳过缓存直接计算

### SHA-1 内容寻址

```rust
pub fn sha1_digest(bytes: &[u8]) -> [u8; 20]
```

> 源码位置：`codex-rs/utils/cache/src/lib.rs:135-142`

独立辅助函数，计算字节切片的 SHA-1 摘要，返回 20 字节数组。用于生成基于内容的缓存键，避免仅使用文件路径作为键时可能出现的缓存过期问题。

### 边界 Case 与注意事项

- **多线程 runtime 必要性**：`block_in_place` 要求多线程 runtime（`flavor = "multi_thread"`），在单线程 runtime 中会 panic。测试中使用 `#[tokio::test(flavor = "multi_thread")]` 明确指定。
- **值必须 Clone**：`get`、`get_or_insert_with` 等读取方法要求 `V: Clone`，因为锁内返回的是克隆值而非引用。
- **`with_mut` 在无 runtime 时的行为**：不同于其他方法返回默认值 / `None`，`with_mut` 会创建一个临时的 `LruCache::unbounded()` 传给回调。回调内的操作是有效的，但回调结束后这个临时缓存会被丢弃，不会持久化任何数据。
- **LRU 驱逐**：当缓存已满时，插入新条目会驱逐最久未访问的条目（标准 LRU 语义）。`get` 操作会更新条目的最近使用时间。