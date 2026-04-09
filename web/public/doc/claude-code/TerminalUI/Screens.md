# Screens

## Overview & Responsibilities

The `src/screens/` directory contains the top-level page layouts of the Claude Code terminal UI. These are the highest-level React components rendered into the Ink (React-for-CLI) root, each representing a distinct application screen. Within the **TerminalUI** module of the overall architecture, Screens sit directly below the `App` wrapper and above all other UI components (Messages, PromptInput, dialogs, etc.).

There are three screens and one launcher:

| File | Export | Role |
|------|--------|------|
| `src/screens/REPL.tsx` (5005 lines) | `REPL` | Main interactive screen — the conversation loop |
| `src/screens/Doctor.tsx` (574 lines) | `Doctor` | Diagnostic/health-check screen (`/doctor` command) |
| `src/screens/ResumeConversation.tsx` (398 lines) | `ResumeConversation` | Session picker and restoration screen (`--resume`) |
| `src/replLauncher.tsx` (22 lines) | `launchRepl` | Bootstrap function that mounts `App > REPL` into the Ink root |

Sibling modules in the TerminalUI layer (components, hooks, keybindings, ink engine) are consumed heavily by these screens but are not screens themselves.

---

## REPL Screen

### Purpose

`REPL` is the central screen of Claude Code. It orchestrates the entire interactive conversation loop: accepting user input, dispatching queries to the AI engine, streaming responses, rendering messages, handling tool-use permission dialogs, managing slash commands, and coordinating dozens of overlays (cost dialogs, idle-return prompts, sandbox permissions, feedback surveys, etc.).

### Props

The `REPL` component accepts an extensive props interface (`src/screens/REPL.tsx:526-570`):

| Prop | Type | Description |
|------|------|-------------|
| `commands` | `Command[]` | Available slash commands |
| `debug` | `boolean` | Enable debug logging |
| `initialTools` | `Tool[]` | Base tool set |
| `initialMessages` | `MessageType[]` | Pre-populated messages (for resume) |
| `pendingHookMessages` | `Promise<HookResultMessage[]>` | Deferred session-start hook messages |
| `mcpClients` | `MCPServerConnection[]` | MCP server connections |
| `systemPrompt` / `appendSystemPrompt` | `string` | Custom system prompt overrides |
| `onBeforeQuery` | callback | Hook before API call; return `false` to prevent |
| `onTurnComplete` | callback | Fires when a model turn finishes |
| `disabled` | `boolean` | Hides prompt input |
| `mainThreadAgentDefinition` | `AgentDefinition` | Agent definition for the main thread |
| `remoteSessionConfig` | `RemoteSessionConfig` | Config for `--remote` mode |
| `directConnectConfig` | `DirectConnectConfig` | Config for `claude connect` mode |
| `sshSession` | `SSHSession` | SSH session for remote tool execution |
| `thinkingConfig` | `ThinkingConfig` | Extended thinking configuration |
| `taskListId` | `string` | Enables task-watch mode |

### Key Processes

#### Query Lifecycle

The query lifecycle is managed by a `QueryGuard` state machine (`src/screens/REPL.tsx:900`) that ensures only one query runs at a time:

1. **User submits input** via `onSubmit` (`src/screens/REPL.tsx:3142`). This handles immediate commands (bypass queue), idle-return detection, history tracking, and stash management.
2. **Input is processed** through `handlePromptSubmit` which parses slash commands, expands pasted text refs, creates user messages, and determines whether to call the API.
3. **`onQuery`** (`src/screens/REPL.tsx:2855`) acquires the query guard via `queryGuard.tryStart()`. If already running, the input is enqueued for later replay. It resets timing refs, appends new messages, and calls `onQueryImpl`.
4. **`onQueryImpl`** (`src/screens/REPL.tsx:2661`) builds the system prompt, loads user/system context, resolves tools, and iterates over the async generator from `query()` — the core AI query engine.
5. **`onQueryEvent`** (`src/screens/REPL.tsx:2584`) processes each streaming event via `handleMessageFromStream`, routing to `setMessages` for new assistant/progress messages, handling compact boundaries, and updating streaming state (tool uses, thinking blocks).
6. **Turn completes** in the `finally` block: `queryGuard.end()` transitions back to idle, `resetLoadingState` clears spinners, bridge clients are notified, and `onTurnComplete` fires.

#### Screen Modes

The REPL has two screen modes (`src/screens/REPL.tsx:571`):

```typescript
export type Screen = 'prompt' | 'transcript';
```

- **`prompt`**: Normal mode — message display with prompt input at the bottom. In fullscreen mode, uses `FullscreenLayout` with `AlternateScreen` for smooth scrolling.
- **`transcript`**: Read-only transcript view with virtual scrolling, search (`/` opens `TranscriptSearchBar`), and export-to-editor (`v` key). Toggled via `ctrl+o`.

#### Tool Permission Flow

When Claude requests a tool use, the permission system presents an overlay:
- `PermissionRequest` component renders for `tool-permission` dialog focus
- `SandboxPermissionRequest` handles network access approvals
- `ElicitationDialog` handles MCP elicitation prompts
- `PromptDialog` handles hook-triggered prompts
- `WorkerPendingPermission` shows waiting state on swarm workers

These are deferred while the user is actively typing (`PROMPT_SUPPRESSION_MS = 1500ms` at `src/screens/REPL.tsx:979`) to prevent accidental dismissal.

#### Render Structure

The REPL's render tree (simplified from `src/screens/REPL.tsx:4548+`):

```
KeybindingSetup
├── AnimatedTerminalTitle
├── GlobalKeybindingHandlers
├── VoiceKeybindingHandler (conditional)
├── CommandKeybindingHandlers
├── ScrollKeybindingHandler
├── CancelRequestHandler
└── MCPConnectionManager
    └── FullscreenLayout
        ├── scrollable:
        │   ├── TeammateViewHeader
        │   ├── Messages
        │   ├── AwsAuthStatusBox
        │   ├── UserTextMessage (placeholder)
        │   ├── toolJSX (non-immediate commands)
        │   ├── SpinnerWithVerb / BriefIdleStatus
        │   └── PromptInputQueuedCommands
        ├── bottom:
        │   ├── permissionStickyFooter
        │   ├── toolJSX (immediate commands)
        │   ├── TaskListV2
        │   ├── Permission dialogs
        │   ├── PromptInput / MessageSelector
        │   └── various callout banners
        └── modal: (fullscreen local-jsx commands)
```

### State Management

The REPL manages extensive state via React hooks and the global `AppState` store:

- **Messages**: `useState<MessageType[]>` with a synchronous ref mirror (`messagesRef`) for use in callbacks without stale closures
- **Loading**: Derived from `QueryGuard` (`isQueryActive`) plus external loading (`isExternalLoading`) for remote/background operations
- **Streaming**: `streamMode` (requesting/responding/tool-use), `streamingToolUses`, `streamingThinking` for real-time UI updates
- **Timing**: Wall-clock refs (`loadingStartTimeRef`, `totalPausedMsRef`) for accurate elapsed time in the spinner — avoids re-renders from `useInterval`
- **Screen**: `screen` state toggles between prompt and transcript views

### Conditional Feature Loading

Several features use dead-code elimination via `feature()` (compile-time constants from `bun:bundle`) for conditional imports (`src/screens/REPL.tsx:98-119`):

- `VOICE_MODE`: Voice integration hooks
- `COORDINATOR_MODE`: Multi-agent coordinator context
- `PROACTIVE` / `KAIROS`: Background proactive loop mode
- `BUDDY`: Companion sprite
- `MESSAGE_ACTIONS`: Message-level action system

Ant-only features (frustration detection, org warnings, model switch callout) are gated by `"external" === 'ant'` checks that tree-shake to `false` in external builds.

---

## Doctor Screen

### Purpose

The `Doctor` screen (`src/screens/Doctor.tsx:100`) is a diagnostic panel invoked by the `/doctor` slash command. It presents a comprehensive health check of the Claude Code installation.

### Props

```typescript
type Props = {
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void;
};
```

Single callback prop — called when the user dismisses the diagnostics (Enter/Y/N keybinding).

### Diagnostic Sections

The Doctor screen renders the following sections in a `Pane` (`src/screens/Doctor.tsx:489`):

1. **Diagnostics** — Installation type, version, package manager, binary path, config install method, search (ripgrep) status, and recommendations
2. **Updates** — Auto-update status, channel, permissions, and latest/stable version tags (fetched via `Suspense`-wrapped `DistTagsDisplay` at `src/screens/Doctor.tsx:57`)
3. **Sandbox** — `SandboxDoctorSection` component
4. **MCP Parsing Warnings** — `McpParsingWarnings` component
5. **Keybinding Warnings** — `KeybindingWarnings` component
6. **Environment Variables** — Validates `BASH_MAX_OUTPUT_LENGTH`, `TASK_MAX_OUTPUT_LENGTH`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (`src/screens/Doctor.tsx:144-156`)
7. **Version Locks** — PID-based lock info (if enabled), stale lock cleanup
8. **Agent Parse Errors** — Failed agent definition files
9. **Plugin Errors** — Plugin loading/initialization failures
10. **Unreachable Permission Rules** — Permission rules that can never match
11. **Context Usage Warnings** — Warnings about oversized CLAUDE.md files, agent definitions, or MCP tool descriptions consuming too much context

### Key Types

```typescript
// src/screens/Doctor.tsx:37-50
type AgentInfo = {
  activeAgents: Array<{ agentType: string; source: SettingSource | 'built-in' | 'plugin' }>;
  userAgentsDir: string;
  projectAgentsDir: string;
  userDirExists: boolean;
  projectDirExists: boolean;
  failedFiles?: Array<{ path: string; error: string }>;
};

type VersionLockInfo = {
  enabled: boolean;
  locks: LockInfo[];
  locksDir: string;
  staleLocksCleaned: number;
};
```

---

## ResumeConversation Screen

### Purpose

`ResumeConversation` (`src/screens/ResumeConversation.tsx:67`) handles session restoration when the user runs `claude --resume` or the `/resume` command. It presents a searchable session picker, loads the selected conversation, and then renders the `REPL` with the restored messages.

### Props

```typescript
// src/screens/ResumeConversation.tsx:47-66
type Props = {
  commands: Command[];
  worktreePaths: string[];
  initialTools: Tool[];
  mcpClients?: MCPServerConnection[];
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>;
  debug: boolean;
  mainThreadAgentDefinition?: AgentDefinition;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  initialSearchQuery?: string;
  disableSlashCommands?: boolean;
  forkSession?: boolean;
  taskListId?: string;
  filterByPr?: boolean | number | string;
  thinkingConfig: ThinkingConfig;
  onTurnComplete?: (messages: Message[]) => void | Promise<void>;
};
```

### Key Process: Session Restoration Flow

1. **Load session logs** — On mount, calls `loadSameRepoMessageLogsProgressive(worktreePaths)` to progressively load session logs for the current repository (`src/screens/ResumeConversation.tsx:126-136`).
2. **Filter and display** — Logs are filtered (excluding sidechain sessions, optionally filtering by PR number via `filterByPr` at `src/screens/ResumeConversation.tsx:109-124`), then rendered in a `LogSelector` component with search, lazy loading (`loadMoreLogs`), and a toggle for all-projects view.
3. **User selects a session** — `onSelect` (`src/screens/ResumeConversation.tsx:178`) triggers:
   - Cross-project check — if the session belongs to a different project, copies a CLI command to clipboard and shows instructions
   - `loadConversationForResume()` deserializes the session's messages, file history, and content replacements
   - Session state is restored: `switchSession()`, cost state, session metadata, worktree state, agent definitions, context collapse
   - Coordinator mode warnings are checked
4. **Render REPL** — Once `resumeData` is populated, the component renders `<REPL>` with restored messages, file history snapshots, content replacements, and agent context (`src/screens/ResumeConversation.tsx:297`).

### State Machine

The component progresses through visual states:
- `loading: true` → "Loading conversations..." spinner (`src/screens/ResumeConversation.tsx:299-303`)
- `loading: false`, no selection → `LogSelector` session picker (`src/screens/ResumeConversation.tsx:314`)
- `resuming: true` → "Resuming conversation..." spinner (`src/screens/ResumeConversation.tsx:305-309`)
- `crossProjectCommand` set → `CrossProjectMessage` with clipboard instructions (`src/screens/ResumeConversation.tsx:293-294`)
- `resumeData` set → `REPL` with restored session (`src/screens/ResumeConversation.tsx:296-297`)
- No logs found → `NoConversationsMessage` with exit prompt (`src/screens/ResumeConversation.tsx:311-312`)

### Helper: PR Identifier Parsing

`parsePrIdentifier` (`src/screens/ResumeConversation.tsx:36-46`) parses PR numbers from either direct integers or GitHub PR URLs (e.g. `github.com/org/repo/pull/123`), used for the `filterByPr` prop.

---

## REPL Launcher

### Purpose

`launchRepl` (`src/replLauncher.tsx:12`) is the bootstrap entry point that mounts the application into the Ink rendering root. It uses dynamic imports to code-split the heavy `App` and `REPL` modules.

### Function Signature

```typescript
// src/replLauncher.tsx:12-22
export async function launchRepl(
  root: Root,
  appProps: AppWrapperProps,
  replProps: REPLProps,
  renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>
): Promise<void>
```

**Parameters:**
- `root` — The Ink `Root` instance (custom terminal renderer)
- `appProps` — `{ getFpsMetrics, stats?, initialState }` — context providers for the App wrapper
- `replProps` — Full `REPL` Props (commands, tools, config, etc.)
- `renderAndRun` — Callback that renders the React tree into the Ink root and starts the event loop

### How It Works

The function dynamically imports `App` and `REPL`, then composes them:

```typescript
const { App } = await import('./components/App.js');
const { REPL } = await import('./screens/REPL.js');
await renderAndRun(root, <App {...appProps}><REPL {...replProps} /></App>);
```

The dynamic `import()` calls enable code splitting — the REPL's ~5000-line module and its transitive dependencies are loaded only when needed, keeping the bootstrap path fast.

---

## Edge Cases & Caveats

- **Concurrent query protection**: The `QueryGuard` state machine (`src/screens/REPL.tsx:900`) prevents multiple simultaneous queries. If `onQuery` is called while a query is running, user messages are enqueued via `messageQueueManager` and replayed after the current turn completes.

- **Timing ref reset race**: When `isQueryActive` transitions from false to true, timing refs must be reset inline during the render (not in a `useEffect`) to prevent the spinner from briefly showing ~56 years elapsed (`Date.now() - 0`). See `src/screens/REPL.tsx:946-953`.

- **Ephemeral progress replacement**: Sleep/Bash tool progress messages are replaced in-place rather than appended to prevent the messages array from growing unbounded (13k+ messages observed). Only ephemeral progress types are replaced — agent/hook/skill progress messages are appended because each carries distinct state. See `src/screens/REPL.tsx:2608-2627`.

- **Prompt suppression**: Permission dialogs are deferred for 1500ms after the last keystroke (`PROMPT_SUPPRESSION_MS` at `src/screens/REPL.tsx:979`) to prevent accidental interaction with dialogs the user hasn't read yet.

- **Scroll repin window**: After a user-initiated scroll, auto-scroll-to-bottom is suppressed for 3 seconds (`RECENT_SCROLL_REPIN_WINDOW_MS = 3000` at `src/screens/REPL.tsx:305`) so that scrolling up to read output doesn't snap back when the user starts typing.

- **Cross-project resume**: When resuming a session from a different project directory, `ResumeConversation` copies a CLI command to the clipboard and shows instructions rather than resuming in-place, since the working directory context would be wrong.

- **Dead code elimination**: Feature-gated code uses `feature()` from `bun:bundle` (compile-time constant) and conditional `require()` so that unused feature code (voice, coordinator, proactive, buddy) is completely eliminated from external builds.