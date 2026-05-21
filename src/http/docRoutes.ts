import type { DocStore } from "../mcp/docStore.js";
import { parseBody, sendJson, type RouteHandler } from "./types.js";

interface DocRouteDeps {
  docStore: DocStore;
  getProjectDocDir: (project: string) => string;
  getCurrentDocDir: () => string | undefined;
  handleDocFile: (docDir: string, filePath: string) => Promise<{ content: string; type: string }>;
}

export function createDocRoutes(deps: DocRouteDeps): RouteHandler {
  return async ({ req, res, url }) => {
    if (req.method === "POST" && url.pathname === "/api/doc/create-node") {
      const body = (await parseBody(req)) as {
        project: string; parentNodeId: string;
        node: import("../mcp/schema.js").GraphNodeT; initialContent?: string;
      };
      sendJson(res, await deps.docStore.createNode(body.project, body.parentNodeId, body.node, body.initialContent));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/doc/update-node") {
      const body = (await parseBody(req)) as {
        project: string; parentNodeId: string; nodeName: string;
        patch: { name?: string; description?: string; codeScope?: string[]; edges?: import("../mcp/schema.js").GraphEdgeT[] };
      };
      sendJson(res, await deps.docStore.updateNode(body.project, body.parentNodeId, body.nodeName, body.patch));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/doc/delete-node") {
      const body = (await parseBody(req)) as { project: string; parentNodeId: string; nodeName: string };
      sendJson(res, await deps.docStore.deleteNode(body.project, body.parentNodeId, body.nodeName));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/doc/update-page") {
      const body = (await parseBody(req)) as { project: string; nodeId: string; ref: string; content: string };
      await deps.docStore.writePage(body.project, body.nodeId, body.ref, body.content);
      sendJson(res, { ok: true });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/doc/update-graph-knowledge") {
      const body = (await parseBody(req)) as { project: string; nodeId: string; knowledge: string };
      sendJson(res, await deps.docStore.updateGraphMeta(body.project, body.nodeId, { knowledge: body.knowledge }));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/doc/patch-page") {
      const body = (await parseBody(req)) as { project: string; nodeId: string; ref: string; edits: { old_text: string; new_text: string }[] };
      sendJson(res, await deps.docStore.patchPage(body.project, body.nodeId, body.ref, body.edits));
      return true;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/doc/")) {
      let docDir: string | undefined;
      const project = url.searchParams.get("project");
      if (project) docDir = deps.getProjectDocDir(project);
      else docDir = deps.getCurrentDocDir();
      if (!docDir) {
        sendJson(res, { error: "Not ready" }, 400);
        return true;
      }
      const filePath = url.pathname.slice("/api/doc/".length);
      if (filePath.split("/").some(seg => seg.startsWith("."))) {
        sendJson(res, { error: "Forbidden" }, 403);
        return true;
      }
      const { content, type } = await deps.handleDocFile(docDir, filePath);
      res.writeHead(200, { "Content-Type": type }).end(content);
      return true;
    }
    return false;
  };
}
