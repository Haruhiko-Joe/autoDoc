import { Codex } from "@openai/codex-sdk";
import type { Thread } from "@openai/codex-sdk";
import { UpdaterOutput, toOutputSchema } from "./schemas/schema.js";
import type { AgentResult, IUpdater, UpdaterOutput as UpdaterOutputType, Language } from "./schemas/schema.js";
import { updaterInstruction } from "./instructions/updater.js";
import { updaterInstructionEn } from "./instructions/updater.en.js";

const outputSchema = toOutputSchema(UpdaterOutput);

interface UpdaterContext {
  docDir: string
  repoDir: string
  prevCommit: string
  newCommit: string
  changedFiles: string[]
  diffPatch: string
}

export class codexUpdater implements IUpdater {
  private codex: Codex | null = null;
  private thread: Thread | null = null;
  private threadId: string | undefined;
  private cwd: string | undefined;
  private readonly project: string;
  private readonly language: Language;
  private readonly ctx: UpdaterContext;

  constructor(project: string, ctx: UpdaterContext, language: Language = "zh") {
    this.project = project;
    this.ctx = ctx;
    this.language = language;
  }

  getSessionId(): string | undefined { return this.threadId; }

  restore(sessionId: string, workpath: string): void {
    this.threadId = sessionId;
    this.cwd = workpath;
  }

  private buildInstruction(): string {
    const base = this.language === "en" ? updaterInstructionEn : updaterInstruction;
    return base
      .replaceAll("{{DOC_DIR}}", this.ctx.docDir)
      .replaceAll("{{REPO_DIR}}", this.ctx.repoDir)
      .replaceAll("{{PROJECT}}", this.project)
      .replaceAll("{{PREV_COMMIT}}", this.ctx.prevCommit)
      .replaceAll("{{NEW_COMMIT}}", this.ctx.newCommit)
      .replaceAll("{{CHANGED_FILES}}", this.ctx.changedFiles.join("\n"))
      .replaceAll("{{DIFF_PATCH}}", this.ctx.diffPatch);
  }

  async run(prompt: string, workpath: string): Promise<AgentResult<UpdaterOutputType>> {
    if (this.threadId) {
      throw new Error("Session already active. Use continue() or create a new codexUpdater instance.");
    }
    this.cwd = workpath;
    this.codex = new Codex({
      config: {
        profile: "updater",
        developer_instructions: this.buildInstruction(),
      },
    });
    this.thread = this.codex.startThread({
      workingDirectory: workpath,
      skipGitRepoCheck: true,
    });
    return this.execute(prompt);
  }

  async continue(prompt: string): Promise<AgentResult<UpdaterOutputType>> {
    if (!this.threadId) {
      throw new Error("No active session. Call run() first.");
    }
    if (!this.codex) {
      this.codex = new Codex({
        config: {
          profile: "updater",
          developer_instructions: this.buildInstruction(),
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

  private async execute(prompt: string): Promise<AgentResult<UpdaterOutputType>> {
    if (!this.thread) throw new Error("No active thread");
    const turn = await this.thread.run(prompt, { outputSchema });
    const threadId = this.thread.id;
    if (!threadId) throw new Error("Thread has no ID after execution");
    this.threadId = threadId;
    const result = UpdaterOutput.parse(JSON.parse(turn.finalResponse));
    return { sessionId: threadId, result };
  }
}
