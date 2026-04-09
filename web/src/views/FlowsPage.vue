<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchFlows, fetchTopGraph } from '../services/doc'
import DocTree from '../components/DocTree.vue'
import EdgeLegend from '../components/EdgeLegend.vue'
import { EDGE_STYLES } from '../services/edgeStyles'
import type { FlowsData, FlowCase, FlowStep, TopGraph } from '../types'

const route = useRoute()
const router = useRouter()
const flowsData = ref<FlowsData | null>(null)
const topGraph = ref<TopGraph | null>(null)
const loading = ref(true)
const error = ref('')
const activeIndex = ref(0)
const expandedStep = ref<number | null>(null)

function getProject(): string {
  const p = route.params.project
  return Array.isArray(p) ? (p[0] ?? '') : (p ?? '')
}

async function load() {
  loading.value = true
  error.value = ''
  const project = getProject()
  if (!project) { error.value = 'Missing project.'; loading.value = false; return }
  try {
    const [flows, top] = await Promise.all([fetchFlows(project), fetchTopGraph(project)])
    flowsData.value = flows
    topGraph.value = top
  } catch {
    error.value = 'Failed to load flows.'
  } finally {
    loading.value = false
  }
}

onMounted(load)

const activeFlow = computed<FlowCase | null>(() =>
  flowsData.value?.flows[activeIndex.value] ?? null,
)
const participants = computed(() => activeFlow.value?.participants ?? [])
const steps = computed(() => activeFlow.value?.steps ?? [])

function colPct(name: string): number {
  const idx = participants.value.findIndex(p => p.name === name)
  if (idx < 0) return 0
  return (idx + 0.5) / participants.value.length * 100
}

function stepColor(step: FlowStep): string {
  if (step.edgeType && step.edgeType in EDGE_STYLES) {
    return EDGE_STYLES[step.edgeType as keyof typeof EDGE_STYLES].stroke
  }
  return '#64748b'
}

function arrowStyle(step: FlowStep): Record<string, string> {
  const fromPct = colPct(step.from)
  const toPct = colPct(step.to)
  const left = Math.min(fromPct, toPct)
  const width = Math.abs(toPct - fromPct)
  return { left: `${left}%`, width: `${width || 0.1}%` }
}

function isLTR(step: FlowStep): boolean {
  return colPct(step.to) >= colPct(step.from)
}

function isSelf(step: FlowStep): boolean {
  return step.from === step.to
}

function toggleStep(i: number) {
  expandedStep.value = expandedStep.value === i ? null : i
}

function goToDoc(docPath?: string) {
  if (!docPath) return
  router.push(`/${getProject()}/doc/${docPath}`)
}

function selectFlow(i: number) {
  activeIndex.value = i
  expandedStep.value = null
}
</script>

<template>
  <div class="flows-page">
    <aside class="sidebar">
      <div class="sidebar-header">
        <button class="back-btn" @click="router.push({ name: 'project', params: { project: getProject() } })">
          &larr; Back
        </button>
      </div>
      <div class="sidebar-nav" v-if="topGraph">
        <DocTree :project="getProject()" :nodes="topGraph.nodes" />
      </div>
      <div class="sidebar-footer">
        <EdgeLegend />
      </div>
    </aside>

    <main class="main-area">
      <div v-if="loading" class="status-msg">Loading&hellip;</div>
      <div v-else-if="error" class="status-msg is-error">{{ error }}</div>

      <template v-else-if="flowsData && activeFlow">
        <header class="main-header">
          <nav class="breadcrumb">
            <a @click="router.push({ name: 'project', params: { project: getProject() } })">Home</a>
            <span class="bc-sep">/</span>
            <span class="bc-current">Interaction Flows</span>
          </nav>

          <div class="flow-tabs-wrap">
            <div class="flow-tabs">
              <button
                v-for="(flow, i) in flowsData.flows" :key="i"
                class="flow-tab" :class="{ active: i === activeIndex }"
                @click="selectFlow(i)"
              >
                <span class="tab-idx">{{ i + 1 }}</span>
                {{ flow.title }}
              </button>
            </div>
          </div>

          <p class="flow-desc">{{ activeFlow.description }}</p>
        </header>

        <!-- Diagram -->
        <div class="diagram-scroll">
          <div class="diagram" :style="{ minWidth: participants.length * 152 + 48 + 'px' }">
            <!-- Participant headers -->
            <div class="p-row">
              <div class="gutter"></div>
              <div class="track p-track">
                <div
                  v-for="p in participants" :key="p.name"
                  class="p-slot"
                  :style="{ width: 100 / participants.length + '%' }"
                >
                  <div
                    class="p-card" :class="{ clickable: !!p.docPath }"
                    @click="goToDoc(p.docPath)"
                  >
                    <div class="p-name">{{ p.name }}</div>
                    <div class="p-role">{{ p.description }}</div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Steps body -->
            <div class="steps-body">
              <template v-for="(step, i) in steps" :key="i">
                <div
                  class="step-row"
                  :class="{ expanded: expandedStep === i }"
                  @click="toggleStep(i)"
                >
                  <div class="gutter">
                    <span class="step-num" :style="{ '--c': stepColor(step) }">{{ i + 1 }}</span>
                  </div>
                  <div class="track step-track">
                    <!-- Lifelines -->
                    <div
                      v-for="(p, pi) in participants" :key="'ll' + pi"
                      class="lifeline"
                      :style="{ left: colPct(p.name) + '%' }"
                    ></div>

                    <!-- Normal arrow -->
                    <template v-if="!isSelf(step)">
                      <div
                        class="arrow"
                        :class="isLTR(step) ? 'ltr' : 'rtl'"
                        :style="{ ...arrowStyle(step), '--c': stepColor(step) }"
                      >
                        <div class="arrow-shaft"></div>
                        <div class="arrow-head"></div>
                      </div>
                      <div
                        class="arrow-label"
                        :style="{ left: (colPct(step.from) + colPct(step.to)) / 2 + '%', '--c': stepColor(step) }"
                      >
                        <span class="al-text">{{ step.action }}</span>
                        <span v-if="step.edgeType" class="al-edge" :style="{ background: stepColor(step) + '18', color: stepColor(step) }">{{ step.edgeType }}</span>
                      </div>
                    </template>

                    <!-- Self arrow -->
                    <template v-else>
                      <div class="self-msg" :style="{ left: colPct(step.from) + '%', '--c': stepColor(step) }">
                        <div class="self-loop"></div>
                      </div>
                      <div
                        class="arrow-label self-label"
                        :style="{ left: colPct(step.from) + 4 + '%', '--c': stepColor(step) }"
                      >
                        <span class="al-text">{{ step.action }}</span>
                      </div>
                    </template>
                  </div>
                </div>

                <!-- Expanded detail -->
                <div v-if="expandedStep === i" class="step-detail" @click.stop>
                  <div class="sd-route">
                    <span class="sd-num" :style="{ background: stepColor(step) + '18', color: stepColor(step) }">{{ i + 1 }}</span>
                    <span class="sd-ep">{{ step.from }}</span>
                    <span class="sd-arrow">&rarr;</span>
                    <span class="sd-ep">{{ step.to }}</span>
                    <span v-if="step.edgeType" class="sd-edge" :style="{ background: stepColor(step) + '14', color: stepColor(step), borderColor: stepColor(step) + '30' }">
                      {{ step.edgeType }}
                    </span>
                  </div>
                  <p class="sd-text">{{ step.detail }}</p>
                  <code v-if="step.codeRef" class="sd-ref">{{ step.codeRef }}</code>
                </div>
              </template>
            </div>
          </div>
        </div>
      </template>
    </main>
  </div>
</template>

<style>
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=DM+Mono:ital,wght@0,400;0,500;1,400&display=swap');
</style>

<style scoped>
/* ─── Layout Shell ─── */

.flows-page {
  display: flex;
  height: 100vh;
  overflow: hidden;
  font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
  background: var(--flows-bg);
  color: var(--flows-text);
}

.sidebar {
  width: 20%;
  min-width: 200px;
  max-width: 280px;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 24px 0;
  box-sizing: border-box;
}

.sidebar-header {
  padding: 0 20px 16px;
  border-bottom: 1px solid var(--border);
}

.back-btn {
  padding: 6px 16px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--bg-surface);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
  width: 100%;
  text-align: left;
  font-family: inherit;
}

.back-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.sidebar-nav {
  flex: 1;
  padding: 8px 0;
  overflow-y: auto;
}

.sidebar-footer {
  padding: 16px 12px 0;
  border-top: 1px solid var(--border);
}

/* ─── Main Area ─── */

.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.status-msg {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 15px;
  color: var(--text-muted);
  letter-spacing: -0.01em;
}

.status-msg.is-error {
  color: var(--color-red);
}

/* ─── Header ─── */

.main-header {
  padding: 20px 28px 0;
  flex-shrink: 0;
}

.breadcrumb {
  font-size: 13px;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 2px;
}

.breadcrumb a {
  color: var(--flows-breadcrumb-link);
  cursor: pointer;
  text-decoration: none;
}

.breadcrumb a:hover {
  text-decoration: underline;
}

.bc-sep {
  margin: 0 6px;
  color: var(--flows-breadcrumb-sep);
}

.bc-current {
  color: var(--flows-text);
  font-weight: 600;
}

.flow-tabs-wrap {
  margin-bottom: 10px;
  overflow-x: auto;
  scrollbar-width: none;
}

.flow-tabs-wrap::-webkit-scrollbar {
  display: none;
}

.flow-tabs {
  display: flex;
  gap: 6px;
}

.flow-tab {
  flex-shrink: 0;
  padding: 7px 16px;
  border: 1px solid var(--flows-tab-border);
  border-radius: 999px;
  background: var(--bg-surface);
  font-size: 12px;
  font-weight: 500;
  color: var(--flows-tab-text);
  cursor: pointer;
  transition: all 0.15s ease;
  font-family: inherit;
  white-space: nowrap;
}

.flow-tab:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.flow-tab.active {
  background: var(--flows-tab-active-bg);
  border-color: var(--flows-tab-active-bg);
  color: var(--flows-tab-active-text);
}

.tab-idx {
  font-family: 'DM Mono', monospace;
  font-weight: 500;
  margin-right: 5px;
  opacity: 0.6;
}

.flow-desc {
  margin: 0 0 14px;
  font-size: 13px;
  color: var(--flows-tab-text);
  line-height: 1.55;
  max-width: 720px;
}

/* ─── Diagram ─── */

.diagram-scroll {
  flex: 1;
  overflow: auto;
  padding: 0 28px 28px;
}

.diagram {
  background: var(--flows-diagram-bg);
  border: 1px solid var(--flows-diagram-border);
  border-radius: 12px;
  overflow: hidden;
  box-shadow:
    0 1px 2px rgba(0,0,0,0.04),
    0 4px 16px rgba(0,0,0,0.03);
}

/* Shared layout primitives */

.gutter {
  width: 44px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.track {
  flex: 1;
  position: relative;
  min-width: 0;
}

/* ─── Participants ─── */

.p-row {
  display: flex;
  padding: 16px 0 12px;
  border-bottom: 1px solid var(--border-light);
  background: var(--flows-participant-bg);
  position: sticky;
  top: 0;
  z-index: 5;
}

.p-track {
  display: flex;
}

.p-slot {
  padding: 0 5px;
  box-sizing: border-box;
}

.p-card {
  text-align: center;
  padding: 10px 10px 8px;
  background: var(--flows-participant-card-bg);
  border: 1px solid var(--flows-participant-card-border);
  border-radius: 10px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  transition: all 0.2s ease;
  position: relative;
}

.p-card.clickable {
  cursor: pointer;
}

.p-card.clickable::after {
  content: '\2197';
  position: absolute;
  top: 6px;
  right: 8px;
  font-size: 10px;
  color: var(--text-muted);
  transition: color 0.15s;
}

.p-card.clickable:hover {
  border-color: var(--accent);
  box-shadow:
    0 2px 8px rgba(122, 162, 247, 0.1),
    0 0 0 1px rgba(122, 162, 247, 0.1);
  transform: translateY(-1px);
}

.p-card.clickable:hover::after {
  color: var(--accent);
}

.p-name {
  font-family: 'DM Mono', monospace;
  font-size: 12px;
  font-weight: 500;
  color: var(--flows-text);
  margin-bottom: 4px;
  letter-spacing: -0.02em;
}

.p-role {
  font-size: 10px;
  color: var(--text-muted);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ─── Steps ─── */

.steps-body {
  position: relative;
}

.step-row {
  display: flex;
  cursor: pointer;
  transition: background 0.12s ease;
  position: relative;
}

.step-row:hover {
  background: var(--flows-step-hover);
}

.step-row.expanded {
  background: var(--flows-step-expanded);
}

.step-row:not(:last-child)::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 44px;
  right: 0;
  height: 1px;
  background: var(--flows-step-divider);
}

.step-num {
  font-family: 'DM Mono', monospace;
  font-size: 11px;
  font-weight: 500;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--c) 10%, transparent);
  color: var(--c);
}

.step-track {
  height: 56px;
  overflow: visible;
}

/* ─── Lifelines ─── */

.lifeline {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  border-left: 1px dashed var(--flows-lifeline);
  transform: translateX(-0.5px);
  pointer-events: none;
}

/* ─── Arrows ─── */

.arrow {
  position: absolute;
  top: 0;
  height: 100%;
  z-index: 2;
  pointer-events: none;
}

.arrow-shaft {
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--c);
  transform: translateY(-50%);
  border-radius: 1px;
  transition: height 0.12s ease;
}

.step-row:hover .arrow-shaft {
  height: 2.5px;
}

/* Arrowhead */
.arrow.ltr .arrow-head {
  position: absolute;
  right: -1px;
  top: 50%;
  transform: translateY(-50%);
  width: 0;
  height: 0;
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  border-left: 9px solid var(--c);
}

.arrow.rtl .arrow-head {
  position: absolute;
  left: -1px;
  top: 50%;
  transform: translateY(-50%);
  width: 0;
  height: 0;
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  border-right: 9px solid var(--c);
}

/* ─── Arrow Label ─── */

.arrow-label {
  position: absolute;
  top: 7px;
  transform: translateX(-50%);
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  pointer-events: none;
}

.al-text {
  font-size: 11px;
  font-weight: 600;
  color: var(--c);
  background: var(--flows-label-bg);
  padding: 1px 7px;
  border-radius: 4px;
  letter-spacing: -0.01em;
  backdrop-filter: blur(2px);
}

.al-edge {
  font-family: 'DM Mono', monospace;
  font-size: 9px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 6px;
  letter-spacing: 0.02em;
}

/* ─── Self Arrow ─── */

.self-msg {
  position: absolute;
  top: 50%;
  transform: translate(0, -50%);
  z-index: 2;
}

.self-loop {
  width: 30px;
  height: 26px;
  border: 2px solid var(--c);
  border-left: 0;
  border-radius: 0 10px 10px 0;
  position: relative;
}

.self-loop::after {
  content: '';
  position: absolute;
  bottom: -2px;
  left: -5px;
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 7px solid var(--c);
}

.self-label {
  text-align: left;
  transform: translateX(0);
}

/* ─── Step Detail (Expanded) ─── */

.step-detail {
  padding: 14px 20px 14px 52px;
  background: var(--flows-detail-bg);
  border-top: 1px solid var(--flows-detail-border);
  border-bottom: 1px solid var(--flows-detail-border);
  animation: detailIn 0.18s ease;
  cursor: default;
}

@keyframes detailIn {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.sd-route {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.sd-num {
  font-family: 'DM Mono', monospace;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 5px;
}

.sd-ep {
  font-family: 'DM Mono', monospace;
  font-size: 13px;
  font-weight: 500;
  color: var(--flows-text);
}

.sd-arrow {
  color: var(--text-muted);
  font-size: 14px;
}

.sd-edge {
  font-family: 'DM Mono', monospace;
  font-size: 10px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 5px;
  border: 1px solid;
}

.sd-text {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--flows-text-secondary);
  line-height: 1.65;
  max-width: 640px;
}

.sd-ref {
  font-family: 'DM Mono', monospace;
  font-size: 11px;
  background: var(--flows-ref-bg);
  color: var(--flows-text-secondary);
  padding: 4px 10px;
  border-radius: 5px;
  display: inline-block;
  border: 1px solid var(--flows-ref-border);
}
</style>
