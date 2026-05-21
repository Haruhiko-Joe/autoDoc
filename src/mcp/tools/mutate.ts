import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { DocStore } from "../docStore.js"
import {
  GraphNode as GraphNodeSchema,
  ScaffoldNode as ScaffoldNodeSchema,
  GraphEdge as GraphEdgeSchema,
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
        "Patch top.json. Optionally replace `description` and/or the full `nodes` array. Use this to add/remove top-level modules or rewrite the project overview.",
      inputSchema: {
        project: z.string(),
        description: z.string().optional(),
        nodes: z.array(ScaffoldNodeSchema).optional(),
      },
    },
    async ({ project, description, nodes }) => {
      return json(await store.updateTop(project, { description, nodes }))
    },
  )

  // ─── graph-level metadata edits ─────────────────────────────

  mcp.registerTool(
    "update_graph_meta", {
      description:
        "Patch a subgraph's `description`, `codeScope`, and/or `knowledge`.",
      inputSchema: {
        project: z.string(),
        nodeId: z.string(),
        description: z.string().optional(),
        codeScope: z.array(z.string()).optional(),
        knowledge: z.string().optional(),
      },
    },
    async ({ project, nodeId, description, codeScope, knowledge }) => {
      return json(await store.updateGraphMeta(project, nodeId, { description, codeScope, knowledge }))
    },
  )

  // ─── node CRUD ──────────────────────────────────────────────

  mcp.registerTool(
    "create_node",
    {
      description:
        "Append a new node to a parent subgraph. If `node.child.type=='page'`, an (optionally pre-filled) markdown file is created. If `node.child.type=='graph'`, a placeholder sub-graph is created at `{parentNodeId}/{ref}/{ref}.json`. Fails if a sibling with the same name already exists.",
      inputSchema: {
        project: z.string(),
        parentNodeId: z.string(),
        node: GraphNodeSchema,
        initialContent: z
          .string()
          .optional()
          .describe("For page nodes only: initial markdown body. Defaults to an empty string."),
      },
    },
    async ({ project, parentNodeId, node, initialContent }) => {
      return json(await store.createNode(project, parentNodeId, node, initialContent))
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
        patch: z.object({
          name: z.string().optional(),
          description: z.string().optional(),
          codeScope: z.array(z.string()).optional(),
          edges: z.array(GraphEdgeSchema).optional(),
        }),
      },
    },
    async ({ project, parentNodeId, nodeName, patch }) => {
      return json(await store.updateNode(project, parentNodeId, nodeName, patch))
    },
  )

  mcp.registerTool(
    "delete_node",
    {
      description:
        "Remove a child node from its parent graph. For page children: the `.md` file is deleted. For graph children: the entire sub-directory is removed recursively.",
      inputSchema: {
        project: z.string(),
        parentNodeId: z.string(),
        nodeName: z.string(),
      },
    },
    async ({ project, parentNodeId, nodeName }) => {
      return json(await store.deleteNode(project, parentNodeId, nodeName))
    },
  )

  // ─── page content edits ─────────────────────────────────────

  mcp.registerTool(
    "update_page", {
      description:
        "Overwrite a leaf markdown page's full content.",
      inputSchema: {
        project: z.string(),
        nodeId: z.string(),
        ref: z.string(),
        content: z.string(),
      },
    },
    async ({ project, nodeId, ref, content }) => {
      await store.writePage(project, nodeId, ref, content)
      return json({ ok: true })
    },
  )

  // ─── patch page (fine-grained edits) ────────────────────────

  mcp.registerTool(
    "patch_page",
    {
      description:
        "Apply targeted string-match edits to a leaf markdown page without rewriting the entire file. Each edit specifies `old_text` (must match exactly once in the current content) and `new_text` to replace it with. Edits are applied sequentially. Use this instead of update_page when only changing specific sections — it's cheaper and less error-prone.",
      inputSchema: {
        project: z.string(),
        nodeId: z.string(),
        ref: z.string(),
        edits: z.array(
          z.object({
            old_text: z.string().describe("Exact text to find. Must appear exactly once."),
            new_text: z.string().describe("Replacement text. Empty string = delete the matched text."),
          }),
        ).min(1),
      },
    },
    async ({ project, nodeId, ref, edits }) => {
      const result = await store.patchPage(project, nodeId, ref, edits)
      return json(result)
    },
  )
}
