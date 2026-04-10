# 语音输入系统 Hooks

## 概述与职责

语音输入系统（VoiceInput）是 Claude Code 终端 UI 中的语音交互模块，位于 **TerminalUI → Hooks** 层级下。它提供了**按住说话**（hold-to-talk）和**焦点驱动**（focus-mode）两种语音输入模式，将用户语音实时转录为文本并注入到终端输入框中。

整个系统由三个 Hook 协作完成：

- **`useVoiceEnabled`**：守门人——判断语音功能是否满足启用条件
- **`useVoice`**（1144 行）：核心引擎——管理音频录制、WebSocket 连接、流式 STT 转录、释放检测和错误重试
- **`useVoiceIntegration`**：顶层编排——将语音状态注入 UI 输入框，处理按键激活逻辑和临时转录文本的实时预览

同级兄弟模块包括输入处理 Hooks（useTextInput、useVimInput）、历史导航、IDE 集成、远程会话等 80+ 个自定义 Hooks。语音模块通过 `bun:bundle` 的 `feature('VOICE_MODE')` 编译时常量实现死代码消除——当 VOICE_MODE 关闭时，`useVoice` 不会被打包。

---

## 关键流程

### 1. 语音功能启用判断（useVoiceEnabled）

`useVoiceEnabled` 通过三重检查决定是否启用语音：

1. **用户意图**：`AppState.settings.voiceEnabled === true`
2. **认证状态**：调用 `hasVoiceAuth()` 检查 Claude.ai OAuth token（通过 `useMemo` 缓存，仅在 `authVersion` 变更时重新计算——因为冷调用涉及同步 `security` 进程 spawn，约 60ms/次）
3. **GrowthBook 开关**：调用 `isVoiceGrowthBookEnabled()` 检查远程特性开关（轻量缓存查找，不走 memo，确保中途关闭能立即生效）

三者全部为 `true` 时才返回 `true`。

> 源码位置：`src/hooks/useVoiceEnabled.ts:19-25`

### 2. Hold-to-Talk 完整流程

这是最核心的用户交互路径，横跨 `useVoiceKeybindingHandler` → `useVoiceIntegration` → `useVoice` 三层：

**阶段一：按键激活（useVoiceKeybindingHandler）**

1. 用户按住配置的语音键（默认空格，可通过 `voice:pushToTalk` keybinding 自定义）
2. 对于**裸字符绑定**（如空格）：前 `WARMUP_THRESHOLD`（2）次按键正常输入，之后快速连续按键被吞掉，达到 `HOLD_THRESHOLD`（5）次时激活语音
3. 对于**修饰键组合**（如 `meta+k`）：第一次按下即激活——修饰键组合不可能是误触
4. 激活时调用 `stripTrailing()` 清理预热阶段泄漏到输入框的字符，并设置语音锚点（`voicePrefix` / `voiceSuffix`）记录光标位置

> 源码位置：`src/hooks/useVoiceIntegration.tsx:468-599`

**阶段二：录音与 WebSocket 连接（useVoice.startRecordingSession）**

1. 状态同步切换为 `'recording'`（必须在任何 `await` 之前，防止竞态）
2. 调用 `voiceModule.checkRecordingAvailability()` 检查麦克风可用性
3. **立即开始录音**——音频数据缓存在 `audioBuffer` 中，消除 OAuth + WS 连接的 1-2s 延迟
4. 每个音频 chunk 计算 RMS 振幅（`computeLevel()`），推送到 `voiceAudioLevels` 供 UI 波形可视化
5. 并行发起 WebSocket 连接：获取 keyterms → 调用 `connectVoiceStream()` 连接 Anthropic voice_stream 端点
6. WebSocket onReady 时：将缓冲的音频分片（~32KB/片）flush 到服务端，后续音频直接发送

> 源码位置：`src/hooks/useVoice.ts:633-1011`

**阶段三：流式转录**

1. `onTranscript(text, isFinal)` 回调接收转录结果
2. 非 final 的 interim 文本实时更新到 `voiceInterimTranscript`
3. final 文本累积到 `accumulatedRef`，interim 预览显示 "已确认文本 + 当前 interim"
4. `useVoiceIntegration` 的 `useEffect` 监听 `voiceInterimTranscript`，实时将转录插入到输入框的光标位置（保留前后用户文本）

> 源码位置：`src/hooks/useVoice.ts:783-839`、`src/hooks/useVoiceIntegration.tsx:253-280`

**阶段四：释放检测与结束**

1. `handleKeyEvent()` 在每次按键（含自动重复）时重置 `releaseTimer`
2. 当按键间隔超过 `RELEASE_TIMEOUT_MS`（200ms）时，判定为松开按键
3. 如果从未检测到自动重复，`REPEAT_FALLBACK_MS`（600ms，修饰键为 2000ms）后兜底触发释放
4. `finishRecording()` 停止录音 → 发送 finalize 指令 → 等待 WebSocket 关闭 → 组装最终转录文本
5. 转录文本通过 `onTranscript` 回调注入输入框

> 源码位置：`src/hooks/useVoice.ts:1013-1127`、`src/hooks/useVoice.ts:322-522`

### 3. Focus Mode（焦点驱动录音）

当启用 focus mode 时，终端窗口获得焦点自动开始录音，失去焦点自动停止——支持多窗口"语音跟随焦点"工作流。

1. `useEffect` 监听 `isFocused` 状态变化
2. 获得焦点 → 设置 `focusTriggeredRef = true` → 启动录音会话 → 启动静默计时器
3. 每个 final 转录**立即 flush**（`onTranscriptRef.current(text)`），不等松开
4. 每次语音活动（final/interim）重置 `FOCUS_SILENCE_TIMEOUT_MS`（5秒）计时器
5. 5秒无语音 → 自动断开 WebSocket（释放连接资源）
6. 失去焦点 → 清除静默超时标志 → 下次获焦重新启动

> 源码位置：`src/hooks/useVoice.ts:572-630`

### 4. Silent-Drop 重放机制

约 1% 的会话遇到 CE pod 粘连问题（接受音频但不返回转录）。系统的应对策略：

1. `finalize()` 因 `no_data_timeout` 超时返回
2. 检查条件：有音频信号 + WebSocket 已连接 + 转录为空 + 非 focus 模式 + 未曾重试
3. 将完整音频缓冲区（`fullAudioRef`，最大约 2MB）在新 WebSocket 上重放
4. 250ms 退避后建立新连接，分片发送缓冲音频，再次 finalize

> 源码位置：`src/hooks/useVoice.ts:376-454`

---

## 函数签名与参数说明

### `useVoiceEnabled(): boolean`

判断语音功能是否启用。无参数。

> 源码位置：`src/hooks/useVoiceEnabled.ts:19-25`

### `useVoice(options: UseVoiceOptions): UseVoiceReturn`

核心语音 Hook。

**参数（UseVoiceOptions）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `onTranscript` | `(text: string) => void` | 转录完成回调，接收最终文本 |
| `onError` | `(message: string) => void` | 可选，错误通知回调 |
| `enabled` | `boolean` | 是否启用语音功能 |
| `focusMode` | `boolean` | 是否启用焦点驱动录音模式 |

**返回值（UseVoiceReturn）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `state` | `'idle' \| 'recording' \| 'processing'` | 当前语音状态 |
| `handleKeyEvent` | `(fallbackMs?: number) => void` | 按键事件处理器，每次按键时调用 |

> 源码位置：`src/hooks/useVoice.ts:199-1144`

### `useVoiceIntegration(args: UseVoiceIntegrationArgs): UseVoiceIntegrationResult`

顶层编排 Hook，桥接语音引擎与 UI 输入框。

**参数（UseVoiceIntegrationArgs）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `setInputValueRaw` | `Dispatch<SetStateAction<string>>` | 输入框值设置器 |
| `inputValueRef` | `RefObject<string>` | 输入框当前值引用 |
| `insertTextRef` | `RefObject<InsertTextHandle \| null>` | 光标感知的文本插入句柄 |

**返回值（UseVoiceIntegrationResult）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `stripTrailing` | `(maxStrip: number, opts?: StripOpts) => number` | 清理尾部按键字符，返回剩余数量 |
| `resetAnchor` | `() => void` | 重置语音锚点（激活失败时调用） |
| `handleKeyEvent` | `(fallbackMs?: number) => void` | 透传 useVoice 的按键处理器 |
| `interimRange` | `InterimRange \| null` | 输入框中 interim 转录文本的字符范围（用于 UI 变暗显示） |

> 源码位置：`src/hooks/useVoiceIntegration.tsx:118-347`

### `useVoiceKeybindingHandler(options): { handleKeyDown: (e: KeyboardEvent) => void }`

处理按键激活的 Hook，负责区分正常打字与按住触发。

> 源码位置：`src/hooks/useVoiceIntegration.tsx:373-666`

### `VoiceKeybindingHandler(props): null`

临时 shim 组件，包装 `useVoiceKeybindingHandler` 供旧 JSX 调用者使用。待 REPL.tsx 迁移到 `handleKeyDown` 后移除。

> 源码位置：`src/hooks/useVoiceIntegration.tsx:673-676`

### `normalizeLanguageForSTT(language: string | undefined): { code: string; fellBackFrom?: string }`

将用户的语言偏好规范化为 voice_stream 端点支持的 BCP-47 代码。

- 支持语言名（英文/原文皆可）和 BCP-47 代码
- 不支持的语言回退到 `'en'`，并在 `fellBackFrom` 中记录原始输入

> 源码位置：`src/hooks/useVoice.ts:121-134`

### `computeLevel(chunk: Buffer): number`

从 16-bit 有符号 PCM 缓冲区计算 RMS 振幅，返回 0-1 的归一化值（经 sqrt 曲线调整，使安静级别在波形中占更多视觉空间）。

> 源码位置：`src/hooks/useVoice.ts:185-197`

---

## 接口与类型定义

### `VoiceState`

```typescript
type VoiceState = 'idle' | 'recording' | 'processing'
```

三态状态机：空闲 → 录音中 → 处理中（等待转录完成）→ 空闲。

### `InsertTextHandle`

```typescript
type InsertTextHandle = {
  insert: (text: string) => void
  setInputWithCursor: (value: string, cursor: number) => void
  cursorOffset: number
}
```

光标感知的文本操作接口，由 PromptInput 组件提供。

### `InterimRange`

```typescript
type InterimRange = { start: number; end: number }
```

输入框中尚未确认的 interim 转录文本的字符范围，UI 层据此将该范围文本变暗显示。

### `StripOpts`

```typescript
type StripOpts = {
  char?: string    // 要清理的字符（默认空格）
  anchor?: boolean // 是否在清理位置设置语音锚点
  floor?: number   // 最少保留的尾部字符数
}
```

---

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|-----|------|
| `RELEASE_TIMEOUT_MS` | 200ms | 按键间隔超过此值判定为松开 |
| `REPEAT_FALLBACK_MS` | 600ms | 未检测到自动重复时的兜底超时 |
| `FIRST_PRESS_FALLBACK_MS` | 2000ms | 修饰键组合首次按下的兜底超时（覆盖 macOS 最大初始重复延迟） |
| `FOCUS_SILENCE_TIMEOUT_MS` | 5000ms | Focus 模式下无语音自动断开超时 |
| `AUDIO_LEVEL_BARS` | 16 | 波形可视化柱状条数量 |
| `HOLD_THRESHOLD` | 5 | 裸字符绑定需要的连续快速按键数 |
| `WARMUP_THRESHOLD` | 2 | 开始显示预热反馈的按键数 |
| `RAPID_KEY_GAP_MS` | 120ms | 区分按住和正常打字的按键间隔阈值 |
| `DEFAULT_STT_LANGUAGE` | `'en'` | 默认 STT 语言 |
| `SUPPORTED_LANGUAGE_CODES` | 19 种语言 | 支持 en/es/fr/ja/de/pt/it/ko/hi/id/ru/pl/tr/nl/uk/el/cs/da/sv/no |

用户侧配置：
- `settings.voiceEnabled`：启用/禁用语音
- `settings.language`：STT 语言偏好
- keybinding `voice:pushToTalk`：自定义语音激活键（默认空格）

---

## 边界 Case 与注意事项

### 原生模块延迟加载
- `voice.ts`（包含 `audio-capture-napi` 原生音频模块）在语音功能首次使用时才 lazy import
- macOS 上加载原生模块会触发 TCC 麦克风权限弹窗，必须延迟到用户明确启用语音后
- `require('audio-capture.node')` 是同步 dlopen，阻塞事件循环 1-8 秒（`src/hooks/useVoice.ts:524-536`）

### 按键绑定的兼容性限制
- **修饰键+空格不工作**：终端将其解析为 NUL（ctrl+backtick），无法正确匹配
- **chord 组合键不工作**：需要按住持续触发，而 chord 是离散序列
- 绑定验证会对上述情况发出警告

### Session 代际（generation）防护
- `sessionGenRef` 和 `attemptGenRef` 通过递增计数实现会话隔离
- 防止僵尸 WebSocket（慢连接的上一次会话）在新会话中覆盖 `connectionRef` 或触发虚假重试
- 所有异步回调捕获当前 generation 并在执行前检查是否过时

### 早期错误重试
- WebSocket 在产出任何转录前断开时（CE pod 拒绝或 Deepgram 上游故障），自动 250ms 退避后重试一次
- 录音期间的音频继续缓冲（`connectionRef` 为 null 时走 `audioBuffer` 路径），第二次 `onReady` 时 flush
- fatal 错误（Cloudflare bot challenge、认证拒绝）不重试

### CJK 输入法兼容
- 当绑定键为空格时，同时匹配全角空格（U+3000）——CJK 输入法对同一物理键可能输出全角空格
- `normalizeFullWidthSpace()` 用于统一处理

### 提交竞态防护
- `lastSetInputRef` 追踪本 Hook 最后一次设置的输入值
- 如果 `inputValueRef.current` 与之不同，说明用户已提交或编辑，所有写入操作静默跳过
- 防止在 `'processing'` 阶段（finalize 等待中）用户提交后，迟到的 WebSocket 关闭事件重新填充已清空的输入框