# 加载动画与进度指示系统（SpinnerAnimations）

## 概述与职责

SpinnerAnimations 是 Claude Code 终端 UI 中的**加载动画与进度指示系统**，负责在模型响应、工具执行、思考等异步操作期间，向用户提供丰富的视觉反馈。它位于 `TerminalUI → UIComponents → DesignSystem` 层级中，是设计系统层的核心动画组件之一，与 `MessageRendering`（消息渲染）、`PromptInput`（输入框）等同级模块协作，共同构成 REPL 主界面的交互体验。

该系统的顶层入口是 `Spinner.tsx`（约 560 行），子目录 `Spinner/` 包含 12 个文件，实现具体的动画原语、状态管理 Hook 和多 Agent 协作场景的树形进度展示。整个模块约 2000 行代码。

### 核心设计理念

1. **性能分离**：将高频动画渲染（50ms 一帧）隔离在 `SpinnerAnimationRow` 子组件中，父组件 `SpinnerWithVerb` 仅在 props/状态变化时重渲染（每轮约 25 次 vs 383 次）
2. **渐进式信息展示**：根据终端宽度动态裁剪显示内容（计时器 → token 计数 → thinking 状态）
3. **多模式动画**：四种 `SpinnerMode` 对应不同的视觉效果（旋转字符、闪烁微光、颜色插值等）
4. **无障碍支持**：`prefersReducedMotion` 设置下切换为低频闪烁的静态圆点

---

## 模块结构

| 文件 | 职责 |
|------|------|
| `Spinner.tsx` | 主入口，`SpinnerWithVerb` 组件，整合所有动画模式和状态逻辑 |
| `Spinner/index.ts` | 桶文件，导出公共组件和工具函数 |
| `Spinner/SpinnerAnimationRow.tsx` | 50ms 动画时钟核心，承载所有帧驱动的渲染逻辑 |
| `Spinner/GlimmerMessage.tsx` | 闪烁文字效果，按 mode 分支实现不同的颜色动画 |
| `Spinner/FlashingChar.tsx` | 单字符闪烁，两色 RGB 插值 |
| `Spinner/ShimmerChar.tsx` | 单字符微光，基于位置索引的高亮切换 |
| `Spinner/SpinnerGlyph.tsx` | 旋转字符符号（`·✢✳✶✻✽`），支持 stall 变红 |
| `Spinner/TeammateSpinnerTree.tsx` | 多 Agent 协作的树形进度视图 |
| `Spinner/TeammateSpinnerLine.tsx` | 树形视图中单个 teammate 的状态行 |
| `Spinner/useShimmerAnimation.ts` | 微光动画 Hook，管理 glimmer 索引 |
| `Spinner/useStalledAnimation.ts` | 停滞检测 Hook，无新 token 3 秒后渐变为红色 |
| `Spinner/utils.ts` | 颜色工具函数（RGB 插值、HSL 转换、解析缓存） |
| `Spinner/teammateSelectHint.ts` | 常量：`'shift + ↑/↓ to select'` |

---

## 关键流程

### 1. SpinnerWithVerb → SpinnerAnimationRow 渲染流程

这是整个动画系统的主轴线：

1. REPL 屏幕传入 `mode`（`'responding'`/`'requesting'`/`'thinking'`/`'tool-use'`）等 props 给 `SpinnerWithVerb`
2. `SpinnerWithVerb` 判断是否进入 Brief 模式（`BriefSpinner`）；否则进入 `SpinnerWithVerbInner`（`Spinner.tsx:62-81`）
3. `SpinnerWithVerbInner` 从 AppState 读取任务列表、终端宽度、effort 值等，计算出 `message`（动画文本）、`messageColor`、`shimmerColor` 等静态属性
4. 将这些稳定的 props 传递给 `SpinnerAnimationRow`——这是**性能边界**，50ms 动画时钟仅在此组件内部运行（`SpinnerAnimationRow.tsx:103`）
5. `SpinnerAnimationRow` 内部：
   - 调用 `useAnimationFrame(50)` 获取动画时钟 `time`
   - 调用 `useStalledAnimation()` 检测是否超过 3 秒无新 token
   - 从 `time` 派生帧号 `frame`、微光索引 `glimmerIndex`、闪烁透明度 `flashOpacity`
   - 用 `SpinnerGlyph` 渲染旋转符号
   - 用 `GlimmerMessage` 渲染带动画效果的文字
   - 根据终端宽度渐进拼装状态信息：`suffix` → `timer` → `tokens` → `thinking`

> 源码位置：`src/components/Spinner.tsx:280-301`（主渲染输出），`src/components/Spinner/SpinnerAnimationRow.tsx:81-214`（动画核心）

### 2. 四种 SpinnerMode 的动画差异

| Mode | SpinnerGlyph 行为 | GlimmerMessage 行为 | 典型场景 |
|------|-------------------|---------------------|----------|
| `responding` | 字符帧循环（`·✢✳✶✻✽` 正反序） | 微光从右向左扫过文字（速度 200ms/步） | 模型正在流式输出 |
| `requesting` | 同上 | 微光从左向右扫过文字（速度 50ms/步，更快） | 等待 API 响应 |
| `thinking` | 同上 | 同 responding | 模型正在思考 |
| `tool-use` | 同上 | 整体文字闪烁（正弦波 RGB 插值） | 工具执行中 |

> 源码位置：`src/components/Spinner/SpinnerAnimationRow.tsx:132-139`

### 3. Stall 检测与红色渐变

`useStalledAnimation` 监测 `responseLengthRef`（响应字符长度）的变化：

1. 每帧检查 `currentResponseLength` 是否增长；增长则重置计时器（`useStalledAnimation.ts:22-27`）
2. 若 `hasActiveTools` 为 true，始终视为非停滞（`useStalledAnimation.ts:31-33`）
3. 超过 **3 秒**无新 token 后，`isStalled` 变为 true
4. 之后 **2 秒**内，`stalledIntensity` 从 0 平滑过渡到 1（`useStalledAnimation.ts:43-44`）
5. 平滑过渡通过每 50ms 一步的指数衰减实现（`diff * 0.1`），减少视觉抖动（`useStalledAnimation.ts:48-63`）
6. `SpinnerGlyph` 和 `GlimmerMessage` 使用 `stalledIntensity` 将基础颜色向 `ERROR_RED(171,43,63)` 插值

> 源码位置：`src/components/Spinner/useStalledAnimation.ts:6-75`

### 4. 多 Agent 协作树形进度

当有 in-process teammate 运行时，`SpinnerWithVerbInner` 可展示 `TeammateSpinnerTree`：

1. `TeammateSpinnerTree` 从 AppState 读取任务列表，通过 `getRunningTeammatesSorted()` 获取排序后的 teammate 列表（`TeammateSpinnerTree.tsx:44`）
2. 顶部渲染 `team-lead` 行（leader 节点），显示其动词、token 数和选择提示
3. 对每个 teammate 渲染 `TeammateSpinnerLine`，使用 Unicode 树形字符（`├─`/`└─`，选中时 `╞═`/`╘═`）
4. 每行显示 `@agentName`、活动描述、工具使用数和 token 计数
5. 支持键盘导航选择（`shift+↑/↓`）和查看（`enter`）
6. 空闲时显示 "Idle for Xs" 或 "Worked for Xs"（带冻结时间防止全部空闲时持续滚动）
7. 底部可选 `HideRow`（隐藏树形视图的选项）

响应式布局策略（`TeammateSpinnerLine.tsx:137-153`）：
- 宽屏（80+ 列）：完整名称 + 活动描述 + 统计 + 提示
- 中等（60-80 列）：完整名称 + 活动描述
- 窄屏（<60 列）：隐藏名称，仅活动描述

> 源码位置：`src/components/Spinner/TeammateSpinnerTree.tsx:21-201`，`src/components/Spinner/TeammateSpinnerLine.tsx:72-220`

---

## 函数签名与参数说明

### `SpinnerWithVerb(props: Props): React.ReactNode`

主入口组件，由 REPL 屏幕直接使用。

| 参数 | 类型 | 说明 |
|------|------|------|
| `mode` | `SpinnerMode` | 当前动画模式 |
| `loadingStartTimeRef` | `RefObject<number>` | 加载开始时间戳 |
| `totalPausedMsRef` | `RefObject<number>` | 累计暂停毫秒数 |
| `pauseStartTimeRef` | `RefObject<number \| null>` | 当前暂停开始时间 |
| `spinnerTip` | `string?` | 自定义提示文本 |
| `responseLengthRef` | `RefObject<number>` | 响应字符长度（用于 stall 检测） |
| `overrideColor` | `keyof Theme \| null?` | 覆盖消息颜色 |
| `overrideShimmerColor` | `keyof Theme \| null?` | 覆盖微光颜色 |
| `overrideMessage` | `string \| null?` | 覆盖动词文本 |
| `spinnerSuffix` | `string \| null?` | 状态栏后缀 |
| `verbose` | `boolean` | 是否始终显示计时器和 token 数 |
| `hasActiveTools` | `boolean?` | 是否有活跃工具执行（抑制 stall） |
| `leaderIsIdle` | `boolean?` | Leader 轮次已完成 |

> 源码位置：`src/components/Spinner.tsx:42-57`

### `SpinnerAnimationRow(props: SpinnerAnimationRowProps): React.ReactNode`

50ms 动画核心组件，props 在 `SpinnerAnimationRowProps` 中定义（`SpinnerAnimationRow.tsx:36-69`），除继承上层大部分 props 外，还接收：

| 参数 | 类型 | 说明 |
|------|------|------|
| `columns` | `number` | 终端宽度，用于渐进式布局 |
| `hasRunningTeammates` | `boolean` | 是否有运行中的 teammate |
| `teammateTokens` | `number` | 所有 teammate 累计 token 数 |
| `foregroundedTeammate` | `InProcessTeammateTaskState?` | 当前前台查看的 teammate |
| `thinkingStatus` | `'thinking' \| number \| null` | thinking 显示状态 |
| `effortSuffix` | `string` | effort 级别后缀 |

### `useStalledAnimation(time, currentResponseLength, hasActiveTools?, reducedMotion?)`

返回 `{ isStalled: boolean, stalledIntensity: number }`。`stalledIntensity` 范围 0-1，驱动红色渐变。

> 源码位置：`src/components/Spinner/useStalledAnimation.ts:6-75`

### `useShimmerAnimation(mode, message, isStalled)`

返回 `[ref, glimmerIndex]`。`ref` 用于绑定 DOM 元素以检测可见性，`glimmerIndex` 是当前高亮字符位置。`requesting` 模式下从左到右扫过（速度 50ms），其他模式从右到左（速度 200ms）。stalled 时返回 `glimmerIndex = -100` 禁用微光。

> 源码位置：`src/components/Spinner/useShimmerAnimation.ts:6-31`

---

## 接口/类型定义

### `SpinnerMode`

从 `Spinner/types.js` 导出（编译产物）。根据代码使用推断为：

```typescript
type SpinnerMode = 'responding' | 'requesting' | 'thinking' | 'tool-use'
```

### `RGBColor`

```typescript
type RGBColor = { r: number; g: number; b: number }
```

在 `utils.ts` 中广泛用于颜色插值计算。

---

## 关键工具函数（utils.ts）

### `getDefaultCharacters(): string[]`

根据终端和平台返回旋转字符集（`utils.ts:4-11`）：
- **Ghostty 终端**：`['·', '✢', '✳', '✶', '✻', '*']`（避免 `✽` 的渲染偏移）
- **macOS**：`['·', '✢', '✳', '✶', '✻', '✽']`
- **其他平台**：`['·', '✢', '*', '✶', '✻', '✽']`（`✳` 替换为 `*`）

### `interpolateColor(color1, color2, t): RGBColor`

在两个 RGB 颜色之间线性插值，`t` 范围 0-1。这是整个动画系统最核心的颜色计算函数，被 `FlashingChar`、`SpinnerGlyph`、`GlimmerMessage`、`SpinnerAnimationRow` 广泛使用。

> 源码位置：`src/components/Spinner/utils.ts:14-24`

### `hueToRgb(hue): RGBColor`

HSL 色相到 RGB 的转换，固定饱和度 0.7、亮度 0.6。用于语音模式波形参数。

> 源码位置：`src/components/Spinner/utils.ts:32-66`

### `parseRGB(colorStr): RGBColor | null`

解析 `rgb(r,g,b)` 字符串，带内部缓存（`Map`），避免高频帧中重复解析。

> 源码位置：`src/components/Spinner/utils.ts:68-84`

---

## 配置项与默认值

| 配置 | 来源 | 默认值 | 说明 |
|------|------|--------|------|
| `prefersReducedMotion` | `useSettings()` | `false` | 启用后使用静态圆点 `●`（2 秒周期明暗交替） |
| `spinnerTipsEnabled` | `useSettings()` | `true` | 是否在 spinner 下方显示使用提示 |
| `expandedView` | AppState | — | `'teammates'` 时显示树形视图，`'tasks'` 时显示任务列表 |
| `SHOW_TOKENS_AFTER_MS` | 常量 | `30000` | 30 秒后自动显示 token 计数和计时器 |
| `THINKING_DELAY_MS` | 常量 | `3000` | thinking 微光延迟 3 秒后开始 |
| `SHIMMER_INTERVAL_MS` | 从 `bridgeStatusUtil` 导入 | — | Brief 模式下微光步进间隔 |

---

## 边界 Case 与注意事项

- **Brief 模式分支**：`SpinnerWithVerb` 在 Kairos/Brief 特性开关启用时，渲染轻量的 `BriefSpinner`（仅显示动词 + 点号动画 + 背景任务计数），避免 Hook 数量不匹配导致的 Rules of Hooks 违规（`Spinner.tsx:59-81`）
- **Leader 空闲时的 Stall 抑制**：当 leader 已完成但 teammate 仍在运行时，将 `leaderIsIdle` 传递给 `useStalledAnimation` 作为 `hasActiveTools`，避免误触发红色变色（`SpinnerAnimationRow.tsx:123-130`）
- **Teammate 组件的惰性导入**：`TeammateSpinnerTree`/`TeammateSpinnerLine` **不从 `index.ts` 导出**，而是在 `Spinner.tsx` 和 `REPL.tsx` 中直接 import，以支持死代码消除（`index.ts:9-10`）
- **Token 计数平滑动画**：`SpinnerAnimationRow` 内部用 `tokenCounterRef` 实现数字递增动画（每帧增 3-50），避免大段 token 到达时数字跳变（`SpinnerAnimationRow.tsx:141-158`）
- **Thinking 状态的最小显示时间**：thinking 状态切换时确保至少展示 2 秒，然后显示 "thought for Ns" 持续 2 秒后消失，避免快速闪烁（`Spinner.tsx:127-159`）
- **视口不可见时的性能优化**：`useShimmerAnimation` 在 stalled 状态下传 `null` 给 `useAnimationFrame` 以取消 setInterval 订阅，因为微光此时不可见（`useShimmerAnimation.ts:12-17`）