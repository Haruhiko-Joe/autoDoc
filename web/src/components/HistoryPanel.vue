<script setup lang="ts">
import { ref, watch, toRef } from 'vue'
import DiffView from './DiffView.vue'
import { useDocHistory } from '../composables/useDocHistory'

const props = defineProps<{
  project: string
  relPath: string
  visible: boolean
}>()

const emit = defineEmits<{
  close: []
  revert: [version: number]
}>()

const projectRef = toRef(props, 'project')
const relPathRef = toRef(props, 'relPath')
const { versions, loading, load, diff } = useDocHistory(projectRef, relPathRef)

watch(() => [props.visible, props.relPath], ([vis]) => {
  if (vis) load()
})

const diffVisible = ref(false)
const diffContentA = ref('')
const diffContentB = ref('')
const diffVersionA = ref(0)
const diffVersionB = ref(0)

async function showDiff(vA: number, vB: number) {
  const result = await diff(vA, vB)
  diffContentA.value = result.contentA
  diffContentB.value = result.contentB
  diffVersionA.value = vA
  diffVersionB.value = vB
  diffVisible.value = true
}
</script>

<template>
  <Transition name="panel-slide">
    <aside v-if="visible" class="history-panel">
      <div class="panel-header">
        <h3>History</h3>
        <button class="panel-close" @click="emit('close')">&times;</button>
      </div>
      <div class="panel-path">{{ relPath }}</div>
      <div class="timeline" v-if="!loading">
        <div class="timeline-item" v-for="(v, i) in versions" :key="v.version">
          <div class="timeline-dot" />
          <div class="timeline-content">
            <div class="version-header">
              <span class="version-num">v{{ v.version }}</span>
              <span class="version-ts" v-if="v.ts">{{ new Date(v.ts).toLocaleString() }}</span>
            </div>
            <div class="version-source" v-if="v.source">
              <span class="source-badge" :class="v.source.type">{{ v.source.type }}</span>
              <span v-if="v.source.ref" class="source-ref">{{ v.source.ref }}</span>
            </div>
            <div class="version-summary" v-if="v.summary">{{ v.summary }}</div>
            <div class="version-actions">
              <button class="action-btn" @click="emit('revert', v.version)">Revert</button>
              <button
                v-if="i < versions.length - 1"
                class="action-btn"
                @click="showDiff(versions[i + 1]!.version, v.version)"
              >Compare</button>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="panel-loading">Loading...</div>

      <DiffView
        :visible="diffVisible"
        :content-a="diffContentA"
        :content-b="diffContentB"
        :version-a="diffVersionA"
        :version-b="diffVersionB"
        @close="diffVisible = false"
      />
    </aside>
  </Transition>
</template>

<style scoped>
.history-panel {
  width: 340px;
  background: var(--bg-sidebar);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.panel-header h3 { margin: 0; font-size: 15px; color: var(--text-heading); }

.panel-close {
  background: none; border: none; font-size: 20px;
  color: var(--text-disabled); cursor: pointer;
}

.panel-path {
  padding: 8px 20px;
  font-size: 12px;
  color: var(--text-disabled);
  font-family: monospace;
  border-bottom: 1px solid var(--border);
}

.timeline {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}

.timeline-item {
  display: flex;
  gap: 12px;
  padding-bottom: 20px;
  position: relative;
}

.timeline-item:not(:last-child)::after {
  content: '';
  position: absolute;
  left: 5px;
  top: 16px;
  bottom: 0;
  width: 1px;
  background: var(--border);
}

.timeline-dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--accent);
  border: 2px solid var(--bg-sidebar);
  flex-shrink: 0;
  margin-top: 3px;
  z-index: 1;
}

.timeline-content {
  flex: 1;
  min-width: 0;
}

.version-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.version-num {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.version-ts {
  font-size: 11px;
  color: var(--text-disabled);
}

.version-source {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.source-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  text-transform: uppercase;
}

.source-badge.commit { background: #dbeafe; color: #2563eb; }
.source-badge.pr { background: #dcfce7; color: #16a34a; }
.source-badge.manual { background: #fef3c7; color: #d97706; }
.source-badge.agent { background: #ede9fe; color: #7c3aed; }

.source-ref {
  font-size: 11px;
  color: var(--text-secondary);
  font-family: monospace;
}

.version-summary {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.version-actions {
  display: flex;
  gap: 6px;
}

.action-btn {
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
}

.action-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.panel-loading {
  padding: 40px;
  text-align: center;
  color: var(--text-disabled);
}

.panel-slide-enter-active,
.panel-slide-leave-active {
  transition: transform 0.25s ease, opacity 0.25s ease;
}

.panel-slide-enter-from,
.panel-slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
</style>
