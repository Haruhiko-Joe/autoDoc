import type { TopGraph, SubGraph, FlowsData } from '../types'

const API = '/api'

function buildDocUrl(filePath: string, project: string): string {
  return `${API}/doc/${filePath}?project=${encodeURIComponent(project)}`
}

export async function fetchTopGraph(project: string): Promise<TopGraph> {
  const res = await fetch(buildDocUrl('top.json', project))
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchSubGraph(project: string, ref: string): Promise<SubGraph> {
  const name = ref.split('/').pop()
  const res = await fetch(buildDocUrl(`${ref}/${name}.json`, project))
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchPage(project: string, ref: string): Promise<string> {
  const res = await fetch(buildDocUrl(`${ref}.md`, project))
  if (!res.ok) throw new Error(await res.text())
  return res.text()
}

export async function fetchFlows(project: string): Promise<FlowsData> {
  const res = await fetch(buildDocUrl('flows.json', project))
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export interface NodeProgress {
  nodeId: string
  status: 'pending' | 'decomposing' | 'writing' | 'checking' | 'done' | 'error'
}

export interface Progress {
  phase: 'scaffold' | 'processing' | 'assembling' | 'flows' | 'idle'
  counts: Record<string, number>
  nodes: NodeProgress[]
  paused: boolean
}

export type AgentBackend = 'claude' | 'codex'
export type AgentRole = 'scaffold' | 'decomposer' | 'writer' | 'checker' | 'flowAnalyzer'
export type AgentBackends = Record<AgentRole, AgentBackend>

export interface RunConfig {
  maxConcurrency: number
  agentBackends: AgentBackends
  language: 'zh' | 'en'
}

export type RunPhase = 'idle' | 'cloning' | 'awaiting-knowledge' | 'running' | 'done' | 'error'

export interface RunStatus {
  phase: RunPhase
  paused?: boolean
  gitUrl?: string
  currentProject?: string
  repoDir?: string
  docDir?: string
  message?: string
  progress?: Progress
  config?: RunConfig
}

export interface ProjectListEntry {
  name: string
  hasDoc: boolean
  sourceUrl: string
  branch: string
  head: string
  lastUpdated: string
}

export async function fetchProjects(): Promise<ProjectListEntry[]> {
  const res = await fetch(`${API}/projects`)
  if (!res.ok) throw new Error(await res.text())
  const data = await res.json() as { projects?: ProjectListEntry[] }
  return data.projects ?? []
}

export async function startRun(
  gitUrl: string,
  maxConcurrency?: number,
  agentBackends?: Partial<AgentBackends>,
  language?: 'zh' | 'en',
): Promise<{ ok: boolean; project: string }> {
  const res = await fetch(`${API}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gitUrl, maxConcurrency, agentBackends, language }),
  })
  if (!res.ok) {
    const data = await res.json()
    throw new Error(data.error ?? 'Failed to start')
  }
  return res.json()
}

export async function continueRun(): Promise<void> {
  const res = await fetch(`${API}/run/continue`, { method: 'POST' })
  if (!res.ok) {
    const data = await res.json()
    throw new Error(data.error ?? 'Failed to continue run')
  }
}

export async function pausePipeline(): Promise<void> {
  const res = await fetch(`${API}/pause`, { method: 'POST' })
  if (!res.ok) {
    const data = await res.json()
    throw new Error(data.error ?? 'Failed to pause')
  }
}

export async function resumePipeline(): Promise<void> {
  const res = await fetch(`${API}/resume`, { method: 'POST' })
  if (!res.ok) {
    const data = await res.json()
    throw new Error(data.error ?? 'Failed to resume')
  }
}

export async function retryErrors(): Promise<void> {
  const res = await fetch(`${API}/retry-errors`, { method: 'POST' })
  if (!res.ok) {
    const data = await res.json()
    throw new Error(data.error ?? 'Failed to retry errors')
  }
}

export async function fetchStatus(): Promise<RunStatus> {
  const res = await fetch(`${API}/status`)
  return res.json()
}

export function subscribeStatus(onStatus: (status: RunStatus) => void): () => void {
  const es = new EventSource(`${API}/status/stream`)
  es.onmessage = (e) => {
    try { onStatus(JSON.parse(e.data)) } catch { /* ignore */ }
  }
  return () => es.close()
}

// ─── Doc editing ───

export async function createNode(
  project: string, parentNodeId: string, baseVersion: number,
  node: import('../types').GraphNode, initialContent?: string,
): Promise<import('../types').SubGraph> {
  const res = await fetch(`${API}/doc/create-node`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, parentNodeId, baseVersion, node, initialContent }),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to create node')
  return res.json()
}

export async function updateNode(
  project: string, parentNodeId: string, nodeName: string, baseVersion: number,
  patch: { name?: string; description?: string; codeScope?: string[]; edges?: import('../types').GraphEdge[] },
): Promise<import('../types').SubGraph> {
  const res = await fetch(`${API}/doc/update-node`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, parentNodeId, nodeName, baseVersion, patch }),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to update node')
  return res.json()
}

export async function deleteNode(
  project: string, parentNodeId: string, nodeName: string, baseVersion: number,
): Promise<import('../types').SubGraph> {
  const res = await fetch(`${API}/doc/delete-node`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, parentNodeId, nodeName, baseVersion }),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to delete node')
  return res.json()
}

export async function updatePage(
  project: string, nodeId: string, ref: string, baseVersion: number, content: string,
): Promise<{ version: number; graphVersion: number }> {
  const res = await fetch(`${API}/doc/update-page`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, nodeId, ref, baseVersion, content }),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to update page')
  return res.json()
}

export async function patchPage(
  project: string, nodeId: string, ref: string, baseVersion: number,
  edits: { old_text: string; new_text: string }[],
): Promise<{ version: number; graphVersion: number; appliedCount: number }> {
  const res = await fetch(`${API}/doc/patch-page`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, nodeId, ref, baseVersion, edits }),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to patch page')
  return res.json()
}

export async function revertDoc(
  project: string, relPath: string, toVersion: number, baseVersion: number,
): Promise<{ relPath: string; newVersion: number }> {
  const res = await fetch(`${API}/doc/revert`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, relPath, toVersion, baseVersion }),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to revert')
  return res.json()
}

export async function fetchHistory(
  project: string, relPath: string,
): Promise<{ versions: { version: number; ts: string; source?: { type: string; ref?: string }; summary?: string }[] }> {
  const res = await fetch(`${API}/history?project=${encodeURIComponent(project)}&relPath=${encodeURIComponent(relPath)}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchHistoryDiff(
  project: string, relPath: string, versionA: number, versionB: number,
): Promise<{ contentA: string; contentB: string }> {
  const res = await fetch(`${API}/history/diff`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, relPath, versionA, versionB }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// ─── Update ───

export type UpdateTaskStatus = 'idle' | 'running' | 'awaiting-review' | 'done' | 'skipped' | 'error'

export interface UpdateTaskItem {
  id: string
  sha: string
  title: string
  body?: string
  filesChanged: number
  changedFiles?: string[]
  status: UpdateTaskStatus
  markdown?: string
  error?: string
  userInstructions?: string
  confirmed?: boolean
  sessionId?: string
}

export interface UpdateEvent {
  type: 'queue' | 'task-start' | 'task-text-delta' | 'task-awaiting-review' | 'task-done' | 'task-error' | 'task-skipped' | 'awaiting-confirm' | 'finished'
  taskId?: string
  tasks?: UpdateTaskItem[]
  delta?: string
  markdown?: string
  error?: string
}

export async function startUpdateRun(
  project: string, mode: 'auto' | 'manual' = 'auto',
): Promise<{ ok: boolean; tasks: UpdateTaskItem[] }> {
  const res = await fetch(`${API}/update/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, mode }),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to start update')
  return res.json()
}

export async function continueUpdateRun(project: string, extraInstructions?: string): Promise<void> {
  const res = await fetch(`${API}/update/continue`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, extraInstructions }),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to continue')
}

export async function skipUpdateTask(project: string, taskId: string): Promise<void> {
  const res = await fetch(`${API}/update/skip`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, taskId }),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to skip')
}

export async function cancelUpdateRun(project: string): Promise<void> {
  const res = await fetch(`${API}/update/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project }),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to cancel')
}

export async function acceptUpdateTask(project: string, taskId: string): Promise<void> {
  const res = await fetch(`${API}/update/task/accept`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, taskId }),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to accept task')
}

export async function chatOnUpdateTask(project: string, taskId: string, prompt: string): Promise<void> {
  const res = await fetch(`${API}/update/task/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, taskId, prompt }),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to send follow-up')
}

export function subscribeUpdateStream(
  project: string, onEvent: (event: UpdateEvent) => void,
): () => void {
  const es = new EventSource(`${API}/update/stream?project=${encodeURIComponent(project)}`)
  es.onmessage = (e) => {
    try { onEvent(JSON.parse(e.data)) } catch { /* ignore */ }
  }
  return () => es.close()
}

// ─── Search ───

export interface SearchResult {
  name: string
  description: string
  path: string
  type: 'graph' | 'page'
}

export async function searchModules(project: string, query: string): Promise<SearchResult[]> {
  const res = await fetch(`${API}/search?project=${encodeURIComponent(project)}&q=${encodeURIComponent(query)}`)
  if (!res.ok) return []
  const data = await res.json() as { results: SearchResult[] }
  return data.results ?? []
}

// ─── Chat ───

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatEvent {
  type: 'text' | 'done' | 'error'
  text?: string
}

// ─── Knowledge ───

export interface KnowledgeGetResponse {
  exists: boolean
  content?: string
  draftExists?: boolean
}

export async function knowledgeGet(project: string): Promise<KnowledgeGetResponse> {
  const res = await fetch(`${API}/knowledge?project=${encodeURIComponent(project)}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export interface KnowledgeTurnResponse {
  sessionId?: string
  draft: string
  question: string
}

export async function knowledgeStart(
  project: string,
  userMessage: string,
  language: 'zh' | 'en',
  agentBackend: AgentBackend,
): Promise<KnowledgeTurnResponse & { sessionId: string }> {
  const res = await fetch(`${API}/knowledge/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, userMessage, language, agentBackend }),
  })
  if (!res.ok) {
    const data = await res.json()
    throw new Error(data.error ?? 'Failed to start knowledge session')
  }
  return res.json()
}

export class KnowledgeSessionExpiredError extends Error {
  readonly code = 'SESSION_EXPIRED'
  constructor() { super('Knowledge session expired. Start a new one.') }
}

export async function knowledgeMessage(
  sessionId: string,
  userReply: string,
): Promise<KnowledgeTurnResponse> {
  const res = await fetch(`${API}/knowledge/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, userReply }),
  })
  if (!res.ok) {
    const data = await res.json() as { error?: string; code?: string }
    if (data.code === 'SESSION_EXPIRED') throw new KnowledgeSessionExpiredError()
    throw new Error(data.error ?? 'Failed to send knowledge message')
  }
  return res.json()
}

export async function knowledgeFinalize(
  sessionId: string,
  project: string,
): Promise<{ ok: boolean; path: string }> {
  const res = await fetch(`${API}/knowledge/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, project }),
  })
  if (!res.ok) {
    const data = await res.json()
    throw new Error(data.error ?? 'Failed to finalize knowledge')
  }
  return res.json()
}

export async function knowledgeDiscard(project: string): Promise<void> {
  const res = await fetch(`${API}/knowledge/discard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project }),
  })
  if (!res.ok) {
    const data = await res.json()
    throw new Error(data.error ?? 'Failed to discard knowledge draft')
  }
}

export async function sendChat(
  messages: ChatMessage[],
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const res = await fetch(`${API}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  })

  if (!res.ok || !res.body) throw new Error(await res.text())

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()!

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          onEvent(JSON.parse(line.slice(6)))
        } catch { /* ignore malformed */ }
      }
    }
  }
}
