<script setup lang="ts">
import { ref, nextTick, watch } from 'vue'
import { marked } from 'marked'
import { sendChat, type ChatEvent } from '../services/doc'

const props = defineProps<{
  open: boolean
  agentSessionId?: string  // 当前页面对应的原始 agent sessionId（用于 fork）
}>()
const emit = defineEmits<{ close: [] }>()

interface Message {
  role: 'user' | 'assistant'
  content: string
}

const messages = ref<Message[]>([])
const input = ref('')
const loading = ref(false)
const listRef = ref<HTMLDivElement>()
// fork 出来的独立 sessionId，原始 agent session 不受影响
let chatSessionId: string | null = null

function scrollToBottom() {
  nextTick(() => {
    if (listRef.value) listRef.value.scrollTop = listRef.value.scrollHeight
  })
}

watch(() => props.open, (v) => { if (v) scrollToBottom() })

async function send() {
  const text = input.value.trim()
  if (!text || loading.value) return

  messages.value.push({ role: 'user', content: text })
  input.value = ''
  loading.value = true
  scrollToBottom()

  const assistantMsg: Message = { role: 'assistant', content: '' }
  messages.value.push(assistantMsg)

  // 首次消息：传 agentSessionId 让后端 fork；后续消息：传 chatSessionId 续聊
  const agentSid = chatSessionId ? null : (props.agentSessionId ?? null)

  try {
    await sendChat(text, chatSessionId, agentSid, (event: ChatEvent) => {
      if (event.type === 'session' && event.sessionId) {
        chatSessionId = event.sessionId
      }
      if (event.type === 'text' && event.text) {
        assistantMsg.content += event.text
        scrollToBottom()
      }
      if (event.type === 'error' && event.text) {
        assistantMsg.content += `\n\n**Error:** ${event.text}`
        scrollToBottom()
      }
    })
  } catch (e) {
    assistantMsg.content = `**Error:** ${e instanceof Error ? e.message : String(e)}`
  }

  if (!assistantMsg.content) {
    assistantMsg.content = '(No response)'
  }

  loading.value = false
  scrollToBottom()
}

function renderMd(md: string): string {
  return marked.parse(md) as string
}
</script>

<template>
  <Transition name="panel">
    <div v-if="open" class="chat-panel">
      <div class="chat-header">
        <span class="chat-title">Chat</span>
        <button class="chat-close" @click="emit('close')">&times;</button>
      </div>
      <div ref="listRef" class="chat-messages">
        <div v-if="messages.length === 0" class="chat-empty">
          Ask anything about the project.
        </div>
        <div
          v-for="(msg, i) in messages"
          :key="i"
          class="chat-msg"
          :class="msg.role"
        >
          <div v-if="msg.role === 'user'" class="msg-bubble user-bubble">{{ msg.content }}</div>
          <div v-else class="msg-bubble assistant-bubble" v-html="renderMd(msg.content)" />
        </div>
        <div v-if="loading && messages[messages.length - 1]?.content === ''" class="chat-typing">
          <span class="dot" /><span class="dot" /><span class="dot" />
        </div>
      </div>
      <div class="chat-input-area">
        <input
          v-model="input"
          class="chat-input"
          placeholder="Type a message..."
          :disabled="loading"
          @keydown.enter="send"
        />
        <button class="chat-send" :disabled="loading || !input.trim()" @click="send">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M14.5 1.5L7 9M14.5 1.5L10 14.5L7 9M14.5 1.5L1.5 6L7 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.chat-panel {
  position: fixed;
  bottom: 24px;
  left: 24px;
  width: 420px;
  height: 540px;
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 16px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  z-index: 1000;
  overflow: hidden;
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid #f0f0f0;
  flex-shrink: 0;
}

.chat-title {
  font-size: 15px;
  font-weight: 600;
  color: #1a1a1a;
}

.chat-close {
  background: none;
  border: none;
  font-size: 20px;
  color: #999;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.chat-close:hover {
  color: #333;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.chat-empty {
  color: #bbb;
  font-size: 14px;
  text-align: center;
  margin-top: 40px;
}

.chat-msg {
  display: flex;
}

.chat-msg.user {
  justify-content: flex-end;
}

.chat-msg.assistant {
  justify-content: flex-start;
}

.msg-bubble {
  max-width: 85%;
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
}

.user-bubble {
  background: #1890ff;
  color: #fff;
  border-bottom-right-radius: 4px;
  white-space: pre-wrap;
}

.assistant-bubble {
  background: #f5f5f5;
  color: #333;
  border-bottom-left-radius: 4px;
}

.assistant-bubble :deep(p) {
  margin: 0 0 8px;
}

.assistant-bubble :deep(p:last-child) {
  margin: 0;
}

.assistant-bubble :deep(pre) {
  background: #e8e8e8;
  padding: 10px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 8px 0;
}

.assistant-bubble :deep(code) {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
}

.assistant-bubble :deep(p code) {
  background: #e0e0e0;
  padding: 1px 4px;
  border-radius: 3px;
}

.chat-typing {
  display: flex;
  gap: 4px;
  padding: 8px 0;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #bbb;
  animation: typing 1.2s infinite;
}

.dot:nth-child(2) { animation-delay: 0.2s; }
.dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes typing {
  0%, 60%, 100% { opacity: 0.3; }
  30% { opacity: 1; }
}

.chat-input-area {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #f0f0f0;
  flex-shrink: 0;
}

.chat-input {
  flex: 1;
  padding: 9px 14px;
  border: 1px solid #d9d9d9;
  border-radius: 20px;
  font-size: 14px;
  outline: none;
  min-width: 0;
}

.chat-input:focus {
  border-color: #1890ff;
}

.chat-input:disabled {
  background: #fafafa;
}

.chat-send {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: #1890ff;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.chat-send:hover:not(:disabled) {
  background: #40a9ff;
}

.chat-send:disabled {
  background: #d9d9d9;
  cursor: not-allowed;
}

/* Transition */
.panel-enter-active,
.panel-leave-active {
  transition: all 0.25s ease;
}

.panel-enter-from,
.panel-leave-to {
  opacity: 0;
  transform: translateY(20px) scale(0.95);
}
</style>
