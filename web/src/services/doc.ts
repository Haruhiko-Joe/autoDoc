import type { TopGraph, SubGraph, FlowsData, GraphEdge, GraphNode } from '../types'

const API = '/api'
const JSON_HEADERS = { 'Content-Type': 'application/json' }

function apiUrl(path: string, params?: Record<string, string>): string {
  const query = new URLSearchParams(params).toString()
  return `${API}${path}${query ? `?${query}` : ''}`
}

function buildDocUrl(filePath: string, project: string): string {
  return apiUrl(`/doc/${filePath}`, { project })
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.clone().json() as { error?: string }
    if (data.error) return data.error
  } catch {
    // Response was not JSON; fall through to text.
  }

  const text = await res.text()
  return text || fallback
}

async function requestJson<T>(url: string, init: RequestInit | undefined, fallback: string): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(await errorMessage(res, fallback))
  return res.json()
}

async function requestText(url: string, fallback: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(await errorMessage(res, fallback))
  return res.text()
}

async function postJson<T>(url: string, body?: unknown, fallback = 'Request failed'): Promise<T> {
  const init = {
    method: 'POST',
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  }
  return requestJson<T>(url, init, fallback)
}

async function postVoid(url: string, body?: unknown, fallback = 'Request failed'): Promise<void> {
  await postJson<unknown>(url, body, fallback)
  return
}

export async function fetchTopGraph(project: string): Promise<TopGraph> {
  const url = buildDocUrl('top.json', project)
  return requestJson<TopGraph>(url, undefined, 'Failed to load top graph')
}

export async function fetchSubGraph(project: string, ref: string): Promise<SubGraph> {
  const name = ref.split('/').pop()
  return requestJson<SubGraph>(buildDocUrl(`${ref}/${name}.json`, project), undefined, 'Failed to load subgraph')
}

export async function fetchPage(project: string, ref: string): Promise<string> {
  const url = buildDocUrl(`${ref}.md`, project)
  return requestText(url, 'Failed to load page')
}

export async function fetchFlows(project: string): Promise<FlowsData> {
  const url = buildDocUrl('flows.json', project)
  return requestJson<FlowsData>(url, undefined, 'Failed to load flows')
}

export interface NodeProgress {
  nodeId: string
  status: 'pending' | 'decomposing' | 'writing' | 'checking' | 'awaiting-review' | 'done' | 'error'
}

export interface Progress {
  phase: 'scaffold' | 'processing' | 'awaiting-review' | 'assembling' | 'flows' | 'idle'
  counts: Record<string, number>
  nodes: NodeProgress[]
  paused: boolean
}

export type AgentBackend = 'claude' | 'codex'
export type AgentRole = 'scaffold' | 'decomposer' | 'writer' | 'checker' | 'flowAnalyzer'
export type AgentBackends = Record<AgentRole, AgentBackend>
export type DecompositionReviewMode = 'off' | 'all'

export interface RunConfig {
  maxConcurrency: number
  agentBackends: AgentBackends
  language: 'zh' | 'en'
  decompositionReview: DecompositionReviewMode
  checkerEnabled: boolean
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
  const data = await requestJson<{ projects?: ProjectListEntry[] }>(
    `${API}/projects`,
    undefined,
    'Failed to load projects',
  )
  return data.projects ?? []
}

export async function startRun(
  gitUrl: string,
  maxConcurrency?: number,
  agentBackends?: Partial<AgentBackends>,
  language?: 'zh' | 'en',
  decompositionReview?: DecompositionReviewMode,
  checkerEnabled?: boolean,
): Promise<{ ok: boolean; project: string }> {
  const body = { gitUrl, maxConcurrency, agentBackends, language, decompositionReview, checkerEnabled }
  return postJson(`${API}/run`, body, 'Failed to start')
}

export interface DecompositionReviewItem {
  id: string
  kind: 'scaffold' | 'decomposer'
  nodeId: string
  title: string
  description: string
  nodes: GraphNode[]
}

export async function fetchDecompositionReviews(project: string): Promise<DecompositionReviewItem[]> {
  const data = await requestJson<{ reviews?: DecompositionReviewItem[] }>(
    apiUrl('/decomposition-reviews', { project }),
    undefined,
    'Failed to load decomposition reviews',
  )
  return data.reviews ?? []
}

export async function updateDecompositionReview(project: string, id: string, nodes: GraphNode[]): Promise<void> {
  const body = { project, id, nodes }
  await postVoid(`${API}/decomposition-review/update`, body, 'Failed to update review')
}

export async function approveDecompositionReview(project: string, id: string): Promise<void> {
  const body = { project, id }
  await postVoid(`${API}/decomposition-review/approve`, body, 'Failed to approve review')
}

export async function rejectDecompositionReview(project: string, id: string, feedback: string): Promise<void> {
  const body = { project, id, feedback }
  await postVoid(`${API}/decomposition-review/reject`, body, 'Failed to request changes')
}

export async function continueRun(): Promise<void> {
  await postVoid(`${API}/run/continue`, undefined, 'Failed to continue run')
  return
}

export async function pausePipeline(): Promise<void> {
  await postVoid(`${API}/pause`, undefined, 'Failed to pause')
  return
}

export async function resumePipeline(): Promise<void> {
  await postVoid(`${API}/resume`, undefined, 'Failed to resume')
  return
}

export async function retryErrors(): Promise<void> {
  await postVoid(`${API}/retry-errors`, undefined, 'Failed to retry errors')
  return
}

export async function fetchStatus(): Promise<RunStatus> {
  const url = `${API}/status`
  return requestJson<RunStatus>(url, undefined, 'Failed to load status')
}

export function subscribeStatus(onStatus: (status: RunStatus) => void): () => void {
  const es = new EventSource(`${API}/status/stream`)
  es.onmessage = (e) => {
    const rawData = e.data
    try {
      onStatus(JSON.parse(rawData))
    } catch {
      return
    }
  }
  return () => es.close()
}

// ─── Doc editing ───

export async function createNode(
  project: string, parentNodeId: string,
  node: GraphNode, initialContent?: string,
): Promise<SubGraph> {
  const body = { project, parentNodeId, node, initialContent }
  return postJson(`${API}/doc/create-node`, body, 'Failed to create node')
}

export async function updateNode(
  project: string, parentNodeId: string, nodeName: string,
  patch: { name?: string; description?: string; codeScope?: string[]; edges?: GraphEdge[] },
): Promise<SubGraph> {
  const body = { project, parentNodeId, nodeName, patch }
  return postJson(`${API}/doc/update-node`, body, 'Failed to update node')
}

export async function deleteNode(
  project: string, parentNodeId: string, nodeName: string,
): Promise<SubGraph> {
  const body = { project, parentNodeId, nodeName }
  return postJson(`${API}/doc/delete-node`, body, 'Failed to delete node')
}

export async function updatePage(
  project: string, nodeId: string, ref: string, content: string,
): Promise<{ ok: boolean }> {
  const body = { project, nodeId, ref, content }
  return postJson(`${API}/doc/update-page`, body, 'Failed to update page')
}

export async function patchPage(
  project: string, nodeId: string, ref: string,
  edits: { old_text: string; new_text: string }[],
): Promise<{ appliedCount: number }> {
  const body = { project, nodeId, ref, edits }
  return postJson(`${API}/doc/patch-page`, body, 'Failed to patch page')
}

export interface DocGitHead {
  sha: string
  shortSha: string
  date: string
  message: string
}

export interface DocGitStatus {
  dirty: boolean
  fileCount: number
  files: string[]
  head?: DocGitHead
}

export interface DocGitCommitResult {
  committed: boolean
  sha?: string
  shortSha?: string
}

export interface DocBlameLine {
  line: number
  sha: string
  shortSha: string
  author: string
  time: string
  message: string
  content: string
}

export async function fetchDocGitStatus(project: string): Promise<DocGitStatus> {
  return requestJson<DocGitStatus>(apiUrl('/doc-git/status', { project }), undefined, 'Failed to load doc git status')
}

export async function commitDocGit(project: string, message: string): Promise<DocGitCommitResult> {
  const body = { project, message }
  return postJson(`${API}/doc-git/commit`, body, 'Failed to commit docs')
}

export async function fetchDocBlame(project: string, nodeId: string): Promise<{ lines: DocBlameLine[] }> {
  return requestJson(apiUrl('/doc-git/blame', { project, nodeId }), undefined, 'Failed to load blame')
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
  type: 'queue' | 'task-start' | 'task-text-delta' | 'task-awaiting-review' | 'task-done' | 'task-error' | 'task-skipped' | 'awaiting-confirm' | 'cancelled' | 'finished'
  taskId?: string
  tasks?: UpdateTaskItem[]
  delta?: string
  markdown?: string
  error?: string
  status?: UpdateTaskStatus
}

export async function startUpdateRun(
  project: string, mode: 'auto' | 'manual' = 'auto',
): Promise<{ ok: boolean; tasks: UpdateTaskItem[] }> {
  const body = { project, mode }
  return postJson(`${API}/update/start`, body, 'Failed to start update')
}

export async function continueUpdateRun(project: string, extraInstructions?: string): Promise<void> {
  const body = { project, extraInstructions }
  await postVoid(`${API}/update/continue`, body, 'Failed to continue')
}

export async function skipUpdateTask(project: string, taskId: string): Promise<void> {
  const body = { project, taskId }
  await postVoid(`${API}/update/skip`, body, 'Failed to skip')
}

export async function cancelUpdateRun(project: string): Promise<void> {
  const body = { project }
  await postVoid(`${API}/update/cancel`, body, 'Failed to cancel')
}

export async function acceptUpdateTask(project: string, taskId: string): Promise<void> {
  const body = { project, taskId }
  await postVoid(`${API}/update/task/accept`, body, 'Failed to accept task')
}

export async function chatOnUpdateTask(project: string, taskId: string, prompt: string): Promise<void> {
  const body = { project, taskId, prompt }
  await postVoid(`${API}/update/task/chat`, body, 'Failed to send follow-up')
}

export function subscribeUpdateStream(
  project: string, onEvent: (event: UpdateEvent) => void,
): () => void {
  const es = new EventSource(apiUrl('/update/stream', { project }))
  es.onmessage = (e) => {
    const rawData = e.data
    try {
      onEvent(JSON.parse(rawData))
    } catch {
      return
    }
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
  try {
    const data = await requestJson<{ results?: SearchResult[] }>(
      apiUrl('/search', { project, q: query }),
      undefined,
      'Failed to search modules',
    )
    return data.results ?? []
  } catch {
    return []
  }
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
  return requestJson<KnowledgeGetResponse>(apiUrl('/knowledge', { project }), undefined, 'Failed to load knowledge')
}

export interface KnowledgeTurnResponse {
  sessionId?: string
  draft: string
  status: 'needs-input' | 'ready'
  question: string
  completionReason: string
}

export async function knowledgeStart(
  project: string,
  userMessage: string,
  language: 'zh' | 'en',
  agentBackend: AgentBackend,
): Promise<KnowledgeTurnResponse & { sessionId: string }> {
  const body = { project, userMessage, language, agentBackend }
  return postJson(`${API}/knowledge/start`, body, 'Failed to start knowledge session')
}

export class KnowledgeSessionExpiredError extends Error {
  readonly code = 'SESSION_EXPIRED'

  constructor() {
    super('Knowledge session expired. Start a new one.')
  }
}

export async function knowledgeMessage(
  sessionId: string,
  userReply: string,
): Promise<KnowledgeTurnResponse> {
  const res = await fetch(`${API}/knowledge/message`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId, userReply }),
  })
  if (!res.ok) {
    try {
      const data = await res.clone().json() as { error?: string; code?: string }
      if (data.code === 'SESSION_EXPIRED') throw new KnowledgeSessionExpiredError()
    } catch (e) {
      if (e instanceof KnowledgeSessionExpiredError) throw e
    }
    throw new Error(await errorMessage(res, 'Failed to send knowledge message'))
  }
  return res.json()
}

export async function knowledgeFinalize(
  sessionId: string,
  project: string,
): Promise<{ ok: boolean; path: string }> {
  const body = { sessionId, project }
  return postJson(`${API}/knowledge/finalize`, body, 'Failed to finalize knowledge')
}

export async function knowledgeDiscard(project: string): Promise<void> {
  const body = { project }
  await postVoid(`${API}/knowledge/discard`, body, 'Failed to discard knowledge draft')
}

export async function sendChat(
  messages: ChatMessage[],
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const res = await fetch(`${API}/chat`, {
    method: 'POST',
    headers: JSON_HEADERS,
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
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          onEvent(JSON.parse(line.slice(6)))
        } catch { /* ignore malformed */ }
      }
    }
  }
}
