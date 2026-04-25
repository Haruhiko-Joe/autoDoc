<script setup lang="ts">
import type { TreeNode } from './DocTree.vue'

const props = defineProps<{
  node: TreeNode
  depth: number
}>()

const emit = defineEmits<{
  toggle: [node: TreeNode]
  navigate: [node: TreeNode]
}>()
</script>

<template>
  <div class="tree-item">
    <div
      class="tree-row"
      :style="{ paddingLeft: depth * 16 + 12 + 'px' }"
      @click="emit('toggle', node)"
    >
      <span class="tree-chevron">
        <template v-if="node.type === 'graph'">{{ node.expanded ? '&#x25BE;' : '&#x25B8;' }}</template>
      </span>
      <span class="tree-label" @click.stop="emit('navigate', node)">{{ node.name }}</span>
      <span v-if="node.loading" class="tree-spin">&#x27F3;</span>
      <span v-else-if="node.status" class="tree-status" :class="node.status">
        <template v-if="node.status === 'done'">&#x2713;</template>
        <template v-else-if="node.status === 'error'">&#x2717;</template>
        <template v-else-if="node.status === 'pending'">&#x25CB;</template>
        <template v-else>&#x25CF;</template>
      </span>
    </div>
    <div v-if="node.expanded && node.children" class="tree-children">
      <TreeItem
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        @toggle="(n) => emit('toggle', n)"
        @navigate="(n) => emit('navigate', n)"
      />
    </div>
  </div>
</template>

<style scoped>
.tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
  transition: background 0.1s, color 0.1s;
  line-height: 1.4;
}

.tree-row:hover {
  background: var(--bg-surface-hover);
  color: var(--accent);
}

.tree-chevron {
  width: 14px;
  font-size: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
  text-align: center;
}

.tree-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.tree-label:hover {
  text-decoration: underline;
}

.tree-spin {
  color: var(--text-disabled);
  font-size: 12px;
  animation: spin 1s linear infinite;
}

.tree-status {
  font-size: 10px;
  flex-shrink: 0;
  width: 14px;
  text-align: center;
}

.tree-status.done { color: var(--color-green); }
.tree-status.error { color: var(--color-red); }
.tree-status.pending { color: var(--text-disabled); }
.tree-status.decomposing,
.tree-status.writing,
.tree-status.checking,
.tree-status.awaiting-review { color: var(--accent); animation: pulse 1.5s infinite; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
