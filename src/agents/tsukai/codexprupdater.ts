import { Codex } from "@openai/codex-sdk";
import type { Thread } from "@openai/codex-sdk";
import { resolveInstruction } from "../schemas/schema.js";
import type { AgentResult, IPrUpdater, Language, PrUpdaterDelta } from "../schemas/schema.js";
import { prUpdaterInstruction } from "../instructions/prupdater.js";

const MCP_URL = process.env.AUTODOC_MCP_URL ?? `http://localhost:${process.env.PORT ?? 3100}/mcp`;

const AUTODOC_TOOLS = [
  "list_projects",
  "get_top",
  "get_flows",
  "get_graph",
  "get_page",
  "search_nodes",
  "list_source_files",
  "read_source_files",
  "list_docs",
  "read_docs",
  "patch_page",
  "update_page",
  "update_node",
  "update_graph_meta",
  "create_node",
  "delete_node",
  "update_top",
];

const MCP_SERVERS_CONFIG = {
  autodoc: { url: MCP_URL, enabled_tools: AUTODOC_TOOLS },
};

export class codexPrUpdater implements IPrUpdater {
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

  async run(prompt: string, workpath: string, onDelta?: PrUpdaterDelta): Promise<AgentResult<string>> {
    if (this.threadId) {
      throw new Error("Session already active. Use continue() or create a new codexPrUpdater instance.");
    }
    this.cwd = workpath;
    const instruction = resolveInstruction(prUpdaterInstruction, this.language);
    this.codex = new Codex({
      config: {
        profile: "prupdater",
        developer_instructions: instruction,
        mcp_servers: MCP_SERVERS_CONFIG,
      },
    });
    this.thread = this.codex.startThread({
      workingDirectory: workpath,
      skipGitRepoCheck: true,
    });
    return this.execute(prompt, onDelta);
  }

  async continue(prompt: string, onDelta?: PrUpdaterDelta): Promise<AgentResult<string>> {
    if (!this.threadId) {
      throw new Error("No active session. Call run() first.");
    }
    if (!this.codex) {
      const instruction = resolveInstruction(prUpdaterInstruction, this.language);
      this.codex = new Codex({
        config: {
          profile: "prupdater",
          developer_instructions: instruction,
          mcp_servers: MCP_SERVERS_CONFIG,
        },
      });
    }
    if (!this.thread) {
      this.thread = this.codex.resumeThread(this.threadId, {
        workingDirectory: this.cwd,
        skipGitRepoCheck: true,
      });
    }
    return this.execute(prompt, onDelta);
  }

  private async execute(prompt: string, onDelta: PrUpdaterDelta | undefined): Promise<AgentResult<string>> {
    if (!this.thread) throw new Error("No active thread");
    const streamed = await this.thread.runStreamed(prompt);

    // Track each agent_message item's last-seen text length so we can emit pure deltas
    // (the SDK emits item.updated with the full accumulated text each time).
    const seenLengthById = new Map<string, number>();
    let finalText = "";

    for await (const event of streamed.events) {
      if (event.type === "item.updated" || event.type === "item.completed") {
        const item = event.item;
        if (item.type === "agent_message") {
          const prev = seenLengthById.get(item.id) ?? 0;
          const full = item.text;
          if (full.length > prev) {
            const delta = full.slice(prev);
            seenLengthById.set(item.id, full.length);
            onDelta?.(delta);
            finalText = full; // last completed agent_message is the final response
          }
        }
      } else if (event.type === "turn.failed") {
        throw new Error(`codexPrUpdater failed: ${event.error.message}`);
      } else if (event.type === "error") {
        throw new Error(`codexPrUpdater stream error: ${event.message}`);
      }
    }

    const threadId = this.thread.id;
    if (!threadId) throw new Error("Thread has no ID after execution");
    this.threadId = threadId;

    if (!finalText.trim()) throw new Error("codexPrUpdater returned no text");
    return { sessionId: threadId, result: finalText };
  }
}
