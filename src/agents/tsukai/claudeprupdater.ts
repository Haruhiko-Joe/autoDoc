import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveInstruction } from "../schemas/schema.js";
import type { AgentResult, IPrUpdater, Language, PrUpdaterDelta } from "../schemas/schema.js";
import { prUpdaterInstruction } from "../instructions/prupdater.js";

const MCP_URL = process.env.AUTODOC_MCP_URL ?? `http://localhost:${process.env.PORT ?? 3100}/mcp`;

const AUTODOC_TOOLS = [
  "mcp__autodoc__list_projects",
  "mcp__autodoc__get_top",
  "mcp__autodoc__get_flows",
  "mcp__autodoc__get_graph",
  "mcp__autodoc__get_page",
  "mcp__autodoc__search_nodes",
  "mcp__autodoc__list_source_files",
  "mcp__autodoc__read_source_files",
  "mcp__autodoc__list_docs",
  "mcp__autodoc__read_docs",
  "mcp__autodoc__patch_page",
  "mcp__autodoc__update_page",
  "mcp__autodoc__update_node",
  "mcp__autodoc__update_graph_meta",
  "mcp__autodoc__create_node",
  "mcp__autodoc__delete_node",
  "mcp__autodoc__update_top",
];

export class claudePrUpdater implements IPrUpdater {
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

  async run(prompt: string, workpath: string, onDelta?: PrUpdaterDelta): Promise<AgentResult<string>> {
    if (this.sessionId) {
      throw new Error("Session already active. Use continue() or create a new claudePrUpdater instance.");
    }
    this.cwd = workpath;
    return this.execute(prompt, undefined, onDelta);
  }

  async continue(prompt: string, onDelta?: PrUpdaterDelta): Promise<AgentResult<string>> {
    if (!this.sessionId) {
      throw new Error("No active session. Call run() first.");
    }
    return this.execute(prompt, this.sessionId, onDelta);
  }

  private async execute(
    prompt: string,
    resumeSessionId: string | undefined,
    onDelta: PrUpdaterDelta | undefined,
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
        allowedTools: ["Read", "Glob", "Grep", ...AUTODOC_TOOLS],
        mcpServers: {
          autodoc: { type: "http", url: MCP_URL },
        },
        cwd: this.cwd,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: resolveInstruction(prUpdaterInstruction, this.language),
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
                onDelta?.(text);
              }
            }
          }
        }
      } else if (message.type === "result") {
        this.sessionId = message.session_id;
        sessionId = message.session_id;
        if (message.subtype !== "success") {
          throw new Error(`claudePrUpdater failed: ${message.subtype}, result: ${JSON.stringify((message as Record<string, unknown>).result ?? "").slice(0, 500)}`);
        }
      }
    }

    if (!accumulated.trim()) throw new Error("claudePrUpdater returned no text");
    return { sessionId, result: accumulated };
  }
}
