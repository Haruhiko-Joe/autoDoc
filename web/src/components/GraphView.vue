<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { Graph, NodeEvent, EdgeEvent } from '@antv/g6'
import { EDGE_STYLES } from '../services/edgeStyles'
import { useTheme } from '../composables/useTheme'
import type { GraphNode, EdgeType } from '../types'

const props = defineProps<{
  nodes: GraphNode[]
  editable?: boolean
}>()

const emit = defineEmits<{
  nodeClick: [node: GraphNode]
  nodeEdit: [node: GraphNode]
  nodeDelete: [node: GraphNode]
  edgeEdit: [source: string, edge: { target: string; type: EdgeType; description: string }]
  edgeDelete: [source: string, edgeTarget: string, edgeType: EdgeType]
  edgeCreate: [source: string, target: string]
}>()

const selectedNodeId = ref<string | null>(null)

const { isDark } = useTheme()
const containerRef = ref<HTMLDivElement>()
let graph: Graph | null = null

const CARD_WIDTH = 468
const CARD_HEIGHT = 234
const FOCUS_DIM_OPACITY = 0.1

interface PopoverState {
  visible: boolean
  x: number
  y: number
  source: string
  target: string
  type: EdgeType
  description: string
  detail: string
}

const popover = ref<PopoverState>({
  visible: false,
  x: 0,
  y: 0,
  source: '',
  target: '',
  type: 'calls',
  description: '',
  detail: '',
})
const focusedNodeId = ref<string | null>(null)

function closePopover() {
  popover.value.visible = false
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderCard(name: string, description: string, isFocused: boolean): string {
  const escapedName = escapeHtml(name)
  const isSelected = props.editable && selectedNodeId.value === name
  const editBtns = props.editable
    ? `<span class="node-card-edit-btn" data-action="edit" data-node-id="${escapedName}" title="Edit">&#9998;</span>`
    : ''
  return `<div class="node-card${isSelected ? ' is-selected' : ''}" data-node-id="${escapedName}">
    <div class="node-card-header">
      <div class="node-card-name">${escapedName}</div>
      ${editBtns}
      <span
        class="node-card-focus-trigger${isFocused ? ' is-active' : ''}"
        data-node-id="${escapedName}"
      >focus</span>
    </div>
    <div class="node-card-desc">${escapeHtml(description)}</div>
  </div>`
}

function getEdgeItems(nodes: GraphNode[]) {
  return nodes.flatMap((node) =>
    node.edges.map((edge) => ({
      id: `${node.name}-${edge.target}-${edge.type}`,
      source: node.name,
      target: edge.target,
    })),
  )
}

function getFocusedNodeIds(nodeId: string): Set<string> {
  const focusedIds = new Set([nodeId])

  for (const node of props.nodes) {
    if (node.name === nodeId) {
      for (const edge of node.edges) focusedIds.add(edge.target)
    }

    if (node.edges.some((edge) => edge.target === nodeId)) {
      focusedIds.add(node.name)
    }
  }

  return focusedIds
}

function syncFocusButtons() {
  const container = containerRef.value
  if (!container) return

  const activeId = focusedNodeId.value
  const markers = container.querySelectorAll<HTMLElement>('.node-card-focus-trigger')
  for (const marker of markers) {
    const isActive = marker.dataset.nodeId === activeId
    marker.classList.toggle('is-active', isActive)
  }
}

async function applyFocusMode() {
  if (!graph) return

  const nodeIds = props.nodes.map((node) => node.name)
  if (focusedNodeId.value && !nodeIds.includes(focusedNodeId.value)) {
    focusedNodeId.value = null
  }

  const activeId = focusedNodeId.value
  const focusedIds = activeId ? getFocusedNodeIds(activeId) : null
  const edgeItems = getEdgeItems(props.nodes)

  graph.updateNodeData(
    nodeIds.map((id) => ({
      id,
      style: {
        opacity: !focusedIds || focusedIds.has(id) ? 1 : FOCUS_DIM_OPACITY,
      },
    })),
  )
  graph.updateEdgeData(
    edgeItems.map(({ id, source, target }) => ({
      id,
      style: {
        opacity: !focusedIds || (focusedIds.has(source) && focusedIds.has(target)) ? 1 : FOCUS_DIM_OPACITY,
      },
    })),
  )
  await graph.draw()
  await graph.setElementZIndex(
    Object.fromEntries([
      ...nodeIds.map((id) => [id, focusedIds?.has(id) ? 2 : 0] as const),
      ...edgeItems.map(({ id, source, target }) => [
        id,
        focusedIds && focusedIds.has(source) && focusedIds.has(target) ? 1 : 0,
      ] as const),
    ]),
  )
  syncFocusButtons()
}

function setFocusMode(nodeId: string | null) {
  if (focusedNodeId.value === nodeId) return
  focusedNodeId.value = nodeId
  closePopover()
  void applyFocusMode()
}

function onContainerPointerOverCapture(_event: PointerEvent) {
  // Focus is now click-toggled; hover no longer drives focus state.
}

function onContainerPointerOutCapture(_event: PointerEvent) {
  // Focus is now click-toggled; hover no longer drives focus state.
}

function superellipsePositions(n: number, canvasW: number, canvasH: number) {
  const cx = canvasW / 2
  const cy = canvasH / 2
  const margin = 100
  const rx = (canvasW - margin * 2 - CARD_WIDTH) / 2
  const ry = (canvasH - margin * 2 - CARD_HEIGHT) / 2
  const p = 6
  const startAngle = -Math.PI / 2
  return Array.from({ length: n }, (_, i) => {
    const angle = startAngle + (2 * Math.PI * i) / n
    const cosA = Math.cos(angle)
    const sinA = Math.sin(angle)
    const r = (Math.abs(cosA / rx) ** p + Math.abs(sinA / ry) ** p) ** (-1 / p)
    return {
      x: cx + r * cosA,
      y: cy + r * sinA,
    }
  })
}

type G6EdgeData = Record<string, unknown> & {
  edgeType: EdgeType
  description: string
  detail: string
  sourceName: string
  curveOffset: number
}

function buildData(nodes: GraphNode[], canvasW: number, canvasH: number) {
  const positions = superellipsePositions(nodes.length, canvasW, canvasH)

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
    data: G6EdgeData
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
          curveOffset: 0,
        },
      })
    }
  }

  // Detect parallel edges between the same pair of nodes and assign curve offsets
  // Key insight: for reversed edges (A→B vs B→A), G6's curveOffset perpendicular
  // direction flips with edge direction, so same-sign offsets actually curve to
  // opposite sides. We must give reversed edges the SAME offset sign, and only
  // spread same-direction edges with different offsets.
  const pairMap = new Map<string, typeof g6Edges>()
  for (const edge of g6Edges) {
    // Use directed key so A→B and B→A are in the same group but distinguishable
    const key = [edge.source, edge.target].sort().join('|')
    const group = pairMap.get(key)
    if (group) group.push(edge)
    else pairMap.set(key, [edge])
  }
  const CURVE_GAP = 25
  for (const group of pairMap.values()) {
    if (group.length < 2) continue
    // Sort so that edges with the same direction are adjacent
    const sorted = group.sort((a, b) => {
      const dirA = `${a.source}->${a.target}`
      const dirB = `${b.source}->${b.target}`
      return dirA.localeCompare(dirB)
    })
    // Assign offsets: use the canonical direction (source < target) as reference.
    // Edges matching canonical direction get positive offset, reversed get negative.
    // Multiple edges in the same direction get incremented offsets.
    const forwardEdges = sorted.filter((e) => e.source <= e.target)
    const reverseEdges = sorted.filter((e) => e.source > e.target)
    forwardEdges.forEach((edge, i) => {
      edge.data.curveOffset = CURVE_GAP * (i + 1)
    })
    reverseEdges.forEach((edge, i) => {
      edge.data.curveOffset = CURVE_GAP * (i + 1)
    })
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
          return renderCard(d.id, d.data?.description ?? '', focusedNodeId.value === d.id)
        },
      },
    },
    edge: {
      type: 'quadratic',
      style: (d: { data?: { edgeType?: EdgeType; description?: string; curveOffset?: number } }) => {
        const edgeType = d.data?.edgeType ?? 'calls'
        const visual = EDGE_STYLES[edgeType]
        const dark = isDark.value
        const offset = d.data?.curveOffset ?? 0
        return {
          stroke: visual.stroke,
          lineWidth: edgeType === 'data-flow' ? 3 : 1.5,
          lineDash: visual.lineDash,
          curveOffset: offset,
          endArrow: true,
          endArrowSize: 8,
          cursor: 'pointer',
          labelText: d.data?.description ?? '',
          labelFontSize: 11,
          labelFill: dark ? '#a9b1d6' : '#666',
          labelBackground: true,
          labelBackgroundFill: dark ? '#24283b' : '#fff',
          labelBackgroundOpacity: 0.85,
          labelBackgroundRadius: 3,
          labelPadding: [2, 6],
          labelCursor: 'pointer',
        }
      },
    },
    behaviors: props.editable
      ? [
          'zoom-canvas',
          'drag-canvas',
          'drag-element',
          {
            type: 'create-edge',
            trigger: 'drag',
            onCreate: (edge: { source: string | number; target: string | number }) => {
              const src = String(edge.source)
              const tgt = String(edge.target)
              if (src !== tgt) {
                emit('edgeCreate', src, tgt)
              }
              return undefined
            },
          },
        ]
      : ['zoom-canvas', 'drag-canvas', 'drag-element'],
  })

  graph.on(NodeEvent.CLICK, (evt) => {
    closePopover()
    const e = evt as unknown as { target?: { id?: string }; nativeEvent?: { target?: EventTarget | null } }
    const nativeTarget = e.nativeEvent?.target
    if (nativeTarget instanceof Element) {
      const marker = nativeTarget.closest('.node-card-focus-trigger') as HTMLElement | null
      if (marker) {
        const nodeId = marker.dataset.nodeId
        if (nodeId) {
          setFocusMode(focusedNodeId.value === nodeId ? null : nodeId)
        }
        return
      }
    }
    if (nativeTarget instanceof Element) {
      const editBtn = nativeTarget.closest('[data-action="edit"]') as HTMLElement | null
      if (editBtn) {
        const nodeId = editBtn.dataset.nodeId
        const found = props.nodes.find((n) => n.name === nodeId)
        if (found) emit('nodeEdit', found)
        return
      }
    }
    const nodeId = e.target?.id
    if (!nodeId) return
    if (props.editable) {
      selectedNodeId.value = selectedNodeId.value === nodeId ? null : nodeId
      destroyGraph()
      createGraph()
      return
    }
    const found = props.nodes.find((n) => n.name === nodeId)
    if (found) emit('nodeClick', found)
  })

  graph.on(EdgeEvent.CLICK, (evt) => {
    const e = evt as unknown as { target?: { id?: string }; client?: { x: number; y: number } }
    const edgeId = e.target?.id
    if (!edgeId || !graph) return

    graph.frontElement(edgeId)

    const edgeData = graph.getEdgeData(edgeId)
    if (!edgeData?.data) return

    const d = edgeData.data as unknown as G6EdgeData
    if (!d.detail) return

    const containerRect = containerRef.value!.getBoundingClientRect()
    popover.value = {
      visible: true,
      x: (e.client?.x ?? 0) - containerRect.left,
      y: (e.client?.y ?? 0) - containerRect.top,
      source: d.sourceName,
      target: edgeData.target as string,
      type: d.edgeType,
      description: d.description,
      detail: d.detail,
    }
  })

  graph.on('canvas:click', closePopover)

  void graph.render().then(() => applyFocusMode())
}

function onKeyDown(e: KeyboardEvent) {
  if (!props.editable || !selectedNodeId.value) return
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const found = props.nodes.find((n) => n.name === selectedNodeId.value)
    if (found) emit('nodeDelete', found)
  }
}

function destroyGraph() {
  if (graph) {
    graph.destroy()
    graph = null
  }
}

onMounted(() => {
  createGraph()
  window.addEventListener('keydown', onKeyDown)
})
onUnmounted(() => {
  destroyGraph()
  window.removeEventListener('keydown', onKeyDown)
})

watch(
  () => props.nodes,
  () => {
    destroyGraph()
    createGraph()
  },
)

watch(isDark, () => {
  destroyGraph()
  createGraph()
})
</script>

<template>
  <div
    ref="containerRef"
    class="graph-container"
    @pointerover.capture="onContainerPointerOverCapture"
    @pointerout.capture="onContainerPointerOutCapture"
  >
    <Transition name="popover">
      <div
        v-if="popover.visible"
        class="edge-popover"
        :style="{ left: popover.x + 'px', top: popover.y + 'px' }"
      >
        <div class="edge-popover-header">
          <div class="edge-popover-route">
            <span class="edge-popover-node">{{ popover.source }}</span>
            <span class="edge-popover-arrow">&rarr;</span>
            <span class="edge-popover-node">{{ popover.target }}</span>
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
          <button class="edge-popover-close" @click="closePopover">&times;</button>
        </div>
        <div class="edge-popover-desc">{{ popover.description }}</div>
        <div class="edge-popover-detail" v-if="popover.detail">{{ popover.detail }}</div>
        <div class="edge-popover-actions" v-if="editable">
          <button class="btn-sm" @click="$emit('edgeEdit', popover.source, { target: popover.target, type: popover.type, description: popover.description }); closePopover()">Edit</button>
          <button class="btn-sm danger" @click="$emit('edgeDelete', popover.source, popover.target, popover.type); closePopover()">Delete</button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.graph-container {
  width: 100%;
  height: 100%;
  position: relative;
  background: var(--bg-body);
}

/* G6 html node 内部渲染，需要全局样式 */
:global(.node-card) {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 26px 30px;
  background: var(--bg-surface);
  border: 1.5px solid var(--border-card);
  border-radius: 12px;
  cursor: pointer;
  transition: box-shadow 0.2s, border-color 0.2s;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
}

:global(.node-card-header) {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

:global(.node-card:hover) {
  border-color: var(--accent);
  box-shadow: 0 6px 20px var(--accent-shadow);
}

:global(.node-card-name) {
  font-size: 17px;
  font-weight: 600;
  color: var(--text-heading);
  line-height: 1.3;
  flex: 1;
  min-width: 0;
}

:global(.node-card-focus-trigger) {
  color: var(--text-disabled);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
  flex-shrink: 0;
}

:global(.node-card-focus-trigger:hover) {
  color: var(--accent);
}

:global(.node-card-focus-trigger.is-active) {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}

:global(.node-card.is-selected) {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent), 0 6px 20px var(--accent-shadow);
}

:global(.node-card-edit-btn) {
  color: var(--text-disabled);
  font-size: 14px;
  cursor: pointer;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
}

:global(.node-card:hover .node-card-edit-btn) {
  opacity: 1;
}

:global(.node-card-edit-btn:hover) {
  color: var(--accent);
}

:global(.node-card-desc) {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.edge-popover {
  position: absolute;
  z-index: 100;
  width: 380px;
  background: var(--bg-surface);
  border: 1px solid var(--border-card);
  border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.2);
  padding: 16px 20px;
  transform: translate(-50%, 12px);
}

.popover-enter-active {
  animation: popover-in 0.15s ease-out;
}

.popover-leave-active {
  animation: popover-in 0.15s ease-in reverse;
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
  color: var(--text-primary);
  background: var(--bg-surface-alt);
  padding: 2px 8px;
  border-radius: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.edge-popover-arrow {
  color: var(--text-disabled);
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
  color: var(--text-disabled);
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  flex-shrink: 0;
}

.edge-popover-close:hover {
  color: var(--text-secondary);
}

.edge-popover-desc {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-light);
}

.edge-popover-detail {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.7;
}

.edge-popover-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border-light);
}

.btn-sm {
  padding: 4px 14px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 5px;
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--bg-surface);
  color: var(--text-primary);
}

.btn-sm:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.btn-sm.danger:hover {
  border-color: var(--color-red);
  color: var(--color-red);
}
</style>
