<script setup lang="ts">
import { ref, watch } from 'vue'
import { marked } from 'marked'

const props = defineProps<{
  content: string
}>()

const html = ref('')

function render(md: string) {
  html.value = marked.parse(md) as string
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
  color: #333;
}

.markdown-body :deep(h1) {
  font-size: 28px;
  border-bottom: 1px solid #eee;
  padding-bottom: 8px;
  margin: 24px 0 16px;
}

.markdown-body :deep(h2) {
  font-size: 22px;
  margin: 20px 0 12px;
}

.markdown-body :deep(h3) {
  font-size: 18px;
  margin: 16px 0 8px;
}

.markdown-body :deep(pre) {
  background: #f6f8fa;
  padding: 16px;
  border-radius: 6px;
  overflow-x: auto;
}

.markdown-body :deep(code) {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
  font-size: 13px;
}

.markdown-body :deep(p code) {
  background: #f0f0f0;
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
  border: 1px solid #ddd;
  padding: 8px 12px;
  text-align: left;
}

.markdown-body :deep(th) {
  background: #f6f8fa;
  font-weight: 600;
}

.markdown-body :deep(blockquote) {
  border-left: 4px solid #ddd;
  padding-left: 16px;
  color: #666;
  margin: 16px 0;
}
</style>
