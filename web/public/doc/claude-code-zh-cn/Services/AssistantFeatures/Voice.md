# 语音输入子系统（Voice）

## 概述与职责

语音输入子系统是 Claude Code 的"按住说话"（push-to-talk）语音输入功能的完整实现，位于 Services → AssistantFeatures 层级下。它由三个紧密配合的模块组成：

- **voice.ts**：音频录制层，负责从麦克风采集原始 PCM 音频数据
- **voiceStreamSTT.ts**：语音转文字层，通过 WebSocket 连接 Anthropic voice_stream 端点，将音频流实时转为文本
- **voiceKeyterms.ts**：词汇提示层，提供编程领域关键词以提升 STT 识别准确率

同级兄弟模块包括 PromptSuggestion（提示建议）、autoDream（对话巩固）、MagicDocs 等辅助功能服务。语音子系统依赖 ApiClient 层的 OAuth 认证来获取 voice_stream 端点的访问凭证。

## 关键流程

### 完整语音输入流程

1. 用户按住语音快捷键触发录制
2. `checkRecordingAvailability()` 检查当前环境是否支持录音（远程环境直接拒绝）
3. `startRecording()` 按优先级尝试录制后端：原生 cpal → arecord → SoX
4. 同时 `connectVoiceStream()` 建立 WebSocket 连接到 Anthropic STT 端点
5. 录制过程中，音频 chunk 通过 `connection.send()` 实时发送到 WebSocket
6. 服务端返回 `TranscriptText`（中间结果）和 `TranscriptEndpoint`（最终结果）
7. 用户松开按键，调用 `stopRecording()` 停止录音，`connection.finalize()` 发送 `CloseStream` 并等待最终转录结果

### 录制后端选择逻辑

`startRecording()` 的后端选择链（`src/services/voice.ts:335-396`）：

1. **原生 cpal 模块**（首选）：通过 `audio-capture-napi` 模块进行进程内录制。macOS 使用 CoreAudio，Linux 使用 ALSA，Windows 使用 WASAPI。Linux 上额外检查 `/proc/asound/cards` 确认有声卡存在
2. **arecord**（Linux 回退）：ALSA 命令行工具。通过 `probeArecord()` 实际试录 150ms 验证设备可用性（而非仅检查命令是否存在），以处理 WSL1/无头 Linux 等场景
3. **SoX rec**（最终回退）：跨平台命令行录制工具，支持内置静音检测

所有后端统一输出 16kHz、16-bit signed、单声道的原始 PCM 数据流。

### WebSocket 通信协议

`connectVoiceStream()` 使用以下线路协议（`src/services/voiceStreamSTT.ts:111-544`）：

**客户端 → 服务端：**
- 二进制帧：原始 PCM 音频数据
- `{"type":"KeepAlive"}`：每 8 秒发送一次心跳防止空闲超时
- `{"type":"CloseStream"}`：通知服务端停止接收音频，触发最终转录刷新

**服务端 → 客户端：**
- `TranscriptText`：中间或累积转录文本（`isFinal=false`）
- `TranscriptEndpoint`：标记一个语句的转录完成（触发 `isFinal=true` 回调）
- `TranscriptError`：转录错误

### finalize 解析机制

`finalize()` 发送 `CloseStream` 后，通过竞争机制等待最终结果（`src/services/voiceStreamSTT.ts:239-304`）：

| 解析源 | 超时 | 含义 |
|--------|------|------|
| `post_closestream_endpoint` | ~300ms | 正常路径：收到 `TranscriptEndpoint` |
| `no_data_timeout` | 1500ms | 服务端无数据返回（静默丢弃） |
| `ws_close` | ~3-5s | WebSocket 关闭事件 |
| `safety_timeout` | 5000ms | 最终兜底超时 |

当 `CloseStream` 后收到 `TranscriptText` 数据，`noData` 定时器会被取消，避免误截断正在刷新的转录。

## 函数签名与参数说明

### voice.ts — 音频录制

#### `checkVoiceDependencies(): Promise<{ available, missing, installCommand }>`

检查录制所需的系统依赖是否已安装。返回缺失的依赖列表和对应包管理器的安装命令（支持 brew/apt-get/dnf/pacman）。

#### `checkRecordingAvailability(): Promise<RecordingAvailability>`

检查当前环境是否能实际录音。除了依赖检查外，还排除远程环境（Homespace、`CLAUDE_CODE_REMOTE`），并在 Linux 上通过 `probeArecord()` 实际探测设备。

- 返回 `{ available: boolean, reason: string | null }`

#### `requestMicrophonePermission(): Promise<boolean>`

触发 macOS TCC 权限弹窗。通过实际启动一次短暂录制来请求麦克风权限，比查询 TCC 状态 API 更可靠（后者对非标签名/跨架构二进制文件不准确）。

#### `startRecording(onData, onEnd, options?): Promise<boolean>`

启动录制。通过 `onData` 回调流式返回 PCM 音频 chunk。

- **onData**: `(chunk: Buffer) => void` — 接收原始 PCM 数据
- **onEnd**: `() => void` — 录制结束回调（静音检测触发或进程退出）
- **options.silenceDetection**: 默认 `true`；push-to-talk 模式下设为 `false` 由用户手动控制停止
- 返回 `boolean` 表示是否成功启动

#### `stopRecording(): void`

停止当前录制。原生后端调用 `stopNativeRecording()`，子进程后端发送 `SIGTERM`。

### voiceStreamSTT.ts — 语音转文字

#### `isVoiceStreamAvailable(): boolean`

检查 voice_stream 是否可用。要求用户已通过 Anthropic OAuth 认证且持有有效 access token。

#### `connectVoiceStream(callbacks, options?): Promise<VoiceStreamConnection | null>`

建立到 voice_stream 端点的 WebSocket 连接。

- **callbacks.onTranscript**: `(text: string, isFinal: boolean) => void` — 接收转录文本
- **callbacks.onError**: `(error: string, opts?) => void` — 错误回调，`fatal: true` 表示 4xx 不可重试
- **callbacks.onClose**: `() => void` — 连接关闭
- **callbacks.onReady**: `(connection: VoiceStreamConnection) => void` — 连接就绪，可以开始发送音频
- **options.language**: STT 语言，默认 `'en'`
- **options.keyterms**: 词汇提示列表，传给 STT 服务进行 boost

返回的 `VoiceStreamConnection` 对象提供：
- `send(audioChunk)`: 发送音频数据
- `finalize()`: 发送 `CloseStream` 并等待最终转录（返回 `Promise<FinalizeSource>`）
- `close()`: 关闭连接
- `isConnected()`: 连接状态查询

### voiceKeyterms.ts — 关键词提示

#### `getVoiceKeyterms(recentFiles?): Promise<string[]>`

构建 STT 关键词列表，最多返回 50 个词。来源包括：

1. **全局编程词汇**：MCP、TypeScript、JSON、OAuth、grep 等 Deepgram 容易误识别的术语
2. **项目名称**：当前项目根目录名
3. **Git 分支词汇**：从分支名拆解出的单词（如 `feat/voice-keyterms` → `feat`, `voice`, `keyterms`）
4. **最近文件名**：从文件名拆解出的单词

#### `splitIdentifier(name: string): string[]`

将 camelCase、PascalCase、kebab-case、snake_case 标识符拆分为单词列表，过滤掉 2 字符以下和 20 字符以上的片段。

## 类型定义

### `RecordingAvailability`

```typescript
type RecordingAvailability = {
  available: boolean
  reason: string | null  // 不可用时的用户可读提示
}
```

### `VoiceStreamCallbacks`

```typescript
type VoiceStreamCallbacks = {
  onTranscript: (text: string, isFinal: boolean) => void
  onError: (error: string, opts?: { fatal?: boolean }) => void
  onClose: () => void
  onReady: (connection: VoiceStreamConnection) => void
}
```

### `VoiceStreamConnection`

```typescript
type VoiceStreamConnection = {
  send: (audioChunk: Buffer) => void
  finalize: () => Promise<FinalizeSource>
  close: () => void
  isConnected: () => boolean
}
```

### `FinalizeSource`

```typescript
type FinalizeSource =
  | 'post_closestream_endpoint'  // 正常路径
  | 'no_data_timeout'            // 服务端静默丢弃
  | 'safety_timeout'             // 兜底超时
  | 'ws_close'                   // WS 关闭事件
  | 'ws_already_closed'          // 调用时已关闭
```

## 配置项与默认值

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `RECORDING_SAMPLE_RATE` | 常量 | 16000 | 录制采样率（Hz） |
| `RECORDING_CHANNELS` | 常量 | 1 | 录制声道数（单声道） |
| `SILENCE_DURATION_SECS` | 常量 | `'2.0'` | SoX 静音检测停止阈值（秒） |
| `SILENCE_THRESHOLD` | 常量 | `'3%'` | SoX 静音检测音量阈值 |
| `KEEPALIVE_INTERVAL_MS` | 常量 | 8000 | WebSocket 心跳间隔（毫秒） |
| `FINALIZE_TIMEOUTS_MS.safety` | 导出常量 | 5000 | finalize 兜底超时（毫秒） |
| `FINALIZE_TIMEOUTS_MS.noData` | 导出常量 | 1500 | 无数据超时（毫秒） |
| `MAX_KEYTERMS` | 常量 | 50 | 最大关键词数量 |
| `VOICE_STREAM_BASE_URL` | 环境变量 | — | 覆盖 voice_stream WebSocket 端点地址 |
| `CLAUDE_CODE_REMOTE` | 环境变量 | — | 设为 truthy 时禁用语音（远程环境） |

WebSocket 连接参数（作为 query string）：

| 参数 | 值 | 说明 |
|------|------|------|
| `encoding` | `linear16` | 音频编码格式 |
| `sample_rate` | `16000` | 采样率 |
| `channels` | `1` | 声道数 |
| `endpointing_ms` | `300` | 端点检测灵敏度（毫秒） |
| `utterance_end_ms` | `1000` | 语句结束检测（毫秒） |
| `language` | `en`（默认） | STT 语言 |
| `use_conversation_engine` | `true`（开关控制） | 启用对话引擎路由 |
| `stt_provider` | `deepgram-nova3`（开关控制） | 指定 STT 提供商 |

## 边界 Case 与注意事项

### 原生模块延迟加载
`audio-capture-napi` 的 `dlopen` 是同步阻塞的，冷启动耗时可达 8 秒（macOS 唤醒后 coreaudiod 冷启动）。因此模块在首次按键时才加载，避免启动时卡顿（`src/services/voice.ts:14-36`）。

### Linux ALSA 检测的特殊处理
在 Linux 上，cpal 的 ALSA 后端找不到声卡时会直接写入进程 stderr（因为是进程内运行无法捕获）。因此 Linux 下在使用原生模块前先检查 `/proc/asound/cards`，无声卡时跳过原生模块避免 stderr 污染（`src/services/voice.ts:128-139`）。

### WSL 兼容性
WSL1 和 Windows 10 的 WSL2 没有音频设备。WSL2 + WSLg（Windows 11）通过 PulseAudio RDP 管道提供音频支持，此时 cpal 因无 ALSA cards 而失败，但 arecord 可以工作。`probeArecord()` 通过实际试录 150ms 来区分这些场景（`src/services/voice.ts:75-118`）。

### 音频缓冲区复制
通过 WebSocket 发送原生模块产生的 Buffer 前，必须调用 `Buffer.from()` 创建副本。原因是 NAPI Buffer 对象可能共享底层 ArrayBuffer 池，直接引用可能导致 ws 库读取到过期或重叠的内存（`src/services/voiceStreamSTT.ts:236-237`）。

### Nova 3 与 Legacy Deepgram 的转录差异
通过 `tengu_cobalt_frost` 特性开关控制是否使用 Deepgram Nova 3。Nova 3 的中间结果是跨语句累积的且可能回溯修改已有文本，因此禁用了自动分段检测逻辑（该逻辑仅适用于 Legacy Deepgram 的非累积中间结果）（`src/services/voiceStreamSTT.ts:396-409`）。

### CloseStream 延迟发送
`finalize()` 通过 `setTimeout(0)` 延迟发送 `CloseStream`，确保原生录制模块事件队列中已排队的 `onData` 回调先被刷入 WebSocket，避免音频在 `CloseStream` 之后到达导致协议错误（`src/services/voiceStreamSTT.ts:297-303`）。

### HTTP 升级拒绝处理
WebSocket 连接使用 `api.anthropic.com` 而非 `claude.ai`，因为后者的 Cloudflare 层会对非浏览器客户端进行 TLS 指纹检测并发起挑战。当升级被拒绝（非 101 响应）时，4xx 错误标记为 `fatal` 不可重试（`src/services/voiceStreamSTT.ts:511-533`）。