import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, readdir, stat, rm, mkdir, rename } from "node:fs/promises";
import path from "node:path";
process.setMaxListeners(0);
import OpenAI from "openai";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { Arranger, type Progress, type AgentBackend, type AgentBackends } from "./workflow/arranger.js";
import type { Language, IKnowledge } from "./agents/schemas/schema.js";
import {
  REPO_ROOT,
  DOC_ROOT,
  KNOWLEDGE_ROOT,
  readRegistry,
  upsertProject,
  knowledgePathOf,
  knowledgeDraftPathOf,
  repoDirOf,
  type ProjectMeta,
} from "./souko/registry.js";
import * as git from "./git/repoManager.js";
import { claudeKnowledge, codexKnowledge } from "./agents/tsukai/index.js";
import { DocStore } from "./mcp/docStore.js";
import { DocGit } from "./mcp/docGit.js";
import { buildMcpServer } from "./mcp/server.js";
import {
  startUpdate, continueUpdate, skipTask, cancelUpdate, acceptTask, chatOnTask,
  getUpdateState, subscribe as subscribeUpdate,
  type UpdateEvent,
} from "./workflow/updateOrchestrator.js";

const PORT = Number(process.env.PORT ?? 3100);

const docGit = new DocGit(DOC_ROOT);
const docStore = new DocStore(DOC_ROOT, repoDirOf, docGit);

// ─── Knowledge elicitor sessions ─────────────────────────────

interface KnowledgeSession {
  agent: IKnowledge;
  project: string;
}

const knowledgeSessions = new Map<string, KnowledgeSession>();

function validateProjectName(project: string): void {
  if (!project || project.includes("/") || project.includes("\\") || project.startsWith(".")) {
    throw new Error("Invalid project");
  }
}

async function readExistingDraftOrKnowledge(project: string): Promise<string> {
  try {
    return await readFile(knowledgeDraftPathOf(project), "utf-8");
  } catch { /* fall through */ }
  try {
    return await readFile(knowledgePathOf(project), "utf-8");
  } catch {
    return "";
  }
}

function buildKnowledgeFirstPrompt(
  project: string,
  existingDraft: string,
  userMessage: string,
  language: Language,
): string {
  const header = language === "en"
    ? `You are helping author knowledge.md for repository "${project}".`
    : `你正在协助用户为仓库 "${project}" 撰写 knowledge.md。`;
  const draftLabel = language === "en" ? "## Current draft" : "## 当前草稿";
  const draftBody = existingDraft.trim() ? existingDraft : (language === "en" ? "(empty — nothing yet)" : "（空白，尚未开始）");
  const userLabel = language === "en" ? "## User's first message" : "## 用户首条消息";
  const instruction = language === "en"
    ? "Fold the user's message into the draft (consult the repo as needed via Read/Grep/Glob), then produce the updated full draft and one focused follow-up question."
    : "把用户这条消息吸纳进草稿（按需用 Read/Grep/Glob 看仓库），然后输出更新后的完整草稿，并给出一个聚焦的后续问题。";
  return [header, "", draftLabel, draftBody, "", userLabel, userMessage, "", instruction].join("\n");
}

async function writeDraft(project: string, content: string): Promise<void> {
  await mkdir(KNOWLEDGE_ROOT, { recursive: true });
  await writeFile(knowledgeDraftPathOf(project), content);
}

function makeKnowledgeAgent(backend: AgentBackend, language: Language): IKnowledge {
  return backend === "codex" ? new codexKnowledge(language) : new claudeKnowledge(language);
}

async function handleKnowledgeGet(project: string): Promise<{ exists: boolean; content?: string; draftExists?: boolean }> {
  validateProjectName(project);
  let content: string | undefined;
  try {
    content = await readFile(knowledgePathOf(project), "utf-8");
  } catch { /* not present */ }
  let draftExists = false;
  try {
    await stat(knowledgeDraftPathOf(project));
    draftExists = true;
  } catch { /* no draft */ }
  return { exists: content !== undefined, content, draftExists };
}

interface KnowledgeStartBody {
  project: string;
  userMessage: string;
  language?: Language;
  agentBackend?: AgentBackend;
}

async function handleKnowledgeStart(body: KnowledgeStartBody): Promise<{ sessionId: string; draft: string; question: string }> {
  validateProjectName(body.project);
  if (!body.userMessage || typeof body.userMessage !== "string" || !body.userMessage.trim()) {
    throw new Error("Missing userMessage");
  }
  const language: Language = body.language ?? "zh";
  const backend: AgentBackend = body.agentBackend ?? "claude";
  const repoDir = path.join(REPO_ROOT, body.project);
  const repoExists = await stat(repoDir).then((s) => s.isDirectory()).catch(() => false);
  if (!repoExists) {
    throw new Error(`Repository not found for project "${body.project}". Clone it first by running the pipeline.`);
  }

  const existingDraft = await readExistingDraftOrKnowledge(body.project);
  const prompt = buildKnowledgeFirstPrompt(body.project, existingDraft, body.userMessage, language);

  const agent = makeKnowledgeAgent(backend, language);
  const { sessionId, result } = await agent.run(prompt, repoDir);
  await writeDraft(body.project, result.draft);
  knowledgeSessions.set(sessionId, { agent, project: body.project });

  return { sessionId, draft: result.draft, question: result.question };
}

interface KnowledgeMessageBody {
  sessionId: string;
  userReply: string;
}

class KnowledgeSessionExpiredError extends Error {
  code = "SESSION_EXPIRED" as const;
  constructor() { super("Knowledge session expired. Start a new one."); }
}

async function handleKnowledgeMessage(body: KnowledgeMessageBody): Promise<{ draft: string; question: string }> {
  const session = knowledgeSessions.get(body.sessionId);
  if (!session) throw new KnowledgeSessionExpiredError();
  if (!body.userReply || typeof body.userReply !== "string") throw new Error("Missing userReply");

  const { result } = await session.agent.continue(body.userReply);
  await writeDraft(session.project, result.draft);
  return { draft: result.draft, question: result.question };
}

interface KnowledgeFinalizeBody {
  sessionId: string;
  project: string;
}

async function handleKnowledgeFinalize(body: KnowledgeFinalizeBody): Promise<{ ok: true; path: string }> {
  validateProjectName(body.project);
  const draftPath = knowledgeDraftPathOf(body.project);
  const finalPath = knowledgePathOf(body.project);
  await stat(draftPath).catch(() => { throw new Error("No draft to finalize"); });
  await mkdir(KNOWLEDGE_ROOT, { recursive: true });
  await rename(draftPath, finalPath);
  knowledgeSessions.delete(body.sessionId);
  return { ok: true, path: finalPath };
}

async function handleKnowledgeDiscard(project: string): Promise<{ ok: true }> {
  validateProjectName(project);
  await rm(knowledgeDraftPathOf(project), { force: true });
  return { ok: true };
}

// ─── Run state ───────────────────────────────────────────────

interface RunContext {
  gitUrl: string;
  project: string;
  repoDir: string;
  docDir: string;
}

type RunState =
  | { phase: "idle" }
  | (RunContext & { phase: "cloning"; config: RunBody })
  | (RunContext & { phase: "awaiting-knowledge"; config: RunBody })
  | (RunContext & { phase: "running"; arranger: Arranger })
  | (RunContext & { phase: "done"; arranger?: Arranger })
  | (RunContext & { phase: "error"; message: string; arranger?: Arranger });

let state: RunState = { phase: "idle" };
const sseClients = new Set<ServerResponse>();

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

// ─── Run handler ─────────────────────────────────────────────

interface RunBody {
  gitUrl: string;
  maxConcurrency?: number;
  agentBackend?: AgentBackend;
  agentBackends?: Partial<AgentBackends>;
  language?: Language;
}

async function handleRun(body: RunBody): Promise<{ ok: boolean; project: string }> {
  if (state.phase === "cloning" || state.phase === "awaiting-knowledge" || state.phase === "running") {
    throw new Error("Already running");
  }
  if (!body.gitUrl || typeof body.gitUrl !== "string") {
    throw new Error("Missing gitUrl");
  }

  const gitUrl = body.gitUrl.trim();
  const project = git.projectNameFromUrl(gitUrl);
  const repoDir = path.join(REPO_ROOT, project);
  const docDir = path.join(DOC_ROOT, project);

  const registry = await readRegistry();
  if (registry.projects[project]) {
    throw new Error(`Project "${project}" is already generated. Delete it first to regenerate.`);
  }

  // Orphan docDir (has top.json but not in registry) = partial run from a prior
  // crash. Keep it — arranger.run() skips scaffold when top.json exists and
  // resetRecoverableNodes() flips stuck decomposing/writing/checking back to
  // pending so the pipeline resumes from where it stopped.
  const isResumable = await stat(path.join(docDir, "top.json"))
    .then((s) => s.isFile())
    .catch(() => false);
  if (!isResumable) {
    await rm(docDir, { recursive: true, force: true });
  }
  const hasKnowledge = await stat(knowledgePathOf(project))
    .then((s) => s.isFile())
    .catch(() => false);
  const repoAlreadyCloned = await stat(repoDir)
    .then((s) => s.isDirectory())
    .catch(() => false);
  const autoSkipKnowledge = isResumable || hasKnowledge || repoAlreadyCloned;

  state = { phase: "cloning", gitUrl, project, repoDir, docDir, config: body };
  broadcastStatus();

  (async () => {
    try {
      if (!repoAlreadyCloned) {
        console.log(`[Run] cloning ${gitUrl} → ${repoDir}`);
        await git.clone(gitUrl, repoDir);
      } else {
        console.log(`[Run] repo already on disk at ${repoDir}, skipping clone`);
      }
      state = { phase: "awaiting-knowledge", gitUrl, project, repoDir, docDir, config: body };
      if (autoSkipKnowledge) {
        console.log(`[Run] project already started (resumable=${isResumable}, hasKnowledge=${hasKnowledge}, repoCloned=${repoAlreadyCloned}), skipping knowledge elicitor`);
        await handleRunContinue();
      } else {
        broadcastStatus();
      }
    } catch (err) {
      state = { phase: "error", gitUrl, project, repoDir, docDir, message: String(err) };
      broadcastStatus();
    }
  })();

  return { ok: true, project };
}

async function handleRunContinue(): Promise<{ ok: boolean }> {
  if (state.phase !== "awaiting-knowledge") {
    throw new Error(`Cannot continue run: current phase is "${state.phase}"`);
  }
  const { gitUrl, project, repoDir, docDir, config } = state;

  const arranger = new Arranger({
    maxConcurrency: config.maxConcurrency,
    agentBackend: config.agentBackend,
    agentBackends: config.agentBackends,
    language: config.language,
  });
  state = { phase: "running", gitUrl, project, repoDir, docDir, arranger };
  arranger.onProgress(debouncedBroadcast);
  broadcastStatus();

  const headPromise = git.getHead(repoDir);
  const branchPromise = git.getCurrentBranch(repoDir);

  arranger.run(repoDir, docDir).then(
    async () => {
      const [head, branch] = await Promise.all([headPromise, branchPromise]);
      await upsertProject(project, {
        sourceUrl: gitUrl,
        branch,
        head,
        lastUpdated: new Date().toISOString(),
      });
      state = { phase: "done", gitUrl, project, repoDir, docDir, arranger };
      broadcastStatus();
    },
    (err) => {
      state = { phase: "error", gitUrl, project, repoDir, docDir, message: String(err), arranger };
      broadcastStatus();
    },
  );
  return { ok: true };
}

// ─── Status ──────────────────────────────────────────────────

interface RunConfig {
  maxConcurrency: number;
  agentBackends: AgentBackends;
  language: Language;
}

interface StatusResponse {
  phase: "idle" | "cloning" | "awaiting-knowledge" | "running" | "done" | "error";
  paused?: boolean;
  gitUrl?: string;
  currentProject?: string;
  repoDir?: string;
  docDir?: string;
  message?: string;
  progress?: Progress;
  config?: RunConfig;
}

async function handleStatus(): Promise<StatusResponse> {
  if (state.phase === "cloning" || state.phase === "awaiting-knowledge") {
    return {
      phase: state.phase,
      gitUrl: state.gitUrl,
      currentProject: state.project,
      repoDir: state.repoDir,
      docDir: state.docDir,
    };
  }
  if (state.phase === "running") {
    const progress = state.arranger ? await state.arranger.getProgress() : undefined;
    const config = state.arranger?.getConfig();
    return {
      phase: "running",
      paused: state.arranger?.paused ?? false,
      gitUrl: state.gitUrl,
      currentProject: state.project,
      repoDir: state.repoDir,
      docDir: state.docDir,
      progress,
      config,
    };
  }
  if (state.phase === "done") {
    const progress = state.arranger ? await state.arranger.getProgress() : undefined;
    return {
      phase: "done",
      gitUrl: state.gitUrl,
      currentProject: state.project,
      repoDir: state.repoDir,
      docDir: state.docDir,
      progress,
    };
  }
  if (state.phase === "error") {
    const progress = state.arranger ? await state.arranger.getProgress() : undefined;
    return {
      phase: "error",
      gitUrl: state.gitUrl,
      currentProject: state.project,
      repoDir: state.repoDir,
      docDir: state.docDir,
      message: state.message,
      progress,
    };
  }
  return { phase: "idle" };
}

// ─── Project listing (registry-driven) ───────────────────────

interface ProjectListEntry extends ProjectMeta {
  name: string;
  hasDoc: boolean;
}

async function listProjects(): Promise<ProjectListEntry[]> {
  const reg = await readRegistry();
  const out: ProjectListEntry[] = [];
  for (const [name, meta] of Object.entries(reg.projects)) {
    const hasDoc = await stat(path.join(DOC_ROOT, name, "top.json"))
      .then((s) => s.isFile())
      .catch(() => false);
    out.push({ name, hasDoc, ...meta });
  }
  // Also surface doc directories that exist but aren't in the registry yet —
  // partial runs from a prior crash. Empty meta (no lastUpdated) is what lets
  // the UI distinguish partial from complete.
  const dirs = await readdir(DOC_ROOT, { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    if (reg.projects[d.name]) continue;
    const hasDoc = await stat(path.join(DOC_ROOT, d.name, "top.json"))
      .then((s) => s.isFile())
      .catch(() => false);
    if (!hasDoc) continue;
    out.push({
      name: d.name,
      hasDoc: true,
      sourceUrl: "",
      branch: "",
      head: "",
      lastUpdated: "",
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Doc file passthrough ────────────────────────────────────

async function handleDocFile(docDir: string, filePath: string): Promise<{ content: string; type: string }> {
  const base = path.resolve(docDir);
  const full = path.resolve(base, filePath);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error("Forbidden");
  const content = await readFile(full, "utf-8");
  const type = full.endsWith(".json") ? "application/json" : "text/plain";
  return { content, type };
}

function getProjectDocDir(project: string): string {
  if (!project || project.includes("/") || project.includes("\\")) {
    throw new Error("Invalid project");
  }
  return path.join(DOC_ROOT, project);
}

// ─── Search (unchanged behavior, just new DOC_ROOT) ──────────

interface SearchResult {
  name: string;
  description: string;
  path: string;
  type: "graph" | "page";
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
      if (entry.isDirectory() && entry.name !== "_pending" && !entry.name.startsWith(".")) {
        await scanDir(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  }

  await scanDir(docDir, "");
  return results;
}

// ─── HTTP plumbing ───────────────────────────────────────────

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
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

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseBody(req);
  const mcp = buildMcpServer(docStore);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    mcp.close().catch(() => {});
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  try {
    if (req.method === "POST" && url.pathname === "/mcp") {
      await handleMcp(req, res);
      return;
    }
    if (url.pathname === "/mcp") {
      res.writeHead(405).end("Method Not Allowed");
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      const body = (await parseBody(req)) as unknown as RunBody;
      const result = await handleRun(body);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } else if (req.method === "POST" && url.pathname === "/api/run/continue") {
      const result = await handleRunContinue();
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } else if (req.method === "POST" && url.pathname === "/api/pause") {
      if (state.phase !== "running" || !state.arranger) throw new Error("Not running");
      state.arranger.pause();
      broadcastStatus();
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    } else if (req.method === "POST" && url.pathname === "/api/resume") {
      if (state.phase !== "running" || !state.arranger) throw new Error("Not running");
      state.arranger.resume();
      broadcastStatus();
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    } else if (req.method === "POST" && url.pathname === "/api/retry-errors") {
      if ((state.phase !== "done" && state.phase !== "error") || !state.arranger) throw new Error("No completed run with arranger to retry");
      const arranger = state.arranger;
      const { gitUrl, project, repoDir, docDir } = state;
      state = { phase: "running", gitUrl, project, repoDir, docDir, arranger };
      arranger.onProgress(debouncedBroadcast);
      broadcastStatus();
      arranger.resetErrorsAndResume().then(
        (count) => {
          console.log(`[RetryErrors] Reset and resumed ${count} error node(s).`);
          state = { phase: "done", gitUrl, project, repoDir, docDir, arranger };
          broadcastStatus();
        },
        (err) => {
          state = { phase: "error", gitUrl, project, repoDir, docDir, message: String(err), arranger };
          broadcastStatus();
        },
      );
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
    } else if (req.method === "GET" && url.pathname === "/api/knowledge") {
      const project = url.searchParams.get("project") ?? "";
      const result = await handleKnowledgeGet(project);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } else if (req.method === "POST" && url.pathname === "/api/knowledge/start") {
      const body = (await parseBody(req)) as unknown as KnowledgeStartBody;
      const result = await handleKnowledgeStart(body);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } else if (req.method === "POST" && url.pathname === "/api/knowledge/message") {
      const body = (await parseBody(req)) as unknown as KnowledgeMessageBody;
      const result = await handleKnowledgeMessage(body);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } else if (req.method === "POST" && url.pathname === "/api/knowledge/finalize") {
      const body = (await parseBody(req)) as unknown as KnowledgeFinalizeBody;
      const result = await handleKnowledgeFinalize(body);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } else if (req.method === "POST" && url.pathname === "/api/knowledge/discard") {
      const body = (await parseBody(req)) as unknown as { project: string };
      const result = await handleKnowledgeDiscard(body.project);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } else if (req.method === "GET" && url.pathname === "/api/search") {
      const project = url.searchParams.get("project");
      const q = (url.searchParams.get("q") ?? "").toLowerCase().trim();
      if (!project || !q) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Missing project or q" }));
        return;
      }
      const results = await searchModules(project, q);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ results }));
    // ─── Update endpoints ───
    } else if (req.method === "POST" && url.pathname === "/api/update/start") {
      const body = (await parseBody(req)) as { project: string; mode?: "auto" | "manual"; backend?: "claude" | "codex"; language?: "zh" | "en" };
      if (!body.project) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "project required" }));
        return;
      }
      const state = await startUpdate(body.project, { mode: body.mode, backend: body.backend, language: body.language });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, tasks: state.tasks }));
    } else if (req.method === "POST" && url.pathname === "/api/update/continue") {
      const body = (await parseBody(req)) as { project: string; extraInstructions?: string };
      continueUpdate(body.project, body.extraInstructions);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    } else if (req.method === "POST" && url.pathname === "/api/update/skip") {
      const body = (await parseBody(req)) as { project: string; taskId: string };
      skipTask(body.project, body.taskId);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    } else if (req.method === "POST" && url.pathname === "/api/update/cancel") {
      const body = (await parseBody(req)) as { project: string };
      cancelUpdate(body.project);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    } else if (req.method === "POST" && url.pathname === "/api/update/task/accept") {
      const body = (await parseBody(req)) as { project: string; taskId: string };
      await acceptTask(body.project, body.taskId);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    } else if (req.method === "POST" && url.pathname === "/api/update/task/chat") {
      const body = (await parseBody(req)) as { project: string; taskId: string; prompt: string };
      // Fire-and-forget so the HTTP response returns immediately and the SSE stream carries progress
      void chatOnTask(body.project, body.taskId, body.prompt).catch(() => {});
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    } else if (req.method === "GET" && url.pathname === "/api/update/status") {
      const project = url.searchParams.get("project");
      if (!project) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "project required" }));
        return;
      }
      const state = getUpdateState(project);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ state: state ?? null }));
    } else if (req.method === "GET" && url.pathname === "/api/update/stream") {
      const project = url.searchParams.get("project");
      if (!project) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "project required" }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      const state = getUpdateState(project);
      if (state) {
        res.write(`data: ${JSON.stringify({ type: "queue", tasks: state.tasks })}\n\n`);
        if (state.awaitingConfirm) {
          const current = state.tasks[state.currentIndex];
          if (current) {
            res.write(`data: ${JSON.stringify({ type: "awaiting-confirm", taskId: current.id })}\n\n`);
          }
        }
        if (state.awaitingReview) {
          const current = state.tasks[state.currentIndex];
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
    // ─── Doc git endpoints ───
    } else if (req.method === "GET" && url.pathname === "/api/doc-git/status") {
      const project = url.searchParams.get("project");
      if (!project) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "project required" }));
        return;
      }
      const status = await docGit.status(project);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(status));
    } else if (req.method === "POST" && url.pathname === "/api/doc-git/commit") {
      const body = (await parseBody(req)) as { project: string; message: string };
      if (!body.project || !body.message?.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "project and message required" }));
        return;
      }
      const result = await docGit.commitAll(body.project, body.message);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } else if (req.method === "GET" && url.pathname === "/api/doc-git/blame") {
      const project = url.searchParams.get("project");
      const nodeId = url.searchParams.get("nodeId");
      if (!project || nodeId == null) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "project and nodeId required" }));
        return;
      }
      const rel = await docStore.resolveNodeId(project, nodeId);
      const lines = await docGit.blame(project, rel);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ lines }));
    // ─── Doc mutation endpoints ───
    } else if (req.method === "POST" && url.pathname === "/api/doc/create-node") {
      const body = (await parseBody(req)) as {
        project: string; parentNodeId: string;
        node: import("./mcp/schema.js").GraphNodeT; initialContent?: string;
      };
      const written = await docStore.createNode(body.project, body.parentNodeId, body.node, body.initialContent);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(written));
    } else if (req.method === "POST" && url.pathname === "/api/doc/update-node") {
      const body = (await parseBody(req)) as {
        project: string; parentNodeId: string; nodeName: string;
        patch: { name?: string; description?: string; codeScope?: string[]; edges?: import("./mcp/schema.js").GraphEdgeT[] };
      };
      const written = await docStore.updateNode(body.project, body.parentNodeId, body.nodeName, body.patch);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(written));
    } else if (req.method === "POST" && url.pathname === "/api/doc/delete-node") {
      const body = (await parseBody(req)) as { project: string; parentNodeId: string; nodeName: string };
      const written = await docStore.deleteNode(body.project, body.parentNodeId, body.nodeName);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(written));
    } else if (req.method === "POST" && url.pathname === "/api/doc/update-page") {
      const body = (await parseBody(req)) as { project: string; nodeId: string; ref: string; content: string };
      await docStore.writePage(body.project, body.nodeId, body.ref, body.content);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    } else if (req.method === "POST" && url.pathname === "/api/doc/patch-page") {
      const body = (await parseBody(req)) as { project: string; nodeId: string; ref: string; edits: { old_text: string; new_text: string }[] };
      const result = await docStore.patchPage(body.project, body.nodeId, body.ref, body.edits);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } else if (req.method === "GET" && url.pathname.startsWith("/api/doc/")) {
      let docDir: string | undefined;
      const project = url.searchParams.get("project");
      if (project) docDir = getProjectDocDir(project);
      else if (state.phase === "done" || state.phase === "running") docDir = state.docDir;
      if (!docDir) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not ready" }));
        return;
      }
      const filePath = url.pathname.slice("/api/doc/".length);
      if (filePath.split("/").some(seg => seg.startsWith("."))) {
        res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Forbidden" }));
        return;
      }
      const { content, type } = await handleDocFile(docDir, filePath);
      res.writeHead(200, { "Content-Type": type }).end(content);
    } else {
      res.writeHead(404).end("Not found");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = e instanceof KnowledgeSessionExpiredError ? e.code : undefined;
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: msg, ...(code ? { code } : {}) }));
  }
});

server.listen(PORT, () => {
  console.log(`[Server] HTTP + MCP on http://localhost:${PORT}`);
  console.log(`[Server] DOC_ROOT=${DOC_ROOT}`);
  console.log(`[Server] REPO_ROOT=${REPO_ROOT}`);
});
