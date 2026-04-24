import type { Graph, GraphStatus, Language } from "../../agents/schemas/schema.js";

export interface NodeProgress {
  nodeId: string
  status: GraphStatus
}

export interface Progress {
  phase: "scaffold" | "processing" | "assembling" | "flows" | "idle"
  counts: Record<string, number>
  nodes: NodeProgress[]
  paused: boolean
}

export type ArrangerTask =
  | { kind: "graph"; nodeId: string; graph: Graph }
  | { kind: "page"; nodeId: string; ref: string; graph: Graph };

export type AgentBackend = "claude" | "codex";
export type AgentRole = "scaffold" | "decomposer" | "writer" | "checker" | "flowAnalyzer";
export type AgentBackends = Record<AgentRole, AgentBackend>;

export interface ArrangerOptions {
  maxConcurrency?: number
  agentBackend?: AgentBackend
  agentBackends?: Partial<AgentBackends>
  language?: Language
}

export interface ArrangerConfig {
  maxConcurrency: number
  agentBackends: AgentBackends
  language: Language
}
