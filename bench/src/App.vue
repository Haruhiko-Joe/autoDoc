<template>
  <div class="app">
    <nav class="nav">
      <RouterLink to="/" class="nav-brand">ACCEED Benchmark</RouterLink>
      <div class="nav-links">
        <RouterLink to="/">Runs</RouterLink>
        <RouterLink to="/ablation">Ablation</RouterLink>
        <RouterLink to="/generate">Generate</RouterLink>
        <RouterLink to="/validate">Validate</RouterLink>
        <RouterLink to="/manual-validate">Manual</RouterLink>
      </div>
    </nav>
    <main class="main">
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
</script>

<style scoped>
.app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.nav {
  display: flex;
  align-items: center;
  gap: 32px;
  padding: 0 24px;
  height: 52px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  position: sticky;
  top: 0;
  z-index: 10;
}

.nav-brand {
  font-weight: 700;
  font-size: 15px;
  color: var(--text);
  text-decoration: none;
}

.nav-links {
  display: flex;
  gap: 16px;
}

.nav-links a {
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 14px;
  padding: 4px 0;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}

.nav-links a.router-link-active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

.main {
  flex: 1;
  padding: 24px;
  max-width: 1200px;
  width: 100%;
  margin: 0 auto;
}
</style>
