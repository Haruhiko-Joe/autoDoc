<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchInsights } from '../services/doc'
import { firstRouteParam } from '../utils/routeParams'
import type { InsightRecord, InsightItem, InsightSeverity } from '../services/doc'

interface FlatInsight extends InsightItem {
  scope: 'decomposer' | 'writer'
  nodeId: string
  ref?: string
}

const route = useRoute()
const router = useRouter()
const records = ref<InsightRecord[]>([])
const loading = ref(true)
const error = ref('')

const severityFilter = ref<InsightSeverity | 'all'>('all')
const scopeFilter = ref<'decomposer' | 'writer' | 'all'>('all')

const SEVERITY_ORDER: InsightSeverity[] = ['critical', 'high', 'medium', 'low']
const SEVERITY_RANK: Record<InsightSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 }

function getProject(): string {
  return firstRouteParam(route.params.project)
}

async function load() {
  loading.value = true
  error.value = ''
  const project = getProject()
  if (!project) { error.value = 'Missing project.'; loading.value = false; return }
  try {
    records.value = await fetchInsights(project)
  } catch {
    error.value = 'Failed to load insights.'
  } finally {
    loading.value = false
  }
}

onMounted(load)

const flat = computed<FlatInsight[]>(() =>
  records.value.flatMap((r) =>
    r.insights.map((i) => ({ ...i, scope: r.scope, nodeId: r.nodeId, ref: r.ref })),
  ),
)

const severityCounts = computed<Record<InsightSeverity, number>>(() => {
  const counts: Record<InsightSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const i of flat.value) counts[i.severity]++
  return counts
})

const filtered = computed<FlatInsight[]>(() => {
  const list = flat.value.filter((i) =>
    (severityFilter.value === 'all' || i.severity === severityFilter.value) &&
    (scopeFilter.value === 'all' || i.scope === scopeFilter.value),
  )
  return [...list].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
})

function goToDoc(item: FlatInsight) {
  const path = item.ref ?? item.nodeId
  if (path) router.push(`/${getProject()}/doc/${path}`)
}
</script>

<template>
  <div class="insights-page">
    <header class="page-header">
      <nav class="breadcrumb">
        <a @click="router.push({ name: 'project', params: { project: getProject() } })">Home</a>
        <span class="bc-sep">/</span>
        <span class="bc-current">Code Insights</span>
      </nav>

      <div class="header-row">
        <h1>Code Insights</h1>
        <span class="total-chip">{{ flat.length }} findings</span>
      </div>
      <p class="subtitle">
        Issues and improvement opportunities the agents observed while reading the code. Read-only — review and act through your own dev workflow.
      </p>

      <div class="filters" v-if="flat.length">
        <div class="filter-group">
          <button class="chip" :class="{ active: severityFilter === 'all' }" @click="severityFilter = 'all'">All</button>
          <button
            v-for="s in SEVERITY_ORDER" :key="s"
            class="chip sev" :class="[`sev-${s}`, { active: severityFilter === s }]"
            @click="severityFilter = s"
          >
            <span class="dot" :class="`bg-${s}`"></span>{{ s }}
            <span class="chip-count">{{ severityCounts[s] }}</span>
          </button>
        </div>
        <div class="filter-group">
          <button class="chip" :class="{ active: scopeFilter === 'all' }" @click="scopeFilter = 'all'">All sources</button>
          <button class="chip" :class="{ active: scopeFilter === 'decomposer' }" @click="scopeFilter = 'decomposer'">decomposer</button>
          <button class="chip" :class="{ active: scopeFilter === 'writer' }" @click="scopeFilter = 'writer'">writer</button>
        </div>
      </div>
    </header>

    <main class="list-area">
      <div v-if="loading" class="status-msg">Loading&hellip;</div>
      <div v-else-if="error" class="status-msg is-error">{{ error }}</div>
      <div v-else-if="!flat.length" class="status-msg">
        No insights recorded yet. They are collected in the background after each module is documented.
      </div>
      <div v-else-if="!filtered.length" class="status-msg">No insights match the current filters.</div>

      <div v-else class="cards">
        <article v-for="(item, i) in filtered" :key="i" class="card" :class="`accent-${item.severity}`">
          <div class="card-top">
            <span class="badge" :class="`bg-${item.severity}`">{{ item.severity }}</span>
            <span class="category">{{ item.category }}</span>
            <span class="confidence">confidence: {{ item.confidence }}</span>
          </div>

          <h3 class="card-title">{{ item.title }}</h3>

          <div class="locations" v-if="item.locations.length">
            <code v-for="(loc, li) in item.locations" :key="li" class="loc">{{ loc }}</code>
          </div>

          <p class="problem">{{ item.problem }}</p>

          <div class="plan">
            <span class="plan-label">Plan</span>
            <p class="plan-text">{{ item.plan }}</p>
          </div>

          <footer class="card-foot">
            <span class="scope-tag">{{ item.scope }}</span>
            <a class="source" @click="goToDoc(item)">{{ item.ref ?? item.nodeId }} &rarr;</a>
          </footer>
        </article>
      </div>
    </main>
  </div>
</template>

<style scoped>
.insights-page {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;
  background: var(--flows-bg);
  color: var(--text-primary);
}

/* ─── Header ─── */

.page-header {
  flex-shrink: 0;
  padding: 20px 28px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
}

.breadcrumb {
  font-size: 13px;
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  gap: 2px;
}

.breadcrumb a {
  color: var(--accent);
  cursor: pointer;
  text-decoration: none;
}

.breadcrumb a:hover { text-decoration: underline; }

.bc-sep { margin: 0 6px; color: var(--text-muted); }
.bc-current { color: var(--text-primary); font-weight: 600; }

.header-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 6px;
}

.header-row h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.02em;
}

.total-chip {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  color: var(--text-muted);
}

.subtitle {
  margin: 0 0 14px;
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.55;
  max-width: 720px;
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.filter-group {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--bg-surface);
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
  font-family: inherit;
  text-transform: capitalize;
}

.chip:hover { border-color: var(--accent); color: var(--accent); }

.chip.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.chip-count {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 11px;
  opacity: 0.7;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

/* ─── Severity colors ─── */

.bg-critical { background: var(--severity-critical); }
.bg-high { background: var(--severity-high); }
.bg-medium { background: var(--severity-medium); }
.bg-low { background: var(--severity-low); }

/* ─── List ─── */

.list-area {
  flex: 1;
  overflow-y: auto;
  padding: 24px 28px 48px;
}

.status-msg {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 60%;
  font-size: 14px;
  color: var(--text-muted);
  text-align: center;
  max-width: 460px;
  margin: 0 auto;
  line-height: 1.6;
}

.status-msg.is-error { color: var(--color-red); }

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 14px;
  max-width: 1400px;
  margin: 0 auto;
}

.card {
  position: relative;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-left-width: 3px;
  border-radius: var(--radius-card);
  padding: 16px 18px;
  box-shadow: var(--shadow-soft);
}

.accent-critical { border-left-color: var(--severity-critical); }
.accent-high { border-left-color: var(--severity-high); }
.accent-medium { border-left-color: var(--severity-medium); }
.accent-low { border-left-color: var(--severity-low); }

.card-top {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.badge {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #fff;
  padding: 2px 8px;
  border-radius: var(--radius-control);
}

[data-theme='dark'] .badge { color: rgba(0, 0, 0, 0.85); }

.category {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-base);
  border: 1px solid var(--border);
  padding: 2px 8px;
  border-radius: var(--radius-control);
  text-transform: capitalize;
}

.confidence {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted);
}

.card-title {
  margin: 0 0 10px;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: -0.01em;
}

.locations {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.loc {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 11px;
  background: var(--bg-base);
  color: var(--text-secondary);
  padding: 3px 8px;
  border-radius: var(--radius-control);
  border: 1px solid var(--border);
  max-width: 100%;
  overflow-wrap: anywhere;
}

.problem {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.plan {
  background: var(--bg-base);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-control);
  padding: 10px 12px;
  margin-bottom: 12px;
}

.plan-label {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 5px;
}

.plan-text {
  margin: 0;
  font-size: 13px;
  color: var(--text-primary);
  line-height: 1.6;
}

.card-foot {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
}

.scope-tag {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-base);
  border: 1px solid var(--border);
  padding: 2px 8px;
  border-radius: 999px;
}

.source {
  font-family: 'SFMono-Regular', Consolas, monospace;
  color: var(--accent);
  cursor: pointer;
  text-decoration: none;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source:hover { text-decoration: underline; }
</style>
