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

export interface RunStatus {
  phase: 'idle' | 'running' | 'done' | 'error'
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
): Promise<{ ok: boolean }> {
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
