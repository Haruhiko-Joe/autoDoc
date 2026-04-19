<script setup lang="ts">
defineProps<{
  visible: boolean
  contentA: string
  contentB: string
  versionA: number
  versionB: number
}>()

defineEmits<{ close: [] }>()
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div v-if="visible" class="dialog-overlay" @click.self="$emit('close')">
        <div class="dialog">
          <div class="dialog-header">
            <h3>Compare v{{ versionA }} &harr; v{{ versionB }}</h3>
            <button class="dialog-close" @click="$emit('close')">&times;</button>
          </div>
          <div class="diff-body">
            <div class="diff-col">
              <div class="diff-col-header">v{{ versionA }}</div>
              <pre class="diff-col-content">{{ contentA }}</pre>
            </div>
            <div class="diff-col">
              <div class="diff-col-header">v{{ versionB }}</div>
              <pre class="diff-col-content">{{ contentB }}</pre>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dialog-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
}

.dialog {
  background: var(--bg-surface);
  border: 1px solid var(--border-card);
  border-radius: 12px;
  width: 90vw;
  max-width: 960px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 16px 48px rgba(0,0,0,0.3);
}

.dialog-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border);
}

.dialog-header h3 { margin: 0; font-size: 15px; color: var(--text-heading); }

.dialog-close {
  background: none; border: none; font-size: 20px;
  color: var(--text-disabled); cursor: pointer;
}

.diff-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.diff-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.diff-col:first-child {
  border-right: 1px solid var(--border);
}

.diff-col-header {
  padding: 8px 16px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-surface-alt);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.diff-col-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  font-size: 12px;
  line-height: 1.6;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-primary);
}

.dialog-enter-active, .dialog-leave-active { transition: opacity 0.15s; }
.dialog-enter-from, .dialog-leave-to { opacity: 0; }
</style>