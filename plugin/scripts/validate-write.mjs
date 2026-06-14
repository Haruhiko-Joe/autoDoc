#!/usr/bin/env node
// PreToolUse hook (matcher: Write|Edit). Two-tier deterministic gate:
//   - ordinary agents: may only write proposals in staging/ (schema-validated,
//     auto-allowed when valid); the tree and top.json are denied with guidance.
//   - the memory-curator (KIOKU_CURATOR env in headless runs, or the
//     memory-curator subagent): may write tree pages and top.json, still
//     schema-validated — an LLM curator does the semantics, this gate keeps
//     the structure sound.
// Paths outside the memory library produce no opinion (normal permission flow).

import path from "node:path";
import { readStdin, projectDirOf, resolveMemoryDir, isWithin, isCuratorContext, validatePage, validateTop, TYPES } from "./lib.mjs";

function decide(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

const SCHEMA_HINT = [
  "A valid memory page is <kebab-name>.md with frontmatter:",
  "---",
  "name: <kebab-name>            # must equal the filename stem",
  "description: <one-line summary used for recall>",
  `type: <${TYPES.join(" | ")}>`,
  "path: <tree node, e.g. conventions/frontend>   # optional in proposals; the curator decides final placement",
  "scope:                        # optional dash-list: file globs / tools / task tags",
  "  - <item>",
  "---",
  "<body: the fact, why it matters, how to apply it>",
].join("\n");

const input = readStdin();
const toolName = input.tool_name;
if (toolName !== "Write" && toolName !== "Edit") process.exit(0);

const filePath = input.tool_input?.file_path;
if (typeof filePath !== "string" || filePath.length === 0) process.exit(0);

const projectDir = projectDirOf(input);
const memDir = resolveMemoryDir(projectDir);
if (!memDir) process.exit(0);

const abs = path.resolve(projectDir, filePath);
if (!isWithin(memDir, abs)) process.exit(0);

const rel = path.relative(memDir, abs);
const segments = rel.split(path.sep);
const curator = isCuratorContext(input);

// --- staging/: open to every agent, schema-gated on Write ---
if (segments[0] === "staging") {
  if (segments.length !== 2) decide("deny", "kioku: proposals must be direct children of .agent-memory/staging/ (no subdirectories).");
  if (!rel.endsWith(".md")) decide("deny", "kioku: proposals must be Markdown (.md) files.");
  if (toolName === "Edit") decide("allow", "kioku: editing a staging proposal (re-validated at consolidation).");
  const { errors } = validatePage(path.basename(abs), String(input.tool_input?.content ?? ""));
  if (errors.length > 0) decide("deny", `kioku: proposal rejected:\n- ${errors.join("\n- ")}\n\n${SCHEMA_HINT}`);
  decide("allow", "kioku: proposal schema OK — the memory-curator will consolidate it into the tree.");
}

// --- tree/ and top.json: curator-only, still schema-gated ---
if (!curator) {
  decide("deny", `kioku: ${rel} is maintained by the memory-curator agent. To add or update a memory, write a proposal to .agent-memory/staging/<name>.md — the curator consolidates it into the tree. To reorganize the tree itself, delegate to the kioku memory-curator agent.\n\n${SCHEMA_HINT}`);
}

if (rel === "top.json") {
  if (toolName === "Edit") decide("allow", "kioku(curator): editing top.json (keep nodes as { path, description }).");
  const { errors } = validateTop(String(input.tool_input?.content ?? ""));
  if (errors.length > 0) decide("deny", `kioku(curator): top.json rejected:\n- ${errors.join("\n- ")}`);
  decide("allow", "kioku(curator): top.json schema OK.");
}

if (segments[0] === "tree") {
  if (segments.length < 3) decide("deny", "kioku(curator): pages must live under a tree node (tree/<path>/<name>.md), never directly in tree/.");
  if (!rel.endsWith(".md")) decide("deny", "kioku(curator): tree pages must be Markdown (.md) files.");
  if (toolName === "Edit") decide("allow", "kioku(curator): editing a tree page.");
  const nodePath = segments.slice(1, -1).join("/");
  const { errors } = validatePage(path.basename(abs), String(input.tool_input?.content ?? ""), { requirePath: nodePath });
  if (errors.length > 0) decide("deny", `kioku(curator): page rejected:\n- ${errors.join("\n- ")}\n\n${SCHEMA_HINT}`);
  decide("allow", "kioku(curator): page schema OK.");
}

decide("deny", `kioku: ${rel} is engine-managed (provenance log, git internals) and never written by agents.`);
