<script setup lang="ts">
defineProps<{
  summary?: string
  impact?: 'none' | 'minor' | 'structural'
}>()
</script>

<template>
  <div class="mutation-summary">
    <span v-if="impact" class="impact-badge" :class="impact">{{ impact }}</span>
    <span class="summary-text">{{ summary || 'No changes' }}</span>
  </div>
</template>

<style scoped>
.mutation-summary {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
  padding-top: 8px;
}

.impact-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  flex-shrink: 0;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.impact-badge.none { background: var(--bg-surface-alt); color: var(--text-disabled); }
.impact-badge.minor { background: #dbeafe; color: #2563eb; }
.impact-badge.structural { background: #fef3c7; color: #d97706; }

.summary-text {
  flex: 1;
  min-width: 0;
}
</style>
