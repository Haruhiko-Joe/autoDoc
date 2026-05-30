export type EdgeType = "calls" | "depends" | "data-flow" | "event" | "extends" | "composes"
export type GraphStatus = "pending" | "decomposing" | "writing" | "checking" | "awaiting-review" | "done" | "error"

export interface GraphEdge {
  target: string
  type: EdgeType
  description: string
  detail?: string
}

export interface GraphNodeChild {
  type: "graph" | "page"
  ref: string
}

export interface GraphNode {
  name: string
  description: string
  edges: GraphEdge[]
  codeScope: string[]
  child: GraphNodeChild
}

export interface ScaffoldNode {
  name: string
  description: string
  codeScope: string[]
  edges: { type: EdgeType; target: string; description: string; detail?: string }[]
}

export interface TopGraph {
  status: "awaiting-review" | "done"
  retryCount: 0
  sessionId: string
  description: string
  nodes: ScaffoldNode[]
}

export interface SubGraph {
  status: GraphStatus
  retryCount: number
  sessionId: string
  description: string
  codeScope: string[]
  nodes: GraphNode[]
  knowledge?: string
  paused?: boolean
}

// ─── Flow ───

export interface FlowParticipant {
  name: string
  description: string
  docPath: string
}

export interface FlowStep {
  from: string
  to: string
  action: string
  detail: string
  edgeType: EdgeType
  codeRef: string
}

export interface FlowCase {
  title: string
  description: string
  participants: FlowParticipant[]
  steps: FlowStep[]
}

export interface FlowsData {
  flows: FlowCase[]
}
