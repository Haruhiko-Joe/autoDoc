<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { UpdateTaskItem } from '../services/doc'

export type DialogMode = 'confirm' | 'review' | 'readonly'

const props = defineProps<{
  task: UpdateTaskItem
  mode: DialogMode
}>()

const emit = defineEmits<{
  confirm: [extraInstructions: string]
  followUp: [prompt: string]
  accept: []
  skip: []
  cancel: []
  close: []
}>()

const instructions = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const streamScrollRef = ref<HTMLElement | null>(null)
const bodyExpanded = ref(false)

const inputEnabled = computed(() => props.mode === 'confirm' || props.mode === 'review')
const isStreaming = computed(() => props.task.status === 'running')

watch(() => props.task.id, async () => {
  instructions.value = ''
  bodyExpanded.value = false
  await nextTick()
  if (inputEnabled.value) textareaRef.value?.focus()
}, { immediate: true })

// Clear the textarea after a follow-up is submitted (task transitions confirm→running→review)
watch(() => props.task.status, (s) => {
  if (s !== 'running') return

  instructions.value = ''
})

const renderedMarkdown = computed(() => {
  const md = props.task.markdown ?? ''
  if (!md) return ''
  return DOMPurify.sanitize(marked.parse(md, { async: false }) as string)
})

const hasResponse = computed(() => (props.task.markdown?.length ?? 0) > 0)
const statusLabels = {
  running: 'Streaming response',
  'awaiting-review': 'Awaiting your review',
  done: 'Accepted',
  error: 'Failed',
  skipped: 'Skipped',
} as const

watch(() => props.task.markdown, async () => {
  if (!streamScrollRef.value) return
  const el = streamScrollRef.value
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  await nextTick()
  if (nearBottom) el.scrollTop = el.scrollHeight
})

const phaseLabel = computed(() =>
  props.task.status === 'idle'
    ? props.mode === 'confirm' ? 'Ready' : 'Queued'
    : statusLabels[props.task.status] ?? '',
)

const primaryLabel = computed(() => {
  if (props.mode === 'confirm') return 'Send \u2192'
  if (props.mode === 'review') return instructions.value.trim() ? 'Send follow-up \u2192' : 'Accept \u2713'
  return ''
})

function submitPrimary() {
  if (isStreaming.value) return
  if (props.mode === 'confirm') {
    emit('confirm', instructions.value)
    return
  }
  if (props.mode === 'review') {
    const p = instructions.value.trim()
    if (p) emit('followUp', p)
    else emit('accept')
  }
}

function acceptNow() {
  if (isStreaming.value) return
  emit('accept')
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return

  e.preventDefault()
  emit('close')
}
</script>

<template>
  <div class="dialog-backdrop" @click.self="emit('close')" @keydown="handleKeydown">
    <div class="chatbox" role="dialog" aria-labelledby="chat-title">
      <header class="chatbox-header">
        <div class="header-main">
          <code class="task-sha">{{ task.sha.slice(0, 7) }}</code>
          <h3 id="chat-title" class="dialog-title">{{ task.title }}</h3>
          <button class="close-btn" @click="emit('close')" title="Close">&times;</button>
        </div>
        <div class="header-meta">
          <span class="phase" :class="task.status">{{ phaseLabel }}</span>
          <span class="meta-sep">·</span>
          <span>{{ task.filesChanged }} file{{ task.filesChanged === 1 ? '' : 's' }}</span>
          <button
            v-if="task.body && task.status !== 'idle'"
            class="body-toggle"
            @click="bodyExpanded = !bodyExpanded"
          >
            {{ bodyExpanded ? 'Hide' : 'View' }} PR description
          </button>
        </div>
        <div v-if="task.body && bodyExpanded" class="task-body">{{ task.body }}</div>
      </header>

      <section class="chatbox-stream" ref="streamScrollRef">
        <article v-if="hasResponse" class="md-body" v-html="renderedMarkdown" />
        <span v-if="hasResponse && task.status === 'running'" class="stream-cursor" />

        <div v-if="!hasResponse && task.status === 'idle'" class="idle-preview">
          <div class="pr-body-block">
            <div class="pr-body-label">Commit / PR title</div>
            <div class="pr-body-content title-line">
              <code class="inline-sha">{{ task.sha.slice(0, 12) }}</code>
              {{ task.title }}
            </div>
          </div>

          <div class="pr-body-block">
            <div class="pr-body-label">Description</div>
            <div v-if="task.body" class="pr-body-content">{{ task.body }}</div>
            <div v-else class="pr-body-content placeholder">
              (No PR body — the agent will rely on title + diff only.)
            </div>
          </div>

          <div class="pr-body-block">
            <div class="pr-body-label">Changed files &middot; {{ task.filesChanged }}</div>
            <ul v-if="(task.changedFiles?.length ?? 0) > 0" class="file-list">
              <li v-for="f in task.changedFiles" :key="f">
                <code>{{ f }}</code>
              </li>
            </ul>
            <div v-else class="pr-body-content placeholder">
              (File list unavailable.)
            </div>
          </div>

          <div class="idle-hint">
            {{ mode === 'confirm'
              ? 'Write extra guidance in the input below, or send empty to let the agent use its defaults.'
              : 'Earlier tasks are still in flight. You can close this and check back later.' }}
          </div>
        </div>

        <div v-if="!hasResponse && task.status === 'running'" class="empty-state">
          <span class="stream-cursor solo" />
          <div class="empty-hint">Agent is thinking&hellip;</div>
        </div>

        <div v-if="task.status === 'error' && task.error" class="error-block">
          <strong>Error:</strong> {{ task.error }}
        </div>
      </section>

      <footer class="chatbox-input">
        <textarea
          v-if="inputEnabled && !isStreaming"
          ref="textareaRef"
          v-model="instructions"
          class="prompt-input"
          rows="3"
          :placeholder="mode === 'confirm'
            ? 'Optional guidance for this PR. E.g. focus on API surface, skip internal refactors, highlight breaking changes…'
            : 'Refine the result: ask for rewrites, extra detail, corrections… Leave empty and hit Accept to confirm as-is.'"
          @keydown="handleKeydown"
        />
        <div v-else class="prompt-input disabled">
          <span v-if="task.status === 'running'">Streaming response — input disabled until complete.</span>
          <span v-else-if="task.status === 'done'">Accepted. Close the window to return to the queue.</span>
          <span v-else-if="task.status === 'error'">This task failed. Retry from the queue panel.</span>
          <span v-else-if="task.status === 'skipped'">This task was skipped.</span>
          <span v-else>Not the current task — earlier items are still in flight.</span>
        </div>

        <div class="input-actions">
          <p class="shortcut-hint">
            <kbd>Esc</kbd> close
          </p>
          <div class="btn-group">
            <!-- confirm mode: initial prompt gate -->
            <template v-if="mode === 'confirm'">
              <button type="button" class="btn-ghost" @click="emit('skip')">Skip</button>
              <button type="button" class="btn-primary" @click="submitPrimary" :disabled="isStreaming">Send &rarr;</button>
            </template>

            <!-- review mode: accept / follow-up -->
            <template v-else-if="mode === 'review'">
              <button
                type="button"
                class="btn-ghost"
                @click="acceptNow"
                :disabled="isStreaming"
                title="Mark this PR's doc changes as accepted"
              >Accept &#10003;</button>
              <button
                type="button"
                class="btn-primary"
                @click="submitPrimary"
                :disabled="isStreaming || !instructions.trim()"
              >{{ primaryLabel }}</button>
            </template>

            <!-- readonly mode: just close -->
            <template v-else>
              <button type="button" class="btn-ghost" @click="emit('close')">Close</button>
            </template>
          </div>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fade-in 0.15s ease;
}

.chatbox {
  width: min(760px, calc(100vw - 48px));
  height: min(720px, calc(100vh - 64px));
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.03);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: slide-up 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes slide-up {
  from { opacity: 0; transform: translateY(12px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.chatbox-header {
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.header-main {
  display: flex;
  align-items: center;
  gap: 10px;
}

.task-sha {
  font-size: 11px;
  color: var(--accent);
  background: var(--bg-surface-alt);
  padding: 3px 8px;
  border-radius: 4px;
  flex-shrink: 0;
}

.dialog-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-heading);
  line-height: 1.35;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.close-btn {
  background: none;
  border: none;
  font-size: 22px;
  line-height: 1;
  color: var(--text-disabled);
  cursor: pointer;
  padding: 0 4px;
  flex-shrink: 0;
}

.close-btn:hover { color: var(--text-primary); }

.header-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.phase {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
}

.phase.running { color: var(--accent); border-color: var(--accent); }
.phase.awaiting-review { color: var(--color-purple, #b48cff); border-color: var(--color-purple, #b48cff); }
.phase.done    { color: var(--color-green); border-color: var(--color-green); }
.phase.error   { color: var(--color-red); border-color: var(--color-red); }
.phase.skipped { color: var(--color-orange); border-color: var(--color-orange); }
.phase.idle    { color: var(--text-secondary); }

.btn-primary:disabled,
.btn-ghost:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.meta-sep { color: var(--text-disabled); }

.body-toggle {
  margin-left: auto;
  background: none;
  border: none;
  font-size: 11px;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
}
.body-toggle:hover { text-decoration: underline; }

.task-body {
  margin-top: 10px;
  padding: 10px 12px;
  background: var(--bg-surface-alt);
  border-radius: 6px;
  max-height: 140px;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-secondary);
  white-space: pre-wrap;
}

.chatbox-stream {
  flex: 1;
  overflow-y: auto;
  padding: 18px 22px;
  background: var(--bg-surface);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 60px 24px;
  text-align: center;
  color: var(--text-disabled);
}

.empty-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
}

.empty-hint {
  font-size: 12px;
  line-height: 1.55;
  max-width: 420px;
}

.idle-preview {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.pr-body-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pr-body-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-disabled);
}

.pr-body-content {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
  padding: 10px 12px;
  background: var(--bg-surface-alt);
  border-radius: 6px;
  border: 1px solid var(--border);
}

.pr-body-content.placeholder {
  color: var(--text-disabled);
  font-style: italic;
}

.idle-hint {
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-disabled);
  padding: 8px 0;
  border-top: 1px dashed var(--border);
}

.title-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}

.inline-sha {
  font-size: 11px;
  color: var(--accent);
  background: var(--bg-surface);
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  flex-shrink: 0;
}

.file-list {
  list-style: none;
  margin: 0;
  padding: 10px 12px;
  background: var(--bg-surface-alt);
  border: 1px solid var(--border);
  border-radius: 6px;
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.file-list li { margin: 0; }

.file-list code {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 11.5px;
  color: var(--text-primary);
  word-break: break-all;
  background: transparent;
  padding: 0;
}

.error-block {
  padding: 12px 14px;
  border: 1px solid var(--color-red);
  border-radius: 6px;
  background: rgba(255, 80, 80, 0.08);
  color: var(--color-red);
  font-size: 13px;
  line-height: 1.5;
}

.md-body {
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--text-primary);
}

.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3) {
  font-weight: 600;
  margin: 18px 0 8px;
  color: var(--text-heading);
}
.md-body :deep(h1) { font-size: 17px; }
.md-body :deep(h2) { font-size: 15px; }
.md-body :deep(h3) { font-size: 14px; }
.md-body :deep(h1):first-child,
.md-body :deep(h2):first-child,
.md-body :deep(h3):first-child { margin-top: 0; }
.md-body :deep(p) { margin: 8px 0; }
.md-body :deep(ul),
.md-body :deep(ol) { margin: 8px 0; padding-left: 22px; }
.md-body :deep(li) { margin: 4px 0; }
.md-body :deep(code) {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
  background: var(--bg-code-inline, rgba(127, 127, 127, 0.14));
  padding: 1px 6px;
  border-radius: 3px;
}
.md-body :deep(pre) {
  background: var(--bg-code, rgba(0, 0, 0, 0.3));
  padding: 12px 14px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 10px 0;
}
.md-body :deep(pre code) { background: none; padding: 0; font-size: 12px; }
.md-body :deep(strong) { color: var(--text-heading); }
.md-body :deep(blockquote) {
  border-left: 3px solid var(--border-strong, var(--border));
  padding-left: 12px;
  margin: 10px 0;
  color: var(--text-secondary);
}

.stream-cursor {
  display: inline-block;
  width: 8px;
  height: 16px;
  background: var(--accent);
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: blink 1s step-end infinite;
}
.stream-cursor.solo {
  width: 10px;
  height: 20px;
  margin: 0 0 6px 0;
}

@keyframes blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}

.chatbox-input {
  padding: 14px 18px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg-surface-alt);
  flex-shrink: 0;
}

.prompt-input {
  width: 100%;
  padding: 10px 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  font-family: inherit;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--text-primary);
  resize: none;
  transition: border-color 0.15s, box-shadow 0.15s;
  box-sizing: border-box;
}

.prompt-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(99, 143, 255, 0.2);
}

.prompt-input::placeholder {
  color: var(--text-disabled);
}

.prompt-input.disabled {
  font-size: 12.5px;
  color: var(--text-disabled);
  font-style: italic;
  padding: 14px 12px;
  cursor: default;
  background: transparent;
  border-style: dashed;
}

.input-actions {
  display: flex;
  align-items: center;
  margin-top: 10px;
  gap: 12px;
}

.shortcut-hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-disabled);
  flex: 1;
}

.shortcut-hint kbd {
  display: inline-block;
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-surface);
  font-family: inherit;
  font-size: 10px;
  color: var(--text-secondary);
}

.btn-group { display: flex; gap: 8px; }

.btn-primary,
.btn-ghost {
  padding: 7px 16px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s, background 0.15s;
}

.btn-primary {
  background: var(--accent);
  color: #fff;
  border: 1px solid var(--accent);
}
.btn-primary:hover { opacity: 0.9; }

.btn-ghost {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border);
}
.btn-ghost:hover {
  color: var(--text-primary);
  background: var(--bg-surface);
}
</style>
