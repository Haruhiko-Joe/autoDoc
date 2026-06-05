<template>
  <div class="page">
    <h1>Generate QA Pairs</h1>

    <form class="form" @submit.prevent="submit">
      <div class="field">
        <label>Project</label>
        <select v-model="form.project">
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
      <div class="actions">
        <button type="submit" class="btn-primary"
                :disabled="!form.project || isProjectRunning">
          {{ isProjectRunning ? `${form.project} running...` : 'Start Generation' }}
        </button>
        <RouterLink to="/validate" class="link-button">Validate</RouterLink>
        <RouterLink to="/manual-validate" class="link-button">Manual Answers</RouterLink>
      </div>
    </form>

    <div v-if="Object.keys(tasks).length" class="tasks-panel">
      <h2>Tasks</h2>
      <div v-for="(state, key) in tasks" :key="key" class="task-card">
        <div class="task-header">
          <span class="status-badge" :class="state.status">{{ state.status }}</span>
          <span class="task-project">{{ state.project }}</span>
          <span class="task-run">{{ state.runId }}</span>
        </div>
        <div v-if="state.error" class="task-error">{{ state.error }}</div>
        <div v-if="state.log.length" class="log-panel">
          <div v-for="(line, i) in state.log" :key="i" class="log-line">{{ line }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { RouterLink } from 'vue-router'
import { startGenerate, fetchGenerateStatus, fetchProjects, type Project, type TaskState } from '../services/api'

const projects = ref<Project[]>([])
const tasks = ref<Record<string, TaskState>>({})

const form = reactive({
  project: '',
  count: 20,
  batchSize: 1,
  language: 'zh',
  provider: 'claude',
  claudeModel: '',
  codexModel: '',
})

let pollTimer: ReturnType<typeof setInterval> | null = null

const hasRunning = computed(() =>
  Object.values(tasks.value).some(t => t.status === 'running')
)

const isProjectRunning = computed(() =>
  form.project ? Object.values(tasks.value).some(t => t.project === form.project && t.status === 'running') : false
)

onMounted(async () => {
  const [projectList, genStatus] = await Promise.all([fetchProjects(), fetchGenerateStatus()])
  projects.value = projectList
  tasks.value = genStatus.tasks
  if (projectList.length > 0 && !form.project) {
    form.project = projectList[0].name
  }
  if (hasRunning.value) startPolling()
})

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
  if (!res.ok) return
  startPolling()
}

function startPolling() {
  stopPolling()
  pollTimer = setInterval(async () => {
    const res = await fetchGenerateStatus()
    tasks.value = res.tasks
    if (!hasRunning.value) stopPolling()
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

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.link-button {
  color: var(--accent);
  text-decoration: none;
  font-size: 13px;
  font-weight: 600;
}

.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.tasks-panel {
  margin-top: 32px;
  max-width: 600px;
}

.tasks-panel h2 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 12px;
}

.task-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  background: var(--bg-card);
  margin-bottom: 8px;
}

.task-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.task-project {
  font-weight: 600;
  font-size: 14px;
}

.task-run {
  font-family: monospace;
  color: var(--text-tertiary);
  font-size: 12px;
}

.task-error {
  color: var(--red);
  font-size: 13px;
  margin-bottom: 6px;
}

.status-badge {
  padding: 2px 10px;
  border-radius: 4px;
  font-size: 11px;
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

.log-panel {
  max-height: 200px;
  overflow-y: auto;
  background: var(--tag-bg);
  border-radius: 6px;
  padding: 8px 10px;
  margin-top: 6px;
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
