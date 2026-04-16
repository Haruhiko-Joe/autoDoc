import { readFile } from "node:fs/promises";
import path from "node:path";
import { TopGraph, Graph } from "../agents/schemas/schema.js";
import type {
  TopGraph as TopGraphType,
  Graph as GraphType,
  GraphNode as GraphNodeType,
  AncestorContext as AncestorContextType,
  AncestorLayer as AncestorLayerType,
  AncestorEdge as AncestorEdgeType,
} from "../agents/schemas/schema.js";

// ─── Types ───────────────────────────────────────────────────

export interface AffectedGraph {
  graphNodeId: string;
  graph: GraphType;
  matchedFiles: string[];
  affectedPageRefs: string[];
  /** Direct child graph nodeIds that are also in the affected set. */
  childGraphIds: string[];
}

export interface TriageResult {
  affected: Map<string, AffectedGraph>;
  unmatched: string[];
}

// ─── File I/O ────────────────────────────────────────────────

function graphFilePath(docDir: string, nodeId: string): string {
  const lastName = nodeId.split("/").pop()!;
  return path.join(docDir, nodeId, `${lastName}.json`);
}

async function readTopGraph(docDir: string): Promise<TopGraphType> {
  const raw = await readFile(path.join(docDir, "top.json"), "utf-8");
  return TopGraph.parse(JSON.parse(raw));
}

async function readGraph(docDir: string, nodeId: string): Promise<GraphType> {
  const raw = await readFile(graphFilePath(docDir, nodeId), "utf-8");
  return Graph.parse(JSON.parse(raw));
}

// ─── Scope index ─────────────────────────────────────────────

interface ScopeEntry {
  scope: string;
  graphNodeId: string;
  pageRef: string;
}

/**
 * Recursively scan the doc tree and collect every page-node's codeScope
 * entries, together with the graphNodeId that directly owns that page.
 */
async function buildScopeIndex(
  docDir: string,
  topNodes: { name: string; codeScope: string[] }[],
): Promise<{ entries: ScopeEntry[]; graphCache: Map<string, GraphType> }> {
  const entries: ScopeEntry[] = [];
  const graphCache = new Map<string, GraphType>();

  async function walk(graphNodeId: string): Promise<void> {
    let graph: GraphType;
    try {
      graph = await readGraph(docDir, graphNodeId);
    } catch {
      return; // graph file missing or corrupt — skip
    }
    graphCache.set(graphNodeId, graph);

    for (const node of graph.nodes) {
      if (node.child.type === "page") {
        for (const scope of node.codeScope) {
          entries.push({ scope, graphNodeId, pageRef: node.child.ref });
        }
      } else {
        // child.type === "graph" — recurse
        await walk(`${graphNodeId}/${node.child.ref}`);
      }
    }
  }

  for (const mod of topNodes) {
    await walk(mod.name);
  }

  // Sort entries by scope length descending so longest-prefix wins first.
  entries.sort((a, b) => b.scope.length - a.scope.length);
  return { entries, graphCache };
}

// ─── Triage ──────────────────────────────────────────────────

export async function triage(
  docDir: string,
  changedFiles: string[],
): Promise<TriageResult> {
  const top = await readTopGraph(docDir);
  const { entries, graphCache } = await buildScopeIndex(docDir, top.nodes);

  // Match each changed file to the longest-prefix scope entry.
  const matched = new Map<string, { files: Set<string>; refs: Set<string> }>();
  const unmatched: string[] = [];

  for (const file of changedFiles) {
    const hit = entries.find((e) => file.startsWith(e.scope));
    if (!hit) {
      unmatched.push(file);
      continue;
    }
    let bucket = matched.get(hit.graphNodeId);
    if (!bucket) {
      bucket = { files: new Set(), refs: new Set() };
      matched.set(hit.graphNodeId, bucket);
    }
    bucket.files.add(file);
    bucket.refs.add(hit.pageRef);
  }

  // Build AffectedGraph entries with childGraphIds for topological sorting.
  const affected = new Map<string, AffectedGraph>();

  for (const [graphNodeId, bucket] of matched) {
    const graph = graphCache.get(graphNodeId);
    if (!graph) continue;

    // Direct child graphs that are also in the affected set.
    const childGraphIds = graph.nodes
      .filter((n) => n.child.type === "graph")
      .map((n) => `${graphNodeId}/${n.child.ref}`)
      .filter((id) => matched.has(id));

    affected.set(graphNodeId, {
      graphNodeId,
      graph,
      matchedFiles: [...bucket.files],
      affectedPageRefs: [...bucket.refs],
      childGraphIds,
    });
  }

  return { affected, unmatched };
}

// ─── AncestorContext builder (standalone) ─────────────────────

export async function buildAncestorContext(
  docDir: string,
  graphNodeId: string,
): Promise<AncestorContextType> {
  const segments = graphNodeId.split("/");

  const extractEdges = (
    nodes: { name: string; edges: { target: string; type: string; description: string }[] }[],
  ): AncestorEdgeType[] =>
    nodes.flatMap((n) =>
      n.edges.map((e) => ({
        source: n.name,
        target: e.target,
        type: e.type as AncestorEdgeType["type"],
        description: e.description,
      })),
    );

  const ancestors: AncestorLayerType[] = [];

  const top = await readTopGraph(docDir);
  ancestors.push({
    name: "top",
    depth: 0,
    siblings: top.nodes.map((n) => ({ name: n.name, description: n.description })),
    edges: extractEdges(top.nodes),
  });

  for (let i = 0; i < segments.length - 1; i++) {
    const parentId = segments.slice(0, i + 1).join("/");
    const parentGraph = await readGraph(docDir, parentId);
    ancestors.push({
      name: segments[i]!,
      depth: i + 1,
      siblings: parentGraph.nodes.map((n) => ({ name: n.name, description: n.description })),
      edges: extractEdges(parentGraph.nodes),
    });
  }

  return { path: segments, ancestors };
}
