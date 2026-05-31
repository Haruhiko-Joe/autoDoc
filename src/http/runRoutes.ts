import type { AgentBackend, AgentBackends, DecompositionReviewMode } from "../workflow/arranger.js";
import type { Language } from "../agents/schemas/schema.js";
import { parseBody, sendJson, type RouteHandler } from "./types.js";

export interface RunBody {
  gitUrl: string;
  maxConcurrency?: number;
  agentBackend?: AgentBackend;
  agentBackends?: Partial<AgentBackends>;
  language?: Language;
  decompositionReview?: DecompositionReviewMode;
  checkerEnabled?: boolean;
  insightEnabled?: boolean;
}

interface RunRouteDeps {
  handleRun: (body: RunBody) => Promise<{ ok: boolean; project: string }>;
  handleRunContinue: () => Promise<{ ok: boolean }>;
  pauseRun: () => { ok: true };
  resumeRun: () => { ok: true };
  retryErrors: () => { ok: true };
}

export function createRunRoutes(deps: RunRouteDeps): RouteHandler {
  return async ({ req, res, url }) => {
    if (req.method === "POST" && url.pathname === "/api/run") {
      const body = (await parseBody(req)) as unknown as RunBody;
      sendJson(res, await deps.handleRun(body));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/run/continue") {
      sendJson(res, await deps.handleRunContinue());
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/pause") {
      sendJson(res, deps.pauseRun());
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/resume") {
      sendJson(res, deps.resumeRun());
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/retry-errors") {
      sendJson(res, deps.retryErrors());
      return true;
    }
    return false;
  };
}
