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
  top: 12px;
  right: 12px;
  z-index: 10;
  display: flex;
  gap: 6px;
  background: var(--bg-surface);
  border: 1px solid var(--border-card);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}

.toolbar-btn {
  width: 32px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 6px;
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
