import { sendJson, type RouteHandler } from "./types.js";

interface SearchRouteDeps {
  searchModules: (project: string, query: string) => Promise<unknown[]>;
}

export function createSearchRoutes(deps: SearchRouteDeps): RouteHandler {
  return async ({ req, res, url }) => {
    if (req.method !== "GET" || url.pathname !== "/api/search") return false;
    const project = url.searchParams.get("project");
    const q = (url.searchParams.get("q") ?? "").toLowerCase().trim();
    if (!project || !q) {
      sendJson(res, { error: "Missing project or q" }, 400);
      return true;
    }
    sendJson(res, { results: await deps.searchModules(project, q) });
    return true;
  };
}
