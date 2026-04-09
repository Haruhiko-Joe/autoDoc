<script setup lang="ts">
import { ref, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const props = defineProps<{
  content: string
}>()

const html = ref('')

function render(md: string) {
  html.value = DOMPurify.sanitize(marked.parse(md) as string)
}

render(props.content)
watch(() => props.content, render)
</script>

<template>
  <article class="markdown-body" v-html="html" />
</template>

<style scoped>
.markdown-body {
  max-width: 860px;
  margin: 0 auto;
  padding: 32px 24px;
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
  border-radius: 6px;
  overflow-x: auto;
}

.markdown-body :deep(code) {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
  font-size: 13px;
}

.markdown-body :deep(p code) {
  background: var(--bg-code-inline);
  padding: 2px 6px;
  border-radius: 3px;
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
</style>
