<script setup lang="ts">
import { EDGE_STYLES } from '../services/edgeStyles'

const entries = Object.entries(EDGE_STYLES)
</script>

<template>
  <div class="edge-legend">
    <div v-for="[type, visual] in entries" :key="type" class="legend-item">
      <svg width="40" height="16" viewBox="0 0 40 16">
        <line
          x1="0"
          y1="8"
          x2="30"
          y2="8"
          :stroke="visual.stroke"
          :stroke-width="type === 'data-flow' ? 3 : 1.5"
          :stroke-dasharray="visual.lineDash?.join(',') ?? 'none'"
        />
        <polygon points="30,4 38,8 30,12" :fill="visual.stroke" />
      </svg>
      <span class="legend-label">{{ type }}</span>
    </div>
  </div>
</template>

<style scoped>
.edge-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  padding: 12px 16px;
  background: #fafafa;
  border-radius: 8px;
  border: 1px solid #eee;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.legend-label {
  font-size: 12px;
  color: #666;
}
</style>
