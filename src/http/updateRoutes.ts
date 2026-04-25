import { assertProjectName } from "../souko/registry.js";
import {
  startUpdate,
  continueUpdate,
  skipTask,
  cancelUpdate,
  acceptTask,
  chatOnTask,
  getUpdateState,
  subscribe as subscribeUpdate,
  type UpdateEvent,
} from "../workflow/updateOrchestrator.js";
import { parseBody, sendJson, type RouteHandler } from "./types.js";

export function createUpdateRoutes(): RouteHandler {
  return async ({ req, res, url }) => {
    if (req.method === "POST" && url.pathname === "/api/update/start") {
      const body = (await parseBody(req)) as { project: string; mode?: "auto" | "manual"; backend?: "claude" | "codex"; language?: "zh" | "en" };
      if (!body.project) {
        sendJson(res, { error: "project required" }, 400);
        return true;
      }
      const updateState = await startUpdate(body.project, { mode: body.mode, backend: body.backend, language: body.language });
      sendJson(res, { ok: true, tasks: updateState.tasks });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/update/continue") {
      const body = (await parseBody(req)) as { project: string; extraInstructions?: string };
      continueUpdate(body.project, body.extraInstructions);
      sendJson(res, { ok: true });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/update/skip") {
      const body = (await parseBody(req)) as { project: string; taskId: string };
      skipTask(body.project, body.taskId);
      sendJson(res, { ok: true });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/update/cancel") {
      const body = (await parseBody(req)) as { project: string };
      await cancelUpdate(body.project);
      sendJson(res, { ok: true });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/update/task/accept") {
      const body = (await parseBody(req)) as { project: string; taskId: string };
      await acceptTask(body.project, body.taskId);
      sendJson(res, { ok: true });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/update/task/chat") {
      const body = (await parseBody(req)) as { project: string; taskId: string; prompt: string };
      // Fire-and-forget so the HTTP response returns immediately and the SSE stream carries progress
      void chatOnTask(body.project, body.taskId, body.prompt).catch(() => {});
      sendJson(res, { ok: true });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/update/status") {
      const project = url.searchParams.get("project");
      if (!project) {
        sendJson(res, { error: "project required" }, 400);
        return true;
      }
      sendJson(res, { state: getUpdateState(project) ?? null });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/update/stream") {
      const project = url.searchParams.get("project");
      if (!project) {
        sendJson(res, { error: "project required" }, 400);
        return true;
      }
      assertProjectName(project);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      const updateState = getUpdateState(project);
      if (updateState) {
        res.write(`data: ${JSON.stringify({ type: "queue", tasks: updateState.tasks })}\n\n`);
        if (updateState.awaitingConfirm) {
          const current = updateState.tasks[updateState.currentIndex];
          if (current) res.write(`data: ${JSON.stringify({ type: "awaiting-confirm", taskId: current.id })}\n\n`);
        }
        if (updateState.awaitingReview) {
          const current = updateState.tasks[updateState.currentIndex];
          if (current && current.markdown) {
            res.write(`data: ${JSON.stringify({ type: "task-awaiting-review", taskId: current.id, markdown: current.markdown })}\n\n`);
          }
        }
      }
      const unsub = subscribeUpdate(project, (event: UpdateEvent) => {
        if (!res.writable) { unsub(); return; }
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      req.on("close", unsub);
      return true;
    }
    return false;
  };
}
