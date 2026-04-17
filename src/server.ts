import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, readdir, stat, rm, mkdir, rename } from "node:fs/promises";
import path from "node:path";
process.setMaxListeners(0);
import OpenAI from "openai";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { Arranger, type Progress, type AgentBackend, type AgentBackends } from "./workflow/arranger.js";
import type { Language, IUpdater, IKnowledge } from "./agents/schemas/schema.js";
import {
  REPO_ROOT,
  DOC_ROOT,
  KNOWLEDGE_ROOT,
  readRegistry,
  upsertProject,
  knowledgePathOf,
  knowledgeDraftPathOf,
  type ProjectMeta,
} from "./souko/registry.js";
import * as git from "./git/repoManager.js";
import { claudeUpdater, codexUpdater, claudeKnowledge, codexKnowledge } from "./agents/tsukai/index.js";
import { DocStore } from "./mcp/docStore.js";
import { buildMcpServer } from "./mcp/server.js";

const PORT = Number(process.env.PORT ?? 3100);

const docStore = new DocStore(DOC_ROOT);

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

async function handleKnowledgeMessage(body: KnowledgeMessageBody): Promise<{ draft: string; question: string }> {
  const session = knowledgeSessions.get(body.sessionId);
  if (!session) throw new Error("Unknown knowledge session. Start a new one.");
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

type RunMode = "initial" | "incremental" | "noop";
type IncrementalStep = "fetching" | "updating";

type RunState =
  | { phase: "idle" }
  | {
      phase: "running";
      mode: RunMode;
      gitUrl: string;
      project: string;
      repoDir: string;
      docDir: string;
      arranger?: Arranger;
      step?: IncrementalStep;
    }
  | {
      phase: "done";
      mode: RunMode;
      gitUrl: string;
      project: string;
      repoDir: string;
      docDir: string;
      arranger?: Arranger;
    }
  | {
      phase: "error";
      gitUrl: string;
      project: string;
      repoDir: string;
      docDir: string;
      message: string;
      arranger?: Arranger;
    };

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

async function handleRun(body: RunBody): Promise<{ ok: boolean; mode: RunMode }> {
  if (state.phase === "running") {
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
  const prev = registry.projects[project];
  const repoExists = await stat(repoDir).then((s) => s.isDirectory()).catch(() => false);

  if (!prev || !repoExists) {
    await runInitial({ body, gitUrl, project, repoDir, docDir });
    return { ok: true, mode: "initial" };
  }

  return await runIncremental({ body, gitUrl, project, repoDir, docDir, prev });
}

interface RunArgs {
  body: RunBody;
  gitUrl: string;
  project: string;
  repoDir: string;
  docDir: string;
}

async function runInitial(args: RunArgs): Promise<void> {
  const { body, gitUrl, project, repoDir, docDir } = args;

  // Clean any half-state from a previous attempt before cloning fresh.
  await rm(repoDir, { recursive: true, force: true });
  await rm(docDir, { recursive: true, force: true });

  console.log(`[Run] initial: cloning ${gitUrl} → ${repoDir}`);
  await git.clone(gitUrl, repoDir);
  const head = await git.getHead(repoDir);
  const branch = await git.getCurrentBranch(repoDir);

  const arranger = new Arranger({
    maxConcurrency: body.maxConcurrency,
    agentBackend: body.agentBackend,
    agentBackends: body.agentBackends,
    language: body.language,
  });
  state = { phase: "running", mode: "initial", gitUrl, project, repoDir, docDir, arranger };
  arranger.onProgress(debouncedBroadcast);

  arranger.run(repoDir, docDir).then(
    async () => {
      await upsertProject(project, {
        sourceUrl: gitUrl,
        branch,
        head,
        lastUpdated: new Date().toISOString(),
      });
      state = { phase: "done", mode: "initial", gitUrl, project, repoDir, docDir, arranger };
      broadcastStatus();
    },
    (err) => {
      state = { phase: "error", gitUrl, project, repoDir, docDir, message: String(err), arranger };
      broadcastStatus();
    },
  );
}

async function runIncremental(args: RunArgs & { prev: ProjectMeta }): Promise<{ ok: boolean; mode: RunMode }> {
  const { body, gitUrl, project, repoDir, docDir, prev } = args;

  // Phase 1: fetch — show "fetching" immediately so the UI doesn't look frozen.
  state = { phase: "running", mode: "incremental", gitUrl, project, repoDir, docDir, step: "fetching" };
  broadcastStatus();
  console.log(`[Run] incremental: fetching ${repoDir}`);
  await git.fetchAndPull(repoDir);
  const newHead = await git.getHead(repoDir);

  if (newHead === prev.head) {
    console.log(`[Run] incremental: no commit change (${newHead.slice(0, 8)}), noop`);
    state = { phase: "done", mode: "noop", gitUrl, project, repoDir, docDir };
    broadcastStatus();
    return { ok: true, mode: "noop" };
  }

  const changedFiles = await git.diffNameOnly(repoDir, prev.head, newHead);
  const diffPatch = await git.diffPatch(repoDir, prev.head, newHead, changedFiles);
  console.log(`[Run] incremental: ${prev.head.slice(0, 8)} → ${newHead.slice(0, 8)} (${changedFiles.length} files)`);

  const language = body.language ?? "zh";
  const backend: AgentBackend = body.agentBackends?.updater ?? body.agentBackend ?? "claude";
  const updater: IUpdater =
    backend === "codex"
      ? new codexUpdater(project, { docDir, repoDir, prevCommit: prev.head, newCommit: newHead, changedFiles, diffPatch }, language)
      : new claudeUpdater(project, { docDir, repoDir, prevCommit: prev.head, newCommit: newHead, changedFiles, diffPatch }, language);

  const prompt =
    `项目 ${project} 在 ${prev.head.slice(0, 8)} → ${newHead.slice(0, 8)} 之间发生了 ${changedFiles.length} 个文件改动。` +
    `请按 SOP 局部更新文档树，使其与新代码一致。`;

  // Phase 2: hand off to Updater agent.
  state = { phase: "running", mode: "incremental", gitUrl, project, repoDir, docDir, step: "updating" };
  broadcastStatus();
  console.log(`[Run] incremental: invoking ${backend} Updater`);

  updater.run(prompt, repoDir).then(
    async ({ result }) => {
      console.log(`[Updater] ${result.summary}`);
      console.log(`[Updater] touched ${result.touched.length} files`);
      await upsertProject(project, {
        ...prev,
        head: newHead,
        lastUpdated: new Date().toISOString(),
      });
      state = { phase: "done", mode: "incremental", gitUrl, project, repoDir, docDir };
      broadcastStatus();
    },
    (err) => {
      state = { phase: "error", gitUrl, project, repoDir, docDir, message: String(err) };
      broadcastStatus();
    },
  );

  return { ok: true, mode: "incremental" };
}

// ─── Status ──────────────────────────────────────────────────

interface RunConfig {
  maxConcurrency: number;
  agentBackends: AgentBackends;
  language: Language;
}

interface StatusResponse {
  phase: "idle" | "running" | "done" | "error";
  mode?: RunMode;
  step?: IncrementalStep;
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
  if (state.phase === "running") {
    const progress = state.arranger ? await state.arranger.getProgress() : undefined;
    const config = state.arranger?.getConfig();
    return {
      phase: "running",
      mode: state.mode,
      step: state.step,
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
      mode: state.mode,
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
  // Also surface doc directories that exist but aren't in the registry yet
  // (e.g. legacy migrated docs). They appear with empty meta so the UI can
  // still browse them.
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
  const full = path.resolve(docDir, filePath);
  if (!full.startsWith(docDir)) throw new Error("Forbidden");
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
      state = { phase: "running", mode: "initial", gitUrl, project, repoDir, docDir, arranger };
      arranger.onProgress(debouncedBroadcast);
      broadcastStatus();
      arranger.resetErrorsAndResume().then(
        (count) => {
          console.log(`[RetryErrors] Reset and resumed ${count} error node(s).`);
          state = { phase: "done", mode: "initial", gitUrl, project, repoDir, docDir, arranger };
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
  console.log(`[Server] HTTP + MCP on http://localhost:${PORT}`);
  console.log(`[Server] DOC_ROOT=${DOC_ROOT}`);
  console.log(`[Server] REPO_ROOT=${REPO_ROOT}`);
});
