<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, inject, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchTopGraph, startRun, fetchStatus, fetchProjects, type RunStatus } from '../services/doc'
import GraphView from '../components/GraphView.vue'
import EdgeLegend from '../components/EdgeLegend.vue'
import DocTree from '../components/DocTree.vue'
import type { TopGraph } from '../types'

const route = useRoute()
const router = useRouter()
const setSessionId = inject<(id: string) => void>('setSessionId')
const topGraph = ref<TopGraph | null>(null)
const repoPath = ref('')
const projects = ref<string[]>([])
const selectedProject = ref('')
const status = ref<RunStatus>({ phase: 'idle' })
const errorMsg = ref('')
const graphLoading = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

function getRouteProject(): string {
  const project = route.query.project
  return Array.isArray(project) ? (project[0] ?? '') : (project ?? '')
}

function getProjectName(repoPathValue: string): string {
  const normalized = repoPathValue.trim().replace(/[/\\]+$/, '')
  const parts = normalized.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

function mergeProjects(nextProjects: string[]) {
  const merged = new Set(nextProjects)
  if (status.value.currentProject) merged.add(status.value.currentProject)
  projects.value = [...merged].filter(Boolean).sort()
}

async function refreshProjects() {
  try {
    mergeProjects(await fetchProjects())
  } catch {
    mergeProjects([])
  }
}

onMounted(async () => {
  const [s, existingProjects] = await Promise.all([
    fetchStatus(),
    fetchProjects().catch(() => []),
  ])
  status.value = s
  mergeProjects(existingProjects)
  if (s.repoPath) repoPath.value = s.repoPath

  const routeProject = getRouteProject()
  selectedProject.value = routeProject || s.currentProject || projects.value[0] || ''

  if (!routeProject && selectedProject.value) {
    await router.replace({ name: 'home', query: { project: selectedProject.value } })
  }

  if (selectedProject.value) {
    await loadGraph(selectedProject.value)
  }

  if (s.phase === 'running') {
    startPolling()
  }
})

onUnmounted(() => stopPolling())

watch(() => route.query.project, async () => {
  const routeProject = getRouteProject()
  if (routeProject === selectedProject.value) return
  selectedProject.value = routeProject
  errorMsg.value = ''
  topGraph.value = null
  if (routeProject) {
    await loadGraph(routeProject)
  }
})

async function handleRun() {
  if (!repoPath.value.trim()) return
  errorMsg.value = ''
  topGraph.value = null
  try {
    const project = getProjectName(repoPath.value)
    await startRun(repoPath.value.trim())
    status.value = { phase: 'running', repoPath: repoPath.value.trim(), currentProject: project }
    selectedProject.value = project
    mergeProjects([...projects.value, project])
    await router.replace({ name: 'home', query: { project } })
    startPolling()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  }
}

function startPolling() {
  stopPolling()
  pollTimer = setInterval(async () => {
    const s = await fetchStatus()
    status.value = s
    mergeProjects(projects.value)
    if (s.phase === 'running') {
      if (selectedProject.value === s.currentProject) {
        await tryLoadGraph(selectedProject.value)
      }
    } else if (s.phase === 'done') {
      stopPolling()
      await refreshProjects()
      if (selectedProject.value) await loadGraph(selectedProject.value)
    } else if (s.phase === 'error') {
      stopPolling()
      errorMsg.value = s.message ?? 'Unknown error'
    }
  }, 2000)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function tryLoadGraph(project = selectedProject.value) {
  if (!project || topGraph.value) return
  try {
    topGraph.value = await fetchTopGraph(project)
    if (topGraph.value?.sessionId) setSessionId?.(topGraph.value.sessionId)
  } catch { /* top.json not ready yet */ }
}

async function loadGraph(project = selectedProject.value) {
  if (!project) {
    topGraph.value = null
    return
  }
  graphLoading.value = true
  try {
    topGraph.value = await fetchTopGraph(project)
    if (topGraph.value?.sessionId) setSessionId?.(topGraph.value.sessionId)
  } catch {
    topGraph.value = null
  } finally {
    graphLoading.value = false
  }
}

async function handleProjectChange() {
  errorMsg.value = ''
  topGraph.value = null
  if (!selectedProject.value) {
    await router.replace({ name: 'home' })
    return
  }
  await router.replace({ name: 'home', query: { project: selectedProject.value } })
  await loadGraph(selectedProject.value)
}

function graphNodes() {
  if (!topGraph.value) return []
  return topGraph.value.nodes.map((n) => ({
    name: n.name,
    description: n.description,
    edges: n.edges,
    child: { type: 'graph' as const, ref: n.name },
  }))
}

function onNodeClick(node: { child?: { type: string; ref: string } }) {
  if (!node.child || !selectedProject.value) return
  if (node.child.type === 'graph') {
    router.push({ name: 'graph', params: { path: node.child.ref }, query: { project: selectedProject.value } })
  } else {
    router.push({ name: 'page', params: { path: node.child.ref }, query: { project: selectedProject.value } })
  }
}

const progress = computed(() => status.value.progress)
const viewingRunningProject = computed(() => status.value.phase === 'running' && selectedProject.value === status.value.currentProject)
const visibleNodeStates = computed(() => (viewingRunningProject.value ? progress.value?.nodes : undefined))

const totalNodes = computed(() => {
  const c = progress.value?.counts
  if (!c) return 0
  return Object.values(c).reduce((a, b) => a + b, 0)
})

const doneNodes = computed(() => progress.value?.counts?.done ?? 0)

const progressPercent = computed(() => {
  if (totalNodes.value === 0) return 0
  return Math.round((doneNodes.value / totalNodes.value) * 100)
})

const progressPhaseLabel = computed(() => {
  const p = progress.value?.phase
  if (p === 'scaffold') return 'Analyzing project structure...'
  if (p === 'processing') return 'Processing modules...'
  return 'Preparing...'
})
</script>

<template>
  <div class="page-layout">
    <aside class="sidebar">
      <div class="sidebar-header">
        <h2>autoDoc</h2>
      </div>
      <div class="sidebar-input">
        <label class="input-label">Project Path</label>
        <div class="input-row">
          <input
            v-model="repoPath"
            class="path-input"
            placeholder="/path/to/repo"
            :disabled="status.phase === 'running'"
            @keydown.enter="handleRun"
          />
          <button
            class="run-btn"
            :disabled="status.phase === 'running' || !repoPath.trim()"
            @click="handleRun"
          >
            {{ status.phase === 'running' ? '...' : 'Run' }}
          </button>
        </div>
        <label class="input-label select-label">Saved Projects</label>
        <select
          v-model="selectedProject"
          class="project-select"
          :disabled="projects.length === 0"
          @change="handleProjectChange"
        >
          <option value="" disabled>
            {{ projects.length === 0 ? 'No saved projects yet' : 'Select a project' }}
          </option>
          <option v-for="project in projects" :key="project" :value="project">
            {{ project }}
          </option>
        </select>
        <p v-if="errorMsg" class="input-error">{{ errorMsg }}</p>
      </div>

      <!-- 生成过程中的实时进度 -->
      <div v-if="viewingRunningProject && progress" class="sidebar-progress">
        <div class="progress-label">{{ progressPhaseLabel }}</div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" :style="{ width: progressPercent + '%' }" />
        </div>
        <div class="progress-stats">
          <span class="stat">
            <span class="stat-num done">{{ doneNodes }}</span>
            <span class="stat-label">done</span>
          </span>
          <span class="stat" v-if="(progress.counts.decomposing ?? 0) + (progress.counts.writing ?? 0) + (progress.counts.checking ?? 0) > 0">
            <span class="stat-num active">{{ (progress.counts.decomposing ?? 0) + (progress.counts.writing ?? 0) + (progress.counts.checking ?? 0) }}</span>
            <span class="stat-label">active</span>
          </span>
          <span class="stat">
            <span class="stat-num pending">{{ progress.counts.pending ?? 0 }}</span>
            <span class="stat-label">pending</span>
          </span>
          <span class="stat" v-if="(progress.counts.error ?? 0) > 0">
            <span class="stat-num error">{{ progress.counts.error ?? 0 }}</span>
            <span class="stat-label">error</span>
          </span>
        </div>
      </div>

      <div class="sidebar-nav" v-if="topGraph && selectedProject">
        <DocTree :project="selectedProject" :nodes="topGraph.nodes" :node-states="visibleNodeStates" />
      </div>
      <div class="sidebar-footer">
        <EdgeLegend />
      </div>
    </aside>
    <main class="canvas">
      <!-- running 但 top.json 已就绪：即时渲染 graph -->
      <template v-if="topGraph">
        <div class="canvas-header">
          <h1>{{ topGraph.description }}</h1>
          <span class="project-chip">{{ selectedProject }}</span>
          <span v-if="viewingRunningProject" class="live-badge">LIVE</span>
        </div>
        <div class="canvas-graph">
          <GraphView :nodes="graphNodes()" @node-click="onNodeClick" />
        </div>
      </template>
      <template v-else-if="graphLoading">
        <div class="canvas-loading">
          <div class="spinner"></div>
          <p>Loading {{ selectedProject }}...</p>
        </div>
      </template>
      <!-- running 且 top.json 还没好：显示进度 -->
      <template v-else-if="viewingRunningProject">
        <div class="canvas-loading">
          <div class="spinner"></div>
          <p>{{ progressPhaseLabel }}</p>
          <p class="sub">Analyzing {{ status.repoPath }}</p>
        </div>
      </template>
      <template v-else-if="selectedProject">
        <div class="canvas-empty">
          <p>No documentation loaded for {{ selectedProject }}.</p>
        </div>
      </template>
      <template v-else-if="status.phase === 'idle'">
        <div class="canvas-empty">
          <p>Enter a project path and click Run to generate documentation.</p>
        </div>
      </template>
      <template v-else-if="errorMsg">
        <div class="canvas-empty error">{{ errorMsg }}</div>
      </template>
    </main>
  </div>
</template>

<style scoped>
.page-layout {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

.sidebar {
  width: 20%;
  min-width: 220px;
  max-width: 300px;
  background: #fafafa;
  border-right: 1px solid #eee;
  display: flex;
  flex-direction: column;
  padding: 24px 0;
  box-sizing: border-box;
}

.sidebar-header {
  padding: 0 20px 16px;
  border-bottom: 1px solid #eee;
}

.sidebar-header h2 {
  font-size: 20px;
  font-weight: 700;
  color: #1a1a1a;
  margin: 0;
}

.sidebar-input {
  padding: 16px 16px 12px;
  border-bottom: 1px solid #eee;
}

.input-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: #666;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.select-label {
  margin-top: 12px;
}

.input-row {
  display: flex;
  gap: 6px;
}

.path-input {
  flex: 1;
  padding: 7px 10px;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  font-size: 13px;
  outline: none;
  min-width: 0;
}

.path-input:focus {
  border-color: #1890ff;
}

.path-input:disabled {
  background: #f5f5f5;
  color: #999;
}

.run-btn {
  padding: 7px 14px;
  border: none;
  border-radius: 6px;
  background: #1890ff;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.run-btn:hover:not(:disabled) {
  background: #40a9ff;
}

.run-btn:disabled {
  background: #d9d9d9;
  cursor: not-allowed;
}

.input-error {
  margin: 6px 0 0;
  font-size: 12px;
  color: #ff4d4f;
}

.project-select {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  font-size: 13px;
  outline: none;
  background: #fff;
  color: #333;
}

.project-select:focus {
  border-color: #1890ff;
}

.project-select:disabled {
  background: #f5f5f5;
  color: #999;
}

/* ─── Progress ─── */

.sidebar-progress {
  padding: 14px 16px;
  border-bottom: 1px solid #eee;
}

.progress-label {
  font-size: 12px;
  color: #1890ff;
  font-weight: 600;
  margin-bottom: 8px;
}

.progress-bar-track {
  height: 6px;
  background: #f0f0f0;
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 10px;
}

.progress-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #1890ff, #52c41a);
  border-radius: 3px;
  transition: width 0.5s ease;
}

.progress-stats {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.stat {
  display: flex;
  align-items: baseline;
  gap: 3px;
}

.stat-num {
  font-size: 16px;
  font-weight: 700;
}

.stat-num.done { color: #52c41a; }
.stat-num.active { color: #1890ff; }
.stat-num.pending { color: #faad14; }
.stat-num.error { color: #ff4d4f; }

.stat-label {
  font-size: 11px;
  color: #999;
}

/* ─── Canvas ─── */

.sidebar-nav {
  flex: 1;
  padding: 12px 0;
  overflow-y: auto;
}

.sidebar-footer {
  padding: 16px 12px 0;
  border-top: 1px solid #eee;
}

.canvas {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.canvas-header {
  padding: 24px 32px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.canvas-header h1 {
  font-size: 18px;
  font-weight: 500;
  color: #666;
  margin: 0;
  line-height: 1.5;
}

.project-chip {
  font-size: 11px;
  font-weight: 700;
  color: #666;
  background: #f5f5f5;
  border: 1px solid #e8e8e8;
  border-radius: 999px;
  padding: 3px 10px;
  flex-shrink: 0;
}

.live-badge {
  font-size: 10px;
  font-weight: 700;
  color: #52c41a;
  background: #f6ffed;
  border: 1px solid #b7eb8f;
  border-radius: 4px;
  padding: 2px 8px;
  letter-spacing: 1px;
  animation: pulse 2s infinite;
  flex-shrink: 0;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.canvas-graph {
  flex: 1;
  margin: 0 16px 16px;
  border: 1px solid #eee;
  border-radius: 8px;
  overflow: hidden;
}

.canvas-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #999;
  font-size: 15px;
}

.canvas-empty.error {
  color: #ff4d4f;
}

.canvas-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 16px;
}

.canvas-loading p {
  margin: 0;
  color: #666;
  font-size: 15px;
}

.canvas-loading .sub {
  font-size: 13px;
  color: #999;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid #f0f0f0;
  border-top-color: #1890ff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
