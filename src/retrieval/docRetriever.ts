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
  /** Graph-like hits; may include the project-root entry with an empty path. */
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

// Short TTL so multi-turn chat bursts share the collected corpus without
// serving long-lived stale docs after writes. Invalidated explicitly by
// callers that know a mutation happened (e.g. after an update_graph_meta
// round-trip), or simply left to expire.
const CORPUS_TTL_MS = 3_000;

function splitPagePath(path: string): { nodeId: string; ref: string } {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`Not a valid page path: "${path}"`);
  const ref = parts[parts.length - 1]!;
  const nodeId = parts.slice(0, -1).join("/");
  return { nodeId, ref };
}

export class DocRetriever {
  private corpusCache = new Map<string, { ts: number; docs: DocEntry[] }>();

  constructor(private readonly store: DocStore) {}

  /**
   * Drop any cached corpus for a project. Call after MCP mutations or when
   * fresh-reads are required.
   */
  invalidate(project?: string): void {
    if (project === undefined) this.corpusCache.clear();
    else this.corpusCache.delete(project);
  }

  /**
   * Walk the project's doc tree, emitting one DocEntry per top/graph/page
   * node. Page bodies are loaded inline.
   *
   * Graph entries use the child graph file's OWN `description`/`codeScope`
   * so that edits via MCP `update_graph_meta` are reflected immediately in
   * retrieval. Parent-view metadata is only used when the child graph file
   * hasn't been generated yet (mid-scaffold/decompose).
   */
  async collectDocs(project: string): Promise<DocEntry[]> {
    const cached = this.corpusCache.get(project);
    if (cached && Date.now() - cached.ts < CORPUS_TTL_MS) return cached.docs;

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
      await this.walkGraph(
        project,
        scaffold.name,
        {
          name: scaffold.name,
          description: scaffold.description,
          codeScope: scaffold.codeScope,
        },
        out,
      );
    }

    this.corpusCache.set(project, { ts: Date.now(), docs: out });
    return out;
  }

  private async walkGraph(
    project: string,
    nodeId: string,
    parentView: { name: string; description: string; codeScope: string[] },
    out: DocEntry[],
  ): Promise<void> {
    let graph;
    try {
      graph = await this.store.readGraph(project, nodeId);
    } catch {
      // Child graph file not yet generated — fall back to the parent's view
      // so in-progress projects are still searchable.
      out.push({
        kind: "graph",
        path: nodeId,
        name: parentView.name,
        description: parentView.description,
        codeScope: parentView.codeScope,
      });
      return;
    }

    // Authoritative metadata lives in the child graph file itself; the
    // parent only owns the node's display `name`.
    out.push({
      kind: "graph",
      path: nodeId,
      name: parentView.name,
      description: graph.description,
      codeScope: graph.codeScope,
    });

    for (const node of graph.nodes) {
      const childPath = `${nodeId}/${node.child.ref}`;
      if (node.child.type === "graph") {
        await this.walkGraph(
          project,
          childPath,
          {
            name: node.name,
            description: node.description,
            codeScope: node.codeScope,
          },
          out,
        );
      } else {
        let body: string | undefined;
        try {
          const { content } = await this.store.readPage(project, nodeId, node.child.ref);
          body = content;
        } catch {
          // Page file missing (mid-generation) — keep metadata-only entry.
        }
        out.push({
          kind: "page",
          path: childPath,
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
    return this.rankOverDocs(docs, queryTokens, opts);
  }

  private rankOverDocs(
    docs: DocEntry[],
    queryTokens: string[],
    opts: RankOptions,
  ): RetrievalHit[] {
    if (queryTokens.length === 0) return [];

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
   *
   * Page bodies are read once during corpus collection and reused here, so
   * a chat turn does not re-read every relevant markdown file from disk.
   */
  async buildChatContext(
    project: string,
    query: string,
    currentPath?: string,
  ): Promise<ChatContext> {
    const top = await this.store.readTop(project);
    const queryTokens = tokenize(query);
    const docs = await this.collectDocs(project);
    const hits = this.rankOverDocs(docs, queryTokens, { topK: 12, currentPath });
    const graphHits = hits.filter((h) => h.kind === "graph" || h.kind === "top").slice(0, 4);
    const pageHits = hits.filter((h) => h.kind === "page").slice(0, 3);

    const docByPath = new Map(docs.map((d) => [d.path, d]));

    const pages: { path: string; content: string }[] = [];
    for (const h of pageHits) {
      const body = docByPath.get(h.path)?.body;
      if (body) pages.push({ path: h.path, content: truncateBlock(body, 2000) });
    }

    let currentPage: ChatContext["currentPage"];
    const cp = currentPath?.replace(/^\/+|\/+$/g, "");
    if (cp) {
      const existing = docByPath.get(cp);
      const body = existing?.body;
      if (body !== undefined) {
        currentPage = { path: cp, content: truncateBlock(body, 4000) };
      } else {
        // Either `cp` isn't a page (graph path) or it isn't in our corpus
        // because it was created just now. One-off disk read as a fallback.
        try {
          const { nodeId, ref } = splitPagePath(cp);
          const { content } = await this.store.readPage(project, nodeId, ref);
          currentPage = { path: cp, content: truncateBlock(content, 4000) };
        } catch {
          // Graph paths / missing pages: retrieval still boosts them via rank.
        }
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

function truncateBlock(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars).trimEnd() + "\n\n…[truncated]";
}

// For values interpolated into a single markdown list item / heading line —
// collapse whitespace so embedded newlines can't fracture the list.
function truncateInline(s: string, maxChars: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return collapsed.slice(0, Math.max(1, maxChars - 1)).trimEnd() + "…";
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
      lines.push(`- **${display}** — ${truncateInline(h.name, 80)}: ${truncateInline(h.description, 400)}`);
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
