<template>
  <div class="page">
    <h1>QA Generation Runs</h1>
    <div v-if="loading" class="empty">Loading...</div>
    <div v-else-if="runs.length === 0" class="empty">
      No runs yet.
      <RouterLink to="/generate">Generate QA pairs</RouterLink>
    </div>
    <table v-else class="run-table">
      <thead>
        <tr>
          <th>Project</th>
          <th>Run</th>
          <th>Items</th>
          <th>Providers</th>
          <th>Validation</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="run in runs" :key="`${run.project}/${run.runId}`"
            class="run-row" @click="goToRun(run)">
          <td class="cell-project">{{ run.project }}</td>
          <td class="cell-id">{{ run.runId }}</td>
          <td class="cell-count">{{ run.itemCount }}</td>
          <td>
            <span v-for="p in run.providers" :key="p" class="tag">{{ p }}</span>
          </td>
          <td>
            <div v-if="validationEntries(run).length" class="validation-pills">
              <span v-for="entry in validationEntries(run)" :key="entry.variant" class="score-pill">
                <span class="variant-name">{{ entry.variant }}</span>
                {{ percent(entry.summary.averageScore) }}
                <span class="score-sub">{{ entry.summary.completedCount }}/{{ entry.summary.itemCount }}</span>
              </span>
            </div>
            <span v-else class="muted">Not run</span>
          </td>
          <td class="cell-date">{{ formatDate(run.createdAt) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter, RouterLink } from 'vue-router'
import { fetchRuns, type RunSummary } from '../services/api'

const router = useRouter()
const runs = ref<RunSummary[]>([])
const loading = ref(true)

onMounted(async () => {
  runs.value = await fetchRuns()
  loading.value = false
})

function goToRun(run: RunSummary) {
  router.push({ name: 'detail', params: { project: run.project, runId: run.runId } })
}

function validationEntries(run: RunSummary) {
  const validations = run.validations ?? (run.validation ? { [run.validation.docVariant]: run.validation } : {})
  return Object.entries(validations)
    .map(([variant, summary]) => ({ variant, summary }))
    .sort((a, b) => variantRank(a.variant) - variantRank(b.variant) || a.variant.localeCompare(b.variant))
}

function variantRank(variant: string): number {
  return ['full', 'no-edges', 'flat-md', 'source'].indexOf(variant) === -1
    ? 99
    : ['full', 'no-edges', 'flat-md', 'source'].indexOf(variant)
}

function formatDate(iso: string): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString()
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
  margin-bottom: 20px;
}

.empty {
  color: var(--text-secondary);
  padding: 40px 0;
  text-align: center;
}

.empty a {
  color: var(--accent);
  margin-left: 4px;
}

.run-table {
  width: 100%;
  border-collapse: collapse;
}

.run-table th {
  text-align: left;
  padding: 8px 12px;
  font-weight: 600;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
  border-bottom: 2px solid var(--border);
}

.run-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.run-row {
  cursor: pointer;
  transition: background 0.1s;
}

.run-row:hover {
  background: var(--tag-bg);
}

.cell-project {
  font-weight: 600;
}

.cell-id {
  font-family: monospace;
  font-size: 12px;
  color: var(--text-secondary);
  max-width: 210px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-count {
  font-variant-numeric: tabular-nums;
}

.cell-date {
  color: var(--text-secondary);
  font-size: 13px;
}

.tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--tag-bg);
  font-size: 12px;
  margin-right: 4px;
}

.validation-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.score-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 2px 8px;
  border-radius: 4px;
  background: #dcfce7;
  color: #166534;
  font-size: 12px;
  font-weight: 600;
}

.variant-name {
  color: #14532d;
  font-weight: 700;
}

.score-sub {
  color: #15803d;
  font-weight: 500;
}

.muted {
  color: var(--text-tertiary);
  font-size: 12px;
}

@media (prefers-color-scheme: dark) {
  .score-pill {
    background: #14532d;
    color: #86efac;
  }
  .variant-name {
    color: #bbf7d0;
  }
  .score-sub {
    color: #bbf7d0;
  }
}
</style>
