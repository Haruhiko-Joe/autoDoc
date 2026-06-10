<script setup lang="ts">
import { ref, watch } from 'vue'
import { commitDocGit, fetchDocGitStatus, type DocGitStatus } from '../services/doc'

const props = defineProps<{
  project: string
  visible: boolean
  refreshToken?: number
}>()

const emit = defineEmits<{
  close: []
  committed: []
}>()

const status = ref<DocGitStatus | null>(null)
const message = ref('docs: update documentation')
const loading = ref(false)
const committing = ref(false)
const error = ref('')

function formatDate(value?: string) {
  if (!value) return ''
  return new Date(value).toLocaleString()
}

async function loadStatus() {
  if (!props.project) return
  loading.value = true
  error.value = ''
  try {
    status.value = await fetchDocGitStatus(props.project)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load git status'
  } finally {
    loading.value = false
  }
}

async function commitNow() {
  if (!props.project || !message.value.trim()) return
  committing.value = true
  error.value = ''
  try {
    await commitDocGit(props.project, message.value)
    await loadStatus()
    emit('committed')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Commit failed'
  } finally {
    committing.value = false
  }
}

watch(() => [props.visible, props.project, props.refreshToken], ([visible]) => {
  if (!visible) return

  void loadStatus()
}, { immediate: true })
</script>

<template>
  <Transition name="panel-slide">
    <aside v-if="visible" class="git-panel">
      <div class="panel-header">
        <div>
          <h3>Git</h3>
          <p>{{ project }}</p>
        </div>
        <button class="panel-close" @click="emit('close')">&times;</button>
      </div>

      <div class="panel-body">
        <div class="git-state">
          <span class="state-dot" :class="{ dirty: status?.dirty }" />
          <div>
            <strong>{{ status?.dirty ? 'Uncommitted changes' : 'Clean working tree' }}</strong>
            <p v-if="status">{{ status.fileCount }} file{{ status.fileCount === 1 ? '' : 's' }} changed</p>
            <p v-else>{{ loading ? 'Checking status...' : 'Status unavailable' }}</p>
          </div>
        </div>

        <div v-if="status?.head" class="head-box">
          <span>{{ status.head.shortSha }}</span>
          <strong>{{ status.head.message }}</strong>
          <p>{{ formatDate(status.head.date) }}</p>
        </div>

        <label class="commit-label" for="doc-git-message">Commit message</label>
        <textarea
          id="doc-git-message"
          v-model="message"
          class="commit-message"
          rows="3"
          :disabled="committing"
        />

        <div class="panel-actions">
          <button class="btn-secondary" :disabled="loading || committing" @click="loadStatus">Refresh</button>
          <button
            class="btn-primary"
            :disabled="!status?.dirty || !message.trim() || committing"
            @click="commitNow"
          >
            {{ committing ? 'Committing...' : 'Commit' }}
          </button>
        </div>

        <p v-if="error" class="git-error">{{ error }}</p>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.git-panel {
  width: clamp(280px, 24vw, 420px);
  background: var(--bg-sidebar);
  border-left: 1px solid var(--border);
  backdrop-filter: blur(18px);
  box-shadow: var(--shadow-soft);
  z-index: var(--z-sidepanel);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.panel-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  padding: var(--space-lg) var(--space-xl);
  border-bottom: 1px solid var(--border);
}

.panel-header > div {
  min-width: 0;
}

.panel-header h3 {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 650;
  color: var(--text-heading);
}

.panel-header p {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel-close {
  background: none;
  border: none;
  font-size: 20px;
  color: var(--text-disabled);
  cursor: pointer;
}

.panel-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
  padding: var(--space-lg) var(--space-xl) var(--space-xl);
  overflow-y: auto;
}

.git-state {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--bg-surface);
  box-shadow: var(--shadow-soft);
}

.state-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  margin-top: 5px;
  background: var(--color-green);
}

.state-dot.dirty { background: var(--color-orange); }

.git-state strong {
  display: block;
  font-size: 13px;
  color: var(--text-heading);
  margin-bottom: 2px;
}

.git-state p,
.head-box p {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.head-box {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--bg-surface-alt);
}

.head-box span {
  display: inline-block;
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--accent);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.head-box strong {
  display: block;
  font-size: 13px;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.commit-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.commit-message {
  width: 100%;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-card);
  background: var(--bg-surface);
  color: var(--text-primary);
  padding: 10px 12px;
  resize: none;
  font: inherit;
  line-height: 1.45;
}

.commit-message:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: var(--shadow-focus);
}

.panel-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.git-error {
  color: var(--color-red);
  font-size: 12px;
  line-height: 1.4;
}
</style>
