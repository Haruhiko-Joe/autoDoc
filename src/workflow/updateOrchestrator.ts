import { randomUUID } from "node:crypto";
import {
  fetchLatest, isGhAvailable, listMergedPrsSince, listCommitsSince,
  diffNameOnly, diffPatch, checkoutRemoteBranch, checkoutCommit,
  type PrInfo, type CommitInfo,
} from "../git/prDiscovery.js";
import { withDocProjectLock } from "../mcp/docLock.js";
import { assertProjectName, getProject, upsertProject, repoDirOf } from "../souko/registry.js";
import { appendUpdateLog } from "../souko/updateLog.js";
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
  runId: string;
  project: string;
  branch: string;
  mode: UpdateMode;
  backend: "claude" | "codex";
  language: Language;
  tasks: TaskItem[];
  currentIndex: number;
  running: boolean;
  awaitingConfirm: boolean;
  awaitingReview: boolean;
  cancelled?: boolean;
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
  | { type: "cancelled" }
  | { type: "finished" };

// ─── Event bus ───

const listeners = new Map<string, Set<UpdateEventListener>>();

function emit(project: string, event: UpdateEvent) {
  const set = listeners.get(project);
  if (set) for (const fn of set) fn(event);
}

export function subscribe(project: string, fn: UpdateEventListener): () => void {
  assertProjectName(project);
  let set = listeners.get(project);
  if (!set) { set = new Set(); listeners.set(project, set); }
  set.add(fn);
  return () => { set.delete(fn); if (set.size === 0) listeners.delete(project); };
}

// ─── Update run ───

const AUTO_TASK_INTERVAL_MS = 500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Thrown at await boundaries once the run is cancelled or superseded; swallowed by entry points. */
class RunCancelled extends Error {}

const runs = new Map<string, UpdateRun>();

class UpdateRun {
  constructor(readonly state: UpdateState) {}

  private get project(): string {
    return this.state.project;
  }

  private get active(): boolean {
    return runs.get(this.project) === this && this.state.running && this.state.cancelled !== true;
  }

  private ensureActive(): void {
    if (!this.active) throw new RunCancelled();
  }

  private emit(event: UpdateEvent): void {
    emit(this.project, event);
  }

  private log(line: string): Promise<void> {
    return appendRunLog(this.project, line);
  }

  async processQueue(): Promise<void> {
    try {
      while (this.state.currentIndex < this.state.tasks.length && this.active) {
        if (this.state.awaitingConfirm || this.state.awaitingReview) return;

        const task = this.state.tasks[this.state.currentIndex];
        if (!task) break;

        if (task.status === "skipped" || task.status === "done") {
          this.state.currentIndex++;
          continue;
        }

        if (this.state.mode === "manual" && !task.confirmed) {
          this.state.awaitingConfirm = true;
          this.emit({ type: "awaiting-confirm", taskId: task.id });
          await this.log(`update awaiting-confirm task=${task.id}`);
          return;
        }

        const outcome = await this.runTask(task);
        if (outcome !== "done") return;

        if (this.state.mode === "auto") await sleep(AUTO_TASK_INTERVAL_MS);
      }

      this.ensureActive();
      this.state.running = false;
      this.emit({ type: "finished" });
      await this.log(`update finished`);
      if (runs.get(this.project) === this) runs.delete(this.project);
    } catch (e) {
      if (!(e instanceof RunCancelled)) throw e;
    } finally {
      await checkoutRemoteBranch(repoDirOf(this.project), this.state.branch).catch(() => {});
    }
  }

  continue(extraInstructions?: string): void {
    if (!this.state.awaitingConfirm) throw new Error("Not awaiting confirmation");
    const task = this.state.tasks[this.state.currentIndex];
    const trimmed = extraInstructions?.trim();
    if (task) {
      task.confirmed = true;
      if (trimmed) task.userInstructions = trimmed;
    }
    this.state.awaitingConfirm = false;
    void this.log(`update continue task=${task?.id ?? "?"}${trimmed ? ` instructions-len=${trimmed.length}` : ""}`);
    void this.processQueue();
  }

  skip(taskId: string): void {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task || task.status !== "idle") throw new Error("Cannot skip task");
    task.status = "skipped";
    this.emit({ type: "task-skipped", taskId });
    void this.log(`task skip id=${taskId}`);
  }

  async cancel(): Promise<void> {
    this.state.cancelled = true;
    this.state.running = false;
    this.state.awaitingConfirm = false;
    this.state.awaitingReview = false;
    this.emit({ type: "cancelled" });
    if (runs.get(this.project) === this) runs.delete(this.project);
    void this.log(`update cancel`);
    await checkoutRemoteBranch(repoDirOf(this.project), this.state.branch).catch(() => {});
  }

  async accept(taskId: string): Promise<void> {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task || task.status !== "awaiting-review") throw new Error("Task is not awaiting review");
    if (!task.markdown) throw new Error("Task has no response to accept");

    this.state.awaitingReview = false;
    try {
      await this.finalize(task, task.markdown);
    } catch (e) {
      if (e instanceof RunCancelled) return;
      throw e;
    }
    await this.log(`task accept id=${task.id}`);
    void this.processQueue();
  }

  async chat(taskId: string, prompt: string): Promise<void> {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task || task.status !== "awaiting-review") throw new Error("Task is not awaiting review");
    if (!task.sessionId) throw new Error("Task has no session to continue");
    const trimmed = prompt.trim();
    if (!trimmed) throw new Error("Empty follow-up prompt");

    task.status = "running";
    this.state.awaitingReview = false;
    const separator = `\n\n---\n\n**${this.state.language === "en" ? "You" : "你"}:** ${trimmed}\n\n`;
    task.markdown = (task.markdown ?? "") + separator;
    this.emit({ type: "task-start", taskId: task.id });
    this.emit({ type: "task-text-delta", taskId: task.id, delta: separator });
    await this.log(`task chat id=${task.id} prompt-len=${trimmed.length}`);

    const repoDir = repoDirOf(this.project);
    await checkoutCommit(repoDir, task.sha);
    try {
      this.ensureActive();
      const agent = this.makeAgent();
      agent.restore(task.sessionId, repoDir);
      const result = await agent.continue(trimmed, this.streamInto(task));
      this.ensureActive();
      task.sessionId = result.sessionId;
      task.status = "awaiting-review";
      this.state.awaitingReview = true;
      this.emit({ type: "task-awaiting-review", taskId: task.id, markdown: task.markdown ?? "" });
      await this.log(`task chat return id=${task.id} len=${result.result.length}`);
    } catch (e) {
      if (e instanceof RunCancelled || !this.active) return;
      const msg = e instanceof Error ? e.message : String(e);
      task.status = "awaiting-review";
      task.error = msg;
      this.state.awaitingReview = true;
      this.emit({ type: "task-error", taskId: task.id, error: msg, status: "awaiting-review" });
      await this.log(`task chat error id=${task.id} error=${msg.slice(0, 200)}`);
      throw e;
    } finally {
      await checkoutRemoteBranch(repoDir, this.state.branch).catch(() => {});
    }
  }

  private async runTask(task: TaskItem): Promise<"done" | "awaiting-review" | "error"> {
    task.status = "running";
    this.emit({ type: "task-start", taskId: task.id });
    await this.log(`task start id=${task.id} sha=${task.sha.slice(0, 12)} files=${task.filesChanged}${task.userInstructions ? " with-instructions" : ""}`);

    try {
      const repoDir = repoDirOf(this.project);
      await checkoutCommit(repoDir, task.sha);
      const diff = await diffPatch(repoDir, task.sha);
      const changedFiles = await diffNameOnly(repoDir, task.sha);
      this.ensureActive();

      const prompt = buildPrUpdaterPrompt(this.project, task, changedFiles, diff, task.userInstructions);
      await this.log(`prUpdater invoke backend=${this.state.backend} task=${task.id}`);

      task.markdown = "";
      const agentResult = await this.makeAgent().run(prompt, repoDir, this.streamInto(task));
      this.ensureActive();
      const markdown = agentResult.result;
      task.sessionId = agentResult.sessionId;
      task.markdown = markdown;
      await this.log(`prUpdater return task=${task.id} len=${markdown.length} session=${agentResult.sessionId.slice(0, 8)}`);

      if (this.state.mode === "manual") {
        task.status = "awaiting-review";
        this.state.awaitingReview = true;
        this.emit({ type: "task-awaiting-review", taskId: task.id, markdown });
        await this.log(`task awaiting-review id=${task.id}`);
        return "awaiting-review";
      }

      await this.finalize(task, markdown);
      return "done";
    } catch (e) {
      if (e instanceof RunCancelled || !this.active) throw new RunCancelled();
      const msg = e instanceof Error ? e.message : String(e);
      task.status = "error";
      task.error = msg;
      this.emit({ type: "task-error", taskId: task.id, error: msg, status: "error" });
      await this.log(`task error id=${task.id} error=${msg.slice(0, 200)}`);

      const meta = await getProject(this.project);
      if (meta) await upsertProject(this.project, { ...meta, lastUpdateError: msg });

      this.state.running = false;
      return "error";
    }
  }

  private async finalize(task: TaskItem, markdown: string): Promise<void> {
    this.ensureActive();
    task.status = "done";
    task.markdown = markdown;
    this.emit({ type: "task-done", taskId: task.id, markdown });

    await appendUpdateLog(this.project, {
      ts: new Date().toISOString(),
      taskId: task.id,
      sha: task.sha,
      title: task.title,
      markdown,
    });

    const meta = await getProject(this.project);
    this.ensureActive();
    if (meta) {
      await upsertProject(this.project, { ...meta, lastProcessedSha: task.sha, lastUpdateError: undefined });
    }

    this.state.currentIndex++;
    await this.log(`task done id=${task.id} len=${markdown.length}`);
  }

  private makeAgent(): IPrUpdater {
    return this.state.backend === "codex"
      ? new codexPrUpdater(this.state.language)
      : new claudePrUpdater(this.state.language);
  }

  private streamInto(task: TaskItem): (chunk: string) => void {
    return (chunk) => {
      if (!this.active) return;
      task.markdown = (task.markdown ?? "") + chunk;
      this.emit({ type: "task-text-delta", taskId: task.id, delta: chunk });
    };
  }
}

// ─── Public API ───

export interface StartUpdateOptions {
  mode?: UpdateMode;
  backend?: "claude" | "codex";
  language?: Language;
}

export function getUpdateState(project: string): UpdateState | undefined {
  assertProjectName(project);
  return runs.get(project)?.state;
}

export async function startUpdate(project: string, options: StartUpdateOptions = {}): Promise<UpdateState> {
  assertProjectName(project);
  const mode: UpdateMode = options.mode ?? "auto";
  const backend: "claude" | "codex" = options.backend ?? "codex";
  const language: Language = options.language ?? "zh";
  if (runs.get(project)?.state.running) {
    throw new Error("Update already running for this project");
  }

  return withDocProjectLock(project, async () => {
    const meta = await getProject(project);
    if (!meta) throw new Error(`Project not found: ${project}`);

    const repoDir = repoDirOf(project);
    const branch = meta.branch || "main";
    await fetchLatest(repoDir);
    await checkoutRemoteBranch(repoDir, branch);

    const cursor = meta.lastProcessedSha ?? meta.head;
    const items: (PrInfo | CommitInfo)[] = (await isGhAvailable(repoDir))
      ? await listMergedPrsSince(repoDir, cursor, branch)
      : await listCommitsSince(repoDir, cursor);
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

    const run = new UpdateRun({
      runId: randomUUID(),
      project,
      branch,
      mode,
      backend,
      language,
      tasks,
      currentIndex: 0,
      running: true,
      awaitingConfirm: false,
      awaitingReview: false,
    });
    runs.set(project, run);
    emit(project, { type: "queue", tasks });

    await appendRunLog(project, `update start mode=${mode} backend=${backend} language=${language} tasks=${tasks.length} cursor=${cursor?.slice(0, 12) ?? "none"}`);

    void run.processQueue();
    return run.state;
  });
}

export function continueUpdate(project: string, extraInstructions?: string): void {
  assertProjectName(project);
  const run = runs.get(project);
  if (!run) throw new Error("Not awaiting confirmation");
  run.continue(extraInstructions);
}

export function skipTask(project: string, taskId: string): void {
  assertProjectName(project);
  const run = runs.get(project);
  if (!run) throw new Error("No active update");
  run.skip(taskId);
}

export async function cancelUpdate(project: string): Promise<void> {
  assertProjectName(project);
  await runs.get(project)?.cancel();
}

export async function acceptTask(project: string, taskId: string): Promise<void> {
  assertProjectName(project);
  const run = runs.get(project);
  if (!run) throw new Error("No active update");
  await run.accept(taskId);
}

export async function chatOnTask(project: string, taskId: string, prompt: string): Promise<void> {
  assertProjectName(project);
  const run = runs.get(project);
  if (!run) throw new Error("No active update");
  await run.chat(taskId, prompt);
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
