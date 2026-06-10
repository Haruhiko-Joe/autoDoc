<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  nodeNames: string[]
  selectedNames: string[] | null
}>()

const emit = defineEmits<{
  'update:selectedNames': [selectedNames: string[] | null]
}>()

const selectedSet = computed(() =>
  props.selectedNames === null ? null : new Set(props.selectedNames),
)

const selectedCount = computed(() => {
  if (props.selectedNames === null) return props.nodeNames.length
  return props.nodeNames.filter((name) => selectedSet.value?.has(name)).length
})

const summary = computed(() =>
  props.selectedNames === null ? 'All' : `${selectedCount.value}/${props.nodeNames.length}`,
)

function toggleNode(name: string, checked: boolean) {
  const current = props.selectedNames === null
    ? props.nodeNames
    : props.nodeNames.filter((item) => selectedSet.value?.has(item))
  const next = new Set(current)

  if (checked) next.add(name)
  else next.delete(name)

  const selectedNames = props.nodeNames.filter((item) => next.has(item))
  emit('update:selectedNames', selectedNames.length === props.nodeNames.length ? null : selectedNames)
}

function onNodeChange(name: string, event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return

  toggleNode(name, event.target.checked)
}
</script>

<template>
  <details
    v-if="nodeNames.length"
    class="node-filter"
    @click.stop
    @keydown.stop
    @pointerdown.stop
    @wheel.stop
  >
    <summary class="node-filter-trigger" title="Filter nodes">
      <span>Nodes</span>
      <strong>{{ summary }}</strong>
    </summary>
    <div class="node-filter-panel">
      <div class="node-filter-actions">
        <button type="button" @click.prevent="emit('update:selectedNames', null)">All</button>
        <button type="button" @click.prevent="emit('update:selectedNames', [])">None</button>
      </div>
      <label v-for="name in nodeNames" :key="name" class="node-filter-option">
        <input
          type="checkbox"
          :checked="selectedNames === null || selectedSet?.has(name)"
          @change="onNodeChange(name, $event)"
        />
        <span>{{ name }}</span>
      </label>
    </div>
  </details>
</template>

<style scoped>
.node-filter {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: var(--z-canvas-ui);
  color: var(--text-primary);
  font-size: 12px;
}

.node-filter-trigger {
  height: 32px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border: 1px solid var(--border-card);
  border-radius: var(--radius-control);
  background: var(--bg-surface);
  box-shadow: var(--shadow-soft);
  cursor: pointer;
  list-style: none;
  user-select: none;
}

.node-filter-trigger::-webkit-details-marker {
  display: none;
}

.node-filter-trigger strong {
  color: var(--accent);
  font-weight: 700;
}

.node-filter-panel {
  width: 240px;
  max-width: calc(100vw - 32px);
  max-height: min(320px, calc(100dvh - 180px));
  box-sizing: border-box;
  margin-top: 8px;
  padding: 8px;
  overflow: auto;
  border: 1px solid var(--border-card);
  border-radius: var(--radius-card);
  background: var(--bg-surface);
  box-shadow: var(--shadow-panel);
}

.node-filter-actions {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}

.node-filter-actions button {
  flex: 1;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg-surface-alt);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}

.node-filter-actions button:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.node-filter-option {
  min-height: 28px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 4px;
  border-radius: var(--radius-control);
  cursor: pointer;
}

.node-filter-option:hover {
  background: var(--bg-surface-alt);
}

.node-filter-option input {
  flex: 0 0 auto;
}

.node-filter-option span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
