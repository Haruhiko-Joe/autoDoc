<script setup lang="ts">
import { ref, watch } from 'vue'
import type { GraphEdge, EdgeType } from '../types'

const props = defineProps<{
  visible: boolean
  edge?: GraphEdge
  sourceNode?: string
  targetOptions: string[]
  prefillTarget?: string
}>()

const emit = defineEmits<{
  close: []
  submit: [data: { target: string; type: EdgeType; description: string }]
}>()

const EDGE_TYPES: EdgeType[] = ['calls', 'depends', 'data-flow', 'event', 'extends', 'composes']

const target = ref('')
const edgeType = ref<EdgeType>('calls')
const description = ref('')

const isEdit = () => !!props.edge

watch(() => props.visible, (v) => {
  if (!v) return
  if (props.edge) {
    target.value = props.edge.target
    edgeType.value = props.edge.type
    description.value = props.edge.description
  } else {
    target.value = props.prefillTarget ?? ''
    edgeType.value = 'calls'
    description.value = ''
  }
})

function onSubmit() {
  emit('submit', { target: target.value, type: edgeType.value, description: description.value })
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div v-if="visible" class="dialog-overlay" @click.self="$emit('close')">
        <div class="dialog">
          <div class="dialog-header">
            <h3>{{ isEdit() ? 'Edit Edge' : 'New Edge' }}</h3>
            <button class="dialog-close" @click="$emit('close')">&times;</button>
          </div>
          <form class="dialog-body" @submit.prevent="onSubmit">
            <div class="field" v-if="sourceNode">
              <span class="field-label">From</span>
              <span class="field-value">{{ sourceNode }}</span>
            </div>
            <label class="field">
              <span class="field-label">To</span>
              <select v-model="target" class="field-input" required>
                <option value="" disabled>Select target...</option>
                <option v-for="opt in targetOptions" :key="opt" :value="opt">{{ opt }}</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">Type</span>
              <select v-model="edgeType" class="field-input">
                <option v-for="t in EDGE_TYPES" :key="t" :value="t">{{ t }}</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">Description</span>
              <input v-model="description" class="field-input" required />
            </label>
            <div class="dialog-actions">
              <button type="button" class="btn-secondary" @click="$emit('close')">Cancel</button>
              <button type="submit" class="btn-primary">{{ isEdit() ? 'Save' : 'Add' }}</button>
            </div>
          </form>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog {
  background: var(--bg-surface);
  border: 1px solid var(--border-card);
  border-radius: 12px;
  width: 420px;
  max-width: 90vw;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px 0;
}

.dialog-header h3 { margin: 0; font-size: 17px; color: var(--text-heading); }

.dialog-close {
  background: none; border: none; font-size: 22px;
  color: var(--text-disabled); cursor: pointer; padding: 0 4px; line-height: 1;
}

.dialog-close:hover { color: var(--text-secondary); }

.dialog-body {
  padding: 20px 24px 24px;
  display: flex; flex-direction: column; gap: 16px;
}

.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 13px; font-weight: 500; color: var(--text-secondary); }
.field-value { font-size: 14px; color: var(--text-primary); font-weight: 500; }

.field-input {
  padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-body); color: var(--text-primary); font-size: 14px; font-family: inherit;
}

.field-input:focus { outline: none; border-color: var(--accent); }

.dialog-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }

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
