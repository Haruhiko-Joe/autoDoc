# Team and Messaging Tools

## Overview & Responsibilities

The Team and Messaging module provides the coordination primitives for **coordinator-mode multi-agent collaboration** in Claude Code. It sits within the **AgentAndOrchestration** group of the **ToolSystem**, enabling a team lead agent to create teams, send messages between agents, and tear down teams when work is complete.

The module comprises three tools:

| Tool | Purpose |
|------|---------|
| **TeamCreateTool** | Bootstraps a new team: writes the team config file, initializes the task list, registers the team lead, and sets up session cleanup |
| **SendMessageTool** | Delivers messages between agents — supports plain text, broadcasts, structured protocol messages (shutdown, plan approval), cross-session bridge/UDS relay, and auto-resume of stopped agents |
| **TeamDeleteTool** | Validates no active members remain, removes team and task directories, clears color assignments and app state |

All three tools are gated behind the `isAgentSwarmsEnabled()` feature flag and share the same `buildTool` construction pattern. They are deferred tools (`shouldDefer: true`), meaning they are only loaded when needed.

**Sibling context**: Within AgentAndOrchestration, the **AgentTool** handles spawning individual subagents, while these three tools handle the higher-level team lifecycle and inter-agent communication. Task management tools (TaskCreate/Update/List) provide the shared work queue that teams coordinate around.

---

## Key Processes

### Team Creation Flow (TeamCreateTool)

1. **Check single-team constraint** — A leader can manage only one team at a time. If `appState.teamContext.teamName` already exists, the tool throws an error (`src/tools/TeamCreateTool/TeamCreateTool.ts:136-139`).

2. **Generate unique name** — If the provided `team_name` collides with an existing team file on disk, `generateUniqueTeamName()` generates a fresh word slug instead of failing (`src/tools/TeamCreateTool/TeamCreateTool.ts:64-72`).

3. **Build the team file** — Constructs a `TeamFile` object containing the team name, leader's agent ID (formatted as `team-lead@<teamName>`), leader session ID, and an initial `members` array with just the leader (`src/tools/TeamCreateTool/TeamCreateTool.ts:157-175`).

4. **Write config and register for cleanup** — Persists the team file to `~/.claude/teams/{team-name}/config.json` via `writeTeamFileAsync()`, then calls `registerTeamForSessionCleanup()` so the team directories are removed on session exit, preventing stale teams on disk (`src/tools/TeamCreateTool/TeamCreateTool.ts:177-180`).

5. **Initialize task list** — Resets and creates the task directory at `~/.claude/tasks/{team-name}/` via `resetTaskList()` and `ensureTasksDir()`. Also calls `setLeaderTeamName()` so that `getTaskListId()` resolves to the team name for the leader, keeping all teammates writing tasks to the same directory (`src/tools/TeamCreateTool/TeamCreateTool.ts:184-191`).

6. **Update AppState** — Sets `teamContext` with the team name, leader info, and assigns the leader a display color via `assignTeammateColor()` (`src/tools/TeamCreateTool/TeamCreateTool.ts:194-212`).

7. **Log analytics** — Fires a `tengu_team_created` event with team name, count, and teammate mode (`src/tools/TeamCreateTool/TeamCreateTool.ts:214-222`).

### Message Sending Flow (SendMessageTool)

The `call()` method in `src/tools/SendMessageTool/SendMessageTool.ts:741-913` implements a multi-stage routing pipeline:

#### Stage 1: Cross-Session Routing (Feature-Flagged)

When the `UDS_INBOX` feature is enabled, the tool inspects the `to` address scheme:

- **`bridge:<session-id>`** — Sends a plain-text message to a Remote Control peer session via `postInterClaudeMessage()`. Re-validates the bridge handle before sending (it may have dropped during the permission prompt). Requires explicit user consent via `checkPermissions()` (`src/tools/SendMessageTool/SendMessageTool.ts:742-774`).
- **`uds:<socket-path>`** — Sends to a local Claude session's Unix domain socket via `sendToUdsSocket()` (`src/tools/SendMessageTool/SendMessageTool.ts:775-798`).

#### Stage 2: In-Process Agent Routing

For plain-text messages to a named recipient (not `*`), the tool checks the `agentNameRegistry` in AppState:

- **Running agent** — Queues the message via `queuePendingMessage()` for delivery at the agent's next tool round (`src/tools/SendMessageTool/SendMessageTool.ts:809-821`).
- **Stopped agent** — Auto-resumes the agent in the background via `resumeAgentBackground()` with the message as the prompt (`src/tools/SendMessageTool/SendMessageTool.ts:823-844`).
- **Evicted agent** — Attempts resume from the on-disk transcript (`src/tools/SendMessageTool/SendMessageTool.ts:850-872`).

#### Stage 3: Mailbox-Based Team Messaging

If no in-process agent matched:

- **Broadcast (`to: "*"`)** — Iterates all team members (excluding the sender), writes the message to each member's mailbox file via `writeToMailbox()` (`handleBroadcast`, `src/tools/SendMessageTool/SendMessageTool.ts:191-266`).
- **Direct message** — Writes to the recipient's mailbox file (`handleMessage`, `src/tools/SendMessageTool/SendMessageTool.ts:149-189`).

#### Stage 4: Structured Protocol Messages

For non-string messages, the tool dispatches based on `message.type`:

| Type | Handler | Behavior |
|------|---------|----------|
| `shutdown_request` | `handleShutdownRequest()` | Writes a shutdown request with a generated `request_id` to the target's mailbox |
| `shutdown_response` (approve) | `handleShutdownApproval()` | Writes approval to the team lead's mailbox, then terminates the current agent — either by aborting the in-process task's `AbortController` or calling `gracefulShutdown()` |
| `shutdown_response` (reject) | `handleShutdownRejection()` | Writes rejection with reason to the team lead's mailbox; agent continues working |
| `plan_approval_response` (approve) | `handlePlanApproval()` | Team-lead-only; writes approval with inherited permission mode to the teammate's mailbox |
| `plan_approval_response` (reject) | `handlePlanRejection()` | Team-lead-only; writes rejection with feedback to the teammate's mailbox |

### Team Deletion Flow (TeamDeleteTool)

1. **Check for active members** — Reads the team config, filters out the team lead, then checks for members where `isActive !== false`. If any are still active, the tool refuses and returns an error listing their names (`src/tools/TeamDeleteTool/TeamDeleteTool.ts:80-98`).

2. **Clean up directories** — Calls `cleanupTeamDirectories()` to remove both `~/.claude/teams/{name}/` and `~/.claude/tasks/{name}/`, then unregisters from session cleanup (`src/tools/TeamDeleteTool/TeamDeleteTool.ts:101-103`).

3. **Clear runtime state** — Clears teammate color assignments via `clearTeammateColors()`, clears the leader team name binding, and resets `teamContext` and `inbox` in AppState (`src/tools/TeamDeleteTool/TeamDeleteTool.ts:106-124`).

---

## Function Signatures

### TeamCreateTool.call

```typescript
async call(input: {
  team_name: string;
  description?: string;
  agent_type?: string;
}, context: ToolUseContext): Promise<{ data: Output }>
```

Returns `{ team_name, team_file_path, lead_agent_id }`.

> Source: `src/tools/TeamCreateTool/TeamCreateTool.ts:128-237`

### SendMessageTool.call

```typescript
async call(input: {
  to: string;       // recipient name, "*", "uds:<path>", or "bridge:<session>"
  summary?: string;  // 5-10 word preview (required for plain text)
  message: string | StructuredMessage;
}, context: ToolUseContext, canUseTool, assistantMessage): Promise<{ data: SendMessageToolOutput }>
```

`SendMessageToolOutput` is a union of `MessageOutput | BroadcastOutput | RequestOutput | ResponseOutput`.

> Source: `src/tools/SendMessageTool/SendMessageTool.ts:741-913`

### TeamDeleteTool.call

```typescript
async call(_input: {}, context: ToolUseContext): Promise<{ data: Output }>
```

Takes no input parameters — derives the team name from `appState.teamContext`. Returns `{ success, message, team_name? }`.

> Source: `src/tools/TeamDeleteTool/TeamDeleteTool.ts:71-135`

---

## Type Definitions

### StructuredMessage (SendMessageTool)

A discriminated union over three protocol message types:

```typescript
// Defined via zod discriminatedUnion at src/tools/SendMessageTool/SendMessageTool.ts:46-65
| { type: "shutdown_request"; reason?: string }
| { type: "shutdown_response"; request_id: string; approve: boolean; reason?: string }
| { type: "plan_approval_response"; request_id: string; approve: boolean; feedback?: string }
```

### MessageRouting

Attached to successful message/broadcast results for UI rendering:

```typescript
type MessageRouting = {
  sender: string;
  senderColor?: string;
  target: string;       // "@name" or "@team"
  targetColor?: string;
  summary?: string;
  content?: string;
}
```

> Source: `src/tools/SendMessageTool/SendMessageTool.ts:92-99`

### TeamFile (external type)

Defined in `src/utils/swarm/teamHelpers.ts`. Contains `name`, `description`, `createdAt`, `leadAgentId`, `leadSessionId`, and a `members` array where each member has `agentId`, `name`, `agentType`, `model`, `joinedAt`, `tmuxPaneId`, `cwd`, `subscriptions`, `isActive?`, and `backendType?`.

---

## Configuration & Defaults

- **Feature gate**: All three tools are only available when `isAgentSwarmsEnabled()` returns true.
- **UDS_INBOX feature**: Cross-session messaging (bridge and UDS targets) is additionally gated behind the `UDS_INBOX` compile-time feature flag (`feature('UDS_INBOX')`).
- **Team file location**: `~/.claude/teams/{team-name}/config.json`
- **Task list location**: `~/.claude/tasks/{team-name}/`
- **Team lead name**: Constant `TEAM_LEAD_NAME` (imported from `src/utils/swarm/constants.ts`) — used as the canonical name for the leader in member lists and mailbox routing.
- **Leader model**: Resolved from `appState.mainLoopModelForSession`, falling back to `appState.mainLoopModel`, then `getDefaultMainLoopModel()`.
- **Max result size**: All three tools set `maxResultSizeChars: 100_000`.

---

## Edge Cases & Caveats

- **One team per leader**: `TeamCreateTool` enforces a single active team. Attempting to create a second team throws an error directing the user to call `TeamDelete` first (`src/tools/TeamCreateTool/TeamCreateTool.ts:136-139`).

- **Name collision handling**: If a team with the requested name already exists on disk, a random word slug is generated instead. The tool does **not** fail — it silently picks a new name (`src/tools/TeamCreateTool/TeamCreateTool.ts:64-72`).

- **Team lead is not a teammate**: The `CLAUDE_CODE_AGENT_ID` env var is intentionally **not** set for the leader. This ensures `isTeammate()` returns false for the leader, preventing them from polling an inbox (`src/tools/TeamCreateTool/TeamCreateTool.ts:224-228`).

- **Active member check on delete**: `TeamDeleteTool` will refuse to clean up if any non-lead members have `isActive !== false`. The error message suggests using `requestShutdown` first (`src/tools/TeamDeleteTool/TeamDeleteTool.ts:89-98`).

- **Bridge handle staleness**: `SendMessageTool` re-checks `getReplBridgeHandle()` and `isReplBridgeActive()` inside `call()` even though `validateInput()` already checked — the bridge may have dropped during the user permission prompt (`src/tools/SendMessageTool/SendMessageTool.ts:748-756`).

- **Shutdown approval terminates the process**: When a teammate approves a shutdown, the handler either aborts the in-process task's `AbortController` or calls `gracefulShutdown(0, 'other')` via `setImmediate`. This is intentionally non-reversible (`src/tools/SendMessageTool/SendMessageTool.ts:348-390`).

- **Plan approval is lead-only**: Both `handlePlanApproval()` and `handlePlanRejection()` check `isTeamLead()` and throw if a non-lead agent attempts it. The leader's permission mode is inherited by the approved teammate (with `plan` mode falling back to `default`) (`src/tools/SendMessageTool/SendMessageTool.ts:442-446, 448-449`).

- **Broadcast excludes structured messages**: Validation rejects structured messages sent to `"*"` — only plain text can be broadcast (`src/tools/SendMessageTool/SendMessageTool.ts:678-684`).

- **Summary required for plain text**: When sending a plain text message within a team (not cross-session UDS), a `summary` field is required for the UI preview notification (`src/tools/SendMessageTool/SendMessageTool.ts:667-675`).

- **UI suppression**: `TeamDeleteTool`'s `renderToolResultMessage` returns `null` for all outputs — the batched shutdown message in the UI covers the cleanup result. Similarly, `SendMessageTool` returns `null` for routing results and request outputs, showing only fallback messages (`src/tools/TeamDeleteTool/UI.tsx:15-17`, `src/tools/SendMessageTool/UI.tsx:21-26`).

---

## Key Code Snippets

### Team file construction (TeamCreateTool)

```typescript
// src/tools/TeamCreateTool/TeamCreateTool.ts:157-175
const teamFile: TeamFile = {
  name: finalTeamName,
  description: _description,
  createdAt: Date.now(),
  leadAgentId,
  leadSessionId: getSessionId(),
  members: [
    {
      agentId: leadAgentId,
      name: TEAM_LEAD_NAME,
      agentType: leadAgentType,
      model: leadModel,
      joinedAt: Date.now(),
      tmuxPaneId: '',
      cwd: getCwd(),
      subscriptions: [],
    },
  ],
}
```

### In-process agent routing with auto-resume (SendMessageTool)

```typescript
// src/tools/SendMessageTool/SendMessageTool.ts:802-873
if (typeof input.message === 'string' && input.to !== '*') {
  const appState = context.getAppState()
  const registered = appState.agentNameRegistry.get(input.to)
  const agentId = registered ?? toAgentId(input.to)
  if (agentId) {
    const task = appState.tasks[agentId]
    if (isLocalAgentTask(task) && !isMainSessionTask(task)) {
      if (task.status === 'running') {
        queuePendingMessage(agentId, input.message, ...)
        // ...
      }
      // task exists but stopped — auto-resume
      const result = await resumeAgentBackground({ agentId, prompt: input.message, ... })
      // ...
    }
  }
}
```

### Active member guard on delete (TeamDeleteTool)

```typescript
// src/tools/TeamDeleteTool/TeamDeleteTool.ts:80-98
const nonLeadMembers = teamFile.members.filter(m => m.name !== TEAM_LEAD_NAME)
const activeMembers = nonLeadMembers.filter(m => m.isActive !== false)
if (activeMembers.length > 0) {
  const memberNames = activeMembers.map(m => m.name).join(', ')
  return {
    data: {
      success: false,
      message: `Cannot cleanup team with ${activeMembers.length} active member(s): ${memberNames}. Use requestShutdown to gracefully terminate teammates first.`,
    },
  }
}
```