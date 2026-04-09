# 图像处理模块（ImageProcessing）

## 概述与职责

图像处理模块（crate 名 `codex-utils-image`）是 SharedUtils 层的基础工具组件，负责将磁盘上的图像文件加工为适合嵌入 LLM prompt 的 base64 data URL。它在 Codex 系统中扮演"图像预处理器"的角色——当用户在对话中附带截图或图片时，该模块确保图像尺寸合理、格式正确，并以最小的重复计算完成编码。

同级的兄弟模块包括路径处理、PTY 管理、字符串工具、缓存等其他通用工具 crate，它们共同构成 Codex 的共享基础设施层。

## 关键流程

### 图像加载与编码的完整流程

核心入口是 `load_for_prompt_bytes()` 函数，完整处理链如下：

1. **计算内容摘要**：对传入的 `file_bytes` 调用 `sha1_digest()` 生成 20 字节 SHA-1 哈希，与 `PromptImageMode` 组合为缓存 key（`src/lib.rs:63-66`）
2. **查询 LRU 缓存**：通过 `IMAGE_CACHE.get_or_try_insert_with()` 查找缓存。命中则直接返回，未命中则执行后续处理（`src/lib.rs:68`）
3. **格式探测**：调用 `image::guess_format()` 从文件头字节嗅探格式，仅识别 PNG / JPEG / GIF / WebP 四种格式（`src/lib.rs:69-75`）
4. **解码图像**：用 `image::load_from_memory()` 将字节解码为 `DynamicImage`（`src/lib.rs:77-78`）
5. **尺寸判断与处理**（分三条路径）：
   - **Original 模式 或 尺寸在限制内**：如果源格式可直接透传（PNG/JPEG/WebP），则零拷贝复用原始字节；如果是 GIF 等不可透传格式，则重新编码为 PNG（`src/lib.rs:83-101`）
   - **ResizeToFit 模式 且 超出尺寸限制**：调用 `image.resize(MAX_WIDTH, MAX_HEIGHT, FilterType::Triangle)` 等比缩放，然后编码为源格式（若可透传）或 PNG（`src/lib.rs:102-115`）
6. **返回 `EncodedImage`**：包含编码后的字节、MIME 类型和最终宽高

### 编码策略

`encode_image()` 函数根据目标格式选择编码器（`src/lib.rs:130-186`）：

| 目标格式 | 编码器 | 特殊配置 |
|----------|--------|----------|
| PNG | `PngEncoder` | 转换为 RGBA8 后编码 |
| JPEG | `JpegEncoder` | 质量设为 85 |
| WebP | `WebPEncoder` | 使用无损模式（`new_lossless`），转为 RGBA8 |
| 其他 | 回退为 PNG | — |

### 格式透传规则

`can_preserve_source_bytes()` 决定是否可以直接复用原始字节（`src/lib.rs:121-128`）：PNG、JPEG、WebP 可透传；GIF 不可透传（因为库仅支持非动画 GIF），会被重新编码为 PNG。

## 函数签名与参数说明

### `load_for_prompt_bytes(path, file_bytes, mode) -> Result<EncodedImage, ImageProcessingError>`

主入口函数。接收已读取的文件字节，处理后返回编码图像。

- **`path: &Path`**：文件路径，仅用于错误消息和 MIME 猜测，不会再次读取磁盘
- **`file_bytes: Vec<u8>`**：文件的完整原始字节
- **`mode: PromptImageMode`**：处理模式（`ResizeToFit` 或 `Original`）
- **返回值**：`EncodedImage` 或 `ImageProcessingError`

> 源码位置：`src/lib.rs:56-119`

### `EncodedImage::into_data_url(self) -> String`

将编码图像转换为 `data:{mime};base64,{data}` 格式的 data URL，可直接嵌入 LLM prompt。

> 源码位置：`src/lib.rs:35-38`

## 类型定义

### `EncodedImage`

处理完成后的图像数据容器（`src/lib.rs:27-32`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `bytes` | `Vec<u8>` | 编码后的图像字节 |
| `mime` | `String` | MIME 类型（如 `image/png`） |
| `width` | `u32` | 最终宽度（像素） |
| `height` | `u32` | 最终高度（像素） |

### `PromptImageMode`

控制图像处理行为的枚举（`src/lib.rs:42-45`）：

| 变体 | 行为 |
|------|------|
| `ResizeToFit` | 超出 2048×768 时等比缩放 |
| `Original` | 保持原始尺寸不变 |

### `ImageProcessingError`

错误类型枚举，定义在 `src/error.rs:7-28`：

| 变体 | 含义 |
|------|------|
| `Read { path, source }` | 文件读取失败 |
| `Decode { path, source }` | 图像解码失败 |
| `Encode { format, source }` | 编码为目标格式失败 |
| `UnsupportedImageFormat { mime }` | 不支持的图像格式 |

辅助方法：
- `decode_error(path, source)`：智能构造错误——解码错误返回 `Decode`，其他错误通过 `mime_guess` 推断 MIME 后返回 `UnsupportedImageFormat`（`src/error.rs:31-44`）
- `is_invalid_image()`：判断是否为解码类错误（`src/error.rs:46-54`）

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|-----|------|
| `MAX_WIDTH` | 2048 | 缩放目标最大宽度（像素） |
| `MAX_HEIGHT` | 768 | 缩放目标最大高度（像素） |
| 缓存容量 | 32 | LRU 缓存最多保存 32 个条目 |
| JPEG 质量 | 85 | JPEG 编码质量（0-100） |

> 源码位置：`src/lib.rs:20-21`（尺寸常量），`src/lib.rs:54`（缓存容量），`src/lib.rs:159`（JPEG 质量）

## 缓存机制

模块使用全局静态的 `BlockingLruCache<ImageCacheKey, EncodedImage>` 实现内容寻址缓存（`src/lib.rs:53-54`）：

- **缓存 key** 由文件内容的 SHA-1 摘要（20 字节）和处理模式组成，因此同一文件在不同模式下会各缓存一份
- **内容寻址**意味着即使文件路径不同，只要内容相同就会命中缓存；反之，同一路径的文件内容变化后会生成新的缓存条目
- 底层实现来自 `codex-utils-cache` crate 的 `BlockingLruCache`，线程安全（内部使用 `Mutex`）
- 容量固定为 32 条，超出时淘汰最久未使用的条目

## 边界 Case 与注意事项

- **GIF 格式不透传**：GIF 图像会被解码后重新编码为 PNG。这是因为底层 `image` 库仅支持非动画 GIF，直接透传可能丢失动画帧信息，所以选择统一转码
- **缩放算法**：使用 `FilterType::Triangle`（双线性插值），在速度和质量之间取得平衡
- **`resize` 的行为**：`DynamicImage::resize()` 保持宽高比不变，在 `MAX_WIDTH × MAX_HEIGHT` 的矩形内等比缩放，不会拉伸变形
- **WebP 使用无损编码**：编码 WebP 时调用 `new_lossless()`，保证像素精确还原
- **路径参数不触发 IO**：`load_for_prompt_bytes` 的 `path` 参数仅作为错误上下文，文件字节需要由调用方预先读取并传入
- **不支持的格式处理**：如果 `guess_format` 返回非 PNG/JPEG/GIF/WebP（或探测失败），`format` 被设为 `None`，图像仍会尝试解码，成功后以 PNG 格式编码输出