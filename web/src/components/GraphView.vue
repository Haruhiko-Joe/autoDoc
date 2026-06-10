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
const selectedFilterNodeNames = ref<string[] | null>(null)

const { isDark } = useTheme()
const containerRef = ref<HTMLDivElement>()
let graph: Graph | null = null

const CARD_WIDTH = 468
const CARD_HEIGHT = 234
const CARD_WIDTH_COMPACT = 380
const CARD_HEIGHT_COMPACT = 156
const COMPACT_THRESHOLD = 8
const OVERLAP_TOLERANCE = 0.15
const POPOVER_WIDTH = 380
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

const filterNodeNames = computed(() => props.nodes.map((node) => node.name))
const visibleNodes = computed(() => filterGraphNodes(props.nodes, selectedFilterNodeNames.value))

function closePopover() {
  if (!popover.value.visible) return

  popover.value.visible = false
}

function syncSelectionWithVisibleNodes() {
  const visibleNames = new Set(visibleNodes.value.map((node) => node.name))
  if (selectedNodeId.value && !visibleNames.has(selectedNodeId.value)) selectedNodeId.value = null
  if (focusedNodeId.value && !visibleNames.has(focusedNodeId.value)) focusedNodeId.value = null
}

function pruneFilterSelection() {
  const selectedNames = pruneSelectedNodeNames(
    selectedFilterNodeNames.value,
    filterNodeNames.value,
  )
  selectedFilterNodeNames.value = selectedNames
}

function renderCard(name: string, description: string, isFocused: boolean): string {
  const escapedName = escapeHtml(name)
  const isSelected = props.editable && selectedNodeId.value === name
  const editBtns = props.editable
    ? `<span class="node-card-edit-btn" data-action="edit" data-node-id="${escapedName}" title="Edit">&#9998;</span>`
    : ''
  const isCompact = visibleNodes.value.length > COMPACT_THRESHOLD
  return `<div class="node-card${isSelected ? ' is-selected' : ''}${isCompact ? ' is-compact' : ''}" data-node-id="${escapedName}">
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
  const edgeItems = nodes.flatMap((node) =>
    node.edges.map((edge) => ({
      id: `${node.name}-${edge.target}-${edge.type}`,
      source: node.name,
      target: edge.target,
    })),
  )
  return edgeItems
}

function getFocusedNodeIds(nodeId: string): Set<string> {
  const focusedIds = new Set([nodeId])

  for (const node of visibleNodes.value) {
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

  const nodeIds = visibleNodes.value.map((node) => node.name)
  if (focusedNodeId.value && !nodeIds.includes(focusedNodeId.value)) {
    focusedNodeId.value = null
  }

  const activeId = focusedNodeId.value
  const focusedIds = activeId ? getFocusedNodeIds(activeId) : null
  const edgeItems = getEdgeItems(visibleNodes.value)

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
        opacity: !activeId || source === activeId || target === activeId ? 1 : FOCUS_DIM_OPACITY,
      },
    })),
  )
  await graph.draw()
  await graph.setElementZIndex(
    Object.fromEntries([
      ...nodeIds.map((id) => [id, focusedIds?.has(id) ? 2 : 0] as const),
      ...edgeItems.map(({ id, source, target }) => [
        id,
        activeId && (source === activeId || target === activeId) ? 1 : 0,
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

function getFocusTrigger(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  return target.closest('.node-card-focus-trigger') as HTMLElement | null
}

function cardSizeFor(n: number) {
  return n > COMPACT_THRESHOLD
    ? { w: CARD_WIDTH_COMPACT, h: CARD_HEIGHT_COMPACT }
    : { w: CARD_WIDTH, h: CARD_HEIGHT }
}

/** 超椭圆等角分布（原版布局，节点少时观感不变） */
function superellipsePositions(n: number, rx: number, ry: number) {
  const p = 6
  const startAngle = -Math.PI / 2
  return Array.from({ length: n }, (_, i) => {
    const angle = startAngle + (2 * Math.PI * i) / n
    const cosA = Math.cos(angle)
    const sinA = Math.sin(angle)
    const r = (Math.abs(cosA / rx) ** p + Math.abs(sinA / ry) ** p) ** (-1 / p)
    return { x: r * cosA, y: r * sinA }
  })
}

/** 矩形周界按弧长均匀分布（密集图：角部相邻卡天然纵向错位，缩放压力小） */
function perimeterPositions(n: number, rx: number, ry: number) {
  const w = 2 * rx
  const h = 2 * ry
  const per = 2 * (w + h)
  const step = per / n
  return Array.from({ length: n }, (_, i) => {
    let d = (i * step + w / 2) % per
    if (d < w) return { x: -rx + d, y: -ry }
    d -= w
    if (d < h) return { x: rx, y: -ry + d }
    d -= h
    if (d < w) return { x: rx - d, y: ry }
    d -= w
    return { x: -rx, y: ry - d }
  })
}

/**
 * 半径按画布尺寸计算，画布够大时布局与改造前完全相同（节点 ≤ 阈值时
 * 连分布算法也与原版一致）。仅当任意两卡交叠超过 OVERLAP_TOLERANCE 时，
 * 等比放大坐标空间到刚好满足容差为止，渲染后用 zoomTo(1/scale, 画布中心)
 * 把整体缩回画布——卡片变小但最多轻微交叠。坐标始终以画布中心为圆心。
 */
function ringLayout(n: number, canvasW: number, canvasH: number) {
  const { w: cardW, h: cardH } = cardSizeFor(n)
  const margin = 100
  const cx = canvasW / 2
  const cy = canvasH / 2
  const rx = Math.max(1, (canvasW - margin * 2 - cardW) / 2)
  const ry = Math.max(1, (canvasH - margin * 2 - cardH) / 2)
  const raw = n > COMPACT_THRESHOLD ? perimeterPositions(n, rx, ry) : superellipsePositions(n, rx, ry)

  const minDx = (1 - OVERLAP_TOLERANCE) * cardW
  const minDy = (1 - OVERLAP_TOLERANCE) * cardH
  let scale = 1
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = Math.abs(raw[i].x - raw[j].x)
      const dy = Math.abs(raw[i].y - raw[j].y)
      if (dx >= minDx || dy >= minDy) continue
      scale = Math.max(scale, Math.min(minDx / Math.max(dx, 1), minDy / Math.max(dy, 1)))
    }
  }
  return {
    positions: raw.map(({ x, y }) => ({ x: cx + x * scale, y: cy + y * scale })),
    scale,
  }
}

type G6EdgeData = Record<string, unknown> & {
  edgeType: EdgeType
  description: string
  detail: string
  sourceName: string
  parallelOffset: number
}

function buildData(nodes: GraphNode[], canvasW: number, canvasH: number) {
  const { positions, scale } = ringLayout(nodes.length, canvasW, canvasH)

  const g6Nodes = nodes.map((n, i) => ({
    id: n.name,
    data: { ...n },
    style: {
      x: positions[i]?.x ?? canvasW / 2,
      y: positions[i]?.y ?? canvasH / 2,
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
          parallelOffset: 0,
        },
      })
    }
  }

  assignParallelEdgeOffsets(g6Edges, 25)

  return { nodes: g6Nodes, edges: g6Edges, scale }
}

function createGraph() {
  if (!containerRef.value) return

  ensureParallelLineEdgeRegistered()

  const rect = containerRef.value.getBoundingClientRect()
  const canvasW = rect.width || 800
  const canvasH = rect.height || 600
  const { nodes: g6Nodes, edges: g6Edges, scale } = buildData(visibleNodes.value, canvasW, canvasH)
  const { w: cardW, h: cardH } = cardSizeFor(visibleNodes.value.length)

  graph = new Graph({
    container: containerRef.value,
    width: canvasW,
    height: canvasH,
    data: { nodes: g6Nodes, edges: g6Edges },
    node: {
      type: 'html',
      style: {
        size: [cardW, cardH],
        dx: -cardW / 2,
        dy: -cardH / 2,
        innerHTML: (d: { id: string; data?: { description?: string } }) => {
          const isFocused = focusedNodeId.value === d.id
          return renderCard(d.id, d.data?.description ?? '', isFocused)
        },
      },
    },
    edge: {
      type: PARALLEL_LINE_EDGE_TYPE,
      style: (d: { data?: { edgeType?: EdgeType; description?: string; parallelOffset?: number } }) => {
        const edgeType = d.data?.edgeType ?? 'calls'
        const visual = EDGE_STYLES[edgeType]
        const dark = isDark.value
        const offset = d.data?.parallelOffset ?? 0
        return {
          stroke: visual.stroke,
          lineWidth: edgeType === 'data-flow' ? 3 : 1.5,
          lineDash: visual.lineDash,
          parallelOffset: offset,
          endArrow: true,
          endArrowSize: 8,
          cursor: 'pointer',
          labelText: d.data?.description ?? '',
          labelFontSize: 11,
          labelFill: dark ? '#a9b1d6' : '#666',
          labelBackground: true,
          labelBackgroundFill: dark ? '#1c1d21' : '#fff',
          labelBackgroundOpacity: 0.85,
          labelBackgroundRadius: 3,
          labelPadding: [2, 6],
          labelCursor: 'pointer',
        }
      },
    },
    behaviors: props.editable
      ? [
          { type: 'zoom-canvas', trigger: ['Control'] },
          'scroll-canvas',
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
      : [{ type: 'zoom-canvas', trigger: ['Control'] }, 'scroll-canvas', 'drag-canvas', 'drag-element'],
  })

  graph.on(NodeEvent.CLICK, (evt) => {
    closePopover()
    const e = evt as unknown as { target?: { id?: string }; nativeEvent?: { target?: EventTarget | null } }
    const nativeTarget = e.nativeEvent?.target
    if (nativeTarget instanceof Element) {
      const marker = getFocusTrigger(nativeTarget)
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
    if (!d.detail && !props.editable) return

    const container = containerRef.value
    if (!container) return
    const containerRect = container.getBoundingClientRect()
    const halfWidth = Math.min(POPOVER_WIDTH, containerRect.width - 24) / 2
    const rawX = (e.client?.x ?? 0) - containerRect.left
    popover.value = {
      visible: true,
      x: Math.min(Math.max(rawX, halfWidth), containerRect.width - halfWidth),
      y: (e.client?.y ?? 0) - containerRect.top,
      source: d.sourceName,
      target: edgeData.target as string,
      type: d.edgeType,
      description: d.description,
      detail: d.detail,
    }
  })

  graph.on('canvas:click', closePopover)

  const activeGraph = graph
  void activeGraph.render()
    .catch((error) => {
      if (graph === activeGraph) console.error(error)
    })
    .then(() => {
      if (graph !== activeGraph || scale <= 1) return

      return activeGraph.zoomTo(1 / scale, undefined, [canvasW / 2, canvasH / 2])
    })
    .then(() => {
      if (graph !== activeGraph) return

      return applyFocusMode()
    })
    .catch((error) => {
      if (graph !== activeGraph) return

      console.error(error)
    })
}

function onKeyDown(e: KeyboardEvent) {
  if (!props.editable || !selectedNodeId.value) return
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const found = props.nodes.find((n) => n.name === selectedNodeId.value)
    if (found) emit('nodeDelete', found)
  }
}

function destroyGraph() {
  if (!graph) return

  graph.destroy()
  graph = null
}

function recreateGraph() {
  closePopover()
  syncSelectionWithVisibleNodes()
  destroyGraph()
  createGraph()
}

let resizeObserver: ResizeObserver | null = null
let resizeTimer: ReturnType<typeof setTimeout> | undefined

function onContainerResize() {
  const container = containerRef.value
  if (!graph || !container) return

  const { width, height } = container.getBoundingClientRect()
  if (!width || !height) return
  const [prevWidth, prevHeight] = graph.getSize()
  if (Math.round(width) === Math.round(prevWidth) && Math.round(height) === Math.round(prevHeight)) return

  recreateGraph()
}

onMounted(() => {
  createGraph()
  window.addEventListener('keydown', onKeyDown)
  if (containerRef.value) {
    resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(onContainerResize, 150)
    })
    resizeObserver.observe(containerRef.value)
  }
})
onUnmounted(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  clearTimeout(resizeTimer)
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
  <div
    ref="containerRef"
    class="graph-container"
  >
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
  background: var(--bg-surface);
}

/* G6 html node 内部渲染，需要全局样式 */
:global(.node-card) {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 24px 28px;
  background: var(--bg-surface);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-card);
  cursor: pointer;
  transition: box-shadow 0.2s, border-color 0.2s, transform 0.2s, opacity 0.2s;
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
  box-shadow: var(--shadow-soft);
  transform: translateY(-1px);
}

:global(.node-card-name) {
  font-size: 17px;
  font-weight: 650;
  color: var(--text-heading);
  line-height: 1.3;
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

:global(.node-card-focus-trigger) {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 4px 8px;
  background: var(--bg-surface-alt);
}

:global(.node-card-focus-trigger:hover) {
  color: var(--accent);
}

:global(.node-card-focus-trigger.is-active) {
  background: var(--badge-active-bg);
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 32%, transparent);
}

:global(.node-card.is-selected) {
  border-color: var(--accent);
  box-shadow: var(--shadow-focus), var(--shadow-soft);
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
  line-height: 1.55;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 7;
  overflow: hidden;
}

:global(.node-card.is-compact) {
  padding: 16px 20px;
  gap: 8px;
}

:global(.node-card.is-compact .node-card-desc) {
  -webkit-line-clamp: 3;
}

.edge-popover {
  position: absolute;
  z-index: var(--z-popover);
  width: 380px;
  max-width: calc(100% - 24px);
  background: var(--bg-surface);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-panel);
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
  flex-wrap: wrap;
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
  min-width: 0;
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
  min-height: 28px;
  padding: 0 14px;
  font-size: 12px;
  font-weight: 500;
  border-radius: var(--radius-control);
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
