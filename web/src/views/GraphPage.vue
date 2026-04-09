<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchTopGraph, fetchSubGraph, fetchPage } from '../services/doc'
import GraphView from '../components/GraphView.vue'
import MarkdownView from '../components/MarkdownView.vue'
import EdgeLegend from '../components/EdgeLegend.vue'
import DocTree from '../components/DocTree.vue'
import type { TopGraph, SubGraph, GraphNode } from '../types'

const route = useRoute()
const router = useRouter()
const topGraph = ref<TopGraph | null>(null)
const subGraph = ref<SubGraph | null>(null)
const pageContent = ref('')
const loading = ref(true)
const error = ref('')

function getPath(): string {
  const p = route.params.path
  return Array.isArray(p) ? p.join('/') : p
}

function getProject(): string {
  const p = route.params.project
  if (!p) return ''
  return Array.isArray(p) ? (p[0] ?? '') : p
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
  load()
})

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
          </div>
        </div>
        <div class="canvas-graph">
          <GraphView :nodes="subGraph.nodes" @node-click="onNodeClick" />
        </div>
      </template>
      <template v-else-if="pageContent">
        <div class="canvas-header">
          <nav class="breadcrumb">
            <a class="crumb" @click="router.push({ name: 'project', params: { project: getProject() } })">Home</a>
            <template v-for="bc in breadcrumbs()" :key="bc.path">
              <span class="sep">/</span>
              <a class="crumb" @click="router.push(`/${getProject()}/doc/${bc.path}`)">{{ bc.label }}</a>
            </template>
          </nav>
        </div>
        <div class="canvas-page">
          <MarkdownView :content="pageContent" />
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
  min-width: 200px;
  max-width: 280px;
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
}

.back-btn {
  padding: 6px 16px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
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
  padding: 20px 32px 12px;
}

.breadcrumb {
  font-size: 14px;
  margin-bottom: 8px;
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
}

.status-badge {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 10px;
  font-weight: 500;
  flex-shrink: 0;
}

.status-badge.done { background: var(--badge-done-bg); color: var(--color-green); }
.status-badge.pending { background: var(--badge-pending-bg); color: var(--color-orange); }
.status-badge.error { background: var(--badge-error-bg); color: var(--color-red); }
.status-badge.decomposing,
.status-badge.writing,
.status-badge.checking { background: var(--badge-active-bg); color: var(--accent); }

.canvas-graph {
  flex: 1;
  margin: 0 16px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.canvas-page {
  flex: 1;
  overflow-y: auto;
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
