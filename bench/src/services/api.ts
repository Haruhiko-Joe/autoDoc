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
  runId: string
  itemCount: number
  createdAt: string
  providers: string[]
  validation?: ValidationSummary
  validations?: Record<string, ValidationSummary>
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

export interface AgentMetrics {
  inputTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
  outputTokens?: number
  reasoningOutputTokens?: number
  totalTokens?: number
  costUsd?: number
  durationMs?: number
  turns?: number
  toolCalls?: Record<string, number>
}

export interface AnswerJudgePointResult {
  point: string
  weight: number
  score: number
  covered: boolean
  rationale: string
}

export interface AnswerJudgeOutput {
  score: number
  maxScore: number
  normalizedScore: number
  verdict: 'excellent' | 'good' | 'partial' | 'poor'
  scoringPointResults: AnswerJudgePointResult[]
  judgeSummary: string
}

export interface ValidationItem {
  itemId: string
  question: string
  category: string
  status: 'done' | 'error'
  startedAt: string
  completedAt: string
  answer?: {
    provider: string
    sessionId: string
    text: string
    metrics?: AgentMetrics
  }
  judge?: {
    provider: string
    sessionId: string
    output: AnswerJudgeOutput
    metrics?: AgentMetrics
  }
  error?: string
}

export interface ValidationSummary {
  docVariant: string
  itemCount: number
  completedCount: number
  averageScore: number | null
  updatedAt: string
  answerProvider: string
  judgeProvider: string
}

export interface ValidationDetail extends ValidationSummary {
  schemaVersion: number
  project: string
  runId: string
  qaFile: string
  docRoot: string
  docProject: string
  browseScript: string
  language: string
  mode: 'doc-drill'
  createdAt: string
  results: ValidationItem[]
}

export interface RunDetail {
  schemaVersion: number
  project: string
  runId: string
  repoPath: string
  language: string
  createdAt: string
  updatedAt: string
  countPerProvider: number
  batchSize: number
  providers: string[]
  items: QaItem[]
  validation?: ValidationDetail | null
  validations?: Record<string, ValidationSummary>
}

export interface TaskState {
  status: 'running' | 'done' | 'error'
  log: string[]
  project: string
  runId: string
  docVariant?: string
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

export async function fetchRunDetailById(project: string, runId: string): Promise<RunDetail> {
  const res = await fetch(`${BASE}/runs/${encodeURIComponent(project)}/${encodeURIComponent(runId)}`)
  return res.json()
}

export async function fetchValidation(project: string, runId: string): Promise<ValidationDetail> {
  const res = await fetch(`${BASE}/validation/${encodeURIComponent(project)}/${encodeURIComponent(runId)}`)
  return res.json()
}

export async function fetchValidationByVariant(project: string, runId: string, docVariant: string): Promise<ValidationDetail> {
  const res = await fetch(`${BASE}/validation/${encodeURIComponent(project)}/${encodeURIComponent(runId)}/${encodeURIComponent(docVariant)}`)
  if (!res.ok) throw new Error(`Validation not found: ${project}/${runId}/${docVariant}`)
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

export async function startValidate(opts: Record<string, unknown>): Promise<{ ok: boolean; project: string; runId: string; error?: string }> {
  const res = await fetch(`${BASE}/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  return res.json()
}

export async function startAblation(opts: Record<string, unknown>): Promise<{ ok: boolean; project: string; runId: string; error?: string }> {
  const res = await fetch(`${BASE}/ablation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  return res.json()
}

export async function fetchValidateStatus(): Promise<GenerateStatusResponse> {
  const res = await fetch(`${BASE}/validate/status`)
  return res.json()
}

export async function fetchGenerateStatus(): Promise<GenerateStatusResponse> {
  const res = await fetch(`${BASE}/generate/status`)
  return res.json()
}

export async function fetchAblationStatus(): Promise<GenerateStatusResponse> {
  const res = await fetch(`${BASE}/ablation/status`)
  return res.json()
}
