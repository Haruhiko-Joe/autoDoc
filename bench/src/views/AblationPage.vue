<template>
  <div class="page">
    <h1>Ablation Docs</h1>

    <form class="form" @submit.prevent="submit">
      <div class="field">
        <label class="field-label">Project</label>
        <select v-model="form.project">
          <option v-for="p in projects" :key="p.name" :value="p.name">{{ p.name }}</option>
        </select>
      </div>

      <div class="field">
        <label class="field-label">Doc variants</label>
        <div class="variant-grid">
          <label v-for="variant in variantOptions" :key="variant.value" class="variant-option">
            <input v-model="form.variants" type="checkbox" :value="variant.value" />
            <span>{{ variant.label }}</span>
          </label>
        </div>
      </div>

      <label class="check-row">
        <input v-model="form.overwrite" type="checkbox" />
        <span>Overwrite existing output</span>
      </label>

      <div class="actions">
        <button type="submit" class="btn-primary" :disabled="!canSubmit">
          {{ isProjectRunning ? `${form.project} running...` : 'Generate Docs' }}
        </button>
        <RouterLink to="/generate" class="link-button">Generate QA</RouterLink>
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
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { RouterLink } from 'vue-router'
import {
  fetchAblationStatus,
  fetchProjects,
  startAblation,
  type GenerateStatusResponse,
  type Project,
  type TaskState,
} from '../services/api'

const projects = ref<Project[]>([])
const tasks = ref<Record<string, TaskState>>({})

const variantOptions = [
  { value: 'full', label: 'Full ACCEED' },
  { value: 'no-edges', label: 'No edges' },
  { value: 'flat-md', label: 'Flat Markdown' },
]

const form = reactive({
  project: '',
  variants: ['full', 'no-edges', 'flat-md'],
  overwrite: true,
})

let pollTimer: ReturnType<typeof setInterval> | null = null

const hasRunning = computed(() =>
  Object.values(tasks.value).some(t => t.status === 'running'),
)

const isProjectRunning = computed(() =>
  form.project ? Object.values(tasks.value).some(t => t.project === form.project && t.status === 'running') : false,
)

const canSubmit = computed(() =>
  Boolean(form.project) && form.variants.length > 0 && !isProjectRunning.value,
)

onMounted(async () => {
  const [projectList, status] = await Promise.all([fetchProjects(), fetchAblationStatus()])
  projects.value = projectList
  tasks.value = status.tasks
  if (projectList.length > 0 && !form.project) {
    form.project = projectList[0].name
  }
  if (hasRunning.value) startPolling()
})

onUnmounted(() => stopPolling())

async function submit() {
  if (!canSubmit.value) return
  const res = await startAblation({
    project: form.project,
    variants: form.variants.join(','),
    overwrite: form.overwrite,
  })
  if (!res.ok) return
  await refreshStatus()
  startPolling()
}

async function refreshStatus(): Promise<GenerateStatusResponse> {
  const status = await fetchAblationStatus()
  tasks.value = status.tasks
  return status
}

function startPolling() {
  stopPolling()
  pollTimer = setInterval(async () => {
    await refreshStatus()
    if (!hasRunning.value) stopPolling()
  }, 2000)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
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
  max-width: 680px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}

.field select {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-card);
  color: var(--text);
  outline: none;
  transition: border-color 0.15s;
}

.field select:focus {
  border-color: var(--accent);
}

.variant-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.variant-option,
.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-card);
  padding: 9px 10px;
  font-size: 13px;
}

.variant-option input,
.check-row input {
  flex: 0 0 auto;
}

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.btn-primary {
  padding: 10px 24px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 6px;
  font-weight: 600;
  transition: background 0.15s;
}

.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.link-button {
  color: var(--accent);
  text-decoration: none;
  font-size: 13px;
  font-weight: 600;
}

.tasks-panel {
  margin-top: 32px;
  max-width: 760px;
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
  max-height: 260px;
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

@media (max-width: 720px) {
  .variant-grid {
    grid-template-columns: 1fr;
  }
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
