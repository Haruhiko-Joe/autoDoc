import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseBody, sendJson, type HttpContext, type RouteHandler } from "./types.js";

const BENCH_DIR = path.resolve("bench/data");
const GENERATE_SCRIPT = path.resolve("bench/scripts/generate-qa.ts");
const VALIDATE_SCRIPT = path.resolve("bench/scripts/validate-answers.ts");
const ABLATION_SCRIPT = path.resolve("bench/scripts/generate-ablation-docs.ts");

interface TaskState {
  status: "running" | "done" | "error";
  log: string[];
  project: string;
  runId: string;
  docVariant?: string;
  error?: string;
}

const generateTasks = new Map<string, TaskState>();
const validateTasks = new Map<string, TaskState>();
const ablationTasks = new Map<string, TaskState>();

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

    const runDetailMatch = p.match(/^\/api\/bench\/runs\/([^/]+)\/([^/]+)$/);
    if (runDetailMatch && req.method === "GET") {
      const [, project, runId] = runDetailMatch;
      const data = await readRun(decodePart(project!), decodePart(runId!));
      if (!data) { sendJson(res, { error: "Not found" }, 404); return true; }
      sendJson(res, data);
      return true;
    }

    const legacyRunMatch = p.match(/^\/api\/bench\/runs\/([^/]+)$/);
    if (legacyRunMatch && req.method === "GET") {
      const [, project] = legacyRunMatch;
      const data = await readRun(decodePart(project!));
      if (!data) { sendJson(res, { error: "Not found" }, 404); return true; }
      sendJson(res, data);
      return true;
    }

    const validationMatch = p.match(/^\/api\/bench\/validation\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
    if (validationMatch && req.method === "GET") {
      const [, project, runId, variant] = validationMatch;
      const queryVariant = url.searchParams.get("variant") ?? undefined;
      const data = await readValidation(decodePart(project!), decodePart(runId!), variant ? decodePart(variant) : queryVariant);
      if (!data) { sendJson(res, { error: "Not found" }, 404); return true; }
      sendJson(res, data);
      return true;
    }

    if (p === "/api/bench/generate" && req.method === "POST") {
      const body = await parseBody(req);
      const result = startGenerate(body);
      sendJson(res, result);
      return true;
    }

    if (p === "/api/bench/generate/status" && req.method === "GET") {
      sendJson(res, { tasks: serializeTasks(generateTasks) });
      return true;
    }

    if (p === "/api/bench/validate" && req.method === "POST") {
      const body = await parseBody(req);
      const result = await startValidate(body);
      sendJson(res, result);
      return true;
    }

    if (p === "/api/bench/validate/status" && req.method === "GET") {
      sendJson(res, { tasks: serializeTasks(validateTasks) });
      return true;
    }

    if (p === "/api/bench/ablation" && req.method === "POST") {
      const body = await parseBody(req);
      const result = startAblation(body);
      sendJson(res, result);
      return true;
    }

    if (p === "/api/bench/ablation/status" && req.method === "GET") {
      sendJson(res, { tasks: serializeTasks(ablationTasks) });
      return true;
    }

    return false;
  };
}

interface ValidationSummary {
  docVariant: string;
  itemCount: number;
  completedCount: number;
  averageScore: number | null;
  updatedAt: string;
  answerProvider: string;
  judgeProvider: string;
}

interface RunSummary {
  project: string;
  runId: string;
  itemCount: number;
  createdAt: string;
  providers: string[];
  validation?: ValidationSummary;
  validations?: Record<string, ValidationSummary>;
}

interface QaRunRef {
  project: string;
  runId: string;
  file: string;
  createdAt: string;
}

function decodePart(value: string): string {
  return decodeURIComponent(value);
}

function taskKey(project: string, runId: string): string {
  return `${project}/${runId}`;
}

function validationTaskKey(project: string, runId: string, docVariant: string): string {
  return `${project}/${runId}/${docVariant}`;
}

function newRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
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
    for (const ref of await listProjectRunRefs(proj)) {
      const raw = await readJson(ref.file).catch(() => null);
      if (!isRecord(raw)) continue;
      const validations = await readValidationSummariesFromDir(path.dirname(ref.file));
      runs.push({
        project: proj,
        runId: ref.runId,
        itemCount: Array.isArray(raw.items) ? raw.items.length : 0,
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : ref.createdAt,
        providers: Array.isArray(raw.providers) ? raw.providers.filter((p): p is string => typeof p === "string") : [],
        validation: preferredValidationSummary(validations),
        validations,
      });
    }
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function readRun(project: string, runId?: string): Promise<unknown | null> {
  const ref = await resolveRunRef(project, runId);
  if (!ref) return null;
  const data = await readJson(ref.file);
  if (isRecord(data)) {
    data.runId = typeof data.runId === "string" ? data.runId : ref.runId;
    const validations = await readValidationSummariesFromDir(path.dirname(ref.file));
    data.validations = validations;
    data.validation = await readValidationFromDir(path.dirname(ref.file));
  }
  return data;
}

async function readValidation(project: string, runId: string, docVariant?: string): Promise<unknown | null> {
  const ref = await resolveRunRef(project, runId);
  if (!ref) return null;
  return readValidationFromDir(path.dirname(ref.file), docVariant);
}

async function readValidationFromDir(runDir: string, docVariant?: string): Promise<unknown | null> {
  if (docVariant && !isSafeVariant(docVariant)) return null;
  const file = docVariant
    ? validationFilePathInDir(runDir, docVariant)
    : await preferredValidationFile(runDir);
  if (!file) return null;
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return null;
  const raw = await readJson(file);
  if (isRecord(raw) && typeof raw.docVariant !== "string") {
    raw.docVariant = variantFromValidationFile(file);
  }
  return raw;
}

async function readValidationSummariesFromDir(runDir: string): Promise<Record<string, ValidationSummary>> {
  const info = await stat(runDir).catch(() => null);
  if (!info?.isDirectory()) return {};

  const entries = (await readdir(runDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const summaries: Record<string, ValidationSummary> = {};
  for (const name of entries) {
    const match = name.match(/^validation\.([A-Za-z0-9_-]+)\.json$/);
    if (!match) continue;
    const raw = await readJson(path.join(runDir, name)).catch(() => null);
    if (!isRecord(raw)) continue;
    const summary = validationSummaryFromRaw(raw, match[1]!);
    summaries[summary.docVariant] = summary;
  }
  return summaries;
}

function validationSummaryFromRaw(raw: Record<string, unknown>, fileSuffix: string): ValidationSummary {
  const fallbackVariant = fileSuffix === "generated" ? "source" : fileSuffix;
  return {
    docVariant: stringValue(raw.docVariant, fallbackVariant),
    itemCount: numberValue(raw.itemCount),
    completedCount: numberValue(raw.completedCount),
    averageScore: typeof raw.averageScore === "number" ? raw.averageScore : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    answerProvider: typeof raw.answerProvider === "string" ? raw.answerProvider : "",
    judgeProvider: typeof raw.judgeProvider === "string" ? raw.judgeProvider : "",
  };
}

function preferredValidationSummary(summaries: Record<string, ValidationSummary>): ValidationSummary | undefined {
  return summaries.full ?? summaries.source ?? Object.values(summaries)[0];
}

async function listProjectRunRefs(project: string): Promise<QaRunRef[]> {
  const projectDir = path.join(BENCH_DIR, project);
  const info = await stat(projectDir).catch(() => null);
  if (!info?.isDirectory()) return [];

  const refs: QaRunRef[] = [];
  const directFile = path.join(projectDir, "qa.generated.json");
  const directInfo = await stat(directFile).catch(() => null);
  if (directInfo?.isFile()) {
    const raw = await readJson(directFile).catch(() => null);
    refs.push({
      project,
      runId: isRecord(raw) && typeof raw.runId === "string" ? raw.runId : "latest",
      file: directFile,
      createdAt: isRecord(raw) && typeof raw.createdAt === "string" ? raw.createdAt : "",
    });
  }

  const entries = await readdir(projectDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(projectDir, entry.name, "qa.generated.json");
    const fileInfo = await stat(file).catch(() => null);
    if (!fileInfo?.isFile()) continue;
    const raw = await readJson(file).catch(() => null);
    refs.push({
      project,
      runId: isRecord(raw) && typeof raw.runId === "string" ? raw.runId : entry.name,
      file,
      createdAt: isRecord(raw) && typeof raw.createdAt === "string" ? raw.createdAt : "",
    });
  }

  return refs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function resolveRunRef(project: string, runId?: string): Promise<QaRunRef | null> {
  const refs = await listProjectRunRefs(project);
  if (refs.length === 0) return null;
  if (!runId || runId === "latest") return refs[0]!;
  return refs.find((ref) => ref.runId === runId) ?? null;
}

async function preferredValidationFile(runDir: string): Promise<string | undefined> {
  const full = validationFilePathInDir(runDir, "full");
  if ((await stat(full).catch(() => null))?.isFile()) return full;

  const source = validationFilePathInDir(runDir, "source");
  if ((await stat(source).catch(() => null))?.isFile()) return source;

  const entries = (await readdir(runDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && /^validation\.[A-Za-z0-9_-]+\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  return entries[0] ? path.join(runDir, entries[0]) : undefined;
}

function validationFilePathInDir(runDir: string, docVariant: string): string {
  const suffix = docVariant === "source" ? "generated" : docVariant;
  if (!isSafeVariant(suffix)) throw new Error(`Invalid documentation variant: ${docVariant}`);
  return path.join(runDir, `validation.${suffix}.json`);
}

function variantFromValidationFile(file: string): string {
  const match = path.basename(file).match(/^validation\.([A-Za-z0-9_-]+)\.json$/);
  if (!match) return "source";
  return match[1] === "generated" ? "source" : match[1]!;
}

function startGenerate(body: Record<string, unknown>): { ok: boolean; project: string; runId: string; error?: string } {
  const project = stringValue(body.project, "git");
  const runId = stringValue(body.runId, newRunId());
  const key = taskKey(project, runId);
  const existing = generateTasks.get(key);
  if (existing?.status === "running") {
    return { ok: false, project, runId, error: `Generation already running for ${key}` };
  }

  const repo = path.resolve("src/souko/repo", project);
  const args: string[] = ["--project", project, "--run-id", runId, "--repo", repo];
  if (body.language) args.push("--language", String(body.language));
  if (body.count) args.push("--count", String(body.count));
  if (body.batchSize) args.push("--batch-size", String(body.batchSize));
  if (body.providers) args.push("--providers", String(body.providers));
  if (body.claudeModel) args.push("--claude-model", String(body.claudeModel));
  if (body.codexModel) args.push("--codex-model", String(body.codexModel));

  const state: TaskState = { status: "running", log: [], project, runId };
  generateTasks.set(key, state);
  spawnTask(state, GENERATE_SCRIPT, args);
  return { ok: true, project, runId };
}

function startAblation(body: Record<string, unknown>): { ok: boolean; project: string; runId: string; error?: string } {
  const project = stringValue(body.project, "git");
  const key = project;
  const existing = ablationTasks.get(key);
  if (existing?.status === "running") {
    return { ok: false, project, runId: "ablation", error: `Ablation docs generation already running for ${project}` };
  }

  const args: string[] = ["--project", project];
  if (body.variants) args.push("--variants", String(body.variants));
  if (body.docRoot) args.push("--doc-root", String(body.docRoot));
  if (body.outRoot) args.push("--out-root", String(body.outRoot));
  if (body.overwrite !== false) args.push("--overwrite");

  const state: TaskState = { status: "running", log: [], project, runId: "ablation" };
  ablationTasks.set(key, state);
  spawnTask(state, ABLATION_SCRIPT, args);
  return { ok: true, project, runId: "ablation" };
}

async function startValidate(body: Record<string, unknown>): Promise<{ ok: boolean; project: string; runId: string; error?: string }> {
  const project = stringValue(body.project, "git");
  const requestedRunId = optionalString(body.runId);
  const ref = await resolveRunRef(project, requestedRunId);
  if (!ref) return { ok: false, project, runId: requestedRunId ?? "", error: `QA run not found for ${project}` };

  const docVariant = docVariantValue(body.docVariant, "full");
  if (!docVariant) return { ok: false, project, runId: ref.runId, error: "Invalid documentation variant" };
  const key = validationTaskKey(project, ref.runId, docVariant);
  const existing = validateTasks.get(key);
  if (existing?.status === "running") {
    return { ok: false, project, runId: ref.runId, error: `Validation already running for ${key}` };
  }

  const docRoot = resolveDocRoot(body, docVariant);
  const args: string[] = [
    "--project", project,
    "--run-id", ref.runId,
    "--data-dir", BENCH_DIR,
    "--doc-variant", docVariant,
    "--doc-root", docRoot,
    "--doc-project", stringValue(body.docProject, project),
  ];
  if (body.limit) args.push("--limit", String(body.limit));
  if (body.itemIds) args.push("--item-ids", String(body.itemIds));
  if (body.answerProvider) args.push("--answer-provider", String(body.answerProvider));
  if (body.judgeProvider) args.push("--judge-provider", String(body.judgeProvider));
  if (body.language) args.push("--language", String(body.language));

  const state: TaskState = { status: "running", log: [], project, runId: ref.runId, docVariant };
  validateTasks.set(key, state);
  spawnTask(state, VALIDATE_SCRIPT, args);
  return { ok: true, project, runId: ref.runId };
}

function spawnTask(state: TaskState, script: string, args: string[]): void {
  const child = spawn("pnpm", ["exec", "tsx", script, ...args], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk: Buffer) => appendLog(state, chunk));
  child.stderr.on("data", (chunk: Buffer) => appendLog(state, chunk));

  child.on("close", (code) => {
    state.status = code === 0 ? "done" : "error";
    if (code !== 0) state.error = `Process exited with code ${code}`;
  });

  child.on("error", (err) => {
    state.status = "error";
    state.error = err.message;
  });
}

function appendLog(state: TaskState, chunk: Buffer): void {
  const lines = chunk.toString().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  state.log.push(...lines);
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

function serializeTasks(tasks: Map<string, TaskState>): Record<string, TaskState> {
  const result: Record<string, TaskState> = {};
  for (const [key, state] of tasks) result[key] = { ...state, log: [...state.log] };
  return result;
}

function resolveDocRoot(body: Record<string, unknown>, docVariant?: string): string {
  const explicit = optionalString(body.docRoot);
  if (explicit) return path.resolve(explicit);
  const variant = docVariant ?? docVariantValue(body.docVariant, "full") ?? "full";
  return path.resolve("bench/data/ablation-docs", variant);
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf-8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function docVariantValue(value: unknown, fallback: string): string | undefined {
  const variant = stringValue(value, fallback);
  return isSafeVariant(variant) ? variant : undefined;
}

function isSafeVariant(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
