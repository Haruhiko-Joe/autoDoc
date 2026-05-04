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
  <ChatPanel :open="chatOpen" @close="chatOpen = false" />
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { RouterView } from 'vue-router'
import ChatPanel from './components/ChatPanel.vue'
const chatOpen = ref(false)
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
  box-shadow: 0 10px 28px var(--accent-shadow);
  z-index: 1001;
  transition: background 0.2s, transform 0.2s, box-shadow 0.2s;
}

.chat-toggle:hover {
  background: var(--accent-hover);
  transform: translateY(-1px);
}

.chat-toggle.active {
  background: var(--text-secondary);
  box-shadow: var(--shadow-soft);
}
</style>
