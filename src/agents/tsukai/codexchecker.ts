import { Codex } from "@openai/codex-sdk";
import type { Thread } from "@openai/codex-sdk";
import { CheckerOutput, toOutputSchema } from "../schemas/schema.js";
import type { AgentResult, IChecker, Language } from "../schemas/schema.js";
import { checkerInstruction } from "../instructions/cn/checker.js";
import { checkerInstructionEn } from "../instructions/en/checker.js";

const outputSchema = toOutputSchema(CheckerOutput);

export class codexChecker implements IChecker {
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

  async run(prompt: string, workpath: string): Promise<AgentResult<CheckerOutput>> {
    if (this.threadId) {
      throw new Error("Session already active. Use continue() or create a new codexChecker instance.");
    }
    this.cwd = workpath;
    const instruction = this.language === "en" ? checkerInstructionEn : checkerInstruction;
    this.codex = new Codex({
      config: {
        profile: "checker",
        developer_instructions: instruction,
      },
    });
    this.thread = this.codex.startThread({
      workingDirectory: workpath,
      skipGitRepoCheck: true,
    });
    return this.execute(prompt);
  }

  async continue(prompt: string): Promise<AgentResult<CheckerOutput>> {
    if (!this.threadId) {
      throw new Error("No active session. Call run() first.");
    }
    if (!this.codex) {
      const instruction = this.language === "en" ? checkerInstructionEn : checkerInstruction;
      this.codex = new Codex({
        config: {
          profile: "checker",
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

  private async execute(prompt: string): Promise<AgentResult<CheckerOutput>> {
    if (!this.thread) throw new Error("No active thread");
    const turn = await this.thread.run(prompt, { outputSchema });
    const threadId = this.thread.id;
    if (!threadId) throw new Error("Thread has no ID after execution");
    this.threadId = threadId;
    const result = CheckerOutput.parse(JSON.parse(turn.finalResponse));
    return { sessionId: threadId, result };
  }
}
