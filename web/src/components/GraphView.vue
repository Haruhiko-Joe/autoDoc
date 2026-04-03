<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { Graph, NodeEvent, EdgeEvent } from '@antv/g6'
import { EDGE_STYLES } from '../services/edgeStyles'
import type { EdgeType } from '../types'

interface EdgeItem {
  target: string
  type: EdgeType
  description: string
  detail?: string
}

interface NodeItem {
  name: string
  description: string
  edges: EdgeItem[]
  child?: { type: 'graph' | 'page'; ref: string }
}

const props = defineProps<{
  nodes: NodeItem[]
}>()

const emit = defineEmits<{
  nodeClick: [node: NodeItem]
}>()

const containerRef = ref<HTMLDivElement>()
let graph: Graph | null = null

const CARD_WIDTH = 468
const CARD_HEIGHT = 234

// Edge detail popover state
const popover = ref<{
  visible: boolean
  x: number
  y: number
  source: string
  target: string
  type: EdgeType
  description: string
  detail: string
}>({
  visible: false,
  x: 0,
  y: 0,
  source: '',
  target: '',
  type: 'calls',
  description: '',
  detail: '',
})

function closePopover() {
  popover.value.visible = false
}

function renderCard(name: string, description: string): string {
  return `<div class="node-card">
    <div class="node-card-name">${name}</div>
    <div class="node-card-desc">${description}</div>
  </div>`
}

function polygonPositions(n: number, canvasW: number, canvasH: number) {
  const cx = canvasW / 2
  const cy = canvasH / 2
  const margin = 100
  const rx = (canvasW - margin * 2 - CARD_WIDTH) / 2
  const ry = (canvasH - margin * 2 - CARD_HEIGHT) / 2
  const startAngle = -Math.PI / 2
  return Array.from({ length: n }, (_, i) => {
    const angle = startAngle + (2 * Math.PI * i) / n
    return {
      x: cx + rx * Math.cos(angle),
      y: cy + ry * Math.sin(angle),
    }
  })
}

function buildData(nodes: NodeItem[], canvasW: number, canvasH: number) {
  const positions = polygonPositions(nodes.length, canvasW, canvasH)

  const g6Nodes = nodes.map((n, i) => ({
    id: n.name,
    data: { ...n },
    style: {
      x: positions[i]!.x,
      y: positions[i]!.y,
    },
  }))

  const g6Edges: {
    id: string
    source: string
    target: string
    data: { edgeType: EdgeType; description: string; detail: string; sourceName: string }
  }[] = []

  for (const node of nodes) {
    for (const edge of node.edges) {
      g6Edges.push({
        id: `${node.name}-${edge.target}-${edge.type}`,
        source: node.name,
        target: edge.target,
        data: {
          edgeType: edge.type,
          description: edge.description,
          detail: edge.detail ?? '',
          sourceName: node.name,
        },
      })
    }
  }

  return { nodes: g6Nodes, edges: g6Edges }
}

function createGraph() {
  if (!containerRef.value) return

  const rect = containerRef.value.getBoundingClientRect()
  const canvasW = rect.width || 800
  const canvasH = rect.height || 600
  const data = buildData(props.nodes, canvasW, canvasH)

  graph = new Graph({
    container: containerRef.value,
    width: canvasW,
    height: canvasH,
    data,
    node: {
      type: 'html',
      style: {
        size: [CARD_WIDTH, CARD_HEIGHT],
        dx: -CARD_WIDTH / 2,
        dy: -CARD_HEIGHT / 2,
        innerHTML: (d: { id: string; data?: { description?: string } }) => {
          return renderCard(d.id, d.data?.description ?? '')
        },
      },
    },
    edge: {
      type: 'line',
      style: (d: { data?: { edgeType?: EdgeType; description?: string } }) => {
        const edgeType = d.data?.edgeType ?? 'calls'
        const visual = EDGE_STYLES[edgeType]
        return {
          stroke: visual.stroke,
          lineWidth: edgeType === 'data-flow' ? 3 : 1.5,
          lineDash: visual.lineDash,
          endArrow: true,
          endArrowSize: 8,
          cursor: 'pointer',
          labelText: d.data?.description ?? '',
          labelFontSize: 11,
          labelFill: '#666',
          labelBackground: true,
          labelBackgroundFill: '#fff',
          labelBackgroundOpacity: 0.85,
          labelBackgroundRadius: 3,
          labelPadding: [2, 6],
          labelCursor: 'pointer',
        }
      },
    },
    behaviors: ['zoom-canvas', 'drag-canvas', 'drag-element'],
  })

  graph.on(NodeEvent.CLICK, (e: any) => {
    closePopover()
    const nodeId: string = e.target?.id
    if (!nodeId) return
    const found = props.nodes.find((n) => n.name === nodeId)
    if (found) emit('nodeClick', found)
  })

  graph.on(EdgeEvent.CLICK, (e: any) => {
    const edgeId: string = e.target?.id
    if (!edgeId || !graph) return

    // Bring clicked edge to top layer
    graph.frontElement(edgeId)

    const edgeData = graph.getEdgeData(edgeId)
    if (!edgeData?.data) return

    const d = edgeData.data as {
      edgeType: EdgeType
      description: string
      detail: string
      sourceName: string
    }

    if (!d.detail) return

    const containerRect = containerRef.value!.getBoundingClientRect()
    popover.value = {
      visible: true,
      x: (e.client?.x ?? e.clientX ?? 0) - containerRect.left,
      y: (e.client?.y ?? e.clientY ?? 0) - containerRect.top,
      source: d.sourceName,
      target: edgeData.target as string,
      type: d.edgeType,
      description: d.description,
      detail: d.detail,
    }
  })

  graph.on('canvas:click', closePopover)

  graph.render()
}

function destroyGraph() {
  if (graph) {
    graph.destroy()
    graph = null
  }
}

onMounted(createGraph)
onUnmounted(destroyGraph)

watch(
  () => props.nodes,
  () => {
    destroyGraph()
    createGraph()
  },
)
</script>

<template>
  <div ref="containerRef" class="graph-container">
    <div
      v-if="popover.visible"
      class="edge-popover"
      :style="{ left: popover.x + 'px', top: popover.y + 'px' }"
    >
      <div class="edge-popover-header">
        <div class="edge-popover-route">
          <span class="edge-popover-node">{{ popover.source }}</span>
          <span class="edge-popover-arrow">→</span>
          <span class="edge-popover-node">{{ popover.target }}</span>
        </div>
        <span class="edge-popover-type" :style="{ background: EDGE_STYLES[popover.type].stroke + '20', color: EDGE_STYLES[popover.type].stroke }">
          {{ popover.type }}
        </span>
        <button class="edge-popover-close" @click="closePopover">&times;</button>
      </div>
      <div class="edge-popover-desc">{{ popover.description }}</div>
      <div class="edge-popover-detail">{{ popover.detail }}</div>
    </div>
  </div>
</template>

<style>
.graph-container {
  width: 100%;
  height: 100%;
  position: relative;
}

.node-card {
  width: 468px;
  height: 234px;
  box-sizing: border-box;
  padding: 26px 30px;
  background: #fff;
  border: 1.5px solid #e0e0e0;
  border-radius: 12px;
  cursor: pointer;
  transition: box-shadow 0.2s, border-color 0.2s;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
}

.node-card:hover {
  border-color: #1890ff;
  box-shadow: 0 6px 20px rgba(24, 144, 255, 0.18);
}

.node-card-name {
  font-size: 17px;
  font-weight: 600;
  color: #1a1a1a;
  line-height: 1.3;
  flex-shrink: 0;
}

.node-card-desc {
  font-size: 13px;
  color: #666;
  line-height: 1.6;
}

/* Edge detail popover */
.edge-popover {
  position: absolute;
  z-index: 100;
  width: 380px;
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
  padding: 16px 20px;
  transform: translate(-50%, 12px);
  animation: popover-in 0.15s ease-out;
}

@keyframes popover-in {
  from {
    opacity: 0;
    transform: translate(-50%, 4px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 12px);
  }
}

.edge-popover-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.edge-popover-route {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.edge-popover-node {
  font-size: 13px;
  font-weight: 600;
  color: #333;
  background: #f5f5f5;
  padding: 2px 8px;
  border-radius: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.edge-popover-arrow {
  color: #bbb;
  font-size: 14px;
  flex-shrink: 0;
}

.edge-popover-type {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 4px;
  white-space: nowrap;
  flex-shrink: 0;
}

.edge-popover-close {
  background: none;
  border: none;
  font-size: 18px;
  color: #bbb;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  flex-shrink: 0;
}

.edge-popover-close:hover {
  color: #666;
}

.edge-popover-desc {
  font-size: 13px;
  font-weight: 500;
  color: #444;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid #f0f0f0;
}

.edge-popover-detail {
  font-size: 13px;
  color: #666;
  line-height: 1.7;
}
</style>
