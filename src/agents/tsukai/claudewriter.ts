import { query } from "@anthropic-ai/claude-agent-sdk";
import { WriterOutput, toOutputSchema } from "../schemas/schema.js";
import type { AgentResult, Language } from "../schemas/schema.js";
import { writerInstruction } from "../instructions/cn/wirter.js";
import { writerInstructionEn } from "../instructions/en/wirter.js";

const outputFormat = {
  type: "json_schema" as const,
  schema: toOutputSchema(WriterOutput),
};

export class claudeWriter {
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

  async run(prompt: string, workpath: string): Promise<AgentResult<WriterOutput>> {
    if (this.sessionId) {
      throw new Error("Session already active. Use continue() or create a new claudeWriter instance.");
    }
    this.cwd = workpath;
    return this.execute(prompt);
  }

  async continue(prompt: string): Promise<AgentResult<WriterOutput>> {
    if (!this.sessionId) {
      throw new Error("No active session. Call run() first.");
    }
    return this.execute(prompt, this.sessionId);
  }

  private async execute(
    prompt: string,
    resumeSessionId?: string,
  ): Promise<AgentResult<WriterOutput>> {
    let sessionId = "";
    let result: WriterOutput | undefined;

    for await (const message of query({
      prompt,
      options: {
        model: "claude-opus-4-7[1m]",
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
          append: this.language === "en" ? writerInstructionEn : writerInstruction,
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
          result = WriterOutput.parse(message.structured_output);
        } else {
          throw new Error(`claudeWriter failed: ${message.subtype}, result: ${JSON.stringify((message as Record<string, unknown>).result ?? "").slice(0, 500)}`);
        }
      }
    }

    if (!result) throw new Error("claudeWriter returned no result");
    return { sessionId, result };
  }
}