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
  if (!props.nodeStates) return undefined
  const stateMap = new Map(props.nodeStates.map((s) => [s.nodeId, s.status]))
  return deriveStatus(nodeId, stateMap)
}

const RUNNING_STATUSES = new Set(['decomposing', 'writing', 'checking'])

// 计算节点的显示状态：如果子树中有任何运行中的节点，父节点也显示为运行中
function deriveStatus(nodePath: string, stateMap: Map<string, string>): string | undefined {
  const own = stateMap.get(nodePath)
  if (own && RUNNING_STATUSES.has(own)) return own

  const prefix = nodePath + '/'
  let hasDescendant = false
  let allDone = true
  for (const [id, status] of stateMap) {
    if (!id.startsWith(prefix)) continue
    hasDescendant = true
    if (RUNNING_STATUSES.has(status)) return 'writing' // 子树有运行中的节点，父节点显示为运行中
    if (status === 'error') return 'error'
    if (status !== 'done') allDone = false
  }

  if (hasDescendant && !allDone && own === 'done') return 'writing'
  return own
}

// 仅更新状态，不重建树结构（保留展开状态）
function updateStatuses() {
  if (!props.nodeStates) return
  const stateMap = new Map(props.nodeStates.map((s) => [s.nodeId, s.status]))
  function walk(nodes: TreeNode[]) {
    for (const node of nodes) {
      node.status = deriveStatus(node.path, stateMap)
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
    router.push(`/${props.project}/doc/${node.path}`)
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
    router.push(`/${props.project}/doc/${node.path}`)
  } else {
    router.push(`/${props.project}/doc/${node.path}`)
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
