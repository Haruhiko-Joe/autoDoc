<script setup lang="ts">
import { ref, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { DocBlameLine } from '../services/doc'

const props = defineProps<{
  content: string
  showGitInfo?: boolean
  blameLines?: DocBlameLine[]
}>()

const html = ref('')
const blocks = ref<Array<{ html: string; startLine: number; endLine: number; blame?: DocBlameLine }>>([])

function render(md: string) {
  const parsed = marked.parse(md, { async: false })
  html.value = DOMPurify.sanitize(parsed)
  blocks.value = buildBlocks(md)
}

function renderFragment(md: string): string {
  const parsed = marked.parse(md, { async: false })
  return DOMPurify.sanitize(parsed)
}

function blameForRange(startLine: number, endLine: number): DocBlameLine | undefined {
  const lines = props.blameLines ?? []
  return lines.find((line) =>
    line.line >= startLine && line.line <= endLine && line.content.trim().length > 0,
  ) ?? lines.find((line) => line.line >= startLine && line.line <= endLine)
}

function buildBlocks(md: string): Array<{ html: string; startLine: number; endLine: number; blame?: DocBlameLine }> {
  const tokens = marked.lexer(md)
  const result: Array<{ html: string; startLine: number; endLine: number; blame?: DocBlameLine }> = []
  let line = 1

  for (const token of tokens) {
    const raw = token.raw
    const lineCount = Math.max(1, raw.split('\n').length - (raw.endsWith('\n') ? 1 : 0))
    const startLine = line
    const endLine = line + lineCount - 1
    result.push({
      html: renderFragment(raw),
      startLine,
      endLine,
      blame: blameForRange(startLine, endLine),
    })
    line = endLine + 1
  }

  return result
}

function blameTitle(blame?: DocBlameLine): string {
  if (!blame) return 'No git info'
  const when = blame.time ? new Date(blame.time).toLocaleString() : 'working tree'
  return `${blame.author} · ${when}\n${blame.shortSha} · ${blame.message}`
}

render(props.content)
watch(() => [props.content, props.blameLines], () => render(props.content), { deep: true })
</script>

<template>
  <article v-if="showGitInfo" class="markdown-body blame-body">
    <section
      v-for="block in blocks"
      :key="`${block.startLine}-${block.endLine}`"
      class="blame-block"
    >
      <div class="blame-content" v-html="block.html" />
      <div class="blame-chip" :title="blameTitle(block.blame)">
        <span>{{ block.blame?.shortSha ?? 'n/a' }}</span>
        <strong>{{ block.blame?.author ?? 'Unknown' }}</strong>
      </div>
    </section>
  </article>
  <article v-else class="markdown-body" v-html="html" />
</template>

<style scoped>
.markdown-body {
  max-width: clamp(720px, 75vw, 1040px);
  margin: 0 auto;
  padding: 32px clamp(16px, 3vw, 24px);
  font-size: 15px;
  line-height: 1.75;
  color: var(--text-primary);
}

.markdown-body :deep(h1) {
  font-size: 28px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
  margin: 24px 0 16px;
  color: var(--text-heading);
}

.markdown-body :deep(h2) {
  font-size: 22px;
  margin: 20px 0 12px;
  color: var(--text-heading);
}

.markdown-body :deep(h3) {
  font-size: 18px;
  margin: 16px 0 8px;
  color: var(--text-heading);
}

.markdown-body :deep(pre) {
  background: var(--bg-code);
  padding: 16px;
  border-radius: var(--radius-card);
  overflow-x: auto;
}

.markdown-body :deep(code) {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
  font-size: 13px;
}

.markdown-body :deep(p code) {
  background: var(--bg-code-inline);
  padding: 2px 6px;
  border-radius: var(--radius-control);
}

.markdown-body :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 16px 0;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--border-strong);
  padding: 8px 12px;
  text-align: left;
}

.markdown-body :deep(th) {
  background: var(--bg-code);
  font-weight: 600;
  color: var(--text-heading);
}

.markdown-body :deep(blockquote) {
  border-left: 4px solid var(--border-strong);
  padding-left: 16px;
  color: var(--text-secondary);
  margin: 16px 0;
}

.markdown-body :deep(a) {
  color: var(--accent);
}

.blame-body {
  max-width: clamp(860px, 85vw, 1280px);
}

.blame-block {
  display: grid;
  grid-template-columns: minmax(0, 1fr) min(172px, 20%);
  gap: 18px;
  align-items: start;
  border-radius: var(--radius-card);
  padding: 2px 0;
}

.blame-block:hover {
  background: var(--bg-surface-alt);
}

.blame-content {
  min-width: 0;
}

.blame-chip {
  position: sticky;
  top: 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 8px;
  padding: 6px 8px;
  border-left: 2px solid var(--border-strong);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.25;
  cursor: default;
}

.blame-chip span {
  color: var(--accent);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.blame-chip strong {
  color: var(--text-primary);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 920px) {
  .blame-block {
    grid-template-columns: 1fr;
    gap: 2px;
  }

  .blame-chip {
    position: static;
    flex-direction: row;
    gap: 8px;
    margin: -4px 0 10px;
  }
}
</style>
