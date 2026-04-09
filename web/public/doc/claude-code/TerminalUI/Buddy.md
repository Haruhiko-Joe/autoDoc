# Buddy — Companion Sprite System

## Overview & Responsibilities

The Buddy module implements a collectible companion character that lives in the terminal UI alongside the user's input. It is part of the **TerminalUI** layer, sitting beside the prompt input area and reacting to conversation events with speech bubbles and animations.

Each user gets a **deterministic** companion derived from a hash of their user ID — the species, rarity, eyes, hat, stats, and shininess are all seeded from this hash, meaning the same user always gets the same companion. The companion's "soul" (name and personality) is generated once and stored in config, while the visual traits ("bones") are re-derived on every read so they can never be faked by editing config.

The module is organized into six files:

| File | Role |
|------|------|
| `types.ts` | Core type definitions, rarity/species/eye/hat enums, weight tables |
| `companion.ts` | Deterministic companion generation from user ID via seeded PRNG |
| `sprites.ts` | ASCII art sprite definitions (18 species × 3 frames), rendering functions |
| `CompanionSprite.tsx` | React component for rendering the animated sprite + speech bubble in the terminal |
| `useBuddyNotification.tsx` | Startup teaser notification hook and feature-gate helpers |
| `prompt.ts` | System prompt attachment that introduces the companion to Claude |

## Key Processes

### Companion Generation Flow

1. `companionUserId()` resolves the current user's identity from global config — preferring the OAuth account UUID, falling back to `userID`, then `'anon'` (`src/buddy/companion.ts:119-122`)
2. `roll(userId)` hashes `userId + SALT` using FNV-1a (or `Bun.hash` when available), then seeds a **Mulberry32 PRNG** with the result (`src/buddy/companion.ts:107-113`)
3. The PRNG deterministically picks rarity (weighted roll), species, eye style, hat (common rarity gets no hat), shiny flag (1% chance), and stat distribution (`src/buddy/companion.ts:91-102`)
4. `getCompanion()` merges the deterministic "bones" with the stored "soul" (name + personality) from config. Bones are **never persisted** — they're regenerated each time, so species renames or array reordering can't break saved companions (`src/buddy/companion.ts:127-133`)
5. The roll result is cached in a module-level variable since the same userId is queried from multiple hot paths (sprite tick, prompt input, per-turn observer) (`src/buddy/companion.ts:106`)

### Rarity System

Rarity is rolled with weighted probabilities:

| Rarity | Weight | Stat Floor |
|--------|--------|-----------|
| common | 60 | 5 |
| uncommon | 25 | 15 |
| rare | 10 | 25 |
| epic | 4 | 35 |
| legendary | 1 | 50 |

Each companion gets 5 stats (DEBUGGING, PATIENCE, CHAOS, WISDOM, SNARK) with one peak stat, one dump stat, and the rest scattered. Higher rarity raises the stat floor (`src/buddy/companion.ts:62-82`).

### Sprite Rendering

Each of the 18 species has **3 animation frames** defined as 5-line, 12-character-wide ASCII art blocks in `sprites.ts`. The `{E}` placeholder in each frame is replaced with the companion's eye character at render time.

`renderSprite(bones, frame)` (`src/buddy/sprites.ts:454-469`):
1. Selects the frame from the species' body array (mod frame count)
2. Substitutes `{E}` placeholders with the companion's eye character
3. Overlays the hat on line 0 if the hat slot is empty (some frames use line 0 for effects like smoke or antenna)
4. Strips the blank hat row when all frames have an empty first line, to avoid wasting vertical space

`renderFace(bones)` (`src/buddy/sprites.ts:475-513`) produces a compact one-line face representation for narrow terminals (e.g., `=·ω·=` for a cat).

### Animation & Interaction (CompanionSprite.tsx)

The `CompanionSprite` React component drives the terminal rendering:

1. A **500ms tick timer** advances the animation state (`src/buddy/CompanionSprite.tsx:16`)
2. **Idle animation** follows a 15-step sequence mixing rest (frame 0), fidgets (frames 1-2), and blinks (eye replaced with `-`) (`src/buddy/CompanionSprite.tsx:23`)
3. **Reactions**: When `companionReaction` is set in app state, the sprite cycles all fidget frames rapidly and a `SpeechBubble` appears for ~10 seconds (20 ticks), fading over the last ~3 seconds (`src/buddy/CompanionSprite.tsx:17-18`)
4. **Petting**: The `/buddy pet` command sets `companionPetAt` in app state, triggering a 2.5-second burst of floating heart characters above the sprite (`src/buddy/CompanionSprite.tsx:19, 26-27`)
5. **Narrow terminal fallback**: Below 100 columns, the full sprite collapses to a single-line face + name/quip display (`src/buddy/CompanionSprite.tsx:152, 227-241`)
6. **Fullscreen mode**: The speech bubble renders separately via `CompanionFloatingBubble` in the fullscreen layout's `bottomFloat` slot (to avoid clipping by `overflowY:hidden`), while the sprite body renders inline (`src/buddy/CompanionSprite.tsx:283-285, 296`)

### Notification & Feature Gating

The buddy system is behind a `BUDDY` feature flag checked via `feature('BUDDY')` from `bun:bundle`. All entry points bail out early when the flag is off.

`useBuddyNotification()` (`src/buddy/useBuddyNotification.tsx:43-78`):
- During the **teaser window** (April 1–7, 2026, local time), if the user hasn't hatched a companion yet, a rainbow-colored `/buddy` notification appears for 15 seconds on startup
- `isBuddyLive()` gates the feature to April 2026 onward (always true for internal builds)
- `findBuddyTriggerPositions(text)` scans input text for `/buddy` occurrences, returning their positions for rainbow highlighting in the prompt input

### Prompt Integration

`prompt.ts` handles introducing the companion to Claude's conversation context:

- `companionIntroText(name, species)` generates a system prompt block explaining that a small creature sits beside the input and occasionally speaks in a bubble, instructing Claude to stay out of the way when the user talks to their companion (`src/buddy/prompt.ts:7-13`)
- `getCompanionIntroAttachment(messages)` returns a `companion_intro` attachment for the message list, but only once per companion (it checks existing messages to avoid duplicate introductions) (`src/buddy/prompt.ts:15-36`)

## Function Signatures

### `roll(userId: string): Roll`
Deterministically generates companion traits from a user ID. Returns `{ bones: CompanionBones, inspirationSeed: number }`. Results are cached.

### `getCompanion(): Companion | undefined`
Returns the full companion (bones + soul) if one has been hatched, or `undefined` if not. Bones are regenerated from the user ID hash; soul comes from stored config.

### `renderSprite(bones: CompanionBones, frame?: number): string[]`
Renders an ASCII sprite as an array of strings. Frame defaults to 0.

### `renderFace(bones: CompanionBones): string`
Returns a compact one-line face string for narrow-terminal display.

### `companionReservedColumns(terminalColumns: number, speaking: boolean): number`
Calculates how many terminal columns the sprite area consumes, so `PromptInput` can wrap text correctly. Returns 0 when the feature is off, companion is muted, or the terminal is too narrow.

### `useBuddyNotification(): void`
React hook that shows the teaser notification on startup during the teaser window.

### `getCompanionIntroAttachment(messages: Message[] | undefined): Attachment[]`
Returns a companion intro attachment if one hasn't been sent yet in the current conversation.

## Interface / Type Definitions

### `CompanionBones`
Deterministic traits derived from `hash(userId)` — never persisted:

| Field | Type | Description |
|-------|------|-------------|
| `rarity` | `Rarity` | common / uncommon / rare / epic / legendary |
| `species` | `Species` | One of 18 species (duck, goose, blob, cat, dragon, octopus, owl, penguin, turtle, snail, ghost, axolotl, capybara, cactus, robot, rabbit, mushroom, chonk) |
| `eye` | `Eye` | One of 6 styles: `·`, `✦`, `×`, `◉`, `@`, `°` |
| `hat` | `Hat` | none / crown / tophat / propeller / halo / wizard / beanie / tinyduck |
| `shiny` | `boolean` | 1% chance |
| `stats` | `Record<StatName, number>` | Five stats: DEBUGGING, PATIENCE, CHAOS, WISDOM, SNARK |

### `CompanionSoul`
Model-generated identity stored in config after first hatch: `{ name: string, personality: string }`.

### `StoredCompanion`
What persists in config: `CompanionSoul & { hatchedAt: number }`. Bones are intentionally excluded to prevent tampering and survive species renames.

### `Companion`
The full union: `CompanionBones & CompanionSoul & { hatchedAt: number }`.

## Configuration & Defaults

- **`config.companion`**: Stored `CompanionSoul & { hatchedAt }` — written once at hatch time
- **`config.companionMuted`**: Boolean flag to suppress the companion entirely
- **Feature flag**: `BUDDY` via `bun:bundle` — all entry points check this before rendering
- **`SALT`**: `'friend-2026-401'` — appended to the userId before hashing to namespace the RNG seed (`src/buddy/companion.ts:84`)

## Edge Cases & Caveats

- **Species names are obfuscated** in source via `String.fromCharCode()` to avoid collisions with an excluded-strings check that greps build output for model codenames (`src/buddy/types.ts:10-13`)
- **Bones are never stored** — they're regenerated from the user ID hash on every access. This means editing `config.companion` cannot fake a rarity, and species array changes don't break existing companions
- **The roll cache** is a single-entry module-level cache keyed on `userId + SALT`. It assumes only one user ID is active at a time
- **Narrow terminals** (< 100 columns) get a degraded one-line display; quips are truncated to 24 characters
- **Fullscreen vs. non-fullscreen** rendering is split: in fullscreen mode the speech bubble is rendered by a separate `CompanionFloatingBubble` component mounted outside the clipped scroll area
- **Teaser window** uses local time (not UTC) intentionally — this creates a 24-hour rolling wave across timezones for sustained social media buzz rather than a single UTC-midnight spike
- **`isBuddyLive()`** returns `true` unconditionally for internal builds (`"external" === 'ant'` check), allowing internal testing before the public launch date