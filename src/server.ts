import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { query, forkSession } from "@anthropic-ai/claude-agent-sdk";
import { Arranger, type Progress } from "./workflow/arranger.js";

const PORT = Number(process.env.PORT ?? 3100);
const DOC_ROOT = path.resolve("web/doc");

type RunState =
  | { phase: "idle" }
  | { phase: "running"; repoPath: string; project: string; docDir: string; arranger: Arranger }
  | { phase: "done"; repoPath: string; project: string; docDir: string }
  | { phase: "error"; repoPath: string; project: string; message: string };

let state: RunState = { phase: "idle" };

function getProjectName(repoPath: string): string {
  return path.basename(path.resolve(repoPath));
}

function getProjectDocDir(project: string): string {
  if (!project || project.includes("/") || project.includes("\\")) {
    throw new Error("Invalid project");
  }
  return path.join(DOC_ROOT, project);
}

async function listProjects(): Promise<string[]> {
  const entries = await readdir(DOC_ROOT, { withFileTypes: true }).catch(() => []);
  const projects = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const topGraph = await stat(path.join(DOC_ROOT, entry.name, "top.json")).catch(() => null);
        return topGraph?.isFile() ? entry.name : null;
      }),
  );
  return projects.filter((project): project is string => Boolean(project)).sort();
}

async function handleRun(body: { repoPath: string; maxConcurrency?: number }): Promise<{ ok: boolean }> {
  if (state.phase === "running") {
    throw new Error("Already running");
  }
  const repoPath = body.repoPath;
  const project = getProjectName(repoPath);
  const docDir = getProjectDocDir(project);
  const s = await stat(repoPath).catch(() => null);
  if (!s?.isDirectory()) {
    throw new Error("Invalid path: not a directory");
  }

  const arranger = new Arranger({ maxConcurrency: body.maxConcurrency });
  state = { phase: "running", repoPath, project, docDir, arranger };

  arranger.run(repoPath, docDir).then(
    () => {
      state = { phase: "done", repoPath, project, docDir };
    },
    (err) => {
      state = { phase: "error", repoPath, project, message: String(err) };
    },
  );

  return { ok: true };
}

interface StatusResponse {
  phase: "idle" | "running" | "done" | "error"
  repoPath?: string
  currentProject?: string
  docDir?: string
  message?: string
  progress?: Progress
}

async function handleStatus(): Promise<StatusResponse> {
  if (state.phase === "running") {
    const progress = await state.arranger.getProgress();
    return { phase: "running", repoPath: state.repoPath, currentProject: state.project, docDir: state.docDir, progress };
  }
  if (state.phase === "done") {
    return { phase: "done", repoPath: state.repoPath, currentProject: state.project, docDir: state.docDir };
  }
  if (state.phase === "error") {
    return { phase: "error", repoPath: state.repoPath, currentProject: state.project, message: state.message };
  }
  return { phase: "idle" };
}

async function handleDocFile(docDir: string, filePath: string): Promise<{ content: string; type: string }> {
  const full = path.resolve(docDir, filePath);
  if (!full.startsWith(docDir)) throw new Error("Forbidden");
  const content = await readFile(full, "utf-8");
  const type = full.endsWith(".json") ? "application/json" : "text/plain";
  return { content, type };
}

function parseBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  try {
    if (req.method === "POST" && url.pathname === "/api/run") {
      const body = await parseBody(req) as { repoPath: string; maxConcurrency?: number };
      const result = await handleRun(body);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } else if (req.method === "GET" && url.pathname === "/api/projects") {
      const projects = await listProjects();
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ projects }));
    } else if (req.method === "GET" && url.pathname === "/api/status") {
      const statusResult = await handleStatus();
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(statusResult));
    } else if (req.method === "POST" && url.pathname === "/api/chat") {
      if (state.phase !== "done" && state.phase !== "running") {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "No project loaded" }));
        return;
      }
      const body = (await parseBody(req)) as {
        message: string
        chatSessionId?: string    // chat 分叉后的 sessionId（续聊用）
        agentSessionId?: string   // 原始 agent sessionId（首次消息时用于 fork）
      };
      const repoPath = "repoPath" in state ? state.repoPath : "";

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);

      try {
        let resumeId = body.chatSessionId;

        // 首次消息：从原始 agent session fork，保留完整上下文但不污染原始记录
        if (!resumeId && body.agentSessionId) {
          const { sessionId: forkedId } = await forkSession(body.agentSessionId);
          resumeId = forkedId;
          send({ type: "session", sessionId: forkedId });
        }

        for await (const msg of query({
          prompt: body.message,
          options: {
            model: "claude-sonnet-4-6",
            permissionMode: "dontAsk",
            allowedTools: ["Read", "Glob", "Grep"],
            cwd: repoPath,
            ...(resumeId ? { resume: resumeId } : {}),
          },
        })) {
          const m = msg as Record<string, unknown>;
          if (m.type === "system" && m.subtype === "init") {
            // 如果是全新会话（无 agentSessionId 可 fork），返回新 sessionId
            if (!body.chatSessionId && !body.agentSessionId) {
              send({ type: "session", sessionId: m.session_id });
            }
          }
          if (m.type === "result" && m.subtype === "success") {
            const text = typeof m.result === "string" ? m.result : JSON.stringify(m.result ?? "");
            send({ type: "text", text });
          }
        }
      } catch (e) {
        send({ type: "error", text: String(e) });
      }

      send({ type: "done" });
      res.end();
    } else if (req.method === "GET" && url.pathname.startsWith("/api/doc/")) {
      // running 时也能读已完成的 doc 文件（即时渲染）
      let docDir: string | undefined;
      const project = url.searchParams.get("project");
      if (project) docDir = getProjectDocDir(project);
      else if (state.phase === "done" || state.phase === "running") docDir = state.docDir;
      if (!docDir) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not ready" }));
        return;
      }
      const filePath = url.pathname.slice("/api/doc/".length);
      const { content, type } = await handleDocFile(docDir, filePath);
      res.writeHead(200, { "Content-Type": type }).end(content);
    } else {
      res.writeHead(404).end("Not found");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: msg }));
  }
});

server.listen(PORT, () => {
  console.log(`[Server] Listening on http://localhost:${PORT}`);
});
