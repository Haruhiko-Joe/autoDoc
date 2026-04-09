# DataPrimitives

## Overview & Responsibilities

DataPrimitives is a collection of low-level data manipulation utilities within the **Infrastructure > CoreUtilities** layer. These modules provide foundational operations — hashing, UUID generation, string manipulation, collection helpers, internationalization, and word generation — that are consumed extensively across the entire Claude Code codebase. They have no dependencies on higher-level application logic and are designed for performance (several are annotated as "hot" code paths).

The module spans eight files:

| File | Purpose |
|------|---------|
| `src/utils/hash.ts` | Content hashing (djb2, SHA-256, Bun.hash) |
| `src/utils/crypto.ts` | Re-exports `randomUUID` from Node's `crypto` |
| `src/utils/uuid.ts` | UUID validation and agent ID generation |
| `src/utils/stringUtils.ts` | String manipulation, truncation, and safe accumulation |
| `src/utils/array.ts` | Array helpers (intersperse, count, dedup) |
| `src/utils/set.ts` | Set algebra (union, intersection, difference, subset) |
| `src/utils/intl.ts` | Cached `Intl` objects for segmentation, formatting, locale |
| `src/utils/words.ts` | Random word slug generator for plan IDs |

## Key Processes

### Hashing: Runtime-Adaptive Strategy

The hashing utilities implement a dual-runtime strategy. When running under Bun, they use `Bun.hash` (wyhash, ~100x faster than SHA-256). When running under Node.js, they fall back to `crypto.createHash('sha256')`. This branching happens at call time via `typeof Bun !== 'undefined'` checks.

1. **`hashContent(content)`** — hashes a single string for change detection (e.g., diffing file contents). Returns `Bun.hash(...).toString()` or a hex SHA-256 digest (`src/utils/hash.ts:19-26`).
2. **`hashPair(a, b)`** — hashes two strings without concatenating them into a temporary. Under Bun, it seed-chains wyhash (`hash(b, hash(a))`), which naturally disambiguates `("ts","code")` from `("tsc","ode")`. Under Node, it uses an incremental SHA-256 with a null-byte separator (`src/utils/hash.ts:34-46`).
3. **`djb2Hash(str)`** — a pure-JS, deterministic, non-cryptographic hash returning a signed 32-bit integer. Used when output must be stable across runtime upgrades (e.g., cache directory naming) (`src/utils/hash.ts:7-13`).

### Safe String Accumulation

`EndTruncatingAccumulator` (`src/utils/stringUtils.ts:140-220`) is a class designed to safely accumulate large shell output without blowing up RSS. It enforces a configurable size limit (default 2^25 = ~33MB) and silently discards excess data, appending a `[output truncated - NKB removed]` marker on `toString()`. This is used by `ShellCommand` to cap in-memory output before disk spillover kicks in.

### Intl Object Caching

`Intl` constructors are expensive (~0.05–0.1ms each). The `intl.ts` module lazily creates and caches singleton instances of `Intl.Segmenter` (grapheme and word granularity), `Intl.RelativeTimeFormat` (keyed by `style:numeric`), and resolved timezone/locale values. This avoids repeated allocations in hot rendering paths (`src/utils/intl.ts:10-94`).

### Word Slug Generation

`words.ts` provides a whimsical random slug generator used for plan IDs. It picks from curated word lists (232 adjectives, 414 nouns, 110 verbs — themed around nature, creatures, programming concepts, and computer scientists) using `crypto.randomBytes` for selection. Two formats are available:
- **`generateWordSlug()`** → `"adjective-verb-noun"` (e.g., `"cosmic-pondering-lighthouse"`)
- **`generateShortWordSlug()`** → `"adjective-noun"` (e.g., `"graceful-unicorn"`)

## Function Signatures

### hash.ts

#### `djb2Hash(str: string): number`
Fast non-cryptographic hash. Returns a signed 32-bit integer. Deterministic across runtimes.

#### `hashContent(content: string): string`
Hashes a string for change detection. Returns a numeric string (Bun) or hex SHA-256 digest (Node).

#### `hashPair(a: string, b: string): string`
Hashes two strings without concatenation. Uses seed-chaining under Bun, null-byte separator under Node.

### crypto.ts

#### `randomUUID(): string`
Re-exports Node's `crypto.randomUUID`. Exists as an indirection point so Bun's browser build can swap in a polyfill-free alternative via the `"browser"` field in `package.json`.

### uuid.ts

#### `validateUuid(maybeUuid: unknown): UUID | null`
Validates a value against the standard UUID regex (`8-4-4-4-12` hex pattern). Returns the typed `UUID` or `null`.

#### `createAgentId(label?: string): AgentId`
Generates an agent ID with format `a{label-}{16 hex chars}` using `crypto.randomBytes(8)`. Examples: `"aa3f2c1b4d5e6f7a8"`, `"acompact-a3f2c1b4d5e6f7a8"`.

### stringUtils.ts

#### `escapeRegExp(str: string): string`
Escapes regex special characters so `str` can be used as a literal pattern in `new RegExp(...)`.

#### `capitalize(str: string): string`
Uppercases the first character only. Unlike lodash's `capitalize`, does **not** lowercase the rest.

#### `plural(n: number, word: string, pluralWord?: string): string`
Returns singular form when `n === 1`, plural otherwise. Defaults to appending `'s'`; custom plural form supported via third argument.

#### `firstLineOf(s: string): string`
Returns text before the first `\n` without allocating a split array.

#### `countCharInString(str, char, start?): number`
Counts occurrences of a single character via `indexOf` jumps. Accepts anything with an `indexOf` method (including `Buffer`).

#### `normalizeFullWidthDigits(input: string): string`
Converts full-width (zenkaku) digits `０-９` to ASCII `0-9` for CJK IME input.

#### `normalizeFullWidthSpace(input: string): string`
Converts full-width space `U+3000` to ASCII space `U+0020`.

#### `safeJoinLines(lines, delimiter?, maxSize?): string`
Joins strings with a delimiter, truncating with `"...[truncated]"` if the result exceeds `maxSize` (default 2^25).

#### `truncateToLines(text: string, maxLines: number): string`
Keeps the first `maxLines` lines, appending `'…'` if truncated.

### array.ts

#### `intersperse<A>(as: A[], separator: (index: number) => A): A[]`
Inserts separator elements between array items. The separator function receives the current index, enabling index-dependent separators.

#### `count<T>(arr: readonly T[], pred: (x: T) => unknown): number`
Counts elements matching a predicate without allocating a filtered array.

#### `uniq<T>(xs: Iterable<T>): T[]`
Deduplicates via `new Set(...)`, returning a new array.

### set.ts

All set operations are marked as hot-path code, optimized with manual iteration instead of spread/filter patterns.

#### `difference<A>(a: Set<A>, b: Set<A>): Set<A>`
Returns elements in `a` that are not in `b`.

#### `intersects<A>(a: Set<A>, b: Set<A>): boolean`
Returns `true` if the two sets share at least one element. Short-circuits on first match or if either set is empty.

#### `every<A>(a: ReadonlySet<A>, b: ReadonlySet<A>): boolean`
Returns `true` if every element of `a` is also in `b` (i.e., `a ⊆ b`).

#### `union<A>(a: Set<A>, b: Set<A>): Set<A>`
Returns a new set containing all elements from both sets.

### intl.ts

#### `getGraphemeSegmenter(): Intl.Segmenter`
Returns a cached grapheme-granularity segmenter.

#### `firstGrapheme(text: string): string`
Extracts the first grapheme cluster (handles multi-codepoint characters like emoji).

#### `lastGrapheme(text: string): string`
Extracts the last grapheme cluster.

#### `getWordSegmenter(): Intl.Segmenter`
Returns a cached word-granularity segmenter.

#### `getRelativeTimeFormat(style, numeric): Intl.RelativeTimeFormat`
Returns a cached `RelativeTimeFormat` for English, keyed by `style` (`'long'|'short'|'narrow'`) and `numeric` (`'always'|'auto'`).

#### `getTimeZone(): string`
Returns the system timezone string (e.g., `"America/New_York"`), cached for the process lifetime.

#### `getSystemLocaleLanguage(): string | undefined`
Returns the BCP 47 language subtag (e.g., `"en"`, `"ja"`). Returns `undefined` in stripped-ICU environments. Cached after first call.

### words.ts

#### `generateWordSlug(): string`
Generates a three-word slug: `"adjective-verb-noun"`. Uses `crypto.randomBytes` for selection.

#### `generateShortWordSlug(): string`
Generates a two-word slug: `"adjective-noun"`.

## Class: EndTruncatingAccumulator

A string buffer that enforces a size cap, silently dropping data once the limit is reached.

| Member | Type | Description |
|--------|------|-------------|
| `constructor(maxSize?)` | — | Default limit: 2^25 (~33MB) |
| `append(data)` | `string \| Buffer → void` | Appends data; truncates if over limit |
| `toString()` | `→ string` | Returns content with truncation marker if truncated |
| `clear()` | `→ void` | Resets all state |
| `length` | `number` (getter) | Current accumulated size |
| `truncated` | `boolean` (getter) | Whether truncation has occurred |
| `totalBytes` | `number` (getter) | Total bytes received before truncation |

## Edge Cases & Caveats

- **`hashPair` disambiguation**: Under Node, a `\0` separator is inserted between `a` and `b` to prevent collision between `("ts","code")` and `("tsc","ode")`. Under Bun, seed-chaining provides this naturally. The two runtimes produce **different hash values** for the same input — do not persist hashes across runtimes.

- **`hashContent` output format differs by runtime**: Bun returns a numeric string; Node returns a hex string. Consumers should treat hashes as opaque.

- **`crypto.ts` re-export workaround**: A direct `export { randomUUID } from 'crypto'` re-export breaks under Bun's bytecode compilation, so an explicit import-then-export is used instead (`src/utils/crypto.ts:12-13`).

- **`capitalize` vs lodash**: Unlike `_.capitalize('fooBAR')` which returns `"Foobar"`, this function returns `"FooBAR"` — it only uppercases the first character.

- **`EndTruncatingAccumulator` is one-directional**: Once truncated, new data is silently dropped. There is no way to "un-truncate" or retrieve the dropped bytes.

- **`safeJoinLines` MAX_STRING_LENGTH** (`2^25`): This limit is chosen to keep in-memory accumulation modest. Overflow beyond this limit is expected to be spilled to disk by `ShellCommand`.

- **`intl.ts` locale caching**: `getSystemLocaleLanguage()` uses a three-state cache (`null` = uncomputed, `undefined` = unavailable, `string` = resolved) so that environments with stripped ICU data fail once rather than retrying on every call.

- **`words.ts` randomness**: Uses `crypto.randomBytes(4)` with modulo selection. The modulo introduces negligible bias given the small word list sizes relative to 2^32.

- **Set operations create new sets**: `difference`, `union` always return fresh `Set` instances; they never mutate their inputs.