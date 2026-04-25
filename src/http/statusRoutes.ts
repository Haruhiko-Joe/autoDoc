import type { ServerResponse } from "node:http";
import { sendJson, type RouteHandler } from "./types.js";

interface StatusRouteDeps {
  listProjects: () => Promise<unknown[]>;
  handleStatus: () => Promise<unknown>;
  streamStatus: (res: ServerResponse) => Promise<void>;
}

export function createStatusRoutes(deps: StatusRouteDeps): RouteHandler {
  return async ({ req, res, url }) => {
    if (req.method === "GET" && url.pathname === "/api/projects") {
      sendJson(res, { projects: await deps.listProjects() });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, await deps.handleStatus());
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/status/stream") {
      await deps.streamStatus(res);
      return true;
    }
    return false;
  };
}
