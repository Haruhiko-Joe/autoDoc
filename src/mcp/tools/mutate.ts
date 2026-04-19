import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { DocStore } from "../docStore.js"
import {
  GraphNode as GraphNodeSchema,
  ScaffoldNode as ScaffoldNodeSchema,
  GraphEdge as GraphEdgeSchema,
  type GraphT,
  type TopGraphT,
} from "../schema.js"

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  }
}

export function registerMutateTools(mcp: McpServer, store: DocStore): void {
  // ─── top.json edits ─────────────────────────────────────────

  mcp.registerTool(
    "update_top", {
      description:
        "Patch top.json. Must supply `baseVersion` (from get_top). Optionally replace `description` and/or the full `nodes` array. Use this to add/remove top-level modules or rewrite the project overview.",
      inputSchema: {
        project: z.string(),
        baseVersion: z.number().int().min(0),
        description: z.string().optional(),
        nodes: z.array(ScaffoldNodeSchema).optional(),
      },
    },
    async ({ project, baseVersion, description, nodes }) => {
      const current = await store.readTop(project)
      const next: TopGraphT = {
        ...current,
        ...(description !== undefined ? { description } : {}),
        ...(nodes !== undefined ? { nodes } : {}),
      }
      return json(await store.writeTop(project, next, baseVersion))
    },
  )

  // ─── graph-level metadata edits ─────────────────────────────

  mcp.registerTool(
    "update_graph_meta", {
      description:
        "Patch a subgraph's `description` and/or `codeScope`. `baseVersion` is the graph's version from the last get_graph.",
      inputSchema: {
        project: z.string(),
        nodeId: z.string(),
        baseVersion: z.number().int().min(0),
        description: z.string().optional(),
        codeScope: z.array(z.string()).optional(),
      },
    },
    async ({ project, nodeId, baseVersion, description, codeScope }) => {
      const current = await store.readGraph(project, nodeId)
      const next: GraphT = {
        ...current,
        ...(description !== undefined ? { description } : {}),
        ...(codeScope !== undefined ? { codeScope } : {}),
      }
      return json(await store.writeGraph(project, nodeId, next, baseVersion))
    },
  )

  // ─── node CRUD ──────────────────────────────────────────────

  mcp.registerTool(
    "create_node",
    {
      description:
        "Append a new node to a parent subgraph. If `node.child.type=='page'`, an (optionally pre-filled) markdown file is created and `pageVersions[ref]` is initialized to 0. If `node.child.type=='graph'`, a placeholder sub-graph is created at `{parentNodeId}/{ref}/{ref}.json`. Fails if a sibling with the same name already exists.",
      inputSchema: {
        project: z.string(),
        parentNodeId: z.string(),
        baseVersion: z.number().int().min(0),
        node: GraphNodeSchema,
        initialContent: z
          .string()
          .optional()
          .describe("For page nodes only: initial markdown body. Defaults to an empty string."),
      },
    },
    async ({ project, parentNodeId, baseVersion, node, initialContent }) => {
      const parent = await store.readGraph(project, parentNodeId)
      if (parent.nodes.some((n) => n.name === node.name)) {
        throw new Error(`Sibling node already exists: ${node.name}`)
      }

      if (node.child.type === "page") {
        await store.createEmptyPage(project, parentNodeId, node.child.ref, initialContent ?? "")
      } else {
        await store.createPlaceholderSubgraph(
          project,
          parentNodeId,
          node.child.ref,
          node.description,
          node.codeScope,
        )
      }

      const nextPageVersions = { ...(parent.pageVersions ?? {}) }
      if (node.child.type === "page") nextPageVersions[node.child.ref] = 0

      const next: GraphT = {
        ...parent,
        nodes: [...parent.nodes, node],
        pageVersions: Object.keys(nextPageVersions).length > 0 ? nextPageVersions : parent.pageVersions,
      }
      try {
        return json(await store.writeGraph(project, parentNodeId, next, baseVersion))
      } catch (e) {
        // Rollback child artifact on version mismatch
        if (node.child.type === "page") {
          await store.deletePageFile(project, parentNodeId, node.child.ref).catch(() => {})
        } else {
          await store.deleteSubgraphDir(project, `${parentNodeId}/${node.child.ref}`).catch(() => {})
        }
        throw e
      }
    },
  )

  mcp.registerTool(
    "update_node",
    {
      description:
        "Patch a single child node inside a parent graph, matched by `nodeName`. Only the provided patch fields are replaced. Cannot rename `child.ref` — use delete_node + create_node for that.",
      inputSchema: {
        project: z.string(),
        parentNodeId: z.string(),
        nodeName: z.string(),
        baseVersion: z.number().int().min(0),
        patch: z.object({
          name: z.string().optional(),
          description: z.string().optional(),
          codeScope: z.array(z.string()).optional(),
          edges: z.array(GraphEdgeSchema).optional(),
        }),
      },
    },
    async ({ project, parentNodeId, nodeName, baseVersion, patch }) => {
      const parent = await store.readGraph(project, parentNodeId)
      const idx = parent.nodes.findIndex((n) => n.name === nodeName)
      if (idx < 0) throw new Error(`Node not found: ${nodeName}`)
      const nextNodes = parent.nodes.slice()
      const current = parent.nodes[idx]!
      const merged: typeof current = {
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        codeScope: patch.codeScope ?? current.codeScope,
        edges: patch.edges ?? current.edges,
        child: current.child,
      }
      nextNodes[idx] = merged
      const next: GraphT = { ...parent, nodes: nextNodes }
      return json(await store.writeGraph(project, parentNodeId, next, baseVersion))
    },
  )

  mcp.registerTool(
    "delete_node",
    {
      description:
        "Remove a child node from its parent graph. For page children: the `.md` file is deleted and `pageVersions[ref]` cleared. For graph children: the entire sub-directory is removed recursively. A snapshot is kept under `.history/` for the parent graph and (best-effort) for the removed child.",
      inputSchema: {
        project: z.string(),
        parentNodeId: z.string(),
        nodeName: z.string(),
        baseVersion: z.number().int().min(0),
      },
    },
    async ({ project, parentNodeId, nodeName, baseVersion }) => {
      const parent = await store.readGraph(project, parentNodeId)
      const target = parent.nodes.find((n) => n.name === nodeName)
      if (!target) throw new Error(`Node not found: ${nodeName}`)

      const nextPageVersions = { ...(parent.pageVersions ?? {}) }
      if (target.child.type === "page") delete nextPageVersions[target.child.ref]

      const next: GraphT = {
        ...parent,
        nodes: parent.nodes.filter((n) => n.name !== nodeName),
        pageVersions:
          target.child.type === "page" ? nextPageVersions : parent.pageVersions,
      }
      const written = await store.writeGraph(project, parentNodeId, next, baseVersion)

      if (target.child.type === "page") {
        await store.deletePageFile(project, parentNodeId, target.child.ref)
      } else {
        await store.deleteSubgraphDir(project, `${parentNodeId}/${target.child.ref}`)
      }

      return json(written)
    },
  )

  // ─── page content edits ─────────────────────────────────────

  mcp.registerTool(
    "update_page", {
      description:
        "Overwrite a leaf markdown page's full content. `baseVersion` is the page's version from `pageVersions[ref]` (NOT the parent graph's version). Bumps both the page's own version and the parent graph's version.",
      inputSchema: {
        project: z.string(),
        nodeId: z.string(),
        ref: z.string(),
        baseVersion: z.number().int().min(0),
        content: z.string(),
      },
    },
    async ({ project, nodeId, ref, baseVersion, content }) =>
      json(await store.writePage(project, nodeId, ref, content, baseVersion)),
  )

  // ─── patch page (fine-grained edits) ────────────────────────

  mcp.registerTool(
    "patch_page",
    {
      description:
        "Apply targeted string-match edits to a leaf markdown page without rewriting the entire file. Each edit specifies `old_text` (must match exactly once in the current content) and `new_text` to replace it with. Edits are applied sequentially. Use this instead of update_page when only changing specific sections — it's cheaper and less error-prone. `baseVersion` comes from `pageVersions[ref]` (use get_graph or get_page to obtain it).",
      inputSchema: {
        project: z.string(),
        nodeId: z.string(),
        ref: z.string(),
        baseVersion: z.number().int().min(0),
        edits: z.array(
          z.object({
            old_text: z.string().describe("Exact text to find. Must appear exactly once."),
            new_text: z.string().describe("Replacement text. Empty string = delete the matched text."),
          }),
        ).min(1),
      },
    },
    async ({ project, nodeId, ref, baseVersion, edits }) =>
      json(await store.patchPage(project, nodeId, ref, edits, baseVersion)),
  )

  // ─── revert ─────────────────────────────────────────────────

  mcp.registerTool(
    "revert", {
      description:
        "Restore a historical version's content as the new current version. This does NOT rewind — it creates version N+1 whose content equals version `toVersion`. `baseVersion` is the file's current version (optimistic lock).",
      inputSchema: {
        project: z.string(),
        relPath: z.string(),
        toVersion: z.number().int().min(0),
        baseVersion: z.number().int().min(0),
      },
    },
    async ({ project, relPath, toVersion, baseVersion }) =>
      json(await store.revert(project, relPath, toVersion, baseVersion)),
  )
}