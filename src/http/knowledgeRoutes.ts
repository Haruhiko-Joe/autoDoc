import type { AgentBackend } from "../workflow/arranger.js";
import type { KnowledgeTurn, Language } from "../agents/schemas/schema.js";
import { parseBody, sendJson, type RouteHandler } from "./types.js";

export interface KnowledgeStartBody {
  project: string;
  userMessage: string;
  language?: Language;
  agentBackend?: AgentBackend;
}

export interface KnowledgeMessageBody {
  sessionId: string;
  userReply: string;
}

export interface KnowledgeFinalizeBody {
  sessionId: string;
  project: string;
}

interface KnowledgeRouteDeps {
  handleKnowledgeGet: (project: string) => Promise<{ exists: boolean; content?: string; draftExists?: boolean }>;
  handleKnowledgeStart: (body: KnowledgeStartBody) => Promise<KnowledgeTurn & { sessionId: string }>;
  handleKnowledgeMessage: (body: KnowledgeMessageBody) => Promise<KnowledgeTurn>;
  handleKnowledgeFinalize: (body: KnowledgeFinalizeBody) => Promise<{ ok: true; path: string }>;
  handleKnowledgeDiscard: (project: string) => Promise<{ ok: true }>;
}

export function createKnowledgeRoutes(deps: KnowledgeRouteDeps): RouteHandler {
  return async ({ req, res, url }) => {
    if (req.method === "GET" && url.pathname === "/api/knowledge") {
      const project = url.searchParams.get("project") ?? "";
      sendJson(res, await deps.handleKnowledgeGet(project));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/knowledge/start") {
      const body = (await parseBody(req)) as unknown as KnowledgeStartBody;
      sendJson(res, await deps.handleKnowledgeStart(body));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/knowledge/message") {
      const body = (await parseBody(req)) as unknown as KnowledgeMessageBody;
      sendJson(res, await deps.handleKnowledgeMessage(body));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/knowledge/finalize") {
      const body = (await parseBody(req)) as unknown as KnowledgeFinalizeBody;
      sendJson(res, await deps.handleKnowledgeFinalize(body));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/knowledge/discard") {
      const body = (await parseBody(req)) as unknown as { project: string };
      sendJson(res, await deps.handleKnowledgeDiscard(body.project));
      return true;
    }
    return false;
  };
}
