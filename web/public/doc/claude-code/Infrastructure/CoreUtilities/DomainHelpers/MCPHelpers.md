# MCP Helpers

## Overview & Responsibilities

The MCP Helpers module provides two specialized utilities for the MCP (Model Context Protocol) integration layer: **natural language date/time parsing** and **elicitation response validation**. It sits within the Infrastructure > CoreUtilities > DomainHelpers hierarchy, serving the MCP tool system when it needs to interpret user-provided input during tool parameter elicitation.

The module solves two problems:
1. Users enter relative date expressions like "tomorrow at 3pm" into MCP tool parameters — these need to be resolved to ISO 8601 strings.
2. MCP servers define schemas for elicitation prompts (text fields, numbers, booleans, enums) — user responses need validated against those schemas before being sent back.

The module spans two files:
- `src/utils/mcp/dateTimeParser.ts` — LLM-powered natural language date/time resolution
- `src/utils/mcp/elicitationValidation.ts` — Zod-based schema validation for MCP elicitation inputs

## Key Processes

### Natural Language Date/Time Parsing Flow

When a user enters a date/time value that doesn't look like ISO 8601, the system attempts AI-powered parsing:

1. `validateElicitationInputAsync()` receives the raw string and the schema (`src/utils/mcp/elicitationValidation.ts:307-336`)
2. It first tries synchronous Zod validation — if the input is already valid ISO 8601, it returns immediately
3. If sync validation fails and the schema is a `date` or `date-time` format, it checks whether the input looks like ISO 8601 via `looksLikeISO8601()` (`src/utils/mcp/dateTimeParser.ts:117-121`)
4. If the input is natural language (not ISO 8601), it calls `parseNaturalLanguageDateTime()` (`src/utils/mcp/dateTimeParser.ts:23-111`)
5. That function builds a system prompt instructing Claude Haiku to act as a date parser, providing current date/time context including timezone and day of week
6. Haiku returns either a parsed ISO 8601 string or `"INVALID"`
7. The parsed result undergoes a final Zod validation pass to ensure it actually conforms to the expected format
8. If all parsing fails, the original sync validation error is returned

### Elicitation Input Validation Flow

When an MCP server requests user input via elicitation, the validation system:

1. Receives a raw string value and a `PrimitiveSchemaDefinition` from the MCP SDK
2. `getZodSchema()` dynamically builds a Zod validator from the schema definition (`src/utils/mcp/elicitationValidation.ts:135-223`):
   - **Enums**: Extracts values from either `enum` or `oneOf` format, builds `z.enum()`
   - **Strings**: Applies `minLength`/`maxLength` constraints and format validation (`email`, `uri`, `date`, `date-time`)
   - **Numbers/Integers**: Uses `z.coerce.number()` with optional `min`/`max`/`int` constraints and descriptive range messages
   - **Booleans**: Uses `z.coerce.boolean()`
3. `validateElicitationInput()` runs `safeParse()` and returns a `ValidationResult` with the coerced value or error messages (`src/utils/mcp/elicitationValidation.ts:225-243`)

## Function Signatures

### `parseNaturalLanguageDateTime(input, format, signal): Promise<DateTimeParseResult>`

Sends natural language to Claude Haiku for date/time resolution.

- **input** (`string`): The natural language expression (e.g., "next Monday", "in 2 hours")
- **format** (`'date' | 'date-time'`): Controls output — `'date'` produces `YYYY-MM-DD`, `'date-time'` produces full ISO 8601 with timezone
- **signal** (`AbortSignal`): For cancellation support
- **Returns**: `{ success: true, value: string }` or `{ success: false, error: string }`

> Source: `src/utils/mcp/dateTimeParser.ts:23-111`

### `looksLikeISO8601(input): boolean`

Quick regex check to determine if input is already ISO 8601 formatted. Matches strings starting with `YYYY-MM-DD`. Used to decide whether to skip NL parsing.

> Source: `src/utils/mcp/dateTimeParser.ts:117-121`

### `validateElicitationInput(stringValue, schema): ValidationResult`

Synchronous validation of a string value against an MCP `PrimitiveSchemaDefinition`.

- **stringValue** (`string`): The raw user input
- **schema** (`PrimitiveSchemaDefinition`): The MCP schema definition (string, number, integer, boolean, or enum)
- **Returns**: `{ value, isValid: true }` or `{ isValid: false, error }`

> Source: `src/utils/mcp/elicitationValidation.ts:225-243`

### `validateElicitationInputAsync(stringValue, schema, signal): Promise<ValidationResult>`

Async validation that extends `validateElicitationInput` with NL date/time parsing fallback via Haiku when the schema has `date` or `date-time` format.

> Source: `src/utils/mcp/elicitationValidation.ts:307-336`

### Enum Utility Functions

| Function | Purpose | Source |
|----------|---------|--------|
| `isEnumSchema(schema)` | Type guard for single-select enums (legacy `enum` or `oneOf`) | `:43-47` |
| `isMultiSelectEnumSchema(schema)` | Type guard for multi-select enums (`type: "array"` with items) | `:52-62` |
| `getEnumValues(schema)` | Extract values from `enum` or `oneOf` format | `:104-112` |
| `getEnumLabels(schema)` | Extract display labels (falls back to values) | `:117-125` |
| `getEnumLabel(schema, value)` | Get label for a specific value | `:130-133` |
| `getMultiSelectValues(schema)` | Extract values from multi-select items | `:67-75` |
| `getMultiSelectLabels(schema)` | Extract labels from multi-select items | `:80-88` |
| `getMultiSelectLabel(schema, value)` | Get label for a specific multi-select value | `:93-99` |

All source references above are relative to `src/utils/mcp/elicitationValidation.ts`.

### `getFormatHint(schema): string | undefined`

Returns a user-facing placeholder string describing the expected format. For strings with format constraints it returns descriptions like `"date, e.g. 2024-03-15"`. For numbers it returns range descriptions like `"(integer between 1 and 100)"`.

> Source: `src/utils/mcp/elicitationValidation.ts:258-288`

### `isDateTimeSchema(schema): boolean`

Type guard that checks if a schema is a string with `date` or `date-time` format — the trigger for NL parsing.

> Source: `src/utils/mcp/elicitationValidation.ts:293-301`

## Type Definitions

### `DateTimeParseResult`

Discriminated union for parse outcomes:

```typescript
type DateTimeParseResult =
  | { success: true; value: string }
  | { success: false; error: string }
```

> Source: `src/utils/mcp/dateTimeParser.ts:6-8`

### `ValidationResult`

Result of elicitation validation:

```typescript
type ValidationResult = {
  value?: string | number | boolean
  isValid: boolean
  error?: string
}
```

> Source: `src/utils/mcp/elicitationValidation.ts:15-19`

### `STRING_FORMATS`

Lookup table mapping format names to descriptions and examples:

| Format | Description | Example |
|--------|-------------|---------|
| `email` | email address | `user@example.com` |
| `uri` | URI | `https://example.com` |
| `date` | date | `2024-03-15` |
| `date-time` | date-time | `2024-03-15T14:30:00Z` |

> Source: `src/utils/mcp/elicitationValidation.ts:21-38`

## Edge Cases & Caveats

- **Haiku dependency**: Natural language date parsing requires a live API call to Claude Haiku via `queryHaiku()`. If the API is unavailable, the function returns a graceful error suggesting manual ISO 8601 input rather than crashing.
- **Future date bias**: The Haiku prompt instructs the model to prefer future dates over past dates when input is ambiguous (e.g., "Monday" means next Monday, not last Monday).
- **Double validation**: After Haiku parses NL input, the result is re-validated through Zod to ensure the AI-generated output actually conforms to the expected format. This prevents malformed AI output from propagating.
- **Enum format duality**: The MCP SDK supports two enum formats — legacy `enum` arrays and newer `oneOf` arrays with `const`/`title` pairs. All enum functions handle both formats transparently.
- **Multi-select enums**: Handled separately from single-select via `type: "array"` with `items` containing `enum` or `anyOf`. The `anyOf` variant uses `const`/`title` pairs for value/label separation.
- **Number coercion**: Number schemas use `z.coerce.number()`, meaning string inputs like `"42"` are automatically converted to numbers. Boolean schema similarly uses `z.coerce.boolean()`.
- **Unsupported schemas**: `getZodSchema()` throws an error for schema types that aren't string, number, integer, boolean, or enum — this is a hard failure, not a graceful degradation.
- **Timezone handling**: The date parser computes the local timezone offset from `Date.getTimezoneOffset()` and passes it to Haiku so relative expressions like "in 2 hours" resolve correctly for the user's locale.