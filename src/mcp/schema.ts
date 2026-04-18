import { z } from "zod"

// Minimal self-contained schema for autoDoc documents.
// `.loose()` preserves arranger-only fields (sessionId, writerSessionIds, pageTasks, ...)
// so mcp can read & round-trip files produced by the backend without losing data.

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

export const TopGraph = z
  .object({
    description: z.string(),
    nodes: z.array(ScaffoldNode),
    version: z.number().int().min(0).default(0),
  })
  .loose()

export const Graph = z
  .object({
    description: z.string(),
    codeScope: z.array(z.string()),
    nodes: z.array(GraphNode),
    version: z.number().int().min(0).default(0),
    pageVersions: z.record(z.string(), z.number()).optional(),
  })
  .loose()

export type GraphEdgeT = z.infer<typeof GraphEdge>
export type ScaffoldEdgeT = z.infer<typeof ScaffoldEdge>
export type ScaffoldNodeT = z.infer<typeof ScaffoldNode>
export type GraphNodeT = z.infer<typeof GraphNode>
export type GraphNodeChildT = z.infer<typeof GraphNodeChild>
export type TopGraphT = z.infer<typeof TopGraph>
export type GraphT = z.infer<typeof Graph>