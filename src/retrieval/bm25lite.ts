// Token-overlap scorer inspired by BM25 but without length normalization
// tuning knobs. For our corpus (well-written node names + descriptions +
// markdown bodies), a simpler sum of `(1 + log(1+tf)) * idf` matches well
// with empirical quality on small benchmarks and has zero configuration.

import { tokenize } from "./tokenize.js";

export interface RawDoc {
  id: string;
  fields: Record<string, string | string[] | undefined>;
}

export interface IndexedDoc {
  id: string;
  fieldTokens: Record<string, string[]>;
}

export interface Index {
  docs: IndexedDoc[];
  idf: Map<string, number>;
}

export function buildIndex(rawDocs: RawDoc[]): Index {
  const docs: IndexedDoc[] = rawDocs.map((d) => {
    const fieldTokens: Record<string, string[]> = {};
    for (const [field, value] of Object.entries(d.fields)) {
      if (value === undefined) continue;
      fieldTokens[field] = tokenize(value);
    }
    return { id: d.id, fieldTokens };
  });

  const df = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set<string>();
    for (const tokens of Object.values(doc.fieldTokens)) {
      for (const t of tokens) seen.add(t);
    }
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const N = Math.max(docs.length, 1);
  const idf = new Map<string, number>();
  for (const [t, dCount] of df) {
    // Okapi BM25 style IDF with +1 smoothing, floored at 0.
    idf.set(t, Math.max(0, Math.log((N - dCount + 0.5) / (dCount + 0.5) + 1)));
  }

  return { docs, idf };
}

export function scoreField(
  queryTokens: readonly string[],
  fieldTokens: readonly string[] | undefined,
  idf: Map<string, number>,
): number {
  if (!fieldTokens || fieldTokens.length === 0 || queryTokens.length === 0) return 0;

  const tf = new Map<string, number>();
  for (const t of fieldTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  const seen = new Set<string>();
  for (const qt of queryTokens) {
    if (seen.has(qt)) continue;
    seen.add(qt);
    const f = tf.get(qt);
    if (!f) continue;
    const i = idf.get(qt) ?? 0;
    if (i <= 0) continue;
    score += (1 + Math.log(1 + f)) * i;
  }
  return score;
}

export function buildSnippet(body: string, queryTokens: readonly string[], maxLen = 240): string {
  if (!body) return "";
  if (queryTokens.length === 0) return body.slice(0, maxLen);

  const lower = body.toLowerCase();
  // Find first occurrence of any query token
  let best = -1;
  for (const qt of queryTokens) {
    const idx = lower.indexOf(qt);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  if (best === -1) return body.slice(0, maxLen).trim();

  const start = Math.max(0, best - 60);
  const end = Math.min(body.length, start + maxLen);
  const ellipsisL = start > 0 ? "…" : "";
  const ellipsisR = end < body.length ? "…" : "";
  return (ellipsisL + body.slice(start, end).trim() + ellipsisR).replace(/\s+/g, " ");
}
