import "dotenv/config";
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
process.setMaxListeners(0);
import { query } from "@anthropic-ai/claude-agent-sdk";
import OpenAI from "openai";
import { Arranger, type Progress, type AgentBackend, type AgentBackends, type CheckerType } from "./workflow/arranger.js";
import type { Language } from "./agents/schemas/schema.js";

const PORT = Number(process.env.PORT ?? 3100);
const DOC_ROOT = path.resolve("web/doc");

type RunState =
  | { phase: "idle" }
  | { phase: "running"; repoPath: string; project: string; docDir: string; arranger: Arranger }
  | { phase: "done"; repoPath: string; project: string; docDir: string }
  | { phase: "error"; repoPath: string; project: string; message: string };

let state: RunState = { phase: "idle" };
const sseClients = new Set<import("node:http").ServerResponse>();

function broadcastStatus(): void {
  if (sseClients.size === 0) return;
  const send = async () => {
    const data = JSON.stringify(await handleStatus());
    for (const res of sseClients) {
      res.write(`data: ${data}\n\n`);
    }
  };
  send().catch(() => {});
}

let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedBroadcast(): void {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcastStatus();
  }, 500);
}

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

async function handleRun(body: {
  repoPath: string
  maxConcurrency?: number
  agentBackend?: AgentBackend
  agentBackends?: Partial<AgentBackends>
  checkerType?: CheckerType
  language?: Language
}): Promise<{ ok: boolean }> {
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

  const arranger = new Arranger({
    maxConcurrency: body.maxConcurrency,
    agentBackend: body.agentBackend,
    agentBackends: body.agentBackends,
    checkerType: body.checkerType,
    language: body.language,
  });
  state = { phase: "running", repoPath, project, docDir, arranger };
  arranger.onProgress(debouncedBroadcast);

  arranger.run(repoPath, docDir).then(
    () => {
      state = { phase: "done", repoPath, project, docDir };
      broadcastStatus();
    },
    (err) => {
      state = { phase: "error", repoPath, project, message: String(err) };
      broadcastStatus();
    },
  );

  return { ok: true };
}

interface RunConfig {
  maxConcurrency: number
  agentBackends: AgentBackends
  language: Language
}

interface StatusResponse {
  phase: "idle" | "running" | "done" | "error"
  paused?: boolean
  repoPath?: string
  currentProject?: string
  docDir?: string
  message?: string
  progress?: Progress
  config?: RunConfig
}

async function handleStatus(): Promise<StatusResponse> {
  if (state.phase === "running") {
    const progress = await state.arranger.getProgress();
    const config = state.arranger.getConfig();
    return { phase: "running", paused: state.arranger.paused, repoPath: state.repoPath, currentProject: state.project, docDir: state.docDir, progress, config };
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

interface SearchResult {
  name: string
  description: string
  path: string
  type: "graph" | "page"
}

async function searchModules(project: string, query: string): Promise<SearchResult[]> {
  const docDir = getProjectDocDir(project);
  const results: SearchResult[] = [];

  async function scanDir(dir: string, prefix: string) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "flows.json") continue;
      try {
        const raw = JSON.parse(await readFile(path.join(dir, entry.name), "utf-8"));
        const nodes = raw.nodes as Array<{ name: string; description: string; child?: { type: string; ref: string } }> | undefined;
        if (!nodes) continue;
        for (const node of nodes) {
          if (node.name.toLowerCase().includes(query) || node.description.toLowerCase().includes(query)) {
            const childType = node.child?.type ?? "graph";
            const ref = node.child?.ref ?? node.name;
            const nodePath = prefix ? `${prefix}/${ref}` : ref;
            results.push({ name: node.name, description: node.description, path: nodePath, type: childType as "graph" | "page" });
          }
        }
      } catch { /* skip invalid */ }
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "_pending") {
        await scanDir(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  }

  await scanDir(docDir, "");
  return results;
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
      const body = await parseBody(req) as {
        repoPath: string
        maxConcurrency?: number
        agentBackend?: AgentBackend
        agentBackends?: Partial<AgentBackends>
        checkerType?: AgentBackend
        language?: Language
      };
      const result = await handleRun(body);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } else if (req.method === "POST" && url.pathname === "/api/pause") {
      if (state.phase !== "running") throw new Error("Not running");
      state.arranger.pause();
      broadcastStatus();
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    } else if (req.method === "POST" && url.pathname === "/api/resume") {
      if (state.phase !== "running") throw new Error("Not running");
      state.arranger.resume();
      broadcastStatus();
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    } else if (req.method === "GET" && url.pathname === "/api/projects") {
      const projects = await listProjects();
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ projects }));
    } else if (req.method === "GET" && url.pathname === "/api/status") {
      const statusResult = await handleStatus();
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(statusResult));
    } else if (req.method === "GET" && url.pathname === "/api/status/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // 立即推送当前状态
      const initial = JSON.stringify(await handleStatus());
      res.write(`data: ${initial}\n\n`);
      sseClients.add(res);
      res.on("close", () => { sseClients.delete(res); });
      return;
    } else if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = (await parseBody(req)) as {
        messages: { role: "user" | "assistant"; content: string }[]
      };

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);

      try {
        const openai = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY,
          baseURL: process.env.OPENAI_BASE_URL,
        });

        const stream = await openai.chat.completions.create({
          model: process.env.OPENAI_MODEL ?? "gpt-4o",
          messages: body.messages,
          stream: true,
        });

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            send({ type: "text", text: delta });
          }
        }
      } catch (e) {
        send({ type: "error", text: String(e) });
      }

      send({ type: "done" });
      res.end();
    } else if (req.method === "GET" && url.pathname === "/api/search") {
      const project = url.searchParams.get("project");
      const q = (url.searchParams.get("q") ?? "").toLowerCase().trim();
      if (!project || !q) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Missing project or q" }));
        return;
      }
      const results = await searchModules(project, q);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ results }));
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
