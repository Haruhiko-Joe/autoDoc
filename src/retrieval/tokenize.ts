// Hybrid tokenizer for English + CJK retrieval over graph node names,
// descriptions, codeScope paths, and markdown bodies.
//
// English: lowercase + Unicode word split + stopword filter (min len 2).
// CJK:     overlapping bigrams (the standard recall-oriented fallback
//          when no segmenter is available, and avoids adding a runtime dep).
// Mixed:   both strategies applied per Unicode segment.

const STOPWORDS_EN = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "to", "of", "in", "on", "at", "for", "and", "or", "not", "no", "nor",
  "it", "this", "that", "these", "those", "i", "you", "we", "they",
  "he", "she", "from", "by", "with", "as", "if", "but", "do", "does",
  "did", "have", "has", "had", "will", "would", "can", "could", "should",
  "may", "might", "must", "shall", "there", "here", "when", "where",
  "what", "which", "who", "how", "why", "about", "into", "over", "under",
  "out", "up", "down", "just", "only", "also", "very", "so", "too",
  "than", "then", "now", "your", "our", "their", "my", "me", "us", "them",
  "him", "her", "its", "any", "all", "some", "each", "every", "more",
  "most", "less", "few", "other", "own", "same", "such", "both", "either",
]);

const STOPWORDS_ZH = new Set([
  "的", "了", "和", "在", "是", "有", "这", "那", "上", "下",
  "为", "与", "及", "或", "等", "就", "到", "对", "也", "而",
  "把", "被", "让", "说", "你", "我", "他", "她", "它", "的话",
  "这个", "那个", "这些", "那些", "什么", "怎么", "哪里", "哪个",
  "可以", "能", "将", "应该", "需要", "要", "不", "没", "会", "去",
  "来", "使", "做", "用", "给", "过", "从", "向", "以", "之", "其",
  "一个", "一种", "一些", "如果", "因为", "所以", "但是", "然后",
]);

const CJK_RE = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const CJK_SPAN_RE = /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+/g;

function hasCjk(s: string): boolean {
  return CJK_RE.test(s);
}

function cjkBigrams(span: string, out: string[]): void {
  if (span.length === 1) {
    if (!STOPWORDS_ZH.has(span)) out.push(span);
    return;
  }
  for (let i = 0; i + 2 <= span.length; i++) {
    const bi = span.slice(i, i + 2);
    if (!STOPWORDS_ZH.has(bi)) out.push(bi);
  }
}

// camelCase split needs the original (cased) span, so this function accepts
// the raw segment and handles lowercasing + stopword filtering internally.
function asciiWords(segment: string, out: string[]): void {
  const matches = segment.match(/[A-Za-z0-9][A-Za-z0-9_-]*/g);
  if (!matches) return;
  for (const m of matches) {
    const whole = m.toLowerCase();
    if (whole.length >= 2 && !STOPWORDS_EN.has(whole)) out.push(whole);
    // Split camelCase / snake_case / kebab-case into constituent tokens
    // e.g. "docRetriever" -> ["doc", "retriever"], "build_chat_context" -> ["build", "chat", "context"].
    const pieces = m
      .split(/[-_]/)
      .flatMap((p) => p.replace(/([a-z])([A-Z])/g, "$1 $2").split(/\s+/));
    if (pieces.length > 1) {
      for (const p of pieces) {
        const pl = p.toLowerCase();
        if (pl.length >= 2 && pl !== whole && !STOPWORDS_EN.has(pl)) out.push(pl);
      }
    }
  }
}

export function tokenize(input: string | string[] | undefined | null): string[] {
  if (input == null) return [];
  const text = Array.isArray(input) ? input.join(" ") : String(input);
  if (!text) return [];

  const out: string[] = [];

  if (hasCjk(text)) {
    for (const match of text.matchAll(CJK_SPAN_RE)) {
      cjkBigrams(match[0], out);
    }
    // Strip CJK spans, then tokenize the ASCII remainder (case-preserving).
    const asciiOnly = text.replace(CJK_SPAN_RE, " ");
    asciiWords(asciiOnly, out);
  } else {
    asciiWords(text, out);
  }

  return out;
}

export function uniqueTokens(input: string | string[] | undefined | null): string[] {
  return Array.from(new Set(tokenize(input)));
}
