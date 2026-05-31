<template>
  <div class="page">
    <h1>Generate QA Pairs</h1>

    <form class="form" @submit.prevent="submit">
      <div class="field">
        <label>Project</label>
        <select v-model="form.project" @change="onProjectChange">
          <option v-for="p in projects" :key="p.name" :value="p.name">{{ p.name }}</option>
        </select>
      </div>
      <div class="row">
        <div class="field">
          <label>Count per provider</label>
          <input v-model.number="form.count" type="number" min="1" />
        </div>
        <div class="field">
          <label>Batch size</label>
          <input v-model.number="form.batchSize" type="number" min="1" />
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label>Language</label>
          <select v-model="form.language">
            <option value="zh">Chinese</option>
            <option value="en">English</option>
          </select>
        </div>
        <div class="field">
          <label>Provider</label>
          <select v-model="form.provider">
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label>Claude model</label>
          <input v-model="form.claudeModel" placeholder="claude-opus-4-6[1m]" />
        </div>
        <div class="field">
          <label>Codex model</label>
          <input v-model="form.codexModel" placeholder="(default)" />
        </div>
      </div>
      <button type="submit" class="btn-primary" :disabled="status.status === 'running'">
        {{ status.status === 'running' ? 'Running...' : 'Start Generation' }}
      </button>
    </form>

    <div v-if="status.status !== 'idle'" class="status-panel">
      <div class="status-header">
        <span class="status-badge" :class="status.status">{{ status.status }}</span>
        <span v-if="status.project" class="status-project">{{ status.project }}</span>
      </div>
      <div v-if="status.error" class="status-error">{{ status.error }}</div>
      <div v-if="status.log.length" class="log-panel">
        <div v-for="(line, i) in status.log" :key="i" class="log-line">{{ line }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import { startGenerate, fetchGenerateStatus, fetchProjects, type GenerateStatus, type Project } from '../services/api'

const projects = ref<Project[]>([])

const form = reactive({
  project: '',
  count: 20,
  batchSize: 1,
  language: 'zh',
  provider: 'claude',
  claudeModel: '',
  codexModel: '',
})

const status = ref<GenerateStatus>({ status: 'idle', log: [] })
let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  const [projectList, genStatus] = await Promise.all([fetchProjects(), fetchGenerateStatus()])
  projects.value = projectList
  if (projectList.length > 0 && !form.project) {
    form.project = projectList[0].name
  }
  status.value = genStatus
  if (genStatus.status === 'running') startPolling()
})

function onProjectChange() {
  // project selected — repo path is resolved server-side from project name
}

onUnmounted(() => stopPolling())

async function submit() {
  const opts: Record<string, unknown> = {
    project: form.project,
    count: form.count,
    batchSize: form.batchSize,
    language: form.language,
    providers: form.provider,
  }
  if (form.claudeModel) opts.claudeModel = form.claudeModel
  if (form.codexModel) opts.codexModel = form.codexModel

  const res = await startGenerate(opts)
  if (!res.ok) {
    status.value = { status: 'error', log: [], error: res.error }
    return
  }
  startPolling()
}

function startPolling() {
  stopPolling()
  pollTimer = setInterval(async () => {
    status.value = await fetchGenerateStatus()
    if (status.value.status !== 'running') stopPolling()
  }, 2000)
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}
</script>

<style scoped>
.page h1 {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 24px;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 600px;
}

.row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}

.field input, .field select {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-card);
  color: var(--text);
  outline: none;
  transition: border-color 0.15s;
}

.field input:focus, .field select:focus {
  border-color: var(--accent);
}

.btn-primary {
  padding: 10px 24px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 6px;
  font-weight: 600;
  transition: background 0.15s;
  align-self: flex-start;
}

.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.status-panel {
  margin-top: 32px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-card);
  max-width: 600px;
}

.status-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.status-badge {
  padding: 2px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
}

.status-badge.running {
  background: #dbeafe;
  color: #1d4ed8;
}

.status-badge.done {
  background: #dcfce7;
  color: #16a34a;
}

.status-badge.error {
  background: #fee2e2;
  color: #dc2626;
}

.status-badge.idle {
  background: var(--tag-bg);
  color: var(--text-secondary);
}

.status-project {
  font-family: monospace;
  font-size: 13px;
  color: var(--text-secondary);
}

.status-error {
  color: var(--red);
  font-size: 13px;
  margin-bottom: 8px;
}

.log-panel {
  max-height: 300px;
  overflow-y: auto;
  background: var(--tag-bg);
  border-radius: 6px;
  padding: 10px 12px;
  margin-top: 8px;
}

.log-line {
  font-family: monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}

@media (prefers-color-scheme: dark) {
  .status-badge.running {
    background: #1e3a5f;
    color: #93c5fd;
  }
  .status-badge.done {
    background: #14532d;
    color: #86efac;
  }
  .status-badge.error {
    background: #450a0a;
    color: #fca5a5;
  }
}
</style>
