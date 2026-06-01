import { ref, type Ref } from 'vue'
import {
  startUpdateRun, continueUpdateRun, skipUpdateTask, cancelUpdateRun,
  acceptUpdateTask, chatOnUpdateTask,
  subscribeUpdateStream, fetchUpdateStatus,
  type UpdateTaskItem, type UpdateEvent, type UpdateRunState,
} from '../services/doc'

export function useUpdateQueue(project: Ref<string>) {
  const tasks = ref<UpdateTaskItem[]>([])
  const mode = ref<'auto' | 'manual'>('auto')
  const isRunning = ref(false)
  const awaitingConfirmTaskId = ref<string | null>(null)
  const awaitingReviewTaskId = ref<string | null>(null)
  const error = ref('')

  let unsub: (() => void) | null = null

  function applyState(state: UpdateRunState | null) {
    if (!state) {
      tasks.value = []
      isRunning.value = false
      awaitingConfirmTaskId.value = null
      awaitingReviewTaskId.value = null
      return
    }

    tasks.value = state.tasks
    mode.value = state.mode
    isRunning.value = state.running

    const current = state.tasks[state.currentIndex]
    awaitingConfirmTaskId.value = state.awaitingConfirm ? current?.id ?? null : null
    awaitingReviewTaskId.value = state.awaitingReview ? current?.id ?? null : null
  }

  async function restore() {
    const currentProject = project.value
    error.value = ''
    unsub?.()
    unsub = null
    const result = await fetchUpdateStatus(currentProject)
    if (project.value !== currentProject) return

    applyState(result.state)
    if (result.state?.running) {
      unsub = subscribeUpdateStream(currentProject, handleEvent)
    }
  }

  function handleEvent(event: UpdateEvent) {
    const eventType = event.type

    if (eventType === 'queue' && event.tasks) {
      tasks.value = event.tasks
    } else if (eventType === 'task-start' && event.taskId) {
      const t = tasks.value.find(t => t.id === event.taskId)
      if (t) {
        // Keep prior markdown when re-running via chat follow-up (status was awaiting-review);
        // only clear it for a fresh first run.
        if (t.status !== 'awaiting-review') t.markdown = ''
        t.status = 'running'
      }
      awaitingConfirmTaskId.value = null
      awaitingReviewTaskId.value = null
    } else if (eventType === 'task-text-delta' && event.taskId) {
      const t = tasks.value.find(t => t.id === event.taskId)
      if (t && event.delta) t.markdown = (t.markdown ?? '') + event.delta
    } else if (eventType === 'task-awaiting-review' && event.taskId) {
      const t = tasks.value.find(t => t.id === event.taskId)
      if (t) {
        t.status = 'awaiting-review'
        if (event.markdown !== undefined) t.markdown = event.markdown
      }
      awaitingReviewTaskId.value = event.taskId
    } else if (eventType === 'task-done' && event.taskId) {
      const t = tasks.value.find(t => t.id === event.taskId)
      if (t) { t.status = 'done'; if (event.markdown !== undefined) t.markdown = event.markdown }
      if (awaitingReviewTaskId.value === event.taskId) awaitingReviewTaskId.value = null
    } else if (eventType === 'task-error' && event.taskId) {
      const t = tasks.value.find(t => t.id === event.taskId)
      const nextStatus = event.status ?? 'error'
      if (t) { t.status = nextStatus; t.error = event.error }
      if (nextStatus === 'awaiting-review') {
        awaitingReviewTaskId.value = event.taskId
      } else {
        isRunning.value = false
        awaitingConfirmTaskId.value = null
        awaitingReviewTaskId.value = null
      }
    } else if (eventType === 'task-skipped' && event.taskId) {
      const t = tasks.value.find(t => t.id === event.taskId)
      if (t) t.status = 'skipped'
    } else if (eventType === 'awaiting-confirm' && event.taskId) {
      awaitingConfirmTaskId.value = event.taskId
    } else if (eventType === 'finished' || eventType === 'cancelled') {
      isRunning.value = false
      awaitingConfirmTaskId.value = null
      awaitingReviewTaskId.value = null
    }
  }

  async function start(m: 'auto' | 'manual') {
    error.value = ''
    mode.value = m
    unsub?.()
    unsub = subscribeUpdateStream(project.value, handleEvent)
    try {
      const result = await startUpdateRun(project.value, m)
      if (tasks.value.length === 0) tasks.value = result.tasks
      isRunning.value = true
    } catch (e) {
      unsub?.()
      unsub = null
      const message = e instanceof Error ? e.message : 'Failed to start'
      if (/already running/i.test(message)) {
        await restore().catch(() => {})
        if (tasks.value.length > 0) return
      }
      error.value = message
    }
  }

  async function skip(taskId: string) {
    const currentProject = project.value
    try { await skipUpdateTask(currentProject, taskId) } catch { /* ignore */ }
  }

  async function continueNext(extraInstructions?: string) {
    awaitingConfirmTaskId.value = null
    try { await continueUpdateRun(project.value, extraInstructions) } catch { /* ignore */ }
  }

  async function acceptTask(taskId: string) {
    const currentProject = project.value
    try { await acceptUpdateTask(currentProject, taskId) } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to accept'
    }
  }

  async function sendFollowUp(taskId: string, prompt: string) {
    const currentProject = project.value
    try { await chatOnUpdateTask(currentProject, taskId, prompt) } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to send follow-up'
    }
  }

  async function cancel() {
    try { await cancelUpdateRun(project.value) } catch { /* ignore */ }
    isRunning.value = false
    awaitingConfirmTaskId.value = null
    awaitingReviewTaskId.value = null
    unsub?.()
    unsub = null
  }

  function dispose() {
    unsub?.()
    unsub = null
  }

  return {
    tasks, mode, isRunning,
    awaitingConfirmTaskId, awaitingReviewTaskId,
    error,
    restore, start, skip, continueNext, acceptTask, sendFollowUp, cancel, dispose,
  }
}
