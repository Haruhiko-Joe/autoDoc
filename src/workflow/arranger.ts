import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Language } from "../agents/schemas/schema.js";
import { DocGit } from "../mcp/docGit.js";
import { DOC_ROOT, knowledgePathOf } from "../souko/registry.js";
import { appendRunLog } from "../souko/runLog.js";
import { AgentFactory, resolveAgentBackends } from "./arranger/agentFactory.js";
import { GraphStore } from "./arranger/graphStore.js";
import { Pipeline } from "./arranger/pipeline.js";
import { PromptBuilder } from "./arranger/promptBuilder.js";
import { Semaphore } from "./arranger/runtime.js";
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
  private readonly sem: Semaphore;
  private readonly docGit = new DocGit(DOC_ROOT);
  private readonly agentFactory: AgentFactory;
  private _paused = false;
  private _resumeResolve: (() => void) | null = null;
  private _resumePromise: Promise<void> | null = null;
  private _reviewResolve: (() => void) | null = null;
  private _reviewPromise: Promise<void> | null = null;
  private _reviewSeq = 0;
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
    if (this._resumeResolve) {
      this._resumeResolve();
      this._resumeResolve = null;
      this._resumePromise = null;
    }
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
    };
  }

  async getProgress(): Promise<Progress> {
    if (!this.graphStore) return { phase: "idle", counts: {}, nodes: [], paused: false };
    return this.graphStore.getProgress(this.currentPhase, this._paused);
  }

  async run(repoPath: string, docDir = path.resolve("src/souko/doc", path.basename(path.resolve(repoPath)))): Promise<void> {
    const { pipeline, store } = await this.prepareRun(repoPath, docDir);

    await appendRunLog(store.projectName, `arranger run repo=${repoPath} backends=${JSON.stringify(this.agentBackends)} language=${this.language} concurrency=${this.maxConcurrency === 0 ? 'unlimited' : this.maxConcurrency} review=${this.decompositionReview} checker=${this.checkerEnabled ? "on" : "off"}`);

    if (!(await store.hasTopGraph())) {
      console.log("[Arranger] Running scaffold...");
      this.currentPhase = "scaffold";
      this.notify();
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

    this.currentPhase = "processing";
    this.notify();
    await appendRunLog(store.projectName, `phase=processing`);
    await this.processLoop(store, pipeline);

    const counts = await store.countStatuses();
    if ((counts.error ?? 0) > 0) {
      console.log(`[Arranger] ${counts.error} node(s) in error state. Stopping — use retry-errors to resume.`);
      this.currentPhase = "idle";
      this.notify();
      throw new Error(`${counts.error} node(s) failed. Use "Retry failed nodes" to reprocess.`);
    }

    this.currentPhase = "assembling";
    this.notify();
    await appendRunLog(store.projectName, `phase=assembling`);
    await pipeline.assembleSkill(repoPath);

    this.currentPhase = "flows";
    this.notify();
    await appendRunLog(store.projectName, `phase=flows`);
    await pipeline.runFlowAnalysis();

    this.currentPhase = "idle";
    this.notify();
    await appendRunLog(store.projectName, `arranger done`);
    console.log("[Arranger] Done.");
  }

  async resetErrorsAndResume(): Promise<number> {
    const { pipeline, store } = this.activeRuntime();
    const resetCount = await store.resetErrorNodes();

    if (resetCount > 0) {
      console.log(`[Arranger] Reset ${resetCount} error node(s) to pending.`);
      this.currentPhase = "processing";
      this.notify();
      await this.processLoop(store, pipeline);

      this.currentPhase = "assembling";
      this.notify();
      await pipeline.assembleSkill(this.repoPath);

      this.currentPhase = "flows";
      this.notify();
      await pipeline.runFlowAnalysis();

      this.currentPhase = "idle";
      this.notify();
    }

    return resetCount;
  }

  async listDecompositionReviews(): Promise<Awaited<ReturnType<GraphStore["listDecompositionReviews"]>>> {
    const { store } = this.activeRuntime();
    return store.listDecompositionReviews();
  }

  async updateDecompositionReview(id: string, nodes: Parameters<GraphStore["updateDecompositionReview"]>[1]): Promise<void> {
    const { store } = this.activeRuntime();
    await store.updateDecompositionReview(id, nodes);
    this.wakeReviewWaiters();
  }

  async approveDecompositionReview(id: string): Promise<void> {
    const { store } = this.activeRuntime();
    await store.approveDecompositionReview(id);
    this.wakeReviewWaiters();
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
    this.wakeReviewWaiters();
  }

  private async prepareRun(repoPath: string, docDir: string): Promise<{ store: GraphStore; pipeline: Pipeline }> {
    this.repoPath = repoPath;
    this.docDir = docDir;
    this.knowledge = await this.loadKnowledge();

    const store = new GraphStore(docDir, () => {
      this.notify();
      this.wakeReviewWaiters();
    });
    const promptBuilder = new PromptBuilder(repoPath, this.language, this.knowledge);
    const pipeline = new Pipeline({
      repoPath,
      store,
      agentFactory: this.agentFactory,
      promptBuilder,
      semaphore: this.sem,
      decompositionReview: this.decompositionReview,
      checkerEnabled: this.checkerEnabled,
    });

    this.graphStore = store;
    this.pipeline = pipeline;

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

  private async processLoop(store: GraphStore, pipeline: Pipeline): Promise<void> {
    const running = new Set<Promise<void>>();

    while (true) {
      while (this.maxConcurrency === 0 || running.size < this.maxConcurrency) {
        if (this._paused) break;
        const task = await store.claimNextTask();
        if (!task) break;

        let runner: Promise<void>;
        runner = this.processTask(task, pipeline)
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
        const seqBefore = this._reviewSeq;
        if (await store.hasPendingReviews()) {
          if (this._reviewSeq !== seqBefore) continue;
          this.currentPhase = "awaiting-review";
          this.notify();
          await this.waitForReviewChange(seqBefore);
          this.currentPhase = "processing";
          this.notify();
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

  private waitForResume(): Promise<void> {
    if (!this._resumePromise) {
      this._resumePromise = new Promise<void>((resolve) => {
        this._resumeResolve = resolve;
      });
    }
    return this._resumePromise;
  }

  private waitForReviewChange(seqSnapshot: number): Promise<void> {
    if (this._reviewSeq !== seqSnapshot) return Promise.resolve();
    if (!this._reviewPromise) {
      this._reviewPromise = new Promise<void>((resolve) => {
        this._reviewResolve = resolve;
      });
    }
    return this._reviewPromise;
  }

  private wakeReviewWaiters(): void {
    this._reviewSeq++;
    if (!this._reviewResolve) return;
    this._reviewResolve();
    this._reviewResolve = null;
    this._reviewPromise = null;
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
