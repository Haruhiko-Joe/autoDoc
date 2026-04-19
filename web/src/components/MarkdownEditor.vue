<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'

const props = defineProps<{
  modelValue: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  save: []
}>()

const containerRef = ref<HTMLDivElement>()
let view: EditorView | null = null

function createEditor() {
  if (!containerRef.value) return

  const saveKeymap = keymap.of([{
    key: 'Mod-s',
    run: () => { emit('save'); return true },
  }])

  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      markdown(),
      saveKeymap,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          emit('update:modelValue', update.state.doc.toString())
        }
      }),
      EditorView.theme({
        '&': {
          height: '100%',
          fontSize: '14px',
        },
        '.cm-scroller': {
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
          overflow: 'auto',
        },
        '.cm-content': {
          padding: '16px 24px',
          caretColor: 'var(--accent)',
        },
        '.cm-gutters': {
          background: 'var(--bg-surface)',
          borderRight: '1px solid var(--border)',
          color: 'var(--text-disabled)',
        },
        '&.cm-focused .cm-cursor': {
          borderLeftColor: 'var(--accent)',
        },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
          background: 'var(--accent-shadow)',
        },
      }, { dark: false }),
      EditorView.baseTheme({
        '&': {
          backgroundColor: 'var(--bg-body)',
          color: 'var(--text-primary)',
        },
      }),
    ],
  })

  view = new EditorView({ state, parent: containerRef.value })
}

onMounted(createEditor)

onUnmounted(() => {
  view?.destroy()
  view = null
})

watch(() => props.modelValue, (newVal) => {
  if (!view) return
  const current = view.state.doc.toString()
  if (current !== newVal) {
    view.dispatch({
      changes: { from: 0, to: current.length, insert: newVal },
    })
  }
})
</script>

<template>
  <div ref="containerRef" class="markdown-editor" />
</template>

<style scoped>
.markdown-editor {
  width: 100%;
  height: 100%;
  overflow: hidden;
}
</style>
