import { z } from "zod"

// --- Edge ---

export const EdgeType = z.enum([
  "calls",
  "depends",
  "data-flow",
  "event",
  "extends",
  "composes",
])

export const GraphEdge = z.object({
  target: z.string(),
  type: EdgeType,
  description: z.string(),
})

// --- Scaffold (top graph) ---

export const ScaffoldEdge = z.object({
  type: EdgeType,
  target: z.string(),
  description: z.string(),
})

export const ScaffoldNode = z.object({
  name: z.string(),
  description: z.string(),
  codeScope: z.array(z.string()),
  edges: z.array(ScaffoldEdge),
})

export const RawTopGraph = z.object({
  description: z.string(),
  nodes: z.array(ScaffoldNode),
})

export const TopGraph = z.object({
  status: z.enum(["awaiting-review", "done"]),
  retryCount: z.number().int().min(0),
  sessionId: z.string(),
  description: z.string(),
  nodes: z.array(ScaffoldNode),
})

// --- Decomposer (sub graph) ---

export const GraphNodeChild = z.object({
  type: z.enum(["graph", "page"]),
  ref: z.string(),
})

export const GraphNode = z.object({
  name: z.string(),
  description: z.string(),
  edges: z.array(GraphEdge),
  codeScope: z.array(z.string()),
  child: GraphNodeChild,
})

export const RawGraph = z.object({
  nodes: z.array(GraphNode),
})

export const PageTaskStatus = z.enum([
  "pending",
  "writing",
  "done",
  "error",
])

export const PageTask = z.object({
  status: PageTaskStatus,
  retryCount: z.number().int().min(0),
})

export const GraphStatus = z.enum([
  "pending",
  "decomposing",
  "writing",
  "checking",
  "awaiting-review",
  "done",
  "error",
])

export const Graph = z.object({
  status: GraphStatus,
  retryCount: z.number().int().min(0),
  sessionId: z.string(),
  description: z.string(),
  codeScope: z.array(z.string()),
  nodes: z.array(GraphNode),
  decomposerSessionId: z.string().optional(),
  checkerSessionId: z.string().optional(),
  pageTasks: z.record(z.string(), PageTask).optional(),
})

// --- Writer ---

export const WriterOutput = z.object({
  content: z.string(),
})

// --- FlowAnalyzer ---

export const FlowParticipant = z.object({
  name: z.string(),
  description: z.string(),
  docPath: z.string(),
})

export const FlowStep = z.object({
  from: z.string(),
  to: z.string(),
  action: z.string(),
  detail: z.string(),
  edgeType: EdgeType,
  codeRef: z.string(),
})

export const FlowCase = z.object({
  title: z.string(),
  description: z.string(),
  participants: z.array(FlowParticipant),
  steps: z.array(FlowStep),
})

export const FlowAnalyzerOutput = z.object({
  flows: z.array(FlowCase),
})

// --- Knowledge Elicitor ---

export const KnowledgeTurn = z.object({
  draft: z.string(),
  status: z.enum(["needs-input", "ready"]),
  question: z.string(),
  completionReason: z.string(),
})

// --- AncestorContext (passed to Decomposer & Writer from depth ≥ 2) ---

export const AncestorSibling = z.object({
  name: z.string(),
  description: z.string(),
})

export const AncestorEdge = z.object({
  source: z.string(),
  target: z.string(),
  type: EdgeType,
  description: z.string(),
})

export const AncestorLayer = z.object({
  name: z.string(),
  depth: z.number().int().min(0),
  siblings: z.array(AncestorSibling),
  edges: z.array(AncestorEdge),
})

export const AncestorContext = z.object({
  path: z.array(z.string()),
  ancestors: z.array(AncestorLayer),
})

// --- PR Updater ---

// PR updater emits a free-form Markdown report, streamed to the client.
export type PrUpdaterDelta = (chunk: string) => void

// --- Checker ---

export const CheckerIssueType = z.enum([
  "broken-target",
  "empty-content",
  "invalid-path",
])

export const CheckerSeverity = z.enum(["error", "warning"])

export const CheckerIssue = z.object({
  files: z.array(z.string()),
  type: CheckerIssueType,
  description: z.string(),
  severity: CheckerSeverity,
})

export const CheckerOutput = z.object({
  passed: z.boolean(),
  issues: z.array(CheckerIssue),
})

export interface AgentResult<T = string> {
  sessionId: string
  result: T
}

export interface IChecker {
  getSessionId(): string | undefined
  restore(sessionId: string, workpath: string): void
  run(prompt: string, workpath: string): Promise<AgentResult<CheckerOutput>>
  continue(prompt: string): Promise<AgentResult<CheckerOutput>>
}

export interface IScaffold {
  getSessionId(): string | undefined
  restore(sessionId: string, workpath: string): void
  run(prompt: string, workpath: string): Promise<AgentResult<RawTopGraph>>
  continue(prompt: string): Promise<AgentResult<RawTopGraph>>
}

export interface IDecomposer {
  getSessionId(): string | undefined
  restore(sessionId: string, workpath: string): void
  run(prompt: string, workpath: string): Promise<AgentResult<RawGraph>>
  continue(prompt: string): Promise<AgentResult<RawGraph>>
}

export interface IWriter {
  getSessionId(): string | undefined
  restore(sessionId: string, workpath: string): void
  run(prompt: string, workpath: string): Promise<AgentResult<WriterOutput>>
  continue(prompt: string): Promise<AgentResult<WriterOutput>>
}

export interface IFlowAnalyzer {
  getSessionId(): string | undefined
  restore(sessionId: string, workpath: string): void
  run(prompt: string, workpath: string): Promise<AgentResult<FlowAnalyzerOutput>>
  continue(prompt: string): Promise<AgentResult<FlowAnalyzerOutput>>
}

export interface IKnowledge {
  getSessionId(): string | undefined
  restore(sessionId: string, workpath: string): void
  run(prompt: string, workpath: string): Promise<AgentResult<KnowledgeTurn>>
  continue(prompt: string): Promise<AgentResult<KnowledgeTurn>>
}

export interface IPrUpdater {
  getSessionId(): string | undefined
  restore(sessionId: string, workpath: string): void
  run(prompt: string, workpath: string, onDelta?: PrUpdaterDelta): Promise<AgentResult<string>>
  continue(prompt: string, onDelta?: PrUpdaterDelta): Promise<AgentResult<string>>
}

// --- Inferred types ---

export type EdgeType = z.infer<typeof EdgeType>
export type GraphEdge = z.infer<typeof GraphEdge>
export type ScaffoldEdge = z.infer<typeof ScaffoldEdge>
export type ScaffoldNode = z.infer<typeof ScaffoldNode>
export type RawTopGraph = z.infer<typeof RawTopGraph>
export type TopGraph = z.infer<typeof TopGraph>
export type GraphNodeChild = z.infer<typeof GraphNodeChild>
export type GraphNode = z.infer<typeof GraphNode>
export type RawGraph = z.infer<typeof RawGraph>
export type PageTaskStatus = z.infer<typeof PageTaskStatus>
export type PageTask = z.infer<typeof PageTask>
export type GraphStatus = z.infer<typeof GraphStatus>
export type Graph = z.infer<typeof Graph>
export type CheckerIssueType = z.infer<typeof CheckerIssueType>
export type CheckerSeverity = z.infer<typeof CheckerSeverity>
export type CheckerIssue = z.infer<typeof CheckerIssue>
export type CheckerOutput = z.infer<typeof CheckerOutput>
export type WriterOutput = z.infer<typeof WriterOutput>
export type AncestorSibling = z.infer<typeof AncestorSibling>
export type AncestorEdge = z.infer<typeof AncestorEdge>
export type AncestorLayer = z.infer<typeof AncestorLayer>
export type AncestorContext = z.infer<typeof AncestorContext>
export type FlowParticipant = z.infer<typeof FlowParticipant>
export type FlowStep = z.infer<typeof FlowStep>
export type FlowCase = z.infer<typeof FlowCase>
export type FlowAnalyzerOutput = z.infer<typeof FlowAnalyzerOutput>
export type KnowledgeTurn = z.infer<typeof KnowledgeTurn>

export type Language = "zh" | "en";

// ─── Utility ───

export function toOutputSchema(zodType: z.ZodType): Record<string, unknown> {
  const { $schema, ...schema } = z.toJSONSchema(zodType) as Record<string, unknown>;
  return schema;
}

export function resolveInstruction(instruction: string, language: Language): string {
  return instruction.replaceAll("{{LANGUAGE}}", language === "en" ? "English" : "Chinese");
}
