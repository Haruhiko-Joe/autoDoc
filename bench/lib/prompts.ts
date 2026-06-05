import type { Language } from "./schemas.ts";

export function buildVerifierPrompt(opts: {
  category: string;
  itemId: string;
  question: string;
}): string {
  return `Question (${opts.category}, id ${opts.itemId}):\n${opts.question}`;
}

export function buildJudgePrompt(opts: {
  language: Language;
  question: string;
  goldAnswer: string;
  scoringPoints: Array<{ point: string; weight: number }>;
  candidateAnswer: string;
}): string {
  const lang = opts.language === "zh" ? "Chinese" : "English";
  const pointsList = opts.scoringPoints
    .map((sp, i) => `${i + 1}. [max ${sp.weight}] ${sp.point}`)
    .join("\n");
  return [
    `Evaluate this candidate answer in ${lang}.`,
    "",
    "## Question",
    opts.question,
    "",
    "## Gold Answer",
    opts.goldAnswer,
    "",
    `## Scoring Points (${opts.scoringPoints.length} items)`,
    pointsList,
    "",
    "## Candidate Answer",
    opts.candidateAnswer,
  ].join("\n");
}
