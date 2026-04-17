<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  knowledgeGet,
  knowledgeStart,
  knowledgeMessage,
  knowledgeFinalize,
  continueRun,
  fetchStatus,
  KnowledgeSessionExpiredError,
  type AgentBackend,
} from '../services/doc'
import MarkdownView from '../components/MarkdownView.vue'
import { useTheme } from '../composables/useTheme'

type TurnRole = 'assistant' | 'user'
interface TurnMessage {
  role: TurnRole
  content: string
}

const { isDark, toggle: toggleTheme } = useTheme()

const route = useRoute()
const router = useRouter()

const project = computed(() => {
  const p = route.query.project
  if (!p) return ''
  return Array.isArray(p) ? (p[0] ?? '') : p
})

const language = ref<'zh' | 'en'>('zh')
const agentBackend = ref<AgentBackend>('claude')

const sessionId = ref('')
const draft = ref('')
const messages = ref<TurnMessage[]>([])
const userInput = ref('')
const loading = ref(false)
const errorMsg = ref('')
const initialized = ref(false)
const finalizing = ref(false)
const chatLogRef = ref<HTMLElement | null>(null)

const preGen = ref(false)
const cloning = ref(false)

const canSend = computed(() => !!project.value && !loading.value && !cloning.value && userInput.value.trim().length > 0)
const canFinalize = computed(() => initialized.value && !loading.value && !finalizing.value && draft.value.trim().length > 0)
const canStartGen = computed(() => preGen.value && !loading.value && !finalizing.value && !cloning.value)

async function scrollToBottom() {
  await nextTick()
  const el = chatLogRef.value
  if (el) el.scrollTop = el.scrollHeight
}

async function loadExistingDraft() {
  if (!project.value) {
    errorMsg.value = 'Missing project'
    return
  }
  try {
    const existing = await knowledgeGet(project.value)
    if (existing.exists && existing.content) {
      draft.value = existing.content
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  }
}

async function startFresh(reply: string) {
  const res = await knowledgeStart(project.value, reply, language.value, agentBackend.value)
  sessionId.value = res.sessionId
  draft.value = res.draft
  messages.value.push({ role: 'assistant', content: res.question })
  initialized.value = true
}

async function sendReply() {
  if (!canSend.value) return
  const reply = userInput.value.trim()
  userInput.value = ''
  messages.value.push({ role: 'user', content: reply })
  await scrollToBottom()
  loading.value = true
  errorMsg.value = ''
  try {
    if (!initialized.value) {
      await startFresh(reply)
    } else {
      try {
        const res = await knowledgeMessage(sessionId.value, reply)
        draft.value = res.draft
        messages.value.push({ role: 'assistant', content: res.question })
      } catch (e) {
        if (e instanceof KnowledgeSessionExpiredError) {
          // server restarted or session dropped — start a new one transparently
          await startFresh(reply)
        } else {
          throw e
        }
      }
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
    await scrollToBottom()
  }
}

async function finalizeOnly() {
  if (!canFinalize.value) return
  finalizing.value = true
  errorMsg.value = ''
  try {
    await knowledgeFinalize(sessionId.value, project.value)
    router.push(`/${project.value}`)
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    finalizing.value = false
  }
}

async function skipAndStart() {
  finalizing.value = true
  errorMsg.value = ''
  try {
    await continueRun()
    router.push(`/${project.value}`)
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    finalizing.value = false
  }
}

async function saveAndStart() {
  finalizing.value = true
  errorMsg.value = ''
  try {
    if (initialized.value) {
      await knowledgeFinalize(sessionId.value, project.value)
    }
    await continueRun()
    router.push(`/${project.value}`)
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    finalizing.value = false
  }
}

function handleInputKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendReply()
  }
}

async function syncServerPhase() {
  try {
    const s = await fetchStatus()
    if (s.currentProject !== project.value) {
      preGen.value = false
      cloning.value = false
      return
    }
    if (s.phase === 'cloning') {
      preGen.value = true
      cloning.value = true
    } else if (s.phase === 'awaiting-knowledge') {
      preGen.value = true
      cloning.value = false
    } else {
      preGen.value = false
      cloning.value = false
    }
  } catch {
    preGen.value = false
    cloning.value = false
  }
}

onMounted(async () => {
  await syncServerPhase()
  await loadExistingDraft()
  if (preGen.value && messages.value.length === 0) {
    messages.value.push({
      role: 'assistant',
      content: language.value === 'en'
        ? 'Repository is being cloned. Would you like to inject any domain knowledge before I start generating docs? Tell me what default behavior to change — e.g. "treat X/Y/Z as one unit", "src/legacy/ is noise". Or skip to use defaults.'
        : '仓库正在克隆。要不要在生成文档前注入一些领域知识？告诉我想改变的默认行为，比如"把 X/Y/Z 作为一个单元"、"src/legacy/ 是噪声"。或者直接跳过使用默认行为。',
    })
  }
  // Keep the "cloning" banner in sync until the server reaches awaiting-knowledge.
  if (cloning.value) {
    const iv = setInterval(async () => {
      await syncServerPhase()
      if (!cloning.value) clearInterval(iv)
    }, 1000)
  }
})
</script>

<template>
  <div class="knowledge-page">
    <header class="k-header">
      <button class="back-btn" @click="router.push(`/${project}`)">&larr; Back</button>
      <h1>Inject Knowledge &mdash; {{ project }}</h1>
      <div class="k-header-actions">
        <select v-model="language" class="mini-select" :disabled="initialized">
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
        <select v-model="agentBackend" class="mini-select" :disabled="initialized">
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
        <button class="theme-btn" @click="toggleTheme" :title="isDark ? 'Light mode' : 'Dark mode'">
          <svg v-if="isDark" width="16" height="16" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="2"/>
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </header>

    <div class="k-body">
      <section class="k-chat">
        <div class="chat-log" ref="chatLogRef">
          <div v-if="cloning" class="chat-banner">Cloning repository... Elicitor will be available once the clone completes.</div>
          <div v-if="!preGen && !initialized && messages.length === 0" class="chat-hint">
            <p>Start the conversation with the Elicitor.</p>
            <p class="sub">Tell it what default documentation behavior you want to change — e.g. "treat X/Y/Z as one unit", "src/legacy/ is noise", "the only public API is Foo".</p>
          </div>
          <div
            v-for="(m, i) in messages"
            :key="i"
            class="chat-bubble"
            :class="m.role"
          >
            <div class="bubble-role">{{ m.role === 'assistant' ? 'Elicitor' : 'You' }}</div>
            <div class="bubble-content">{{ m.content }}</div>
          </div>
          <div v-if="loading" class="chat-bubble assistant">
            <div class="bubble-role">Elicitor</div>
            <div class="bubble-content thinking">thinking...</div>
          </div>
        </div>
        <div class="chat-input">
          <textarea
            v-model="userInput"
            class="reply-input"
            :placeholder="initialized ? 'Reply to the Elicitor. Enter to send, Shift+Enter for newline.' : 'Describe what you want to change about the default docs. Enter to send.'"
            :disabled="loading"
            rows="3"
            @keydown="handleInputKey"
          />
          <div class="chat-input-row">
            <p v-if="errorMsg" class="chat-error">{{ errorMsg }}</p>
            <div class="chat-input-actions">
              <template v-if="preGen">
                <button class="secondary-btn" :disabled="!canStartGen" @click="skipAndStart">
                  {{ finalizing ? 'Starting...' : 'Skip & start generation' }}
                </button>
                <button class="primary-btn" :disabled="!canStartGen || !initialized" @click="saveAndStart">
                  {{ finalizing ? 'Starting...' : 'Save & start generation' }}
                </button>
              </template>
              <template v-else>
                <button class="secondary-btn" :disabled="!canFinalize" @click="finalizeOnly">
                  {{ finalizing ? 'Saving...' : 'Save & close' }}
                </button>
              </template>
              <button class="primary-btn" :disabled="!canSend" @click="sendReply">
                Send
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="k-preview">
        <div class="preview-header">
          <span>knowledge.md preview</span>
          <span class="char-count">{{ draft.length }} chars</span>
        </div>
        <div class="preview-body">
          <MarkdownView v-if="draft.trim()" :content="draft" />
          <div v-else class="preview-empty">No draft yet. The Elicitor will write it as the conversation progresses.</div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.knowledge-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--bg-body);
}

.k-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
}

.k-header h1 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-heading);
  margin: 0;
  flex: 1;
}

.back-btn {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 13px;
}

.back-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.k-header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.mini-select {
  padding: 5px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 12px;
}

.theme-btn {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
}

.theme-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.k-body {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0;
  overflow: hidden;
}

.k-chat {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  min-width: 0;
}

.chat-log {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.chat-banner {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-surface-alt);
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
}

.chat-hint {
  margin: auto;
  text-align: center;
  color: var(--text-muted);
  padding: 40px 24px;
  max-width: 420px;
}

.chat-hint p {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--text-secondary);
}

.chat-hint p.sub {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}

.chat-bubble {
  max-width: 90%;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-bubble.assistant {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  align-self: flex-start;
}

.chat-bubble.user {
  background: var(--accent);
  color: #fff;
  align-self: flex-end;
}

.bubble-role {
  font-size: 11px;
  font-weight: 600;
  opacity: 0.7;
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.bubble-content.thinking {
  font-style: italic;
  opacity: 0.6;
}

.chat-input {
  border-top: 1px solid var(--border);
  padding: 12px 16px;
  background: var(--bg-surface);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.reply-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 14px;
  resize: vertical;
  font-family: inherit;
  outline: none;
  box-sizing: border-box;
}

.reply-input:focus {
  border-color: var(--accent);
}

.reply-input:disabled {
  color: var(--text-muted);
}

.chat-input-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.chat-error {
  color: var(--color-red);
  font-size: 12px;
  margin: 0;
  flex: 1;
}

.chat-input-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.primary-btn {
  padding: 7px 12px;
  border: none;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.primary-btn:disabled {
  background: var(--border-strong);
  color: var(--text-disabled);
  cursor: not-allowed;
}

.secondary-btn {
  padding: 7px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
}

.secondary-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.secondary-btn:disabled {
  color: var(--text-disabled);
  cursor: not-allowed;
}

.k-preview {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-body);
  min-width: 0;
}

.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 20px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  background: var(--bg-sidebar);
}

.char-count {
  color: var(--text-muted);
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
}

.preview-body {
  flex: 1;
  overflow-y: auto;
}

.preview-empty {
  padding: 40px 24px;
  color: var(--text-muted);
  text-align: center;
  font-size: 14px;
}
</style>
