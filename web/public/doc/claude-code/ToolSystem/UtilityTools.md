# Utility Tools

## Overview & Responsibilities

The UtilityTools module is a collection of miscellaneous tools within the **ToolSystem** that handle interactive user input, runtime configuration, message delivery, and experimental feature stubs. These are not file-system or shell tools — they provide meta-capabilities that let Claude interact with the user, modify its own settings, and send structured messages.

Within the ToolSystem hierarchy, these tools sit alongside the 40+ built-in tools (file ops, shell, web access, etc.) and share the same `buildTool()` framework, permission model, and execution pipeline. They are registered into the tool registry and dispatched by the QueryEngine like any other tool.

The module breaks into two distinct groups:

1. **Core TypeScript tools** (`src/tools/`): Fully implemented tools — `AskUserQuestionTool`, `ConfigTool`, and `BriefTool` — each with input/output schemas, permission checks, UI renderers, and execution logic.
2. **External JS stubs** (`tools/`): Auto-generated stub files for feature-flagged experimental tools (`TungstenTool`, `OverflowTestTool`, `TerminalCaptureTool`, `VerifyPlanExecutionTool`, `WorkflowTool`) that are loaded conditionally and currently export no-op functions.

---

## AskUserQuestionTool

### Purpose

Prompts the user with interactive multiple-choice questions during execution. This enables Claude to gather preferences, clarify ambiguous instructions, get decisions on implementation choices, and offer the user directional choices — all without breaking the conversation flow.

### Input Schema

Defined via Zod at `src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx:62-67`:

| Field | Type | Description |
|-------|------|-------------|
| `questions` | `Question[]` (1–4) | Array of questions to present |
| `answers` | `Record<string, string>` (optional) | Pre-filled answers from the permission component |
| `annotations` | `Record<string, {preview?, notes?}>` (optional) | Per-question user annotations (notes, preview selections) |
| `metadata` | `{source?: string}` (optional) | Analytics tracking metadata |

Each `Question` object (`src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx:19-24`):

| Field | Type | Description |
|-------|------|-------------|
| `question` | `string` | The question text |
| `header` | `string` | Short chip/tag label (max 12 chars) |
| `options` | `QuestionOption[]` (2–4) | Available choices |
| `multiSelect` | `boolean` (default `false`) | Allow multiple selections |

Each `QuestionOption`:

| Field | Type | Description |
|-------|------|-------------|
| `label` | `string` | Display text (1–5 words) |
| `description` | `string` | Explanation of what the option means |
| `preview` | `string` (optional) | Preview content (markdown or HTML) rendered side-by-side |

### Key Behaviors

- **Uniqueness validation**: Question texts must be unique across the batch, and option labels must be unique within each question (`UNIQUENESS_REFINE` at line 32–54).
- **Preview format**: The preview feature supports both `markdown` (monospace box) and `html` (self-contained fragment) formats, determined by `getQuestionPreviewFormat()`. HTML previews are validated to reject full documents (`<html>`, `<body>`) and executable tags (`<script>`, `<style>`) — see `validateHtmlPreview()` at line 250–265.
- **Channel gating**: When `--channels` is active (Telegram/Discord mode), the tool disables itself since no one is at the keyboard to answer (`isEnabled()` at line 141).
- **Permission model**: Always requires user interaction (`requiresUserInteraction() = true`), always asks for permission (`checkPermissions` returns `'ask'`).
- **Deferred loading**: `shouldDefer: true` — the tool schema is not sent to the model until needed.

### Execution Flow

1. Claude invokes the tool with 1–4 questions
2. The permission system presents the questions to the user via the TUI
3. The user selects answers (single or multi-select) and optionally adds notes
4. Answers are injected into the `answers` field, and the tool's `call()` method simply passes them through (`src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx:209-222`)
5. `mapToolResultToToolResultBlockParam` formats the answers into a string like `"Which lib?"="lodash"` for the model to read

### Prompt

The tool prompt (`src/tools/AskUserQuestionTool/prompt.ts:32-44`) instructs the model to:
- Use the tool for gathering preferences, clarifying instructions, and offering choices
- Put recommended options first with "(Recommended)" suffix
- In plan mode, use the tool to clarify requirements but NOT to ask "Is my plan ready?" (use `ExitPlanMode` for that)

---

## ConfigTool

### Purpose

Provides a get/set interface for Claude Code's runtime configuration settings. Claude can read current values or update them on behalf of the user — covering theme, model selection, permission mode, voice, and more.

### Input/Output Schemas

**Input** (`src/tools/ConfigTool/ConfigTool.ts:36-48`):

| Field | Type | Description |
|-------|------|-------------|
| `setting` | `string` | Setting key (e.g., `"theme"`, `"model"`, `"permissions.defaultMode"`) |
| `value` | `string \| boolean \| number` (optional) | New value; omit to read current value |

**Output** (`src/tools/ConfigTool/ConfigTool.ts:51-61`):

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Whether the operation succeeded |
| `operation` | `"get" \| "set"` | Which operation was performed |
| `setting` | `string` | The setting key |
| `value` / `previousValue` / `newValue` | `unknown` | Values (depending on operation) |
| `error` | `string` | Error message on failure |

### Supported Settings

All settings are defined in the `SUPPORTED_SETTINGS` registry (`src/tools/ConfigTool/supportedSettings.ts:29-186`). Settings are stored in two locations:

**Global settings** (stored in `~/.claude.json`):
- `theme` — Color theme (`THEME_NAMES` or `THEME_SETTINGS`)
- `editorMode` — Key binding mode (`EDITOR_MODES`)
- `verbose` — Debug output (boolean, syncs to AppState)
- `preferredNotifChannel` — Notification channel
- `autoCompactEnabled` — Auto-compact when context is full
- `fileCheckpointingEnabled` — Code rewind checkpoints
- `showTurnDuration` — "Cooked for 1m 6s" messages
- `terminalProgressBarEnabled` — OSC 9;4 progress indicator
- `todoFeatureEnabled` — Todo/task tracking
- `teammateMode` — How to spawn teammates (`"tmux"`, `"in-process"`, `"auto"`)

**Project settings** (stored in `settings.json`):
- `model` — Override the default model (with async API validation)
- `alwaysThinkingEnabled` — Extended thinking toggle
- `permissions.defaultMode` — Default permission mode
- `language` — Preferred language for responses
- `autoMemoryEnabled` — Auto-memory toggle
- `autoDreamEnabled` — Background memory consolidation

**Feature-gated settings** (conditionally registered):
- `voiceEnabled` — Voice dictation (requires `VOICE_MODE` feature flag + GrowthBook gate)
- `remoteControlAtStartup` — Remote Control (requires `BRIDGE_MODE`)
- `taskCompleteNotifEnabled`, `inputNeededNotifEnabled`, `agentPushNotifEnabled` — Push notifications (require `KAIROS` / `KAIROS_PUSH_NOTIFICATION`)
- `classifierPermissionsEnabled` — AI-based classifier permissions (Anthropic internal only, `USER_TYPE=ant`)

### Key Process: Setting a Value

The `call()` method in `src/tools/ConfigTool/ConfigTool.ts:111-411` follows this flow:

1. **Check support**: Verify the setting key exists in `SUPPORTED_SETTINGS`. Voice settings get an additional runtime GrowthBook gate check.
2. **GET operation**: If `value` is omitted, read from the appropriate source (global config or settings file) and optionally format via `formatOnRead`.
3. **SET operation**:
   - Handle the special `"default"` value for `remoteControlAtStartup` (unsets the key)
   - Coerce string `"true"`/`"false"` to booleans for boolean-typed settings
   - Validate against allowed `options` list
   - Run async `validateOnWrite` if defined (e.g., model API validation)
   - For voice mode: run pre-flight checks (GrowthBook gate, recording availability, mic permission)
4. **Write**: Save to `~/.claude.json` (global) or `settings.json` (project) via `saveGlobalConfig` or `updateSettingsForSource`
5. **Sync**: Update `AppState` for immediate UI effect via `config.appStateKey`, and notify change detectors for voice settings
6. **Log analytics**: Fire `tengu_config_tool_changed` event

### Permission Model

- **Reading** is auto-allowed (no user prompt)
- **Writing** prompts the user with the change description (`src/tools/ConfigTool/ConfigTool.ts:98-107`)

---

## BriefTool (SendUserMessage)

### Purpose

The primary visible output channel in "brief" / "chat" mode. When active, text outside this tool is only visible in the detail view — the `SendUserMessage` tool is how Claude delivers answers the user actually sees.

### Aliases

- Current name: `SendUserMessage`
- Legacy name: `Brief`

### Entitlement & Activation

The tool has a two-layer gating system (`src/tools/BriefTool/BriefTool.ts:88-134`):

1. **Entitlement** (`isBriefEntitled()`): Is the user *allowed* to use Brief? Requires build-time feature flags (`KAIROS` or `KAIROS_BRIEF`) plus one of: Kairos active, `CLAUDE_CODE_BRIEF` env var, or GrowthBook `tengu_kairos_brief` gate.

2. **Activation** (`isBriefEnabled()`): Is the tool *active* this session? Requires entitlement AND explicit opt-in via one of: `--brief` flag, `defaultView: 'chat'` setting, `/brief` command, `/config` defaultView picker, `--tools` SDK option, or `CLAUDE_CODE_BRIEF` env var. Kairos assistant mode bypasses opt-in.

### Input Schema

Defined at `src/tools/BriefTool/BriefTool.ts:20-37`:

| Field | Type | Description |
|-------|------|-------------|
| `message` | `string` | Markdown-formatted message for the user |
| `attachments` | `string[]` (optional) | File paths to attach (images, diffs, logs) |
| `status` | `"normal" \| "proactive"` | `"normal"` for replies; `"proactive"` for unsolicited updates |

### Attachment Pipeline

When attachments are provided:

1. **Validation** (`src/tools/BriefTool/attachments.ts:26-61`): `validateAttachmentPaths()` checks each path exists, is a regular file, and is accessible.
2. **Resolution** (`src/tools/BriefTool/attachments.ts:63-110`): `resolveAttachments()` stats each file for size and determines if it's an image via extension regex, producing `ResolvedAttachment` objects.
3. **Upload** (`src/tools/BriefTool/upload.ts:92-174`): When `BRIDGE_MODE` is active and the repl bridge is enabled, `uploadBriefAttachment()` uploads files to `/api/oauth/file_upload` via multipart POST. Returns a `file_uuid` for web viewers. Upload is best-effort — failures return `undefined` and the attachment still works for local rendering.
   - Max upload size: 30 MB
   - Upload timeout: 30 seconds
   - MIME detection: PNG, JPEG, GIF, WEBP → their image type; everything else → `application/octet-stream`

### UI Rendering

The `renderToolResultMessage` in `src/tools/BriefTool/UI.tsx:15-68` has three rendering modes:

- **Transcript mode** (`ctrl+o`): Black circle gutter marker + markdown + attachment list
- **Brief-only (chat) view**: "Claude" label with timestamp, 2-column indent, matching the "You" label style
- **Default view**: No gutter mark, rendered as plain text with markdown

### Proactive Messaging

The tool prompt (`src/tools/BriefTool/prompt.ts:12-22`) defines a proactive communication protocol:
- Every user-facing reply goes through `SendUserMessage`
- Acknowledge immediately ("On it — checking the test output"), then work, then send result
- Send checkpoints when something useful happened — not filler like "running tests..."
- Keep messages tight: the decision, the `file:line`, the PR number

---

## External Tool Stubs (`tools/` directory)

The `tools/` directory contains JavaScript stub files for experimental, feature-flagged tools that are loaded conditionally at runtime. As of the current codebase, **all five are auto-generated no-op stubs**, but they differ in what they export:

### Tool-named stubs

These export both a default function and a named constant matching the tool name:

| Tool | File | Exports |
|------|------|---------|
| **TungstenTool** | `tools/TungstenTool/TungstenTool.js` | `export default function TungstenTool() {}` and `export const TungstenTool = () => {}` |
| **OverflowTestTool** | `tools/OverflowTestTool/OverflowTestTool.js` | `export default function OverflowTestTool() {}` and `export const OverflowTestTool = () => {}` |

> Source: `tools/TungstenTool/TungstenTool.js:1-3`, `tools/OverflowTestTool/OverflowTestTool.js:1-3`

### Generic-named stubs

These export generic `prompt` or `constants` placeholders rather than tool-named functions. They serve as stand-ins for module-level configuration or prompt text that the real tool implementations would define:

| Tool | File | Exports |
|------|------|---------|
| **TerminalCaptureTool** | `tools/TerminalCaptureTool/prompt.js` | `export default function prompt() {}` and `export const prompt = () => {}` |
| **VerifyPlanExecutionTool** | `tools/VerifyPlanExecutionTool/constants.js` | `export default function constants() {}` and `export const constants = () => {}` |
| **WorkflowTool** | `tools/WorkflowTool/constants.js` | `export default function constants() {}` and `export const constants = () => {}` |

> Source: `tools/TerminalCaptureTool/prompt.js:1-3`, `tools/VerifyPlanExecutionTool/constants.js:1-3`, `tools/WorkflowTool/constants.js:1-3`

The distinction matters: the tool-named stubs (`TungstenTool.js`, `OverflowTestTool.js`) are stand-ins for the tool's main implementation module, while the generic-named stubs (`prompt.js`, `constants.js`) replace auxiliary modules that would provide prompt text or constant definitions (like tool names, descriptions, or feature-flag keys) consumed by the tool's main implementation elsewhere. All are currently no-ops and contribute no runtime behavior — they exist so that import paths resolve without error when the corresponding feature flags are disabled.

---

## Edge Cases & Caveats

- **AskUserQuestionTool disables in channel mode**: When `--channels` is active (Telegram/Discord), the tool returns `isEnabled() = false` because there is nobody at the keyboard to interact with the multiple-choice dialog.
- **ConfigTool voice pre-flights**: Setting `voiceEnabled = true` triggers a chain of runtime checks — GrowthBook gate, recording hardware availability, audio dependency check, microphone permission — any of which can reject the setting change with a descriptive error.
- **ConfigTool "default" special value**: For `remoteControlAtStartup`, passing `"default"` deletes the config key rather than writing the string, causing fallback to the platform-aware default.
- **BriefTool output schema keeps `attachments` optional**: This is intentional — resumed sessions replay pre-attachment outputs verbatim and a required field would crash the UI renderer on resume (`src/tools/BriefTool/BriefTool.ts:40-41`).
- **Upload is best-effort**: `uploadBriefAttachment` silently returns `undefined` on any failure (no token, network error, size exceeded). The attachment metadata still includes `{path, size, isImage}` for local renderers.
- **External stubs are no-ops**: The `tools/` directory stubs export empty functions. They serve as placeholders for future feature-flagged implementations and currently contribute no runtime behavior.