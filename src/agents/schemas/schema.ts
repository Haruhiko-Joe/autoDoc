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
  status: z.literal("done"),
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

export const GraphStatus = z.enum([
  "pending",
  "decomposing",
  "writing",
  "checking",
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
  writerSessionIds: z.record(z.string(), z.string()).optional(),
})

// --- Writer ---

export const WriterOutput = z.object({
  content: z.string(),
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

// --- Checker ---

export const CheckerIssueType = z.enum([
  "missing-ref",
  "broken-target",
  "empty-content",
  "missing-section",
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

// ─── Utility ───

export function toOutputSchema(zodType: z.ZodType): Record<string, unknown> {
  const { $schema, ...schema } = z.toJSONSchema(zodType) as Record<string, unknown>;
  return schema;
}

