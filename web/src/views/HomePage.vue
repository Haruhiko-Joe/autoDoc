<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchTopGraph, startRun, fetchStatus, fetchProjects, subscribeStatus, searchModules, pausePipeline, resumePipeline, retryErrors, knowledgeGet, type AgentBackends, type RunStatus, type SearchResult, type ProjectListEntry } from '../services/doc'
import GraphView from '../components/GraphView.vue'
import EdgeLegend from '../components/EdgeLegend.vue'
import DocTree from '../components/DocTree.vue'
import { useTheme } from '../composables/useTheme'
import type { TopGraph, GraphNode } from '../types'

const { isDark, toggle: toggleTheme } = useTheme()

const route = useRoute()
const router = useRouter()
const topGraph = ref<TopGraph | null>(null)
const gitUrl = ref('')
const maxConcurrency = ref(8)
const agentBackends = reactive<AgentBackends>({
  scaffold: 'claude',
  decomposer: 'claude',
  writer: 'claude',
  checker: 'codex',
  flowAnalyzer: 'claude',
  updater: 'claude',
})
const language = ref<'zh' | 'en'>('zh')
const showConfigDialog = ref(false)
const projectEntries = ref<ProjectListEntry[]>([])
const projects = computed(() => projectEntries.value.map((p) => p.name))
const selectedProject = ref('')
const status = ref<RunStatus>({ phase: 'idle' })
const errorMsg = ref('')
const graphLoading = ref(false)
let unsubscribeSSE: (() => void) | null = null

const agentBackendFields: Array<{ key: keyof AgentBackends; label: string }> = [
  { key: 'scaffold', label: 'Scaffold' },
  { key: 'decomposer', label: 'Decomposer' },
  { key: 'writer', label: 'Writer' },
  { key: 'checker', label: 'Checker' },
  { key: 'flowAnalyzer', label: 'Flow Analyzer' },
  { key: 'updater', label: 'Updater' },
]

function getRouteProject(): string {
  const p = route.params.project
  if (!p) return ''
  return Array.isArray(p) ? (p[0] ?? '') : p
}

function getProjectName(gitUrlValue: string): string {
  const trimmed = gitUrlValue.trim().replace(/\.git$/i, '')
  if (!trimmed) return ''
  // Handles git@host:owner/repo, https://host/owner/repo, ssh://...
  const lastSlash = trimmed.lastIndexOf('/')
  const lastColon = trimmed.lastIndexOf(':')
  const cut = Math.max(lastSlash, lastColon)
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed
}

function mergeProjectEntries(next: ProjectListEntry[]) {
  const map = new Map<string, ProjectListEntry>()
  for (const entry of next) map.set(entry.name, entry)
  // Preserve currently-running project even if it isn't in the new list yet.
  const current = status.value.currentProject
  if (current && !map.has(current)) {
    map.set(current, {
      name: current,
      hasDoc: false,
      sourceUrl: status.value.gitUrl ?? '',
      branch: '',
      head: '',
      lastUpdated: '',
    })
  }
  projectEntries.value = [...map.values()]
    .filter((e) => e.name)
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function refreshProjects() {
  try {
    mergeProjectEntries(await fetchProjects())
  } catch {
    mergeProjectEntries([])
  }
}

function gitUrlForProject(name: string): string {
  return projectEntries.value.find((p) => p.name === name)?.sourceUrl ?? ''
}

function syncGitUrlFromSelection() {
  if (status.value.phase === 'running') return
  const url = gitUrlForProject(selectedProject.value)
  if (url) gitUrl.value = url
}

onMounted(async () => {
  const [s, existingProjects] = await Promise.all([
    fetchStatus(),
    fetchProjects().catch(() => []),
  ])
  status.value = s
  mergeProjectEntries(existingProjects)
  if (s.gitUrl) gitUrl.value = s.gitUrl
  if (s.config) {
    maxConcurrency.value = s.config.maxConcurrency
    Object.assign(agentBackends, s.config.agentBackends)
    language.value = s.config.language
  }

  const routeProject = getRouteProject()
  selectedProject.value = routeProject || s.currentProject || projects.value[0] || ''

  if (!routeProject && selectedProject.value) {
    await router.replace({ name: 'project', params: { project: selectedProject.value } })
  }

  if (selectedProject.value) {
    syncGitUrlFromSelection()
    await loadGraph(selectedProject.value)
    await refreshKnowledge(selectedProject.value)
  }

  if (s.phase === 'running') {
    startSSE()
  }
})

onUnmounted(() => stopSSE())

watch(() => route.params.project, async () => {
  const routeProject = getRouteProject()
  if (routeProject === selectedProject.value) return
  selectedProject.value = routeProject
  errorMsg.value = ''
  topGraph.value = null
  if (routeProject) {
    syncGitUrlFromSelection()
    await loadGraph(routeProject)
    await refreshKnowledge(routeProject)
  } else {
    await refreshKnowledge('')
  }
})

async function handleRun() {
  if (!gitUrl.value.trim()) return
  errorMsg.value = ''
  topGraph.value = null
  try {
    const project = getProjectName(gitUrl.value)
    const { mode } = await startRun(gitUrl.value.trim(), maxConcurrency.value, { ...agentBackends }, language.value)
    if (mode === 'noop') {
      // no-op: nothing to do, just refresh status
      status.value = { phase: 'done', mode: 'noop', gitUrl: gitUrl.value.trim(), currentProject: project }
      await refreshProjects()
      if (project) {
        selectedProject.value = project
        await router.replace({ name: 'project', params: { project } })
        await loadGraph(project)
      }
      return
    }
    status.value = { phase: 'running', mode, gitUrl: gitUrl.value.trim(), currentProject: project }
    selectedProject.value = project
    mergeProjectEntries([
      ...projectEntries.value,
      {
        name: project,
        hasDoc: false,
        sourceUrl: gitUrl.value.trim(),
        branch: '',
        head: '',
        lastUpdated: '',
      },
    ])
    await router.replace({ name: 'project', params: { project } })
    startSSE()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  }
}

function startSSE() {
  stopSSE()
  unsubscribeSSE = subscribeStatus(async (s) => {
    status.value = s
    if (s.phase === 'running') {
      if (selectedProject.value === s.currentProject) {
        await tryLoadGraph(selectedProject.value)
      }
    } else if (s.phase === 'done') {
      stopSSE()
      await refreshProjects()
      if (selectedProject.value) await loadGraph(selectedProject.value)
    } else if (s.phase === 'error') {
      stopSSE()
      errorMsg.value = s.message ?? 'Unknown error'
    }
  })
}

function stopSSE() {
  if (unsubscribeSSE) {
    unsubscribeSSE()
    unsubscribeSSE = null
  }
}

async function tryLoadGraph(project = selectedProject.value) {
  if (!project || topGraph.value) return
  try {
    topGraph.value = await fetchTopGraph(project)

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
  syncGitUrlFromSelection()
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

const knowledgeExists = ref(false)
const knowledgeChars = ref(0)

async function refreshKnowledge(projectName: string) {
  if (!projectName) {
    knowledgeExists.value = false
    knowledgeChars.value = 0
    return
  }
  try {
    const res = await knowledgeGet(projectName)
    knowledgeExists.value = res.exists
    knowledgeChars.value = res.content?.length ?? 0
  } catch {
    knowledgeExists.value = false
    knowledgeChars.value = 0
  }
}

function openKnowledgePage() {
  if (!selectedProject.value) return
  router.push({ name: 'knowledge', query: { project: selectedProject.value } })
}

const searchQuery = ref('')
const searchResults = ref<SearchResult[]>([])
let searchTimer: ReturnType<typeof setTimeout> | null = null

watch(searchQuery, (q) => {
  if (searchTimer) clearTimeout(searchTimer)
  const trimmed = q.trim()
  if (!trimmed || !selectedProject.value) {
    searchResults.value = []
    return
  }
  searchTimer = setTimeout(async () => {
    searchResults.value = await searchModules(selectedProject.value, trimmed)
  }, 250)
})

function jumpToFirstMatch() {
  if (searchResults.value.length > 0) {
    navigateToSearchResult(searchResults.value[0])
  }
}

function navigateToSearchResult(r: SearchResult) {
  if (!selectedProject.value) return
  router.push(`/${selectedProject.value}/doc/${r.path}`)
  searchQuery.value = ''
  searchResults.value = []
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

const isPaused = computed(() => status.value.paused === true)

const runModeLabel = computed(() => {
  const m = status.value.mode
  if (m === 'initial') return 'Initial generation'
  if (m === 'incremental') return 'Incremental update'
  if (m === 'noop') return 'No changes'
  return ''
})

const progressPhaseLabel = computed(() => {
  if (isPaused.value) return 'Paused'
  if (status.value.mode === 'incremental') {
    if (status.value.step === 'fetching') return 'Fetching latest commits...'
    if (status.value.step === 'updating') return 'Updater agent applying diff...'
    return 'Incremental update in progress...'
  }
  const p = progress.value?.phase
  if (p === 'scaffold') return 'Analyzing project structure...'
  if (p === 'processing') return 'Processing modules...'
  if (p === 'assembling') return 'Assembling doc-drill skill...'
  if (p === 'flows') return 'Generating interaction flows...'
  return 'Preparing...'
})

async function handlePauseToggle() {
  try {
    if (isPaused.value) {
      await resumePipeline()
    } else {
      await pausePipeline()
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  }
}

const hasErrors = computed(() => {
  const c = progress.value?.counts
  return c && (c.error ?? 0) > 0
})

const canRetry = computed(() =>
  (status.value.phase === 'done' || status.value.phase === 'error') && selectedProject.value === status.value.currentProject
)

async function handleRetryErrors() {
  try {
    await retryErrors()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  }
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
        <label class="input-label">Git SSH URL</label>
        <div class="input-row">
          <input
            v-model="gitUrl"
            class="path-input"
            placeholder="git@github.com:owner/repo.git"
            :disabled="status.phase === 'running'"
            @keydown.enter="handleRun"
          />
          <button
            class="config-btn"
            title="Run Config"
            :disabled="status.phase === 'running'"
            @click="showConfigDialog = true"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6.5 1.5L7.1 3.3C7.4 3.4 7.7 3.6 8 3.8L9.8 3.2L11.3 5.8L9.9 7.1C9.9 7.4 9.9 7.6 9.9 7.9L11.3 9.2L9.8 11.8L8 11.2C7.7 11.4 7.4 11.6 7.1 11.7L6.5 13.5H3.5L2.9 11.7C2.6 11.6 2.3 11.4 2 11.2L0.2 11.8L-1.3 9.2L0.1 7.9C0.1 7.6 0.1 7.4 0.1 7.1L-1.3 5.8L0.2 3.2L2 3.8C2.3 3.6 2.6 3.4 2.9 3.3L3.5 1.5H6.5Z" transform="translate(3 0.5)" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>
          </button>
          <button
            class="run-btn"
            :disabled="status.phase === 'running' || !gitUrl.trim()"
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
        <button
          v-if="selectedProject"
          class="knowledge-btn"
          :disabled="status.phase === 'running'"
          @click="openKnowledgePage"
        >
          <span>{{ knowledgeExists ? 'Edit existing knowledge' : 'Inject additional knowledge' }}</span>
          <span v-if="knowledgeExists" class="knowledge-chip">{{ knowledgeChars }} chars</span>
        </button>
        <p v-if="errorMsg" class="input-error">{{ errorMsg }}</p>
      </div>

      <!-- Config Dialog -->
      <Teleport to="body">
        <div v-if="showConfigDialog" class="dialog-overlay" @click.self="showConfigDialog = false">
          <div class="dialog">
            <div class="dialog-header">
              <h3>Run Configuration</h3>
              <button class="dialog-close" @click="showConfigDialog = false">&times;</button>
            </div>
            <div class="dialog-body">
              <label class="input-label">Max Concurrency</label>
              <select v-model.number="maxConcurrency" class="project-select">
                <option v-for="n in [1, 2, 4, 8, 16, 32]" :key="n" :value="n">{{ n }}</option>
              </select>
              <label class="input-label select-label">Language</label>
              <select v-model="language" class="project-select">
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select>
              <div class="dialog-section-title">Agent Backends</div>
              <div class="agent-grid">
                <template v-for="field in agentBackendFields" :key="field.key">
                  <label class="agent-label">{{ field.label }}</label>
                  <select v-model="agentBackends[field.key]" class="project-select">
                    <option value="codex">Codex (GPT)</option>
                    <option value="claude">Claude</option>
                  </select>
                </template>
              </div>
            </div>
            <div class="dialog-footer">
              <button class="run-btn" @click="showConfigDialog = false">OK</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- 生成过程中的实时进度 -->
      <div v-if="viewingRunningProject && progress" class="sidebar-progress">
        <div class="progress-header">
          <div class="progress-label">{{ progressPhaseLabel }}</div>
          <button class="pause-btn" @click="handlePauseToggle" :title="isPaused ? 'Resume' : 'Pause'">
            <svg v-if="!isPaused" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1"/>
              <rect x="14" y="4" width="4" height="16" rx="1"/>
            </svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="6,4 20,12 6,20"/>
            </svg>
          </button>
        </div>
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

      <div v-if="canRetry && hasErrors" class="sidebar-retry">
        <button class="retry-btn" @click="handleRetryErrors">
          Retry {{ progress?.counts?.error ?? 0 }} failed node(s)
        </button>
      </div>

      <div class="sidebar-search" v-if="topGraph && selectedProject">
        <input
          v-model="searchQuery"
          class="search-input"
          placeholder="Search modules..."
          @keydown.enter="jumpToFirstMatch"
        />
        <ul v-if="searchQuery.trim() && searchResults.length > 0" class="search-results">
          <li
            v-for="m in searchResults"
            :key="m.path"
            class="search-result-item"
            @click="navigateToSearchResult(m)"
          >
            <span class="search-result-name">{{ m.name }}</span>
            <span class="search-result-desc">{{ m.path }} — {{ m.description }}</span>
          </li>
        </ul>
        <div v-if="searchQuery.trim() && searchResults.length === 0" class="search-empty">
          No matches
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
      <!-- running 且 top.json 还没好：显示进度 -->
      <template v-else-if="viewingRunningProject">
        <div class="canvas-loading">
          <div class="spinner"></div>
          <p>{{ progressPhaseLabel }}</p>
          <p class="sub">Analyzing {{ status.gitUrl }}</p>
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

.knowledge-btn {
  margin-top: 10px;
  width: 100%;
  padding: 8px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.knowledge-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.knowledge-btn:disabled {
  color: var(--text-disabled);
  cursor: not-allowed;
}

.knowledge-chip {
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-surface-alt);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 8px;
}

/* ─── Progress ─── */

.sidebar-progress {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.progress-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.progress-label {
  font-size: 12px;
  color: var(--accent);
  font-weight: 600;
}

.pause-btn {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  flex-shrink: 0;
}

.pause-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.sidebar-retry {
  padding: 0 16px 12px;
}

.retry-btn {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--error, #e53e3e);
  border-radius: 6px;
  background: transparent;
  color: var(--error, #e53e3e);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.retry-btn:hover {
  background: var(--error, #e53e3e);
  color: #fff;
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
