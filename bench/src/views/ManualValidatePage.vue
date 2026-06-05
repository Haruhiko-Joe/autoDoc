<template>
  <div class="page">
    <div class="page-head">
      <h1>Manual Answer Validation</h1>
      <RouterLink v-if="selectedRun" :to="{ name: 'detail', params: { project: selectedRun.project, runId: selectedRun.runId } }" class="link-button">
        View Run
      </RouterLink>
    </div>

    <form class="control-panel" @submit.prevent="submit">
      <div class="field wide">
        <label>QA Run</label>
        <select v-model="selectedRunKey" @change="loadSelectedRun">
          <option v-for="run in runs" :key="runKey(run)" :value="runKey(run)">
            {{ run.project }} / {{ run.runId }} ({{ run.itemCount }})
          </option>
        </select>
      </div>

      <div class="row">
        <div class="field">
          <label>Answer source</label>
          <input v-model="form.answerProvider" placeholder="ChatGPT 5.5" @input="saveDraft" />
        </div>
        <div class="field">
          <label>Result label</label>
          <input v-model="form.docVariant" placeholder="chatgpt-5-5" />
        </div>
      </div>

      <div class="row">
        <div class="field">
          <label>Judge agent</label>
          <select v-model="form.judgeProvider">
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        </div>
        <div class="field">
          <label>Language</label>
          <select v-model="form.language">
            <option value="">QA file default</option>
            <option value="zh">Chinese</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>

      <div class="actions">
        <button type="submit" class="btn-primary" :disabled="!canSubmit">
          {{ isSelectedRunning ? 'Scoring...' : `Score ${answeredCount} Answers` }}
        </button>
        <span v-if="!labelIsSafe" class="form-error">Use letters, numbers, hyphen, or underscore for the result label.</span>
        <span v-else-if="submitError" class="form-error">{{ submitError }}</span>
      </div>
    </form>

    <div v-if="selectedValidation" class="summary-panel">
      <div>
        <h2>Latest Manual Result</h2>
        <p>{{ selectedValidation.docVariant }} - {{ selectedValidation.completedCount }}/{{ selectedValidation.itemCount }} completed - judge {{ selectedValidation.judgeProvider }}</p>
      </div>
      <div class="score-big">{{ percent(selectedValidation.averageScore) }}</div>
    </div>

    <div v-if="loadingRun" class="empty">Loading...</div>
    <div v-else-if="!detail" class="empty">Run not found.</div>
    <div v-else class="qa-list">
      <article v-for="item in detail.items" :key="item.id" class="qa-card">
        <div class="qa-header">
          <span class="qa-id">{{ item.id }}</span>
          <span class="tag">{{ item.category }}</span>
          <span class="tag">{{ item.generator }}</span>
          <span v-if="manualResultByItem[item.id]?.judge" class="score-mini">
            {{ percent(manualResultByItem[item.id]?.judge?.output.normalizedScore) }}
          </span>
        </div>

        <div class="qa-question">{{ item.question }}</div>

        <div class="answer-editor">
          <div class="editor-head">
            <label :for="`answer-${item.id}`">Answer</label>
            <button type="button" class="btn-secondary" @click="copyQuestion(item.question)">Copy Q</button>
          </div>
          <textarea
            :id="`answer-${item.id}`"
            :value="answers[item.id] ?? ''"
            rows="7"
            @input="onAnswerInput(item.id, $event)"
          />
        </div>

        <div v-if="manualResultByItem[item.id]" class="result-panel">
          <template v-if="manualResultByItem[item.id]?.status === 'error'">
            <div class="task-error">{{ manualResultByItem[item.id]?.error }}</div>
          </template>
          <template v-else>
            <div class="result-head">
              <span class="score-mini inline">{{ percent(manualResultByItem[item.id]?.judge?.output.normalizedScore) }}</span>
              <span>{{ manualResultByItem[item.id]?.judge?.output.verdict }}</span>
              <span class="muted">{{ usageText(manualResultByItem[item.id]?.judge?.metrics) }}</span>
            </div>
            <div v-if="manualResultByItem[item.id]?.judge?.output.judgeSummary" class="judge-summary">
              {{ manualResultByItem[item.id]?.judge?.output.judgeSummary }}
            </div>
          </template>
        </div>
      </article>
    </div>

    <div v-if="Object.keys(tasks).length" class="tasks-panel">
      <h2>Tasks</h2>
      <div v-for="(state, key) in tasks" :key="key" class="task-card">
        <div class="task-header">
          <span class="status-badge" :class="state.status">{{ state.status }}</span>
          <span class="task-project">{{ state.project }}</span>
          <span class="task-run">{{ state.runId }}</span>
          <span v-if="state.docVariant" class="variant-tag">{{ state.docVariant }}</span>
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
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import {
  fetchRunDetailById,
  fetchRuns,
  fetchValidateStatus,
  fetchValidationByVariant,
  startManualValidate,
  type AgentMetrics,
  type GenerateStatusResponse,
  type RunDetail,
  type RunSummary,
  type TaskState,
  type ValidationDetail,
  type ValidationItem,
  type ValidationSummary,
} from '../services/api'

const route = useRoute()
const runs = ref<RunSummary[]>([])
const tasks = ref<Record<string, TaskState>>({})
const selectedRunKey = ref('')
const detail = ref<RunDetail | null>(null)
const validationDetail = ref<ValidationDetail | null>(null)
const loadingRun = ref(false)
const submitError = ref('')
const answers = reactive<Record<string, string>>({})

const form = reactive({
  answerProvider: 'ChatGPT 5.5',
  docVariant: 'chatgpt-5-5',
  judgeProvider: 'claude',
  language: '',
})

let pollTimer: ReturnType<typeof setInterval> | null = null

const selectedRun = computed(() =>
  runs.value.find(run => runKey(run) === selectedRunKey.value),
)

const answeredCount = computed(() =>
  Object.values(answers).filter(answer => answer.trim().length > 0).length,
)

const labelIsSafe = computed(() =>
  /^[A-Za-z0-9_-]+$/.test(form.docVariant),
)

const canSubmit = computed(() =>
  Boolean(selectedRun.value)
    && answeredCount.value > 0
    && labelIsSafe.value
    && !isSelectedRunning.value,
)

const selectedValidation = computed<ValidationSummary | undefined>(() => {
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
      && t.docVariant === form.docVariant,
  )
})

const manualResultByItem = computed<Record<string, ValidationItem>>(() =>
  Object.fromEntries((validationDetail.value?.results ?? []).map(item => [item.itemId, item])),
)

watch(() => form.docVariant, async () => {
  await loadManualValidation()
  restoreAnswers()
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
  await loadSelectedRun()
  if (hasRunning.value) startPolling()
})

onUnmounted(() => stopPolling())

async function loadSelectedRun() {
  const run = selectedRun.value
  detail.value = null
  validationDetail.value = null
  clearAnswers()
  if (!run) return
  loadingRun.value = true
  try {
    detail.value = await fetchRunDetailById(run.project, run.runId)
    await loadManualValidation()
    restoreAnswers()
  } finally {
    loadingRun.value = false
  }
}

async function loadManualValidation() {
  const run = selectedRun.value
  if (!run || !labelIsSafe.value) {
    validationDetail.value = null
    return
  }
  try {
    validationDetail.value = await fetchValidationByVariant(run.project, run.runId, form.docVariant)
  } catch {
    validationDetail.value = null
  }
}

async function submit() {
  const run = selectedRun.value
  if (!run || !canSubmit.value) return
  submitError.value = ''
  const payload = Object.fromEntries(
    Object.entries(answers)
      .map(([id, answer]) => [id, answer.trim()] as const)
      .filter(([, answer]) => answer.length > 0),
  )
  const res = await startManualValidate({
    project: run.project,
    runId: run.runId,
    docVariant: form.docVariant,
    answerProvider: form.answerProvider.trim() || 'ChatGPT 5.5',
    judgeProvider: form.judgeProvider,
    language: form.language || undefined,
    answers: payload,
  })
  if (!res.ok) {
    submitError.value = res.error ?? 'Validation failed to start.'
    return
  }
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
      await loadManualValidation()
    }
  }, 2000)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function onAnswerInput(itemId: string, event: Event) {
  answers[itemId] = (event.target as HTMLTextAreaElement).value
  saveDraft()
}

function restoreAnswers() {
  clearAnswers()
  const raw = localStorage.getItem(draftKey())
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const [id, answer] of Object.entries(parsed)) {
        if (typeof answer === 'string') answers[id] = answer
      }
      return
    } catch {
      localStorage.removeItem(draftKey())
    }
  }
  for (const item of validationDetail.value?.results ?? []) {
    if (item.answer?.text) answers[item.itemId] = item.answer.text
  }
}

function saveDraft() {
  const key = draftKey()
  if (!key) return
  localStorage.setItem(key, JSON.stringify(answers))
}

function draftKey(): string {
  const run = selectedRun.value
  return run ? `manual-validation:${run.project}/${run.runId}` : ''
}

function clearAnswers() {
  for (const key of Object.keys(answers)) delete answers[key]
}

async function copyQuestion(question: string) {
  try {
    await navigator.clipboard.writeText(question)
  } catch {
    /* ignore clipboard errors */
  }
}

function runKey(run: RunSummary): string {
  return `${run.project}/${run.runId}`
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-'
  return `${Math.round(value * 100)}%`
}

function formatTokens(n: number | undefined): string {
  if (n == null) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function usageText(metrics: AgentMetrics | undefined): string {
  if (!metrics) return ''
  const parts: string[] = []
  if (metrics.inputTokens != null) parts.push(`in ${formatTokens(metrics.inputTokens)}`)
  if (metrics.outputTokens != null) parts.push(`out ${formatTokens(metrics.outputTokens)}`)
  if (metrics.cachedInputTokens) parts.push(`cached ${formatTokens(metrics.cachedInputTokens)}`)
  if (metrics.reasoningOutputTokens) parts.push(`reason ${formatTokens(metrics.reasoningOutputTokens)}`)
  if (metrics.costUsd != null) parts.push(`$${metrics.costUsd.toFixed(3)}`)
  if (metrics.durationMs != null) parts.push(`${(metrics.durationMs / 1000).toFixed(1)}s`)
  return parts.join(' · ')
}
</script>

<style scoped>
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.page-head h1 {
  font-size: 20px;
  font-weight: 600;
}

.control-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 860px;
  margin-bottom: 24px;
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

.field.wide {
  max-width: 620px;
}

.field label,
.editor-head label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}

.field input,
.field select,
.answer-editor textarea {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-card);
  color: var(--text);
  outline: none;
  transition: border-color 0.15s;
}

.field input:focus,
.field select:focus,
.answer-editor textarea:focus {
  border-color: var(--accent);
}

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.btn-primary,
.btn-secondary {
  border: none;
  border-radius: 6px;
  font-weight: 600;
  transition: background 0.15s, border-color 0.15s;
}

.btn-primary {
  padding: 10px 24px;
  background: var(--accent);
  color: #fff;
}

.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-secondary {
  padding: 6px 10px;
  background: var(--bg-card);
  color: var(--text-secondary);
  border: 1px solid var(--border);
  font-size: 12px;
}

.btn-secondary:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.link-button {
  color: var(--accent);
  text-decoration: none;
  font-size: 13px;
  font-weight: 600;
}

.form-error,
.task-error {
  color: var(--red);
  font-size: 13px;
}

.summary-panel {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  background: var(--bg-card);
  max-width: 860px;
  margin-bottom: 20px;
}

.summary-panel h2 {
  font-size: 15px;
  font-weight: 600;
}

.summary-panel p,
.muted {
  color: var(--text-secondary);
  font-size: 12px;
}

.score-big {
  font-size: 28px;
  font-weight: 700;
  color: var(--green);
}

.empty {
  color: var(--text-secondary);
  padding: 40px 0;
  text-align: center;
}

.qa-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.qa-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  background: var(--bg-card);
}

.qa-header,
.editor-head,
.result-head,
.task-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.qa-header {
  margin-bottom: 6px;
}

.qa-id,
.task-run {
  font-family: monospace;
  font-size: 12px;
  color: var(--text-tertiary);
}

.tag,
.variant-tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--tag-bg);
  font-size: 12px;
}

.score-mini {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 4px;
  background: #dcfce7;
  color: #166534;
  font-size: 12px;
  font-weight: 700;
}

.score-mini.inline {
  margin-left: 0;
}

.qa-question {
  font-size: 14px;
  line-height: 1.55;
  margin-bottom: 12px;
}

.answer-editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.editor-head {
  justify-content: space-between;
}

.answer-editor textarea {
  width: 100%;
  min-height: 150px;
  resize: vertical;
  line-height: 1.55;
}

.result-panel {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.judge-summary {
  margin-top: 8px;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--tag-bg);
  font-size: 13px;
  line-height: 1.5;
}

.tasks-panel {
  margin-top: 32px;
  max-width: 860px;
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

.task-project {
  font-weight: 600;
  font-size: 14px;
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
  color: #1e40af;
}

.status-badge.done {
  background: #dcfce7;
  color: #166534;
}

.status-badge.error {
  background: #fee2e2;
  color: #991b1b;
}

.log-panel {
  margin-top: 8px;
  padding: 8px 10px;
  background: var(--tag-bg);
  border-radius: 6px;
  max-height: 180px;
  overflow: auto;
  font-family: monospace;
  font-size: 12px;
  color: var(--text-secondary);
}

@media (max-width: 760px) {
  .row {
    grid-template-columns: 1fr;
  }

  .summary-panel,
  .page-head {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (prefers-color-scheme: dark) {
  .score-mini,
  .status-badge.done {
    background: #14532d;
    color: #86efac;
  }

  .status-badge.running {
    background: #1e3a8a;
    color: #bfdbfe;
  }

  .status-badge.error {
    background: #7f1d1d;
    color: #fecaca;
  }
}
</style>
