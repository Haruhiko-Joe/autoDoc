import "dotenv/config";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { OutputFormat } from "@anthropic-ai/claude-agent-sdk";
import { Codex } from "@openai/codex-sdk";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { toOutputSchema } from "../src/agents/schemas/schema.js";

const Provider = z.enum(["codex", "claude"]);
const Language = z.enum(["zh", "en"]);
const Difficulty = z.enum(["medium", "hard", "expert"]);
const Category = z.enum([
  "architecture",
  "data-flow",
  "lifecycle",
  "configuration",
  "failure-mode",
  "integration",
  "state-management",
  "api-contract",
]);

const SourceEvidence = z.object({
  filePath: z.string(),
  lineHint: z.string(),
  summary: z.string(),
});

const DocNavigationHint = z.object({
  modulePath: z.string(),
  reason: z.string(),
});

const QaItem = z.object({
  question: z.string(),
  goldAnswer: z.string(),
  category: Category,
  difficulty: Difficulty,
  requiredConcepts: z.array(z.string()).min(2),
  sourceEvidence: z.array(SourceEvidence).min(1),
  docNavigationHints: z.array(DocNavigationHint).min(1),
});

const QaBatchOutput = z.object({
  items: z.array(QaItem),
});

const GeneratedQaItem = QaItem.extend({
  id: z.string(),
  generator: Provider,
  generatorSessionId: z.string(),
  batchIndex: z.number().int().min(0),
  itemIndex: z.number().int().min(0),
});

const GeneratedQaFile = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  project: z.string(),
  repoPath: z.string(),
  docRoot: z.string(),
  language: Language,
  createdAt: z.string(),
  updatedAt: z.string(),
  countPerProvider: z.number().int().min(1),
  batchSize: z.number().int().min(1),
  providers: z.array(Provider),
  batches: z.array(z.object({
    provider: Provider,
    batchIndex: z.number().int().min(0),
    sessionId: z.string(),
    itemIds: z.array(z.string()),
    completedAt: z.string(),
  })),
  items: z.array(GeneratedQaItem),
});

type Provider = z.infer<typeof Provider>;
type Language = z.infer<typeof Language>;
type QaItem = z.infer<typeof QaItem>;
type GeneratedQaFile = z.infer<typeof GeneratedQaFile>;

type GenerateOptions = {
  project: string;
  repoPath: string;
  docRoot: string;
  outDir: string;
  language: Language;
  count: number;
  batchSize: number;
  providers: Provider[];
  runId: string;
  codexModel?: string;
  claudeModel?: string;
};

function usage(): string {
  return [
    "Usage: pnpm exec tsx scripts/generate-qa.ts [options]",
    "",
    "Generates code-grounded QA pairs for a documented repository.",
    "",
    "Options:",
    "  --project <name>          Project name in doc root (default: git)",
    "  --repo <path>             Target source repo (default: src/souko/repo/git)",
    "  --doc-root <path>         autoDoc docs root (default: src/souko/doc)",
    "  --out-dir <path>          Output root (default: benchmarks/qa)",
    "  --language <zh|en>        QA language (default: zh)",
    "  --count <number>          QA count per provider (default: 20)",
    "  --batch-size <number>     QA count per structured turn (default: 2)",
    "  --providers <list>        Comma-separated providers (default: codex,claude)",
    "  --run-id <id>             Override output run id",
    "  --codex-model <model>     Optional Codex model override",
    "  --claude-model <model>    Claude model (default: claude-opus-4-7[1m])",
    "  --help                    Show this help",
  ].join("\n");
}

function parseArgs(argv: string[]): GenerateOptions {
  const values = parseFlagMap(argv);
  if (values.has("help") || values.has("h")) {
    console.log(usage());
    process.exit(0);
  }

  const language = Language.parse(values.get("language") ?? "zh");
  const providers = Provider.array().min(1).parse(splitList(values.get("providers") ?? "codex,claude"));
  const count = positiveInt(values.get("count") ?? "20", "count");
  const batchSize = positiveInt(values.get("batch-size") ?? "2", "batch-size");
  const runId = values.get("run-id") ?? makeRunId();
  const codexModel = optionalString(values.get("codex-model"));
  const claudeModel = optionalString(values.get("claude-model"));

  return {
    project: values.get("project") ?? "git",
    repoPath: path.resolve(values.get("repo") ?? "src/souko/repo/git"),
    docRoot: path.resolve(values.get("doc-root") ?? "src/souko/doc"),
    outDir: path.resolve(values.get("out-dir") ?? "benchmarks/qa"),
    language,
    count,
    batchSize,
    providers,
    runId,
    codexModel,
    claudeModel,
  };
}

function parseFlagMap(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) break;
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
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

function splitList(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

function positiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function optionalString(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

function makeRunId(): string {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
}

async function assertDirectory(dir: string, label: string): Promise<void> {
  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`${label} is not a directory: ${dir}`);
}

async function assertFile(filePath: string, label: string): Promise<void> {
  const info = await stat(filePath).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`${label} is not a file: ${filePath}`);
}

function generationInstruction(provider: Provider, language: Language): string {
  const outputLanguage = language === "zh" ? "Chinese" : "English";
  return `
# SYSTEM PROMPT for QA Benchmark Generator (${provider})

## ROLE DEFINITION
You create rigorous QA pairs for evaluating whether documentation can support deep repository understanding.
You are operating with high tool permissions, but your role is analysis only. Do not edit files, run formatters, or change repository state.

## TASK BACKGROUND
The target repository has an autoDoc documentation tree. Use that documentation to choose relevant areas and navigation paths, but treat the source code as the source of truth for the question and gold answer.

## ABOUT THE TASK
Produce practical, challenging QA pairs in ${outputLanguage}. Each question should require reasoning about real code behavior rather than recall of a single symbol.
Good questions connect modules, lifecycle steps, data movement, configuration effects, error paths, state transitions, or API contracts where that interaction exists in the code.

## CONSTRAINTS
- Stay within the local paths explicitly supplied by the user prompt: the target repository path and documentation root.
- Do not inspect unrelated local files, home-directory data, credentials, network resources, or paths outside those supplied paths.
- Do not invent behavior. Every gold answer must be grounded in source files.
- Do not create trivia questions, naming questions, or questions that are hard only because they are obscure.
- Do not mention benchmark construction, documentation acceleration, or development workflows inside the questions.
- Avoid duplicate questions across the whole session.
- Prefer questions answerable from a focused documentation traversal, but whose gold answer is verified against code.
- Use the structured output schema exactly.

## SOP
1. Start from the documentation tree to identify candidate modules and cross-module relationships.
2. Read the relevant source files for each candidate before writing the question.
3. Write the question so it describes a realistic situation and asks for the mechanism, data path, or consequence.
4. Write a concise gold answer that cites concrete files and explains the reasoning.
5. Fill sourceEvidence with the specific files and line/function hints used.
6. Fill docNavigationHints with module paths that should help a docs-only answerer find the answer.
`.trim();
}

function generationPrompt(options: GenerateOptions, provider: Provider, batchIndex: number, batchCount: number): string {
  if (batchIndex > 0) {
    return `
Continue in the same session. Generate exactly ${batchCount} additional QA items for provider ${provider}.

Do not repeat or closely paraphrase any QA pair you already produced in this session.
Use the same project, repository path, documentation root, language, quality bar, and structured output schema as before.
`.trim();
  }

  return `
Generate batch ${batchIndex + 1} for provider ${provider}.

Project: ${options.project}
Repository path: ${options.repoPath}
Documentation root: ${options.docRoot}
Required item count for this batch: ${batchCount}
Language: ${options.language === "zh" ? "Chinese" : "English"}

Return exactly ${batchCount} new QA items.
`.trim();
}

async function runCodexBatch(
  options: GenerateOptions,
  provider: Provider,
  batchIndex: number,
  batchCount: number,
  threadState: { thread?: ReturnType<Codex["startThread"]> },
): Promise<{ sessionId: string; items: QaItem[] }> {
  if (!threadState.thread) {
    const codex = new Codex({
      config: {
        developer_instructions: generationInstruction(provider, options.language),
      },
    });
    threadState.thread = codex.startThread({
      workingDirectory: options.repoPath,
      skipGitRepoCheck: true,
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      webSearchMode: "disabled",
      modelReasoningEffort: "high",
      model: options.codexModel,
    });
  }

  const turn = await threadState.thread.run(
    generationPrompt(options, provider, batchIndex, batchCount),
    { outputSchema: toOutputSchema(QaBatchOutput) },
  );
  rejectCodexFileChanges(turn.items);
  const parsed = QaBatchOutput.parse(JSON.parse(turn.finalResponse));
  const sessionId = threadState.thread.id;
  if (!sessionId) throw new Error("Codex thread has no session id");
  return { sessionId, items: exactBatch(parsed.items, batchCount, provider, batchIndex) };
}

function rejectCodexFileChanges(items: unknown[]): void {
  const changed = items.some((item) => {
    if (typeof item !== "object" || item === null) return false;
    if (!("type" in item)) return false;
    return item.type === "file_change";
  });
  if (changed) throw new Error("Codex produced file changes during QA generation");
}

async function runClaudeBatch(
  options: GenerateOptions,
  provider: Provider,
  batchIndex: number,
  batchCount: number,
  sessionId: string | undefined,
): Promise<{ sessionId: string; items: QaItem[] }> {
  const outputFormat: OutputFormat = {
    type: "json_schema",
    schema: toOutputSchema(QaBatchOutput),
  };
  let nextSessionId = "";
  let result: z.infer<typeof QaBatchOutput> | undefined;

  for await (const message of query({
    prompt: generationPrompt(options, provider, batchIndex, batchCount),
    options: {
      model: options.claudeModel ?? "claude-opus-4-7[1m]",
      betas: ["context-1m-2025-08-07"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      tools: { type: "preset", preset: "claude_code" },
      cwd: options.repoPath,
      outputFormat,
      maxTurns: 30,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: generationInstruction(provider, options.language),
      },
      ...(sessionId ? { resume: sessionId } : {}),
    },
  })) {
    if (message.type === "system" && message.subtype === "init") {
      nextSessionId = message.session_id;
    } else if (message.type === "result") {
      nextSessionId = message.session_id;
      if (message.subtype === "success" && message.structured_output) {
        result = QaBatchOutput.parse(message.structured_output);
      } else {
        throw new Error(`Claude QA generation failed: ${message.subtype}`);
      }
    }
  }

  if (!result) throw new Error("Claude QA generation returned no structured output");
  if (!nextSessionId) throw new Error("Claude QA generation returned no session id");
  return { sessionId: nextSessionId, items: exactBatch(result.items, batchCount, provider, batchIndex) };
}

function exactBatch(items: QaItem[], batchCount: number, provider: Provider, batchIndex: number): QaItem[] {
  if (items.length !== batchCount) {
    throw new Error(`${provider} batch ${batchIndex + 1} returned ${items.length} items, expected ${batchCount}`);
  }
  return items;
}

function outputPath(options: GenerateOptions): string {
  return path.join(options.outDir, options.project, options.runId, "qa.generated.json");
}

async function writeGeneratedFile(filePath: string, data: GeneratedQaFile): Promise<void> {
  const parsed = GeneratedQaFile.parse(data);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await assertDirectory(options.repoPath, "Repository path");
  await assertDirectory(options.docRoot, "Documentation root");
  await assertFile(path.join(options.docRoot, options.project, "top.json"), "Project top.json");

  const now = new Date().toISOString();
  const data: GeneratedQaFile = {
    schemaVersion: 1,
    runId: options.runId,
    project: options.project,
    repoPath: options.repoPath,
    docRoot: options.docRoot,
    language: options.language,
    createdAt: now,
    updatedAt: now,
    countPerProvider: options.count,
    batchSize: options.batchSize,
    providers: options.providers,
    batches: [],
    items: [],
  };
  const filePath = outputPath(options);
  await writeGeneratedFile(filePath, data);

  for (const provider of options.providers) {
    const codexThreadState: { thread?: ReturnType<Codex["startThread"]> } = {};
    let claudeSessionId: string | undefined;
    let generatedForProvider = 0;
    let batchIndex = 0;

    while (generatedForProvider < options.count) {
      const remaining = options.count - generatedForProvider;
      const batchCount = Math.min(options.batchSize, remaining);
      console.log(`[${provider}] generating batch ${batchIndex + 1} (${batchCount} QA pairs)`);
      const batch = provider === "codex"
        ? await runCodexBatch(options, provider, batchIndex, batchCount, codexThreadState)
        : await runClaudeBatch(options, provider, batchIndex, batchCount, claudeSessionId);

      if (provider === "claude") claudeSessionId = batch.sessionId;

      const itemIds: string[] = [];
      for (const item of batch.items) {
        const itemIndex = generatedForProvider + 1;
        const id = `${provider}-${String(itemIndex).padStart(2, "0")}`;
        itemIds.push(id);
        data.items.push({
          id,
          generator: provider,
          generatorSessionId: batch.sessionId,
          batchIndex,
          itemIndex,
          ...item,
        });
        generatedForProvider += 1;
      }

      const completedAt = new Date().toISOString();
      data.updatedAt = completedAt;
      data.batches.push({
        provider,
        batchIndex,
        sessionId: batch.sessionId,
        itemIds,
        completedAt,
      });
      await writeGeneratedFile(filePath, data);
      console.log(`[${provider}] wrote partial output: ${filePath}`);
      batchIndex += 1;
    }
  }

  console.log(`Generated ${data.items.length} QA pairs at ${filePath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
