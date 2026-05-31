import { decomposerInstruction } from "../../agents/instructions/decomposer.js";
import { writerInstruction } from "../../agents/instructions/writer.js";
import type { Language } from "../../agents/schemas/schema.js";
import { InsightOutput } from "../../agents/schemas/schema.js";
import { ClaudeAgent } from "../../agents/tsukai/claudeBase.js";
import { CodexAgent } from "../../agents/tsukai/codexBase.js";
import { appendInsight } from "../../souko/insightLog.js";
import { appendRunLog } from "../../souko/runLog.js";
import type { GraphStore } from "./graphStore.js";
import type { PromptBuilder } from "./promptBuilder.js";
import { Semaphore, withSemaphore, withTimeout } from "./runtime.js";
import type { AgentBackend } from "./types.js";

export interface InsightTask {
  scope: "decomposer" | "writer";
  nodeId: string;
  ref?: string;
  codeScope: string[];
  sessionId: string;
  backend: AgentBackend;
  profile: "decomposer" | "writer";
}

interface InsightCollectorOptions {
  repoPath: string;
  store: GraphStore;
  promptBuilder: PromptBuilder;
  language: Language;
  concurrency?: number;
}

export class InsightCollector {
  private readonly sem: Semaphore;
  private readonly seen = new Set<string>();
  private pending = 0;
  private drainResolve: (() => void) | null = null;

  constructor(private readonly options: InsightCollectorOptions) {
    this.sem = new Semaphore(options.concurrency ?? 2);
  }

  enqueue(task: InsightTask): void {
    if (!task.sessionId) return;
    const key = `${task.scope}:${task.nodeId}:${task.ref ?? ""}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);

    this.pending++;
    void withSemaphore(this.sem, () => this.extract(task))
      .catch(async (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        await appendRunLog(this.options.store.projectName, `insight error scope=${task.scope} node=${task.nodeId}${task.ref ? ` ref=${task.ref}` : ""} error=${msg.slice(0, 200)}`);
      })
      .finally(() => {
        this.pending--;
        if (this.pending === 0) this.drainResolve?.();
      });
  }

  async drain(): Promise<void> {
    if (this.pending === 0) return;
    return new Promise((resolve) => { this.drainResolve = resolve; });
  }

  private async extract(task: InsightTask): Promise<void> {
    const { promptBuilder, repoPath, store, language } = this.options;
    await appendRunLog(store.projectName, `insight invoke scope=${task.scope} node=${task.nodeId}${task.ref ? ` ref=${task.ref}` : ""} backend=${task.backend}`);

    // Reuse the worker's read-the-code session as-is: keep the worker's own system
    // prompt (decomposer/writer instruction) and backend/profile, only swap the
    // output schema to InsightOutput. The review guidance lives in the user prompt.
    const instruction = task.scope === "decomposer" ? decomposerInstruction : writerInstruction;
    const ex = task.backend === "claude"
      ? new ClaudeAgent(language, { instruction, outputSchema: InsightOutput, errorPrefix: "insight" })
      : new CodexAgent(language, { profile: task.profile, instruction, outputSchema: InsightOutput, errorPrefix: "insight" });
    ex.restore(task.sessionId, repoPath);

    const nodeName = task.ref ?? task.nodeId.split("/").pop() ?? task.nodeId;
    const { result } = await withTimeout(
      () => ex.continue(promptBuilder.insightPrompt(task.scope, nodeName, task.codeScope)),
      10 * 60_000,
      `insight ${task.scope} ${task.nodeId}`,
    );

    if (!result.hasFindings || result.insights.length === 0) {
      await appendRunLog(store.projectName, `insight done scope=${task.scope} node=${task.nodeId}${task.ref ? ` ref=${task.ref}` : ""} count=0`);
      return;
    }

    await appendInsight(store.projectName, {
      ts: new Date().toISOString(),
      scope: task.scope,
      nodeId: task.nodeId,
      ...(task.ref ? { ref: task.ref } : {}),
      codeScope: task.codeScope,
      insights: result.insights,
    });
    await appendRunLog(store.projectName, `insight done scope=${task.scope} node=${task.nodeId}${task.ref ? ` ref=${task.ref}` : ""} count=${result.insights.length}`);
  }
}
