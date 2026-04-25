import type { GraphNode } from "../agents/schemas/schema.js";
import { parseBody, sendJson, type RouteHandler } from "./types.js";

interface DecompositionReviewRouteDeps {
  listReviews: (project: string) => Promise<unknown[]>;
  updateReview: (project: string, id: string, nodes: GraphNode[]) => Promise<void>;
  approveReview: (project: string, id: string) => Promise<void>;
  rejectReview: (project: string, id: string, feedback: string) => Promise<void>;
}

export function createDecompositionReviewRoutes(deps: DecompositionReviewRouteDeps): RouteHandler {
  return async ({ req, res, url }) => {
    if (req.method === "GET" && url.pathname === "/api/decomposition-reviews") {
      const project = url.searchParams.get("project");
      if (!project) {
        sendJson(res, { error: "project required" }, 400);
        return true;
      }
      sendJson(res, { reviews: await deps.listReviews(project) });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/decomposition-review/update") {
      const body = (await parseBody(req)) as { project: string; id: string; nodes: GraphNode[] };
      await deps.updateReview(body.project, body.id, body.nodes);
      sendJson(res, { ok: true });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/decomposition-review/approve") {
      const body = (await parseBody(req)) as { project: string; id: string };
      await deps.approveReview(body.project, body.id);
      sendJson(res, { ok: true });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/decomposition-review/reject") {
      const body = (await parseBody(req)) as { project: string; id: string; feedback: string };
      await deps.rejectReview(body.project, body.id, body.feedback);
      sendJson(res, { ok: true });
      return true;
    }

    return false;
  };
}
