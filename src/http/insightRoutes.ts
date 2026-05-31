import { readInsights } from "../souko/insightLog.js";
import { sendJson, type RouteHandler } from "./types.js";

export function createInsightRoutes(): RouteHandler {
  return async ({ req, res, url }) => {
    if (req.method !== "GET" || url.pathname !== "/api/insights") return false;
    const project = url.searchParams.get("project");
    if (!project) {
      sendJson(res, { error: "Missing project" }, 400);
      return true;
    }
    sendJson(res, { insights: await readInsights(project) });
    return true;
  };
}
