import { ref, type Ref } from 'vue'
import {
  startUpdateRun, continueUpdateRun, skipUpdateTask, cancelUpdateRun,
  acceptUpdateTask, chatOnUpdateTask,
  subscribeUpdateStream,
  type UpdateTaskItem, type UpdateEvent,
} from '../services/doc'

export function useUpdateQueue(project: Ref<string>) {
  const tasks = ref<UpdateTaskItem[]>([])
  const mode = ref<'auto' | 'manual'>('auto')
  const isRunning = ref(false)
  const awaitingConfirmTaskId = ref<string | null>(null)
  const awaitingReviewTaskId = ref<string | null>(null)
  const error = ref('')

  let unsub: (() => void) | null = null

  function handleEvent(event: UpdateEvent) {
    if (event.type === 'queue' && event.tasks) {
      tasks.value = event.tasks
    } else if (event.type === 'task-start' && event.taskId) {
      const t = tasks.value.find(t => t.id === event.taskId)
      if (t) {
        // Keep prior markdown when re-running via chat follow-up (status was awaiting-review);
        // only clear it for a fresh first run.
        if (t.status !== 'awaiting-review') t.markdown = ''
        t.status = 'running'
      }
      awaitingConfirmTaskId.value = null
      awaitingReviewTaskId.value = null
    } else if (event.type === 'task-text-delta' && event.taskId) {
      const t = tasks.value.find(t => t.id === event.taskId)
      if (t && event.delta) t.markdown = (t.markdown ?? '') + event.delta
    } else if (event.type === 'task-awaiting-review' && event.taskId) {
      const t = tasks.value.find(t => t.id === event.taskId)
      if (t) {
        t.status = 'awaiting-review'
        if (event.markdown !== undefined) t.markdown = event.markdown
      }
      awaitingReviewTaskId.value = event.taskId
    } else if (event.type === 'task-done' && event.taskId) {
      const t = tasks.value.find(t => t.id === event.taskId)
      if (t) { t.status = 'done'; if (event.markdown !== undefined) t.markdown = event.markdown }
      if (awaitingReviewTaskId.value === event.taskId) awaitingReviewTaskId.value = null
    } else if (event.type === 'task-error' && event.taskId) {
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
    } else if (event.type === 'task-skipped' && event.taskId) {
      const t = tasks.value.find(t => t.id === event.taskId)
      if (t) t.status = 'skipped'
    } else if (event.type === 'awaiting-confirm' && event.taskId) {
      awaitingConfirmTaskId.value = event.taskId
    } else if (event.type === 'finished') {
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
      error.value = e instanceof Error ? e.message : 'Failed to start'
      unsub?.()
      unsub = null
    }
  }

  async function skip(taskId: string) {
    try { await skipUpdateTask(project.value, taskId) } catch { /* ignore */ }
  }

  async function continueNext(extraInstructions?: string) {
    awaitingConfirmTaskId.value = null
    try { await continueUpdateRun(project.value, extraInstructions) } catch { /* ignore */ }
  }

  async function acceptTask(taskId: string) {
    try { await acceptUpdateTask(project.value, taskId) } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to accept'
    }
  }

  async function sendFollowUp(taskId: string, prompt: string) {
    try { await chatOnUpdateTask(project.value, taskId, prompt) } catch (e) {
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
    start, skip, continueNext, acceptTask, sendFollowUp, cancel, dispose,
  }
}
