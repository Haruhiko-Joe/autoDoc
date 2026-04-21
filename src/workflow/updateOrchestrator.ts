import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  fetchLatest, isGhAvailable, listMergedPrsSince, listCommitsSince,
  diffNameOnly, diffPatch,
  type PrInfo, type CommitInfo,
} from "../git/prDiscovery.js";
import { withProjectLock } from "./locks.js";
import { getProject, upsertProject, repoDirOf, docDirOf } from "../souko/registry.js";
import { appendUpdateLog, type UpdateLogEntry } from "../souko/updateLog.js";
import { appendRunLog } from "../souko/runLog.js";
import { claudePrUpdater } from "../agents/tsukai/claudeprupdater.js";
import { codexPrUpdater } from "../agents/tsukai/codexprupdater.js";
import type { IPrUpdater, Language } from "../agents/schemas/schema.js";

// ─── Types ───

export type TaskStatus = "idle" | "running" | "awaiting-review" | "done" | "skipped" | "error";
export type UpdateMode = "auto" | "manual";

export interface TaskItem {
  id: string;
  sha: string;
  title: string;
  body?: string;
  filesChanged: number;
  changedFiles: string[];
  status: TaskStatus;
  markdown?: string;
  error?: string;
  userInstructions?: string;
  confirmed?: boolean;
  sessionId?: string;
}

export interface UpdateState {
  project: string;
  mode: UpdateMode;
  backend: "claude" | "codex";
  language: Language;
  tasks: TaskItem[];
  currentIndex: number;
  running: boolean;
  awaitingConfirm: boolean;
  awaitingReview: boolean;
}

type UpdateEventListener = (event: UpdateEvent) => void;

export type UpdateEvent =
  | { type: "queue"; tasks: TaskItem[] }
  | { type: "task-start"; taskId: string }
  | { type: "task-text-delta"; taskId: string; delta: string }
  | { type: "task-awaiting-review"; taskId: string; markdown: string }
  | { type: "task-done"; taskId: string; markdown: string }
  | { type: "task-error"; taskId: string; error: string; status?: TaskStatus }
  | { type: "task-skipped"; taskId: string }
  | { type: "awaiting-confirm"; taskId: string }
  | { type: "finished" };

// ─── Singleton state per project ───

const states = new Map<string, UpdateState>();
const listeners = new Map<string, Set<UpdateEventListener>>();

function emit(project: string, event: UpdateEvent) {
  const set = listeners.get(project);
  if (set) for (const fn of set) fn(event);
}

export function subscribe(project: string, fn: UpdateEventListener): () => void {
  let set = listeners.get(project);
  if (!set) { set = new Set(); listeners.set(project, set); }
  set.add(fn);
  return () => { set!.delete(fn); if (set!.size === 0) listeners.delete(project); };
}

export function getUpdateState(project: string): UpdateState | undefined {
  return states.get(project);
}

// ─── Snapshot ───

const SNAPSHOT_DIR = ".snapshots";
const MAX_SNAPSHOTS = 20;

async function snapshotDocDir(project: string, sha: string): Promise<void> {
  const docDir = docDirOf(project);
  const snapshotBase = path.join(docDir, SNAPSHOT_DIR);
  await mkdir(snapshotBase, { recursive: true });
  const dest = path.join(snapshotBase, sha.slice(0, 12));
  await cp(docDir, dest, {
    recursive: true,
    filter: (src) => !src.includes(SNAPSHOT_DIR),
  }).catch(() => {});
}

// ─── Core ───

export interface StartUpdateOptions {
  mode?: UpdateMode;
  backend?: "claude" | "codex";
  language?: Language;
}

export async function startUpdate(project: string, options: StartUpdateOptions = {}): Promise<UpdateState> {
  const mode: UpdateMode = options.mode ?? "auto";
  const backend: "claude" | "codex" = options.backend ?? "claude";
  const language: Language = options.language ?? "zh";
  if (states.has(project) && states.get(project)!.running) {
    throw new Error("Update already running for this project");
  }

  return withProjectLock(project, async () => {
    const meta = await getProject(project);
    if (!meta) throw new Error(`Project not found: ${project}`);

    const repoDir = repoDirOf(project);
    await fetchLatest(repoDir);

    const cursor = meta.lastProcessedSha ?? meta.head;

    const useGh = await isGhAvailable(repoDir);
    let items: (PrInfo | CommitInfo)[];
    if (useGh) {
      items = await listMergedPrsSince(repoDir, cursor, meta.branch || "main");
    } else {
      items = await listCommitsSince(repoDir, cursor);
    }

    if (items.length === 0) {
      throw new Error("No new commits/PRs to process");
    }

    const tasks: TaskItem[] = await Promise.all(items.map(async (item) => {
      const files = await diffNameOnly(repoDir, item.sha).catch(() => []);
      return {
        id: item.id,
        sha: item.sha,
        title: item.title,
        body: "body" in item ? item.body : undefined,
        filesChanged: files.length,
        changedFiles: files,
        status: "idle" as TaskStatus,
      };
    }));

    const state: UpdateState = {
      project,
      mode,
      backend,
      language,
      tasks,
      currentIndex: 0,
      running: true,
      awaitingConfirm: false,
      awaitingReview: false,
    };
    states.set(project, state);
    emit(project, { type: "queue", tasks });

    await appendRunLog(project, `update start mode=${mode} backend=${backend} language=${language} tasks=${tasks.length} cursor=${cursor?.slice(0, 12) ?? "none"}`);

    void runQueue(project);
    return state;
  });
}

async function runQueue(project: string): Promise<void> {
  const state = states.get(project);
  if (!state) return;

  while (state.currentIndex < state.tasks.length && state.running) {
    if (state.awaitingConfirm || state.awaitingReview) return;

    const task = state.tasks[state.currentIndex]!;

    if (task.status === "skipped" || task.status === "done") {
      state.currentIndex++;
      continue;
    }

    // Manual mode: gate on confirmation BEFORE running each task (including the first)
    if (state.mode === "manual" && !task.confirmed) {
      state.awaitingConfirm = true;
      emit(project, { type: "awaiting-confirm", taskId: task.id });
      await appendRunLog(project, `update awaiting-confirm task=${task.id}`);
      return;
    }

    task.status = "running";
    emit(project, { type: "task-start", taskId: task.id });
    await appendRunLog(project, `task start id=${task.id} sha=${task.sha.slice(0, 12)} files=${task.filesChanged}${task.userInstructions ? " with-instructions" : ""}`);

    try {
      await snapshotDocDir(project, task.sha);
      const repoDir = repoDirOf(project);
      const diff = await diffPatch(repoDir, task.sha);
      const changedFiles = await diffNameOnly(repoDir, task.sha);

      const agent: IPrUpdater = state.backend === "codex"
        ? new codexPrUpdater(state.language)
        : new claudePrUpdater(state.language);

      const prompt = buildPrUpdaterPrompt(project, task, changedFiles, diff, task.userInstructions);
      await appendRunLog(project, `prUpdater invoke backend=${state.backend} task=${task.id}`);

      task.markdown = "";
      const onDelta = (chunk: string) => {
        task.markdown = (task.markdown ?? "") + chunk;
        emit(project, { type: "task-text-delta", taskId: task.id, delta: chunk });
      };
      const agentResult = await agent.run(prompt, repoDir, onDelta);
      const markdown = agentResult.result;
      task.sessionId = agentResult.sessionId;
      task.markdown = markdown;
      await appendRunLog(project, `prUpdater return task=${task.id} len=${markdown.length} session=${agentResult.sessionId.slice(0, 8)}`);

      if (state.mode === "manual") {
        task.status = "awaiting-review";
        state.awaitingReview = true;
        emit(project, { type: "task-awaiting-review", taskId: task.id, markdown });
        await appendRunLog(project, `task awaiting-review id=${task.id}`);
        return;
      }

      await finalizeTaskAsDone(project, task, markdown);

      // Auto mode: brief pause so SSE clients see each task
      if (state.mode === "auto") {
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      task.status = "error";
      task.error = msg;
      emit(project, { type: "task-error", taskId: task.id, error: msg, status: "error" });
      await appendRunLog(project, `task error id=${task.id} error=${msg.slice(0, 200)}`);

      const meta = await getProject(project);
      if (meta) {
        await upsertProject(project, { ...meta, lastUpdateError: msg });
      }

      state.running = false;
      return;
    }
  }

  state.running = false;
  emit(project, { type: "finished" });
  await appendRunLog(project, `update finished`);
  states.delete(project);
}

// ─── Controls ───

export function continueUpdate(project: string, extraInstructions?: string): void {
  const state = states.get(project);
  if (!state || !state.awaitingConfirm) throw new Error("Not awaiting confirmation");
  const task = state.tasks[state.currentIndex];
  if (task) {
    task.confirmed = true;
    const trimmed = extraInstructions?.trim();
    if (trimmed) task.userInstructions = trimmed;
  }
  state.awaitingConfirm = false;
  void appendRunLog(project, `update continue task=${task?.id ?? "?"}${extraInstructions?.trim() ? ` instructions-len=${extraInstructions.trim().length}` : ""}`);
  void runQueue(project);
}

export function skipTask(project: string, taskId: string): void {
  const state = states.get(project);
  if (!state) throw new Error("No active update");
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task || task.status !== "idle") throw new Error("Cannot skip task");
  task.status = "skipped";
  emit(project, { type: "task-skipped", taskId });
  void appendRunLog(project, `task skip id=${taskId}`);
}

export function cancelUpdate(project: string): void {
  const state = states.get(project);
  if (!state) return;
  state.running = false;
  state.awaitingConfirm = false;
  state.awaitingReview = false;
  states.delete(project);
  void appendRunLog(project, `update cancel`);
}

// ─── Awaiting-review actions (manual mode) ───

async function finalizeTaskAsDone(project: string, task: TaskItem, markdown: string): Promise<void> {
  task.status = "done";
  task.markdown = markdown;
  emit(project, { type: "task-done", taskId: task.id, markdown });

  const entry: UpdateLogEntry = {
    ts: new Date().toISOString(),
    taskId: task.id,
    sha: task.sha,
    title: task.title,
    markdown,
  };
  await appendUpdateLog(project, entry);

  const meta = await getProject(project);
  if (meta) {
    await upsertProject(project, { ...meta, lastProcessedSha: task.sha, lastUpdateError: undefined });
  }

  const state = states.get(project);
  if (state) state.currentIndex++;
  await appendRunLog(project, `task done id=${task.id} len=${markdown.length}`);
}

export async function acceptTask(project: string, taskId: string): Promise<void> {
  const state = states.get(project);
  if (!state) throw new Error("No active update");
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task || task.status !== "awaiting-review") throw new Error("Task is not awaiting review");
  if (!task.markdown) throw new Error("Task has no response to accept");

  state.awaitingReview = false;
  await finalizeTaskAsDone(project, task, task.markdown);
  await appendRunLog(project, `task accept id=${task.id}`);
  void runQueue(project);
}

export async function chatOnTask(project: string, taskId: string, prompt: string): Promise<void> {
  const state = states.get(project);
  if (!state) throw new Error("No active update");
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task || task.status !== "awaiting-review") throw new Error("Task is not awaiting review");
  if (!task.sessionId) throw new Error("Task has no session to continue");

  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("Empty follow-up prompt");

  task.status = "running";
  state.awaitingReview = false;
  const separator = `\n\n---\n\n**${state.language === "en" ? "You" : "你"}:** ${trimmed}\n\n`;
  task.markdown = (task.markdown ?? "") + separator;
  emit(project, { type: "task-start", taskId: task.id });
  emit(project, { type: "task-text-delta", taskId: task.id, delta: separator });
  await appendRunLog(project, `task chat id=${task.id} prompt-len=${trimmed.length}`);

  const repoDir = repoDirOf(project);
  const agent: IPrUpdater = state.backend === "codex"
    ? new codexPrUpdater(state.language)
    : new claudePrUpdater(state.language);
  agent.restore(task.sessionId, repoDir);

  try {
    const onDelta = (chunk: string) => {
      task.markdown = (task.markdown ?? "") + chunk;
      emit(project, { type: "task-text-delta", taskId: task.id, delta: chunk });
    };
    const result = await agent.continue(trimmed, onDelta);
    task.sessionId = result.sessionId;
    task.markdown = (task.markdown ?? "");
    task.status = "awaiting-review";
    state.awaitingReview = true;
    emit(project, { type: "task-awaiting-review", taskId: task.id, markdown: task.markdown });
    await appendRunLog(project, `task chat return id=${task.id} len=${result.result.length}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    task.status = "awaiting-review"; // keep the review gate so user can retry
    task.error = msg;
    state.awaitingReview = true;
    emit(project, { type: "task-error", taskId: task.id, error: msg, status: "awaiting-review" });
    await appendRunLog(project, `task chat error id=${task.id} error=${msg.slice(0, 200)}`);
    throw e;
  }
}

// ─── Prompt construction ───

function buildPrUpdaterPrompt(
  project: string,
  task: TaskItem,
  changedFiles: string[],
  diff: string,
  extraInstructions?: string,
): string {
  const header = task.body
    ? `PR #${task.id}: ${task.title}\n\n${task.body}\n`
    : `Commit ${task.sha.slice(0, 12)}: ${task.title}\n`;
  const files = changedFiles.length > 0
    ? `Changed files (${changedFiles.length}):\n${changedFiles.map((f) => `- ${f}`).join("\n")}\n`
    : "";
  const guidance = extraInstructions?.trim()
    ? `\n## Additional user guidance for this PR\n\nThe user has provided extra instructions to steer your documentation update. Treat these with high priority — they may narrow scope, highlight what to emphasize, or specify formatting preferences.\n\n${extraInstructions.trim()}\n`
    : "";
  return `# Incremental documentation update

Project: ${project}
${header}
${files}
## Diff (may be truncated)

\`\`\`diff
${diff}
\`\`\`
${guidance}
Apply the two-stage workflow:
1. First assess the impact (none / minor / structural) with a one-sentence reasoning.
2. If impact != "none", use MCP tools to navigate and apply the smallest possible edits.

Your final reply MUST be Markdown (not JSON) — it is streamed live to the user in a documentation UI.
`;
}
