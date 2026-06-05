import type { Codex, Thread, ThreadItem, Usage } from "@openai/codex-sdk";
import { toOutputSchema, resolveInstruction } from "../schemas/schema.js";
import type { AgentResult, AgentRunMetrics, Language } from "../schemas/schema.js";
import type { z } from "zod";
import { createCodexClient } from "./codexProfile.js";
import type { CodexProfileName } from "./codexProfile.js";

export interface CodexAgentConfig<T extends z.ZodType> {
  profile: CodexProfileName;
  instruction: string;
  outputSchema: T;
  errorPrefix: string;
}

export class CodexAgent<S extends z.ZodType, T = z.infer<S>> {
  private codex: Codex | null = null;
  private thread: Thread | null = null;
  private threadId: string | undefined;
  private cwd: string | undefined;
  protected readonly language: Language;

  constructor(
    language: Language,
    private readonly config: CodexAgentConfig<S>,
  ) {
    this.language = language;
  }

  getSessionId(): string | undefined { return this.threadId; }

  restore(sessionId: string, workpath: string): void {
    this.threadId = sessionId;
    this.cwd = workpath;
  }

  async run(prompt: string, workpath: string): Promise<AgentResult<T>> {
    if (this.threadId) {
      throw new Error("Session already active. Use continue() or create a new instance.");
    }
    this.cwd = workpath;
    this.codex = await createCodexClient(this.config.profile, {
      developer_instructions: this.getInstruction(),
    });
    this.thread = this.codex.startThread({
      workingDirectory: workpath,
      skipGitRepoCheck: true,
    });
    return this.execute(prompt);
  }

  async continue(prompt: string): Promise<AgentResult<T>> {
    if (!this.threadId) {
      throw new Error("No active session. Call run() first.");
    }
    if (!this.codex) {
      this.codex = await createCodexClient(this.config.profile, {
        developer_instructions: this.getInstruction(),
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

  protected getInstruction(): string {
    return resolveInstruction(this.config.instruction, this.language);
  }

  private async execute(prompt: string): Promise<AgentResult<T>> {
    if (!this.thread) throw new Error("No active thread");
    const outputSchema = toOutputSchema(this.config.outputSchema);
    const turn = await this.thread.run(prompt, { outputSchema });
    const threadId = this.thread.id;
    if (!threadId) throw new Error("Thread has no ID after execution");
    this.threadId = threadId;
    const result = this.config.outputSchema.parse(JSON.parse(turn.finalResponse)) as T;
    return { sessionId: threadId, result, metrics: collectCodexMetrics(turn.usage, turn.items) };
  }
}

function collectCodexMetrics(usage: Usage | null, items: ThreadItem[]): AgentRunMetrics {
  const byType: Record<string, number> = {};
  for (const item of items) {
    if (item.type === "command_execution") {
      byType.command_execution = (byType.command_execution ?? 0) + 1;
    } else if (item.type === "mcp_tool_call") {
      const key = `mcp:${item.server}/${item.tool}`;
      byType[key] = (byType[key] ?? 0) + 1;
    } else if (item.type === "web_search") {
      byType.web_search = (byType.web_search ?? 0) + 1;
    }
  }

  const total = Object.values(byType).reduce((sum, count) => sum + count, 0);
  return {
    usage: usage ? {
      inputTokens: usage.input_tokens,
      cachedInputTokens: usage.cached_input_tokens,
      outputTokens: usage.output_tokens,
      reasoningOutputTokens: usage.reasoning_output_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens,
    } : undefined,
    toolUse: { total, byType },
  };
}
