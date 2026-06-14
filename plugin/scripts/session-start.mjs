#!/usr/bin/env node
// SessionStart hook: inject a compact index of the memory tree as
// additionalContext. Silent no-op when the project has no .agent-memory/
// or when running inside a curator child process.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { readStdin, projectDirOf, resolveMemoryDir, readTop, parseFrontmatter, MEMORY_DIR_NAME, CURATOR_ENV } from "./lib.mjs";

const CONTEXT_BUDGET = 4000;
const MAX_PAGES_PER_NODE = 12;

if (process.env[CURATOR_ENV]) process.exit(0);

const input = readStdin();
const memDir = resolveMemoryDir(projectDirOf(input));
if (!memDir) process.exit(0);

function pagesOf(nodePath) {
  try {
    return readdirSync(path.join(memDir, "tree", nodePath))
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => {
        let description = "";
        try {
          const { meta } = parseFrontmatter(readFileSync(path.join(memDir, "tree", nodePath, f), "utf8"));
          description = meta?.description ?? "";
        } catch { /* unreadable page → name only */ }
        return { name: f.replace(/\.md$/, ""), description };
      });
  } catch {
    return [];
  }
}

function stagingLeftovers() {
  try {
    return readdirSync(path.join(memDir, "staging")).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

const top = readTop(memDir);
const nodes = [...top.nodes].sort((a, b) => a.path.localeCompare(b.path));
const leftovers = stagingLeftovers();
if (nodes.length === 0 && leftovers.length === 0) process.exit(0);

const lines = [`# Project memory tree (${MEMORY_DIR_NAME}/)`];
if (top.description) lines.push(top.description);
lines.push("");

let totalPages = 0;
for (const node of nodes) {
  const pages = pagesOf(node.path);
  totalPages += pages.length;
  lines.push(`## ${node.path}${node.description ? ` — ${node.description}` : ""} (${pages.length})`);
  for (const page of pages.slice(0, MAX_PAGES_PER_NODE)) {
    lines.push(`- ${page.name}${page.description ? ` — ${page.description}` : ""}`);
  }
  if (pages.length > MAX_PAGES_PER_NODE) {
    lines.push(`- …+${pages.length - MAX_PAGES_PER_NODE} more — Glob ${MEMORY_DIR_NAME}/tree/${node.path}/*.md`);
  }
  lines.push("");
}

if (leftovers.length > 0) {
  lines.push(`⚠ ${leftovers.length} proposal(s) still in ${MEMORY_DIR_NAME}/staging/ (${leftovers.join(", ")}) — rejected by the curator (see their \`rejected:\` frontmatter) or not yet consolidated. Fix, resubmit, or delete them.`);
  lines.push("");
}

lines.push(`Recall: Read ${MEMORY_DIR_NAME}/tree/<path>/<name>.md before relying on a memory. Record durable knowledge via the memory skill (write a proposal to ${MEMORY_DIR_NAME}/staging/); the memory-curator agent consolidates it into the tree automatically. For reorganizing or auditing the tree itself, delegate to the kioku memory-curator agent.`);

let context = lines.join("\n");
if (context.length > CONTEXT_BUDGET) {
  const summary = nodes.map((n) => `${n.path} (${pagesOf(n.path).length})`).join(", ");
  context = [
    `# Project memory tree (${MEMORY_DIR_NAME}/)`,
    top.description,
    "",
    `${totalPages} pages across nodes: ${summary}.`,
    `Index too large to inline — browse with Glob ${MEMORY_DIR_NAME}/tree/**/*.md and Read pages on demand. Record via the memory skill (proposals to ${MEMORY_DIR_NAME}/staging/).`,
  ].filter(Boolean).join("\n");
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
}));
