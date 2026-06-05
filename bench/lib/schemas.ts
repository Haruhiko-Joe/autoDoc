import { z } from "zod";

export const Provider = z.enum(["codex", "claude"]);
export const Language = z.enum(["zh", "en"]);
export const Variant = z.enum(["full", "no-edges", "flat-md"]);

export type Provider = z.infer<typeof Provider>;
export type Language = z.infer<typeof Language>;
export type Variant = z.infer<typeof Variant>;

export const AgentMetrics = z.object({
  inputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  cacheCreationInputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  reasoningOutputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  costUsd: z.number().optional(),
  durationMs: z.number().optional(),
  turns: z.number().optional(),
  toolCalls: z.record(z.string(), z.number()).optional(),
});

export type AgentMetrics = z.infer<typeof AgentMetrics>;

export const JudgePointResult = z.object({
  point: z.string(),
  weight: z.number(),
  covered: z.boolean(),
  rationale: z.string(),
});

export const JudgeOutput = z.object({
  score: z.number().min(0),
  maxScore: z.number().min(0),
  normalizedScore: z.number().min(0).max(1),
  verdict: z.enum(["excellent", "good", "partial", "poor"]),
  scoringPointResults: z.array(JudgePointResult),
  judgeSummary: z.string(),
});

export type JudgeOutput = z.infer<typeof JudgeOutput>;

export const ValidationAnswer = z.object({
  provider: Provider,
  sessionId: z.string(),
  text: z.string(),
  metrics: AgentMetrics.optional(),
});

export const ValidationJudge = z.object({
  provider: Provider,
  sessionId: z.string(),
  output: JudgeOutput,
  metrics: AgentMetrics.optional(),
});

export const ValidationItem = z.object({
  itemId: z.string(),
  question: z.string(),
  category: z.string(),
  status: z.enum(["done", "error"]),
  startedAt: z.string(),
  completedAt: z.string(),
  answer: ValidationAnswer.optional(),
  judge: ValidationJudge.optional(),
  error: z.string().optional(),
});

export type ValidationItem = z.infer<typeof ValidationItem>;

export const ValidationFile = z.object({
  schemaVersion: z.literal(2),
  project: z.string(),
  docVariant: Variant,
  workdir: z.string(),
  language: Language,
  answerProvider: Provider,
  judgeProvider: Provider,
  createdAt: z.string(),
  updatedAt: z.string(),
  itemCount: z.number().int().min(0),
  completedCount: z.number().int().min(0),
  averageScore: z.number().nullable(),
  results: z.array(ValidationItem),
});

export type ValidationFile = z.infer<typeof ValidationFile>;

export const ScoringPoint = z.object({
  point: z.string(),
  weight: z.number().int().min(1),
});

export const QaItem = z.object({
  id: z.string(),
  generator: z.string(),
  question: z.string(),
  goldAnswer: z.string(),
  scoringPoints: z.array(ScoringPoint),
  category: z.string(),
});

export type QaItem = z.infer<typeof QaItem>;

export const QaFile = z.object({
  schemaVersion: z.number(),
  project: z.string(),
  runId: z.string().optional(),
  language: Language,
  createdAt: z.string(),
  items: z.array(QaItem),
});

export type QaFile = z.infer<typeof QaFile>;
