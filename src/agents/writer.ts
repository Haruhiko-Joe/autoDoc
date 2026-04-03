import { query } from "@anthropic-ai/claude-agent-sdk";
import { WriterOutput, toOutputSchema } from "./schemas/schema.js";
import type { AgentResult } from "./schemas/schema.js";
import { writerInstruction } from "./instructions/wirter.js";

const outputFormat = {
  type: "json_schema" as const,
  schema: toOutputSchema(WriterOutput),
};

export class Writer {
  private sessionId: string | undefined;
  private cwd: string | undefined;

  async run(prompt: string, workpath: string): Promise<AgentResult<WriterOutput>> {
    if (this.sessionId) {
      throw new Error("Session already active. Use continue() or create a new Writer instance.");
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
          append: writerInstruction,
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
          throw new Error(`Writer failed: ${message.subtype}, result: ${JSON.stringify((message as Record<string, unknown>).result ?? "").slice(0, 500)}`);
        }
      }
    }

    if (!result) throw new Error("Writer returned no result");
    return { sessionId, result };
  }
}