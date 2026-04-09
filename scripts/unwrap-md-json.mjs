import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const write = args.includes("--write");
const targetArg = args.find((arg) => !arg.startsWith("--"));
const targetDir = path.resolve(targetArg ?? "web/doc/claude-code");

async function collectMarkdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectMarkdownFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function unwrapMarkdown(raw) {
  let current = raw;
  let depth = 0;

  while (depth < 10) {
    const trimmed = current.trim();
    const parsed = tryParseJson(trimmed);
    if (parsed === undefined) break;

    if (typeof parsed === "string") {
      current = parsed;
      depth++;
      continue;
    }

    if (parsed && typeof parsed === "object" && typeof parsed.content === "string") {
      current = parsed.content;
      depth++;
      continue;
    }

    break;
  }

  return { changed: depth > 0, depth, content: current };
}

function toRelative(filePath) {
  return path.relative(process.cwd(), filePath) || filePath;
}

const files = await collectMarkdownFiles(targetDir);
const issues = [];

for (const file of files) {
  const raw = await readFile(file, "utf-8");
  const result = unwrapMarkdown(raw);
  if (!result.changed) continue;

  issues.push({ file, depth: result.depth });
  console.log(`[wrapped:${result.depth}] ${toRelative(file)}`);

  if (write) {
    await writeFile(file, result.content);
  }
}

console.log(
  write
    ? `Rewrote ${issues.length} markdown file(s) under ${toRelative(targetDir)}.`
    : `Detected ${issues.length} wrapped markdown file(s) under ${toRelative(targetDir)}.`,
);
