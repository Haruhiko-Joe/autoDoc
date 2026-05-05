<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import { Graph, NodeEvent, EdgeEvent } from '@antv/g6'
import { EDGE_STYLES } from '../services/edgeStyles'
import { useTheme } from '../composables/useTheme'
import GraphNodeFilter from './GraphNodeFilter.vue'
import { escapeHtml } from '../utils/html'
import { filterGraphNodes, pruneSelectedNodeNames } from '../utils/graphNodes'
import {
  PARALLEL_LINE_EDGE_TYPE,
  assignParallelEdgeOffsets,
  ensureParallelLineEdgeRegistered,
} from '../utils/parallelEdges'
import type { EdgeType, GraphNode } from '../types'

const props = defineProps<{
  nodes: GraphNode[]
}>()

const emit = defineEmits<{
  nodeEdit: [node: GraphNode]
  nodeDelete: [node: GraphNode]
  edgeEdit: [source: string, edge: { target: string; type: EdgeType; description: string }]
  edgeDelete: [source: string, edgeTarget: string, edgeType: EdgeType]
  edgeCreate: [source: string, target: string]
}>()

const { isDark } = useTheme()
const containerRef = ref<HTMLDivElement>()
const selectedNodeId = ref<string | null>(null)
const selectedFilterNodeNames = ref<string[] | null>(null)
let graph: Graph | null = null
let lastNodeClick: { id: string; time: number } | null = null
let resizeObserver: ResizeObserver | null = null

const NODE_WIDTH = 176
const NODE_HEIGHT = 42

type EdgeData = Record<string, unknown> & {
  edgeType: EdgeType
  description: string
  sourceName: string
  parallelOffset: number
}

const popover = ref({
  visible: false,
  x: 0,
  y: 0,
  source: '',
  target: '',
  type: 'calls' as EdgeType,
  description: '',
})

const filterNodeNames = computed(() => props.nodes.map((node) => node.name))
const visibleNodes = computed(() => filterGraphNodes(props.nodes, selectedFilterNodeNames.value))

function closePopover() {
  if (!popover.value.visible) return

  popover.value.visible = false
}

function syncSelectionWithVisibleNodes() {
  const visibleNames = new Set(visibleNodes.value.map((node) => node.name))
  if (selectedNodeId.value && !visibleNames.has(selectedNodeId.value)) selectedNodeId.value = null
}

function pruneFilterSelection() {
  const selectedNames = pruneSelectedNodeNames(
    selectedFilterNodeNames.value,
    filterNodeNames.value,
  )
  selectedFilterNodeNames.value = selectedNames
}

function renderNode(name: string): string {
  const escaped = escapeHtml(name)
  const selected = selectedNodeId.value === name
  return `<div class="review-graph-node${selected ? ' is-selected' : ''}" title="${escaped}">
    <span class="review-graph-node-name">${escaped}</span>
  </div>`
}

function compactPositions(n: number, canvasW: number, canvasH: number) {
  const margin = 72
  const gapX = 56
  const gapY = 48
  const cellW = NODE_WIDTH + gapX
  const cellH = NODE_HEIGHT + gapY
  const maxCols = Math.max(1, Math.floor(Math.max(canvasW - margin * 2, NODE_WIDTH) / cellW))
  const maxRows = Math.max(1, Math.floor(Math.max(canvasH - margin * 2, NODE_HEIGHT) / cellH))
  const cols = Math.min(maxCols, Math.max(1, Math.ceil(n / maxRows)))

  return Array.from({ length: n }, (_, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    return {
      x: margin + col * cellW + NODE_WIDTH / 2,
      y: margin + row * cellH + NODE_HEIGHT / 2,
    }
  })
}

function buildData(nodes: GraphNode[], canvasW: number, canvasH: number) {
  const positions = compactPositions(nodes.length, canvasW, canvasH)
  const g6Nodes = nodes.map((node, i) => ({
    id: node.name,
    data: { ...node },
    style: {
      x: positions[i]?.x ?? canvasW / 2,
      y: positions[i]?.y ?? canvasH / 2,
    },
  }))

  const g6Edges: {
    id: string
    source: string
    target: string
    data: EdgeData
  }[] = []

  for (const node of nodes) {
    node.edges.forEach((edge, index) => {
      const g6Edge = {
        id: `${node.name}-${edge.target}-${edge.type}-${index}`,
        source: node.name,
        target: edge.target,
        data: {
          edgeType: edge.type,
          description: edge.description,
          sourceName: node.name,
          parallelOffset: 0,
        },
      }
      g6Edges.push(g6Edge)
    })
  }

  assignParallelEdgeOffsets(g6Edges, 18)

  return { nodes: g6Nodes, edges: g6Edges }
}

function createGraph() {
  const container = containerRef.value
  if (!container) return

  ensureParallelLineEdgeRegistered()

  const rect = container.getBoundingClientRect()
  const canvasW = rect.width || 600
  const canvasH = rect.height || 360

  graph = new Graph({
    container,
    width: canvasW,
    height: canvasH,
    data: buildData(visibleNodes.value, canvasW, canvasH),
    node: {
      type: 'html',
      style: {
        size: [NODE_WIDTH, NODE_HEIGHT],
        dx: -NODE_WIDTH / 2,
        dy: -NODE_HEIGHT / 2,
        innerHTML: (d: { id: string }) => renderNode(d.id),
      },
    },
    edge: {
      type: PARALLEL_LINE_EDGE_TYPE,
      style: (d: { data?: { edgeType?: EdgeType; parallelOffset?: number } }) => {
        const edgeType = d.data?.edgeType ?? 'calls'
        const visual = EDGE_STYLES[edgeType]
        return {
          stroke: visual.stroke,
          lineWidth: edgeType === 'data-flow' ? 2.5 : 1.4,
          lineDash: visual.lineDash,
          parallelOffset: d.data?.parallelOffset ?? 0,
          endArrow: true,
          endArrowSize: 7,
          cursor: 'pointer',
        }
      },
    },
    behaviors: [
      { type: 'zoom-canvas', trigger: ['Control'] },
      'scroll-canvas',
      'drag-canvas',
      'drag-element',
      {
        type: 'create-edge',
        trigger: 'drag',
        onCreate: (edge: { source: string | number; target: string | number }) => {
          const source = String(edge.source)
          const target = String(edge.target)
          if (source !== target) emit('edgeCreate', source, target)
          return undefined
        },
      },
    ],
  })

  graph.on(NodeEvent.CLICK, (evt) => {
    closePopover()
    const e = evt as unknown as { target?: { id?: string } }
    const nodeId = e.target?.id
    if (!nodeId) return

    const now = Date.now()
    const isDoubleClick = lastNodeClick?.id === nodeId && now - lastNodeClick.time < 320
    lastNodeClick = { id: nodeId, time: now }

    if (isDoubleClick) {
      const found = props.nodes.find((node) => node.name === nodeId)
      if (found) emit('nodeEdit', found)
      return
    }

    selectedNodeId.value = selectedNodeId.value === nodeId ? null : nodeId
    destroyGraph()
    createGraph()
  })

  graph.on(EdgeEvent.CLICK, (evt) => {
    const e = evt as unknown as { target?: { id?: string }; client?: { x: number; y: number } }
    const edgeId = e.target?.id
    if (!edgeId || !graph || !containerRef.value) return
    graph.frontElement(edgeId)

    const edgeData = graph.getEdgeData(edgeId)
    if (!edgeData?.data) return
    const data = edgeData.data as unknown as EdgeData
    const rect = containerRef.value.getBoundingClientRect()
    popover.value = {
      visible: true,
      x: (e.client?.x ?? 0) - rect.left,
      y: (e.client?.y ?? 0) - rect.top,
      source: data.sourceName,
      target: String(edgeData.target),
      type: data.edgeType,
      description: data.description,
    }
  })

  graph.on('canvas:click', closePopover)

  const activeGraph = graph
  void activeGraph.render().catch((error) => {
    if (graph !== activeGraph) return

    console.error(error)
  })
}

function destroyGraph() {
  if (!graph) return

  graph.destroy()
  graph = null
}

function recreateGraph() {
  closePopover()
  lastNodeClick = null
  syncSelectionWithVisibleNodes()
  destroyGraph()
  createGraph()
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return
  const nodeId = selectedNodeId.value
  if (!nodeId) return
  const found = props.nodes.find((node) => node.name === nodeId)
  if (found) emit('nodeDelete', found)
}

onMounted(() => {
  createGraph()
  if (containerRef.value) {
    resizeObserver = new ResizeObserver(() => {
      destroyGraph()
      createGraph()
    })
    resizeObserver.observe(containerRef.value)
  }
  window.addEventListener('keydown', onKeyDown)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  destroyGraph()
  window.removeEventListener('keydown', onKeyDown)
})

watch(
  () => props.nodes,
  () => {
    pruneFilterSelection()
    recreateGraph()
  },
)

watch(selectedFilterNodeNames, recreateGraph)

watch(isDark, recreateGraph)
</script>

<template>
  <div ref="containerRef" class="review-graph-container">
    <GraphNodeFilter
      v-model:selected-names="selectedFilterNodeNames"
      :node-names="filterNodeNames"
    />
    <Transition name="popover">
      <div
        v-if="popover.visible"
        class="edge-popover"
        :style="{ left: popover.x + 'px', top: popover.y + 'px' }"
      >
        <div class="edge-popover-header">
          <strong>{{ popover.source }} &rarr; {{ popover.target }}</strong>
          <button class="edge-popover-close" @click="closePopover">&times;</button>
        </div>
        <span
          class="edge-popover-type"
          :style="{
            background: EDGE_STYLES[popover.type].stroke + '20',
            color: EDGE_STYLES[popover.type].stroke,
          }"
        >
          {{ popover.type }}
        </span>
        <p>{{ popover.description }}</p>
        <div class="edge-popover-actions">
          <button @click="$emit('edgeEdit', popover.source, { target: popover.target, type: popover.type, description: popover.description }); closePopover()">Edit</button>
          <button class="danger" @click="$emit('edgeDelete', popover.source, popover.target, popover.type); closePopover()">Delete</button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.review-graph-container {
  width: 100%;
  height: 100%;
  position: relative;
  background: var(--bg-surface);
}

:global(.review-graph-node) {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 12px;
  border: 1px solid var(--border-card);
  border-radius: var(--radius-card);
  background: var(--bg-surface);
  color: var(--text-heading);
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
  overflow: hidden;
}

:global(.review-graph-node.is-selected) {
  border-color: var(--accent);
  box-shadow: var(--shadow-focus);
}

:global(.review-graph-node-name) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.edge-popover {
  position: absolute;
  z-index: 20;
  width: 280px;
  transform: translate(-50%, 10px);
  padding: 12px;
  border: 1px solid var(--border-card);
  border-radius: var(--radius-card);
  background: var(--bg-surface);
  box-shadow: var(--shadow-panel);
}

.edge-popover-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.edge-popover-header strong {
  color: var(--text-heading);
  font-size: 12px;
  line-height: 1.4;
}

.edge-popover-close {
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0;
}

.edge-popover-type {
  display: inline-block;
  margin-bottom: 8px;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
}

.edge-popover p {
  margin: 0 0 10px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.edge-popover-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.edge-popover-actions button {
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}

.edge-popover-actions .danger {
  color: var(--color-red);
  border-color: var(--color-red);
}

.popover-enter-active,
.popover-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.popover-enter-from,
.popover-leave-to {
  opacity: 0;
  transform: translate(-50%, 4px);
}
</style>
