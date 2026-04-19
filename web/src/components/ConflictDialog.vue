<script setup lang="ts">
defineProps<{
  visible: boolean
  localContent: string
  serverContent: string
}>()

const emit = defineEmits<{
  overwrite: []
  discard: []
  close: []
}>()
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div v-if="visible" class="dialog-overlay" @click.self="$emit('close')">
        <div class="dialog">
          <div class="dialog-header">
            <h3>Version Conflict</h3>
            <button class="dialog-close" @click="$emit('close')">&times;</button>
          </div>
          <div class="dialog-body">
            <p class="conflict-desc">The document was modified by another source. Choose how to resolve:</p>
            <div class="diff-panels">
              <div class="diff-panel">
                <div class="diff-panel-header">Your changes</div>
                <pre class="diff-panel-content">{{ localContent.slice(0, 500) }}{{ localContent.length > 500 ? '...' : '' }}</pre>
              </div>
              <div class="diff-panel">
                <div class="diff-panel-header">Server version</div>
                <pre class="diff-panel-content">{{ serverContent.slice(0, 500) }}{{ serverContent.length > 500 ? '...' : '' }}</pre>
              </div>
            </div>
            <div class="dialog-actions">
              <button class="btn-secondary" @click="$emit('discard')">Discard my changes</button>
              <button class="btn-primary" @click="$emit('overwrite')">Overwrite server</button>
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
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
}

.dialog {
  background: var(--bg-surface);
  border: 1px solid var(--border-card);
  border-radius: 12px;
  width: 720px;
  max-width: 90vw;
  max-height: 80vh;
  overflow-y: auto;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
}

.dialog-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 20px 24px 0;
}

.dialog-header h3 { margin: 0; font-size: 17px; color: var(--text-heading); }

.dialog-close {
  background: none; border: none; font-size: 22px;
  color: var(--text-disabled); cursor: pointer;
}

.dialog-body { padding: 16px 24px 24px; }

.conflict-desc { font-size: 14px; color: var(--text-secondary); margin: 0 0 16px; }

.diff-panels { display: flex; gap: 12px; margin-bottom: 20px; }

.diff-panel {
  flex: 1;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.diff-panel-header {
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-surface-alt);
  border-bottom: 1px solid var(--border);
}

.diff-panel-content {
  padding: 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-primary);
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
}

.dialog-actions {
  display: flex; justify-content: flex-end; gap: 10px;
}

.btn-primary, .btn-secondary {
  padding: 8px 20px; border-radius: 6px; font-size: 14px; font-weight: 500;
  cursor: pointer; border: 1px solid transparent;
}

.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover { opacity: 0.9; }
.btn-secondary { background: var(--bg-surface); border-color: var(--border); color: var(--text-primary); }
.btn-secondary:hover { border-color: var(--accent); }

.dialog-enter-active, .dialog-leave-active { transition: opacity 0.15s; }
.dialog-enter-from, .dialog-leave-to { opacity: 0; }
</style>
