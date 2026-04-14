import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { DocStore } from "../docStore.js"
import { DocRetriever } from "../../retrieval/docRetriever.js"

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  }
}

export function registerQueryTools(mcp: McpServer, store: DocStore): void {
  mcp.tool(
    "list_projects",
    "List all autoDoc projects available on this MCP server. Call this first to discover what's documented.",
    {},
    async () => json({ projects: await store.listProjects() }),
  )

  mcp.tool(
    "get_top",
    "Fetch the top-level graph (top.json) of a project — the entry point for progressive disclosure. Returns description, top-level modules, and a `version` field needed for any future write to top.json.",
    { project: z.string() },
    async ({ project }) => json(await store.readTop(project)),
  )

  mcp.tool(
    "get_graph",
    "Fetch a subgraph by slash-separated nodeId (e.g. 'MobileApps/IOSApp'). Returns the graph's description, codeScope, child nodes, `version` (for graph-level writes) and `pageVersions` map (for writing individual leaf pages).",
    { project: z.string(), nodeId: z.string() },
    async ({ project, nodeId }) => json(await store.readGraph(project, nodeId)),
  )

  mcp.tool(
    "get_page",
    "Read a leaf markdown page. `nodeId` is the parent graph's path, `ref` is the child entry's ref. Returns content plus its current `version` (use this as baseVersion when calling update_page).",
    { project: z.string(), nodeId: z.string(), ref: z.string() },
    async ({ project, nodeId, ref }) => json(await store.readPage(project, nodeId, ref)),
  )

  mcp.tool(
    "search_nodes",
    "Keyword substring search over node names and descriptions across every level of a project. Fast and exact — prefer this when you know a specific module name. For open-ended natural-language questions use `semantic_search` instead.",
    { project: z.string(), query: z.string() },
    async ({ project, query }) => json({ results: await store.search(project, query) }),
  )

  const retriever = new DocRetriever(store)
  mcp.tool(
    "semantic_search",
    "Rank top-level project description, graph nodes, and leaf pages by relevance to a natural-language query using hybrid BM25-lite scoring over names, descriptions, codeScope paths, and markdown bodies. Returns up to `topK` hits. Each hit's `kind` is one of `top` | `graph` | `page`; `path` is empty string for the project-root `top` hit, a nodeId for graphs, and `nodeId/ref` for pages. Only `page` hits carry a `snippet`. Pass `currentPath` to apply path-aware boosts. Complements the keyword-only `search_nodes` tool.",
    {
      project: z.string(),
      query: z.string(),
      topK: z.number().int().min(1).max(25).optional(),
      currentPath: z.string().optional(),
    },
    async ({ project, query, topK, currentPath }) =>
      json({ results: await retriever.rank(project, query, { topK, currentPath }) }),
  )

  mcp.tool(
    "list_history",
    "List version snapshots stored under `.history/` for a given file. `relPath` is relative to the project root, e.g. 'top.json', 'MobileApps/MobileApps.json', or 'MobileApps/IOSApp/VoiceSystem.md'.",
    { project: z.string(), relPath: z.string() },
    async ({ project, relPath }) =>
      json({ versions: await store.listHistory(project, relPath) }),
  )

  mcp.tool(
    "get_history",
    "Read the raw content of a specific historical version of a file.",
    {
      project: z.string(),
      relPath: z.string(),
      version: z.number().int().min(0),
    },
    async ({ project, relPath, version }) =>
      json({ content: await store.readHistorySnapshot(project, relPath, version) }),
  )
}
