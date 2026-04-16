import { query } from "@anthropic-ai/claude-agent-sdk";
import { CheckerOutput, toOutputSchema } from "../schemas/schema.js";
import type { AgentResult, Language } from "../schemas/schema.js";
import { checkerInstruction } from "../instructions/cn/checker.js";
import { checkerInstructionEn } from "../instructions/en/checker.js";

const outputFormat = {
  type: "json_schema" as const,
  schema: toOutputSchema(CheckerOutput),
};

export class claudeChecker {
  private sessionId: string | undefined;
  private cwd: string | undefined;
  private readonly language: Language;

  constructor(language: Language = "zh") {
    this.language = language;
  }

  getSessionId(): string | undefined { return this.sessionId; }

  restore(sessionId: string, workpath: string): void {
    this.sessionId = sessionId;
    this.cwd = workpath;
  }

  async run(prompt: string, workpath: string): Promise<AgentResult<CheckerOutput>> {
    if (this.sessionId) {
      throw new Error("Session already active. Use continue() or create a new Checker instance.");
    }
    this.cwd = workpath;
    return this.execute(prompt);
  }

  async continue(prompt: string): Promise<AgentResult<CheckerOutput>> {
    if (!this.sessionId) {
      throw new Error("No active session. Call run() first.");
    }
    return this.execute(prompt, this.sessionId);
  }

  private async execute(
    prompt: string,
    resumeSessionId?: string,
  ): Promise<AgentResult<CheckerOutput>> {
    let sessionId = "";
    let result: CheckerOutput | undefined;

    for await (const message of query({
      prompt,
      options: {
        model: "claude-opus-4-6",
        betas: ["context-1m-2025-08-07"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        tools: { type: "preset", preset: "claude_code" },
        allowedTools: ["Read", "Glob", "Grep"],
        cwd: this.cwd,
        outputFormat,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: this.language === "en" ? checkerInstructionEn : checkerInstruction,
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
          result = CheckerOutput.parse(message.structured_output);
        } else {
          throw new Error(`Checker failed: ${message.subtype}, result: ${JSON.stringify((message as Record<string, unknown>).result ?? "").slice(0, 500)}`);
        }
      }
    }

    if (!result) throw new Error("Checker returned no result");
    return { sessionId, result };
  }
}
