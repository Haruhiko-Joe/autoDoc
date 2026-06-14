<template>
  <div class="page">
    <h1>Validate Answers</h1>

    <form class="form" @submit.prevent="submit">
      <div class="field">
        <label>QA Run</label>
        <select v-model="selectedRunKey">
          <option v-for="run in runs" :key="runKey(run)" :value="runKey(run)">
            {{ run.project }} / {{ run.runId }} ({{ run.itemCount }})
          </option>
        </select>
      </div>

      <div class="row">
        <div class="field">
          <label>Answer agent</label>
          <select v-model="form.answerProvider">
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </div>
        <div class="field">
          <label>Judge agent</label>
          <div class="check-group">
            <label class="check-option">
              <input v-model="form.judgeProviders" type="checkbox" value="claude" />
              Claude
            </label>
            <label class="check-option">
              <input v-model="form.judgeProviders" type="checkbox" value="codex" />
              Codex
            </label>
          </div>
        </div>
      </div>

      <div class="row">
        <div class="field">
          <label>Doc variant</label>
          <select v-model="form.docVariant">
            <option value="full">Full ACCEED</option>
            <option value="no-edges">No edges</option>
            <option value="flat-md">Flat Markdown</option>
          </select>
        </div>
        <div class="field">
          <label>Limit</label>
          <input v-model.number="form.limit" type="number" min="1" placeholder="All items" />
        </div>
      </div>

      <div class="row">
        <div class="field">
          <label>Language</label>
          <select v-model="form.language">
            <option value="">QA file default</option>
            <option value="zh">Chinese</option>
            <option value="en">English</option>
          </select>
        </div>
        <div class="field">
          <label>Item ids</label>
          <input v-model="form.itemIds" placeholder="codex-01,codex-02" />
        </div>
      </div>

      <div class="actions">
        <button type="submit" class="btn-primary"
                :disabled="!selectedRun || isSelectedRunning || form.judgeProviders.length === 0">
          {{ isSelectedRunning ? `${selectedRun?.project}/${selectedRun?.runId} running...` : 'Start Validation' }}
        </button>
        <RouterLink :to="{ name: 'manual-validate', query: selectedRun ? { project: selectedRun.project, runId: selectedRun.runId } : {} }" class="link-button">
          Manual Answers
        </RouterLink>
      </div>
    </form>

    <div v-if="selectedValidation" class="summary-panel">
      <div>
        <h2>Latest Result</h2>
        <p>{{ selectedValidation.completedCount }}/{{ selectedValidation.itemCount }} completed - {{ selectedValidation.answerProvider }} answer</p>
      </div>
      <div class="score-big">{{ summaryScoreText(selectedValidation, percent) }}</div>
    </div>

    <div v-if="Object.keys(tasks).length" class="tasks-panel">
      <h2>Tasks</h2>
      <div v-for="(state, key) in tasks" :key="key" class="task-card">
        <div class="task-header">
          <span class="status-badge" :class="state.status">{{ state.status }}</span>
          <span class="task-project">{{ state.project }}</span>
          <span class="task-run">{{ state.runId }}</span>
          <span v-if="state.docVariant" class="variant-tag">{{ state.docVariant }}</span>
          <span v-for="provider in state.judgeProviders ?? []" :key="provider" class="variant-tag">{{ provider }}</span>
          <RouterLink v-if="state.status !== 'running'" :to="{ name: 'detail', params: { project: state.project, runId: state.runId } }" class="detail-link">
            View
          </RouterLink>
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
import { useRoute, RouterLink } from 'vue-router'
import {
  fetchRuns,
  fetchValidateStatus,
  startValidate,
  type GenerateStatusResponse,
  type RunSummary,
  type TaskState,
} from '../services/api'
import { summaryScoreText } from '../utils/validation'

const route = useRoute()
const runs = ref<RunSummary[]>([])
const tasks = ref<Record<string, TaskState>>({})
const selectedRunKey = ref('')

const form = reactive({
  answerProvider: 'codex',
  judgeProviders: ['claude'] as string[],
  docVariant: 'full',
  limit: undefined as number | undefined,
  language: '',
  itemIds: '',
})

let pollTimer: ReturnType<typeof setInterval> | null = null

const selectedRun = computed(() =>
  runs.value.find(run => runKey(run) === selectedRunKey.value),
)

const selectedValidation = computed(() => {
  const run = selectedRun.value
  if (!run) return undefined
  return run.validations?.[form.docVariant]
    ?? (run.validation?.docVariant === form.docVariant ? run.validation : undefined)
})

const hasRunning = computed(() =>
  Object.values(tasks.value).some(t => t.status === 'running'),
)

const isSelectedRunning = computed(() => {
  const run = selectedRun.value
  if (!run) return false
  return Object.values(tasks.value).some(t =>
    t.project === run.project
      && t.runId === run.runId
      && t.status === 'running'
      && (!t.docVariant || t.docVariant === form.docVariant),
  )
})

onMounted(async () => {
  const [runList, status] = await Promise.all([fetchRuns(), fetchValidateStatus()])
  runs.value = runList
  tasks.value = status.tasks
  const project = route.query.project as string | undefined
  const runId = route.query.runId as string | undefined
  const preferred = project && runId
    ? runList.find(run => run.project === project && run.runId === runId)
    : undefined
  selectedRunKey.value = preferred ? runKey(preferred) : (runList[0] ? runKey(runList[0]) : '')
  if (hasRunning.value) startPolling()
})

onUnmounted(() => stopPolling())

async function submit() {
  const run = selectedRun.value
  if (!run) return
  const opts: Record<string, unknown> = {
    project: run.project,
    runId: run.runId,
    answerProvider: form.answerProvider,
    judgeProviders: form.judgeProviders,
    docVariant: form.docVariant,
  }
  if (form.limit) opts.limit = form.limit
  if (form.language) opts.language = form.language
  if (form.itemIds.trim()) opts.itemIds = form.itemIds.trim()

  const res = await startValidate(opts)
  if (!res.ok) return
  await refreshStatus()
  startPolling()
}

async function refreshStatus(): Promise<GenerateStatusResponse> {
  const status = await fetchValidateStatus()
  tasks.value = status.tasks
  return status
}

function startPolling() {
  stopPolling()
  pollTimer = setInterval(async () => {
    await refreshStatus()
    if (!hasRunning.value) {
      stopPolling()
      runs.value = await fetchRuns()
    }
  }, 2000)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function runKey(run: RunSummary): string {
  return `${run.project}/${run.runId}`
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-'
  return `${Math.round(value * 100)}%`
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

.field input,
.field select {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-card);
  color: var(--text);
  outline: none;
  transition: border-color 0.15s;
}

.field input:focus,
.field select:focus {
  border-color: var(--accent);
}

.check-group {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 37px;
}

.check-option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text);
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

.summary-panel {
  max-width: 680px;
  margin-top: 24px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  background: var(--bg-card);
  display: flex;
  justify-content: space-between;
  gap: 16px;
}

.summary-panel h2 {
  font-size: 15px;
  font-weight: 600;
}

.summary-panel p {
  color: var(--text-secondary);
  font-size: 13px;
}

.score-big {
  font-size: 28px;
  font-weight: 700;
  color: var(--green);
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

.variant-tag {
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--tag-bg);
  color: var(--text-secondary);
  font-size: 12px;
}

.detail-link {
  margin-left: auto;
  color: var(--accent);
  text-decoration: none;
  font-size: 13px;
  font-weight: 600;
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
