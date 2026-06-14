import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GraphNode, Language } from "../agents/schemas/schema.js";
import { DocGit } from "../mcp/docGit.js";
import { DOC_ROOT, knowledgePathOf } from "../souko/registry.js";
import { appendRunLog } from "../souko/runLog.js";
import { AgentFactory, resolveAgentBackends } from "./arranger/agentFactory.js";
import { GraphStore, type DecompositionReviewItem } from "./arranger/graphStore.js";
import { InsightCollector } from "./arranger/insightCollector.js";
import { Pipeline } from "./arranger/pipeline.js";
import { PromptBuilder } from "./arranger/promptBuilder.js";
import { Semaphore, Signal } from "./arranger/runtime.js";
import type {
  AgentBackends,
  ArrangerConfig,
  ArrangerOptions,
  ArrangerTask,
  DecompositionReviewMode,
  Progress,
} from "./arranger/types.js";

export type {
  AgentBackend,
  AgentBackends,
  AgentRole,
  ArrangerConfig,
  ArrangerOptions,
  DecompositionReviewMode,
  NodeProgress,
  Progress,
} from "./arranger/types.js";

export class Arranger {
  private readonly maxConcurrency: number;
  private readonly agentBackends: AgentBackends;
  private readonly language: Language;
  private readonly decompositionReview: DecompositionReviewMode;
  private readonly checkerEnabled: boolean;
  private readonly insightEnabled: boolean;
  private readonly insightConcurrency: number;
  private readonly sem: Semaphore;
  private readonly docGit = new DocGit(DOC_ROOT);
  private readonly agentFactory: AgentFactory;
  private readonly resumeSignal = new Signal();
  private readonly reviewSignal = new Signal();
  private insightCollector: InsightCollector | null = null;
  private _paused = false;
  private _haltedByError = false;
  private repoPath = "";
  private docDir = "";
  private knowledge = "";
  private currentPhase: Progress["phase"] = "idle";
  private listeners = new Set<() => void>();
  private graphStore: GraphStore | null = null;
  private pipeline: Pipeline | null = null;

  constructor(options?: ArrangerOptions) {
    this.maxConcurrency = options?.maxConcurrency ?? 8;
    this.agentBackends = resolveAgentBackends(options);
    this.language = options?.language ?? "zh";
    this.decompositionReview = options?.decompositionReview ?? "off";
    this.checkerEnabled = options?.checkerEnabled ?? true;
    this.insightEnabled = options?.insightEnabled ?? false;
    this.insightConcurrency = options?.insightConcurrency ?? 2;
    this.sem = new Semaphore(this.maxConcurrency);
    this.agentFactory = new AgentFactory(this.agentBackends, this.language);
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
    this.resumeSignal.fire();
    this.notify();
  }

  async pauseSubgraph(nodeId: string): Promise<void> {
    const { store } = this.activeRuntime();
    await store.pauseNode(nodeId);
    console.log(`[Arranger] Paused subgraph: ${nodeId}`);
    this.notify();
  }

  async resumeSubgraph(nodeId: string): Promise<void> {
    const { store } = this.activeRuntime();
    await store.resumeNode(nodeId);
    console.log(`[Arranger] Resumed subgraph: ${nodeId}`);
    this.reviewSignal.fire();
    this.notify();
  }

  onProgress(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getConfig(): ArrangerConfig {
    return {
      maxConcurrency: this.maxConcurrency,
      agentBackends: this.agentBackends,
      language: this.language,
      decompositionReview: this.decompositionReview,
      checkerEnabled: this.checkerEnabled,
      insightEnabled: this.insightEnabled,
    };
  }

  async getProgress(): Promise<Progress> {
    if (!this.graphStore) return { phase: "idle", counts: {}, nodes: [], paused: false };
    return this.graphStore.getProgress(this.currentPhase, this._paused);
  }

  async run(repoPath: string, docDir = path.resolve("src/souko/doc", path.basename(path.resolve(repoPath)))): Promise<void> {
    const { pipeline, store } = await this.prepareRun(repoPath, docDir);

    await appendRunLog(store.projectName, `arranger run repo=${repoPath} backends=${JSON.stringify(this.agentBackends)} language=${this.language} concurrency=${this.maxConcurrency === 0 ? 'unlimited' : this.maxConcurrency} review=${this.decompositionReview} checker=${this.checkerEnabled ? "on" : "off"} insight=${this.insightEnabled ? "on" : "off"}`);

    if (!(await store.hasTopGraph())) {
      console.log("[Arranger] Running scaffold...");
      await this.enterPhase(store.projectName, "scaffold");
      await pipeline.runScaffold();
    } else {
      console.log("[Arranger] top.json already exists, skipping scaffold.");
      await appendRunLog(store.projectName, `scaffold skip (top.json exists)`);
    }

    const recoveredCount = await store.resetRecoverableNodes();
    if (recoveredCount > 0) {
      console.log(`[Arranger] Recovered ${recoveredCount} node(s) to pending.`);
    }

    const errorResetCount = await store.resetErrorNodes();
    if (errorResetCount > 0) {
      console.log(`[Arranger] Reset ${errorResetCount} error node(s) for fresh re-run.`);
    }

    await this.completeRun(store, pipeline);
    await appendRunLog(store.projectName, `arranger done`);
    console.log("[Arranger] Done.");
  }

  async resetErrorsAndResume(): Promise<number> {
    const { pipeline, store } = this.activeRuntime();
    const resetCount = await store.resetErrorNodes();

    if (resetCount > 0) {
      console.log(`[Arranger] Reset ${resetCount} error node(s) to pending.`);
      await this.completeRun(store, pipeline);
    }

    return resetCount;
  }

  async listDecompositionReviews(): Promise<DecompositionReviewItem[]> {
    const { store } = this.activeRuntime();
    return store.listDecompositionReviews();
  }

  async updateDecompositionReview(id: string, nodes: GraphNode[]): Promise<void> {
    const { store } = this.activeRuntime();
    await store.updateDecompositionReview(id, nodes);
    this.reviewSignal.fire();
  }

  async approveDecompositionReview(id: string): Promise<void> {
    const { pipeline, store } = this.activeRuntime();
    let collectInsight: (() => void) | null = null;
    if (id.startsWith("graph:")) {
      const nodeId = id.slice("graph:".length);
      try {
        const graph = await store.getGraphReview(nodeId);
        const sessionId = graph.decomposerSessionId ?? graph.sessionId;
        collectInsight = () => pipeline.enqueueDecomposerInsight(nodeId, graph.codeScope, sessionId);
      } catch { /* insight is best-effort; ignore */ }
    }
    await store.approveDecompositionReview(id);
    collectInsight?.();
    this.reviewSignal.fire();
  }

  async rejectDecompositionReview(id: string, feedback: string): Promise<void> {
    const { pipeline } = this.activeRuntime();
    const trimmed = feedback.trim();
    if (!trimmed) throw new Error("Feedback required");
    if (id === "scaffold") {
      await pipeline.redoScaffoldReview(trimmed);
    } else if (id.startsWith("graph:")) {
      await pipeline.redoGraphReview(id.slice("graph:".length), trimmed);
    } else {
      throw new Error(`Invalid review id: ${id}`);
    }
    this.reviewSignal.fire();
  }

  private async prepareRun(repoPath: string, docDir: string): Promise<{ store: GraphStore; pipeline: Pipeline }> {
    this.repoPath = repoPath;
    this.docDir = docDir;
    this.knowledge = await this.loadKnowledge();

    const store = new GraphStore(docDir, () => {
      this.notify();
      this.reviewSignal.fire();
    });
    const promptBuilder = new PromptBuilder(repoPath, this.language, this.knowledge);
    const insightCollector = this.insightEnabled
      ? new InsightCollector({
          repoPath,
          store,
          promptBuilder,
          language: this.language,
          concurrency: this.insightConcurrency,
        })
      : null;
    const pipeline = new Pipeline({
      repoPath,
      store,
      agentFactory: this.agentFactory,
      promptBuilder,
      semaphore: this.sem,
      decompositionReview: this.decompositionReview,
      checkerEnabled: this.checkerEnabled,
      insightCollector: insightCollector ?? undefined,
      shouldAbort: () => this._haltedByError,
    });

    this.graphStore = store;
    this.pipeline = pipeline;
    this.insightCollector = insightCollector;

    await store.ensureRoot();
    await this.docGit.ensureRepo(store.projectName);

    return { store, pipeline };
  }

  private activeRuntime(): { store: GraphStore; pipeline: Pipeline } {
    if (!this.docDir || !this.graphStore || !this.pipeline) {
      throw new Error("No active project. Run first.");
    }
    return { store: this.graphStore, pipeline: this.pipeline };
  }

  /** Shared tail of a run: process all nodes, then assemble, analyze flows, and drain insights. */
  private async completeRun(store: GraphStore, pipeline: Pipeline): Promise<void> {
    await this.enterPhase(store.projectName, "processing");
    await this.processLoop(store, pipeline);

    const counts = await store.countStatuses();
    if ((counts.error ?? 0) > 0) {
      console.log(`[Arranger] ${counts.error} node(s) in error state. Stopping — use retry-errors to resume.`);
      this.setPhase("idle");
      throw new Error(`${counts.error} node(s) failed. Use "Retry failed nodes" to reprocess.`);
    }

    await this.enterPhase(store.projectName, "assembling");
    await pipeline.assembleSkill(this.repoPath);

    await this.enterPhase(store.projectName, "flows");
    await pipeline.runFlowAnalysis();

    await this.drainInsights(store.projectName);
    this.setPhase("idle");
  }

  private async processLoop(store: GraphStore, pipeline: Pipeline): Promise<void> {
    const running = new Set<Promise<void>>();
    this._haltedByError = false;

    while (true) {
      while (this.maxConcurrency === 0 || running.size < this.maxConcurrency) {
        if (this._paused || this._haltedByError) break;
        const task = await store.claimNextTask();
        if (!task) break;

        const runner: Promise<void> = this.processTask(task, pipeline)
          .catch(() => {
            if (!this._haltedByError) {
              this._haltedByError = true;
              console.log("[Arranger] Task failed — halting new tasks, waiting for in-flight tasks to finish.");
            }
          })
          .finally(() => {
            running.delete(runner);
          });

        running.add(runner);
      }

      if (running.size === 0) {
        if (this._haltedByError) break;
        if (this._paused) {
          await this.resumeSignal.wait();
          continue;
        }
        const seen = this.reviewSignal.snapshot();
        const hasReviews = await store.hasPendingReviews();
        const hasPaused = await store.hasPausedNodes();
        if (hasReviews || hasPaused) {
          if (this.reviewSignal.snapshot() !== seen) continue;
          this.setPhase("awaiting-review");
          await this.reviewSignal.wait(seen);
          this.setPhase("processing");
          continue;
        }
        break;
      }
      await Promise.race(running);
    }
  }

  private processTask(task: ArrangerTask, pipeline: Pipeline): Promise<void> {
    return task.kind === "graph"
      ? pipeline.processGraphTask(task.nodeId, task.graph)
      : pipeline.processPageTask(task.nodeId, task.ref, task.graph);
  }

  private setPhase(phase: Progress["phase"]): void {
    this.currentPhase = phase;
    this.notify();
  }

  private async enterPhase(projectName: string, phase: Progress["phase"]): Promise<void> {
    this.setPhase(phase);
    await appendRunLog(projectName, `phase=${phase}`);
  }

  private async drainInsights(projectName: string): Promise<void> {
    if (!this.insightCollector) return;
    await appendRunLog(projectName, `insight drain start`);
    await this.insightCollector.drain();
    await appendRunLog(projectName, `insight drain done`);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
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
}
