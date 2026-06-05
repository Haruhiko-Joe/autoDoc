<template>
  <div class="page">
    <div class="header">
      <RouterLink to="/" class="back">&larr; Back</RouterLink>
      <h1 v-if="detail">{{ detail.project }}</h1>
    </div>

    <div v-if="loading" class="empty">Loading...</div>
    <div v-else-if="!detail" class="empty">Run not found.</div>
    <template v-else>
      <div class="meta">
        <span>{{ detail.items.length }} items</span>
        <span class="run-id">{{ detail.runId }}</span>
        <span>{{ detail.language }}</span>
        <span v-for="p in detail.providers" :key="p" class="tag">{{ p }}</span>
        <RouterLink :to="{ name: 'validate', query: { project: detail.project, runId: detail.runId } }" class="validate-link">
          Run Validation
        </RouterLink>
        <span class="date">{{ formatDate(detail.createdAt) }}</span>
      </div>

      <div v-if="validationDetail" class="validation-panel">
        <div class="validation-head">
          <div>
            <h2>Validation</h2>
            <p>{{ validationDetail.docVariant }} - {{ validationDetail.mode }} - answer {{ validationDetail.answerProvider }} - judge {{ validationDetail.judgeProvider }}</p>
          </div>
          <div class="validation-side">
            <select v-if="validationEntries.length > 1" v-model="selectedVariant" class="variant-select" @change="loadSelectedValidation">
              <option v-for="entry in validationEntries" :key="entry.variant" :value="entry.variant">
                {{ entry.variant }}
              </option>
            </select>
            <div class="score-big">{{ percent(validationDetail.averageScore) }}</div>
          </div>
        </div>
        <div class="validation-stats">
          <span>{{ validationDetail.completedCount }}/{{ validationDetail.itemCount }} completed</span>
          <span>{{ formatDate(validationDetail.updatedAt) }}</span>
        </div>
      </div>

      <div class="qa-list">
        <div v-for="item in detail.items" :key="item.id" class="qa-card"
             :class="{ expanded: expandedId === item.id }"
             @click="toggle(item.id)">
          <div class="qa-header">
            <span class="qa-id">{{ item.id }}</span>
            <span class="tag">{{ item.category }}</span>
            <span class="tag">{{ item.generator }}</span>
            <span v-if="validationByItem[item.id]?.judge" class="score-mini">
              {{ percent(validationByItem[item.id]?.judge?.output.normalizedScore) }}
            </span>
          </div>
          <div class="qa-question">{{ item.question }}</div>
          <div v-if="expandedId === item.id" class="qa-detail" @click.stop>
            <div v-if="validationByItem[item.id]" class="section validation-detail">
              <h3>Validation Result</h3>
              <template v-if="validationByItem[item.id]?.status === 'error'">
                <div class="task-error">{{ validationByItem[item.id]?.error }}</div>
              </template>
              <template v-else>
                <div class="score-row">
                  <span class="score-mini inline">{{ percent(validationByItem[item.id]?.judge?.output.normalizedScore) }}</span>
                  <span>{{ validationByItem[item.id]?.judge?.output.verdict }}</span>
                  <span class="muted">{{ usageText(validationByItem[item.id]?.answer?.metrics) }}</span>
                </div>
                <div class="answer-text candidate">{{ validationByItem[item.id]?.answer?.output.answer }}</div>
                <div v-if="validationByItem[item.id]?.answer?.output.citations.length" class="citation-list">
                  <div v-for="citation in validationByItem[item.id]?.answer?.output.citations" :key="citation.source" class="citation">
                    <strong>{{ citation.source }}</strong>
                    <span>{{ citation.summary }}</span>
                  </div>
                </div>
                <div v-if="validationByItem[item.id]?.judge?.output.judgeSummary" class="judge-summary">
                  {{ validationByItem[item.id]?.judge?.output.judgeSummary }}
                </div>
                <div class="scoring-list judge-points">
                  <div v-for="(sp, i) in validationByItem[item.id]?.judge?.output.scoringPointResults" :key="i"
                       class="scoring-item" :class="{ covered: sp.covered, missed: !sp.covered }">
                    <span class="scoring-weight">{{ sp.covered ? 'Hit' : 'Miss' }}</span>
                    <span>{{ sp.point }}</span>
                  </div>
                </div>
              </template>
            </div>
            <div class="section">
              <h3>Gold Answer</h3>
              <div class="answer-text">{{ item.goldAnswer }}</div>
            </div>
            <div class="section">
              <h3>Scoring Points</h3>
              <div class="scoring-list">
                <div v-for="(sp, i) in item.scoringPoints" :key="i" class="scoring-item">
                  <span class="scoring-weight">{{ sp.weight }}</span>
                  <span>{{ sp.point }}</span>
                </div>
              </div>
            </div>
            <div class="section">
              <h3>Required Concepts</h3>
              <div class="concepts">
                <span v-for="c in item.requiredConcepts" :key="c" class="tag">{{ c }}</span>
              </div>
            </div>
            <div class="section">
              <h3>Source Evidence</h3>
              <div v-for="(e, i) in item.sourceEvidence" :key="i" class="evidence">
                <code>{{ e.filePath }}</code>
                <span class="line-hint">{{ e.lineHint }}</span>
                <p>{{ e.summary }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import {
  fetchRunDetailById,
  fetchValidationByVariant,
  type AgentRunMetrics,
  type RunDetail,
  type ValidationDetail,
  type ValidationItem,
} from '../services/api'

const route = useRoute()
const project = route.params.project as string
const runId = route.params.runId as string

const detail = ref<RunDetail | null>(null)
const loading = ref(true)
const expandedId = ref<string | null>(null)
const selectedVariant = ref('')
const validationDetail = ref<ValidationDetail | null>(null)
const validationByItem = ref<Record<string, ValidationItem>>({})

const validationEntries = computed(() => {
  const data = detail.value
  const validations = data?.validations ?? (data?.validation ? { [data.validation.docVariant]: data.validation } : {})
  return Object.entries(validations)
    .map(([variant, summary]) => ({ variant, summary }))
    .sort((a, b) => variantRank(a.variant) - variantRank(b.variant) || a.variant.localeCompare(b.variant))
})

onMounted(async () => {
  detail.value = await fetchRunDetailById(project, runId)
  selectedVariant.value = detail.value.validation?.docVariant ?? validationEntries.value[0]?.variant ?? ''
  await loadSelectedValidation()
  loading.value = false
})

async function loadSelectedValidation() {
  if (!detail.value || !selectedVariant.value) {
    validationDetail.value = null
    validationByItem.value = {}
    return
  }

  const current = detail.value.validation
  if (current?.docVariant === selectedVariant.value) {
    validationDetail.value = current
  } else {
    try {
      validationDetail.value = await fetchValidationByVariant(detail.value.project, detail.value.runId, selectedVariant.value)
    } catch {
      validationDetail.value = null
    }
  }

  validationByItem.value = Object.fromEntries(
    (validationDetail.value?.results ?? []).map(item => [item.itemId, item]),
  )
}

function toggle(id: string) {
  expandedId.value = expandedId.value === id ? null : id
}

function formatDate(iso: string): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString()
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-'
  return `${Math.round(value * 100)}%`
}

function usageText(metrics: AgentRunMetrics | undefined): string {
  const tokens = metrics?.usage?.totalTokens
  const tools = metrics?.toolUse?.total
  const parts = []
  if (typeof tokens === 'number') parts.push(`${tokens.toLocaleString()} tokens`)
  if (typeof tools === 'number') parts.push(`${tools} tools`)
  return parts.join(' - ')
}

function variantRank(variant: string): number {
  return ['full', 'no-edges', 'flat-md', 'source'].indexOf(variant) === -1
    ? 99
    : ['full', 'no-edges', 'flat-md', 'source'].indexOf(variant)
}
</script>

<style scoped>
.header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}

.back {
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 14px;
}

.back:hover {
  color: var(--accent);
}

.header h1 {
  font-size: 18px;
  font-weight: 600;
}

.empty {
  color: var(--text-secondary);
  padding: 40px 0;
  text-align: center;
}

.meta {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--text-secondary);
  font-size: 13px;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}

.date {
  margin-left: auto;
}

.tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--tag-bg);
  font-size: 12px;
}

.run-id {
  font-family: monospace;
  font-size: 12px;
  color: var(--text-tertiary);
}

.validate-link {
  color: var(--accent);
  text-decoration: none;
  font-size: 13px;
  font-weight: 600;
}

.validation-panel {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  background: var(--bg-card);
  margin-bottom: 20px;
}

.validation-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}

.validation-side {
  display: flex;
  align-items: center;
  gap: 12px;
}

.variant-select {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-card);
  color: var(--text);
  outline: none;
}

.validation-head h2 {
  font-size: 15px;
  font-weight: 600;
}

.validation-head p,
.validation-stats,
.muted {
  color: var(--text-secondary);
  font-size: 12px;
}

.validation-stats {
  display: flex;
  gap: 16px;
  margin-top: 10px;
}

.score-big {
  font-size: 28px;
  font-weight: 700;
  color: var(--green);
}

.qa-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.qa-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  background: var(--bg-card);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.qa-card:hover {
  border-color: var(--accent);
}

.qa-card.expanded {
  border-color: var(--accent);
  box-shadow: var(--shadow);
}

.qa-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.qa-id {
  font-family: monospace;
  font-size: 12px;
  color: var(--text-tertiary);
}

.qa-question {
  font-size: 14px;
  line-height: 1.5;
}

.qa-detail {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  cursor: default;
}

.section {
  margin-bottom: 16px;
}

.section h3 {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.answer-text {
  white-space: pre-wrap;
  font-size: 14px;
  line-height: 1.6;
  background: var(--tag-bg);
  padding: 12px;
  border-radius: 6px;
}

.candidate {
  background: transparent;
  border: 1px solid var(--border);
}

.concepts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.evidence {
  margin-bottom: 8px;
  padding: 8px 12px;
  background: var(--tag-bg);
  border-radius: 6px;
}

.scoring-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.scoring-item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
  padding: 6px 10px;
  background: var(--tag-bg);
  border-radius: 6px;
}

.scoring-weight {
  min-width: 24px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: #fff;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}

.evidence code {
  font-size: 13px;
  color: var(--accent);
}

.evidence .line-hint {
  margin-left: 8px;
  color: var(--text-tertiary);
  font-size: 12px;
}

.evidence p {
  margin-top: 4px;
  font-size: 13px;
  color: var(--text-secondary);
}

.score-mini {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
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

.validation-detail {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  background: var(--bg-card);
}

.score-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.citation-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}

.citation {
  display: flex;
  gap: 8px;
  font-size: 12px;
  padding: 6px 8px;
  background: var(--tag-bg);
  border-radius: 6px;
}

.judge-summary {
  margin-top: 10px;
  font-size: 13px;
  color: var(--text-secondary);
}

.judge-points {
  margin-top: 10px;
}

.scoring-item.covered .scoring-weight {
  min-width: 40px;
  background: var(--green);
}

.scoring-item.missed .scoring-weight {
  min-width: 40px;
  background: var(--red);
}

.task-error {
  color: var(--red);
  font-size: 13px;
}

@media (prefers-color-scheme: dark) {
  .score-mini {
    background: #14532d;
    color: #86efac;
  }
}
</style>
