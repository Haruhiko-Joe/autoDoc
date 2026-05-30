import { parseBody, sendJson, type RouteHandler } from "./types.js";

interface SubgraphPauseRouteDeps {
  pauseSubgraph: (project: string, nodeId: string) => Promise<void>;
  resumeSubgraph: (project: string, nodeId: string) => Promise<void>;
}

export function createSubgraphPauseRoutes(deps: SubgraphPauseRouteDeps): RouteHandler {
  return async ({ req, res, url }) => {
    if (req.method === "POST" && url.pathname === "/api/subgraph/pause") {
      const body = await parseBody(req);
      const project = body.project as string;
      const nodeId = body.nodeId as string;
      if (!project || !nodeId) {
        sendJson(res, { error: "project and nodeId required" }, 400);
        return true;
      }
      await deps.pauseSubgraph(project, nodeId);
      sendJson(res, { ok: true });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/subgraph/resume") {
      const body = await parseBody(req);
      const project = body.project as string;
      const nodeId = body.nodeId as string;
      if (!project || !nodeId) {
        sendJson(res, { error: "project and nodeId required" }, 400);
        return true;
      }
      await deps.resumeSubgraph(project, nodeId);
      sendJson(res, { ok: true });
      return true;
    }

    return false;
  };
}
