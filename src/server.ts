import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, readdir, stat, rm, mkdir, rename } from "node:fs/promises";
import path from "node:path";
process.setMaxListeners(0);
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { Arranger, type Progress, type AgentBackend, type AgentBackends } from "./workflow/arranger.js";
import { GraphStore } from "./workflow/arranger/graphStore.js";
import type { GraphNode, Language, IKnowledge, KnowledgeTurn } from "./agents/schemas/schema.js";
import {
  REPO_ROOT,
  DOC_ROOT,
  KNOWLEDGE_ROOT,
  readRegistry,
  upsertProject,
  knowledgePathOf,
  knowledgeDraftPathOf,
  repoDirOf,
  assertProjectName,
  type ProjectMeta,
} from "./souko/registry.js";
import * as git from "./git/repoManager.js";
import { claudeKnowledge, codexKnowledge } from "./agents/tsukai/index.js";
import { DocStore } from "./mcp/docStore.js";
import { DocGit } from "./mcp/docGit.js";
import { buildMcpServer } from "./mcp/server.js";
import { parseBody, sendJson, type HttpContext, type RouteHandler } from "./http/types.js";
import { createMcpRoutes } from "./http/mcpRoutes.js";
import { createRunRoutes, type RunBody } from "./http/runRoutes.js";
import { createStatusRoutes } from "./http/statusRoutes.js";
import { createChatRoutes } from "./http/chatRoutes.js";
import {
  createKnowledgeRoutes,
  type KnowledgeFinalizeBody,
  type KnowledgeMessageBody,
  type KnowledgeStartBody,
} from "./http/knowledgeRoutes.js";
import { createSearchRoutes } from "./http/searchRoutes.js";
import { createInsightRoutes } from "./http/insightRoutes.js";
import { createUpdateRoutes } from "./http/updateRoutes.js";
import { createDocGitRoutes } from "./http/docGitRoutes.js";
import { createDocRoutes } from "./http/docRoutes.js";
import { createDecompositionReviewRoutes } from "./http/decompositionReviewRoutes.js";
import { createSubgraphPauseRoutes } from "./http/subgraphPauseRoutes.js";
import { createBenchRoutes } from "./http/benchRoutes.js";

const PORT = Number(process.env.PORT ?? 3100);

const docGit = new DocGit(DOC_ROOT);
const docStore = new DocStore(DOC_ROOT, repoDirOf, docGit);

// ─── Knowledge elicitor sessions ─────────────────────────────

interface KnowledgeSession {
  agent: IKnowledge;
  project: string;
}

const knowledgeSessions = new Map<string, KnowledgeSession>();

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
    ? "Fold the user's message into the draft (consult the repo as needed via Read/Grep/Glob), then produce the updated full draft and decide whether one more focused question is valuable or the user can save and start generation now."
    : "把用户这条消息吸纳进草稿（按需用 Read/Grep/Glob 看仓库），然后输出更新后的完整草稿，并判断是否还值得追问一个聚焦问题，还是可以建议用户保存并开始生成。";
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
  assertProjectName(project);
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

async function handleKnowledgeStart(body: KnowledgeStartBody): Promise<KnowledgeTurn & { sessionId: string }> {
  assertProjectName(body.project);
  if (!body.userMessage || typeof body.userMessage !== "string" || !body.userMessage.trim()) {
    throw new Error("Missing userMessage");
  }
  const language: Language = body.language ?? "zh";
  const backend: AgentBackend = body.agentBackend ?? "codex";
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

  return { sessionId, ...result };
}

class KnowledgeSessionExpiredError extends Error {
  code = "SESSION_EXPIRED" as const;
  constructor() { super("Knowledge session expired. Start a new one."); }
}

async function handleKnowledgeMessage(body: KnowledgeMessageBody): Promise<KnowledgeTurn> {
  const session = knowledgeSessions.get(body.sessionId);
  if (!session) throw new KnowledgeSessionExpiredError();
  if (!body.userReply || typeof body.userReply !== "string") throw new Error("Missing userReply");

  const { result } = await session.agent.continue(body.userReply);
  await writeDraft(session.project, result.draft);
  return result;
}

async function handleKnowledgeFinalize(body: KnowledgeFinalizeBody): Promise<{ ok: true; path: string }> {
  assertProjectName(body.project);
  const draftPath = knowledgeDraftPathOf(body.project);
  const finalPath = knowledgePathOf(body.project);
  await stat(draftPath).catch(() => { throw new Error("No draft to finalize"); });
  await mkdir(KNOWLEDGE_ROOT, { recursive: true });
  await rename(draftPath, finalPath);
  knowledgeSessions.delete(body.sessionId);
  return { ok: true, path: finalPath };
}

async function handleKnowledgeDiscard(project: string): Promise<{ ok: true }> {
  assertProjectName(project);
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

async function handleRun(body: RunBody): Promise<{ ok: boolean; project: string }> {
  if (state.phase === "cloning" || state.phase === "awaiting-knowledge" || state.phase === "running") {
    throw new Error("Already running");
  }
  if (!body.gitUrl || typeof body.gitUrl !== "string") {
    throw new Error("Missing gitUrl");
  }

  const gitUrl = body.gitUrl.trim();
  const project = git.projectNameFromUrl(gitUrl);
  assertProjectName(project);
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
    decompositionReview: config.decompositionReview ?? "off",
    checkerEnabled: config.checkerEnabled ?? true,
    insightEnabled: config.insightEnabled ?? false,
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

function pauseRun(): { ok: true } {
  if (state.phase !== "running" || !state.arranger) throw new Error("Not running");
  state.arranger.pause();
  broadcastStatus();
  return { ok: true };
}

function resumeRun(): { ok: true } {
  if (state.phase !== "running" || !state.arranger) throw new Error("Not running");
  state.arranger.resume();
  broadcastStatus();
  return { ok: true };
}

function retryErrors(): { ok: true } {
  if ((state.phase !== "done" && state.phase !== "error") || !state.arranger) {
    throw new Error("No completed run with arranger to retry");
  }
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
  return { ok: true };
}

// ─── Status ──────────────────────────────────────────────────

interface RunConfig {
  maxConcurrency: number;
  agentBackends: AgentBackends;
  language: Language;
  decompositionReview: "off" | "all";
  checkerEnabled: boolean;
  insightEnabled: boolean;
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

async function streamStatus(res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify(await handleStatus())}\n\n`);
  sseClients.add(res);
  res.on("close", () => { sseClients.delete(res); });
}

function activeArrangerForProject(project: string): Arranger {
  assertProjectName(project);
  if (state.phase !== "running" || state.project !== project || !state.arranger) {
    throw new Error(`No active run for project: ${project}`);
  }
  return state.arranger;
}

async function listDecompositionReviews(project: string): Promise<unknown[]> {
  assertProjectName(project);
  if (state.phase === "running" && state.project === project && state.arranger) {
    return state.arranger.listDecompositionReviews();
  }
  return new GraphStore(getProjectDocDir(project)).listDecompositionReviews();
}

async function updateDecompositionReview(project: string, id: string, nodes: GraphNode[]): Promise<void> {
  await activeArrangerForProject(project).updateDecompositionReview(id, nodes);
}

async function approveDecompositionReview(project: string, id: string): Promise<void> {
  await activeArrangerForProject(project).approveDecompositionReview(id);
}

async function rejectDecompositionReview(project: string, id: string, feedback: string): Promise<void> {
  await activeArrangerForProject(project).rejectDecompositionReview(id, feedback);
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
    const sourceUrl = meta.sourceUrl || await git.getOriginUrl(path.join(REPO_ROOT, name)).catch(() => "");
    out.push({ name, hasDoc, ...meta, sourceUrl });
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
      sourceUrl: await git.getOriginUrl(path.join(REPO_ROOT, d.name)).catch(() => ""),
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
  assertProjectName(project);
  const base = path.resolve(DOC_ROOT);
  const full = path.resolve(base, project);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error("Invalid project");
  }
  return full;
}

function getCurrentDocDir(): string | undefined {
  return state.phase === "done" || state.phase === "running" ? state.docDir : undefined;
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

const routeHandlers: RouteHandler[] = [
  createMcpRoutes(handleMcp),
  createRunRoutes({ handleRun, handleRunContinue, pauseRun, resumeRun, retryErrors }),
  createStatusRoutes({ listProjects, handleStatus, streamStatus }),
  createChatRoutes(),
  createKnowledgeRoutes({
    handleKnowledgeGet,
    handleKnowledgeStart,
    handleKnowledgeMessage,
    handleKnowledgeFinalize,
    handleKnowledgeDiscard,
  }),
  createSearchRoutes({ searchModules }),
  createInsightRoutes(),
  createUpdateRoutes(),
  createDecompositionReviewRoutes({
    listReviews: listDecompositionReviews,
    updateReview: updateDecompositionReview,
    approveReview: approveDecompositionReview,
    rejectReview: rejectDecompositionReview,
  }),
  createDocGitRoutes(docGit, docStore),
  createDocRoutes({ docStore, getProjectDocDir, getCurrentDocDir, handleDocFile }),
  createBenchRoutes(),
  createSubgraphPauseRoutes({
    pauseSubgraph: async (_project, nodeId) => {
      if (state.phase !== "running" || !state.arranger) throw new Error("Not running");
      await state.arranger.pauseSubgraph(nodeId);
      broadcastStatus();
    },
    resumeSubgraph: async (_project, nodeId) => {
      if (state.phase !== "running" || !state.arranger) throw new Error("Not running");
      await state.arranger.resumeSubgraph(nodeId);
      broadcastStatus();
    },
  }),
];

async function dispatchRequest(ctx: HttpContext): Promise<void> {
  for (const handler of routeHandlers) {
    if (await handler(ctx)) return;
  }
  ctx.res.writeHead(404).end("Not found");
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  try {
    await dispatchRequest({ req, res, url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = e instanceof KnowledgeSessionExpiredError ? e.code : undefined;
    sendJson(res, { error: msg, ...(code ? { code } : {}) }, 400);
  }
}

const server = createServer((req, res) => {
  void handleRequest(req, res);
});

server.listen(PORT, () => {
  console.log(`[Server] HTTP + MCP on http://localhost:${PORT}`);
  console.log(`[Server] DOC_ROOT=${DOC_ROOT}`);
  console.log(`[Server] REPO_ROOT=${REPO_ROOT}`);
});
