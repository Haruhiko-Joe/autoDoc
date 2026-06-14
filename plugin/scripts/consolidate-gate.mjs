#!/usr/bin/env node
// Stop + SessionEnd hook: the consolidation gate (modeled on the Codex
// plugin's stop-review gate). Cheap short-circuits first; when proposals are
// pending it runs the memory-curator agent headlessly (`claude -p`) to
// consolidate them into the tree, then does the deterministic bookkeeping
// the LLM is never trusted with: provenance stamps, update-log, git commit.
// Never blocks the session: failures leave proposals in staging/ and are
// surfaced by the next SessionStart.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStdin, projectDirOf, resolveMemoryDir, readTop, parseFrontmatter, serializeFrontmatter, CURATOR_ENV } from "./lib.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CURATOR_TIMEOUT_MS = 10 * 60 * 1000;

// Recursion guard: the headless curator child loads this plugin too.
if (process.env[CURATOR_ENV]) process.exit(0);

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(cwd, args) {
  try { return git(cwd, args); } catch { return null; }
}

function ensureRepo(memDir) {
  if (existsSync(path.join(memDir, ".git"))) return;
  git(memDir, ["init", "-q"]);
  git(memDir, ["config", "user.name", "kioku"]);
  git(memDir, ["config", "user.email", "kioku@agent-memory.local"]);
}

function stagingProposals(memDir) {
  const dir = path.join(memDir, "staging");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
}

// Proposals the curator has explicitly rejected keep a `rejected:` marker and
// must not retrigger the gate every turn.
function pendingProposals(memDir) {
  return stagingProposals(memDir).filter((f) => {
    try {
      const { meta } = parseFrontmatter(readFileSync(path.join(memDir, "staging", f), "utf8"));
      return !meta?.rejected;
    } catch {
      return true;
    }
  });
}

function loadCuratorSystemPrompt() {
  const raw = readFileSync(path.join(ROOT_DIR, "agents", "memory-curator.md"), "utf8");
  return parseFrontmatter(raw).body.trim();
}

function buildTaskPrompt(memDir, proposals) {
  const template = readFileSync(path.join(ROOT_DIR, "prompts", "consolidate.md"), "utf8");
  const top = readTop(memDir);
  const treeIndex = top.nodes.length > 0
    ? top.nodes.map((n) => `- ${n.path} — ${n.description}`).join("\n")
    : "(empty tree — no nodes yet)";
  return template
    .replaceAll("{{MEMORY_DIR}}", memDir)
    .replaceAll("{{TREE_INDEX}}", treeIndex)
    .replaceAll("{{STAGING_LIST}}", proposals.map((f) => `- staging/${f}`).join("\n"));
}

function runCurator(projectDir, memDir, proposals, sessionId) {
  const args = [
    "-p", buildTaskPrompt(memDir, proposals),
    "--append-system-prompt", loadCuratorSystemPrompt(),
    "--allowedTools", `Read,Grep,Glob,Write,Edit,Bash(rm ${path.relative(projectDir, memDir) || "."}/*)`,
    ...(process.env.KIOKU_MODEL ? ["--model", process.env.KIOKU_MODEL] : []),
  ];
  const result = spawnSync("claude", args, {
    cwd: projectDir,
    encoding: "utf8",
    timeout: CURATOR_TIMEOUT_MS,
    env: { ...process.env, [CURATOR_ENV]: "1", ...(sessionId ? { KIOKU_PARENT_SESSION: sessionId } : {}) },
  });
  if (result.error?.code === "ENOENT") return { ok: false, note: "kioku: `claude` CLI not found on PATH — proposals stay in staging/." };
  if (result.error?.code === "ETIMEDOUT") return { ok: false, note: "kioku: curator timed out after 10 minutes — proposals stay in staging/." };
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim().slice(0, 300);
    return { ok: false, note: `kioku: curator run failed — proposals stay in staging/.${detail ? ` ${detail}` : ""}` };
  }
  const stdout = String(result.stdout ?? "").trim();
  const summaryLine = stdout.split(/\r?\n/).reverse().find((l) => l.startsWith("SUMMARY:"));
  return { ok: true, summary: summaryLine ? summaryLine.slice("SUMMARY:".length).trim() : stdout.slice(-300) };
}

// Deterministic bookkeeping after the curator: stamp provenance on every tree
// page it touched, log, and commit.
function stampAndCommit(projectDir, memDir, sessionId, eventName, summary) {
  const now = new Date().toISOString();
  const sourceSha = tryGit(projectDir, ["rev-parse", "HEAD"]);
  const porcelain = tryGit(memDir, ["status", "--porcelain"]) ?? "";
  const touched = porcelain.split("\n").filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, ""))
    .filter((f) => f.startsWith("tree/") && f.endsWith(".md") && existsSync(path.join(memDir, f)));

  for (const rel of touched) {
    try {
      const { meta, body } = parseFrontmatter(readFileSync(path.join(memDir, rel), "utf8"));
      if (!meta) continue;
      const stamped = {
        ...meta,
        path: rel.split("/").slice(1, -1).join("/"),
        sourceSession: sessionId ?? meta.sourceSession ?? "unknown",
        ...(sourceSha ? { sourceSha } : {}),
        createdAt: meta.createdAt ?? now,
        updatedAt: now,
      };
      delete stamped.rejected;
      writeFileSync(path.join(memDir, rel), serializeFrontmatter(stamped, body.trim() + "\n"));
    } catch { /* leave the page as the curator wrote it */ }
  }

  appendFileSync(path.join(memDir, "update-log.jsonl"), JSON.stringify({
    ts: now,
    session: sessionId ?? "unknown",
    event: eventName,
    ...(sourceSha ? { sourceSha } : {}),
    touched,
    leftInStaging: stagingProposals(memDir),
    summary,
  }) + "\n");

  git(memDir, ["add", "-A"]);
  if (tryGit(memDir, ["status", "--porcelain"])) {
    git(memDir, ["commit", "-q", "-m", `kioku: consolidate session ${String(sessionId ?? "unknown").slice(0, 8)} — ${touched.length} page(s)`]);
  }
  return touched;
}

try {
  const input = readStdin();
  const projectDir = projectDirOf(input);
  const memDir = resolveMemoryDir(projectDir);
  if (!memDir) process.exit(0);

  const proposals = pendingProposals(memDir);
  if (proposals.length === 0) process.exit(0);

  ensureRepo(memDir);
  const sessionId = input.session_id ?? null;
  const run = runCurator(projectDir, memDir, proposals, sessionId);
  if (!run.ok) {
    console.error(run.note);
    process.exit(0);
  }

  const touched = stampAndCommit(projectDir, memDir, sessionId, input.hook_event_name ?? "Stop", run.summary);
  const leftover = stagingProposals(memDir);
  const message = `kioku: consolidated ${proposals.length} proposal(s) → ${touched.length} tree page(s) committed.${leftover.length ? ` ${leftover.length} left in staging (rejected).` : ""}${run.summary ? ` ${run.summary}` : ""}`;
  process.stdout.write(JSON.stringify({ systemMessage: message }));
} catch (e) {
  console.error(`kioku: consolidation gate failed (session unaffected): ${e?.message ?? e}`);
}
process.exit(0);
