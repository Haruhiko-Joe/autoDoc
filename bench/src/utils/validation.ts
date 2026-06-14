import type { ValidationItem, ValidationJudge, ValidationSummary } from '../services/api'

const providerOrder = ['claude', 'codex']

export function judgesFor(item: ValidationItem | undefined): ValidationJudge[] {
  if (!item) return []
  const byProvider = new Map<string, ValidationJudge>()
  for (const judge of item.judges ?? []) byProvider.set(judge.provider, judge)
  if (item.judge) byProvider.set(item.judge.provider, item.judge)
  return [...byProvider.values()].sort((a, b) => providerRank(a.provider) - providerRank(b.provider))
}

export function judgeFor(item: ValidationItem | undefined, provider?: string): ValidationJudge | undefined {
  const judges = judgesFor(item)
  if (provider) return judges.find(judge => judge.provider === provider) ?? judges[0]
  return judges[0]
}

export function scoreFor(item: ValidationItem | undefined, provider?: string): number | null | undefined {
  return judgeFor(item, provider)?.output.normalizedScore
}

export function providerList(summary: Pick<ValidationSummary, 'judgeProvider' | 'judgeProviders'> | undefined): string[] {
  if (!summary) return []
  const providers = summary.judgeProviders?.length ? summary.judgeProviders : (summary.judgeProvider ? [summary.judgeProvider] : [])
  return [...new Set(providers)].sort((a, b) => providerRank(a) - providerRank(b))
}

export function summaryScore(summary: ValidationSummary | undefined, provider?: string): number | null | undefined {
  if (!summary) return undefined
  if (provider && summary.averageScores && provider in summary.averageScores) return summary.averageScores[provider]
  return summary.averageScore
}

export function summaryScoreText(summary: ValidationSummary | undefined, percent: (value: number | null | undefined) => string): string {
  if (!summary) return '-'
  const providers = providerList(summary)
  if (providers.length <= 1) return percent(summaryScore(summary, providers[0]))
  return providers.map(provider => `${provider} ${percent(summaryScore(summary, provider))}`).join(' / ')
}

function providerRank(provider: string): number {
  const rank = providerOrder.indexOf(provider)
  return rank === -1 ? 99 : rank
}
