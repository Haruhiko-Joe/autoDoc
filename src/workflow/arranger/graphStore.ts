import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Graph, GraphNode, RawGraph, RawTopGraph, TopGraph } from "../../agents/schemas/schema.js";
import { withDocProjectLock } from "../../mcp/docLock.js";
import type {
  AncestorContext as AncestorContextType,
  AncestorEdge as AncestorEdgeType,
  AncestorLayer as AncestorLayerType,
  FlowAnalyzerOutput,
  Graph as GraphType,
  GraphNode as GraphNodeType,
  GraphStatus as GraphStatusType,
  PageTask as PageTaskType,
  RawGraph as RawGraphType,
  RawTopGraph as RawTopGraphType,
  TopGraph as TopGraphType,
} from "../../agents/schemas/schema.js";
import type { ArrangerTask, NodeProgress, Progress } from "./types.js";
import { fileExists } from "./runtime.js";

const ACTIONABLE: ReadonlySet<GraphStatusType> = new Set([
  "pending", "writing", "checking",
]);

const RECOVERABLE: ReadonlySet<GraphStatusType> = new Set([
  "decomposing", "writing", "checking",
]);

type AncestorEdgeSource = Pick<AncestorEdgeType, "target" | "type" | "description">;
type AncestorEdgeNode = { name: string; edges: AncestorEdgeSource[] };

export interface DecompositionReviewItem {
  id: string
  kind: "scaffold" | "decomposer"
  nodeId: string
  title: string
  description: string
  nodes: GraphNodeType[]
}

export class GraphStore {
  private readonly nodeLocks = new Map<string, Promise<void>>();

  constructor(
    public readonly docDir: string,
    private readonly onChange: () => void = () => {},
  ) {}

  get projectName(): string {
    return path.basename(this.docDir);
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.docDir, { recursive: true });
  }

  async hasTopGraph(): Promise<boolean> {
    return fileExists(path.join(this.docDir, "top.json"));
  }

  async getProgress(phase: Progress["phase"], paused: boolean): Promise<Progress> {
    const counts = await this.countStatuses();
    const allNodeIds = await this.scanGraphNodes(this.docDir, "");
    const nodes: NodeProgress[] = [];
    for (const nodeId of allNodeIds) {
      try {
        const graph = await this.readGraph(nodeId);
        nodes.push({ nodeId, status: graph.status });
      } catch { /* skip */ }
    }
    return { phase, counts, nodes, paused };
  }

  async countStatuses(): Promise<Record<string, number>> {
    const counts: Record<string, number> = { pending: 0, decomposing: 0, writing: 0, checking: 0, "awaiting-review": 0, done: 0, error: 0 };
    const top = await this.readTopGraph().catch(() => undefined);
    if (top?.status === "awaiting-review") counts["awaiting-review"] = (counts["awaiting-review"] ?? 0) + 1;
    const allNodeIds = await this.scanGraphNodes(this.docDir, "");
    for (const nodeId of allNodeIds) {
      try {
        const graph = await this.readGraph(nodeId);
        counts[graph.status] = (counts[graph.status] ?? 0) + 1;
      } catch { /* skip */ }
    }
    return counts;
  }

  async claimNextTask(): Promise<ArrangerTask | null> {
    const allNodeIds = await this.scanGraphNodes(this.docDir, "");
    allNodeIds.sort((a, b) => a.split("/").length - b.split("/").length);
    for (const nodeId of allNodeIds) {
      try {
        const graph = await this.readGraph(nodeId);
        if (!ACTIONABLE.has(graph.status)) continue;

        if (graph.status === "writing" && graph.pageTasks) {
          const nextPage = Object.entries(graph.pageTasks).find(([, task]) => task.status === "pending");
          if (nextPage) {
            const [ref] = nextPage;
            await this.markPageWriting(nodeId, ref);
            return { kind: "page", nodeId, ref, graph };
          } else if (Object.values(graph.pageTasks).every((task) => task.status === "done")) {
            await this.finishNodeIfReady(nodeId);
          }
          continue;
        }

        await this.updateGraph(nodeId, { status: "decomposing", pageTasks: undefined });
        return { kind: "graph", nodeId, graph };
      } catch {
        console.warn(`[Arranger] Skipping unreadable graph: ${nodeId}`);
      }
    }
    return null;
  }

  async initializeFromScaffold(topResult: RawTopGraphType, finalSessionId: string): Promise<void> {
    this.validateScaffoldNodes(topResult.nodes);
    const topGraph: TopGraphType = {
      status: "done",
      retryCount: 0,
      sessionId: finalSessionId,
      description: topResult.description,
      nodes: topResult.nodes,
    };
    await this.writeTopGraph(topGraph);

    for (const node of topResult.nodes) {
      await this.writeGraph(node.name, {
        status: "pending",
        retryCount: 0,
        sessionId: "",
        description: node.description,
        codeScope: node.codeScope,
        nodes: [],
      });
    }
  }

  async initializeScaffoldReview(topResult: RawTopGraphType, finalSessionId: string): Promise<void> {
    this.validateScaffoldNodes(topResult.nodes);
    const topGraph: TopGraphType = {
      status: "awaiting-review",
      retryCount: 0,
      sessionId: finalSessionId,
      description: topResult.description,
      nodes: topResult.nodes,
    };
    await this.writeTopGraph(topGraph);
    this.onChange();
  }

  async markGraphDecomposed(nodeId: string, rawGraph: RawGraphType, decomposerSessionId: string): Promise<void> {
    this.validateGraphNodes(rawGraph.nodes);
    await this.ensureChildGraphs(nodeId, rawGraph.nodes);

    const pageTasks = this.buildPageTasks(rawGraph.nodes);
    const hasPages = Object.keys(pageTasks).length > 0;
    const latest = await this.readGraph(nodeId);
    await this.writeGraph(nodeId, {
      ...latest,
      status: hasPages ? "writing" : "done",
      sessionId: decomposerSessionId,
      nodes: rawGraph.nodes,
      decomposerSessionId: undefined,
      checkerSessionId: undefined,

      pageTasks: hasPages ? pageTasks : undefined,
    });
  }

  async markGraphAwaitingReview(nodeId: string, rawGraph: RawGraphType, decomposerSessionId: string): Promise<void> {
    this.validateGraphNodes(rawGraph.nodes);
    const latest = await this.readGraph(nodeId);
    await this.writeGraph(nodeId, {
      ...latest,
      status: "awaiting-review",
      sessionId: decomposerSessionId,
      nodes: rawGraph.nodes,
      decomposerSessionId,
      checkerSessionId: undefined,

      pageTasks: undefined,
    });
    this.onChange();
  }

  async markGraphError(nodeId: string): Promise<void> {
    await this.updateGraph(nodeId, { status: "error" });
  }

  async markPageWriting(nodeId: string, ref: string): Promise<void> {
    await this.updatePageTask(nodeId, ref, { status: "writing" });
  }

  async markPageDone(nodeId: string, ref: string): Promise<void> {
    await this.updatePageTask(nodeId, ref, { status: "done" });
  }

  async markPageError(nodeId: string, ref: string): Promise<void> {
    await this.updatePageTask(nodeId, ref, { status: "error" });
    await this.markGraphError(nodeId);
  }

  async finishNodeIfReady(nodeId: string): Promise<void> {
    let changed = false;
    await this.withNodeLock(nodeId, async () => {
      const graph = await this.readGraph(nodeId);
      const pageTasks = graph.pageTasks;
      if (!pageTasks) {
        if (graph.status !== "done") {
          await this.writeGraph(nodeId, { ...graph, status: "done" });
          changed = true;
        }
        return;
      }
      if (!Object.values(pageTasks).every((task) => task.status === "done")) return;

      await this.writeGraph(nodeId, {
        ...graph,
        status: "done",
        pageTasks: undefined,
      });
      changed = true;
    });
    if (changed) this.onChange();
  }

  findPageNode(graph: GraphType, ref: string): GraphNodeType | undefined {
    return graph.nodes.find((node) => node.child.type === "page" && node.child.ref === ref);
  }

  async writePage(nodeId: string, ref: string, content: string): Promise<void> {
    await withDocProjectLock(this.projectName, async () => {
      const destDir = path.join(this.docDir, nodeId);
      await mkdir(destDir, { recursive: true });
      await writeFile(path.join(destDir, `${ref}.md`), content);
    });
  }

  async hasFlows(): Promise<boolean> {
    return fileExists(path.join(this.docDir, "flows.json"));
  }

  async writeFlows(result: FlowAnalyzerOutput): Promise<void> {
    await withDocProjectLock(this.projectName, async () => {
      await writeFile(path.join(this.docDir, "flows.json"), JSON.stringify(result, null, 2));
    });
  }

  async resetRecoverableNodes(): Promise<number> {
    return this.resetNodes(
      (status) => RECOVERABLE.has(status),
      false,
      "recovery",
    );
  }

  async resetErrorNodes(): Promise<number> {
    return this.resetNodes(
      (status) => status === "error",
      true,
      "error reset",
      true,
    );
  }

  async hasPendingReviews(): Promise<boolean> {
    const top = await this.readTopGraph().catch(() => undefined);
    if (top?.status === "awaiting-review") return true;
    const allNodeIds = await this.scanGraphNodes(this.docDir, "");
    for (const nodeId of allNodeIds) {
      try {
        if ((await this.readGraph(nodeId)).status === "awaiting-review") return true;
      } catch { /* skip */ }
    }
    return false;
  }

  async listDecompositionReviews(): Promise<DecompositionReviewItem[]> {
    const out: DecompositionReviewItem[] = [];
    const top = await this.readTopGraph().catch(() => undefined);
    if (top?.status === "awaiting-review") {
      out.push({
        id: "scaffold",
        kind: "scaffold",
        nodeId: "",
        title: "Top-level modules",
        description: top.description,
        nodes: this.scaffoldNodesToGraphNodes(top.nodes),
      });
    }

    const allNodeIds = await this.scanGraphNodes(this.docDir, "");
    for (const nodeId of allNodeIds) {
      try {
        const graph = await this.readGraph(nodeId);
        if (graph.status !== "awaiting-review") continue;
        out.push({
          id: `graph:${nodeId}`,
          kind: "decomposer",
          nodeId,
          title: nodeId,
          description: graph.description,
          nodes: graph.nodes,
        });
      } catch { /* skip */ }
    }
    return out;
  }

  async updateDecompositionReview(id: string, nodes: GraphNodeType[]): Promise<void> {
    if (id === "scaffold") {
      await this.updateScaffoldReview(nodes);
      return;
    }
    const nodeId = this.parseGraphReviewId(id);
    const rawGraph = RawGraph.parse({ nodes });
    this.validateGraphNodes(rawGraph.nodes);
    await this.updateGraph(nodeId, { nodes: rawGraph.nodes });
  }

  async approveDecompositionReview(id: string): Promise<void> {
    if (id === "scaffold") {
      await this.approveScaffoldReview();
      return;
    }
    const nodeId = this.parseGraphReviewId(id);
    const graph = await this.readGraph(nodeId);
    if (graph.status !== "awaiting-review") throw new Error(`Review is not awaiting approval: ${id}`);
    await this.markGraphDecomposed(nodeId, { nodes: graph.nodes }, graph.decomposerSessionId ?? graph.sessionId);
  }

  async getScaffoldReviewSession(): Promise<string> {
    const top = await this.readTopGraph();
    if (top.status !== "awaiting-review") throw new Error("Scaffold review is not awaiting feedback");
    return top.sessionId;
  }

  async getScaffoldReviewCandidate(): Promise<RawTopGraphType> {
    const top = await this.readTopGraph();
    if (top.status !== "awaiting-review") throw new Error("Scaffold review is not awaiting feedback");
    return { description: top.description, nodes: top.nodes };
  }

  async getGraphReview(nodeId: string): Promise<GraphType> {
    const graph = await this.readGraph(nodeId);
    if (graph.status !== "awaiting-review") throw new Error(`Graph review is not awaiting feedback: ${nodeId}`);
    return graph;
  }

  async isScaffoldStillAwaitingReview(expectedSessionId: string): Promise<boolean> {
    const top = await this.readTopGraph().catch(() => undefined);
    return top?.status === "awaiting-review" && top.sessionId === expectedSessionId;
  }

  async isGraphStillAwaitingReview(nodeId: string, expectedSessionId: string): Promise<boolean> {
    try {
      const graph = await this.readGraph(nodeId);
      return graph.status === "awaiting-review" && (graph.decomposerSessionId ?? graph.sessionId) === expectedSessionId;
    } catch {
      return false;
    }
  }

  async buildAncestorContext(nodeId: string): Promise<AncestorContextType | null> {
    const segments = nodeId.split("/").filter(Boolean);
    if (segments.length === 0) return null;

    const ancestors: AncestorLayerType[] = [];
    const extractEdges = (nodes: AncestorEdgeNode[]): AncestorEdgeType[] =>
      nodes.flatMap((n) =>
        n.edges.map((e) => ({
          source: n.name,
          target: e.target,
          type: e.type,
          description: e.description,
        })),
      );

    const top = await this.readTopGraph();
    ancestors.push({
      name: "top",
      depth: 0,
      siblings: top.nodes.map((n) => ({ name: n.name, description: n.description })),
      edges: extractEdges(top.nodes),
    });

    for (let i = 0; i < segments.length - 1; i++) {
      const name = segments[i];
      if (!name) throw new Error(`Invalid ancestor path: ${nodeId}`);
      const parentId = segments.slice(0, i + 1).join("/");
      const parentGraph = await this.readGraph(parentId);
      ancestors.push({
        name,
        depth: i + 1,
        siblings: parentGraph.nodes.map((n) => ({ name: n.name, description: n.description })),
        edges: extractEdges(parentGraph.nodes),
      });
    }

    return { path: segments, ancestors };
  }

  private async resetNodes(
    shouldReset: (status: GraphStatusType) => boolean,
    clearDecomposerSession: boolean,
    label: string,
    fullReset = false,
  ): Promise<number> {
    const allNodeIds = await this.scanGraphNodes(this.docDir, "");
    let resetCount = 0;

    for (const nodeId of allNodeIds) {
      try {
        const graph = await this.readGraph(nodeId);
        if (!shouldReset(graph.status)) continue;

        if (fullReset) {
          await this.writeGraph(nodeId, {
            status: "pending",
            retryCount: 0,
            sessionId: "",
            description: graph.description,
            codeScope: graph.codeScope,
            nodes: [],
          });
        } else {
          const pageTasks = this.resetPageTasks(graph.pageTasks);
          const hasPendingPages = pageTasks && Object.values(pageTasks).some((task) => task.status !== "done");
          await this.writeGraph(nodeId, {
            ...graph,
            status: hasPendingPages ? "writing" : "pending",
            pageTasks,
            decomposerSessionId: clearDecomposerSession ? undefined : graph.decomposerSessionId,
            checkerSessionId: undefined,
          });
        }
        resetCount++;
      } catch {
        console.warn(`[Arranger] Skipping unreadable graph during ${label}: ${nodeId}`);
      }
    }

    return resetCount;
  }

  private resetPageTasks(pageTasks: Record<string, PageTaskType> | undefined): Record<string, PageTaskType> | undefined {
    if (!pageTasks) return undefined;
    const resetTasks: Record<string, PageTaskType> = {};
    for (const [ref, task] of Object.entries(pageTasks)) {
      resetTasks[ref] = {
        ...task,
        status: task.status === "done" ? "done" : "pending",
      };
    }
    return resetTasks;
  }

  private buildPageTasks(nodes: GraphNodeType[]): Record<string, PageTaskType> {
    const tasks: Record<string, PageTaskType> = {};
    for (const node of nodes) {
      if (node.child.type !== "page") continue;
      tasks[node.child.ref] = { status: "pending", retryCount: 0 };
    }
    return tasks;
  }

  private async updateScaffoldReview(nodes: GraphNodeType[]): Promise<void> {
    const top = await this.readTopGraph();
    if (top.status !== "awaiting-review") throw new Error("Scaffold review is not awaiting approval");
    const rawTop = RawTopGraph.parse({
      description: top.description,
      nodes: nodes.map((node) => ({
        name: node.name,
        description: node.description,
        codeScope: node.codeScope,
        edges: node.edges,
      })),
    });
    this.validateScaffoldNodes(rawTop.nodes);
    await this.writeTopGraph({ ...top, nodes: rawTop.nodes });
    this.onChange();
  }

  private async approveScaffoldReview(): Promise<void> {
    const top = await this.readTopGraph();
    if (top.status !== "awaiting-review") throw new Error("Scaffold review is not awaiting approval");
    this.validateScaffoldNodes(top.nodes);
    for (const node of top.nodes) {
      await this.writeGraph(node.name, {
        status: "pending",
        retryCount: 0,
        sessionId: "",
        description: node.description,
        codeScope: node.codeScope,
        nodes: [],
      });
    }
    await this.writeTopGraph({ ...top, status: "done" });
    this.onChange();
  }

  private scaffoldNodesToGraphNodes(nodes: RawTopGraphType["nodes"]): GraphNodeType[] {
    return nodes.map((node) => GraphNode.parse({
      name: node.name,
      description: node.description,
      codeScope: node.codeScope,
      edges: node.edges,
      child: { type: "graph", ref: node.name },
    }));
  }

  private parseGraphReviewId(id: string): string {
    if (!id.startsWith("graph:")) throw new Error(`Invalid review id: ${id}`);
    const nodeId = id.slice("graph:".length);
    if (!nodeId) throw new Error(`Invalid review id: ${id}`);
    return nodeId;
  }

  private validateScaffoldNodes(nodes: RawTopGraphType["nodes"]): void {
    this.validateNames(nodes.map((node) => node.name), "node name");
    const names = new Set(nodes.map((node) => node.name));
    for (const node of nodes) {
      this.validatePathPart(node.name, "node name");
      for (const edge of node.edges) {
        if (!names.has(edge.target)) throw new Error(`Edge target not found: ${node.name} -> ${edge.target}`);
      }
    }
  }

  private validateGraphNodes(nodes: GraphNodeType[]): void {
    this.validateNames(nodes.map((node) => node.name), "node name");
    this.validateNames(nodes.map((node) => node.child.ref), "child ref");
    const names = new Set(nodes.map((node) => node.name));
    for (const node of nodes) {
      this.validatePathPart(node.child.ref, "child ref");
      for (const edge of node.edges) {
        if (!names.has(edge.target)) throw new Error(`Edge target not found: ${node.name} -> ${edge.target}`);
      }
    }
  }

  private validateNames(values: string[], label: string): void {
    const seen = new Set<string>();
    for (const value of values) {
      if (!value.trim()) throw new Error(`Empty ${label}`);
      if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
      seen.add(value);
    }
  }

  private validatePathPart(value: string, label: string): void {
    if (value.includes("/") || value.includes("\\") || value.includes("..")) {
      throw new Error(`Invalid ${label}: ${value}`);
    }
  }

  private async updatePageTask(nodeId: string, ref: string, patch: Partial<PageTaskType>): Promise<void> {
    await this.withNodeLock(nodeId, async () => {
      const graph = await this.readGraph(nodeId);
      if (!graph.pageTasks?.[ref]) {
        throw new Error(`Missing page task ${nodeId}/${ref}`);
      }
      graph.pageTasks[ref] = { ...graph.pageTasks[ref], ...patch };
      await this.writeGraph(nodeId, graph);
    });
    this.onChange();
  }

  private async ensureChildGraphs(nodeId: string, nodes: GraphNodeType[]): Promise<void> {
    for (const node of nodes) {
      if (node.child.type !== "graph") continue;
      const childId = `${nodeId}/${node.child.ref}`;
      if (await fileExists(this.graphFilePath(childId))) continue;
      await this.writeGraph(childId, {
        status: "pending",
        retryCount: 0,
        sessionId: "",
        description: node.description,
        codeScope: node.codeScope,
        nodes: [],
      });
    }
  }

  private async withNodeLock<T>(nodeId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.nodeLocks.get(nodeId);
    const waitForPrevious = previous?.catch(() => {}) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = waitForPrevious.then(() => current);
    this.nodeLocks.set(nodeId, tail);
    await waitForPrevious;
    try {
      return await fn();
    } finally {
      if (release) release();
      if (this.nodeLocks.get(nodeId) === tail) {
        this.nodeLocks.delete(nodeId);
      }
    }
  }

  private async updateGraph(nodeId: string, patch: Partial<GraphType>): Promise<void> {
    await this.withNodeLock(nodeId, async () => {
      const graph = await this.readGraph(nodeId);
      await this.writeGraph(nodeId, { ...graph, ...patch });
    });
    this.onChange();
  }

  private async scanGraphNodes(dir: string, prefix: string): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodeIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const nodeId = prefix ? `${prefix}/${entry.name}` : entry.name;
      const selfJson = path.join(dir, entry.name, `${entry.name}.json`);
      if (await fileExists(selfJson)) {
        nodeIds.push(nodeId);
      }
      const sub = await this.scanGraphNodes(path.join(dir, entry.name), nodeId);
      nodeIds.push(...sub);
    }
    return nodeIds;
  }

  private graphFilePath(nodeId: string): string {
    const parts = nodeId.split("/").filter(Boolean);
    const lastName = parts[parts.length - 1];
    if (!lastName) throw new Error("nodeId required");
    return path.join(this.docDir, ...parts, `${lastName}.json`);
  }

  private async readGraph(nodeId: string): Promise<GraphType> {
    const raw = await readFile(this.graphFilePath(nodeId), "utf-8");
    return Graph.parse(JSON.parse(raw));
  }

  private async writeGraph(nodeId: string, graph: GraphType): Promise<void> {
    await withDocProjectLock(this.projectName, async () => {
      const filePath = this.graphFilePath(nodeId);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(graph, null, 2));
    });
  }

  private async readTopGraph(): Promise<TopGraphType> {
    const raw = await readFile(path.join(this.docDir, "top.json"), "utf-8");
    return TopGraph.parse(JSON.parse(raw));
  }

  private async writeTopGraph(topGraph: TopGraphType): Promise<void> {
    await withDocProjectLock(this.projectName, async () => {
      await writeFile(path.join(this.docDir, "top.json"), JSON.stringify(topGraph, null, 2));
    });
  }
}
