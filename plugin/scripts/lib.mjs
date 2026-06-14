// Shared core for the kioku memory plugin.
// Zero-dependency Node (>=18). Memory library layout:
//
//   .agent-memory/
//   ├── top.json            tree index: { version, description, nodes: [{ path, description }] }
//   ├── tree/<path>/<name>.md   memory pages, recursive tree (curator-managed)
//   ├── staging/            the ONLY place ordinary agents write (proposals)
//   ├── update-log.jsonl    consolidation provenance, append-only (engine-managed)
//   └── .git/               independent git repo (engine-managed)
//
// Write authority: ordinary agents → staging/ only (schema-gated);
// the memory-curator agent (KIOKU_CURATOR env or agent_type) → tree/ and
// top.json, still schema-gated; provenance stamps and git commits → engine.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const MEMORY_DIR_NAME = ".agent-memory";
export const CURATOR_ENV = "KIOKU_CURATOR";
export const CURATOR_AGENT = "memory-curator";
export const TYPES = ["user", "feedback", "project", "reference"];
export const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_BODY_CHARS = 6000;

export function readStdin() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function projectDirOf(input) {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}

export function isCuratorContext(input = {}) {
  if (process.env[CURATOR_ENV]) return true;
  return typeof input.agent_type === "string" && input.agent_type.includes(CURATOR_AGENT);
}

// AGENT_MEMORY_DIR overrides; otherwise walk up from startDir looking for .agent-memory/.
export function resolveMemoryDir(startDir, { mustExist = true } = {}) {
  const override = process.env.AGENT_MEMORY_DIR;
  if (override) {
    const abs = path.resolve(override);
    return !mustExist || existsSync(abs) ? abs : null;
  }
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, MEMORY_DIR_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return mustExist ? null : path.join(path.resolve(startDir), MEMORY_DIR_NAME);
    dir = parent;
  }
}

export function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Tree node paths are slash-joined kebab segments, e.g. "conventions/frontend".
export function isTreePath(p) {
  return typeof p === "string" && p.length > 0 && p.split("/").every((seg) => KEBAB.test(seg));
}

// Minimal frontmatter: `key: value` scalars and dash-list blocks. Quotes around
// scalar values are stripped. Unknown keys are preserved round-trip.
export function parseFrontmatter(text) {
  const normalized = text.replace(/^﻿/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: null, body: normalized };
  const meta = {};
  const lines = match[1].split(/\r?\n/);
  let listKey = null;
  for (const line of lines) {
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && listKey) {
      meta[listKey].push(unquote(item[1].trim()));
      continue;
    }
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) { listKey = null; continue; }
    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    if (value === "") {
      meta[key] = [];
      listKey = key;
    } else {
      meta[key] = unquote(value);
      listKey = null;
    }
  }
  return { meta, body: match[2] };
}

function unquote(value) {
  const m = value.match(/^"(.*)"$/) || value.match(/^'(.*)'$/);
  return m ? m[1] : value;
}

export function serializeFrontmatter(meta, body) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n") + body.replace(/^\n+/, "");
}

// Validates a memory page (staging proposal or curated tree page). The same
// schema gates both: ordinary agents on Write to staging/, the curator on
// Write to tree/. Engine-stamped fields (createdAt/updatedAt/sourceSession/
// sourceSha) are optional here and overwritten by the engine.
export function validatePage(filename, text, { requirePath } = {}) {
  const errors = [];
  if (!filename.endsWith(".md")) errors.push(`memory page must be a .md file, got "${filename}"`);
  const stem = filename.replace(/\.md$/, "");
  if (!KEBAB.test(stem)) errors.push(`filename must be kebab-case (a-z, 0-9, hyphens), got "${stem}"`);

  const { meta, body } = parseFrontmatter(text);
  if (!meta) {
    errors.push("missing frontmatter block (--- ... ---) at the top of the file");
    return { errors, meta: null, body };
  }
  if (!meta.name) errors.push("frontmatter is missing required field: name");
  else if (meta.name !== stem) errors.push(`frontmatter name "${meta.name}" must equal the filename stem "${stem}"`);
  if (!meta.description || typeof meta.description !== "string") {
    errors.push("frontmatter is missing required field: description (one-line summary used for recall)");
  } else if (meta.description.length > 200) {
    errors.push("description must be at most 200 characters");
  }
  if (!meta.type) errors.push(`frontmatter is missing required field: type (one of ${TYPES.join(" | ")})`);
  else if (!TYPES.includes(meta.type)) errors.push(`type must be one of ${TYPES.join(" | ")}, got "${meta.type}"`);
  if (meta.path !== undefined && !isTreePath(meta.path)) {
    errors.push(`path must be slash-joined kebab segments (e.g. conventions/frontend), got "${meta.path}"`);
  }
  if (requirePath && meta.path !== undefined && meta.path !== requirePath) {
    errors.push(`frontmatter path "${meta.path}" must match the page's tree location "${requirePath}"`);
  }
  if (meta.scope !== undefined && !Array.isArray(meta.scope)) {
    errors.push("scope must be a dash-list of strings (file globs, tool names, or task tags)");
  }
  const trimmedBody = body.trim();
  if (!trimmedBody) errors.push("body is empty — state the fact, why it matters, and how to apply it");
  if (trimmedBody.length > MAX_BODY_CHARS) {
    errors.push(`body exceeds ${MAX_BODY_CHARS} characters — memories must stay focused; split or condense`);
  }
  return { errors, meta, body };
}

// Validates top.json content written by the curator.
export function validateTop(text) {
  const errors = [];
  let top = null;
  try {
    top = JSON.parse(text);
  } catch (e) {
    return { errors: [`top.json must be valid JSON: ${e.message}`], top: null };
  }
  if (typeof top.description !== "string") errors.push("top.json requires a string `description`");
  if (!Array.isArray(top.nodes)) {
    errors.push("top.json requires a `nodes` array of { path, description }");
  } else {
    for (const node of top.nodes) {
      if (!isTreePath(node?.path)) errors.push(`node path must be slash-joined kebab segments, got "${node?.path}"`);
      if (typeof node?.description !== "string") errors.push(`node "${node?.path}" requires a string description`);
    }
    const paths = top.nodes.map((n) => n?.path);
    const dupes = paths.filter((p, i) => paths.indexOf(p) !== i);
    if (dupes.length > 0) errors.push(`duplicate node paths: ${[...new Set(dupes)].join(", ")}`);
  }
  return { errors, top };
}

export function readTop(memDir) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(memDir, "top.json"), "utf8"));
    if (Array.isArray(parsed.nodes)) return parsed;
  } catch { /* missing or corrupt → fresh index */ }
  return { version: 2, description: "", nodes: [] };
}
