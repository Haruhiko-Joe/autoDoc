import { readFile, writeFile, mkdir, readdir, access, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  claudeScaffold, claudeDecomposer, claudeChecker, claudeWriter, claudeFlowAnalyzer,
  codexScaffold, codexDecomposer, codexChecker, codexWriter, codexFlowAnalyzer,
} from "../agents/tsukai/index.js";
import { TopGraph, Graph } from "../agents/schemas/schema.js";
import type { IChecker, IScaffold, IDecomposer, IWriter, IFlowAnalyzer, Language } from "../agents/schemas/schema.js";
import { knowledgePathOf } from "../souko/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_TEMPLATE_DIR = path.resolve(__dirname, "..", "skill-template");
import type {
  TopGraph as TopGraphType,
  Graph as GraphType,
  GraphStatus as GraphStatusType,
  PageTask as PageTaskType,
  AncestorContext as AncestorContextType,
  AncestorLayer as AncestorLayerType,
  AncestorEdge as AncestorEdgeType,
  GraphNode as GraphNodeType,
  RawTopGraph as RawTopGraphType,
  RawGraph as RawGraphType,
  CheckerIssue as CheckerIssueType,
} from "../agents/schemas/schema.js";

// ─── Checker issue 格式化 ───

function formatIssue(issue: CheckerIssueType, index: number): string {
  const severity = issue.severity === "error" ? "[ERROR]" : "[WARNING]";
  const files = issue.files.length > 0 ? `\n   相关文件: ${issue.files.join(", ")}` : "";
  return `${index + 1}. ${severity} [${issue.type}] ${issue.description}${files}`;
}

function buildDecomposerFixPrompt(issues: CheckerIssueType[]): string {
  const parts = ["你的子图产出经过 Checker 校验未通过，存在以下问题：", ""];

  issues.forEach((issue, i) => parts.push(formatIssue(issue, i)));
  parts.push("");

  parts.push(
    "请根据以上问题修正你的输出：",
    "- edges[].target 必须指向当前图中实际存在的节点名称",
    "- codeScope 中的路径必须是目标仓库中实际存在的文件或目录",
    "- 每个节点的 description 必须非空且有意义",
    "- child.ref 使用简洁英文标识符，不含空格和特殊字符",
    "",
    "请重新输出完整的、修正后的子图 JSON。",
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
  phase: "scaffold" | "processing" | "assembling" | "flows" | "idle"
  counts: Record<string, number>
  nodes: NodeProgress[]
  paused: boolean
}

type ArrangerTask =
  | { kind: "graph"; nodeId: string; graph: GraphType }
  | { kind: "page"; nodeId: string; ref: string; graph: GraphType };

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

export type AgentBackend = "claude" | "codex";
export type AgentRole = "scaffold" | "decomposer" | "writer" | "checker" | "flowAnalyzer" | "updater";
export type AgentBackends = Record<AgentRole, AgentBackend>;

const DEFAULT_AGENT_BACKENDS: AgentBackends = {
  scaffold: "claude",
  decomposer: "claude",
  writer: "claude",
  checker: "codex",
  flowAnalyzer: "claude",
  updater: "claude",
};

export class Arranger {
  private readonly maxConcurrency: number;
  private readonly agentBackends: AgentBackends;
  private readonly language: Language;
  private readonly sem: Semaphore;
  private readonly nodeLocks = new Map<string, Promise<void>>();
  private _paused = false;
  private _resumeResolve: (() => void) | null = null;
  private _resumePromise: Promise<void> | null = null;
  private repoPath = "";
  private docDir = "";
  private knowledge = "";
  private currentPhase: Progress["phase"] = "idle";
  private listeners = new Set<() => void>();

  constructor(options?: {
    maxConcurrency?: number
    agentBackend?: AgentBackend
    agentBackends?: Partial<AgentBackends>
    language?: Language
  }) {
    this.maxConcurrency = options?.maxConcurrency ?? 8;
    const fallback = options?.agentBackend;
    this.agentBackends = {
      scaffold: options?.agentBackends?.scaffold ?? fallback ?? DEFAULT_AGENT_BACKENDS.scaffold,
      decomposer: options?.agentBackends?.decomposer ?? fallback ?? DEFAULT_AGENT_BACKENDS.decomposer,
      writer: options?.agentBackends?.writer ?? fallback ?? DEFAULT_AGENT_BACKENDS.writer,
      checker: options?.agentBackends?.checker ?? fallback ?? DEFAULT_AGENT_BACKENDS.checker,
      flowAnalyzer: options?.agentBackends?.flowAnalyzer ?? fallback ?? DEFAULT_AGENT_BACKENDS.flowAnalyzer,
      updater: options?.agentBackends?.updater ?? fallback ?? DEFAULT_AGENT_BACKENDS.updater,
    };
    this.language = options?.language ?? "zh";
    this.sem = new Semaphore(this.maxConcurrency);
  }

  private getBackend(role: AgentRole): AgentBackend {
    return this.agentBackends[role];
  }

  private makeChecker(): IChecker {
    return this.getBackend("checker") === "claude" ? new claudeChecker(this.language) : new codexChecker(this.language);
  }

  private makeScaffold(): IScaffold {
    return this.getBackend("scaffold") === "claude" ? new claudeScaffold(this.language) : new codexScaffold(this.language);
  }

  private makeDecomposer(): IDecomposer {
    return this.getBackend("decomposer") === "claude" ? new claudeDecomposer(this.language) : new codexDecomposer(this.language);
  }

  private makeWriter(): IWriter {
    return this.getBackend("writer") === "claude" ? new claudeWriter(this.language) : new codexWriter(this.language);
  }

  private makeFlowAnalyzer(): IFlowAnalyzer {
    return this.getBackend("flowAnalyzer") === "claude"
      ? new claudeFlowAnalyzer(this.docDir, this.projectName, this.language)
      : new codexFlowAnalyzer(this.docDir, this.projectName, this.language);
  }

  get paused(): boolean {
    return this._paused;
  }

  pause(): void {
    if (this._paused) return;
    this._paused = true;
    console.log("[Arranger] Paused.");
    this.notify();
  }

  resume(): void {
    if (!this._paused) return;
    this._paused = false;
    console.log("[Arranger] Resumed.");
    if (this._resumeResolve) {
      this._resumeResolve();
      this._resumeResolve = null;
      this._resumePromise = null;
    }
    this.notify();
  }

  private waitForResume(): Promise<void> {
    if (!this._resumePromise) {
      this._resumePromise = new Promise<void>((resolve) => {
        this._resumeResolve = resolve;
      });
    }
    return this._resumePromise;
  }

  onProgress(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getConfig(): { maxConcurrency: number; agentBackends: AgentBackends; language: Language } {
    return { maxConcurrency: this.maxConcurrency, agentBackends: this.agentBackends, language: this.language };
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  async getProgress(): Promise<Progress> {
    if (!this.docDir) return { phase: "idle", counts: {}, nodes: [], paused: false };
    const counts = await this.countStatuses();
    const allNodeIds = await this.scanGraphNodes(this.docDir, "");
    const nodes: NodeProgress[] = [];
    for (const nodeId of allNodeIds) {
      try {
        const graph = await this.readGraph(nodeId);
        nodes.push({ nodeId, status: graph.status });
      } catch { /* skip */ }
    }
    return { phase: this.currentPhase, counts, nodes, paused: this._paused };
  }

  // ─── 唯一公开入口 ───

  async run(repoPath: string, docDir = path.resolve("src/souko/doc", path.basename(path.resolve(repoPath)))): Promise<void> {
    this.repoPath = repoPath;
    this.docDir = docDir;
    this.knowledge = await this.loadKnowledge();

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

    const counts = await this.countStatuses();
    if ((counts.error ?? 0) > 0) {
      console.log(`[Arranger] ${counts.error} node(s) in error state. Stopping — use retry-errors to resume.`);
      this.currentPhase = "idle";
      this.notify();
      throw new Error(`${counts.error} node(s) failed. Use "Retry failed nodes" to reprocess.`);
    }

    this.currentPhase = "assembling";
    this.notify();
    await this.assembleSkill();

    this.currentPhase = "flows";
    this.notify();
    await this.runFlowAnalysis();

    this.currentPhase = "idle";
    this.notify();
    console.log("[Arranger] Done.");
  }

  async resetErrorsAndResume(): Promise<number> {
    if (!this.docDir) throw new Error("No active project. Run first.");
    const allNodeIds = await this.scanGraphNodes(this.docDir, "");
    let resetCount = 0;

    for (const nodeId of allNodeIds) {
      try {
        const graph = await this.readGraph(nodeId);
        if (graph.status !== "error") continue;
        const pageTasks: Record<string, PageTaskType> | undefined = graph.pageTasks
          ? Object.fromEntries(
            Object.entries(graph.pageTasks).map(([ref, task]) => [
              ref,
              { ...task, status: task.status === "done" ? "done" : "pending" } satisfies PageTaskType,
            ]),
          )
          : undefined;
        const hasPendingPages = pageTasks && Object.values(pageTasks).some((task) => task.status !== "done");
        await this.writeGraph(nodeId, {
          ...graph,
          status: hasPendingPages ? "writing" : "pending",
          pageTasks,
          decomposerSessionId: undefined,
          checkerSessionId: undefined,
          writerSessionIds: undefined,
        });
        resetCount++;
      } catch {
        console.warn(`[Arranger] Skipping unreadable graph during error reset: ${nodeId}`);
      }
    }

    if (resetCount > 0) {
      console.log(`[Arranger] Reset ${resetCount} error node(s) to pending.`);
      this.currentPhase = "processing";
      this.notify();
      await this.processLoop();

      this.currentPhase = "assembling";
      this.notify();
      await this.assembleSkill();

      this.currentPhase = "flows";
      this.notify();
      await this.runFlowAnalysis();

      this.currentPhase = "idle";
      this.notify();
    }

    return resetCount;
  }

  // ─── Scaffold + Checker ───

  private async runScaffold(): Promise<void> {
    const { topResult, finalSessionId } = await this.withRetry(async () => {
      const scaffold = this.makeScaffold();
      const { sessionId, result } = await scaffold.run(
        this.appendKnowledge(`Analyze the repository at ${this.repoPath} and produce the top-level module graph.`),
        this.repoPath,
      );

      let topResult: RawTopGraphType = result;
      let finalSessionId = sessionId;

      const checker = this.makeChecker();
      for (let retry = 0; ; retry++) {
        const checkerPrompt = this.appendKnowledge([
          `Validate the scaffold output for the top-level module graph.`,
          `Repository root: ${this.repoPath}`,
          ``,
          `## Graph JSON content:`,
          "```json",
          JSON.stringify(topResult, null, 2),
          "```",
        ].join("\n"));

        const checkerResult = checker.getSessionId()
          ? await checker.continue(checkerPrompt)
          : await checker.run(checkerPrompt, this.repoPath);

        if (checkerResult.result.passed) {
          console.log("[Arranger] Scaffold check passed.");
          break;
        }
        if (retry >= 5) throw new Error(`Scaffold check failed after 5 retries: ${JSON.stringify(checkerResult.result.issues)}`);

        console.log(`[Arranger] Scaffold check failed (retry ${retry + 1}/5)`);
        const fixed = await scaffold.continue(buildScaffoldFixPrompt(checkerResult.result.issues));
        topResult = fixed.result;
        finalSessionId = fixed.sessionId;
      }

      return { topResult, finalSessionId };
    });

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
    "pending", "writing", "checking",
  ]);

  private static readonly RECOVERABLE: ReadonlySet<GraphStatusType> = new Set([
    "decomposing", "writing", "checking",
  ]);

  private async processLoop(): Promise<void> {
    const running = new Set<Promise<void>>();

    while (true) {
      while (running.size < this.maxConcurrency) {
        const task = await this.claimNextTask();
        if (!task) break;

        let runner: Promise<void>;
        runner = (task.kind === "graph"
          ? this.processGraphTask(task.nodeId, task.graph)
          : this.processPageTask(task.nodeId, task.ref, task.graph)
        )
          .catch((error) => {
            console.error("[Arranger] Pipeline failed:", error);
          })
          .finally(() => {
            running.delete(runner);
          });

        running.add(runner);
      }

      if (running.size === 0) {
        if (this._paused) {
          await this.waitForResume();
          continue;
        }
        break;
      }
      await Promise.race(running);
    }
  }

  private async resetRecoverableNodes(): Promise<void> {
    const allNodeIds = await this.scanGraphNodes(this.docDir, "");
    let resetCount = 0;

    for (const nodeId of allNodeIds) {
      try {
        const graph = await this.readGraph(nodeId);
        if (!Arranger.RECOVERABLE.has(graph.status)) continue;
        const pageTasks: Record<string, PageTaskType> | undefined = graph.pageTasks
          ? Object.fromEntries(
            Object.entries(graph.pageTasks).map(([ref, task]) => [
              ref,
              { ...task, status: task.status === "done" ? "done" : "pending" } satisfies PageTaskType,
            ]),
          )
          : undefined;
        const hasPendingPages = pageTasks && Object.values(pageTasks).some((task) => task.status !== "done");
        await this.writeGraph(nodeId, {
          ...graph,
          status: hasPendingPages ? "writing" : "pending",
          pageTasks,
          checkerSessionId: undefined,
          writerSessionIds: undefined,
        });
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

  private async withNodeLock<T>(nodeId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.nodeLocks.get(nodeId);
    const waitForPrevious = previous?.catch(() => {}) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = waitForPrevious.then(() => current);
    this.nodeLocks.set(nodeId, tail);
    await waitForPrevious;
    try {
      return await fn();
    } finally {
      release();
      if (this.nodeLocks.get(nodeId) === tail) {
        this.nodeLocks.delete(nodeId);
      }
    }
  }

  private async claimNextTask(): Promise<ArrangerTask | null> {
    if (this._paused) return null;
    const allNodeIds = await this.scanGraphNodes(this.docDir, "");
    for (const nodeId of allNodeIds) {
      try {
        const graph = await this.readGraph(nodeId);
        if (!Arranger.ACTIONABLE.has(graph.status)) continue;

        if (graph.status === "writing" && graph.pageTasks) {
          const nextPage = Object.entries(graph.pageTasks).find(([, task]) => task.status === "pending");
          if (nextPage) {
            await this.updatePageTask(nodeId, nextPage[0], { status: "writing" });
            return { kind: "page", nodeId, ref: nextPage[0], graph };
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
    return this.appendKnowledge(parts.join("\n"));
  }

  private buildGraphCheckerPrompt(nodeId: string, rawGraph: RawGraphType): string {
    return this.appendKnowledge([
      `Validate the decomposer output (graph structure only) for module "${nodeId}".`,
      `Repository root: ${this.repoPath}`,
      ``,
      `## Graph JSON content:`,
      "```json",
      JSON.stringify(rawGraph, null, 2),
      "```",
      ``,
      `Note: Leaf Markdown documents have not been generated yet — validate graph structure only.`,
    ].join("\n"));
  }

  // ─── Agent 循环 ───

  private async decomposeAndCheck(
    nodeId: string,
    prompt: string,
    existing?: { rawGraph?: RawGraphType; decomposerSessionId?: string; checkerSessionId?: string },
  ): Promise<{ rawGraph: RawGraphType; decomposer: IDecomposer }> {
    const decomposer = this.makeDecomposer();
    const checker = this.makeChecker();

    if (existing?.decomposerSessionId) {
      decomposer.restore(existing.decomposerSessionId, this.repoPath);
    }
    if (existing?.checkerSessionId) {
      checker.restore(existing.checkerSessionId, this.repoPath);
    }

    let rawGraph = existing?.rawGraph;
    if (!rawGraph) {
      rawGraph = (await this.withSemaphore(() =>
        decomposer.getSessionId()
          ? decomposer.continue(prompt)
          : decomposer.run(prompt, this.repoPath),
      )).result;
    }

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
      if (retry >= 5) throw new Error(`Decomposer check failed after 5 retries for ${nodeId}`);

      console.log(`[Arranger] Decomposer check failed: ${nodeId} (retry ${retry + 1}/5)`);
      rawGraph = (await this.withSemaphore(() => decomposer.continue(buildDecomposerFixPrompt(checkerResult.result.issues)))).result;
    }
  }

  private async writePage(
    pageNode: GraphNodeType,
    ancestorContext: AncestorContextType | null,
  ): Promise<string> {
    const writer = this.makeWriter();
    return this.withSemaphore(() =>
      this.generatePageContent(writer, pageNode, ancestorContext),
    );
  }

  // ─── 任务调度 ───

  private async processGraphTask(nodeId: string, graph: GraphType): Promise<void> {
    const ancestorContext = await this.buildAncestorContext(nodeId);

    console.log(`[Arranger] Processing graph task: ${nodeId}`);
    let rawGraph: RawGraphType;
    let decomposerSessionId: string;

    try {
      const result = await this.withRetry(async (attempt) => {
        const prompt = this.buildDecompPrompt(nodeId, graph, ancestorContext);
        const existing = attempt === 0 ? {
          rawGraph: graph.status === "checking" && graph.nodes.length > 0 ? { nodes: graph.nodes } : undefined,
          decomposerSessionId: graph.decomposerSessionId,
          checkerSessionId: graph.checkerSessionId,
        } : undefined;
        return this.decomposeAndCheck(nodeId, prompt, existing);
      });
      rawGraph = result.rawGraph;
      decomposerSessionId = result.decomposer.getSessionId() ?? "";
    } catch (e) {
      console.error(`[Arranger] Decompose+check failed for ${nodeId}:`, e);
      await this.updateGraph(nodeId, { status: "error" });
      return;
    }

    console.log(`[Arranger] Decomposed: ${nodeId} → ${rawGraph.nodes.length} child nodes`);
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
      writerSessionIds: undefined,
      pageTasks: hasPages ? pageTasks : undefined,
    });
  }

  private async processPageTask(nodeId: string, ref: string, graph: GraphType): Promise<void> {
    const ancestorContext = await this.buildAncestorContext(nodeId);
    const pageNode = this.findPageNode(graph.nodes, ref);
    if (!pageNode) {
      console.error(`[Arranger] Missing page node for ${nodeId}/${ref}`);
      await this.updateGraph(nodeId, { status: "error" });
      return;
    }

    let content: string;
    try {
      content = await this.withRetry(() => this.writePage(pageNode, ancestorContext));
    } catch (e) {
      console.error(`[Arranger] Write failed for ${nodeId}/${ref}:`, e);
      await this.updatePageTask(nodeId, ref, { status: "error" });
      await this.updateGraph(nodeId, { status: "error" });
      return;
    }

    const destDir = path.join(this.docDir, nodeId);
    await mkdir(destDir, { recursive: true });
    await writeFile(path.join(destDir, `${ref}.md`), content);

    await this.updatePageTask(nodeId, ref, { status: "done" });
    await this.finishNodeIfReady(nodeId);
  }

  // ─── Writer ───

  private async generatePageContent(
    writer: IWriter,
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

    const { result } = await writer.run(this.appendKnowledge(parts.join("\n")), this.repoPath);
    console.log(`[Arranger] Page generated: ${node.name}`);
    return result.content;
  }

  private buildPageTasks(nodes: GraphNodeType[]): Record<string, PageTaskType> {
    return Object.fromEntries(
      nodes
        .filter((node) => node.child.type === "page")
        .map((node) => [
          node.child.ref,
          { status: "pending", retryCount: 0 } satisfies PageTaskType,
        ]),
    );
  }

  private findPageNode(nodes: GraphNodeType[], ref: string): GraphNodeType | undefined {
    return nodes.find((node) => node.child.type === "page" && node.child.ref === ref);
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
    this.notify();
  }

  private async ensureChildGraphs(nodeId: string, nodes: GraphNodeType[]): Promise<void> {
    for (const node of nodes.filter((item) => item.child.type === "graph")) {
      const childId = `${nodeId}/${node.child.ref}`;
      if (await this.fileExists(this.graphFilePath(childId))) continue;
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

  private async finishNodeIfReady(nodeId: string): Promise<void> {
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
    if (changed) this.notify();
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
      if (!entry.isDirectory()) continue;
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
    await this.withNodeLock(nodeId, async () => {
      const graph = await this.readGraph(nodeId);
      Object.assign(graph, patch);
      await this.writeGraph(nodeId, graph);
    });
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

  // ─── Skill 组装 + Flow 分析 ───

  private get projectName(): string {
    return path.basename(this.docDir);
  }

  private async assembleSkill(): Promise<string> {
    const skillDir = path.join(this.repoPath, ".claude", "skills", "doc-drill");

    console.log(`[Arranger] Assembling doc-drill skill at ${skillDir}...`);
    await mkdir(skillDir, { recursive: true });

    await copyFile(
      path.join(SKILL_TEMPLATE_DIR, "SKILL.md"),
      path.join(skillDir, "SKILL.md"),
    );

    // Register the autodoc MCP server in the target repo's .mcp.json so
    // Claude Code picks it up automatically. MCP_PUBLIC_URL lets ops override
    // the endpoint at deploy time (e.g. a central server behind a reverse proxy).
    const mcpUrl = process.env.MCP_PUBLIC_URL ?? "http://localhost:3200/mcp";
    const mcpConfigPath = path.join(this.repoPath, ".mcp.json");
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await readFile(mcpConfigPath, "utf-8"));
    } catch {
      // no existing config; start fresh
    }
    const servers = (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
    servers.autodoc = { type: "http", url: mcpUrl };
    existing.mcpServers = servers;
    await writeFile(mcpConfigPath, JSON.stringify(existing, null, 2));

    console.log(`[Arranger] Skill assembled. Registered MCP server autodoc → ${mcpUrl}`);
    return skillDir;
  }

  private async runFlowAnalysis(): Promise<void> {
    const flowsPath = path.join(this.docDir, "flows.json");
    if (await this.fileExists(flowsPath)) {
      console.log("[Arranger] flows.json already exists, skipping flow analysis.");
      return;
    }

    console.log("[Arranger] Running flow analysis...");
    const { result } = await this.withRetry(async () => {
      const analyzer = this.makeFlowAnalyzer();
      const prompt = `Analyze the documented codebase and produce 3-7 typical business interaction flows.\nRepository root: ${this.repoPath}`;
      return analyzer.run(prompt, this.repoPath);
    });

    await writeFile(flowsPath, JSON.stringify(result, null, 2));
    console.log(`[Arranger] Flow analysis complete. ${result.flows.length} flows generated.`);
  }

  // ─── 重试 ───

  private async withRetry<T>(fn: (attempt: number) => Promise<T>, maxRetries = 3): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn(attempt);
      } catch (e) {
        if (attempt >= maxRetries) throw e;
        const delay = Math.min(2000 * 2 ** attempt, 30_000);
        console.log(`[Arranger] Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${e}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
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

  private async loadKnowledge(): Promise<string> {
    const name = path.basename(this.docDir);
    try {
      const content = (await readFile(knowledgePathOf(name), "utf-8")).trim();
      if (content) console.log(`[Arranger] Loaded knowledge.md (${content.length} chars) for ${name}`);
      return content;
    } catch {
      return "";
    }
  }

  private appendKnowledge(prompt: string): string {
    if (!this.knowledge) return prompt;
    const header = this.language === "en" ? "# Repository Domain Knowledge" : "# 仓库领域知识";
    return `${prompt}\n\n${header}\n${this.knowledge}`;
  }
}
