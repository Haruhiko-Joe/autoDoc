import { query } from "@anthropic-ai/claude-agent-sdk";
import { toOutputSchema, resolveInstruction } from "../schemas/schema.js";
import type { AgentResult, AgentRunMetrics, Language } from "../schemas/schema.js";
import type { z } from "zod";

export interface ClaudeAgentConfig<T extends z.ZodType> {
  instruction: string;
  outputSchema: T;
  errorPrefix: string;
  allowedTools?: string[];
}

export class ClaudeAgent<S extends z.ZodType, T = z.infer<S>> {
  private sessionId: string | undefined;
  private cwd: string | undefined;
  protected readonly language: Language;

  constructor(
    language: Language,
    private readonly config: ClaudeAgentConfig<S>,
  ) {
    this.language = language;
  }

  getSessionId(): string | undefined { return this.sessionId; }

  restore(sessionId: string, workpath: string): void {
    this.sessionId = sessionId;
    this.cwd = workpath;
  }

  async run(prompt: string, workpath: string): Promise<AgentResult<T>> {
    if (this.sessionId) {
      throw new Error(`Session already active. Use continue() or create a new instance.`);
    }
    this.cwd = workpath;
    return this.execute(prompt);
  }

  async continue(prompt: string): Promise<AgentResult<T>> {
    if (!this.sessionId) {
      throw new Error("No active session. Call run() first.");
    }
    return this.execute(prompt, this.sessionId);
  }

  protected getInstruction(): string {
    return resolveInstruction(this.config.instruction, this.language);
  }

  private async execute(
    prompt: string,
    resumeSessionId?: string,
  ): Promise<AgentResult<T>> {
    let sessionId = "";
    let result: T | undefined;
    let metrics: AgentRunMetrics | undefined;
    const toolUse: Record<string, number> = {};

    const outputFormat = {
      type: "json_schema" as const,
      schema: toOutputSchema(this.config.outputSchema),
    };

    for await (const message of query({
      prompt,
      options: {
        model: "claude-opus-4-6[1m]",
        betas: ["context-1m-2025-08-07"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        tools: { type: "preset", preset: "claude_code" },
        allowedTools: this.config.allowedTools ?? ["Read", "Glob", "Grep"],
        cwd: this.cwd,
        outputFormat,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: this.getInstruction(),
        },
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      },
    })) {
      if (message.type === "system" && message.subtype === "init") {
        this.sessionId = message.session_id;
        sessionId = message.session_id;
      }
      if (message.type === "assistant") {
        collectClaudeToolUse(message, toolUse);
      }
      if (message.type === "result") {
        this.sessionId = message.session_id;
        sessionId = message.session_id;
        if (message.subtype === "success" && message.structured_output) {
          result = this.config.outputSchema.parse(message.structured_output) as T;
          metrics = {
            usage: {
              inputTokens: message.usage.input_tokens,
              cachedInputTokens: message.usage.cache_read_input_tokens,
              cacheCreationInputTokens: message.usage.cache_creation_input_tokens,
              outputTokens: message.usage.output_tokens,
              reasoningOutputTokens: message.usage.output_tokens_details?.thinking_tokens ?? 0,
              totalTokens: message.usage.input_tokens + message.usage.output_tokens,
              totalCostUsd: message.total_cost_usd,
              durationMs: message.duration_ms,
              turns: message.num_turns,
            },
            toolUse: {
              total: Object.values(toolUse).reduce((sum, count) => sum + count, 0),
              byType: toolUse,
            },
          };
        } else {
          throw new Error(`${this.config.errorPrefix} failed: ${message.subtype}, result: ${JSON.stringify((message as Record<string, unknown>).result ?? "").slice(0, 500)}`);
        }
      }
    }

    if (!result) throw new Error(`${this.config.errorPrefix} returned no result`);
    return { sessionId, result, metrics };
  }
}

function collectClaudeToolUse(message: unknown, counts: Record<string, number>): void {
  if (!isRecord(message)) return;
  const betaMessage = message.message;
  if (!isRecord(betaMessage)) return;
  const content = betaMessage.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_use") continue;
    const name = typeof block.name === "string" ? block.name : "tool_use";
    counts[name] = (counts[name] ?? 0) + 1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
