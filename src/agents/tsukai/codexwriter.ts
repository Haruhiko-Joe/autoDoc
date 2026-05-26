import { Codex } from "@openai/codex-sdk";
import type { Thread } from "@openai/codex-sdk";
import { resolveInstruction } from "../schemas/schema.js";
import type { AgentResult, IWriter, Language } from "../schemas/schema.js";
import { writerInstruction } from "../instructions/writer.js";

export class codexWriter implements IWriter {
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

  async run(prompt: string, workpath: string): Promise<AgentResult<string>> {
    if (this.threadId) {
      throw new Error("Session already active. Use continue() or create a new codexWriter instance.");
    }
    this.cwd = workpath;
    this.codex = new Codex({
      config: {
        profile: "writer",
        developer_instructions: resolveInstruction(writerInstruction, this.language),
      },
    });
    this.thread = this.codex.startThread({
      workingDirectory: workpath,
      skipGitRepoCheck: true,
    });
    return this.execute(prompt);
  }

  async continue(prompt: string): Promise<AgentResult<string>> {
    if (!this.threadId) {
      throw new Error("No active session. Call run() first.");
    }
    if (!this.codex) {
      this.codex = new Codex({
        config: {
          profile: "writer",
          developer_instructions: resolveInstruction(writerInstruction, this.language),
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

  private async execute(prompt: string): Promise<AgentResult<string>> {
    if (!this.thread) throw new Error("No active thread");
    const turn = await this.thread.run(prompt);
    const threadId = this.thread.id;
    if (!threadId) throw new Error("Thread has no ID after execution");
    this.threadId = threadId;
    if (!turn.finalResponse.trim()) throw new Error("codexWriter returned no text");
    return { sessionId: threadId, result: turn.finalResponse };
  }
}
