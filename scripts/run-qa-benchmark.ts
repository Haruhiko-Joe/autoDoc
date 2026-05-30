import "dotenv/config";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback, PostToolUseHookSpecificOutput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { Codex } from "@openai/codex-sdk";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertDirectory, assertFile, optionalPath, optionalString, parseFlagMap, positiveInt, splitList } from "./lib/cli-utils.js";

const Provider = z.enum(["codex", "claude"]);
const Language = z.enum(["zh", "en"]);
const AnswerStatus = z.enum(["success", "error"]);

const GeneratedInputItem = z.object({
  id: z.string(),
  generator: Provider,
  question: z.string(),
  goldAnswer: z.string(),
});

const GeneratedQaFile = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  project: z.string(),
  docRoot: z.string(),
  language: Language,
  items: z.array(GeneratedInputItem),
});

const BenchmarkAnswerRecord = z.object({
  provider: Provider,
  status: AnswerStatus,
  sessionId: z.string().optional(),
  docDrillCallCount: z.number().int().min(0),
  commands: z.array(z.string()),
  answerText: z.string().optional(),
  error: z.string().optional(),
  completedAt: z.string(),
});

const BenchmarkQuestionRecord = z.object({
  questionId: z.string(),
  generator: Provider,
  question: z.string(),
  answers: z.array(BenchmarkAnswerRecord),
});

const BenchmarkFile = z.object({
  schemaVersion: z.literal(1),
  generatedRunId: z.string(),
  project: z.string(),
  inputFile: z.string(),
  workspaceRoot: z.string(),
  docRoot: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  answerProviders: z.array(Provider),
  minDocDrillCalls: z.number().int().min(1),
  questions: z.array(BenchmarkQuestionRecord),
});

type Provider = z.infer<typeof Provider>;
type BenchmarkFile = z.infer<typeof BenchmarkFile>;
type GeneratedQaFile = z.infer<typeof GeneratedQaFile>;
type GeneratedInputItem = z.infer<typeof GeneratedInputItem>;

type BenchmarkOptions = {
  inputFile?: string;
  project: string;
  docRoot: string;
  outDir: string;
  answerProviders: Provider[];
  limit?: number;
  questionId?: string;
  repoPath: string;
  minDocDrillCalls: number;
  codexModel?: string;
  claudeModel?: string;
};

type Workspace = {
  root: string;
  docRoot: string;
  codexBrowseScript: string;
  claudeBrowseScript: string;
};

type ToolUse = {
  toolName: string;
  command: string;
};

function usage(): string {
  return [
    "Usage: pnpm exec tsx scripts/run-qa-benchmark.ts [options]",
    "",
    "Runs docs-only benchmark answers for generated QA JSON.",
    "",
    "Options:",
    "  --input <path>                 qa.generated.json path (default: latest for project)",
    "  --project <name>               Project name (default: git)",
    "  --doc-root <path>              ACCEED docs root (default: src/souko/doc)",
    "  --out-dir <path>               Output root (default: benchmarks/qa)",
    "  --answer-providers <list>      Comma-separated providers (default: codex,claude)",
    "  --limit <number>               Limit questions for smoke tests",
    "  --question-id <id>             Run only one question id",
    "  --repo <path>                  Source repo path used only for violation checks",
    "  --min-doc-drill-calls <number> Minimum browse calls per answer (default: 2)",
    "  --codex-model <model>          Optional Codex model override",
    "  --claude-model <model>         Claude model (default: claude-opus-4-7[1m])",
    "  --help                         Show this help",
  ].join("\n");
}

function parseArgs(argv: string[]): BenchmarkOptions {
  const values = parseFlagMap(argv);
  if (values.has("help") || values.has("h")) {
    console.log(usage());
    process.exit(0);
  }

  const answerProviders = Provider.array().min(1).parse(splitList(values.get("answer-providers") ?? "codex,claude"));
  const limitValue = values.get("limit");
  return {
    inputFile: optionalPath(values.get("input")),
    project: values.get("project") ?? "git",
    docRoot: path.resolve(values.get("doc-root") ?? "src/souko/doc"),
    outDir: path.resolve(values.get("out-dir") ?? "benchmarks/qa"),
    answerProviders,
    limit: limitValue === undefined ? undefined : positiveInt(limitValue, "limit"),
    questionId: optionalString(values.get("question-id")),
    repoPath: path.resolve(values.get("repo") ?? "src/souko/repo/git"),
    minDocDrillCalls: positiveInt(values.get("min-doc-drill-calls") ?? "2", "min-doc-drill-calls"),
    codexModel: optionalString(values.get("codex-model")),
    claudeModel: optionalString(values.get("claude-model")),
  };
}

async function findLatestGeneratedFile(options: BenchmarkOptions): Promise<string> {
  const projectDir = path.join(options.outDir, options.project);
  await assertDirectory(projectDir, "Benchmark project output directory");
  const entries = await readdir(projectDir, { withFileTypes: true });
  const candidateDirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith("."))
    .map((entry) => path.join(projectDir, entry.name));

  const candidates: { filePath: string; mtimeMs: number }[] = [];
  for (const dir of candidateDirs) {
    const filePath = path.join(dir, "qa.generated.json");
    const info = await stat(filePath).catch(() => undefined);
    if (info?.isFile()) candidates.push({ filePath, mtimeMs: info.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const latest = candidates[0];
  if (!latest) throw new Error(`No qa.generated.json found under ${projectDir}`);
  return latest.filePath;
}

async function readGeneratedFile(filePath: string): Promise<GeneratedQaFile> {
  const raw = await readFile(filePath, "utf-8");
  return GeneratedQaFile.parse(JSON.parse(raw));
}

function selectQuestions(generated: GeneratedQaFile, options: BenchmarkOptions): GeneratedInputItem[] {
  let items = generated.items;
  if (options.questionId) items = items.filter((item) => item.id === options.questionId);
  if (options.limit !== undefined) items = items.slice(0, options.limit);
  if (items.length === 0) throw new Error("No questions selected for benchmark");
  return items;
}

async function prepareWorkspace(options: BenchmarkOptions, project: string): Promise<Workspace> {
  const root = path.join(options.outDir, project, "_workspace");
  const templateDir = path.resolve("scripts/templates/qa-benchmark-skill");
  const localDocRoot = path.join(root, "doc");
  const codexSkillDir = path.join(root, ".codex", "skills", "doc-drill");
  const claudeSkillDir = path.join(root, ".claude", "skills", "doc-drill");

  await mkdir(root, { recursive: true });
  await rm(codexSkillDir, { recursive: true, force: true });
  await rm(claudeSkillDir, { recursive: true, force: true });
  await cp(templateDir, codexSkillDir, { recursive: true });
  await cp(templateDir, claudeSkillDir, { recursive: true });

  await rm(path.join(localDocRoot, project), { recursive: true, force: true });
  await mkdir(localDocRoot, { recursive: true });
  await cp(path.join(options.docRoot, project), path.join(localDocRoot, project), { recursive: true });

  const config = `${JSON.stringify({ project, docRoot: localDocRoot }, null, 2)}\n`;
  await writeFile(path.join(codexSkillDir, "config.json"), config, "utf-8");
  await writeFile(path.join(claudeSkillDir, "config.json"), config, "utf-8");

  return {
    root,
    docRoot: localDocRoot,
    codexBrowseScript: path.join(codexSkillDir, "scripts", "browse.mjs"),
    claudeBrowseScript: path.join(claudeSkillDir, "scripts", "browse.mjs"),
  };
}

function benchmarkInstruction(provider: Provider, browseScript: string, minDocDrillCalls: number): string {
  return `
# SYSTEM PROMPT for Docs-only QA Answerer (${provider})

You answer one question using only the local doc-drill skill in the current working directory.

Rules:
- Stay inside the current working directory.
- Do not read source code, generated QA files, home-directory data, network resources, or unrelated local paths.
- Do not edit files.
- Use this local documentation command at least ${minDocDrillCalls} times before answering:
  node ${browseScript}
- You may pass a module path, --read, --search <keyword>, or --flows to that command.
- Output plain text only. Do not output JSON.
`.trim();
}

function benchmarkPrompt(question: string): string {
  return `
Answer the following question using the local doc-drill skill only.

Question:
${question}
`.trim();
}

async function runCodexAnswer(
  options: BenchmarkOptions,
  question: string,
  workspace: Workspace,
): Promise<{ sessionId: string; answerText: string; commands: string[] }> {
  const codex = new Codex({
    config: {
      developer_instructions: benchmarkInstruction("codex", workspace.codexBrowseScript, options.minDocDrillCalls),
    },
  });
  const thread = codex.startThread({
    workingDirectory: workspace.root,
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    webSearchMode: "disabled",
    modelReasoningEffort: "high",
    model: options.codexModel,
  });

  const turn = await thread.run(benchmarkPrompt(question));
  rejectCodexNonDocItems(turn.items);
  const commands = turn.items
    .map(commandFromCodexItem)
    .filter((command) => command !== undefined);
  validateDocDrillUsage(commands, workspace.codexBrowseScript, options.repoPath, options.minDocDrillCalls);
  const sessionId = thread.id;
  if (!sessionId) throw new Error("Codex answer thread has no session id");
  return {
    sessionId,
    answerText: turn.finalResponse,
    commands,
  };
}

function rejectCodexNonDocItems(items: unknown[]): void {
  const badItem = items.find((item) => {
    if (typeof item !== "object" || item === null) return false;
    if (!("type" in item)) return false;
    if (item.type === "agent_message") return false;
    if (item.type === "reasoning") return false;
    if (item.type === "todo_list") return false;
    if (item.type === "command_execution") return false;
    return true;
  });
  if (!badItem) return;
  if (typeof badItem === "object" && badItem !== null && "type" in badItem && typeof badItem.type === "string") {
    throw new Error(`Docs-only benchmark used a disallowed Codex item: ${badItem.type}`);
  }
  throw new Error("Docs-only benchmark used a disallowed Codex item");
}

async function runClaudeAnswer(
  options: BenchmarkOptions,
  question: string,
  workspace: Workspace,
): Promise<{ sessionId: string; answerText: string; commands: string[] }> {
  const toolUses: ToolUse[] = [];
  const postToolUseHook = makePostToolUseRecorder(toolUses);
  let sessionId = "";
  let answerText = "";

  for await (const message of query({
    prompt: benchmarkPrompt(question),
    options: {
      model: options.claudeModel ?? "claude-opus-4-7[1m]",
      betas: ["context-1m-2025-08-07"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      tools: { type: "preset", preset: "claude_code" },
      cwd: workspace.root,
      maxTurns: 30,
      hooks: {
        PostToolUse: [{ hooks: [postToolUseHook] }],
      },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: benchmarkInstruction("claude", workspace.claudeBrowseScript, options.minDocDrillCalls),
      },
    },
  })) {
    if (message.type === "system" && message.subtype === "init") {
      sessionId = message.session_id;
    } else if (message.type === "assistant") {
      // Only keep the latest assistant message — earlier ones are intermediate narration
      const texts: string[] = [];
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim().length > 0) {
          texts.push(block.text);
        }
      }
      if (texts.length > 0) answerText = texts.join("");
    } else if (message.type === "result") {
      sessionId = message.session_id;
      if (message.subtype !== "success") {
        throw new Error(`Claude benchmark answer failed: ${message.subtype}`);
      }
    }
  }

  const commands = toolUses.map((toolUse) => toolUse.command).filter((command) => command.length > 0);
  validateClaudeToolUses(toolUses, workspace.claudeBrowseScript, options.repoPath, options.minDocDrillCalls);
  if (!sessionId) throw new Error("Claude answer returned no session id");
  if (!answerText.trim()) throw new Error("Claude answer returned no text");
  return { sessionId, answerText, commands };
}

function makePostToolUseRecorder(toolUses: ToolUse[]): HookCallback {
  return async (input) => {
    if ("tool_name" in input) {
      toolUses.push({
        toolName: input.tool_name,
        command: commandFromToolInput(input.tool_input),
      });
    }
    const hookSpecificOutput: PostToolUseHookSpecificOutput = { hookEventName: "PostToolUse" };
    const output: SyncHookJSONOutput = { hookSpecificOutput };
    return output;
  };
}

function commandFromToolInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  if (!("command" in input)) return "";
  return typeof input.command === "string" ? input.command : "";
}

function commandFromCodexItem(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  if (!("type" in item) || item.type !== "command_execution") return undefined;
  if (!("command" in item) || typeof item.command !== "string") return undefined;
  return item.command;
}

const ALLOWED_CLAUDE_TOOLS = new Set(["Bash", "Read"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

function validateClaudeToolUses(
  toolUses: ToolUse[],
  browseScript: string,
  repoPath: string,
  minDocDrillCalls: number,
): void {
  for (const toolUse of toolUses) {
    if (WRITE_TOOLS.has(toolUse.toolName)) {
      throw new Error(`Docs-only benchmark used a write tool: ${toolUse.toolName}`);
    }
    if (!ALLOWED_CLAUDE_TOOLS.has(toolUse.toolName)) {
      throw new Error(`Docs-only benchmark used disallowed tool: ${toolUse.toolName}`);
    }
  }
  const commands = toolUses
    .filter((toolUse) => toolUse.toolName === "Bash")
    .map((toolUse) => toolUse.command)
    .filter((command) => command.length > 0);
  validateDocDrillUsage(commands, browseScript, repoPath, minDocDrillCalls);
}

function validateDocDrillUsage(
  commands: string[],
  browseScript: string,
  repoPath: string,
  minDocDrillCalls: number,
): void {
  const resolvedRepoPath = path.resolve(repoPath) + path.sep;
  for (const command of commands) {
    if (!isDocDrillCommand(command, browseScript)) {
      throw new Error(`Docs-only benchmark used a non-doc-drill command: ${command}`);
    }
    if (referencesPath(command, resolvedRepoPath)) {
      throw new Error(`Docs-only benchmark accessed source repo: ${command}`);
    }
  }
  const callCount = commands.length;
  if (callCount < minDocDrillCalls) {
    throw new Error(`Expected at least ${minDocDrillCalls} doc-drill calls, got ${callCount}`);
  }
}

function referencesPath(command: string, resolvedDir: string): boolean {
  const tokens = command.split(/\s+/);
  return tokens.some((token) => {
    try {
      const resolved = path.resolve(token);
      return resolved.startsWith(resolvedDir) || resolved === resolvedDir.slice(0, -1);
    } catch {
      return false;
    }
  });
}

function isDocDrillCommand(command: string, browseScript: string): boolean {
  const localCodexScript = ".codex/skills/doc-drill/scripts/browse.mjs";
  const localClaudeScript = ".claude/skills/doc-drill/scripts/browse.mjs";
  return command.includes("node ")
    && (
      command.includes(browseScript)
      || command.includes(localCodexScript)
      || command.includes(localClaudeScript)
    );
}

async function writeBenchmarkFile(filePath: string, data: BenchmarkFile): Promise<void> {
  const parsed = BenchmarkFile.parse(data);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
}

function ensureQuestionRecord(data: BenchmarkFile, item: GeneratedInputItem): z.infer<typeof BenchmarkQuestionRecord> {
  const existing = data.questions.find((record) => record.questionId === item.id);
  if (existing) return existing;
  const record = {
    questionId: item.id,
    generator: item.generator,
    question: item.question,
    answers: [],
  };
  data.questions.push(record);
  return record;
}

async function runOneAnswer(
  options: BenchmarkOptions,
  item: GeneratedInputItem,
  provider: Provider,
  workspace: Workspace,
): Promise<z.infer<typeof BenchmarkAnswerRecord>> {
  try {
    const result = provider === "codex"
      ? await runCodexAnswer(options, item.question, workspace)
      : await runClaudeAnswer(options, item.question, workspace);
    const browseScript = provider === "codex" ? workspace.codexBrowseScript : workspace.claudeBrowseScript;

    return {
      provider,
      status: "success",
      sessionId: result.sessionId,
      docDrillCallCount: result.commands.filter((command) => isDocDrillCommand(command, browseScript)).length,
      commands: result.commands,
      answerText: result.answerText,
      completedAt: new Date().toISOString(),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      provider,
      status: "error",
      docDrillCallCount: 0,
      commands: [],
      error: message,
      completedAt: new Date().toISOString(),
    };
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await assertDirectory(options.docRoot, "Documentation root");
  const repoInfo = await stat(options.repoPath).catch(() => undefined);
  if (!repoInfo?.isDirectory()) {
    console.warn(`Repository path is unavailable for violation checks: ${options.repoPath}`);
  }

  const inputFile = options.inputFile ?? await findLatestGeneratedFile(options);
  await assertFile(inputFile, "Generated QA input");
  const generated = await readGeneratedFile(inputFile);
  const project = generated.project;
  await assertFile(path.join(options.docRoot, project, "top.json"), "Project top.json");
  const selected = selectQuestions(generated, options);
  const workspace = await prepareWorkspace(options, project);
  const now = new Date().toISOString();
  const outputFile = path.join(path.dirname(inputFile), "qa.benchmark.json");
  const data: BenchmarkFile = {
    schemaVersion: 1,
    generatedRunId: generated.runId,
    project,
    inputFile,
    workspaceRoot: workspace.root,
    docRoot: workspace.docRoot,
    createdAt: now,
    updatedAt: now,
    answerProviders: options.answerProviders,
    minDocDrillCalls: options.minDocDrillCalls,
    questions: [],
  };
  await writeBenchmarkFile(outputFile, data);

  for (const item of selected) {
    const record = ensureQuestionRecord(data, item);
    for (const provider of options.answerProviders) {
      console.log(`[${provider}] answering ${item.id}`);
      const answer = await runOneAnswer(options, item, provider, workspace);
      record.answers.push(answer);
      data.updatedAt = new Date().toISOString();
      await writeBenchmarkFile(outputFile, data);
      console.log(`[${provider}] wrote partial benchmark output: ${outputFile}`);
    }
  }

  console.log(`Benchmark output written to ${outputFile}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
