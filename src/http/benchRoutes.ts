import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { sendJson, type HttpContext, type RouteHandler } from "./types.js";

const BENCH_DIR = path.resolve("bench/data");
const GENERATE_SCRIPT = path.resolve("bench/scripts/generate-qa.ts");

interface GenerateState {
  status: "running" | "done" | "error";
  log: string[];
  error?: string;
}

const generateTasks = new Map<string, GenerateState>();

export function createBenchRoutes(): RouteHandler {
  return async (ctx: HttpContext): Promise<boolean> => {
    const { req, res, url } = ctx;
    const p = url.pathname;

    if (p === "/api/bench/runs" && req.method === "GET") {
      const project = url.searchParams.get("project");
      const runs = await listRuns(project ?? undefined);
      sendJson(res, runs);
      return true;
    }

    const runMatch = p.match(/^\/api\/bench\/runs\/([^/]+)$/);
    if (runMatch && req.method === "GET") {
      const [, project] = runMatch;
      const data = await readRun(project!);
      if (!data) { sendJson(res, { error: "Not found" }, 404); return true; }
      sendJson(res, data);
      return true;
    }

    if (p === "/api/bench/generate" && req.method === "POST") {
      const body = await readBody(req);
      const result = startGenerate(body);
      sendJson(res, result);
      return true;
    }

    if (p === "/api/bench/generate/status" && req.method === "GET") {
      const tasks: Record<string, GenerateState> = {};
      for (const [project, state] of generateTasks) {
        tasks[project] = { ...state };
      }
      sendJson(res, { tasks });
      return true;
    }

    return false;
  };
}

interface RunSummary {
  project: string;
  itemCount: number;
  createdAt: string;
  providers: string[];
}

async function listRuns(project?: string): Promise<RunSummary[]> {
  const baseDir = await stat(BENCH_DIR).catch(() => null);
  if (!baseDir?.isDirectory()) return [];

  const projects = project
    ? [project]
    : (await readdir(BENCH_DIR, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

  const runs: RunSummary[] = [];
  for (const proj of projects) {
    const file = path.join(BENCH_DIR, proj, "qa.generated.json");
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) continue;
    try {
      const raw = JSON.parse(await readFile(file, "utf-8"));
      runs.push({
        project: proj,
        itemCount: raw.items?.length ?? 0,
        createdAt: raw.createdAt ?? "",
        providers: raw.providers ?? [],
      });
    } catch { /* skip corrupt files */ }
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function readRun(project: string): Promise<unknown | null> {
  const file = path.join(BENCH_DIR, project, "qa.generated.json");
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return null;
  return JSON.parse(await readFile(file, "utf-8"));
}

function startGenerate(body: Record<string, unknown>): { ok: boolean; error?: string } {
  const project = String(body.project ?? "git");
  const existing = generateTasks.get(project);
  if (existing?.status === "running") {
    return { ok: false, error: `Generation already running for ${project}` };
  }

  const repo = path.resolve("src/souko/repo", project);
  const args: string[] = [];
  args.push("--project", project);
  args.push("--repo", repo);
  if (body.language) args.push("--language", String(body.language));
  if (body.count) args.push("--count", String(body.count));
  if (body.batchSize) args.push("--batch-size", String(body.batchSize));
  if (body.providers) args.push("--providers", String(body.providers));
  if (body.claudeModel) args.push("--claude-model", String(body.claudeModel));
  if (body.codexModel) args.push("--codex-model", String(body.codexModel));

  const state: GenerateState = { status: "running", log: [] };
  generateTasks.set(project, state);

  const child = spawn("pnpm", ["exec", "tsx", GENERATE_SCRIPT, ...args], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) state.log.push(line);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) state.log.push(line);
  });

  child.on("close", (code) => {
    state.status = code === 0 ? "done" : "error";
    if (code !== 0) state.error = `Process exited with code ${code}`;
  });

  child.on("error", (err) => {
    state.status = "error";
    state.error = err.message;
  });

  return { ok: true };
}

function readBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}
