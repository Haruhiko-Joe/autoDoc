import { query } from "@anthropic-ai/claude-agent-sdk";
import { UpdaterOutput, toOutputSchema } from "../schemas/schema.js";
import type { AgentResult, IUpdater, UpdaterOutput as UpdaterOutputType, Language, AncestorContext as AncestorContextType } from "../schemas/schema.js";
import { updaterInstruction } from "../instructions/cn/updater.js";
import { updaterInstructionEn } from "../instructions/en/updater.js";

const outputFormat = {
  type: "json_schema" as const,
  schema: toOutputSchema(UpdaterOutput),
};

interface UpdaterContext {
  docDir: string
  repoDir: string
  prevCommit: string
  newCommit: string
  changedFiles: string[]
  diffPatch: string
  graphNodeId?: string
  ancestorContext?: AncestorContextType | null
}

export class claudeUpdater implements IUpdater {
  private sessionId: string | undefined;
  private cwd: string | undefined;
  private readonly project: string;
  private readonly language: Language;
  private readonly ctx: UpdaterContext;

  constructor(project: string, ctx: UpdaterContext, language: Language = "zh") {
    this.project = project;
    this.ctx = ctx;
    this.language = language;
  }

  getSessionId(): string | undefined { return this.sessionId; }

  restore(sessionId: string, workpath: string): void {
    this.sessionId = sessionId;
    this.cwd = workpath;
  }

  async run(prompt: string, workpath: string): Promise<AgentResult<UpdaterOutputType>> {
    if (this.sessionId) {
      throw new Error("Session already active. Use continue() or create a new claudeUpdater instance.");
    }
    this.cwd = workpath;
    return this.execute(prompt);
  }

  async continue(prompt: string): Promise<AgentResult<UpdaterOutputType>> {
    if (!this.sessionId) {
      throw new Error("No active session. Call run() first.");
    }
    return this.execute(prompt, this.sessionId);
  }

  private buildSystemPrompt(): string {
    const base = this.language === "en" ? updaterInstructionEn : updaterInstruction;
    return base
      .replaceAll("{{DOC_DIR}}", this.ctx.docDir)
      .replaceAll("{{REPO_DIR}}", this.ctx.repoDir)
      .replaceAll("{{PROJECT}}", this.project)
      .replaceAll("{{PREV_COMMIT}}", this.ctx.prevCommit)
      .replaceAll("{{NEW_COMMIT}}", this.ctx.newCommit)
      .replaceAll("{{CHANGED_FILES}}", this.ctx.changedFiles.join("\n"))
      .replaceAll("{{DIFF_PATCH}}", this.ctx.diffPatch)
      .replaceAll("{{GRAPH_NODE_ID}}", this.ctx.graphNodeId ?? "")
      .replaceAll(
        "{{ANCESTOR_CONTEXT}}",
        this.ctx.ancestorContext ? JSON.stringify(this.ctx.ancestorContext, null, 2) : "",
      );
  }

  private async execute(
    prompt: string,
    resumeSessionId?: string,
  ): Promise<AgentResult<UpdaterOutputType>> {
    let sessionId = "";
    let result: UpdaterOutputType | undefined;

    const systemPrompt = this.buildSystemPrompt();

    for await (const message of query({
      prompt,
      options: {
        model: "claude-opus-4-6",
        betas: ["context-1m-2025-08-07"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        tools: { type: "preset", preset: "claude_code" },
        allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
        cwd: this.cwd,
        outputFormat,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: systemPrompt,
        },
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      },
    })) {
      if (message.type === "system" && message.subtype === "init") {
        this.sessionId = message.session_id;
        sessionId = message.session_id;
      }
      if (message.type === "result") {
        this.sessionId = message.session_id;
        sessionId = message.session_id;
        if (message.subtype === "success" && message.structured_output) {
          result = UpdaterOutput.parse(message.structured_output);
        } else {
          throw new Error(`claudeUpdater failed: ${message.subtype}, result: ${JSON.stringify((message as Record<string, unknown>).result ?? "").slice(0, 500)}`);
        }
      }
    }

    if (!result) throw new Error("claudeUpdater returned no result");
    return { sessionId, result };
  }
}
