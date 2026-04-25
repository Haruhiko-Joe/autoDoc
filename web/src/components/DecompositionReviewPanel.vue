<script setup lang="ts">
import { computed, ref, onUnmounted, watch } from 'vue'
import {
  approveDecompositionReview,
  fetchDecompositionReviews,
  rejectDecompositionReview,
  updateDecompositionReview,
  type DecompositionReviewItem,
} from '../services/doc'
import ReviewGraphView from './ReviewGraphView.vue'
import NodeFormDialog from './NodeFormDialog.vue'
import EdgeFormDialog from './EdgeFormDialog.vue'
import {
  cloneGraphNodes,
  createGraphNode,
  normalizeGraphNodes,
  removeEdge,
  removeGraphNode,
  updateGraphNode,
  updateNodeEdges,
  upsertEdge,
  type EdgeFormData,
  type NodeFormData,
} from '../utils/graphNodes'
import type { EdgeType, GraphEdge, GraphNode } from '../types'

const props = defineProps<{
  project: string
  visible: boolean
}>()

const emit = defineEmits<{
  close: []
  changed: []
}>()

const reviews = ref<DecompositionReviewItem[]>([])
const selectedId = ref('')
const editableNodes = ref<GraphNode[]>([])
const feedback = ref('')
const loading = ref(false)
const error = ref('')
const graphHeight = ref(460)
const graphFullscreen = ref(false)
const panelWidth = ref(720)
type ReviewAction = 'saving' | 'approving' | 'rejecting'
const reviewActions = ref<Record<string, ReviewAction>>({})

const nodeDialogVisible = ref(false)
const nodeDialogTarget = ref<GraphNode | undefined>()
const edgeDialogVisible = ref(false)
const edgeDialogSource = ref('')
const edgeDialogTarget = ref<GraphEdge | undefined>()
const edgeDialogPrefillTarget = ref('')
let resizeStart: { y: number; height: number } | null = null
let panelResizeStart: { x: number; width: number; maxWidth: number } | null = null

const PANEL_MIN_WIDTH = 440
const PANEL_FALLBACK_RESERVED_WIDTH = 580
const MAIN_CANVAS_MIN_WIDTH = 360

const selectedReview = computed(() =>
  reviews.value.find((review) => review.id === selectedId.value) ?? null,
)
const selectedIsScaffold = computed(() => selectedReview.value?.kind === 'scaffold')
const targetOptions = computed(() =>
  editableNodes.value.map((node) => node.name).filter((name) => name !== edgeDialogSource.value),
)
const selectedAction = computed(() => selectedReview.value ? reviewActions.value[selectedReview.value.id] : undefined)
const selectedBusy = computed(() => selectedAction.value !== undefined)
const feedbackHasText = computed(() => feedback.value.trim().length > 0)
const graphShellStyle = computed(() =>
  graphFullscreen.value ? undefined : { height: `${graphHeight.value}px` },
)
const reviewPanelStyle = computed(() => ({ width: `${panelWidth.value}px` }))

function setReviewAction(id: string, action: ReviewAction) {
  const next = { ...reviewActions.value }
  next[id] = action
  reviewActions.value = next
}

function clearReviewAction(id: string) {
  const next = { ...reviewActions.value }
  delete next[id]
  reviewActions.value = next
}

function syncEditableNodes() {
  const review = selectedReview.value
  editableNodes.value = review ? cloneGraphNodes(review.nodes) : []
  feedback.value = ''
}

async function loadReviews() {
  if (!props.project) return
  loading.value = true
  error.value = ''
  try {
    const previousId = selectedId.value
    reviews.value = await fetchDecompositionReviews(props.project)
    selectedId.value = reviews.value.some((review) => review.id === previousId)
      ? previousId
      : reviews.value[0]?.id ?? ''
    syncEditableNodes()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load reviews'
  } finally {
    loading.value = false
  }
}

watch(() => [props.visible, props.project], ([visible]) => {
  if (!visible) return

  void loadReviews()
}, { immediate: true })

watch(selectedId, syncEditableNodes)

function getPanelMaxWidth(): number {
  const canvas = document.querySelector('.canvas')
  if (!canvas) return Math.max(PANEL_MIN_WIDTH, window.innerWidth - PANEL_FALLBACK_RESERVED_WIDTH)

  const canvasWidth = canvas.getBoundingClientRect().width
  return Math.max(PANEL_MIN_WIDTH, panelWidth.value + Math.max(0, canvasWidth - MAIN_CANVAS_MIN_WIDTH))
}

function startPanelResize(event: PointerEvent) {
  panelResizeStart = { x: event.clientX, width: panelWidth.value, maxWidth: getPanelMaxWidth() }
  window.addEventListener('pointermove', resizePanel)
  window.addEventListener('pointerup', stopPanelResize)
}

function resizePanel(event: PointerEvent) {
  if (!panelResizeStart) return
  const next = panelResizeStart.width - (event.clientX - panelResizeStart.x)
  panelWidth.value = Math.min(panelResizeStart.maxWidth, Math.max(PANEL_MIN_WIDTH, next))
}

function stopPanelResize() {
  panelResizeStart = null
  window.removeEventListener('pointermove', resizePanel)
  window.removeEventListener('pointerup', stopPanelResize)
}

function startGraphResize(event: PointerEvent) {
  if (graphFullscreen.value) return
  resizeStart = { y: event.clientY, height: graphHeight.value }
  window.addEventListener('pointermove', resizeGraph)
  window.addEventListener('pointerup', stopGraphResize)
}

function resizeGraph(event: PointerEvent) {
  if (!resizeStart) return
  const next = resizeStart.height + event.clientY - resizeStart.y
  graphHeight.value = Math.min(900, Math.max(280, next))
}

function stopGraphResize() {
  resizeStart = null
  window.removeEventListener('pointermove', resizeGraph)
  window.removeEventListener('pointerup', stopGraphResize)
}

onUnmounted(() => {
  stopGraphResize()
  stopPanelResize()
})

function removeReview(id: string) {
  const wasSelected = selectedId.value === id
  reviews.value = reviews.value.filter((review) => review.id !== id)
  if (wasSelected) {
    selectedId.value = reviews.value[0]?.id ?? ''
    syncEditableNodes()
  }
}

async function saveCandidate(clearAction = true): Promise<DecompositionReviewItem | null> {
  const review = selectedReview.value
  if (!review) return null
  const nodes = normalizeGraphNodes(editableNodes.value, selectedIsScaffold.value)
  setReviewAction(review.id, 'saving')
  error.value = ''
  try {
    await updateDecompositionReview(props.project, review.id, nodes)
    editableNodes.value = cloneGraphNodes(nodes)
    reviews.value = reviews.value.map((item) =>
      item.id === review.id ? { ...item, nodes: cloneGraphNodes(nodes) } : item,
    )
    emit('changed')
    return { ...review, nodes }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to save review'
    return null
  } finally {
    if (clearAction) clearReviewAction(review.id)
  }
}

async function approveCurrent() {
  if (feedbackHasText.value) return
  const saved = await saveCandidate(false)
  if (!saved) return
  setReviewAction(saved.id, 'approving')
  error.value = ''
  try {
    await approveDecompositionReview(props.project, saved.id)
    removeReview(saved.id)
    emit('changed')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to approve review'
  } finally {
    clearReviewAction(saved.id)
  }
}

async function approveReview(review: DecompositionReviewItem) {
  if (feedbackHasText.value) return
  if (review.id === selectedId.value) {
    await approveCurrent()
    return
  }
  setReviewAction(review.id, 'approving')
  error.value = ''
  try {
    await approveDecompositionReview(props.project, review.id)
    removeReview(review.id)
    emit('changed')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to approve review'
  } finally {
    clearReviewAction(review.id)
  }
}

async function requestChanges() {
  const text = feedback.value.trim()
  if (!text) return
  const saved = await saveCandidate(false)
  if (!saved) return
  setReviewAction(saved.id, 'rejecting')
  error.value = ''
  try {
    await rejectDecompositionReview(props.project, saved.id, text)
    emit('changed')
    await loadReviews()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to request changes'
  } finally {
    clearReviewAction(saved.id)
  }
}

function openAddNode() {
  nodeDialogTarget.value = undefined
  nodeDialogVisible.value = true
}

function openEditNode(node: GraphNode) {
  nodeDialogTarget.value = node
  nodeDialogVisible.value = true
}

function handleNodeSubmit(data: NodeFormData) {
  const target = nodeDialogTarget.value
  const forceGraphChild = selectedIsScaffold.value

  if (target) {
    editableNodes.value = updateGraphNode(editableNodes.value, target.name, data, forceGraphChild)
  } else {
    const node = createGraphNode(data, forceGraphChild)
    if (!node) return
    editableNodes.value = [...editableNodes.value, node]
  }

  nodeDialogVisible.value = false
}

function handleDeleteNode(node: GraphNode) {
  if (!confirm(`Delete "${node.name}"?`)) return
  editableNodes.value = removeGraphNode(editableNodes.value, node.name)
}

function handleEdgeCreate(source: string, target: string) {
  edgeDialogSource.value = source
  edgeDialogTarget.value = undefined
  edgeDialogPrefillTarget.value = target
  edgeDialogVisible.value = true
}

function openEditEdge(source: string, edge: { target: string; type: EdgeType; description: string }) {
  edgeDialogSource.value = source
  edgeDialogTarget.value = { ...edge }
  edgeDialogPrefillTarget.value = ''
  edgeDialogVisible.value = true
}

function handleEdgeSubmit(data: EdgeFormData) {
  const source = edgeDialogSource.value
  const current = edgeDialogTarget.value
  editableNodes.value = updateNodeEdges(editableNodes.value, source, (edges) =>
    upsertEdge(edges, current, data),
  )
  edgeDialogVisible.value = false
}

function handleEdgeDelete(source: string, edgeTarget: string, edgeType: EdgeType) {
  const nextNodes = updateNodeEdges(editableNodes.value, source, (edges) =>
    removeEdge(edges, edgeTarget, edgeType),
  )
  editableNodes.value = nextNodes
}
</script>

<template>
  <Transition name="panel-slide">
    <aside v-if="visible" class="review-panel" :style="reviewPanelStyle">
      <button
        class="panel-resize-handle"
        type="button"
        title="Resize panel"
        aria-label="Resize review panel"
        @pointerdown.prevent="startPanelResize"
      />
      <div class="panel-header">
        <div>
          <h3>Decomposition Review</h3>
          <p>{{ project }}</p>
        </div>
        <button class="panel-close" @click="emit('close')">&times;</button>
      </div>

      <div class="review-list" v-if="reviews.length > 0">
        <div
          v-for="review in reviews"
          :key="review.id"
          class="review-tab"
          :class="{ active: review.id === selectedId }"
          role="button"
          tabindex="0"
          @click="selectedId = review.id"
          @keydown.enter="selectedId = review.id"
        >
          <span>{{ review.kind === 'scaffold' ? 'Scaffold' : 'Decomposer' }}</span>
          <strong>{{ review.title }}</strong>
          <button
            type="button"
            class="review-tab-approve"
            :disabled="reviewActions[review.id] !== undefined || feedbackHasText"
            @click.stop="approveReview(review)"
          >
            {{ reviewActions[review.id] === 'approving' ? 'Approving...' : 'Approve' }}
          </button>
        </div>
      </div>

      <div v-if="loading" class="panel-empty">Loading reviews...</div>
      <div v-else-if="reviews.length === 0" class="panel-empty">
        <p>No decomposition reviews are waiting.</p>
        <button class="btn-secondary" @click="loadReviews">Refresh</button>
      </div>

      <template v-else-if="selectedReview">
        <div class="review-meta">
          <span class="review-kind">{{ selectedReview.kind }}</span>
          <h4>{{ selectedReview.title }}</h4>
          <p>{{ selectedReview.description }}</p>
        </div>

        <div class="graph-shell" :class="{ fullscreen: graphFullscreen }" :style="graphShellStyle">
          <div v-if="graphFullscreen" class="fullscreen-bar">
            <div>
              <strong>{{ selectedReview.title }}</strong>
              <span>{{ selectedReview.kind }}</span>
            </div>
            <button class="panel-close" @click="graphFullscreen = false">&times;</button>
          </div>
          <ReviewGraphView
            :nodes="editableNodes"
            @node-edit="openEditNode"
            @node-delete="handleDeleteNode"
            @edge-edit="openEditEdge"
            @edge-delete="handleEdgeDelete"
            @edge-create="handleEdgeCreate"
          />
          <button class="add-node-btn" title="Add node" @click="openAddNode">+</button>
          <button
            v-if="!graphFullscreen"
            class="fullscreen-btn"
            title="Full screen"
            @click="graphFullscreen = true"
          >
            &#x26F6;
          </button>
          <button
            v-if="!graphFullscreen"
            class="resize-handle"
            title="Resize canvas"
            @pointerdown.prevent="startGraphResize"
          />
        </div>

        <label class="feedback-box">
          <span>Feedback for redo</span>
          <textarea
            v-model="feedback"
            rows="4"
            placeholder="Explain what should be changed before this decomposition is accepted."
            :disabled="selectedBusy"
          />
        </label>

        <p v-if="error" class="panel-error">{{ error }}</p>

        <div class="panel-actions">
          <button class="btn-secondary" :disabled="loading" @click="loadReviews">Refresh</button>
          <button class="btn-secondary" :disabled="selectedBusy" @click="saveCandidate()">
            {{ selectedAction === 'saving' ? 'Saving...' : 'Save edits' }}
          </button>
          <button class="btn-secondary" :disabled="selectedBusy || !feedback.trim()" @click="requestChanges">
            {{ selectedAction === 'rejecting' ? 'Requesting...' : 'Request changes' }}
          </button>
          <button class="btn-primary" :disabled="selectedBusy || feedbackHasText" @click="approveCurrent">
            {{ selectedAction === 'approving' ? 'Approving...' : 'Approve' }}
          </button>
        </div>
      </template>

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
        :target-options="targetOptions"
        @close="edgeDialogVisible = false"
        @submit="handleEdgeSubmit"
      />
    </aside>
  </Transition>
</template>

<style scoped>
.review-panel {
  width: 720px;
  min-width: 440px;
  max-width: calc(100vw - 360px);
  position: relative;
  box-sizing: border-box;
  background: var(--bg-sidebar);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
}

.panel-resize-handle {
  position: absolute;
  left: -5px;
  top: 0;
  bottom: 0;
  z-index: 30;
  width: 10px;
  padding: 0;
  border: 0;
  border-radius: 0;
  appearance: none;
  background: transparent;
  cursor: ew-resize;
  touch-action: none;
}

.panel-resize-handle::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border);
}

.panel-resize-handle:hover::before,
.panel-resize-handle:focus-visible::before {
  left: 3px;
  width: 3px;
  background: var(--accent);
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.panel-header h3 {
  margin: 0 0 4px;
  font-size: 15px;
  color: var(--text-heading);
}

.panel-header p {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.panel-close {
  background: none;
  border: none;
  font-size: 20px;
  color: var(--text-disabled);
  cursor: pointer;
}

.panel-close:hover {
  color: var(--text-primary);
}

.review-list {
  display: flex;
  gap: 8px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}

.review-tab {
  min-width: 150px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
}

.review-tab.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.review-tab span {
  display: block;
  margin-bottom: 3px;
  font-size: 10px;
  text-transform: uppercase;
  color: var(--text-muted);
}

.review-tab strong {
  display: block;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.review-tab-approve {
  width: 100%;
  margin-top: 8px;
  padding: 5px 8px;
  border: 1px solid var(--accent);
  border-radius: 5px;
  background: transparent;
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}

.review-tab-approve:hover:not(:disabled) {
  background: var(--badge-active-bg);
}

.review-tab-approve:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.review-meta {
  padding: 14px 20px 10px;
}

.review-kind {
  display: inline-block;
  margin-bottom: 6px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--accent);
}

.review-meta h4 {
  margin: 0 0 6px;
  font-size: 14px;
  color: var(--text-heading);
}

.review-meta p {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.graph-shell {
  position: relative;
  margin: 0 20px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-body);
  min-height: 280px;
}

.graph-shell.fullscreen {
  position: fixed;
  inset: 16px;
  z-index: 1200;
  margin: 0;
  height: auto;
  min-height: 0;
  border-color: var(--accent);
  box-shadow: 0 18px 70px rgba(0, 0, 0, 0.45);
}

.fullscreen-bar {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  z-index: 20;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
}

.fullscreen-bar strong {
  display: block;
  max-width: min(820px, calc(100vw - 180px));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-heading);
  font-size: 14px;
}

.fullscreen-bar span {
  display: block;
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}

.add-node-btn {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 10;
  width: 32px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 20px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
}

.add-node-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.fullscreen .add-node-btn {
  top: 60px;
}

.fullscreen-btn {
  position: absolute;
  top: 12px;
  right: 52px;
  z-index: 10;
  width: 32px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 15px;
  cursor: pointer;
}

.fullscreen-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.resize-handle {
  position: absolute;
  right: 2px;
  bottom: 2px;
  z-index: 12;
  width: 22px;
  height: 22px;
  border: 0;
  background: linear-gradient(135deg, transparent 50%, var(--text-muted) 50%);
  opacity: 0.55;
  cursor: nwse-resize;
}

.resize-handle:hover {
  opacity: 0.9;
}

.feedback-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 14px 20px 0;
}

.feedback-box span {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.feedback-box textarea {
  resize: vertical;
  min-height: 78px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
}

.feedback-box textarea:focus {
  outline: none;
  border-color: var(--accent);
}

.panel-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px 18px;
}

.btn-primary,
.btn-secondary {
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.btn-primary {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
}

.btn-secondary {
  border: 1px solid var(--border);
  background: var(--bg-surface);
  color: var(--text-primary);
}

.btn-primary:disabled,
.btn-secondary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.panel-empty {
  margin: 20px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 13px;
  text-align: center;
}

.panel-empty p {
  margin: 0 0 12px;
}

.panel-error {
  margin: 10px 20px 0;
  color: var(--color-red);
  font-size: 12px;
}

.panel-slide-enter-active,
.panel-slide-leave-active {
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.panel-slide-enter-from,
.panel-slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
</style>
