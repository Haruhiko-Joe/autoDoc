# Model and Cost

## Overview & Responsibilities

The ModelAndCost module is the centralized model management layer within the **Infrastructure** subsystem. It determines which Claude model to use for every API call, maps model identifiers across four API providers (firstParty, Bedrock, Vertex, Foundry), validates user-selected models against admin allowlists, tracks model deprecation, and calculates USD costs from token usage.

Every other subsystem that sends requests to Claude — QueryEngine, Services, RemoteAndBridge, ToolSystem — depends on this module to resolve the actual model string before making API calls.

The module lives in two locations:
- `src/utils/model/` — 16 files covering selection, configuration, aliases, validation, and capabilities
- `src/utils/modelCost.ts` — pricing tiers and cost calculation

## Key Processes

### Model Resolution Priority Chain

The most important flow is resolving which model to use for a session. `getMainLoopModel()` (`src/utils/model/model.ts:92-98`) implements a 5-level priority chain:

1. **Session override** — `/model` command sets a runtime override via `getMainLoopModelOverride()`
2. **CLI `--model` flag** — passed at startup
3. **`ANTHROPIC_MODEL` env var** — environment-level configuration
4. **Settings** — `model` field from user's saved `settings.json`
5. **Built-in default** — determined by subscription tier via `getDefaultMainLoopModelSetting()`

```
getUserSpecifiedModelSetting() → checks levels 1-4, returns undefined if none set
getMainLoopModel() → calls above, falls back to getDefaultMainLoopModel() for level 5
```

At each level, the model is checked against the allowlist (`isModelAllowed()`) before being accepted (`src/utils/model/model.ts:72-75`).

### Default Model Selection by User Tier

`getDefaultMainLoopModelSetting()` (`src/utils/model/model.ts:178-200`) selects defaults based on subscription:

| User Tier | Default Model |
|-----------|--------------|
| Internal (ant) | Flag-configured or Opus 4.6 [1m] |
| Max / Team Premium | Opus 4.6 (with [1m] if merge enabled) |
| Pro / Team Standard / Enterprise / PAYG | Sonnet 4.6 (first-party) or Sonnet 4.5 (3P) |

### Alias Resolution

`parseUserSpecifiedModel()` (`src/utils/model/model.ts:445-506`) converts user-friendly aliases to concrete model IDs:

| Alias | Resolves To |
|-------|------------|
| `sonnet` | `getDefaultSonnetModel()` — Sonnet 4.6 (1P) or 4.5 (3P) |
| `opus` | `getDefaultOpusModel()` — Opus 4.6 |
| `haiku` | `getDefaultHaikuModel()` — Haiku 4.5 |
| `best` | `getDefaultOpusModel()` — Opus 4.6 |
| `opusplan` | Sonnet by default, Opus in plan mode only |

Any alias can carry a `[1m]` suffix (e.g., `sonnet[1m]`) to request the 1M context window variant. Legacy Opus 4.0/4.1 model IDs on first-party are silently remapped to the current Opus default unless `CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP` is set.

### Multi-Provider Model String Resolution

Each model has a `ModelConfig` (`src/utils/model/configs.ts`) mapping its ID across all four providers:

```typescript
// src/utils/model/configs.ts:79-84
export const CLAUDE_SONNET_4_6_CONFIG = {
  firstParty: 'claude-sonnet-4-6',
  bedrock: 'us.anthropic.claude-sonnet-4-6',
  vertex: 'claude-sonnet-4-6',
  foundry: 'claude-sonnet-4-6',
} as const satisfies ModelConfig
```

`getModelStrings()` (`src/utils/model/modelStrings.ts:136-145`) selects the correct provider column based on `getAPIProvider()`, which checks env vars `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, and `CLAUDE_CODE_USE_FOUNDRY` (`src/utils/model/providers.ts:6-14`).

For Bedrock specifically, model strings are resolved asynchronously by querying AWS inference profiles (`src/utils/model/bedrock.ts:7-41`) and matching them against canonical model IDs. Cross-region prefixes (`us.`, `eu.`, `apac.`, `global.`) are handled transparently.

User-configured `modelOverrides` from `settings.json` are layered on top via `applyModelOverrides()` (`src/utils/model/modelStrings.ts:63-76`), allowing custom Bedrock ARNs to replace default model strings.

### Canonical Name Mapping

`getCanonicalName()` (`src/utils/model/model.ts:279-283`) unifies any provider-specific model ID to a short canonical form. For example, both `claude-sonnet-4-5-20250929` and `us.anthropic.claude-sonnet-4-5-20250929-v1:0` map to `claude-sonnet-4-5`. This canonical name is used as the key for cost lookups and display logic.

The pipeline is: input → `resolveOverriddenModel()` (reverse ARN→canonical lookup) → `firstPartyNameToCanonical()` (substring match to strip dates/suffixes).

### Cost Calculation

`calculateUSDCost()` (`src/utils/modelCost.ts:177-180`) computes session costs:

1. Resolve model to canonical name via `getCanonicalName()`
2. Look up `ModelCosts` pricing tier from `MODEL_COSTS` map
3. Apply `tokensToUSDCost()` formula

The formula (`src/utils/modelCost.ts:131-142`):
```
cost = (input_tokens / 1M) × inputRate
     + (output_tokens / 1M) × outputRate
     + (cache_read_tokens / 1M) × cacheReadRate
     + (cache_creation_tokens / 1M) × cacheWriteRate
     + web_search_requests × webSearchRate
```

### Pricing Tiers

All prices are per million tokens (`src/utils/modelCost.ts:36-89`):

| Tier | Input | Output | Cache Write | Cache Read | Models |
|------|-------|--------|-------------|------------|--------|
| `COST_HAIKU_35` | $0.80 | $4 | $1 | $0.08 | Haiku 3.5 |
| `COST_HAIKU_45` | $1 | $5 | $1.25 | $0.10 | Haiku 4.5 |
| `COST_TIER_3_15` | $3 | $15 | $3.75 | $0.30 | All Sonnet models |
| `COST_TIER_5_25` | $5 | $25 | $6.25 | $0.50 | Opus 4.5, Opus 4.6 |
| `COST_TIER_15_75` | $15 | $75 | $18.75 | $1.50 | Opus 4.0, Opus 4.1 |
| `COST_TIER_30_150` | $30 | $150 | $37.50 | $3.00 | Opus 4.6 fast mode |

Opus 4.6 has dynamic pricing: `getOpus46CostTier()` returns `COST_TIER_30_150` when fast mode is active, otherwise `COST_TIER_5_25`. For unknown models, costs fall back to the default main loop model's tier, or `COST_TIER_5_25` as the ultimate fallback.

### Allowlist Validation

`isModelAllowed()` (`src/utils/model/modelAllowlist.ts:100-170`) enforces the `availableModels` setting with three matching tiers:

1. **Family aliases** — `"opus"` in the allowlist permits any Opus model, unless more specific entries exist (e.g., `["opus", "opus-4-5"]` restricts to Opus 4.5 only)
2. **Version prefixes** — `"opus-4-5"` or `"claude-opus-4-5"` matches any build (e.g., `claude-opus-4-5-20251101`)
3. **Full model IDs** — exact match only

If `availableModels` is not configured, all models pass. An empty list blocks everything.

### Model Validation via API

`validateModel()` (`src/utils/model/validateModel.ts:20-82`) performs live validation by sending a minimal API request (`max_tokens: 1`). Results are cached in memory. Known aliases and `ANTHROPIC_CUSTOM_MODEL_OPTION` bypass the API call. On 404, 3P users get a fallback suggestion (e.g., "Try 'claude-sonnet-4-5' instead").

### Deprecation Tracking

`getModelDeprecationWarning()` (`src/utils/model/deprecation.ts:88-101`) checks model IDs against `DEPRECATED_MODELS` with per-provider retirement dates. Currently tracked deprecated models: Claude 3 Opus, Claude 3.7 Sonnet, and Claude 3.5 Haiku.

### Model Capabilities Cache

`modelCapabilities.ts` fetches and caches model capability data (max input tokens, max output tokens) from the Anthropic API. The cache is stored at `~/.claude/cache/model-capabilities.json` and is refreshed via `refreshModelCapabilities()`. Capabilities are sorted longest-ID-first for most-specific substring matching. This is currently limited to internal (ant) users on first-party API.

### Subagent Model Resolution

`getAgentModel()` (`src/utils/model/agent.ts:37-95`) resolves the model for subagent (child) threads. The default is `'inherit'`, which passes through the parent's model. When a family alias (e.g., `opus`) matches the parent's tier, the parent's exact model string is inherited — preventing downgrades on 3P providers. For Bedrock, the parent's cross-region prefix is propagated to subagents.

## Function Signatures

### Core Model Resolution

#### `getMainLoopModel(): ModelName`
Returns the resolved model name for the current session by walking the priority chain. Source: `src/utils/model/model.ts:92-98`

#### `getUserSpecifiedModelSetting(): ModelSetting | undefined`
Returns the user's configured model (from session/CLI/env/settings), or `undefined` if using defaults. Filters against allowlist. Source: `src/utils/model/model.ts:61-78`

#### `parseUserSpecifiedModel(modelInput: ModelName | ModelAlias): ModelName`
Resolves aliases to concrete model IDs, handles `[1m]` suffixes, remaps legacy Opus, and resolves internal models. Source: `src/utils/model/model.ts:445-506`

#### `getRuntimeMainLoopModel(params): ModelName`
Applies runtime context (permission mode, token count) to model selection. Handles `opusplan` (Opus in plan mode) and `haiku` (upgraded to Sonnet in plan mode). Source: `src/utils/model/model.ts:145-167`

### Naming & Display

#### `getCanonicalName(fullModelName: ModelName): ModelShortName`
Maps any provider-specific model ID to a unified short name (e.g., `claude-opus-4-6`). Source: `src/utils/model/model.ts:279-283`

#### `normalizeModelStringForAPI(model: string): string`
Strips `[1m]` and `[2m]` suffixes for API calls. Source: `src/utils/model/model.ts:616-618`

### Cost Calculation

#### `calculateUSDCost(resolvedModel: string, usage: Usage): number`
Calculates USD cost from a full `BetaUsage` object. Source: `src/utils/modelCost.ts:177-180`

#### `calculateCostFromTokens(model: string, tokens: {...}): number`
Calculates cost from raw token counts without a `Usage` object. Source: `src/utils/modelCost.ts:186-202`

#### `getModelPricingString(model: string): string | undefined`
Returns a formatted pricing string like `"$3/$15 per Mtok"`. Source: `src/utils/modelCost.ts:226-231`

### Validation & Allowlist

#### `isModelAllowed(model: string): boolean`
Checks a model against the `availableModels` setting. Source: `src/utils/model/modelAllowlist.ts:100-170`

#### `validateModel(model: string): Promise<{ valid: boolean; error?: string }>`
Live-validates a model via a minimal API call. Source: `src/utils/model/validateModel.ts:20-82`

## Interface/Type Definitions

### `ModelConfig`
```typescript
type ModelConfig = Record<APIProvider, ModelName>
// Maps each provider to its model ID string
```
Source: `src/utils/model/configs.ts:4`

### `APIProvider`
```typescript
type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry'
```
Source: `src/utils/model/providers.ts:4`

### `ModelAlias`
```typescript
const MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'best', 'sonnet[1m]', 'opus[1m]', 'opusplan'] as const
type ModelAlias = (typeof MODEL_ALIASES)[number]
```
Source: `src/utils/model/aliases.ts:1-10`

### `ModelCosts`
```typescript
type ModelCosts = {
  inputTokens: number       // $/Mtok for input
  outputTokens: number      // $/Mtok for output
  promptCacheWriteTokens: number  // $/Mtok for cache writes
  promptCacheReadTokens: number   // $/Mtok for cache reads
  webSearchRequests: number       // $ per request
}
```
Source: `src/utils/modelCost.ts:27-33`

### `ModelOption`
```typescript
type ModelOption = {
  value: ModelSetting    // The model alias or ID to set
  label: string          // Display label in model picker
  description: string    // Description shown in picker
  descriptionForModel?: string  // Description for model context
}
```
Source: `src/utils/model/modelOptions.ts:38-43`

## Configuration & Environment Variables

### Provider Selection
| Variable | Effect |
|----------|--------|
| `CLAUDE_CODE_USE_BEDROCK` | Use Amazon Bedrock as API provider |
| `CLAUDE_CODE_USE_VERTEX` | Use Google Vertex AI as API provider |
| `CLAUDE_CODE_USE_FOUNDRY` | Use Azure Foundry as API provider |

### Model Overrides
| Variable | Effect |
|----------|--------|
| `ANTHROPIC_MODEL` | Override model selection (priority level 3) |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Custom Opus model string |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Custom Sonnet model string |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Custom Haiku model string |
| `ANTHROPIC_SMALL_FAST_MODEL` | Override the small/fast model (defaults to Haiku) |
| `ANTHROPIC_CUSTOM_MODEL_OPTION` | Custom model added to the model picker |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Force a specific model for all subagents |
| `CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP` | Disable automatic Opus 4.0/4.1 → current remap |

### 3P Model Capability Overrides
| Variable | Effect |
|----------|--------|
| `ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES` | Comma-separated capabilities (e.g., `effort,thinking`) |
| `ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES` | Same, for Sonnet tier |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES` | Same, for Haiku tier |

Supported capability values: `effort`, `max_effort`, `thinking`, `adaptive_thinking`, `interleaved_thinking` (`src/utils/model/modelSupportOverrides.ts:4-9`)

### Settings Fields
- `settings.model` — Persistent model selection (priority level 4)
- `settings.availableModels` — Admin-controlled allowlist array
- `settings.modelOverrides` — Map of canonical model ID → custom provider-specific string

## Edge Cases & Caveats

- **Unknown model costs**: When a model has no pricing entry, cost is logged via analytics (`tengu_unknown_model_cost`) and falls back to the default model's tier, then `COST_TIER_5_25`. A global flag `hasUnknownModelCost` is set so the UI can display a warning.

- **Opus 4.6 fast mode pricing**: The same model (`claude-opus-4-6`) has two different cost tiers depending on the `usage.speed` field — `$5/$25` normally, `$30/$150` in fast mode (`src/utils/modelCost.ts:94-99`).

- **`[1m]` suffix handling**: The `[1m]` tag is a client-side convention stripped before API calls via `normalizeModelStringForAPI()`. It controls context window behavior but is not part of the actual model ID sent to the API.

- **Opus 1M merge guard**: `isOpus1mMergeEnabled()` (`src/utils/model/model.ts:314-332`) fails closed when a subscriber's `subscriptionType` is null (stale token), preventing the `opus[1m]` option from leaking into dropdowns where the API would reject it.

- **Bedrock region prefix inheritance**: Subagents inherit the parent's cross-region prefix (e.g., `eu.`) for Bedrock models, but if a subagent config explicitly specifies a full model ID with its own prefix, that prefix is preserved to avoid data-residency violations (`src/utils/model/agent.ts:58-67`).

- **3P provider lag**: Default models for third-party providers (Bedrock, Vertex, Foundry) intentionally use older versions than first-party because new models may not yet be available on those platforms. `getDefaultSonnetModel()` returns Sonnet 4.5 for 3P vs Sonnet 4.6 for first-party.

- **Skill model override**: `resolveSkillModelOverride()` (`src/utils/model/model.ts:523-536`) carries the `[1m]` suffix from the current session to a skill's model override when the target supports it, preventing unexpected context window downgrades.

- **Model validation caching**: `validateModel()` caches successful validations in memory but does not cache failures, so a model that was temporarily unavailable will be retried on the next attempt.