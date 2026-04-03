<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { fetchSubGraph, type NodeProgress } from '../services/doc'
import type { ScaffoldNode } from '../types'
import TreeItem from './TreeItem.vue'

const props = defineProps<{
  project: string
  nodes: ScaffoldNode[]
  nodeStates?: NodeProgress[]  // 实时节点状态（running 期间由 progress 传入）
}>()

export interface TreeNode {
  name: string
  path: string
  type: 'graph' | 'page'
  children?: TreeNode[]
  loading: boolean
  expanded: boolean
  status?: string  // 节点处理状态
}

const router = useRouter()
const tree = ref<TreeNode[]>([])

function buildTree() {
  tree.value = props.nodes.map((n) => ({
    name: n.name,
    path: n.name,
    type: 'graph' as const,
    expanded: false,
    loading: false,
    status: getNodeStatus(n.name),
  }))
}

function getNodeStatus(nodeId: string): string | undefined {
  return props.nodeStates?.find((s) => s.nodeId === nodeId)?.status
}

// 仅更新状态，不重建树结构（保留展开状态）
function updateStatuses() {
  if (!props.nodeStates) return
  const stateMap = new Map(props.nodeStates.map((s) => [s.nodeId, s.status]))
  function walk(nodes: TreeNode[]) {
    for (const node of nodes) {
      const s = stateMap.get(node.path)
      if (s) node.status = s
      if (node.children) walk(node.children)
    }
  }
  walk(tree.value)
}

onMounted(buildTree)
watch(() => props.nodes, buildTree)
watch(() => props.project, buildTree)
watch(() => props.nodeStates, updateStatuses, { deep: true })

async function onToggle(node: TreeNode) {
  if (node.type === 'page') {
    router.push({ name: 'page', params: { path: node.path }, query: { project: props.project } })
    return
  }

  if (node.expanded) {
    node.expanded = false
    return
  }

  if (!node.children) {
    node.loading = true
    try {
      const graph = await fetchSubGraph(props.project, node.path)
      node.children = graph.nodes.map((n) => ({
        name: n.name,
        path: `${node.path}/${n.child.ref}`,
        type: n.child.type,
        expanded: false,
        loading: false,
        status: getNodeStatus(`${node.path}/${n.child.ref}`),
      }))
    } catch {
      node.children = []
    }
    node.loading = false
  }

  node.expanded = true
}

function onNavigate(node: TreeNode) {
  if (node.type === 'graph') {
    router.push({ name: 'graph', params: { path: node.path }, query: { project: props.project } })
  } else {
    router.push({ name: 'page', params: { path: node.path }, query: { project: props.project } })
  }
}
</script>

<template>
  <div class="doc-tree">
    <TreeItem
      v-for="node in tree"
      :key="node.path"
      :node="node"
      :depth="0"
      @toggle="onToggle"
      @navigate="onNavigate"
    />
  </div>
</template>

<style scoped>
.doc-tree {
  user-select: none;
}
</style>
