<script setup lang="ts">
defineEmits<{
  addNode: []
  deleteSelected: []
}>()

defineProps<{
  hasSelection: boolean
}>()
</script>

<template>
  <div class="graph-toolbar">
    <button class="toolbar-btn" title="Add node" @click="$emit('addNode')">
      <span class="toolbar-icon">+</span>
    </button>
    <button
      class="toolbar-btn danger"
      title="Delete selected node"
      :disabled="!hasSelection"
      @click="$emit('deleteSelected')"
    >
      <span class="toolbar-icon">&times;</span>
    </button>
  </div>
</template>

<style scoped>
.graph-toolbar {
  position: absolute;
  top: var(--space-md);
  left: var(--space-md);
  z-index: var(--z-canvas-ui);
  display: flex;
  gap: 6px;
  background: var(--bg-surface);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-card);
  padding: 4px;
  box-shadow: var(--shadow-soft);
}

.toolbar-btn {
  width: 32px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg-surface);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
  transition: border-color 0.15s, color 0.15s;
}

.toolbar-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.toolbar-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.toolbar-btn.danger:hover:not(:disabled) {
  border-color: var(--color-red);
  color: var(--color-red);
}

.toolbar-icon {
  font-size: 18px;
  font-weight: 600;
  line-height: 1;
}
</style>
