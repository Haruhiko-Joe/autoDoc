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
  const data = { target: target.value, type: edgeType.value, description: description.value }
  emit('submit', data)
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
.dialog { --dialog-width: 420px; }

.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 13px; font-weight: 500; color: var(--text-secondary); }
.field-value { font-size: 14px; color: var(--text-primary); font-weight: 500; }

.field-input {
  padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-control);
  background: var(--bg-body); color: var(--text-primary); font-size: 14px; font-family: inherit;
}

.field-input:focus { outline: none; border-color: var(--accent); }

.dialog-enter-active, .dialog-leave-active { transition: opacity 0.15s; }
.dialog-enter-active .dialog, .dialog-leave-active .dialog { transition: transform 0.15s; }
.dialog-enter-from, .dialog-leave-to { opacity: 0; }
.dialog-enter-from .dialog { transform: scale(0.95); }
</style>
