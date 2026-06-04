<script setup lang="ts">
import { ref, nextTick, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { sendChat, type ChatEvent, type ChatMessage } from '../services/doc'

const props = defineProps<{
  open: boolean
}>()
const emit = defineEmits<{ close: [] }>()

const messages = ref<ChatMessage[]>([])
const input = ref('')
const loading = ref(false)
const listRef = ref<HTMLDivElement>()

async function scrollToBottom() {
  await nextTick()
  const list = listRef.value
  if (!list) return

  list.scrollTop = list.scrollHeight
}

watch(() => props.open, (v) => {
  if (!v) return

  void scrollToBottom()
})

async function send() {
  const text = input.value.trim()
  if (!text || loading.value) return

  messages.value.push({ role: 'user', content: text })
  input.value = ''
  loading.value = true
  scrollToBottom()

  const assistantMsg: ChatMessage = { role: 'assistant', content: '' }
  messages.value.push(assistantMsg)

  // 发送完整对话历史（不含当前空的 assistant 占位）
  const history = messages.value.slice(0, -1)

  try {
    await sendChat(history, (event: ChatEvent) => {
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
  const html = marked.parse(md) as string
  return DOMPurify.sanitize(html)
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
        <textarea
          v-model="input"
          class="chat-input"
          placeholder="Type a message..."
          :disabled="loading"
          rows="2"
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
  width: min(420px, calc(100vw - 48px));
  height: min(540px, calc(100vh - 48px));
  background: var(--bg-surface);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-panel);
  display: flex;
  flex-direction: column;
  z-index: 1000;
  overflow: hidden;
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-light);
  flex-shrink: 0;
}

.chat-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-heading);
}

.chat-close {
  background: none;
  border: none;
  font-size: 20px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.chat-close:hover {
  color: var(--text-primary);
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
  color: var(--text-disabled);
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
  border-radius: var(--radius-card);
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
}

.user-bubble {
  background: var(--accent);
  color: #fff;
  border-bottom-right-radius: 4px;
  white-space: pre-wrap;
}

.assistant-bubble {
  background: var(--chat-assistant-bg);
  color: var(--text-primary);
  border-bottom-left-radius: 4px;
}

.assistant-bubble :deep(p) {
  margin: 0 0 8px;
}

.assistant-bubble :deep(p:last-child) {
  margin: 0;
}

.assistant-bubble :deep(pre) {
  background: var(--chat-assistant-code);
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
  background: var(--chat-assistant-code-inline);
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
  background: var(--text-disabled);
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
  padding: 12px 14px;
  border-top: 1px solid var(--border-light);
  flex-shrink: 0;
}

.chat-input {
  flex: 1;
  padding: 9px 14px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-card);
  font-size: 14px;
  outline: none;
  min-width: 0;
  background: var(--bg-body);
  color: var(--text-primary);
  font-family: inherit;
  resize: none;
  line-height: 1.5;
}

.chat-input:focus {
  border-color: var(--accent);
  box-shadow: var(--shadow-focus);
}

.chat-input:disabled {
  background: var(--bg-sidebar);
}

.chat-send {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.chat-send:hover:not(:disabled) {
  background: var(--accent-hover);
  transform: translateY(-1px);
}

.chat-send:disabled {
  background: var(--border-strong);
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
