const BASE = '/api/bench'

export interface Project {
  name: string
  sourceUrl: string
  hasDoc: boolean
}

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch('/api/projects')
  const data = await res.json()
  return data.projects ?? []
}

export interface RunSummary {
  project: string
  itemCount: number
  createdAt: string
  providers: string[]
}

export interface SourceEvidence {
  filePath: string
  lineHint: string
  summary: string
}

export interface ScoringPoint {
  point: string
  weight: number
}

export interface QaItem {
  id: string
  generator: string
  question: string
  goldAnswer: string
  scoringPoints: ScoringPoint[]
  category: string
  requiredConcepts: string[]
  sourceEvidence: SourceEvidence[]
  batchIndex: number
  itemIndex: number
}

export interface RunDetail {
  schemaVersion: number
  project: string
  repoPath: string
  language: string
  createdAt: string
  updatedAt: string
  countPerProvider: number
  batchSize: number
  providers: string[]
  items: QaItem[]
}

export interface TaskState {
  status: 'running' | 'done' | 'error'
  log: string[]
  error?: string
}

export interface GenerateStatusResponse {
  tasks: Record<string, TaskState>
}

export async function fetchRuns(project?: string): Promise<RunSummary[]> {
  const params = project ? `?project=${encodeURIComponent(project)}` : ''
  const res = await fetch(`${BASE}/runs${params}`)
  return res.json()
}

export async function fetchRunDetail(project: string): Promise<RunDetail> {
  const res = await fetch(`${BASE}/runs/${encodeURIComponent(project)}`)
  return res.json()
}

export async function startGenerate(opts: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${BASE}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  return res.json()
}

export async function fetchGenerateStatus(): Promise<GenerateStatusResponse> {
  const res = await fetch(`${BASE}/generate/status`)
  return res.json()
}
