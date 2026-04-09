<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchTopGraph, fetchProjects } from '../services/doc'
import GraphView from '../components/GraphView.vue'
import EdgeLegend from '../components/EdgeLegend.vue'
import DocTree from '../components/DocTree.vue'
import { useTheme } from '../composables/useTheme'
import type { TopGraph, GraphNode } from '../types'

const { isDark, toggle: toggleTheme } = useTheme()

const route = useRoute()
const router = useRouter()
const topGraph = ref<TopGraph | null>(null)
const projects = ref<string[]>([])
const selectedProject = ref('')
const graphLoading = ref(false)

function getRouteProject(): string {
  const p = route.params.project
  if (!p) return ''
  return Array.isArray(p) ? (p[0] ?? '') : p
}

onMounted(async () => {
  const existingProjects = await fetchProjects().catch(() => [] as string[])
  projects.value = existingProjects.sort()

  const routeProject = getRouteProject()
  selectedProject.value = routeProject || projects.value[0] || ''

  if (!routeProject && selectedProject.value) {
    await router.replace({ name: 'project', params: { project: selectedProject.value } })
  }

  if (selectedProject.value) {
    await loadGraph(selectedProject.value)
  }
})

watch(() => route.params.project, async () => {
  const routeProject = getRouteProject()
  if (routeProject === selectedProject.value) return
  selectedProject.value = routeProject
  topGraph.value = null
  if (routeProject) {
    await loadGraph(routeProject)
  }
})

async function loadGraph(project = selectedProject.value) {
  if (!project) {
    topGraph.value = null
    return
  }
  graphLoading.value = true
  try {
    topGraph.value = await fetchTopGraph(project)
  } catch {
    topGraph.value = null
  } finally {
    graphLoading.value = false
  }
}

async function handleProjectChange() {
  topGraph.value = null
  if (!selectedProject.value) {
    await router.replace({ name: 'home' })
    return
  }
  await router.replace({ name: 'project', params: { project: selectedProject.value } })
  await loadGraph(selectedProject.value)
}

function graphNodes() {
  if (!topGraph.value) return []
  return topGraph.value.nodes.map((n) => ({
    name: n.name,
    description: n.description,
    edges: n.edges,
    codeScope: n.codeScope,
    child: { type: 'graph' as const, ref: n.name },
  }))
}

function onNodeClick(node: Pick<GraphNode, 'child'>) {
  if (!node.child || !selectedProject.value) return
  router.push(`/${selectedProject.value}/doc/${node.child.ref}`)
}
</script>

<template>
  <div class="page-layout">
    <aside class="sidebar">
      <div class="sidebar-header">
        <h2>autoDoc</h2>
        <button class="theme-btn" @click="toggleTheme" :title="isDark ? 'Light mode' : 'Dark mode'">
          <svg v-if="isDark" width="16" height="16" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="2"/>
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      <div class="sidebar-input">
        <label class="input-label">Project</label>
        <select
          v-model="selectedProject"
          class="project-select"
          :disabled="projects.length === 0"
          @change="handleProjectChange"
        >
          <option value="" disabled>
            {{ projects.length === 0 ? 'No projects' : 'Select a project' }}
          </option>
          <option v-for="project in projects" :key="project" :value="project">
            {{ project }}
          </option>
        </select>
      </div>

      <div class="sidebar-nav" v-if="topGraph && selectedProject">
        <DocTree :project="selectedProject" :nodes="topGraph.nodes" />
      </div>
      <div class="sidebar-footer">
        <EdgeLegend />
      </div>
    </aside>
    <main class="canvas">
      <template v-if="topGraph">
        <div class="canvas-header">
          <h1>{{ topGraph.description }}</h1>
          <span class="project-chip">{{ selectedProject }}</span>
          <a class="flows-link" @click="router.push(`/${selectedProject}/flows`)">Interaction Flows &rarr;</a>
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
      <template v-else-if="selectedProject">
        <div class="canvas-empty">
          <p>No documentation loaded for {{ selectedProject }}.</p>
        </div>
      </template>
      <template v-else>
        <div class="canvas-empty">
          <p>Select a project to view documentation.</p>
        </div>
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
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 24px 0;
  box-sizing: border-box;
}

.sidebar-header {
  padding: 0 20px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sidebar-header h2 {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0;
}

.theme-btn {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  flex-shrink: 0;
}

.theme-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.sidebar-input {
  padding: 16px 16px 12px;
  border-bottom: 1px solid var(--border);
}

.input-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
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
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font-size: 13px;
  outline: none;
  min-width: 0;
  background: var(--bg-surface);
  color: var(--text-primary);
}

.path-input:focus {
  border-color: var(--accent);
}

.path-input:disabled {
  background: var(--bg-surface-alt);
  color: var(--text-muted);
}

.config-btn {
  padding: 7px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.config-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.config-btn:disabled {
  background: var(--bg-surface-alt);
  color: var(--text-disabled);
  cursor: not-allowed;
}

.run-btn {
  padding: 7px 14px;
  border: none;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.run-btn:hover:not(:disabled) {
  background: var(--accent-hover);
}

.run-btn:disabled {
  background: var(--border-strong);
  color: var(--text-disabled);
  cursor: not-allowed;
}

.input-error {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--color-red);
}

.project-select {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font-size: 13px;
  outline: none;
  background: var(--bg-surface);
  color: var(--text-primary);
}

.project-select:focus {
  border-color: var(--accent);
}

.project-select:disabled {
  background: var(--bg-surface-alt);
  color: var(--text-muted);
}

/* ─── Progress ─── */

.sidebar-progress {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.progress-label {
  font-size: 12px;
  color: var(--accent);
  font-weight: 600;
  margin-bottom: 8px;
}

.progress-bar-track {
  height: 6px;
  background: var(--border-light);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 10px;
}

.progress-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--color-green));
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

.stat-num.done { color: var(--color-green); }
.stat-num.active { color: var(--accent); }
.stat-num.pending { color: var(--color-orange); }
.stat-num.error { color: var(--color-red); }

.stat-label {
  font-size: 11px;
  color: var(--text-muted);
}

/* ─── Search ─── */

.sidebar-search {
  padding: 10px 16px 0;
}

.search-input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
  background: var(--bg-surface);
  color: var(--text-primary);
}

.search-input:focus {
  border-color: var(--accent);
}

.search-results {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  max-height: 200px;
  overflow-y: auto;
}

.search-result-item {
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.search-result-item:hover {
  background: var(--bg-surface-hover);
}

.search-result-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-heading);
}

.search-result-desc {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-empty {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}

/* ─── Canvas ─── */

.sidebar-nav {
  flex: 1;
  padding: 12px 0;
  overflow-y: auto;
}

.sidebar-footer {
  padding: 16px 12px 0;
  border-top: 1px solid var(--border);
}

.canvas {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-body);
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
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.5;
}

.project-chip {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-secondary);
  background: var(--bg-surface-alt);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 10px;
  flex-shrink: 0;
}

.flows-link {
  font-size: 13px;
  color: var(--accent);
  cursor: pointer;
  margin-left: auto;
  flex-shrink: 0;
  white-space: nowrap;
}

.flows-link:hover {
  text-decoration: underline;
}

.live-badge {
  font-size: 10px;
  font-weight: 700;
  color: var(--color-green);
  background: var(--badge-done-bg);
  border: 1px solid var(--badge-done-border);
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
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.canvas-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
  font-size: 15px;
}

.canvas-empty.error {
  color: var(--color-red);
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
  color: var(--text-secondary);
  font-size: 15px;
}

.canvas-loading .sub {
  font-size: 13px;
  color: var(--text-muted);
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--border-light);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ─── Config Dialog ─── */

.dialog-overlay {
  position: fixed;
  inset: 0;
  background: var(--bg-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  width: 420px;
  max-width: 90vw;
  max-height: 80vh;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
  display: flex;
  flex-direction: column;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px 0;
}

.dialog-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--text-heading);
}

.dialog-close {
  border: none;
  background: none;
  font-size: 22px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.dialog-close:hover {
  color: var(--text-primary);
}

.dialog-body {
  padding: 20px 24px;
  overflow-y: auto;
}

.dialog-body .project-select {
  width: 100%;
}

.dialog-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-top: 18px;
  margin-bottom: 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-light);
}

.agent-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 12px;
  align-items: center;
}

.agent-label {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
}

.dialog-footer {
  padding: 0 24px 20px;
  display: flex;
  justify-content: flex-end;
}
</style>
