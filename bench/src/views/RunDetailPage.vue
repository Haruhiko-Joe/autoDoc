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
        <span>{{ detail.language }}</span>
        <span v-for="p in detail.providers" :key="p" class="tag">{{ p }}</span>
        <span class="date">{{ formatDate(detail.createdAt) }}</span>
      </div>

      <div class="qa-list">
        <div v-for="item in detail.items" :key="item.id" class="qa-card"
             :class="{ expanded: expandedId === item.id }"
             @click="toggle(item.id)">
          <div class="qa-header">
            <span class="qa-id">{{ item.id }}</span>
            <span class="tag">{{ item.category }}</span>
            <span class="tag">{{ item.generator }}</span>
          </div>
          <div class="qa-question">{{ item.question }}</div>
          <div v-if="expandedId === item.id" class="qa-detail">
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
import { ref, onMounted } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { fetchRunDetail, type RunDetail } from '../services/api'

const route = useRoute()
const project = route.params.project as string

const detail = ref<RunDetail | null>(null)
const loading = ref(true)
const expandedId = ref<string | null>(null)

onMounted(async () => {
  detail.value = await fetchRunDetail(project)
  loading.value = false
})

function toggle(id: string) {
  expandedId.value = expandedId.value === id ? null : id
}

function formatDate(iso: string): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString()
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
  margin-bottom: 24px;
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
</style>
