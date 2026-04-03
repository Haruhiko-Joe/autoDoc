import type { TopGraph, SubGraph } from '../types'

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

export interface NodeProgress {
  nodeId: string
  status: 'pending' | 'decomposing' | 'writing' | 'checking' | 'done' | 'error'
}

export interface Progress {
  phase: 'scaffold' | 'processing' | 'idle'
  counts: Record<string, number>
  nodes: NodeProgress[]
}

export interface RunStatus {
  phase: 'idle' | 'running' | 'done' | 'error'
  repoPath?: string
  currentProject?: string
  message?: string
  progress?: Progress
}

export async function fetchProjects(): Promise<string[]> {
  const res = await fetch(`${API}/projects`)
  if (!res.ok) throw new Error(await res.text())
  const data = await res.json() as { projects?: string[] }
  return data.projects ?? []
}

export async function startRun(repoPath: string): Promise<void> {
  const res = await fetch(`${API}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath }),
  })
  if (!res.ok) {
    const data = await res.json()
    throw new Error(data.error ?? 'Failed to start')
  }
}

export async function fetchStatus(): Promise<RunStatus> {
  const res = await fetch(`${API}/status`)
  return res.json()
}

// ─── Chat ───

export interface ChatEvent {
  type: 'session' | 'text' | 'done' | 'error'
  text?: string
  sessionId?: string
}

export async function sendChat(
  message: string,
  chatSessionId: string | null,
  agentSessionId: string | null,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const res = await fetch(`${API}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      ...(chatSessionId ? { chatSessionId } : {}),
      ...(agentSessionId ? { agentSessionId } : {}),
    }),
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
