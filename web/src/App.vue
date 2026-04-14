<template>
  <RouterView />
  <button class="chat-toggle" :class="{ active: chatOpen }" @click="chatOpen = !chatOpen">
    <svg v-if="!chatOpen" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </button>
  <ChatPanel
    :open="chatOpen"
    :project="currentProject"
    :current-path="currentDocPath"
    @close="chatOpen = false"
    @navigate="onNavigate"
  />
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import ChatPanel from './components/ChatPanel.vue'
import { isSafeRefPath } from './services/doc'

const chatOpen = ref(false)
const route = useRoute()
const router = useRouter()

const currentProject = computed(() => {
  const p = route.params.project
  return typeof p === 'string' ? p : Array.isArray(p) ? p[0] : undefined
})

// When the user is viewing a specific graph/page the route param `path`
// carries the slash-separated node path. Home and Flows routes don't set it.
const currentDocPath = computed(() => {
  const p = route.params.path
  if (typeof p === 'string' && p.length > 0) return p
  if (Array.isArray(p) && p.length > 0) return p.join('/')
  return undefined
})

function onNavigate(path: string) {
  const project = currentProject.value
  if (!project) return
  // Defense in depth: the emitting component already validates, but citation
  // paths originate from the LLM so double-check before routing — a bad ref
  // would otherwise flow into /api/doc/... requests.
  if (!isSafeRefPath(path)) return
  // Empty path = project root.
  if (!path) {
    router.push({ name: 'project', params: { project } })
    return
  }
  router.push({ name: 'doc', params: { project, path } })
}
</script>

<style scoped>
.chat-toggle {
  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 48px;
  height: 48px;
  border: none;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 16px var(--accent-shadow);
  z-index: 1001;
  transition: background 0.2s, transform 0.2s;
}

.chat-toggle:hover {
  background: var(--accent-hover);
  transform: scale(1.05);
}

.chat-toggle.active {
  background: var(--text-secondary);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
}
</style>
