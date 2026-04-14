<script setup lang="ts">
import { ref, nextTick, watch } from 'vue'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import { sendChat, isSafeRefPath, type ChatEvent, type ChatMessage } from '../services/doc'

interface DisplayMessage extends ChatMessage {
  citations?: string[]
}

const props = defineProps<{
  open: boolean
  project?: string
  currentPath?: string
}>()
const emit = defineEmits<{
  close: []
  navigate: [path: string]
}>()

const messages = ref<DisplayMessage[]>([])
const input = ref('')
const loading = ref(false)
const listRef = ref<HTMLDivElement>()

function scrollToBottom() {
  nextTick(() => {
    if (listRef.value) listRef.value.scrollTop = listRef.value.scrollHeight
  })
}

watch(() => props.open, (v) => { if (v) scrollToBottom() })

// Clear the transcript when the user switches between projects — otherwise
// the next turn would send the previous project's history together with a
// different retrieval context, producing cross-project answers. Initial
// mount (prev === undefined) does not clear.
watch(
  () => props.project,
  (next, prev) => {
    if (prev !== undefined && prev !== next) {
      messages.value = []
    }
  },
)

const REF_RE = /\[ref:([A-Za-z0-9_\-\/.]+)\]/g

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Marked inline extension: only fires in non-code contexts, so [ref:PATH]
// tokens inside fenced ``` blocks or inline `code` are preserved verbatim
// instead of being corrupted into literal <button> tags.
const markedInstance = new Marked({
  extensions: [
    {
      name: 'citation',
      level: 'inline',
      start(src: string) {
        const idx = src.indexOf('[ref:')
        return idx >= 0 ? idx : undefined
      },
      tokenizer(src: string) {
        const m = /^\[ref:([A-Za-z0-9_.\-/]+)\]/.exec(src)
        if (!m) return undefined
        return {
          type: 'citation',
          raw: m[0],
          ref: m[1]!,
        }
      },
      renderer(token: { raw: string; ref: string }) {
        if (!isSafeRefPath(token.ref)) return escapeHtml(token.raw)
        return (
          `<button type="button" class="citation-inline" data-ref="${escapeAttr(token.ref)}">` +
          `${escapeHtml(token.ref)}</button>`
        )
      },
    },
  ],
})

function extractCitationsFromText(text: string): string[] {
  // Strip fenced + inline code before matching so citations that appear only
  // inside code examples (e.g. the model showing the `[ref:...]` syntax) do
  // not bleed into the Sources list.
  const withoutCode = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
  const found = new Set<string>()
  for (const m of withoutCode.matchAll(REF_RE)) {
    const ref = m[1]!
    if (isSafeRefPath(ref)) found.add(ref)
  }
  return Array.from(found)
}

function tryNavigate(ref: string | undefined) {
  if (isSafeRefPath(ref)) emit('navigate', ref)
}

async function send() {
  const text = input.value.trim()
  if (!text || loading.value) return

  messages.value.push({ role: 'user', content: text })
  input.value = ''
  loading.value = true
  scrollToBottom()

  const assistantMsg: DisplayMessage = { role: 'assistant', content: '' }
  messages.value.push(assistantMsg)

  // Send full history without the current empty assistant placeholder.
  const history = messages.value.slice(0, -1).map(({ role, content }) => ({ role, content }))

  try {
    await sendChat(
      history,
      (event: ChatEvent) => {
        // NOTE: the server also emits a `sources` event listing every path
        // it injected into the prompt. We deliberately do NOT surface those
        // as "Sources:" chips — that would be attribution for context the
        // model may never have cited. The chip list below is built from
        // citations the model actually wrote inline. `sources` is kept on
        // the wire for tooling / logging only.
        if (event.type === 'text' && event.text) {
          assistantMsg.content += event.text
          scrollToBottom()
        }
        if (event.type === 'warning' && event.text) {
          // Non-fatal: the backend couldn't attach doc context this round.
          assistantMsg.content = `> ⚠ ${event.text}\n\n` + assistantMsg.content
        }
        if (event.type === 'error' && event.text) {
          assistantMsg.content += `\n\n**Error:** ${event.text}`
          scrollToBottom()
        }
      },
      { project: props.project, currentPath: props.currentPath },
    )
  } catch (e) {
    assistantMsg.content = `**Error:** ${e instanceof Error ? e.message : String(e)}`
  }

  const inline = extractCitationsFromText(assistantMsg.content)
  if (inline.length > 0) assistantMsg.citations = inline

  if (!assistantMsg.content) {
    assistantMsg.content = '(No response)'
  }

  loading.value = false
  scrollToBottom()
}

function renderMd(md: string): string {
  return DOMPurify.sanitize(markedInstance.parse(md) as string, {
    ADD_ATTR: ['data-ref'],
  })
}

function onBubbleClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  const chip = target?.closest('.citation-inline, .citation-chip') as HTMLElement | null
  if (!chip) return
  // Prevent <button type="button"> from triggering any enclosing form / link.
  e.preventDefault()
  tryNavigate(chip.dataset.ref)
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
          <template v-if="msg.role === 'user'">
            <div class="msg-bubble user-bubble">{{ msg.content }}</div>
          </template>
          <template v-else>
            <div class="assistant-stack">
              <div class="msg-bubble assistant-bubble" @click="onBubbleClick" v-html="renderMd(msg.content)" />
              <div v-if="msg.citations && msg.citations.length > 0" class="citation-row">
                <span class="citation-label">Sources:</span>
                <button
                  v-for="p in msg.citations"
                  :key="p"
                  type="button"
                  class="citation-chip"
                  :data-ref="p"
                  :title="p"
                  @click="tryNavigate(p)"
                >
                  {{ p }}
                </button>
              </div>
            </div>
          </template>
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
  background: var(--bg-surface);
  border: 1px solid var(--border-card);
  border-radius: 16px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
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

.assistant-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 85%;
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
  background: var(--accent);
  color: #fff;
  border-bottom-right-radius: 4px;
  white-space: pre-wrap;
}

.assistant-bubble {
  background: var(--chat-assistant-bg);
  color: var(--text-primary);
  border-bottom-left-radius: 4px;
  max-width: 100%;
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

.assistant-bubble :deep(.citation-inline) {
  display: inline-block;
  padding: 1px 6px;
  margin: 0 1px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 6px;
  font-family: inherit;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  vertical-align: 1px;
  line-height: 1.4;
}

.assistant-bubble :deep(.citation-inline:hover),
.assistant-bubble :deep(.citation-inline:focus-visible) {
  background: var(--accent-hover);
  outline: none;
}

.citation-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  padding: 0 2px;
}

.citation-label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-right: 2px;
}

.citation-chip {
  background: transparent;
  border: 1px solid var(--border-strong);
  color: var(--text-primary);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  cursor: pointer;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'SFMono-Regular', Consolas, monospace;
}

.citation-chip:hover {
  border-color: var(--accent);
  color: var(--accent);
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
  padding: 12px 16px;
  border-top: 1px solid var(--border-light);
  flex-shrink: 0;
}

.chat-input {
  flex: 1;
  padding: 9px 14px;
  border: 1px solid var(--border-strong);
  border-radius: 20px;
  font-size: 14px;
  outline: none;
  min-width: 0;
  background: var(--bg-body);
  color: var(--text-primary);
}

.chat-input:focus {
  border-color: var(--accent);
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
