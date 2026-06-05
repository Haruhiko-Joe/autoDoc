import "dotenv/config";

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  RawJudgeOutput,
  Provider,
  QaFile,
  ValidationFile,
  type Language,
  type QaItem,
  type ValidationItem,
  type JudgeOutput,
} from "../lib/schemas.ts";
import { runAnswerJudge } from "../lib/agents.ts";
import { buildJudgePrompt } from "../lib/prompts.ts";

interface Options {
  project: string;
  runId?: string;
  dataDir: string;
  docVariant: string;
  language?: Language;
  limit?: number;
  itemIds?: string[];
  answerProvider: string;
  judgeProvider: "codex" | "claude";
  answersFile: string;
}

const ManualAnswersFile = z.object({
  answers: z.record(z.string(), z.string()),
});

function parseArgs(argv: string[]): Options {
  const m = new Map<string, string>();
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i]!;
    if (!tok.startsWith("--")) throw new Error(`Unexpected: ${tok}`);
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      m.set(key, "true");
      i += 1;
    } else {
      m.set(key, next);
      i += 2;
    }
  }

  const docVariant = m.get("doc-variant") ?? "chatgpt-5-5";
  if (!isSafeVariant(docVariant)) throw new Error(`Invalid validation label: ${docVariant}`);

  const answersFile = m.get("answers-file");
  if (!answersFile) throw new Error("--answers-file is required");

  return {
    project: m.get("project") ?? "git",
    runId: m.get("run-id"),
    dataDir: path.resolve(m.get("data-dir") ?? "bench/data"),
    docVariant,
    language: m.has("language") ? (m.get("language") as Language) : undefined,
    limit: m.has("limit") ? Number.parseInt(m.get("limit")!, 10) : undefined,
    itemIds: m.get("item-ids")?.split(",").map(s => s.trim()).filter(Boolean),
    answerProvider: m.get("answer-provider") ?? "ChatGPT 5.5",
    judgeProvider: Provider.parse(m.get("judge-provider") ?? "claude"),
    answersFile: path.resolve(answersFile),
  };
}

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

async function loadAnswers(file: string): Promise<Map<string, string>> {
  const raw = JSON.parse(await readFile(file, "utf-8"));
  const parsed = ManualAnswersFile.parse(raw);
  return new Map(
    Object.entries(parsed.answers)
      .map(([id, answer]) => [id, answer.trim()] as const)
      .filter(([, answer]) => answer.length > 0),
  );
}

function validationPath(qaFile: string, variant: string): string {
  if (!isSafeVariant(variant)) throw new Error(`Invalid validation label: ${variant}`);
  return path.join(path.dirname(qaFile), `validation.${variant}.json`);
}

async function loadExistingValidation(filePath: string): Promise<ValidationFile | null> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf-8"));
    return ValidationFile.parse(raw);
  } catch {
    return null;
  }
}

async function writeValidation(filePath: string, data: ValidationFile): Promise<void> {
  data.completedCount = data.results.filter(r => r.status === "done").length;
  data.averageScore = averageScore(data.results);
  data.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function averageScore(results: ValidationItem[]): number | null {
  const done = results.filter(r => r.status === "done" && r.judge);
  if (done.length === 0) return null;
  const sum = done.reduce((s, r) => s + (r.judge?.output.normalizedScore ?? 0), 0);
  return Number((sum / done.length).toFixed(4));
}

function normalizeJudge(
  raw: RawJudgeOutput,
  scoringPoints: Array<{ point: string; weight: number }>,
): JudgeOutput {
  const maxScore = scoringPoints.reduce((s, p) => s + p.weight, 0);
  const scoringPointResults = scoringPoints.map((sp, i) => {
    const r = raw.results[i];
    const pts = Math.max(0, Math.min(sp.weight, r?.score ?? 0));
    return {
      point: sp.point,
      weight: sp.weight,
      score: pts,
      covered: pts >= sp.weight,
      rationale: r?.rationale ?? "",
    };
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

function selectItems(data: QaFile, opts: Options, answers: Map<string, string>): QaItem[] {
  const byId = opts.itemIds ? new Set(opts.itemIds) : null;
  let items = byId ? data.items.filter(it => byId.has(it.id)) : data.items;
  if (opts.limit) items = items.slice(0, opts.limit);
  items = items.filter(it => answers.has(it.id));
  if (items.length === 0) throw new Error("No answered QA items selected");
  return items;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const { file: qaFile, data: qaData } = await loadQaFile(opts.dataDir, opts.project, opts.runId);
  const answers = await loadAnswers(opts.answersFile);
  const language = opts.language ?? qaData.language;
  const items = selectItems(qaData, opts, answers);
  const outFile = validationPath(qaFile, opts.docVariant);
  const existing = await loadExistingValidation(outFile);
  const selectedIds = new Set(items.map(item => item.id));
  const now = new Date().toISOString();
  const workdir = path.resolve(".");

  const validation: ValidationFile = {
    schemaVersion: 2,
    project: opts.project,
    docVariant: opts.docVariant,
    workdir,
    language,
    answerProvider: opts.answerProvider,
    judgeProvider: opts.judgeProvider,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    itemCount: qaData.items.length,
    completedCount: 0,
    averageScore: null,
    results: existing?.results.filter(r => !selectedIds.has(r.itemId)) ?? [],
  };
  await writeValidation(outFile, validation);

  console.log(`[manual-validation] project=${opts.project} run=${qaData.runId ?? opts.runId ?? "latest"} label=${opts.docVariant} answered=${items.length}`);

  for (const item of items) {
    const candidateAnswer = answers.get(item.id)!;
    const startedAt = new Date().toISOString();
    console.log(`[judge:${opts.judgeProvider}] item=${item.id}`);

    try {
      const judgeResult = await runAnswerJudge({
        provider: opts.judgeProvider,
        language,
        prompt: buildJudgePrompt({
          language,
          question: item.question,
          goldAnswer: item.goldAnswer,
          scoringPoints: item.scoringPoints,
          candidateAnswer,
        }),
        workdir,
      });

      const judgeOutput = normalizeJudge(
        RawJudgeOutput.parse(JSON.parse(judgeResult.text)),
        item.scoringPoints,
      );

      validation.results.push({
        itemId: item.id,
        question: item.question,
        category: item.category,
        status: "done",
        startedAt,
        completedAt: new Date().toISOString(),
        answer: {
          provider: opts.answerProvider,
          sessionId: `manual:${opts.docVariant}:${item.id}:${startedAt}`,
          text: candidateAnswer,
        },
        judge: {
          provider: opts.judgeProvider,
          sessionId: judgeResult.sessionId,
          output: judgeOutput,
          metrics: judgeResult.metrics,
        },
      });

      await writeValidation(outFile, validation);
      console.log(`[manual-validation] item=${item.id} score=${judgeOutput.normalizedScore}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      validation.results.push({
        itemId: item.id,
        question: item.question,
        category: item.category,
        status: "error",
        startedAt,
        completedAt: new Date().toISOString(),
        answer: {
          provider: opts.answerProvider,
          sessionId: `manual:${opts.docVariant}:${item.id}:${startedAt}`,
          text: candidateAnswer,
        },
        error: message,
      });
      await writeValidation(outFile, validation);
      console.error(`[manual-validation] item=${item.id} error=${message}`);
    }
  }

  console.log(`[manual-validation] wrote ${outFile}`);
}

function isSafeVariant(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
