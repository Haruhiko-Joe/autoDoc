import type {
  Language,
  UpdaterOutput as UpdaterOutputType,
  IUpdater,
  AncestorContext as AncestorContextType,
} from "../agents/schemas/schema.js";
import type { AgentBackend } from "./arranger.js";
import { claudeUpdater, codexUpdater } from "../agents/tsukai/index.js";
import * as git from "../git/repoManager.js";
import { triage, buildAncestorContext, type AffectedGraph, type TriageResult } from "./triage.js";

// ─── Semaphore (same pattern as Arranger) ────────────────────

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

// ─── Types ───────────────────────────────────────────────────

export interface IncrementalUpdaterOptions {
  project: string;
  repoDir: string;
  docDir: string;
  prevCommit: string;
  newCommit: string;
  changedFiles: string[];
  language: Language;
  backend: AgentBackend;
  maxConcurrency?: number;
}

// ─── IncrementalUpdater ──────────────────────────────────────

export class IncrementalUpdater {
  private readonly project: string;
  private readonly repoDir: string;
  private readonly docDir: string;
  private readonly prevCommit: string;
  private readonly newCommit: string;
  private readonly changedFiles: string[];
  private readonly language: Language;
  private readonly backend: AgentBackend;
  private readonly sem: Semaphore;
  private listeners = new Set<() => void>();

  constructor(opts: IncrementalUpdaterOptions) {
    this.project = opts.project;
    this.repoDir = opts.repoDir;
    this.docDir = opts.docDir;
    this.prevCommit = opts.prevCommit;
    this.newCommit = opts.newCommit;
    this.changedFiles = opts.changedFiles;
    this.language = opts.language;
    this.backend = opts.backend;
    this.sem = new Semaphore(opts.maxConcurrency ?? 4);
  }

  onProgress(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  // ─── Main entry ────────────────────────────────────────────

  async run(): Promise<UpdaterOutputType> {
    // Phase 1: triage
    console.log(`[IncrementalUpdater] Triaging ${this.changedFiles.length} changed files...`);
    const result = await triage(this.docDir, this.changedFiles);

    console.log(
      `[IncrementalUpdater] ${result.affected.size} graphs affected, ${result.unmatched.length} unmatched files`,
    );
    for (const [id, ag] of result.affected) {
      console.log(`  ${id}: ${ag.matchedFiles.length} files, pages=[${ag.affectedPageRefs.join(", ")}]`);
    }

    if (result.affected.size === 0 && result.unmatched.length === 0) {
      return { summary: "No documentation changes needed.", touched: [] };
    }

    // Phase 2: topological execution
    const graphResults = await this.executeTopological(result);

    // Phase 3: unmatched fallback — top-level agent
    let unmatchedResult: UpdaterOutputType | undefined;
    if (result.unmatched.length > 0) {
      console.log(`[IncrementalUpdater] Running top-level agent for ${result.unmatched.length} unmatched files...`);
      unmatchedResult = await this.runSingleUpdater(
        undefined, // no graphNodeId — full scope
        result.unmatched,
        null, // no ancestor context for top-level
      );
    }

    // Phase 4: merge
    return this.mergeResults(graphResults, unmatchedResult);
  }

  // ─── Topological execution ─────────────────────────────────

  private async executeTopological(
    triageResult: TriageResult,
  ): Promise<Map<string, UpdaterOutputType>> {
    const { affected } = triageResult;
    if (affected.size === 0) return new Map();

    const results = new Map<string, UpdaterOutputType>();

    // Compute in-degree: count of affected child graphs still pending.
    const inDegree = new Map<string, number>();
    // Reverse map: child → parent IDs that depend on it.
    const dependents = new Map<string, string[]>();

    for (const [id, ag] of affected) {
      const deps = ag.childGraphIds.filter((c) => affected.has(c));
      inDegree.set(id, deps.length);
      for (const dep of deps) {
        const list = dependents.get(dep) ?? [];
        list.push(id);
        dependents.set(dep, list);
      }
    }

    // Seed the ready queue with zero-in-degree graphs.
    const ready: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) ready.push(id);
    }

    // Process with sliding-window concurrency.
    const running = new Set<Promise<void>>();

    const launchIfReady = () => {
      while (ready.length > 0 && running.size < this.sem["max"]) {
        const id = ready.shift()!;
        const ag = affected.get(id)!;
        const runner = this.processGraph(id, ag)
          .then((output) => {
            results.set(id, output);
            // Decrement in-degree for dependents.
            for (const parentId of dependents.get(id) ?? []) {
              const newDeg = inDegree.get(parentId)! - 1;
              inDegree.set(parentId, newDeg);
              if (newDeg === 0) ready.push(parentId);
            }
          })
          .catch((err) => {
            console.error(`[IncrementalUpdater] Graph ${id} failed:`, err);
            results.set(id, {
              summary: `Error updating ${id}: ${err}`,
              touched: [],
            });
            // Still release dependents so they can proceed.
            for (const parentId of dependents.get(id) ?? []) {
              const newDeg = inDegree.get(parentId)! - 1;
              inDegree.set(parentId, newDeg);
              if (newDeg === 0) ready.push(parentId);
            }
          })
          .finally(() => {
            running.delete(runner);
            this.notify();
          });
        running.add(runner);
      }
    };

    launchIfReady();

    while (running.size > 0 || ready.length > 0) {
      if (running.size > 0) {
        await Promise.race(running);
      }
      launchIfReady();
    }

    return results;
  }

  // ─── Per-graph processing ──────────────────────────────────

  private async processGraph(
    graphNodeId: string,
    ag: AffectedGraph,
  ): Promise<UpdaterOutputType> {
    console.log(`[IncrementalUpdater] Processing graph: ${graphNodeId}`);
    const ancestorContext = await buildAncestorContext(this.docDir, graphNodeId);
    return this.withSemaphore(() =>
      this.runSingleUpdater(graphNodeId, ag.matchedFiles, ancestorContext),
    );
  }

  private async runSingleUpdater(
    graphNodeId: string | undefined,
    files: string[],
    ancestorContext: AncestorContextType | null,
  ): Promise<UpdaterOutputType> {
    const diffPatch = await git.diffPatch(
      this.repoDir, this.prevCommit, this.newCommit, files,
    );

    const updater: IUpdater =
      this.backend === "codex"
        ? new codexUpdater(
            this.project,
            {
              docDir: this.docDir,
              repoDir: this.repoDir,
              prevCommit: this.prevCommit,
              newCommit: this.newCommit,
              changedFiles: files,
              diffPatch,
              graphNodeId,
              ancestorContext,
            },
            this.language,
          )
        : new claudeUpdater(
            this.project,
            {
              docDir: this.docDir,
              repoDir: this.repoDir,
              prevCommit: this.prevCommit,
              newCommit: this.newCommit,
              changedFiles: files,
              diffPatch,
              graphNodeId,
              ancestorContext,
            },
            this.language,
          );

    const label = graphNodeId ?? "top-level";
    const prompt = graphNodeId
      ? `项目 ${this.project} 的图节点 ${graphNodeId} 在 ${this.prevCommit.slice(0, 8)} → ${this.newCommit.slice(0, 8)} 之间发生了 ${files.length} 个文件改动。` +
        `请按 SOP 局部更新该图节点范围内的文档，使其与新代码一致。`
      : `项目 ${this.project} 在 ${this.prevCommit.slice(0, 8)} → ${this.newCommit.slice(0, 8)} 之间有 ${files.length} 个文件改动未匹配到现有文档节点。` +
        `请从 top.json 开始往下钻，为这些文件找到合适的位置并更新文档。`;

    console.log(`[IncrementalUpdater] Invoking ${this.backend} updater for ${label} (${files.length} files)`);
    const { result } = await updater.run(prompt, this.repoDir);
    console.log(`[IncrementalUpdater] ${label} done: ${result.touched.length} files touched`);
    return result;
  }

  // ─── Helpers ───────────────────────────────────────────────

  private async withSemaphore<T>(fn: () => Promise<T>): Promise<T> {
    await this.sem.acquire();
    try {
      return await fn();
    } finally {
      this.sem.release();
    }
  }

  private mergeResults(
    graphResults: Map<string, UpdaterOutputType>,
    unmatchedResult?: UpdaterOutputType,
  ): UpdaterOutputType {
    const touched: UpdaterOutputType["touched"] = [];
    const summaryParts: string[] = [];

    for (const [id, r] of graphResults) {
      touched.push(...r.touched);
      if (r.summary) summaryParts.push(`[${id}] ${r.summary}`);
    }
    if (unmatchedResult) {
      touched.push(...unmatchedResult.touched);
      if (unmatchedResult.summary) summaryParts.push(`[unmatched] ${unmatchedResult.summary}`);
    }

    const summary =
      summaryParts.length > 0
        ? `增量更新涉及 ${graphResults.size} 个图节点。${summaryParts.join(" ")}`
        : "No documentation changes needed.";

    return { summary, touched };
  }
}
