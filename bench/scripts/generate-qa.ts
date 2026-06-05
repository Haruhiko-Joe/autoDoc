import "dotenv/config";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { OutputFormat } from "@anthropic-ai/claude-agent-sdk";
import { Codex } from "@openai/codex-sdk";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { toOutputSchema } from "../../src/agents/schemas/schema.js";

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

function splitList(value: string): string[] {
  return value.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
}

function positiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function optionalString(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

async function assertDirectory(dir: string, label: string): Promise<void> {
  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`${label} is not a directory: ${dir}`);
}


const Provider = z.enum(["codex", "claude"]);
const Language = z.enum(["zh", "en"]);
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

const ScoringPoint = z.object({
  point: z.string(),
  weight: z.number().int().min(1),
});

const QaItem = z.object({
  question: z.string(),
  goldAnswer: z.string(),
  scoringPoints: z.array(ScoringPoint).min(2),
  category: Category,
  requiredConcepts: z.array(z.string()).min(2),
  sourceEvidence: z.array(SourceEvidence).min(1),
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
  project: z.string(),
  runId: z.string(),
  repoPath: z.string(),
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
  runId: string;
  repoPath: string;
  outDir: string;
  language: Language;
  count: number;
  batchSize: number;
  providers: Provider[];
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
    "  --project <name>          Project name (default: git)",
    "  --run-id <id>             Output run id (default: timestamp)",
    "  --repo <path>             Target source repo (default: src/souko/repo/git)",
    "  --out-dir <path>          Output root (default: bench/data)",
    "  --language <zh|en>        QA language (default: zh)",
    "  --count <number>          QA count per provider (default: 20)",
    "  --batch-size <number>     QA count per structured turn (default: 1)",
    "  --providers <list>        Comma-separated providers (default: codex,claude)",
    "  --codex-model <model>     Optional Codex model override",
    "  --claude-model <model>    Claude model (default: claude-opus-4-6[1m])",
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
  const batchSize = positiveInt(values.get("batch-size") ?? "1", "batch-size");
  const codexModel = optionalString(values.get("codex-model"));
  const claudeModel = optionalString(values.get("claude-model"));

  return {
    project: values.get("project") ?? "git",
    runId: values.get("run-id") ?? newRunId(),
    repoPath: path.resolve(values.get("repo") ?? "src/souko/repo/git"),
    outDir: path.resolve(values.get("out-dir") ?? "bench/data"),
    language,
    count,
    batchSize,
    providers,
    codexModel,
    claudeModel,
  };
}

function generationInstruction(provider: Provider, language: Language): string {
  const outputLanguage = language === "zh" ? "Chinese" : "English";
  return `
# SYSTEM PROMPT for QA Benchmark Generator (${provider})

## ROLE DEFINITION
You create rigorous, source-code-grounded QA pairs for evaluating documentation quality.
You are operating with high tool permissions, but your role is analysis only. Do not edit files, run formatters, or change repository state.

## ABOUT THE TASK
Produce practical, complex QA pairs in ${outputLanguage} based exclusively on the source code of the target repository.
Each question should simulate a real developer scenario: debugging a cross-module issue, tracing a data flow through multiple layers, understanding the consequence of a configuration change, reasoning about error propagation, or predicting behavior under edge conditions.

The purpose of these QA pairs is to evaluate whether generated documentation can support answering deep questions WITHOUT source code access. Keep this in mind when writing gold answers and scoring points.

Quality bar:
- Questions must require reasoning across at least 2 modules or subsystems — single-file lookup questions are not acceptable.
- Questions should reflect situations a real developer would encounter: "what happens when X fails during Y", "how does data flow from A to B through C", "what are the side effects of changing config Z".
- Gold answers must explain the mechanism, data flow, causal chain, or behavioral consequence — the kind of understanding that good documentation should convey. Do NOT fill answers with specific line numbers or raw code snippets. Mention module names, function/class names, and architectural relationships instead.
- Scoring points (scoringPoints) must be facts verifiable from documentation — architectural decisions, module responsibilities, data flow steps, behavioral outcomes, error handling strategies, configuration effects. Each point has a short statement and an integer weight (higher = more important). Do NOT use line numbers, code syntax, or implementation details that only source code access can produce as scoring criteria.
- Avoid trivia, naming questions, or questions that are hard only because they are obscure.

## CONSTRAINTS
- Stay within the repository path supplied by the user prompt.
- Do not inspect unrelated local files, home-directory data, credentials, network resources, or paths outside the repository.
- Do not invent behavior. Every gold answer must be grounded in source files you have actually read.
- Do not mention benchmark construction, documentation, or development workflows inside the questions.
- Avoid duplicate or closely paraphrased questions across the entire session.
- Use the structured output schema exactly.

## SOP
1. Explore the repository structure freely — use ls, find, grep, or read files to understand the codebase layout.
2. Identify cross-module relationships, data flows, error paths, lifecycle transitions, or configuration effects.
3. For each candidate question, read all relevant source files to verify the behavior.
4. Write the question as a realistic scenario that asks for the mechanism, data path, consequence, or side effect.
5. Write a gold answer that explains the mechanism at the architectural level — module names, function/class names, data flow, causal reasoning. No line numbers, no code blocks.
6. Decompose the gold answer into scoring points — each an atomic, documentation-verifiable fact with an importance weight. Ask yourself: "could someone answer this from well-written docs?" If not, rephrase the point.
7. Fill sourceEvidence with the specific files and line/function hints you used to verify the answer (this is metadata for validation, not part of the scored answer).
`.trim();
}

function generationPrompt(options: GenerateOptions, _provider: Provider, batchIndex: number, batchCount: number): string {
  if (batchIndex > 0) {
    return `
Continue in the same session. Generate exactly ${batchCount} additional QA items.

Do not repeat or closely paraphrase any QA pair you already produced in this session.
Explore different areas of the codebase than previous batches — target modules, layers, or interaction patterns you have not yet covered.
Use the same repository path, language, quality bar, and structured output schema as before.
`.trim();
  }

  return `
Generate QA pairs for project "${options.project}".

Repository path: ${options.repoPath}
Required item count: ${batchCount}
Language: ${options.language === "zh" ? "Chinese" : "English"}

Start by exploring the repository structure, then produce exactly ${batchCount} QA items.
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
      model: options.claudeModel ?? "claude-opus-4-6[1m]",
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
  return path.join(options.outDir, options.project, "qa.generated.json");
}

function newRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function writeGeneratedFile(filePath: string, data: GeneratedQaFile): Promise<void> {
  const parsed = GeneratedQaFile.parse(data);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
}

async function loadExistingGenerated(filePath: string): Promise<GeneratedQaFile | null> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf-8"));
    return GeneratedQaFile.parse(raw);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await assertDirectory(options.repoPath, "Repository path");

  const filePath = outputPath(options);
  const existing = await loadExistingGenerated(filePath);

  const now = new Date().toISOString();
  const data: GeneratedQaFile = existing ?? {
    schemaVersion: 1,
    project: options.project,
    runId: options.runId,
    repoPath: options.repoPath,
    language: options.language,
    createdAt: now,
    updatedAt: now,
    countPerProvider: options.count,
    batchSize: options.batchSize,
    providers: options.providers,
    batches: [],
    items: [],
  };
  data.countPerProvider = options.count;
  data.providers = options.providers;

  if (existing) {
    console.log(`[resume] loaded ${existing.items.length} existing items from ${filePath}`);
  }
  await writeGeneratedFile(filePath, data);

  for (const provider of options.providers) {
    const existingCount = data.items.filter(it => it.generator === provider).length;
    if (existingCount >= options.count) {
      console.log(`[${provider}] already has ${existingCount}/${options.count} items, skipping`);
      continue;
    }

    const codexThreadState: { thread?: ReturnType<Codex["startThread"]> } = {};
    let claudeSessionId: string | undefined;
    let generatedForProvider = existingCount;
    let batchIndex = data.batches.filter(b => b.provider === provider).length;

    while (generatedForProvider < options.count) {
      const remaining = options.count - generatedForProvider;
      const batchCount = Math.min(options.batchSize, remaining);
      console.log(`[${provider}] generating batch ${batchIndex + 1} (${batchCount} QA pairs, ${generatedForProvider}/${options.count} done)`);
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
