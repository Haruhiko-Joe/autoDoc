import { Codex } from "@openai/codex-sdk";
import type { Thread } from "@openai/codex-sdk";
import { RawGraph, toOutputSchema } from "../schemas/schema.js";
import type { AgentResult, IDecomposer, Language } from "../schemas/schema.js";
import { decomposerInstruction } from "../instructions/cn/decomposer.js";
import { decomposerInstructionEn } from "../instructions/en/decomposer.js";

const outputSchema = toOutputSchema(RawGraph);

export class codexDecomposer implements IDecomposer {
  private codex: Codex | null = null;
  private thread: Thread | null = null;
  private threadId: string | undefined;
  private cwd: string | undefined;
  private readonly language: Language;

  constructor(language: Language = "zh") {
    this.language = language;
  }

  getSessionId(): string | undefined { return this.threadId; }

  restore(sessionId: string, workpath: string): void {
    this.threadId = sessionId;
    this.cwd = workpath;
  }

  async run(prompt: string, workpath: string): Promise<AgentResult<RawGraph>> {
    if (this.threadId) {
      throw new Error("Session already active. Use continue() or create a new codexDecomposer instance.");
    }
    this.cwd = workpath;
    const instruction = this.language === "en" ? decomposerInstructionEn : decomposerInstruction;
    this.codex = new Codex({
      config: {
        profile: "decomposer",
        developer_instructions: instruction,
      },
    });
    this.thread = this.codex.startThread({
      workingDirectory: workpath,
      skipGitRepoCheck: true,
    });
    return this.execute(prompt);
  }

  async continue(prompt: string): Promise<AgentResult<RawGraph>> {
    if (!this.threadId) {
      throw new Error("No active session. Call run() first.");
    }
    if (!this.codex) {
      const instruction = this.language === "en" ? decomposerInstructionEn : decomposerInstruction;
      this.codex = new Codex({
        config: {
          profile: "decomposer",
          developer_instructions: instruction,
        },
      });
    }
    if (!this.thread) {
      this.thread = this.codex.resumeThread(this.threadId, {
        workingDirectory: this.cwd,
        skipGitRepoCheck: true,
      });
    }
    return this.execute(prompt);
  }

  private async execute(prompt: string): Promise<AgentResult<RawGraph>> {
    if (!this.thread) throw new Error("No active thread");
    const turn = await this.thread.run(prompt, { outputSchema });
    const threadId = this.thread.id;
    if (!threadId) throw new Error("Thread has no ID after execution");
    this.threadId = threadId;
    const result = RawGraph.parse(JSON.parse(turn.finalResponse));
    return { sessionId: threadId, result };
  }
}