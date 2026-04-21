<script setup lang="ts">
import { ref, watch } from 'vue'
import type { GraphNode } from '../types'

const props = defineProps<{
  visible: boolean
  node?: GraphNode
}>()

const emit = defineEmits<{
  close: []
  submit: [data: { name: string; description: string; codeScope: string[]; childType: 'graph' | 'page'; childRef: string }]
}>()

const name = ref('')
const description = ref('')
const codeScopeText = ref('')
const childType = ref<'graph' | 'page'>('page')
const childRef = ref('')

const isEdit = () => !!props.node

watch(() => props.visible, (v) => {
  if (!v) return
  if (props.node) {
    name.value = props.node.name
    description.value = props.node.description
    codeScopeText.value = props.node.codeScope.join(', ')
    childType.value = props.node.child.type
    childRef.value = props.node.child.ref
  } else {
    name.value = ''
    description.value = ''
    codeScopeText.value = ''
    childType.value = 'page'
    childRef.value = ''
  }
})

function onSubmit() {
  const codeScope = codeScopeText.value.split(',').map(s => s.trim()).filter(Boolean)
  const ref = childRef.value || name.value.replace(/\s+/g, '')
  emit('submit', { name: name.value, description: description.value, codeScope, childType: childType.value, childRef: ref })
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div v-if="visible" class="dialog-overlay" @click.self="$emit('close')">
        <div class="dialog">
          <div class="dialog-header">
            <h3>{{ isEdit() ? 'Edit Node' : 'New Node' }}</h3>
            <button class="dialog-close" @click="$emit('close')">&times;</button>
          </div>
          <form class="dialog-body" @submit.prevent="onSubmit">
            <label class="field">
              <span class="field-label">Name</span>
              <input v-model="name" class="field-input" required />
            </label>
            <label class="field">
              <span class="field-label">Description</span>
              <textarea v-model="description" class="field-input field-textarea" rows="3" required />
            </label>
            <label class="field">
              <span class="field-label">Code Scope (comma-separated)</span>
              <input v-model="codeScopeText" class="field-input" placeholder="src/module/, src/utils/helper.ts" />
            </label>
            <div class="field" v-if="!isEdit()">
              <span class="field-label">Type</span>
              <div class="radio-group">
                <label class="radio-item">
                  <input type="radio" v-model="childType" value="page" /> Page
                </label>
                <label class="radio-item">
                  <input type="radio" v-model="childType" value="graph" /> Sub-graph
                </label>
              </div>
            </div>
            <label class="field" v-if="!isEdit()">
              <span class="field-label">Ref (file/dir name, auto-generated if empty)</span>
              <input v-model="childRef" class="field-input" :placeholder="name.replace(/\s+/g, '')" />
            </label>
            <div class="dialog-actions">
              <button type="button" class="btn-secondary" @click="$emit('close')">Cancel</button>
              <button type="submit" class="btn-primary">{{ isEdit() ? 'Save' : 'Create' }}</button>
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
  width: 480px;
  max-width: 90vw;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px 0;
}

.dialog-header h3 {
  margin: 0;
  font-size: 17px;
  color: var(--text-heading);
}

.dialog-close {
  background: none;
  border: none;
  font-size: 22px;
  color: var(--text-disabled);
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.dialog-close:hover {
  color: var(--text-secondary);
}

.dialog-body {
  padding: 20px 24px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}

.field-input {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-body);
  color: var(--text-primary);
  font-size: 14px;
  font-family: inherit;
}

.field-input:focus {
  outline: none;
  border-color: var(--accent);
}

.field-textarea {
  resize: vertical;
  min-height: 60px;
}

.radio-group {
  display: flex;
  gap: 16px;
}

.radio-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  color: var(--text-primary);
  cursor: pointer;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 8px;
}

.btn-primary, .btn-secondary {
  padding: 8px 20px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
}

.btn-primary {
  background: var(--accent);
  color: #fff;
}

.btn-primary:hover {
  opacity: 0.9;
}

.btn-secondary {
  background: var(--bg-surface);
  border-color: var(--border);
  color: var(--text-primary);
}

.btn-secondary:hover {
  border-color: var(--accent);
}

.dialog-enter-active, .dialog-leave-active {
  transition: opacity 0.15s;
}

.dialog-enter-active .dialog, .dialog-leave-active .dialog {
  transition: transform 0.15s;
}

.dialog-enter-from, .dialog-leave-to {
  opacity: 0;
}

.dialog-enter-from .dialog {
  transform: scale(0.95);
}
</style>
