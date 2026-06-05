import "dotenv/config";

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  JudgeOutput,
  Provider,
  QaFile,
  ValidationFile,
  Variant,
  type Language,
  type QaItem,
  type ValidationItem,
} from "../lib/schemas.ts";
import { runAnswerJudge, runAnswerVerifier } from "../lib/agents.ts";
import { buildJudgePrompt, buildVerifierPrompt } from "../lib/prompts.ts";
import { cleanWorkdir, setupWorkdir } from "../lib/workdir.ts";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface Options {
  project: string;
  dataDir: string;
  docVariant: "full" | "no-edges" | "flat-md";
  language?: Language;
  limit?: number;
  itemIds?: string[];
  answerProvider: "codex" | "claude";
  judgeProvider: "codex" | "claude";
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
    dataDir: path.resolve(m.get("data-dir") ?? "bench/data"),
    docVariant: Variant.parse(m.get("doc-variant") ?? "full"),
    language: m.has("language") ? (m.get("language") as Language) : undefined,
    limit: m.has("limit") ? Number.parseInt(m.get("limit")!, 10) : undefined,
    itemIds: m.get("item-ids")?.split(",").map(s => s.trim()).filter(Boolean),
    answerProvider: Provider.parse(m.get("answer-provider") ?? "codex"),
    judgeProvider: Provider.parse(m.get("judge-provider") ?? "claude"),
    validationRoot: path.resolve(m.get("validation-root") ?? "bench/validation"),
    ablationDocs: path.resolve(m.get("ablation-docs") ?? "bench/data/ablation-docs"),
    skillTemplate: path.resolve(m.get("skill-template") ?? "src/skill-template-readonly"),
    force: m.has("force"),
  };
}

// ---------------------------------------------------------------------------
// QA file loading
// ---------------------------------------------------------------------------

async function loadQaFile(dataDir: string, project: string): Promise<{ file: string; data: QaFile }> {
  const file = path.join(dataDir, project, "qa.generated.json");
  if (!(await stat(file).catch(() => null))?.isFile()) {
    throw new Error(`QA file not found: ${file}`);
  }
  return { file, data: QaFile.parse(JSON.parse(await readFile(file, "utf-8"))) };
}

// ---------------------------------------------------------------------------
// Validation file I/O
// ---------------------------------------------------------------------------

function validationPath(qaFile: string, variant: string): string {
  return path.join(path.dirname(qaFile), `validation.${variant}.json`);
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

// ---------------------------------------------------------------------------
// Judge output normalization
// ---------------------------------------------------------------------------

function normalizeJudge(
  raw: JudgeOutput,
  scoringPoints: Array<{ point: string; weight: number }>,
): JudgeOutput {
  const maxScore = scoringPoints.reduce((s, p) => s + p.weight, 0);
  const coveredScore = raw.scoringPointResults
    .filter(p => p.covered)
    .reduce((s, p) => s + p.weight, 0);
  const score = Math.min(maxScore, Math.max(0, raw.scoringPointResults.length > 0 ? coveredScore : raw.score));
  const normalizedScore = maxScore > 0 ? Number((score / maxScore).toFixed(4)) : 0;
  return { ...raw, score, maxScore, normalizedScore, verdict: verdictFor(normalizedScore) };
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

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const { file: qaFile, data: qaData } = await loadQaFile(opts.dataDir, opts.project);
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

  const now = new Date().toISOString();
  const validation: ValidationFile = {
    schemaVersion: 2,
    project: opts.project,
    docVariant: opts.docVariant,
    workdir,
    language,
    answerProvider: opts.answerProvider,
    judgeProvider: opts.judgeProvider,
    createdAt: now,
    updatedAt: now,
    itemCount: items.length,
    completedCount: 0,
    averageScore: null,
    results: [],
  };
  await writeValidation(outFile, validation);

  console.log(`[validation] project=${opts.project} variant=${opts.docVariant} items=${items.length}`);

  for (const item of items) {
    const startedAt = new Date().toISOString();
    console.log(`[answer:${opts.answerProvider}] item=${item.id}`);

    try {
      const answer = await runAnswerVerifier({
        provider: opts.answerProvider,
        variant: opts.docVariant,
        language,
        prompt: buildVerifierPrompt({ category: item.category, itemId: item.id, question: item.question }),
        workdir,
      });

      cleanWorkdir(workdir);

      console.log(`[judge:${opts.judgeProvider}] item=${item.id}`);
      const judgeResult = await runAnswerJudge({
        provider: opts.judgeProvider,
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
        JudgeOutput.parse(JSON.parse(judgeResult.text)),
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
          sessionId: answer.sessionId,
          text: answer.text,
          metrics: answer.metrics,
        },
        judge: {
          provider: opts.judgeProvider,
          sessionId: judgeResult.sessionId,
          output: judgeOutput,
          metrics: judgeResult.metrics,
        },
      });

      await writeValidation(outFile, validation);
      console.log(`[validation] item=${item.id} score=${judgeOutput.normalizedScore}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      validation.results.push({
        itemId: item.id,
        question: item.question,
        category: item.category,
        status: "error",
        startedAt,
        completedAt: new Date().toISOString(),
        error: message,
      });
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
