import "dotenv/config";

import { query } from "@anthropic-ai/claude-agent-sdk";
import { Codex } from "@openai/codex-sdk";
import { z } from "zod";
import { RawJudgeOutput, type AgentMetrics, type Language, type Provider, type Variant } from "./schemas.ts";
import { getVerifierInstruction, getJudgeInstruction } from "./instructions.ts";

export interface AgentResult {
  sessionId: string;
  text: string;
  metrics: AgentMetrics;
}

// ---------------------------------------------------------------------------
// AnswerVerifier — text mode, full access
// ---------------------------------------------------------------------------

export async function runAnswerVerifier(opts: {
  provider: Provider;
  variant: Variant;
  language: Language;
  prompt: string;
  workdir: string;
}): Promise<AgentResult> {
  const instruction = getVerifierInstruction(opts.variant, opts.language);
  return opts.provider === "claude"
    ? runClaudeText(instruction, opts.prompt, opts.workdir)
    : runCodexText(instruction, opts.prompt, opts.workdir);
}

// ---------------------------------------------------------------------------
// AnswerJudge — structured output, no tools
// ---------------------------------------------------------------------------

const judgeJsonSchema = toJsonSchema(RawJudgeOutput);

export async function runAnswerJudge(opts: {
  provider: Provider;
  language: Language;
  prompt: string;
  workdir: string;
}): Promise<AgentResult> {
  const instruction = getJudgeInstruction(opts.language);
  return opts.provider === "claude"
    ? runClaudeStructured(instruction, opts.prompt, opts.workdir, judgeJsonSchema)
    : runCodexStructured(instruction, opts.prompt, opts.workdir, judgeJsonSchema);
}

// ---------------------------------------------------------------------------
// Claude implementations
// ---------------------------------------------------------------------------

async function runClaudeText(
  instruction: string,
  prompt: string,
  workdir: string,
): Promise<AgentResult> {
  let sessionId = "";
  let result = "";
  let metrics: AgentMetrics = {};
  const toolCounts: Record<string, number> = {};

  for await (const msg of query({
    prompt,
    options: {
      model: "claude-sonnet-4-6",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      tools: { type: "preset", preset: "claude_code" },
      allowedTools: ["Bash", "Read", "Glob", "Grep", "Edit", "Write"],
      cwd: workdir,
      systemPrompt: { type: "preset", preset: "claude_code", append: instruction },
    },
  })) {
    if (msg.type === "system" && msg.subtype === "init") {
      sessionId = msg.session_id;
    }
    if (msg.type === "assistant") {
      countClaudeToolUse(msg, toolCounts);
    }
    if (msg.type === "result") {
      sessionId = msg.session_id;
      if (msg.subtype === "success") {
        result = msg.result;
        metrics = extractClaudeMetrics(msg, toolCounts);
      } else {
        throw new Error(`Claude verifier failed: ${msg.subtype}`);
      }
    }
  }

  if (!result) throw new Error("Claude verifier returned no result");
  return { sessionId, text: result, metrics };
}

async function runClaudeStructured(
  instruction: string,
  prompt: string,
  workdir: string,
  schema: Record<string, unknown>,
): Promise<AgentResult> {
  let sessionId = "";
  let result = "";
  let metrics: AgentMetrics = {};

  for await (const msg of query({
    prompt,
    options: {
      model: "claude-sonnet-4-6",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      tools: { type: "preset", preset: "claude_code" },
      allowedTools: [],
      cwd: workdir,
      outputFormat: { type: "json_schema", schema },
      systemPrompt: { type: "preset", preset: "claude_code", append: instruction },
    },
  })) {
    if (msg.type === "system" && msg.subtype === "init") {
      sessionId = msg.session_id;
    }
    if (msg.type === "result") {
      sessionId = msg.session_id;
      if (msg.subtype === "success") {
        result = JSON.stringify(msg.structured_output);
        metrics = extractClaudeMetrics(msg, {});
      } else {
        throw new Error(`Claude judge failed: ${msg.subtype}`);
      }
    }
  }

  if (!result) throw new Error("Claude judge returned no result");
  return { sessionId, text: result, metrics };
}

function countClaudeToolUse(msg: unknown, counts: Record<string, number>): void {
  const rec = msg as Record<string, unknown>;
  const betaMsg = rec.message;
  if (!betaMsg || typeof betaMsg !== "object") return;
  const content = (betaMsg as Record<string, unknown>).content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "tool_use") continue;
    const name = typeof b.name === "string" ? b.name : "tool_use";
    counts[name] = (counts[name] ?? 0) + 1;
  }
}

function extractClaudeMetrics(
  msg: Record<string, unknown>,
  toolCounts: Record<string, number>,
): AgentMetrics {
  const usage = msg.usage as Record<string, unknown> | undefined;
  const inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined;
  const outputTokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : undefined;
  const cachedInputTokens = typeof usage?.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : undefined;
  const cacheCreationInputTokens = typeof usage?.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : undefined;
  const details = usage?.output_tokens_details as Record<string, unknown> | undefined;
  const reasoningOutputTokens = typeof details?.thinking_tokens === "number" ? details.thinking_tokens : undefined;
  const total = Object.values(toolCounts).reduce((s, n) => s + n, 0);
  return {
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens != null && outputTokens != null ? inputTokens + outputTokens : undefined,
    costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined,
    durationMs: typeof msg.duration_ms === "number" ? msg.duration_ms : undefined,
    turns: typeof msg.num_turns === "number" ? msg.num_turns : undefined,
    toolCalls: total > 0 ? toolCounts : undefined,
  };
}

// ---------------------------------------------------------------------------
// Codex implementations
// ---------------------------------------------------------------------------

async function runCodexText(
  instruction: string,
  prompt: string,
  workdir: string,
): Promise<AgentResult> {
  const codex = new Codex({ config: { developer_instructions: instruction } });
  const thread = codex.startThread({
    workingDirectory: workdir,
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    modelReasoningEffort: "xhigh",
  });

  const turn = await thread.run(prompt);
  const threadId = thread.id;
  if (!threadId) throw new Error("Codex thread has no ID");

  return {
    sessionId: threadId,
    text: turn.finalResponse,
    metrics: extractCodexMetrics(turn),
  };
}

async function runCodexStructured(
  instruction: string,
  prompt: string,
  workdir: string,
  schema: Record<string, unknown>,
): Promise<AgentResult> {
  const codex = new Codex({ config: { developer_instructions: instruction } });
  const thread = codex.startThread({
    workingDirectory: workdir,
    skipGitRepoCheck: true,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    modelReasoningEffort: "high",
  });

  const turn = await thread.run(prompt, { outputSchema: schema });
  const threadId = thread.id;
  if (!threadId) throw new Error("Codex thread has no ID");

  return {
    sessionId: threadId,
    text: turn.finalResponse,
    metrics: extractCodexMetrics(turn),
  };
}

function extractCodexMetrics(turn: { items: Array<Record<string, unknown>>; usage: Record<string, number> | null }): AgentMetrics {
  const toolCounts: Record<string, number> = {};
  for (const item of turn.items) {
    if (item.type === "command_execution") {
      toolCounts.command_execution = (toolCounts.command_execution ?? 0) + 1;
    } else if (item.type === "mcp_tool_call") {
      const key = `mcp:${item.server}/${item.tool}`;
      toolCounts[key] = (toolCounts[key] ?? 0) + 1;
    } else if (item.type === "web_search") {
      toolCounts.web_search = (toolCounts.web_search ?? 0) + 1;
    }
  }

  const total = Object.values(toolCounts).reduce((s, n) => s + n, 0);
  const u = turn.usage;
  return {
    inputTokens: u?.input_tokens,
    cachedInputTokens: u?.cached_input_tokens,
    outputTokens: u?.output_tokens,
    reasoningOutputTokens: u?.reasoning_output_tokens,
    totalTokens: u ? u.input_tokens + u.output_tokens : undefined,
    toolCalls: total > 0 ? toolCounts : undefined,
  };
}

// ---------------------------------------------------------------------------
// Zod → JSON Schema helper
// ---------------------------------------------------------------------------

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}
