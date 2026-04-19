<script setup lang="ts">
import { ref, computed, onUnmounted, onMounted, watch, nextTick } from 'vue'
import TaskCard from './TaskCard.vue'
import TaskConfirmDialog from './TaskConfirmDialog.vue'
import { useUpdateQueue } from '../composables/useUpdateQueue'
import type { Ref } from 'vue'

const props = defineProps<{
  project: string
  visible: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const projectRef = ref(props.project) as Ref<string>
const {
  tasks, mode, isRunning,
  awaitingConfirmTaskId, awaitingReviewTaskId,
  error,
  start, skip, continueNext, acceptTask, sendFollowUp, cancel, dispose,
} = useUpdateQueue(projectRef)

onUnmounted(() => {
  dispose()
  resizeObserver?.disconnect()
})

const selectedMode = ref<'auto' | 'manual'>('auto')

// Dynamic visible-limit based on task-list container height.
// Per-card = collapsed height (44px) + 8px gap. Running/done-expanded cards
// are taller but users can scroll; we optimize for the "many idle waiting" case.
const taskListRef = ref<HTMLElement | null>(null)
const containerHeight = ref(0)
const PER_CARD_PX = 52
const MIN_VISIBLE = 3
let resizeObserver: ResizeObserver | null = null

const visibleLimit = computed(() =>
  Math.max(MIN_VISIBLE, Math.floor(containerHeight.value / PER_CARD_PX)),
)

onMounted(() => {
  watch(
    () => props.visible,
    async (v) => {
      if (!v) return
      await nextTick()
      if (!taskListRef.value) return
      containerHeight.value = taskListRef.value.clientHeight
      resizeObserver?.disconnect()
      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          containerHeight.value = entry.contentRect.height
        }
      })
      resizeObserver.observe(taskListRef.value)
    },
    { immediate: true },
  )
})

const activeDialogTaskId = ref<string | null>(null)

// Auto-open the dialog when the queue gates for confirmation (pre-run) or review (post-run).
watch(awaitingConfirmTaskId, (id) => { if (id) activeDialogTaskId.value = id })
watch(awaitingReviewTaskId, (id) => { if (id) activeDialogTaskId.value = id })

const dialogTask = computed(() => {
  const id = activeDialogTaskId.value
  if (!id) return null
  return tasks.value.find((t) => t.id === id) ?? null
})

const dialogMode = computed<'confirm' | 'review' | 'readonly'>(() => {
  const task = dialogTask.value
  if (!task) return 'readonly'
  if (task.id === awaitingConfirmTaskId.value && task.status === 'idle') return 'confirm'
  if (task.status === 'awaiting-review') return 'review'
  return 'readonly'
})

function handleOpenTask(taskId: string) {
  activeDialogTaskId.value = taskId
}

function handleDialogClose() {
  activeDialogTaskId.value = null
}

function handleConfirm(extraInstructions: string) {
  void continueNext(extraInstructions)
}

function handleAccept() {
  const task = dialogTask.value
  if (!task) return
  void acceptTask(task.id)
}

function handleFollowUp(prompt: string) {
  const task = dialogTask.value
  if (!task) return
  void sendFollowUp(task.id, prompt)
}

function handleSkipConfirm() {
  const id = awaitingConfirmTaskId.value
  if (!id) return
  awaitingConfirmTaskId.value = null
  activeDialogTaskId.value = null
  void skip(id)
  void continueNext()
}

const counts = computed(() => {
  const c = { idle: 0, running: 0, 'awaiting-review': 0, done: 0, skipped: 0, error: 0 }
  for (const t of tasks.value) c[t.status]++
  return c
})

const activeTasks = computed(() =>
  tasks.value.filter((t) => t.status === 'running' || t.status === 'idle' || t.status === 'error' || t.status === 'awaiting-review'),
)
const visibleTasks = computed(() => activeTasks.value.slice(0, visibleLimit.value))
const hiddenCount = computed(() => activeTasks.value.length - visibleTasks.value.length)

async function handleStart() {
  projectRef.value = props.project
  await start(selectedMode.value)
}
</script>

<template>
  <Transition name="panel-slide">
    <aside v-if="visible" class="update-panel">
      <div class="panel-header">
        <h3>Update Queue</h3>
        <button class="panel-close" @click="emit('close')">&times;</button>
      </div>

      <div class="panel-controls" v-if="!isRunning && tasks.length === 0">
        <div class="mode-switch" role="radiogroup" aria-label="Update mode">
          <span class="switch-thumb" :class="selectedMode" aria-hidden="true" />
          <button
            type="button"
            role="radio"
            :aria-checked="selectedMode === 'auto'"
            :class="{ active: selectedMode === 'auto' }"
            @click="selectedMode = 'auto'"
          >Auto</button>
          <button
            type="button"
            role="radio"
            :aria-checked="selectedMode === 'manual'"
            :class="{ active: selectedMode === 'manual' }"
            @click="selectedMode = 'manual'"
          >Manual</button>
        </div>
        <p class="mode-hint">
          {{ selectedMode === 'auto'
            ? 'Process every PR sequentially without interruption.'
            : 'Pause after each PR for review and confirmation.' }}
        </p>
        <button class="start-btn" @click="handleStart">Start Update</button>
        <p v-if="error" class="panel-error">{{ error }}</p>
      </div>

      <div class="panel-status" v-if="isRunning">
        <span class="live-dot" />
        <span class="mode-label">{{ mode }} mode</span>
        <button class="cancel-btn" @click="cancel">Cancel</button>
      </div>

      <div class="panel-counts" v-if="tasks.length > 0">
        <span v-if="counts.done" class="count-done">&#10003; {{ counts.done }}</span>
        <span v-if="counts.skipped" class="count-skipped">&#9198; {{ counts.skipped }}</span>
        <span v-if="counts.error" class="count-error">&#10005; {{ counts.error }}</span>
        <span class="count-pending">{{ counts.idle + counts.running }} queued</span>
      </div>

      <div class="task-list" ref="taskListRef">
        <TaskCard
          v-for="task in visibleTasks"
          :key="task.id"
          :task="task"
          @skip="skip"
          @open="handleOpenTask"
        />
        <div v-if="hiddenCount > 0" class="more-indicator">
          +{{ hiddenCount }} more queued
        </div>
      </div>

      <div class="panel-empty" v-if="!isRunning && tasks.length === 0 && !error">
        Click "Start Update" to discover and process new commits.
      </div>
    </aside>
  </Transition>

  <Teleport to="body">
    <TaskConfirmDialog
      v-if="dialogTask"
      :task="dialogTask"
      :mode="dialogMode"
      @confirm="handleConfirm"
      @follow-up="handleFollowUp"
      @accept="handleAccept"
      @skip="handleSkipConfirm"
      @cancel="cancel"
      @close="handleDialogClose"
    />
  </Teleport>
</template>

<style scoped>
.update-panel {
  width: 380px;
  background: var(--bg-sidebar);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.panel-header h3 {
  margin: 0;
  font-size: 15px;
  color: var(--text-heading);
}

.panel-close {
  background: none;
  border: none;
  font-size: 20px;
  color: var(--text-disabled);
  cursor: pointer;
}

.panel-close:hover { color: var(--text-secondary); }

.panel-controls {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mode-switch {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  padding: 3px;
  background: var(--bg-surface-alt);
  border: 1px solid var(--border);
  border-radius: 9px;
  isolation: isolate;
}

.switch-thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: calc(50% - 3px);
  height: calc(100% - 6px);
  background: var(--accent);
  border-radius: 6px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25), 0 0 0 0.5px rgba(255, 255, 255, 0.06) inset;
  transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1);
  z-index: 0;
}

.switch-thumb.manual {
  transform: translateX(100%);
}

.mode-switch button {
  position: relative;
  z-index: 1;
  background: transparent;
  border: none;
  padding: 7px 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  transition: color 0.2s ease;
  letter-spacing: 0.01em;
}

.mode-switch button:hover:not(.active) {
  color: var(--text-primary);
}

.mode-switch button.active {
  color: #fff;
}

.mode-switch button:focus-visible {
  outline: none;
}

.mode-switch:focus-within {
  box-shadow: 0 0 0 2px var(--accent);
}

.mode-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-secondary);
  min-height: 17px;
  transition: color 0.2s;
}

.start-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}

.start-btn:hover { opacity: 0.9; }

.panel-error {
  font-size: 13px;
  color: var(--color-red);
  margin: 0;
}

.panel-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--border);
}

.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-green);
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.mode-label {
  font-size: 12px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  flex: 1;
}

.cancel-btn {
  font-size: 12px;
  padding: 3px 10px;
  border: 1px solid var(--color-red);
  border-radius: 4px;
  background: none;
  color: var(--color-red);
  cursor: pointer;
}

.cancel-btn:hover { background: var(--color-red); color: #fff; }

.task-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.panel-empty {
  padding: 40px 20px;
  text-align: center;
  font-size: 13px;
  color: var(--text-disabled);
}

.panel-counts {
  display: flex;
  gap: 12px;
  padding: 8px 20px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.panel-counts .count-done { color: var(--color-green); }
.panel-counts .count-skipped { color: var(--color-orange); }
.panel-counts .count-error { color: var(--color-red); }
.panel-counts .count-pending { margin-left: auto; color: var(--text-disabled); }

.more-indicator {
  padding: 10px 14px;
  text-align: center;
  font-size: 12px;
  color: var(--text-disabled);
  border: 1px dashed var(--border);
  border-radius: 8px;
  margin-top: 4px;
}

.panel-slide-enter-active,
.panel-slide-leave-active {
  transition: transform 0.25s ease, opacity 0.25s ease;
}

.panel-slide-enter-from,
.panel-slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
</style>
