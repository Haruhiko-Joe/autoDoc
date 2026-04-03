<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchPage } from '../services/doc'
import MarkdownView from '../components/MarkdownView.vue'

const route = useRoute()
const router = useRouter()
const content = ref('')
const loading = ref(true)
const error = ref('')

function getPath(): string {
  const p = route.params.path
  return Array.isArray(p) ? p.join('/') : p
}

function getProject(): string {
  const project = route.query.project
  return Array.isArray(project) ? (project[0] ?? '') : (project ?? '')
}

async function load() {
  loading.value = true
  error.value = ''
  const project = getProject()
  if (!project) {
    content.value = ''
    error.value = 'Missing project.'
    loading.value = false
    return
  }
  try {
    content.value = await fetchPage(project, getPath())
  } catch {
    error.value = 'Failed to load page.'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => [route.params.path, route.query.project], load)

function goBack() {
  const path = getPath()
  const parts = path.split('/')
  if (parts.length <= 1) {
    router.push({ name: 'home', query: { project: getProject() } })
  } else {
    parts.pop()
    router.push({ name: 'graph', params: { path: parts.join('/') }, query: { project: getProject() } })
  }
}

const breadcrumbs = () => {
  const parts = getPath().split('/')
  return parts.map((p, i) => ({
    label: p,
    path: parts.slice(0, i + 1).join('/'),
    isLast: i === parts.length - 1,
  }))
}
</script>

<template>
  <div class="doc-page">
    <div v-if="loading" class="loading">Loading...</div>
    <div v-else-if="error" class="error">{{ error }}</div>
    <template v-else>
      <header class="page-header">
        <nav class="breadcrumb">
          <a class="crumb" @click="router.push({ name: 'home', query: { project: getProject() } })">Home</a>
          <template v-for="bc in breadcrumbs()" :key="bc.path">
            <span class="sep">/</span>
            <a
              v-if="!bc.isLast"
              class="crumb"
              @click="router.push({ name: 'graph', params: { path: bc.path }, query: { project: getProject() } })"
            >
              {{ bc.label }}
            </a>
            <span v-else class="crumb current">{{ bc.label }}</span>
          </template>
        </nav>
        <button class="back-btn" @click="goBack">Back</button>
      </header>
      <MarkdownView :content="content" />
    </template>
  </div>
</template>

<style scoped>
.doc-page {
  min-height: 100vh;
  padding: 24px;
  box-sizing: border-box;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #eee;
}

.breadcrumb {
  font-size: 14px;
}

.crumb {
  color: #1890ff;
  cursor: pointer;
}

.crumb:hover {
  text-decoration: underline;
}

.crumb.current {
  color: #333;
  cursor: default;
}

.crumb.current:hover {
  text-decoration: none;
}

.sep {
  margin: 0 6px;
  color: #ccc;
}

.back-btn {
  padding: 6px 16px;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  font-size: 13px;
  color: #333;
}

.back-btn:hover {
  border-color: #1890ff;
  color: #1890ff;
}

.loading,
.error {
  text-align: center;
  padding: 80px;
  font-size: 16px;
  color: #999;
}

.error {
  color: #ff4d4f;
}
</style>
