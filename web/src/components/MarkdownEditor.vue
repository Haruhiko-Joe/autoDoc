<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { EditorView, GutterMarker, gutter, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import type { DocBlameLine } from '../services/doc'

const props = defineProps<{
  modelValue: string
  showGitInfo?: boolean
  blameLines?: DocBlameLine[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  save: []
}>()

const containerRef = ref<HTMLDivElement>()
let view: EditorView | null = null

class BlameMarker extends GutterMarker {
  private readonly label: string
  private readonly titleText: string

  constructor(label: string, title: string) {
    super()
    this.label = label
    this.titleText = title
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-blame-marker'
    el.textContent = this.label
    el.title = this.titleText
    return el
  }
}

function blameTitle(blame: DocBlameLine): string {
  const when = blame.time ? new Date(blame.time).toLocaleString() : 'working tree'
  return `${blame.author} · ${when}\n${blame.shortSha} · ${blame.message}`
}

function blameGutter() {
  const byLine = new Map((props.blameLines ?? []).map((line) => [line.line, line]))
  return gutter({
    class: 'cm-blame-gutter',
    lineMarker(editorView, line) {
      const lineNumber = editorView.state.doc.lineAt(line.from).number
      const blame = byLine.get(lineNumber)
      return blame ? new BlameMarker(blame.shortSha, blameTitle(blame)) : null
    },
  })
}

function createEditor(initialDoc = props.modelValue) {
  if (!containerRef.value) return

  const saveKeymap = keymap.of([{
    key: 'Mod-s',
    run: () => { emit('save'); return true },
  }])

  const state = EditorState.create({
    doc: initialDoc,
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
        '.cm-blame-gutter': {
          minWidth: props.showGitInfo ? '72px' : '0',
          color: 'var(--text-secondary)',
          background: 'var(--bg-surface-alt)',
          borderRight: '1px solid var(--border)',
        },
        '.cm-blame-marker': {
          display: 'inline-block',
          minWidth: '56px',
          padding: '0 8px',
          fontSize: '11px',
          color: 'var(--accent)',
          cursor: 'default',
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
      ...(props.showGitInfo ? [blameGutter()] : []),
    ],
  })

  view = new EditorView({ state, parent: containerRef.value })
}

onMounted(createEditor)

onUnmounted(() => {
  view?.destroy()
  view = null
})

watch(() => [props.showGitInfo, props.blameLines], () => {
  const current = view?.state.doc.toString() ?? props.modelValue
  view?.destroy()
  view = null
  createEditor(current)
}, { deep: true })

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
