import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { DocStore } from "../docStore.js"

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  }
}

export function registerQueryTools(mcp: McpServer, store: DocStore): void {
  mcp.registerTool(
    "list_projects",
    {
      description:
        "List all autoDoc projects available on this MCP server. Call this first to discover what's documented.",
      inputSchema: {},
    },
    async () => json({ projects: await store.listProjects() }),
  )

  mcp.registerTool(
    "list_source_files",
    {
      description:
        "List source files in a project's repo clone by regex patterns. Each pattern in `patterns` is tested (RegExp.test) against every file's POSIX repo-relative path (e.g. 'src/agents/writer.ts'). Returns one result group per input pattern, in the same order: `results[i] = { pattern, files }`. A file matching multiple patterns appears in multiple groups. `.gitignore` is respected; `.git/` and binary files are skipped. Pass `['.*']` to list everything.",
      inputSchema: {
        project: z.string(),
        patterns: z.array(z.string()),
      },
    },
    async ({ project, patterns }) =>
      json({ results: await store.listSourceFiles(project, patterns) }),
  )

  mcp.registerTool(
    "read_source_files",
    {
      description:
        "Read exact source files from a project's repo clone by repo-relative path, with optional line-range slicing. Each request is `{ path, start, end }` where `start`/`end` are 1-indexed inclusive line numbers. Sentinels: `start=0` means 'from the start of the file' (equivalent to 1); `end=-1` means 'to the end of file'. So `{start:0, end:-1}` returns the whole file. Missing, out-of-repo, binary, and >1MB files are silently skipped. Returned `start`/`end` are the resolved concrete line numbers.",
      inputSchema: {
        project: z.string(),
        requests: z.array(
          z.object({
            path: z.string(),
            start: z.number().int(),
            end: z.number().int(),
          }),
        ),
      },
    },
    async ({ project, requests }) =>
      json({ files: await store.readSourceFiles(project, requests) }),
  )

  mcp.registerTool(
    "list_docs",
    {
      description:
        "List documentation nodeIds in a project by regex patterns. Each pattern in `patterns` is tested against every doc's nodeId — the same slash-separated, extension-less path the frontend uses (e.g. 'FlaskApp/AppFactory'). The project root graph (top.json) has nodeId ''. Returns one group per input pattern: `results[i] = { pattern, docs }`. Pass `['.*']` to list everything.",
      inputSchema: {
        project: z.string(),
        patterns: z.array(z.string()),
      },
    },
    async ({ project, patterns }) =>
      json({ results: await store.listDocs(project, patterns) }),
  )

  mcp.registerTool(
    "read_docs",
    {
      description:
        "Batch-read documentation files by nodeId. Each path is a slash-separated, extension-less id; '' maps to top.json; non-empty ids are resolved to the leaf page `.md` if present, otherwise to the subgraph `.json`. Returns `docs: [{ path, content }]` where `content` is the raw file text (JSON text for graphs, Markdown for pages). Missing ids are skipped.",
      inputSchema: {
        project: z.string(),
        paths: z.array(z.string()),
      },
    },
    async ({ project, paths }) =>
      json({ docs: await store.readDocs(project, paths) }),
  )
}
