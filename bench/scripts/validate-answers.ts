import "dotenv/config";

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  RawJudgeOutput,
  Provider,
  QaFile,
  ValidationFile,
  Variant,
  type JudgeOutput,
  type Language,
  type QaItem,
  type ValidationAnswer,
  type ValidationItem,
  type ValidationJudge,
} from "../lib/schemas.ts";
import { runAnswerJudge, runAnswerVerifier } from "../lib/agents.ts";
import { buildJudgePrompt, buildVerifierPrompt } from "../lib/prompts.ts";
import { cleanWorkdir, setupWorkdir } from "../lib/workdir.ts";
import {
  judgeFor,
  judgesFor,
  normalizeValidationFile,
  normalizeValidationItem,
  syncValidationStats,
  upsertJudge,
} from "../lib/validation.ts";
import { assertBenchWorker } from "../lib/worker.ts";

// ---------------------------------------------------------------------------
// Worker option parsing
// ---------------------------------------------------------------------------

interface Options {
  project: string;
  runId?: string;
  dataDir: string;
  docVariant: "full" | "no-edges" | "flat-md";
  language?: Language;
  limit?: number;
  itemIds?: string[];
  answerProvider: "codex" | "claude";
  judgeProviders: Array<"codex" | "claude">;
  validationRoot: string;
  ablationDocs: string;
  skillTemplate: string;
  force: boolean;
}

function parseArgs(argv: string[]): Options {
  const m = new Map<string, string>();
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i]!;
    if (!tok.startsWith("--")) throw new Error(`Unexpected: ${tok}`);
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) { m.set(key, "true"); i += 1; }
    else { m.set(key, next); i += 2; }
  }

  return {
    project: m.get("project") ?? "git",
    runId: m.get("run-id"),
    dataDir: path.resolve(m.get("data-dir") ?? "bench/data"),
    docVariant: Variant.parse(m.get("doc-variant") ?? "full"),
    language: m.has("language") ? (m.get("language") as Language) : undefined,
    limit: m.has("limit") ? Number.parseInt(m.get("limit")!, 10) : undefined,
    itemIds: m.get("item-ids")?.split(",").map(s => s.trim()).filter(Boolean),
    answerProvider: Provider.parse(m.get("answer-provider") ?? "codex"),
    judgeProviders: parseProviderList(m.get("judge-providers") ?? m.get("judge-provider") ?? "claude"),
    validationRoot: path.resolve(m.get("validation-root") ?? "bench/validation"),
    ablationDocs: path.resolve(m.get("ablation-docs") ?? "bench/data/ablation-docs"),
    skillTemplate: path.resolve(m.get("skill-template") ?? "src/skill-template-readonly"),
    force: m.has("force"),
  };
}

function parseProviderList(value: string): Array<"codex" | "claude"> {
  const providers = value.split(",").map((item) => Provider.parse(item.trim())).filter(Boolean);
  const unique = [...new Set(providers)];
  if (unique.length === 0) throw new Error("At least one judge provider is required");
  return unique;
}

// ---------------------------------------------------------------------------
// QA file loading
// ---------------------------------------------------------------------------

async function loadQaFile(dataDir: string, project: string, runId?: string): Promise<{ file: string; data: QaFile }> {
  const runDirFile = runId && runId !== "latest"
    ? path.join(dataDir, project, runId, "qa.generated.json")
    : undefined;
  const candidates = runId && runId !== "latest"
    ? [runDirFile!, path.join(dataDir, project, "qa.generated.json")]
    : [path.join(dataDir, project, "qa.generated.json")];

  for (const file of candidates) {
    if (!(await stat(file).catch(() => null))?.isFile()) continue;
    const data = QaFile.parse(JSON.parse(await readFile(file, "utf-8")));
    if (!runId || runId === "latest" || file === runDirFile || data.runId === runId) {
      return { file, data };
    }
  }

  throw new Error(`QA file not found for ${project}${runId ? `/${runId}` : ""}`);
}

// ---------------------------------------------------------------------------
// Validation file I/O
// ---------------------------------------------------------------------------

function validationPath(qaFile: string, variant: string): string {
  return path.join(path.dirname(qaFile), `validation.${variant}.json`);
}

async function writeValidation(filePath: string, data: ValidationFile): Promise<void> {
  syncValidationStats(data);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Judge output normalization
// ---------------------------------------------------------------------------

function normalizeJudge(
  raw: RawJudgeOutput,
  scoringPoints: Array<{ point: string; weight: number }>,
): import("../lib/schemas.ts").JudgeOutput {
  const maxScore = scoringPoints.reduce((s, p) => s + p.weight, 0);
  const scoringPointResults = scoringPoints.map((sp, i) => {
    const r = raw.results[i];
    const pts = Math.max(0, Math.min(sp.weight, r?.score ?? 0));
    return { point: sp.point, weight: sp.weight, score: pts, covered: pts >= sp.weight, rationale: r?.rationale ?? "" };
  });
  const score = scoringPointResults.reduce((s, p) => s + p.score, 0);
  const normalizedScore = maxScore > 0 ? Number((score / maxScore).toFixed(4)) : 0;
  return { score, maxScore, normalizedScore, verdict: verdictFor(normalizedScore), scoringPointResults, judgeSummary: raw.judgeSummary };
}

function verdictFor(n: number): "excellent" | "good" | "partial" | "poor" {
  if (n >= 0.85) return "excellent";
  if (n >= 0.65) return "good";
  if (n >= 0.35) return "partial";
  return "poor";
}

// ---------------------------------------------------------------------------
// Item selection
// ---------------------------------------------------------------------------

function selectItems(data: QaFile, opts: Options): QaItem[] {
  const byId = opts.itemIds ? new Set(opts.itemIds) : null;
  let items = byId ? data.items.filter(it => byId.has(it.id)) : data.items;
  if (opts.limit) items = items.slice(0, opts.limit);
  if (items.length === 0) throw new Error("No QA items selected");
  return items;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function loadExistingValidation(filePath: string): Promise<ValidationFile | null> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf-8"));
    return normalizeValidationFile(ValidationFile.parse(raw));
  } catch {
    return null;
  }
}

function findExistingResult(validation: ValidationFile, itemId: string): ValidationItem | undefined {
  return validation.results.find((result) => result.itemId === itemId && result.status === "done");
}

function canReuseAnswer(result: ValidationItem | undefined, answerProvider: string): result is ValidationItem & { answer: ValidationAnswer } {
  return result?.status === "done" && result.answer?.provider === answerProvider && result.answer.text.trim().length > 0;
}

function needsValidation(item: QaItem, validation: ValidationFile, opts: Options): boolean {
  const existing = findExistingResult(validation, item.id);
  if (!canReuseAnswer(existing, opts.answerProvider)) return true;
  return opts.judgeProviders.some((provider) => !judgeFor(existing, provider));
}

function removeResult(validation: ValidationFile, itemId: string): void {
  validation.results = validation.results.filter((result) => result.itemId !== itemId);
}

function makeJudge(
  provider: "codex" | "claude",
  sessionId: string,
  output: JudgeOutput,
  metrics: ValidationJudge["metrics"],
): ValidationJudge {
  return { provider, sessionId, output, metrics };
}

async function main(): Promise<void> {
  assertBenchWorker();
  const opts = parseArgs(process.argv.slice(2));
  const { file: qaFile, data: qaData } = await loadQaFile(opts.dataDir, opts.project, opts.runId);
  const language = opts.language ?? qaData.language;
  const items = selectItems(qaData, opts);
  const outFile = validationPath(qaFile, opts.docVariant);

  console.log(`[setup] preparing workdir: ${opts.docVariant}/${opts.project}${opts.force ? " (force rebuild)" : ""}`);
  const workdir = await setupWorkdir({
    project: opts.project,
    variant: opts.docVariant,
    ablationDocsRoot: opts.ablationDocs,
    validationRoot: opts.validationRoot,
    skillTemplateDir: opts.skillTemplate,
    force: opts.force,
  });
  console.log(`[setup] workdir ready: ${workdir}`);

  const existing = await loadExistingValidation(outFile);

  const now = new Date().toISOString();
  const validation: ValidationFile = {
    schemaVersion: 2,
    project: opts.project,
    docVariant: opts.docVariant,
    workdir,
    language,
    answerProvider: opts.answerProvider,
    judgeProvider: opts.judgeProviders[0]!,
    judgeProviders: opts.judgeProviders,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    itemCount: items.length,
    completedCount: 0,
    averageScore: null,
    averageScores: {},
    results: existing?.results.filter(r => r.status === "done").map(normalizeValidationItem) ?? [],
  };
  await writeValidation(outFile, validation);

  const pending = items.filter(it => needsValidation(it, validation, opts));
  const reusable = items.length - pending.length;
  console.log(`[validation] project=${opts.project} variant=${opts.docVariant} items=${items.length} reusable=${reusable} pending=${pending.length}`);

  for (const item of pending) {
    const startedAt = new Date().toISOString();
    let resultItem = findExistingResult(validation, item.id);
    let answer: ValidationAnswer;

    try {
      if (canReuseAnswer(resultItem, opts.answerProvider)) {
        answer = resultItem.answer;
        console.log(`[answer:${opts.answerProvider}] item=${item.id} reuse`);
      } else {
        console.log(`[answer:${opts.answerProvider}] item=${item.id}`);
        const answerResult = await runAnswerVerifier({
          provider: opts.answerProvider,
          variant: opts.docVariant,
          language,
          prompt: buildVerifierPrompt({ category: item.category, itemId: item.id, question: item.question }),
          workdir,
        });

        cleanWorkdir(workdir);
        answer = {
          provider: opts.answerProvider,
          sessionId: answerResult.sessionId,
          text: answerResult.text,
          metrics: answerResult.metrics,
        };

        removeResult(validation, item.id);
        resultItem = {
          itemId: item.id,
          question: item.question,
          category: item.category,
          status: "done",
          startedAt,
          completedAt: startedAt,
          answer,
          judges: [],
        };
        validation.results.push(resultItem);
      }

      for (const judgeProvider of opts.judgeProviders) {
        if (judgeFor(resultItem, judgeProvider)) {
          console.log(`[judge:${judgeProvider}] item=${item.id} reuse`);
          continue;
        }

        console.log(`[judge:${judgeProvider}] item=${item.id}`);
        const judgeResult = await runAnswerJudge({
          provider: judgeProvider,
          language,
          prompt: buildJudgePrompt({
            language,
            question: item.question,
            goldAnswer: item.goldAnswer,
            scoringPoints: item.scoringPoints,
            candidateAnswer: answer.text,
          }),
          workdir,
        });

        const judgeOutput = normalizeJudge(
          RawJudgeOutput.parse(JSON.parse(judgeResult.text)),
          item.scoringPoints,
        );

        upsertJudge(resultItem, makeJudge(judgeProvider, judgeResult.sessionId, judgeOutput, judgeResult.metrics));
        await writeValidation(outFile, validation);
        console.log(`[validation] item=${item.id} judge=${judgeProvider} score=${judgeOutput.normalizedScore}`);
      }

      resultItem.completedAt = new Date().toISOString();
      await writeValidation(outFile, validation);
      console.log(`[validation] item=${item.id} done`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (resultItem?.answer) {
        resultItem.status = judgesFor(resultItem).length > 0 ? "done" : "error";
        resultItem.error = message;
        resultItem.completedAt = new Date().toISOString();
      } else {
        removeResult(validation, item.id);
        validation.results.push({
          itemId: item.id,
          question: item.question,
          category: item.category,
          status: "error",
          startedAt,
          completedAt: new Date().toISOString(),
          error: message,
        });
      }
      await writeValidation(outFile, validation);
      console.error(`[validation] item=${item.id} error=${message}`);

      try { cleanWorkdir(workdir); } catch { /* best effort */ }
    }
  }

  console.log(`[validation] wrote ${outFile}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
