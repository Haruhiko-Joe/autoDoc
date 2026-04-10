# 构建工具链与编译基础设施（BuildSystem）

## 概述与职责

BuildSystem 是 Claude Code 项目的构建与编译基础设施层，隶属于顶层架构中的 **Infrastructure** 模块。它解决的核心问题是：Claude Code 的生产构建依赖 Bun 运行时的编译时内建能力（`feature()`、`MACRO`、`bun:bundle`），而 BuildSystem 提供了一套基于 esbuild 的**替代构建管道**，使项目在标准 Node.js 环境下也能完成打包。

同时，该模块还包含 4 个原生 N-API 模块的 TypeScript 封装（vendor/）、3 个纯 TypeScript 引擎用于替代原生依赖（native-ts/），以及一组构建时辅助脚本（utils/）。

在整体架构中，Infrastructure 被 Services、MemorySystem 等上层模块依赖，提供底层工具函数、类型定义和构建产物。BuildSystem 是 Infrastructure 的子模块之一，与同级的 `src/utils/`（通用工具函数）和 `src/types/`（全局类型）并列。

---

## 关键流程

### 1. esbuild 构建主流程（`scripts/build.mjs`）

这是最核心的构建脚本，完整实现了从源码到可执行产物的 4 阶段管道：

**Phase 1 — 复制源码**：将 `src/` 复制到 `build-src/`，确保原始源码不被修改（`scripts/build.mjs:56-59`）。

**Phase 2 — 源码转换**：遍历所有 `.ts/.tsx/.js/.jsx` 文件，执行 3 类替换：
- `feature('FEATURE_FLAG')` → `false`：将 Bun 编译时特性门控替换为常量 false，使所有 feature-gated 分支被 tree-shake 掉（`scripts/build.mjs:87-90`）
- `MACRO.VERSION` 等 → 字符串字面量：将 Bun 的 `--define` 编译时宏替换为硬编码值（`scripts/build.mjs:93-98`）
- 移除 `import { feature } from 'bun:bundle'`：删除 Bun 专有模块导入（`scripts/build.mjs:101-104`）

**Phase 3 — 创建入口包装器**：生成 `build-src/entry.ts`，简单导入 `./src/entrypoints/cli.tsx`（`scripts/build.mjs:123-128`）。

**Phase 4 — 迭代式打包**：运行最多 5 轮 esbuild → 收集缺失模块 → 创建桩文件 → 重试的循环（`scripts/build.mjs:144-229`）。每轮解析 esbuild 的 `Could not resolve` 错误，根据文件类型生成对应桩（`.json` → `{}`，`.txt/.md` → 空文件，`.ts/.tsx` → 导出空函数）。最终产出 `dist/cli.js`（ESM 格式，Node 18+ target，带 sourcemap）。

### 2. 源码预处理流程（`scripts/prepare-src.mjs`）

与 `build.mjs` 的 Phase 2 类似但**直接修改 `src/` 目录**（而非副本）。额外功能包括：
- 将 `bun:bundle` 导入替换为相对路径指向 `stubs/bun-bundle.js`，并根据文件深度自动计算正确的相对路径（`scripts/prepare-src.mjs:40-51`）
- 创建 `stubs/bun-ffi.ts` 桩（`scripts/prepare-src.mjs:94-98`）
- 生成 `stubs/global.d.ts` 类型声明（`scripts/prepare-src.mjs:101-113`）

### 3. 桩模块生成流程（`scripts/stub-modules.mjs`）

独立的桩生成工具，先执行一次 esbuild 收集所有缺失模块，然后通过 `grep` 在源码中定位每个缺失模块的导入者，解析出正确的绝对路径后创建桩文件。支持类型声明桩（`.d.ts` → `export {}`）、文本资源桩、JS/TS 模块桩。创建完成后自动尝试一次完整打包（`scripts/stub-modules.mjs:46-121`）。

### 4. 备选构建脚本（`scripts/transform.mjs`）

采用不同策略：在入口包装器中注入 `globalThis.MACRO` 对象而非逐文件替换宏引用，同时将 `stubs/` 目录复制到 `build-src/` 中。相比 `build.mjs` 的逐文件替换方案，这种方式更简洁但依赖运行时全局变量（`scripts/transform.mjs:73-93`）。

---

## 编译时桩（stubs/）

### `bun-bundle.ts`

Bun 的 `bun:bundle` 模块的替代桩，导出 `feature()` 函数，永远返回 `false`：

```typescript
export function feature(_flag: string): boolean {
  return false
}
```

> 源码位置：`stubs/bun-bundle.ts:1-4`

这使得所有 `feature('FEATURE_FLAG')` 守卫的代码分支在打包时被静态消除。

### `macros.ts` / `macros.d.ts`

提供 `MACRO` 全局常量的类型声明，包含 `VERSION`、`BUILD_TIME`、`FEEDBACK_CHANNEL`、`NATIVE_PACKAGE_URL` 等字段。在 Bun 原生构建中这些值通过 `--define` 注入，在 esbuild 构建中通过源码替换或 `globalThis` 注入。

### `global.d.ts`

全局类型声明文件，声明 `MACRO` 常量的类型结构，使 TypeScript 编译器不会报错。额外包含 `ISSUES_EXPLAINER_URL`、`FEEDBACK_CHANNEL_URL` 等字段（`stubs/global.d.ts:1-16`）。

---

## 原生模块封装（vendor/）

vendor/ 目录包含 4 个原生 N-API 模块的 TypeScript 加载器。它们共享相同的懒加载模式：首次调用时才 `require()` `.node` 二进制文件，支持通过环境变量指定路径（打包模式）或从相对目录加载（开发模式），且在不支持的平台上优雅降级返回 `null`。

### 音频捕获（`vendor/audio-capture-src/index.ts`）

提供麦克风录音和音频播放能力。

| 导出函数 | 说明 |
|---------|------|
| `isNativeAudioAvailable()` | 检测原生音频模块是否可用 |
| `startNativeRecording(onData, onEnd)` | 开始录音，通过回调返回 PCM 数据 |
| `stopNativeRecording()` | 停止录音 |
| `isNativeRecordingActive()` | 检查是否正在录音 |
| `startNativePlayback(sampleRate, channels)` | 开始播放 |
| `writeNativePlaybackData(data)` | 写入播放数据 |
| `stopNativePlayback()` | 停止播放 |
| `microphoneAuthorizationStatus()` | 返回麦克风权限状态（macOS TCC: 0=未确定, 1=受限, 2=拒绝, 3=已授权） |

支持平台：macOS、Linux、Windows。加载路径优先级：`AUDIO_CAPTURE_NODE_PATH` 环境变量 → `vendor/audio-capture/{arch}-{platform}/` → 相对路径回退（`vendor/audio-capture-src/index.ts:36-71`）。

### 图像处理（`vendor/image-processor-src/index.ts`）

提供图像处理能力，并封装了一个兼容 `sharp` API 的链式调用接口。

核心导出：
- `getNativeModule(): NativeModule | null`：获取原生模块实例，支持 `processImage()`、`readClipboardImage?()` 和 `hasClipboardImage?()` 方法
- `sharp(input: Buffer): SharpInstance`：创建兼容 sharp API 的图像处理实例，支持 `metadata()`、`resize()`、`jpeg()`、`png()`、`webp()`、`toBuffer()` 链式调用

`sharp()` 内部采用延迟执行模式——`resize()`、`jpeg()` 等操作只是记录到队列中，直到 `toBuffer()` 时才一次性执行所有挂起的操作（`vendor/image-processor-src/index.ts:80-161`）。

### 键盘修饰符（`vendor/modifiers-napi-src/index.ts`）

检测当前按下的键盘修饰键（Ctrl、Shift、Alt 等），仅限 macOS。

| 导出函数 | 说明 |
|---------|------|
| `getModifiers(): string[]` | 返回当前按下的修饰键列表 |
| `isModifierPressed(modifier): boolean` | 检查指定修饰键是否按下 |
| `prewarm(): void` | 预加载原生模块，避免首次使用延迟 |

支持通过 `MODIFIERS_NODE_PATH` 环境变量指定模块路径（`vendor/modifiers-napi-src/index.ts:23-37`）。

### URL 处理（`vendor/url-handler-src/index.ts`）

监听 macOS URL 事件（Apple Event `kAEGetURL`），用于 OAuth 回调等场景。

```typescript
export function waitForUrlEvent(timeoutMs: number): string | null
```

初始化 NSApplication，注册 URL 事件处理器，在指定超时内泵入事件循环等待 URL。仅 macOS 可用，其他平台返回 `null`（`vendor/url-handler-src/index.ts:52-58`）。

---

## 构建辅助脚本（utils/）

`utils/` 目录包含 3 个由构建系统自动生成的桩文件：

- `attributionHooks.js`：署名钩子桩
- `udsClient.js`：Unix Domain Socket 客户端桩
- `systemThemeWatcher.js`：系统主题监听器桩

这些文件导出空函数，是构建过程中为解决模块缺失而自动生成的最小桩实现（`utils/attributionHooks.js:1-3`）。

---

## 纯 TypeScript 引擎（src/native-ts/）

native-ts/ 包含 3 个纯 TypeScript 实现的引擎，用于替代对应的 Rust N-API 原生模块，消除原生依赖。

### 文件索引引擎（`src/native-ts/file-index/index.ts`）

纯 TypeScript 移植自 Rust 的 `vendor/file-index-src`（基于 nucleo 模糊搜索库）。

**核心类 `FileIndex`**：

```typescript
class FileIndex {
  loadFromFileList(fileList: string[]): void
  loadFromFileListAsync(fileList: string[]): { queryable: Promise<void>; done: Promise<void> }
  search(query: string, limit: number): SearchResult[]
}
```

**关键设计决策**：

1. **位图预过滤**：为每个路径预计算 a-z 字母的 26 位位图（`charBits`），搜索时通过位与运算 O(1) 排除不可能匹配的路径，对稀有字符查询可过滤 90%+ 候选（`src/native-ts/file-index/index.ts:156-167`）

2. **融合 indexOf 扫描**：将位置查找和评分合并到单次扫描中，利用 JS 引擎对 `indexOf` 的 SIMD 优化，同时累积间隙惩罚和连续匹配奖励（`src/native-ts/file-index/index.ts:218-232`）

3. **Top-K 堆**：维护大小为 `limit` 的有序数组，避免对全量匹配排序。结合 gap-bound 提前拒绝——如果最佳理论得分都无法超越当前阈值，直接跳过边界评分阶段（`src/native-ts/file-index/index.ts:236-241`）

4. **异步构建**：`loadFromFileListAsync` 每 4ms 让出事件循环，支持 270k+ 文件的大型仓库不阻塞主线程，且第一个 chunk 索引完成后即可开始搜索（返回部分结果）（`src/native-ts/file-index/index.ts:83-93`）

5. **评分语义**：最终 score 为位置分数（0.0 最佳），包含 `test` 的路径受 1.05× 惩罚使非测试文件排名更高（`src/native-ts/file-index/index.ts:283-284`）。Smart case：纯小写查询不区分大小写，含大写则区分。

### 颜色差异引擎（`src/native-ts/color-diff/index.ts`）

纯 TypeScript 移植自 Rust 的 `vendor/color-diff-src`，提供语法高亮的彩色 diff 渲染。

**核心类**：
- `ColorDiff`：接收 unified diff 的 hunk 列表，输出带语法高亮和词级差异标记的 ANSI 彩色行
- `ColorFile`：单文件语法高亮渲染
- `getSyntaxTheme(themeName): SyntaxTheme`：获取语法主题信息

**与原生模块的语义差异**：
- 语法高亮使用 highlight.js 替代 syntect（Rust），大部分 token 颜色一致，但 hljs 不覆盖纯标识符和操作符
- 不支持 `BAT_THEME` 环境变量（hljs 无 bat 主题集）
- highlight.js 采用**懒加载**，避免 190+ 语法文件在模块加载时阻塞 100-200ms（`src/native-ts/color-diff/index.ts:35-42`）

**主题系统**：内置 3 套配色方案——Monokai Extended（暗色）、GitHub（亮色）、ANSI（终端色），每套定义了增删行/词的背景色、装饰色和作用域→颜色映射。支持色觉障碍友好的 daltonized 变体（`src/native-ts/color-diff/index.ts:282-362`）。

**颜色模式**：自动检测 `COLORTERM` 环境变量，支持 truecolor（24 位）、256 色和 ANSI 基础色 3 种输出模式。256 色模式实现了 `ansi_colours` crate 的 RGB→xterm-256 近似算法（`src/native-ts/color-diff/index.ts:104-127`）。

### Yoga 布局引擎（`src/native-ts/yoga-layout/`）

纯 TypeScript 移植自 Meta 的 Yoga 布局引擎（C++ 实现），供 Ink 终端 UI 框架的布局系统使用。

**覆盖的 Flexbox 特性**（`src/native-ts/yoga-layout/index.ts:8-29`）：
- flex-direction（row/column + reverse）
- flex-grow / flex-shrink / flex-basis
- align-items / align-self / align-content
- justify-content（全部 6 个值）
- margin / padding / border / gap
- width / height / min / max（point、percent、auto）
- position: relative / absolute
- display: flex / none / contents
- flex-wrap: wrap / wrap-reverse
- baseline 对齐
- margin: auto

**未实现**（Ink 不使用）：aspect-ratio、box-sizing: content-box、RTL 方向。

**类型系统**：`enums.ts` 导出 16 个枚举常量对象（`Align`、`FlexDirection`、`Justify`、`Edge` 等），值与上游 Yoga C++ 完全一致（`src/native-ts/yoga-layout/enums.ts:1-135`）。

**核心数据结构**：
- `Style`：输入样式，包含 9-edge 数组（Left/Top/Right/Bottom/Start/End/Horizontal/Vertical/All）用于 margin/padding/border/position
- `Layout`：计算结果，包含 left/top/width/height 和解析后的 4 边 border/padding/margin
- `Value`：带单位的值（`{ unit: Unit, value: number }`），支持 Point、Percent、Auto、Undefined

**边解析优化**：`resolveEdges4Into()` 将 4 条物理边的解析合并为单次遍历，预先提取共享回退值（Horizontal/Vertical/All/Start/End），避免每次 `layoutNode()` 调用分配新数组（`src/native-ts/yoga-layout/index.ts:269-299`）。

---

## 配置项与默认值

| 配置项 | 位置 | 默认值 | 说明 |
|--------|------|--------|------|
| `VERSION` | build.mjs / transform.mjs | `'2.1.88'` | 构建版本号，注入到 `MACRO.VERSION` |
| `MAX_ROUNDS` | build.mjs | `5` | 迭代式桩生成的最大轮次 |
| `--target` | esbuild 参数 | `node18` | 目标 Node.js 版本 |
| `--format` | esbuild 参数 | `esm` | 输出模块格式 |
| `--packages` | esbuild 参数 | `external` | 将 npm 包标记为外部依赖 |
| `AUDIO_CAPTURE_NODE_PATH` | 环境变量 | 无 | 音频捕获 .node 二进制路径 |
| `MODIFIERS_NODE_PATH` | 环境变量 | 无 | 键盘修饰符 .node 二进制路径 |
| `URL_HANDLER_NODE_PATH` | 环境变量 | 无 | URL 处理 .node 二进制路径 |
| `CHUNK_MS` | file-index | `4` | 异步索引构建的时间片（毫秒） |
| `TOP_LEVEL_CACHE_LIMIT` | file-index | `100` | 空查询时返回的顶层目录缓存上限 |
| `MAX_QUERY_LEN` | file-index | `64` | 搜索查询最大字符数 |

---

## 边界 Case 与注意事项

- **构建脚本互斥**：`build.mjs` 操作 `build-src/` 副本，`prepare-src.mjs` 直接修改 `src/`。两者不应混用，否则会导致源码被双重转换
- **feature() 语义差异**：所有 `feature()` 调用在 esbuild 构建中被替换为 `false`，意味着所有 Bun 编译时特性门控的功能在替代构建中均不可用
- **原生模块平台限制**：modifiers-napi 和 url-handler 仅支持 macOS；audio-capture 支持 macOS/Linux/Windows；image-processor 的剪贴板功能仅限 macOS darwin 构建
- **image-processor 延迟加载**：采用 `loadAttempted` 标志避免重复 dlopen，因为 `.node` 二进制链接 CoreGraphics/ImageIO，同步加载会阻塞启动
- **highlight.js 懒加载**：color-diff 引擎延迟加载 highlight.js 以避免 190+ 语法文件的注册开销（50MB，100-200ms），这是因为 Windows CI 上的 GC 暂停问题（PR #24150）
- **file-index 部分搜索**：异步构建期间 `search()` 只搜索已就绪的 `readyCount` 前缀，返回部分结果而非等待全部索引完成