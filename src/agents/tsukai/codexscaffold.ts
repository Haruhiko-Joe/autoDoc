import { Codex } from "@openai/codex-sdk";
import type { Thread } from "@openai/codex-sdk";
import { RawTopGraph, toOutputSchema } from "../schemas/schema.js";
import type { AgentResult, IScaffold, Language } from "../schemas/schema.js";
import { scaffoldInstruction } from "../instructions/cn/scaffold.js";
import { scaffoldInstructionEn } from "../instructions/en/scaffold.js";

const outputSchema = toOutputSchema(RawTopGraph);

export class codexScaffold implements IScaffold {
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

  async run(prompt: string, workpath: string): Promise<AgentResult<RawTopGraph>> {
    if (this.threadId) {
      throw new Error("Session already active. Use continue() or create a new codexScaffold instance.");
    }
    this.cwd = workpath;
    const instruction = this.language === "en" ? scaffoldInstructionEn : scaffoldInstruction;
    this.codex = new Codex({
      config: {
        profile: "scaffold",
        developer_instructions: instruction,
      },
    });
    this.thread = this.codex.startThread({
      workingDirectory: workpath,
      skipGitRepoCheck: true,
    });
    return this.execute(prompt);
  }

  async continue(prompt: string): Promise<AgentResult<RawTopGraph>> {
    if (!this.threadId) {
      throw new Error("No active session. Call run() first.");
    }
    if (!this.codex) {
      const instruction = this.language === "en" ? scaffoldInstructionEn : scaffoldInstruction;
      this.codex = new Codex({
        config: {
          profile: "scaffold",
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

  private async execute(prompt: string): Promise<AgentResult<RawTopGraph>> {
    if (!this.thread) throw new Error("No active thread");
    const turn = await this.thread.run(prompt, { outputSchema });
    const threadId = this.thread.id;
    if (!threadId) throw new Error("Thread has no ID after execution");
    this.threadId = threadId;
    const result = RawTopGraph.parse(JSON.parse(turn.finalResponse));
    return { sessionId: threadId, result };
  }
}