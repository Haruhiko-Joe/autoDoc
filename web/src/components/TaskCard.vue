<script setup lang="ts">
import type { UpdateTaskItem } from '../services/doc'

defineProps<{
  task: UpdateTaskItem
}>()

const emit = defineEmits<{
  skip: [taskId: string]
  retry: [taskId: string]
  open: [taskId: string]
}>()
</script>

<template>
  <div class="task-card" :class="task.status" @click="emit('open', task.id)">
    <div class="task-status-bar" />
    <div class="task-content">
      <div class="task-header">
        <code class="task-sha">{{ task.sha.slice(0, 7) }}</code>
        <span class="task-title" :class="{ strikethrough: task.status === 'skipped' }">{{ task.title }}</span>
        <span class="task-files">{{ task.filesChanged }}f</span>
        <button
          v-if="task.status === 'idle'"
          class="skip-btn"
          title="Skip"
          @click.stop="emit('skip', task.id)"
        >&#9654;&#9654;</button>
      </div>

      <div v-if="task.status === 'running'" class="task-shimmer" />

      <div v-if="task.status === 'error'" class="task-error" @click.stop>
        {{ task.error }}
        <button class="retry-btn" @click="emit('retry', task.id)">Retry</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.task-card {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.task-card:hover {
  border-color: var(--accent);
  background: var(--bg-surface-alt);
}

.task-status-bar {
  width: 4px;
  flex-shrink: 0;
  transition: background 0.2s;
}

.task-card.idle .task-status-bar { background: var(--text-disabled); }
.task-card.running .task-status-bar { background: var(--accent); }
.task-card.awaiting-review .task-status-bar { background: var(--color-purple, #b48cff); }
.task-card.done .task-status-bar { background: var(--color-green); }
.task-card.skipped .task-status-bar { background: var(--color-orange); }
.task-card.error .task-status-bar { background: var(--color-red); }

.task-content {
  flex: 1;
  padding: 10px 14px;
  min-width: 0;
}

.task-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-sha {
  font-size: 11px;
  color: var(--accent);
  background: var(--bg-surface-alt);
  padding: 1px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}

.task-title {
  font-size: 13px;
  color: var(--text-primary);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 0.15s;
}

.task-card:hover .task-title { color: var(--text-heading); }

.task-title.strikethrough {
  text-decoration: line-through;
  color: var(--text-disabled);
}

.task-files {
  font-size: 11px;
  color: var(--text-disabled);
  flex-shrink: 0;
}

.skip-btn {
  background: none;
  border: none;
  font-size: 10px;
  color: var(--text-disabled);
  cursor: pointer;
  padding: 2px 4px;
  flex-shrink: 0;
}

.skip-btn:hover { color: var(--color-orange); }

.task-shimmer {
  height: 3px;
  margin-top: 8px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--bg-surface-alt) 0%, var(--accent) 50%, var(--bg-surface-alt) 100%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.task-error {
  font-size: 12px;
  color: var(--color-red);
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.retry-btn {
  font-size: 11px;
  padding: 2px 10px;
  border: 1px solid var(--color-red);
  border-radius: 4px;
  background: none;
  color: var(--color-red);
  cursor: pointer;
  flex-shrink: 0;
}

.retry-btn:hover { background: var(--color-red); color: #fff; }
</style>
