// Graph-native retriever over autoDoc's existing DocStore artifacts.
// Treats every ScaffoldNode / GraphNode / leaf page as a "document" and
// ranks them using hybrid field-weighted BM25-lite scoring (see
// `bm25lite.ts`) plus path-aware boosts.
//
// No embeddings, no vector store, no extra runtime deps. Relies on the
// structured docs autoDoc already produces.

import type { DocStore } from "../mcp/docStore.js";
import { buildIndex, scoreField, buildSnippet, type RawDoc } from "./bm25lite.js";
import { tokenize } from "./tokenize.js";

export type DocKind = "top" | "graph" | "page";

export interface DocEntry {
  kind: DocKind;
  /** Slash-separated canonical path. `""` for top, nodeId for graphs, `nodeId/ref` for pages. */
  path: string;
  name: string;
  description: string;
  codeScope: string[];
  /** Only populated for pages (markdown body). */
  body?: string;
}

export interface RetrievalHit {
  kind: DocKind;
  path: string;
  name: string;
  description: string;
  score: number;
  /** Short excerpt around the first matched token, pages only. */
  snippet?: string;
}

export interface ChatContext {
  projectName: string;
  topDescription: string;
  graphHits: RetrievalHit[];
  pages: { path: string; content: string }[];
  currentPage?: { path: string; content: string };
}

export interface RankOptions {
  topK?: number;
  currentPath?: string;
}

const FIELD_WEIGHTS = { name: 2.0, description: 1.5, body: 1.0, scope: 1.5 } as const;
const PATH_EXACT_BOOST = 4.0;
const PATH_DESCENDANT_BOOST = 1.5;
const PATH_ANCESTOR_BOOST = 1.5;

function splitPagePath(path: string): { nodeId: string; ref: string } {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`Not a valid page path: "${path}"`);
  const ref = parts[parts.length - 1]!;
  const nodeId = parts.slice(0, -1).join("/");
  return { nodeId, ref };
}

export class DocRetriever {
  constructor(private readonly store: DocStore) {}

  /**
   * Walk the project's doc tree, emitting one DocEntry per top/graph/page
   * node. Page bodies are loaded inline.
   */
  async collectDocs(project: string): Promise<DocEntry[]> {
    const out: DocEntry[] = [];

    const top = await this.store.readTop(project);
    out.push({
      kind: "top",
      path: "",
      name: project,
      description: top.description,
      codeScope: [],
    });

    for (const scaffold of top.nodes) {
      out.push({
        kind: "graph",
        path: scaffold.name,
        name: scaffold.name,
        description: scaffold.description,
        codeScope: scaffold.codeScope,
      });
      await this.walkGraph(project, scaffold.name, out);
    }

    return out;
  }

  private async walkGraph(project: string, nodeId: string, out: DocEntry[]): Promise<void> {
    let graph;
    try {
      graph = await this.store.readGraph(project, nodeId);
    } catch {
      // Graph file may still be pending during generation. Skip quietly.
      return;
    }
    for (const node of graph.nodes) {
      const childPath = `${nodeId}/${node.child.ref}`;
      if (node.child.type === "graph") {
        out.push({
          kind: "graph",
          path: childPath,
          name: node.name,
          description: node.description,
          codeScope: node.codeScope,
        });
        await this.walkGraph(project, childPath, out);
      } else {
        const pagePath = childPath;
        let body: string | undefined;
        try {
          const { content } = await this.store.readPage(project, nodeId, node.child.ref);
          body = content;
        } catch {
          // Page file missing (mid-generation) — keep metadata-only entry.
        }
        out.push({
          kind: "page",
          path: pagePath,
          name: node.name,
          description: node.description,
          codeScope: node.codeScope,
          body,
        });
      }
    }
  }

  /**
   * Rank all docs in the project against the query. Returns the top-K highest
   * scoring entries with score > 0. Deterministic: ties broken by path.
   */
  async rank(project: string, query: string, opts: RankOptions = {}): Promise<RetrievalHit[]> {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const docs = await this.collectDocs(project);
    const raws: RawDoc[] = docs.map((d) => ({
      id: d.path,
      fields: {
        name: d.name,
        description: d.description,
        scope: d.codeScope.join(" "),
        body: d.body,
      },
    }));
    const { docs: indexed, idf } = buildIndex(raws);

    const currentPath = opts.currentPath?.replace(/^\/+|\/+$/g, "");
    const hits: { entry: DocEntry; score: number }[] = [];

    for (let i = 0; i < docs.length; i++) {
      const entry = docs[i]!;
      const ix = indexed[i]!;
      let s = 0;
      s += FIELD_WEIGHTS.name * scoreField(queryTokens, ix.fieldTokens.name, idf);
      s += FIELD_WEIGHTS.description * scoreField(queryTokens, ix.fieldTokens.description, idf);
      s += FIELD_WEIGHTS.body * scoreField(queryTokens, ix.fieldTokens.body, idf);
      s += FIELD_WEIGHTS.scope * scoreField(queryTokens, ix.fieldTokens.scope, idf);

      if (currentPath && entry.path) {
        if (entry.path === currentPath) {
          s += PATH_EXACT_BOOST;
        } else if (entry.path.startsWith(currentPath + "/")) {
          s += PATH_DESCENDANT_BOOST;
        } else if (currentPath.startsWith(entry.path + "/")) {
          s += PATH_ANCESTOR_BOOST;
        }
      }

      if (s > 0) hits.push({ entry, score: s });
    }

    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.entry.path.localeCompare(b.entry.path);
    });

    const topK = opts.topK ?? 8;
    return hits.slice(0, topK).map(({ entry, score }) => ({
      kind: entry.kind,
      path: entry.path,
      name: entry.name,
      description: entry.description,
      score: Number(score.toFixed(4)),
      snippet: entry.body ? buildSnippet(entry.body, queryTokens) : undefined,
    }));
  }

  /**
   * Assemble a bounded context for the chat endpoint: top-level project
   * description, top-K graph hits, top-K page hits with truncated bodies,
   * and optionally the current page the user is viewing.
   */
  async buildChatContext(
    project: string,
    query: string,
    currentPath?: string,
  ): Promise<ChatContext> {
    const top = await this.store.readTop(project);
    const hits = await this.rank(project, query, { topK: 12, currentPath });
    const graphHits = hits.filter((h) => h.kind === "graph" || h.kind === "top").slice(0, 4);
    const pageHits = hits.filter((h) => h.kind === "page").slice(0, 3);

    const pages: { path: string; content: string }[] = [];
    for (const h of pageHits) {
      try {
        const { nodeId, ref } = splitPagePath(h.path);
        const { content } = await this.store.readPage(project, nodeId, ref);
        pages.push({ path: h.path, content: truncate(content, 2000) });
      } catch {
        // Skip hits whose bodies can't be resolved (e.g. deleted mid-query).
      }
    }

    let currentPage: ChatContext["currentPage"];
    const cp = currentPath?.replace(/^\/+|\/+$/g, "");
    if (cp) {
      try {
        const { nodeId, ref } = splitPagePath(cp);
        const { content } = await this.store.readPage(project, nodeId, ref);
        currentPage = { path: cp, content: truncate(content, 4000) };
      } catch {
        // currentPath is a graph or missing — retrieval still boosted it above.
      }
    }

    return {
      projectName: project,
      topDescription: top.description,
      graphHits,
      pages,
      currentPage,
    };
  }
}

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars).trimEnd() + "\n\n…[truncated]";
}

/**
 * Render a ChatContext into the model-facing system prompt string.
 * Kept as a pure function so the HTTP layer stays declarative.
 */
export function formatContextForPrompt(ctx: ChatContext): string {
  const lines: string[] = [];
  lines.push(`You are a senior engineer answering questions about the "${ctx.projectName}" codebase.`);
  lines.push(
    "Base all answers strictly on the <project> and <retrieved> context below. " +
      "If the context is insufficient, say so and suggest which module path the user could drill into.",
  );
  lines.push(
    "Cite sources inline as [ref:PATH] where PATH is one of the paths in <retrieved> " +
      "(e.g. [ref:Frontend/GraphView]). Do not invent paths. One citation per distinct claim is enough.",
  );
  lines.push("");
  lines.push("<project>");
  lines.push(ctx.topDescription.trim() || "(no project description available)");
  lines.push("</project>");
  lines.push("");
  lines.push("<retrieved>");
  if (ctx.graphHits.length > 0) {
    lines.push("## Relevant modules");
    for (const h of ctx.graphHits) {
      const display = h.path || "(project root)";
      lines.push(`- **${display}** — ${h.name}: ${truncate(h.description, 400)}`);
    }
    lines.push("");
  }
  if (ctx.pages.length > 0) {
    lines.push("## Relevant doc pages");
    for (const p of ctx.pages) {
      lines.push(`### [ref:${p.path}]`);
      lines.push(p.content);
      lines.push("");
    }
  }
  if (ctx.currentPage) {
    lines.push("## Page the user is currently viewing");
    lines.push(`### [ref:${ctx.currentPage.path}]`);
    lines.push(ctx.currentPage.content);
    lines.push("");
  }
  lines.push("</retrieved>");

  return lines.join("\n");
}
