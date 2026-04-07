import { readFile, writeFile, mkdir, readdir, access } from "node:fs/promises";
import path from "node:path";
import { Scaffold } from "../agents/scaffold.js";
import { Decomposer } from "../agents/decomposer.js";
import { claudeChecker } from "../agents/claudechecker.js";
import { codexChecker } from "../agents/codexchecker.js";
import { Writer } from "../agents/writer.js";
import { TopGraph, Graph } from "../agents/schemas/schema.js";
import type { IChecker } from "../agents/schemas/schema.js";
import type {
  TopGraph as TopGraphType,
  Graph as GraphType,
  GraphStatus as GraphStatusType,
  AncestorContext as AncestorContextType,
  AncestorLayer as AncestorLayerType,
  AncestorEdge as AncestorEdgeType,
  GraphNode as GraphNodeType,
  RawTopGraph as RawTopGraphType,
  RawGraph as RawGraphType,
  CheckerIssue as CheckerIssueType,
} from "../agents/schemas/schema.js";

// ─── Checker issue 分类与格式化 ───

const GRAPH_ISSUE_TYPES = new Set(["broken-target", "invalid-path", "empty-content", "missing-ref"]);
const DOC_ISSUE_TYPES = new Set(["missing-section", "empty-content", "invalid-path", "missing-ref"]);

function formatIssue(issue: CheckerIssueType, index: number): string {
  const severity = issue.severity === "error" ? "[ERROR]" : "[WARNING]";
  const files = issue.files.length > 0 ? `\n   相关文件: ${issue.files.join(", ")}` : "";
  return `${index + 1}. ${severity} [${issue.type}] ${issue.description}${files}`;
}

function buildDecomposerFixPrompt(issues: CheckerIssueType[]): string {
  const graphIssues = issues.filter((i) => GRAPH_ISSUE_TYPES.has(i.type));
  const docIssues = issues.filter((i) => DOC_ISSUE_TYPES.has(i.type) && (i.type === "missing-section" || i.type === "missing-ref"));

  const parts = ["你的子图产出经过 Checker 校验未通过，存在以下问题：", ""];

  if (graphIssues.length > 0) {
    parts.push("### 图结构问题");
    graphIssues.forEach((issue, i) => parts.push(formatIssue(issue, i)));
    parts.push("");
  }

  if (docIssues.length > 0) {
    parts.push("### 文档质量问题（可能需要调整节点的 description 或 codeScope 来辅助 Writer）");
    docIssues.forEach((issue, i) => parts.push(formatIssue(issue, i)));
    parts.push("");
  }

  parts.push(
    "请根据以上问题修正你的输出：",
    "- edges[].target 必须指向当前图中实际存在的节点名称",
    "- codeScope 中的路径必须是目标仓库中实际存在的文件或目录，请用 Glob 验证",
    "- 每个节点的 description 必须非空且有意义",
    "- child.ref 使用简洁英文标识符，不含空格和特殊字符",
    "",
    "请重新输出完整的、修正后的子图 JSON。",
  );

  return parts.join("\n");
}

function buildWriterFixPrompt(issues: CheckerIssueType[], nodeName: string): string {
  const relevant = issues.filter(
    (i) => DOC_ISSUE_TYPES.has(i.type) && i.description.toLowerCase().includes(nodeName.toLowerCase()),
  );
  const toShow = relevant.length > 0 ? relevant : issues.filter((i) => DOC_ISSUE_TYPES.has(i.type));
  if (toShow.length === 0) return "";

  const parts = [
    `你为模块 "${nodeName}" 生成的文档经过 Checker 校验发现以下问题：`,
    "",
  ];
  toShow.forEach((issue, i) => parts.push(formatIssue(issue, i)));
  parts.push(
    "",
    "请针对以上问题修正文档，确保：",
    "- 包含核心章节（概述与职责、关键流程）",
    "- 文档中引用的代码路径在目标仓库中实际存在",
    "- 内容具有实质性，而非占位符",
    "",
    "请重新输出修正后的完整文档。",
  );
  return parts.join("\n");
}

function buildScaffoldFixPrompt(issues: CheckerIssueType[]): string {
  const parts = [
    "你的顶层模块图经过 Checker 校验未通过，存在以下问题：",
    "",
  ];
  issues.forEach((issue, i) => parts.push(formatIssue(issue, i)));
  parts.push(
    "",
    "请修正后重新输出完整的顶层模块图，确保：",
    "- 所有 codeScope 路径在目标仓库中实际存在",
    "- 所有 edges[].target 指向当前图中存在的节点名称",
    "- 每个节点的 description 非空且有意义",
  );
  return parts.join("\n");
}

export interface NodeProgress {
  nodeId: string
  status: GraphStatusType
}

export interface Progress {
  phase: "scaffold" | "processing" | "idle"
  counts: Record<string, number>
  nodes: NodeProgress[]
}

// ─── 并发限流 ───

class Semaphore {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.running--;
    }
  }
}

export type CheckerType = "claude" | "codex";

export class Arranger {
  private readonly maxConcurrency: number;
  private readonly checkerType: CheckerType;
  private readonly sem: Semaphore;
  private repoPath = "";
  private docDir = "";
  private currentPhase: Progress["phase"] = "idle";
  private listeners = new Set<() => void>();

  constructor(options?: { maxConcurrency?: number; checkerType?: CheckerType }) {
    this.maxConcurrency = options?.maxConcurrency ?? 8;
    this.checkerType = options?.checkerType ?? "codex";
    this.sem = new Semaphore(this.maxConcurrency);
  }

  private makeChecker(): IChecker {
    return this.checkerType === "claude" ? new claudeChecker() : new codexChecker();
  }

  onProgress(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  async getProgress(): Promise<Progress> {
    if (!this.docDir) return { phase: "idle", counts: {}, nodes: [] };
    const counts = await this.countStatuses();
    const allNodeIds = await this.scanGraphNodes(this.docDir, "");
    const nodes: NodeProgress[] = [];
    for (const nodeId of allNodeIds) {
      try {
        const graph = await this.readGraph(nodeId);
        nodes.push({ nodeId, status: graph.status });
      } catch { /* skip */ }
    }
    return { phase: this.currentPhase, counts, nodes };
  }

  // ─── 唯一公开入口 ───

  async run(repoPath: string, docDir = path.resolve("web/doc", path.basename(path.resolve(repoPath)))): Promise<void> {
    this.repoPath = repoPath;
    this.docDir = docDir;

    await mkdir(this.docDir, { recursive: true });

    const topExists = await this.fileExists(path.join(this.docDir, "top.json"));
    if (!topExists) {
      console.log("[Arranger] Running scaffold...");
      this.currentPhase = "scaffold";
      this.notify();
      await this.runScaffold();
    } else {
      console.log("[Arranger] top.json already exists, skipping scaffold.");
    }

    await this.resetRecoverableNodes();
    this.currentPhase = "processing";
    this.notify();
    await this.processLoop();
    this.currentPhase = "idle";
    this.notify();
    console.log("[Arranger] Done.");
  }

  // ─── Scaffold + Checker ───

  private async runScaffold(): Promise<void> {
    const scaffold = new Scaffold();
    const { sessionId, result } = await scaffold.run(
      `Analyze the repository at ${this.repoPath} and produce the top-level module graph.`,
      this.repoPath,
    );

    let topResult: RawTopGraphType = result;
    let finalSessionId = sessionId;

    const checker = this.makeChecker();
    for (let retry = 0; ; retry++) {
      const checkerPrompt = [
        `Validate the scaffold output for the top-level module graph.`,
        `Repository root: ${this.repoPath}`,
        ``,
        `## Graph JSON content:`,
        "```json",
        JSON.stringify(topResult, null, 2),
        "```",
      ].join("\n");

      const checkerResult = checker.getSessionId()
        ? await checker.continue(checkerPrompt)
        : await checker.run(checkerPrompt, this.repoPath);

      if (checkerResult.result.passed) {
        console.log("[Arranger] Scaffold check passed.");
        break;
      }
      if (retry >= 3) throw new Error(`Scaffold check failed after 3 retries: ${JSON.stringify(checkerResult.result.issues)}`);

      console.log(`[Arranger] Scaffold check failed (retry ${retry + 1}/3)`);
      const fixed = await scaffold.continue(buildScaffoldFixPrompt(checkerResult.result.issues));
      topResult = fixed.result;
      finalSessionId = fixed.sessionId;
    }

    const topGraph: TopGraphType = {
      status: "done",
      retryCount: 0,
      sessionId: finalSessionId,
      description: topResult.description,
      nodes: topResult.nodes,
    };
    await this.writeTopGraph(topGraph);
    console.log(`[Arranger] Scaffold complete. ${topResult.nodes.length} top-level modules.`);

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

  // ─── 滑动窗口主循环 ───

  private static readonly ACTIONABLE: ReadonlySet<GraphStatusType> = new Set([
    "pending", "decomposing", "writing", "checking",
  ]);

  private static readonly RECOVERABLE: ReadonlySet<GraphStatusType> = new Set([
    "decomposing", "writing", "checking", "error",
  ]);

  private async processLoop(): Promise<void> {
    for (let iteration = 1; ; iteration++) {
      const actionable = await this.findActionableNodes();
      if (actionable.length === 0) break;

      const allStatuses = await this.countStatuses();
      console.log(
        `[Arranger] Iteration ${iteration}: `
        + `${allStatuses.pending ?? 0} pending, ${allStatuses.decomposing ?? 0} decomposing, `
        + `${allStatuses.writing ?? 0} writing, ${allStatuses.checking ?? 0} checking, `
        + `${allStatuses.done ?? 0} done, ${allStatuses.error ?? 0} error`,
      );

      const results = await Promise.allSettled(
        actionable.map(({ nodeId }) => this.processNode(nodeId)),
      );
      for (const r of results) {
        if (r.status === "rejected") {
          console.error("[Arranger] Pipeline failed:", r.reason);
        }
      }
    }
  }

  private async resetRecoverableNodes(): Promise<void> {
    const allNodeIds = await this.scanGraphNodes(this.docDir, "");
    let resetCount = 0;

    for (const nodeId of allNodeIds) {
      try {
        const graph = await this.readGraph(nodeId);
        if (!Arranger.RECOVERABLE.has(graph.status)) continue;
        await this.writeGraph(nodeId, { ...graph, status: "pending" });
        resetCount++;
      } catch {
        console.warn(`[Arranger] Skipping unreadable graph during recovery: ${nodeId}`);
      }
    }

    if (resetCount > 0) {
      console.log(`[Arranger] Recovered ${resetCount} node(s) to pending.`);
    }
  }

  private async withSemaphore<T>(fn: () => Promise<T>): Promise<T> {
    await this.sem.acquire();
    try {
      return await fn();
    } finally {
      this.sem.release();
    }
  }

  private async findActionableNodes(): Promise<Array<{ nodeId: string; graph: GraphType }>> {
    const allNodeIds = await this.scanGraphNodes(this.docDir, "");
    const results: Array<{ nodeId: string; graph: GraphType }> = [];
    for (const nodeId of allNodeIds) {
      try {
        const graph = await this.readGraph(nodeId);
        if (Arranger.ACTIONABLE.has(graph.status)) {
          results.push({ nodeId, graph });
        }
      } catch {
        console.warn(`[Arranger] Skipping unreadable graph: ${nodeId}`);
      }
    }
    return results;
  }

  // ─── Prompt 构建 ───

  private buildDecompPrompt(
    nodeId: string,
    graph: GraphType,
    ancestorContext: AncestorContextType | null,
  ): string {
    const parts = [
      `Analyze the code scope and produce a sub-graph for the module "${nodeId}".`,
      `Description: ${graph.description}`,
      `Code scope (files/directories to analyze): ${graph.codeScope.join(", ")}`,
      `Repository root: ${this.repoPath}`,
    ];
    if (ancestorContext) {
      parts.push(`\nAncestor context (the module hierarchy above this node):\n${JSON.stringify(ancestorContext, null, 2)}`);
    }
    return parts.join("\n");
  }

  private buildGraphCheckerPrompt(nodeId: string, rawGraph: RawGraphType): string {
    return [
      `Validate the decomposer output (graph structure only) for module "${nodeId}".`,
      `Repository root: ${this.repoPath}`,
      ``,
      `## Graph JSON content:`,
      "```json",
      JSON.stringify(rawGraph, null, 2),
      "```",
      ``,
      `Note: Leaf Markdown documents have not been generated yet — validate graph structure only.`,
    ].join("\n");
  }

  private buildDocCheckerPrompt(
    nodeId: string,
    rawGraph: RawGraphType,
    pageContents: Map<string, string>,
  ): string {
    const pageNodes = rawGraph.nodes.filter((n) => n.child.type === "page");
    const mdSections: string[] = [];
    for (const node of pageNodes) {
      const content = pageContents.get(node.child.ref);
      if (content) {
        mdSections.push(`--- FILE: ${node.child.ref}.md (node: ${node.name}) ---\n${content}\n--- END FILE ---`);
      } else {
        mdSections.push(`--- FILE: ${node.child.ref}.md (node: ${node.name}) ---\n[WRITER FAILED]\n--- END FILE ---`);
      }
    }
    return [
      `Validate the writer output for module "${nodeId}".`,
      `Repository root: ${this.repoPath}`,
      ``,
      `## Graph JSON content:`,
      "```json",
      JSON.stringify(rawGraph, null, 2),
      "```",
      ``,
      ...(mdSections.length > 0
        ? [`## Leaf Markdown documents:`, ``, ...mdSections]
        : [`## Leaf Markdown documents: (none)`]),
    ].join("\n");
  }

  // ─── Agent 循环 ───

  private async decomposeAndCheck(
    nodeId: string,
    prompt: string,
  ): Promise<{ rawGraph: RawGraphType; decomposer: Decomposer }> {
    const decomposer = new Decomposer();
    const checker = this.makeChecker();
    let rawGraph = (await this.withSemaphore(() => decomposer.run(prompt, this.repoPath))).result;

    for (let retry = 0; ; retry++) {
      const checkerPrompt = this.buildGraphCheckerPrompt(nodeId, rawGraph);
      const checkerResult = await this.withSemaphore(() =>
        checker.getSessionId()
          ? checker.continue(checkerPrompt)
          : checker.run(checkerPrompt, this.repoPath),
      );

      if (checkerResult.result.passed) {
        console.log(`[Arranger] Decomposer check passed: ${nodeId}`);
        return { rawGraph, decomposer };
      }
      if (retry >= 3) throw new Error(`Decomposer check failed after 3 retries for ${nodeId}`);

      console.log(`[Arranger] Decomposer check failed: ${nodeId} (retry ${retry + 1}/3)`);
      rawGraph = (await this.withSemaphore(() => decomposer.continue(buildDecomposerFixPrompt(checkerResult.result.issues)))).result;
    }
  }

  private async writeAndCheck(
    nodeId: string,
    rawGraph: RawGraphType,
    ancestorContext: AncestorContextType | null,
  ): Promise<Map<string, string>> {
    const pageContents = new Map<string, string>();
    const pageNodes = rawGraph.nodes.filter((n) => n.child.type === "page");
    if (pageNodes.length === 0) return pageContents;

    const checker = this.makeChecker();
    const writers = new Map<string, Writer>();

    await Promise.allSettled(
      pageNodes.map(async (node) => {
        const writer = new Writer();
        writers.set(node.child.ref, writer);
        const content = await this.withSemaphore(() =>
          this.generatePageContent(writer, node, ancestorContext),
        );
        pageContents.set(node.child.ref, content);
      }),
    );

    for (let retry = 0; ; retry++) {
      const checkerPrompt = this.buildDocCheckerPrompt(nodeId, rawGraph, pageContents);
      const checkerResult = await this.withSemaphore(() =>
        checker.getSessionId()
          ? checker.continue(checkerPrompt)
          : checker.run(checkerPrompt, this.repoPath),
      );

      if (checkerResult.result.passed) {
        console.log(`[Arranger] Writer check passed: ${nodeId}`);
        return pageContents;
      }
      if (retry >= 3) throw new Error(`Writer check failed after 3 retries for ${nodeId}`);

      console.log(`[Arranger] Writer check failed: ${nodeId} (retry ${retry + 1}/3)`);
      await Promise.allSettled(
        pageNodes.map(async (node) => {
          const writer = writers.get(node.child.ref);
          if (!writer) return;
          const fixPrompt = buildWriterFixPrompt(checkerResult.result.issues, node.name);
          if (!fixPrompt) return;
          const { result } = await this.withSemaphore(() => writer.continue(fixPrompt));
          pageContents.set(node.child.ref, result.content);
        }),
      );
    }
  }

  // ─── 单节点管线 ───

  private async processNode(nodeId: string): Promise<void> {
    let graph = await this.readGraph(nodeId);
    const ancestorContext = await this.buildAncestorContext(nodeId);

    console.log(`[Arranger] ${graph.status === "pending" ? "Processing" : `Resuming (${graph.status})`}: ${nodeId}`);

    // ── Phase 1: Decompose + Check ──
    let rawGraph: RawGraphType;
    let decomposerSessionId: string;

    if (graph.nodes.length > 0) {
      rawGraph = { nodes: graph.nodes };
      decomposerSessionId = graph.decomposerSessionId ?? graph.sessionId;
    } else {
      await this.updateGraph(nodeId, { status: "decomposing" });
      try {
        const prompt = this.buildDecompPrompt(nodeId, graph, ancestorContext);
        const result = await this.decomposeAndCheck(nodeId, prompt);
        rawGraph = result.rawGraph;
        decomposerSessionId = result.decomposer.getSessionId() ?? "";
      } catch (e) {
        console.error(`[Arranger] Decompose+check error for ${nodeId}:`, e);
        await this.updateGraph(nodeId, { status: "error" });
        return;
      }
      await this.updateGraph(nodeId, {
        status: "writing",
        nodes: rawGraph.nodes,
        decomposerSessionId,
      });
    }

    console.log(`[Arranger] Decomposed: ${nodeId} → ${rawGraph.nodes.length} child nodes`);

    // ── Phase 2: Write + Check ──
    await this.updateGraph(nodeId, { status: "writing" });

    let pageContents: Map<string, string>;
    try {
      pageContents = await this.writeAndCheck(nodeId, rawGraph, ancestorContext);
    } catch (e) {
      console.error(`[Arranger] Write+check error for ${nodeId}:`, e);
      await this.updateGraph(nodeId, { status: "error" });
      return;
    }

    // ── Finalize ──
    const destDir = path.join(this.docDir, nodeId);
    for (const [ref, content] of pageContents) {
      await writeFile(path.join(destDir, `${ref}.md`), content);
    }

    graph = await this.readGraph(nodeId);
    await this.writeGraph(nodeId, {
      ...graph,
      status: "done",
      sessionId: decomposerSessionId,
      nodes: rawGraph.nodes,
      decomposerSessionId: undefined,
      checkerSessionId: undefined,
      writerSessionIds: undefined,
    });

    for (const node of rawGraph.nodes.filter((n) => n.child.type === "graph")) {
      const childId = `${nodeId}/${node.child.ref}`;
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

  // ─── Writer ───

  private async generatePageContent(
    writer: Writer,
    node: GraphNodeType,
    ancestorContext: AncestorContextType | null,
  ): Promise<string> {
    console.log(`[Arranger] Generating page: ${node.name}`);

    const parts = [
      `Write comprehensive Markdown documentation for the module "${node.name}".`,
      `Description: ${node.description}`,
      `Code scope (files/directories to read): ${node.codeScope.join(", ")}`,
      `Repository root: ${this.repoPath}`,
    ];
    if (ancestorContext) {
      parts.push(`\nAncestor context (the module hierarchy above this node):\n${JSON.stringify(ancestorContext, null, 2)}`);
    }

    const { result } = await writer.run(parts.join("\n"), this.repoPath);
    console.log(`[Arranger] Page generated: ${node.name}`);
    return result.content;
  }

  // ─── AncestorContext 构造 ───

  private async buildAncestorContext(nodeId: string): Promise<AncestorContextType | null> {
    const segments = nodeId.split("/");
    if (segments.length < 1) return null;

    const ancestors: AncestorLayerType[] = [];

    const extractEdges = (nodes: { name: string; edges: { target: string; type: string; description: string }[] }[]): AncestorEdgeType[] =>
      nodes.flatMap((n) =>
        n.edges.map((e) => ({
          source: n.name,
          target: e.target,
          type: e.type as AncestorEdgeType["type"],
          description: e.description,
        })),
      );

    const top = await this.readTopGraph();
    ancestors.push({
      name: "top",
      depth: 0,
      siblings: top.nodes.map((n: { name: string; description: string }) => ({ name: n.name, description: n.description })),
      edges: extractEdges(top.nodes),
    });

    for (let i = 0; i < segments.length - 1; i++) {
      const parentId = segments.slice(0, i + 1).join("/");
      const parentGraph = await this.readGraph(parentId);
      ancestors.push({
        name: segments[i]!,
        depth: i + 1,
        siblings: parentGraph.nodes.map((n: { name: string; description: string }) => ({ name: n.name, description: n.description })),
        edges: extractEdges(parentGraph.nodes),
      });
    }

    return { path: segments, ancestors };
  }

  // ─── 文件扫描 ───

  private async countStatuses(): Promise<Record<string, number>> {
    const counts: Record<string, number> = { pending: 0, decomposing: 0, writing: 0, checking: 0, done: 0, error: 0 };
    const allNodeIds = await this.scanGraphNodes(this.docDir, "");
    for (const nodeId of allNodeIds) {
      try {
        const graph = await this.readGraph(nodeId);
        counts[graph.status] = (counts[graph.status] ?? 0) + 1;
      } catch { /* skip */ }
    }
    return counts;
  }

  private async scanGraphNodes(dir: string, prefix: string): Promise<string[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodeIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "_pending") continue;
      const nodeId = prefix ? `${prefix}/${entry.name}` : entry.name;
      const selfJson = path.join(dir, entry.name, `${entry.name}.json`);
      if (await this.fileExists(selfJson)) {
        nodeIds.push(nodeId);
      }
      const sub = await this.scanGraphNodes(path.join(dir, entry.name), nodeId);
      nodeIds.push(...sub);
    }
    return nodeIds;
  }

  // ─── 文件 I/O ───

  private graphFilePath(nodeId: string): string {
    const lastName = nodeId.split("/").pop()!;
    return path.join(this.docDir, nodeId, `${lastName}.json`);
  }

  private async readGraph(nodeId: string): Promise<GraphType> {
    const raw = await readFile(this.graphFilePath(nodeId), "utf-8");
    return Graph.parse(JSON.parse(raw));
  }

  private async writeGraph(nodeId: string, graph: GraphType): Promise<void> {
    const filePath = this.graphFilePath(nodeId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(graph, null, 2));
  }

  private async updateGraph(nodeId: string, patch: Partial<GraphType>): Promise<void> {
    const graph = await this.readGraph(nodeId);
    Object.assign(graph, patch);
    await this.writeGraph(nodeId, graph);
    this.notify();
  }

  private async readTopGraph(): Promise<TopGraphType> {
    const filePath = path.join(this.docDir, "top.json");
    const raw = await readFile(filePath, "utf-8");
    return TopGraph.parse(JSON.parse(raw));
  }

  private async writeTopGraph(topGraph: TopGraphType): Promise<void> {
    const filePath = path.join(this.docDir, "top.json");
    await writeFile(filePath, JSON.stringify(topGraph, null, 2));
  }

  // ─── 工具 ───

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
