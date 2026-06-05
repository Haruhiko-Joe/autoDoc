import "dotenv/config";

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AnswerJudgeOutput,
  AnswerVerifierOutput,
  AgentRunMetrics,
  type AgentResult,
  type IAnswerJudge,
  type IAnswerVerifier,
  type Language,
} from "../../src/agents/schemas/schema.js";
import {
  claudeAnswerJudge,
  claudeAnswerVerifier,
  codexAnswerJudge,
  codexAnswerVerifier,
} from "../../src/agents/tsukai/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BROWSE_SCRIPT = path.resolve(__dirname, "../../src/skill-template-readonly/scripts/browse.mjs");

const Provider = z.enum(["codex", "claude"]);
const LanguageSchema = z.enum(["zh", "en"]);
const ScoringPoint = z.object({
  point: z.string(),
  weight: z.number().int().min(1),
});
const QaItem = z.object({
  id: z.string(),
  generator: z.string(),
  question: z.string(),
  goldAnswer: z.string(),
  scoringPoints: z.array(ScoringPoint),
  category: z.string(),
  requiredConcepts: z.array(z.string()).optional(),
});
const GeneratedQaFile = z.object({
  schemaVersion: z.number(),
  project: z.string(),
  runId: z.string().optional(),
  repoPath: z.string().optional(),
  language: LanguageSchema,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  items: z.array(QaItem),
});

const ValidationAnswerRecord = z.object({
  provider: Provider,
  sessionId: z.string(),
  output: AnswerVerifierOutput,
  metrics: AgentRunMetrics.optional(),
});
const ValidationJudgeRecord = z.object({
  provider: Provider,
  sessionId: z.string(),
  output: AnswerJudgeOutput,
  metrics: AgentRunMetrics.optional(),
});
const ValidationItem = z.object({
  itemId: z.string(),
  question: z.string(),
  category: z.string(),
  status: z.enum(["done", "error"]),
  startedAt: z.string(),
  completedAt: z.string(),
  answer: ValidationAnswerRecord.optional(),
  judge: ValidationJudgeRecord.optional(),
  error: z.string().optional(),
});
const ValidationFile = z.object({
  schemaVersion: z.literal(1),
  project: z.string(),
  runId: z.string(),
  qaFile: z.string(),
  docVariant: z.string(),
  docRoot: z.string(),
  docProject: z.string(),
  browseScript: z.string(),
  language: LanguageSchema,
  mode: z.literal("doc-drill"),
  answerProvider: Provider,
  judgeProvider: Provider,
  createdAt: z.string(),
  updatedAt: z.string(),
  itemCount: z.number().int().min(0),
  completedCount: z.number().int().min(0),
  averageScore: z.number().min(0).max(1).nullable(),
  results: z.array(ValidationItem),
});

type Provider = z.infer<typeof Provider>;
type QaItem = z.infer<typeof QaItem>;
type GeneratedQaFile = z.infer<typeof GeneratedQaFile>;
type ValidationFile = z.infer<typeof ValidationFile>;

interface ValidateOptions {
  project: string;
  runId?: string;
  qaFile?: string;
  outFile?: string;
  dataDir: string;
  docVariant: string;
  docRoot: string;
  docProject: string;
  browseScript: string;
  language?: Language;
  limit?: number;
  itemIds?: string[];
  answerProvider: Provider;
  judgeProvider: Provider;
}

interface QaRunRef {
  project: string;
  runId: string;
  file: string;
  createdAt: string;
}

function parseFlagMap(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) break;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      values.set(key, "true");
      index += 1;
    } else {
      values.set(key, next);
      index += 2;
    }
  }
  return values;
}

function optionalString(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((part) => part.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function positiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function usage(): string {
  return [
    "Usage: pnpm exec tsx bench/scripts/validate-answers.ts [options]",
    "",
    "Runs ACCEED-Bench Phase 2 answer validation for a QA run.",
    "",
    "Options:",
    "  --project <name>              Project name (default: git)",
    "  --run-id <id>                 QA run id under bench/data/<project>/<run-id>",
    "  --qa-file <path>              Explicit QA file path",
    "  --out-file <path>             Explicit validation output path",
    "  --data-dir <path>             Benchmark data root (default: bench/data)",
    "  --doc-variant <name>          Documentation variant label (default: source)",
    "  --doc-root <path>             Documentation root (default: src/souko/doc)",
    "  --doc-project <name>          Documentation project name (default: --project)",
    "  --browse-script <path>        Readonly doc-drill browse script",
    "  --language <zh|en>            Output language (default: QA file language)",
    "  --limit <number>              Validate only the first N selected items",
    "  --item-ids <list>             Comma-separated QA item ids",
    "  --answer-provider <provider>  codex or claude (default: codex)",
    "  --judge-provider <provider>   codex or claude (default: claude)",
    "  --help                       Show this help",
  ].join("\n");
}

function parseArgs(argv: string[]): ValidateOptions {
  const values = parseFlagMap(argv);
  if (values.has("help") || values.has("h")) {
    console.log(usage());
    process.exit(0);
  }

  const project = values.get("project") ?? "git";
  return {
    project,
    runId: optionalString(values.get("run-id")),
    qaFile: optionalString(values.get("qa-file")) ? path.resolve(values.get("qa-file")!) : undefined,
    outFile: optionalString(values.get("out-file")) ? path.resolve(values.get("out-file")!) : undefined,
    dataDir: path.resolve(values.get("data-dir") ?? "bench/data"),
    docVariant: values.get("doc-variant") ?? "source",
    docRoot: path.resolve(values.get("doc-root") ?? "src/souko/doc"),
    docProject: values.get("doc-project") ?? project,
    browseScript: path.resolve(values.get("browse-script") ?? DEFAULT_BROWSE_SCRIPT),
    language: values.has("language") ? LanguageSchema.parse(values.get("language")) : undefined,
    limit: positiveInt(values.get("limit"), "limit"),
    itemIds: splitList(values.get("item-ids")),
    answerProvider: Provider.parse(values.get("answer-provider") ?? "codex"),
    judgeProvider: Provider.parse(values.get("judge-provider") ?? "claude"),
  };
}

async function assertFile(file: string, label: string): Promise<void> {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`${label} is not a file: ${file}`);
}

async function assertDirectory(dir: string, label: string): Promise<void> {
  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`${label} is not a directory: ${dir}`);
}

async function listQaRuns(dataDir: string, project: string): Promise<QaRunRef[]> {
  const projectDir = path.join(dataDir, project);
  const info = await stat(projectDir).catch(() => undefined);
  if (!info?.isDirectory()) return [];

  const refs: QaRunRef[] = [];
  const direct = path.join(projectDir, "qa.generated.json");
  const directInfo = await stat(direct).catch(() => undefined);
  if (directInfo?.isFile()) {
    const raw = GeneratedQaFile.parse(JSON.parse(await readFile(direct, "utf-8")));
    refs.push({
      project,
      runId: raw.runId ?? "latest",
      file: direct,
      createdAt: raw.createdAt,
    });
  }

  const entries = await readdir(projectDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(projectDir, entry.name, "qa.generated.json");
    const fileInfo = await stat(file).catch(() => undefined);
    if (!fileInfo?.isFile()) continue;
    try {
      const raw = GeneratedQaFile.parse(JSON.parse(await readFile(file, "utf-8")));
      refs.push({
        project,
        runId: raw.runId ?? entry.name,
        file,
        createdAt: raw.createdAt,
      });
    } catch {
      // Skip corrupt runs.
    }
  }

  return refs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function resolveQaRun(options: ValidateOptions): Promise<QaRunRef> {
  if (options.qaFile) {
    await assertFile(options.qaFile, "QA file");
    const raw = GeneratedQaFile.parse(JSON.parse(await readFile(options.qaFile, "utf-8")));
    return {
      project: raw.project,
      runId: raw.runId ?? options.runId ?? path.basename(path.dirname(options.qaFile)),
      file: options.qaFile,
      createdAt: raw.createdAt,
    };
  }

  const runs = await listQaRuns(options.dataDir, options.project);
  if (runs.length === 0) throw new Error(`No QA runs found for project ${options.project}`);
  if (options.runId) {
    const found = runs.find((run) => run.runId === options.runId);
    if (!found) throw new Error(`QA run not found: ${options.project}/${options.runId}`);
    return found;
  }
  return runs[0]!;
}

function defaultOutFile(qaFile: string, docVariant: string): string {
  const suffix = docVariant === "source" ? "generated" : docVariant;
  if (!/^[A-Za-z0-9_-]+$/.test(suffix)) throw new Error(`Invalid documentation variant: ${docVariant}`);
  return path.join(path.dirname(qaFile), `validation.${suffix}.json`);
}

function makeAnswerVerifier(provider: Provider, language: Language): IAnswerVerifier {
  return provider === "codex" ? new codexAnswerVerifier(language) : new claudeAnswerVerifier(language);
}

function makeAnswerJudge(provider: Provider, language: Language): IAnswerJudge {
  return provider === "codex" ? new codexAnswerJudge(language) : new claudeAnswerJudge(language);
}

function buildAnswerPrompt(options: ValidateOptions, language: Language, item: QaItem): string {
  const outputLanguage = language === "zh" ? "Chinese" : "English";
  return `
Answer this ACCEED-Bench question using only the readonly doc-drill browse tool.

Project: ${options.docProject}
Documentation root: ${options.docRoot}
Browse script: ${options.browseScript}
Answer language: ${outputLanguage}

Use commands like:
\`\`\`bash
node ${JSON.stringify(options.browseScript)} ${JSON.stringify(options.docRoot)} ${JSON.stringify(options.docProject)}
node ${JSON.stringify(options.browseScript)} ${JSON.stringify(options.docRoot)} ${JSON.stringify(options.docProject)} --flows
node ${JSON.stringify(options.browseScript)} ${JSON.stringify(options.docRoot)} ${JSON.stringify(options.docProject)} --search "<keyword>"
node ${JSON.stringify(options.browseScript)} ${JSON.stringify(options.docRoot)} ${JSON.stringify(options.docProject)} "<Module>/<Child>"
node ${JSON.stringify(options.browseScript)} ${JSON.stringify(options.docRoot)} ${JSON.stringify(options.docProject)} "<Module>/<Leaf>" --read
\`\`\`

Do not read source code or benchmark answer files. If the docs are insufficient, answer what is supported and put gaps in missingInfo.

Question (${item.category}, id ${item.id}):
${item.question}
`.trim();
}

function buildJudgePrompt(language: Language, item: QaItem, answer: AgentResult<z.infer<typeof AnswerVerifierOutput>>): string {
  const outputLanguage = language === "zh" ? "Chinese" : "English";
  return `
Judge this candidate answer in ${outputLanguage}.

## Question
${item.question}

## Gold answer
${item.goldAnswer}

## Scoring points
${JSON.stringify(item.scoringPoints, null, 2)}

## Candidate answer
${answer.result.answer}

## Candidate citations
${JSON.stringify(answer.result.citations, null, 2)}

## Candidate missing-info note
${answer.result.missingInfo || "(none)"}
`.trim();
}

function selectItems(data: GeneratedQaFile, options: ValidateOptions): QaItem[] {
  const byId = new Set(options.itemIds);
  let items = options.itemIds ? data.items.filter((item) => byId.has(item.id)) : data.items;
  if (options.limit !== undefined) items = items.slice(0, options.limit);
  if (items.length === 0) throw new Error("No QA items selected for validation");
  return items;
}

function summarizeAverage(results: ValidationFile["results"]): number | null {
  const done = results.filter((item) => item.status === "done" && item.judge);
  if (done.length === 0) return null;
  const total = done.reduce((sum, item) => sum + (item.judge?.output.normalizedScore ?? 0), 0);
  return Number((total / done.length).toFixed(4));
}

async function writeValidationFile(filePath: string, data: ValidationFile): Promise<void> {
  data.completedCount = data.results.filter((item) => item.status === "done").length;
  data.averageScore = summarizeAverage(data.results);
  data.updatedAt = new Date().toISOString();
  const parsed = ValidationFile.parse(data);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await assertDirectory(options.docRoot, "Documentation root");
  await assertDirectory(path.join(options.docRoot, options.docProject), "Documentation project directory");
  await assertFile(options.browseScript, "Browse script");

  const qaRun = await resolveQaRun(options);
  const qaData = GeneratedQaFile.parse(JSON.parse(await readFile(qaRun.file, "utf-8")));
  const language = options.language ?? qaData.language;
  const items = selectItems(qaData, options);
  const outFile = options.outFile ?? defaultOutFile(qaRun.file, options.docVariant);

  const now = new Date().toISOString();
  const validation: ValidationFile = {
    schemaVersion: 1,
    project: qaData.project,
    runId: qaRun.runId,
    qaFile: qaRun.file,
    docVariant: options.docVariant,
    docRoot: options.docRoot,
    docProject: options.docProject,
    browseScript: options.browseScript,
    language,
    mode: "doc-drill",
    answerProvider: options.answerProvider,
    judgeProvider: options.judgeProvider,
    createdAt: now,
    updatedAt: now,
    itemCount: items.length,
    completedCount: 0,
    averageScore: null,
    results: [],
  };
  await writeValidationFile(outFile, validation);

  console.log(`[validation] project=${validation.project} run=${validation.runId} items=${items.length}`);
  console.log(`[validation] docVariant=${options.docVariant}`);
  console.log(`[validation] docRoot=${options.docRoot} docProject=${options.docProject}`);

  for (const item of items) {
    const startedAt = new Date().toISOString();
    console.log(`[answer:${options.answerProvider}] item=${item.id}`);
    try {
      const answerer = makeAnswerVerifier(options.answerProvider, language);
      const answer = await answerer.run(buildAnswerPrompt(options, language, item), options.docRoot);

      console.log(`[judge:${options.judgeProvider}] item=${item.id}`);
      const judge = makeAnswerJudge(options.judgeProvider, language);
      const judged = await judge.run(buildJudgePrompt(language, item, answer), options.docRoot);

      validation.results.push({
        itemId: item.id,
        question: item.question,
        category: item.category,
        status: "done",
        startedAt,
        completedAt: new Date().toISOString(),
        answer: {
          provider: options.answerProvider,
          sessionId: answer.sessionId,
          output: answer.result,
          metrics: answer.metrics,
        },
        judge: {
          provider: options.judgeProvider,
          sessionId: judged.sessionId,
          output: normalizeJudgeOutput(judged.result, item.scoringPoints),
          metrics: judged.metrics,
        },
      });
      await writeValidationFile(outFile, validation);
      const last = validation.results[validation.results.length - 1];
      console.log(`[validation] item=${item.id} score=${last?.judge?.output.normalizedScore ?? "n/a"}`);
    } catch (error) {
      validation.results.push({
        itemId: item.id,
        question: item.question,
        category: item.category,
        status: "error",
        startedAt,
        completedAt: new Date().toISOString(),
        error: errorMessage(error),
      });
      await writeValidationFile(outFile, validation);
      console.error(`[validation] item=${item.id} error=${errorMessage(error)}`);
    }
  }

  console.log(`[validation] wrote ${outFile}`);
}

function normalizeJudgeOutput(
  output: z.infer<typeof AnswerJudgeOutput>,
  scoringPoints: Array<z.infer<typeof ScoringPoint>>,
): z.infer<typeof AnswerJudgeOutput> {
  const maxScore = scoringPoints.reduce((sum, point) => sum + point.weight, 0);
  const coveredScore = output.scoringPointResults
    .filter((point) => point.covered)
    .reduce((sum, point) => sum + point.weight, 0);
  const rawScore = output.scoringPointResults.length > 0 ? coveredScore : output.score;
  const score = Math.min(maxScore, Math.max(0, rawScore));
  const normalizedScore = maxScore > 0 ? Number((score / maxScore).toFixed(4)) : 0;
  return {
    ...output,
    score,
    maxScore,
    normalizedScore,
    verdict: verdictFor(normalizedScore),
  };
}

function verdictFor(normalizedScore: number): z.infer<typeof AnswerJudgeOutput>["verdict"] {
  if (normalizedScore >= 0.85) return "excellent";
  if (normalizedScore >= 0.65) return "good";
  if (normalizedScore >= 0.35) return "partial";
  return "poor";
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exit(1);
});
