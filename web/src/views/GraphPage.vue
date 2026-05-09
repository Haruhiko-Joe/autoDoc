<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchTopGraph, fetchSubGraph, fetchPage, createNode, updateNode, deleteNode, updatePage, fetchDocBlame, type DocBlameLine } from '../services/doc'
import GraphView from '../components/GraphView.vue'
import GraphToolbar from '../components/GraphToolbar.vue'
import NodeFormDialog from '../components/NodeFormDialog.vue'
import EdgeFormDialog from '../components/EdgeFormDialog.vue'
import MarkdownView from '../components/MarkdownView.vue'
import MarkdownEditor from '../components/MarkdownEditor.vue'
import DocGitPanel from '../components/DocGitPanel.vue'
import EdgeLegend from '../components/EdgeLegend.vue'
import DocTree from '../components/DocTree.vue'
import {
  createGraphNode,
  removeEdge,
  upsertEdge,
  type EdgeFormData,
  type NodeFormData,
} from '../utils/graphNodes'
import { firstRouteParam, routePathParam } from '../utils/routeParams'
import type { TopGraph, SubGraph, GraphNode, EdgeType } from '../types'

const route = useRoute()
const router = useRouter()
const topGraph = ref<TopGraph | null>(null)
const subGraph = ref<SubGraph | null>(null)
const pageContent = ref('')
const loading = ref(true)
const error = ref('')

// Edit mode
const editMode = ref(false)
const selectedNodeId = ref<string | null>(null)
const nodeDialogVisible = ref(false)
const nodeDialogTarget = ref<GraphNode | undefined>()
const edgeDialogVisible = ref(false)
const edgeDialogSource = ref('')
const edgeDialogTarget = ref<{ target: string; type: EdgeType; description: string } | undefined>()
const edgeDialogPrefillTarget = ref('')

const showGitPanel = ref(false)
const gitInfoEnabled = ref(false)
const blameLines = ref<DocBlameLine[]>([])
const gitRefreshToken = ref(0)

function getPath(): string {
  return routePathParam(route.params.path)
}

function getProject(): string {
  return firstRouteParam(route.params.project)
}

async function load() {
  loading.value = true
  error.value = ''
  const project = getProject()
  if (!project) {
    topGraph.value = null
    subGraph.value = null
    error.value = 'Missing project.'
    loading.value = false
    return
  }
  subGraph.value = null
  pageContent.value = ''
  try {
    const [top, sub] = await Promise.all([
      topGraph.value ? topGraph.value : fetchTopGraph(project),
      fetchSubGraph(project, getPath()),
    ])
    topGraph.value = top
    subGraph.value = sub

  } catch {
    try {
      if (!topGraph.value) topGraph.value = await fetchTopGraph(project)
      pageContent.value = await fetchPage(project, getPath())
      await loadBlame()
    } catch {
      error.value = 'Failed to load document.'
    }
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => [route.params.path, route.params.project], () => {
  topGraph.value = null
  editMode.value = false
  load()
})

async function loadBlame() {
  if (!gitInfoEnabled.value || !pageContent.value) {
    blameLines.value = []
    return
  }
  try {
    blameLines.value = (await fetchDocBlame(getProject(), getPath())).lines
  } catch {
    blameLines.value = []
  }
}

watch(gitInfoEnabled, loadBlame)

function onNodeClick(node: { child?: GraphNode['child'] }) {
  if (!node.child) return
  router.push(`/${getProject()}/doc/${getPath()}/${node.child.ref}`)
}

function goBack() {
  const path = getPath()
  const parts = path.split('/')
  const project = getProject()
  if (parts.length <= 1) {
    router.push({ name: 'project', params: { project } })
  } else {
    parts.pop()
    router.push(`/${project}/doc/${parts.join('/')}`)
  }
}

const breadcrumbs = () => {
  const parts = getPath().split('/')
  return parts.map((p, i) => ({
    label: p,
    path: parts.slice(0, i + 1).join('/'),
  }))
}

// ─── Graph editing ───

function openAddNode() {
  nodeDialogTarget.value = undefined
  nodeDialogVisible.value = true
}

function openEditNode(node: GraphNode) {
  nodeDialogTarget.value = node
  nodeDialogVisible.value = true
}

async function handleNodeSubmit(data: NodeFormData) {
  if (!subGraph.value) return
  const project = getProject()
  const nodeId = getPath()
  try {
    if (nodeDialogTarget.value) {
      // Edit existing node
      subGraph.value = await updateNode(project, nodeId, nodeDialogTarget.value.name, {
        name: data.name,
        description: data.description,
        codeScope: data.codeScope,
      })
    } else {
      const node = createGraphNode(data, false)
      if (!node) return
      subGraph.value = await createNode(project, nodeId, node)
    }
    gitRefreshToken.value++
    nodeDialogVisible.value = false
  } catch (e) {
    alert(e instanceof Error ? e.message : 'Operation failed')
  }
}

async function handleDeleteNode(node: GraphNode) {
  if (!subGraph.value || !confirm(`Delete "${node.name}"?`)) return
  try {
    subGraph.value = await deleteNode(getProject(), getPath(), node.name)
    selectedNodeId.value = null
    gitRefreshToken.value++
  } catch (e) {
    alert(e instanceof Error ? e.message : 'Delete failed')
  }
}

function handleDeleteSelected() {
  if (!selectedNodeId.value || !subGraph.value) return
  const node = subGraph.value.nodes.find(n => n.name === selectedNodeId.value)
  if (node) handleDeleteNode(node)
}

// ─── Edge editing ───

function handleEdgeCreate(source: string, target: string) {
  edgeDialogSource.value = source
  edgeDialogTarget.value = undefined
  edgeDialogPrefillTarget.value = target
  edgeDialogVisible.value = true
}

function openEditEdge(source: string, edge: { target: string; type: EdgeType; description: string }) {
  edgeDialogSource.value = source
  edgeDialogTarget.value = edge
  edgeDialogVisible.value = true
}

async function handleEdgeSubmit(data: EdgeFormData) {
  if (!subGraph.value) return
  const project = getProject()
  const nodeId = getPath()
  const sourceNodeName = edgeDialogSource.value
  const sourceNode = subGraph.value.nodes.find(n => n.name === sourceNodeName)
  if (!sourceNode) return

  try {
    subGraph.value = await updateNode(project, nodeId, sourceNodeName, {
      edges: upsertEdge(sourceNode.edges, edgeDialogTarget.value, data),
    })
    gitRefreshToken.value++
    edgeDialogVisible.value = false
  } catch (e) {
    alert(e instanceof Error ? e.message : 'Edge operation failed')
  }
}

async function handleEdgeDelete(source: string, edgeTarget: string, edgeType: EdgeType) {
  if (!subGraph.value || !confirm(`Delete edge ${source} -> ${edgeTarget}?`)) return
  const sourceNode = subGraph.value.nodes.find(n => n.name === source)
  if (!sourceNode) return
  try {
    subGraph.value = await updateNode(getProject(), getPath(), source, {
      edges: removeEdge(sourceNode.edges, edgeTarget, edgeType),
    })
    gitRefreshToken.value++
  } catch (e) {
    alert(e instanceof Error ? e.message : 'Delete edge failed')
  }
}

// ─── Page editing ───

type PageViewMode = 'preview' | 'edit' | 'split'
const pageViewMode = ref<PageViewMode>('preview')
const pageEditContent = ref('')
const pageSaving = ref(false)

// ─── Split-mode scroll sync ───

const splitEditorRef = ref<HTMLDivElement>()
const splitPreviewRef = ref<HTMLDivElement>()
let splitSyncCleanup: (() => void) | null = null

function setupSplitScrollSync(editorScroller: HTMLElement, preview: HTMLElement): () => void {
  let syncing = false
  const sync = (src: HTMLElement, dst: HTMLElement) => {
    if (syncing) return
    const srcMax = src.scrollHeight - src.clientHeight
    const dstMax = dst.scrollHeight - dst.clientHeight
    if (srcMax <= 0 || dstMax <= 0) return
    syncing = true
    dst.scrollTop = (src.scrollTop / srcMax) * dstMax
    requestAnimationFrame(() => {
      if (!syncing) return

      syncing = false
    })
  }
  const onEditorScroll = () => sync(editorScroller, preview)
  const onPreviewScroll = () => sync(preview, editorScroller)
  editorScroller.addEventListener('scroll', onEditorScroll, { passive: true })
  preview.addEventListener('scroll', onPreviewScroll, { passive: true })
  return () => {
    editorScroller.removeEventListener('scroll', onEditorScroll)
    preview.removeEventListener('scroll', onPreviewScroll)
  }
}

async function attachSplitScrollSync() {
  splitSyncCleanup?.()
  splitSyncCleanup = null
  await nextTick()
  // CodeMirror mounts its scroller asynchronously; retry a few frames.
  for (let i = 0; i < 10; i++) {
    const scroller = splitEditorRef.value?.querySelector<HTMLElement>('.cm-scroller')
    const preview = splitPreviewRef.value
    if (scroller && preview) {
      splitSyncCleanup = setupSplitScrollSync(scroller, preview)
      return
    }
    await new Promise((r) => requestAnimationFrame(r))
  }
}

watch(pageViewMode, (mode) => {
  const isSplitMode = mode === 'split'
  if (isSplitMode) {
    attachSplitScrollSync()
  } else {
    splitSyncCleanup?.()
    splitSyncCleanup = null
  }
})

onUnmounted(() => {
  splitSyncCleanup?.()
  splitSyncCleanup = null
})

function getPageParentNodeId(): string {
  const parts = getPath().split('/')
  return parts.slice(0, -1).join('/')
}

function getPageRef(): string {
  const parts = getPath().split('/')
  return parts[parts.length - 1] ?? ''
}

watch(pageContent, (val) => {
  if (pageViewMode.value !== 'preview') return

  pageEditContent.value = val
})

function enterPageEdit() {
  pageEditContent.value = pageContent.value
  pageViewMode.value = 'edit'
}

async function savePage() {
  pageSaving.value = true
  try {
    await updatePage(getProject(), getPageParentNodeId(), getPageRef(), pageEditContent.value)
    pageContent.value = pageEditContent.value
    gitRefreshToken.value++
    await loadBlame()
  } catch (e) {
    alert(e instanceof Error ? e.message : 'Save failed')
  } finally {
    pageSaving.value = false
  }
}
</script>

<template>
  <div class="page-layout">
    <aside class="sidebar">
      <div class="sidebar-header">
        <button class="back-btn" @click="goBack">&larr; Back</button>
      </div>
      <div class="sidebar-nav" v-if="topGraph">
        <DocTree :project="getProject()" :nodes="topGraph.nodes" />
      </div>
      <div class="sidebar-footer">
        <EdgeLegend />
      </div>
    </aside>
    <main class="canvas">
      <div v-if="loading" class="loading">Loading...</div>
      <div v-else-if="error" class="error">{{ error }}</div>
      <template v-else-if="subGraph">
        <div class="canvas-header">
          <nav class="breadcrumb">
            <a class="crumb" @click="router.push({ name: 'project', params: { project: getProject() } })">Home</a>
            <template v-for="bc in breadcrumbs()" :key="bc.path">
              <span class="sep">/</span>
              <a class="crumb" @click="router.push(`/${getProject()}/doc/${bc.path}`)">
                {{ bc.label }}
              </a>
            </template>
          </nav>
          <div class="header-meta">
            <p class="desc">{{ subGraph.description }}</p>
            <span class="status-badge" :class="subGraph.status">{{ subGraph.status }}</span>
            <button
              class="edit-toggle"
              :class="{ active: editMode }"
              @click="editMode = !editMode; selectedNodeId = null"
            >
              {{ editMode ? 'Done' : 'Edit' }}
            </button>
            <button class="git-toggle" @click="showGitPanel = !showGitPanel">Git</button>
          </div>
        </div>
        <div class="canvas-graph">
          <GraphView
            :nodes="subGraph.nodes"
            :editable="editMode"
            @node-click="onNodeClick"
            @node-edit="openEditNode"
            @node-delete="handleDeleteNode"
            @edge-edit="openEditEdge"
            @edge-delete="handleEdgeDelete"
            @edge-create="handleEdgeCreate"
          />
          <GraphToolbar
            v-if="editMode"
            :has-selection="!!selectedNodeId"
            @add-node="openAddNode"
            @delete-selected="handleDeleteSelected"
          />
        </div>
      </template>
      <template v-else-if="pageContent || pageViewMode !== 'preview'">
        <div class="canvas-header">
          <nav class="breadcrumb">
            <a class="crumb" @click="router.push({ name: 'project', params: { project: getProject() } })">Home</a>
            <template v-for="bc in breadcrumbs()" :key="bc.path">
              <span class="sep">/</span>
              <a class="crumb" @click="router.push(`/${getProject()}/doc/${bc.path}`)">{{ bc.label }}</a>
            </template>
          </nav>
          <div class="header-meta">
            <div class="view-mode-group">
              <button class="mode-btn" :class="{ active: pageViewMode === 'preview' }" @click="pageViewMode = 'preview'">Preview</button>
              <button class="mode-btn" :class="{ active: pageViewMode === 'edit' }" @click="enterPageEdit()">Edit</button>
              <button class="mode-btn" :class="{ active: pageViewMode === 'split' }" @click="enterPageEdit(); pageViewMode = 'split'">Split</button>
            </div>
            <button
              class="git-info-toggle"
              :class="{ active: gitInfoEnabled }"
              @click="gitInfoEnabled = !gitInfoEnabled"
            >Git Info</button>
            <button class="git-toggle" @click="showGitPanel = !showGitPanel">Git</button>
            <button v-if="pageViewMode !== 'preview'" class="btn-save" :disabled="pageSaving" @click="savePage">
              {{ pageSaving ? 'Saving...' : 'Save' }}
            </button>
          </div>
        </div>
        <div class="canvas-page" v-if="pageViewMode === 'preview'">
          <MarkdownView :content="pageContent" :show-git-info="gitInfoEnabled" :blame-lines="blameLines" />
        </div>
        <div class="canvas-page-edit" v-else-if="pageViewMode === 'edit'">
          <MarkdownEditor
            v-model="pageEditContent"
            :show-git-info="gitInfoEnabled"
            :blame-lines="blameLines"
            @save="savePage"
          />
        </div>
        <div class="canvas-page-split" v-else>
          <div class="split-editor" ref="splitEditorRef">
            <MarkdownEditor
              v-model="pageEditContent"
              :show-git-info="gitInfoEnabled"
              :blame-lines="blameLines"
              @save="savePage"
            />
          </div>
          <div class="split-preview" ref="splitPreviewRef">
            <MarkdownView :content="pageEditContent" :show-git-info="gitInfoEnabled" :blame-lines="blameLines" />
          </div>
        </div>
      </template>
    </main>

    <!-- Dialogs -->
    <NodeFormDialog
      :visible="nodeDialogVisible"
      :node="nodeDialogTarget"
      @close="nodeDialogVisible = false"
      @submit="handleNodeSubmit"
    />
    <EdgeFormDialog
      :visible="edgeDialogVisible"
      :edge="edgeDialogTarget"
      :source-node="edgeDialogSource"
      :prefill-target="edgeDialogPrefillTarget"
      :target-options="subGraph?.nodes.map(n => n.name).filter(n => n !== edgeDialogSource) ?? []"
      @close="edgeDialogVisible = false"
      @submit="handleEdgeSubmit"
    />
    <DocGitPanel
      v-if="getProject()"
      :project="getProject()"
      :visible="showGitPanel"
      :refresh-token="gitRefreshToken"
      @close="showGitPanel = false"
      @committed="loadBlame"
    />
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
  min-width: 200px;
  max-width: 280px;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  backdrop-filter: blur(18px);
  display: flex;
  flex-direction: column;
  padding: 22px 0;
  box-sizing: border-box;
}

.sidebar-header {
  padding: 0 20px 16px;
  border-bottom: 1px solid var(--border);
}

.back-btn {
  min-height: 34px;
  padding: 0 14px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--bg-surface);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
  width: 100%;
  text-align: left;
}

.back-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--bg-surface-hover);
}

.sidebar-nav {
  flex: 1;
  padding: 8px 0;
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
  min-height: 72px;
  padding: 18px 32px 14px;
}

.breadcrumb {
  font-size: 13px;
  margin-bottom: 8px;
  color: var(--text-muted);
}

.crumb {
  color: var(--accent);
  cursor: pointer;
}

.crumb:hover {
  text-decoration: underline;
}

.sep {
  margin: 0 6px;
  color: var(--text-disabled);
}

.header-meta {
  display: flex;
  align-items: center;
  gap: 12px;
}

.desc {
  font-size: 15px;
  color: var(--text-secondary);
  margin: 0;
  flex: 1;
  line-height: 1.45;
  letter-spacing: -0.01em;
}

.status-badge {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 999px;
  font-weight: 500;
  flex-shrink: 0;
}

.status-badge.done { background: var(--badge-done-bg); color: var(--color-green); }
.status-badge.pending { background: var(--badge-pending-bg); color: var(--color-orange); }
.status-badge.error { background: var(--badge-error-bg); color: var(--color-red); }
.status-badge.decomposing,
.status-badge.writing,
.status-badge.checking,
.status-badge.awaiting-review { background: var(--badge-active-bg); color: var(--accent); }

.edit-toggle,
.git-toggle,
.git-info-toggle {
  min-height: 30px;
  padding: 0 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s;
}

.edit-toggle:hover,
.git-toggle:hover,
.git-info-toggle:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--bg-surface-hover);
}

.edit-toggle.active,
.git-info-toggle.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

.canvas-graph {
  flex: 1;
  margin: 0 16px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  overflow: hidden;
  position: relative;
  background: var(--bg-surface);
  box-shadow: var(--shadow-soft);
}

.canvas-page {
  flex: 1;
  overflow-y: auto;
  background: var(--bg-surface);
  border-top: 1px solid var(--border-light);
}

.canvas-page-edit {
  flex: 1;
  overflow: hidden;
}

.canvas-page-split {
  flex: 1;
  display: flex;
  gap: 1px;
  background: var(--border);
  overflow: hidden;
}

.split-editor, .split-preview {
  flex: 1;
  overflow-y: auto;
  background: var(--bg-surface);
}

.view-mode-group {
  display: flex;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  overflow: hidden;
  background: var(--bg-surface);
}

.mode-btn {
  min-height: 30px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}

.mode-btn:not(:last-child) {
  border-right: 1px solid var(--border);
}

.mode-btn:hover {
  color: var(--accent);
}

.mode-btn.active {
  background: var(--accent);
  color: #fff;
}

.btn-save {
  min-height: 30px;
  padding: 0 16px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-control);
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  flex-shrink: 0;
}

.btn-save:hover:not(:disabled) {
  background: var(--accent-hover);
  transform: translateY(-1px);
}

.btn-save:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.loading,
.error {
  text-align: center;
  padding: 80px;
  font-size: 16px;
  color: var(--text-muted);
}

.error {
  color: var(--color-red);
}
</style>
