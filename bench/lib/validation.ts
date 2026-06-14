import type { Provider, ValidationFile, ValidationItem, ValidationJudge } from "./schemas.ts";

const providerRank: Record<Provider, number> = { claude: 0, codex: 1 };

export function judgesFor(item: ValidationItem): ValidationJudge[] {
  const byProvider = new Map<Provider, ValidationJudge>();
  for (const judge of item.judges ?? []) byProvider.set(judge.provider, judge);
  if (item.judge) byProvider.set(item.judge.provider, item.judge);
  return [...byProvider.values()].sort((a, b) => providerRank[a.provider] - providerRank[b.provider]);
}

export function judgeFor(item: ValidationItem, provider: Provider): ValidationJudge | undefined {
  return judgesFor(item).find((judge) => judge.provider === provider);
}

export function upsertJudge(item: ValidationItem, judge: ValidationJudge): void {
  const next = judgesFor(item).filter((existing) => existing.provider !== judge.provider);
  next.push(judge);
  item.judges = next.sort((a, b) => providerRank[a.provider] - providerRank[b.provider]);
  item.judge = judge;
}

export function normalizeValidationItem(item: ValidationItem): ValidationItem {
  const judges = judgesFor(item);
  if (judges.length > 0) {
    item.judges = judges;
    item.judge ??= judges[0];
  }
  return item;
}

export function normalizeValidationFile(data: ValidationFile): ValidationFile {
  data.results = data.results.map(normalizeValidationItem);
  data.judgeProviders = data.judgeProviders?.length ? data.judgeProviders : judgeProvidersFor(data.results);
  return data;
}

export function judgeProvidersFor(results: ValidationItem[]): Provider[] {
  const providers = new Set<Provider>();
  for (const item of results) {
    for (const judge of judgesFor(item)) providers.add(judge.provider);
  }
  return [...providers].sort((a, b) => providerRank[a] - providerRank[b]);
}

export function averageScore(results: ValidationItem[], provider: Provider): number | null {
  const judged = results
    .filter((item) => item.status === "done")
    .map((item) => judgeFor(item, provider))
    .filter((judge): judge is ValidationJudge => Boolean(judge));
  if (judged.length === 0) return null;
  const sum = judged.reduce((score, judge) => score + judge.output.normalizedScore, 0);
  return Number((sum / judged.length).toFixed(4));
}

export function averageScores(results: ValidationItem[]): Record<string, number | null> {
  return Object.fromEntries(
    judgeProvidersFor(results).map((provider) => [provider, averageScore(results, provider)]),
  );
}

export function syncValidationStats(data: ValidationFile): void {
  normalizeValidationFile(data);
  data.completedCount = data.results.filter((item) => item.status === "done").length;
  data.judgeProviders = judgeProvidersFor(data.results);
  if (!data.judgeProviders.includes(data.judgeProvider)) data.judgeProviders.unshift(data.judgeProvider);
  data.averageScores = averageScores(data.results);
  data.averageScore = averageScore(data.results, data.judgeProvider);
  data.updatedAt = new Date().toISOString();
}
