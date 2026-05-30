import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveInstruction } from "../schemas/schema.js";
import type { AgentResult, IWriter, Language } from "../schemas/schema.js";
import { writerInstruction } from "../instructions/writer.js";

export class claudeWriter implements IWriter {
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

  async run(prompt: string, workpath: string): Promise<AgentResult<string>> {
    if (this.sessionId) {
      throw new Error("Session already active. Use continue() or create a new claudeWriter instance.");
    }
    this.cwd = workpath;
    return this.execute(prompt);
  }

  async continue(prompt: string): Promise<AgentResult<string>> {
    if (!this.sessionId) {
      throw new Error("No active session. Call run() first.");
    }
    return this.execute(prompt, this.sessionId);
  }

  private async execute(
    prompt: string,
    resumeSessionId?: string,
  ): Promise<AgentResult<string>> {
    let sessionId = "";
    let accumulated = "";

    for await (const message of query({
      prompt,
      options: {
        model: "claude-opus-4-6[1m]",
        betas: ["context-1m-2025-08-07"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        tools: { type: "preset", preset: "claude_code" },
        allowedTools: ["Read", "Glob", "Grep"],
        cwd: this.cwd,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: resolveInstruction(writerInstruction, this.language),
        },
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      },
    })) {
      if (message.type === "system" && message.subtype === "init") {
        this.sessionId = message.session_id;
        sessionId = message.session_id;
      } else if (message.type === "assistant") {
        const content = (message as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === "object" && "type" in block && (block as { type: string }).type === "text") {
              const text = (block as { text?: unknown }).text;
              if (typeof text === "string" && text.length > 0) {
                accumulated += text;
              }
            }
          }
        }
      } else if (message.type === "result") {
        this.sessionId = message.session_id;
        sessionId = message.session_id;
        if (message.subtype !== "success") {
          throw new Error(`claudeWriter failed: ${message.subtype}, result: ${JSON.stringify((message as Record<string, unknown>).result ?? "").slice(0, 500)}`);
        }
      }
    }

    if (!accumulated.trim()) throw new Error("claudeWriter returned no text");
    return { sessionId, result: accumulated };
  }
}
