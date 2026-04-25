import type { DocGit } from "../mcp/docGit.js";
import type { DocStore } from "../mcp/docStore.js";
import { parseBody, sendJson, type RouteHandler } from "./types.js";

export function createDocGitRoutes(docGit: DocGit, docStore: DocStore): RouteHandler {
  return async ({ req, res, url }) => {
    if (req.method === "GET" && url.pathname === "/api/doc-git/status") {
      const project = url.searchParams.get("project");
      if (!project) {
        sendJson(res, { error: "project required" }, 400);
        return true;
      }
      sendJson(res, await docGit.status(project));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/doc-git/commit") {
      const body = (await parseBody(req)) as { project: string; message: string };
      if (!body.project || !body.message?.trim()) {
        sendJson(res, { error: "project and message required" }, 400);
        return true;
      }
      sendJson(res, await docGit.commitAll(body.project, body.message));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/doc-git/blame") {
      const project = url.searchParams.get("project");
      const nodeId = url.searchParams.get("nodeId");
      if (!project || nodeId == null) {
        sendJson(res, { error: "project and nodeId required" }, 400);
        return true;
      }
      const rel = await docStore.resolveNodeId(project, nodeId);
      sendJson(res, { lines: await docGit.blame(project, rel) });
      return true;
    }
    return false;
  };
}
