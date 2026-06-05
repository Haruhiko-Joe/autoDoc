import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

type Variant = "full" | "no-edges" | "flat-md";

type Options = {
  project: string;
  docRoot: string;
  outRoot: string;
  variants: Variant[];
  overwrite: boolean;
};

type FlatEntry = {
  sourcePath: string;
  outputFile: string;
  ref: string;
  title: string;
};

const VARIANTS: readonly Variant[] = ["full", "no-edges", "flat-md"];
const FLAT_MODULE = "FlatMarkdown";
const SKIP_DIRS = new Set(["_pending"]);

function usage(): string {
  return [
    "Usage: pnpm exec tsx bench/scripts/generate-ablation-docs.ts [options]",
    "",
    "Creates doc-drill-compatible documentation variants for ablation experiments:",
    "  - full:     sanitized copy of original ACCEED docs",
    "  - no-edges: tree + pages only; typed edges and flows removed",
    "  - flat-md:  all leaf markdown pages exposed under one flat doc-drill graph",
    "",
    "Options:",
    "  --project <name>      Project name in doc root (default: git)",
    "  --doc-root <path>     ACCEED docs root (default: src/souko/doc)",
    "  --out-root <path>     Output root (default: bench/data/ablation-docs)",
    "  --variants <list>     Comma-separated: full,no-edges,flat-md",
    "  --overwrite           Replace existing outputs",
    "  --help                Show this help",
  ].join("\n");
}

function parseFlagMap(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) break;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      values.set(key, "true");
      index += 1;
    } else {
      values.set(key, next);
      index += 2;
    }
  }
  return values;
}

function splitList(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

async function assertDirectory(dir: string, label: string): Promise<void> {
  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`${label} is not a directory: ${dir}`);
}

async function assertFile(filePath: string, label: string): Promise<void> {
  const info = await stat(filePath).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`${label} is not a file: ${filePath}`);
}

function parseArgs(argv: string[]): Options {
  const values = parseFlagMap(argv);
  if (values.has("help") || values.has("h")) {
    console.log(usage());
    process.exit(0);
  }

  const variantsValue = values.get("variants") ?? VARIANTS.join(",");
  const variants = splitList(variantsValue);
  for (const variant of variants) {
    if (!VARIANTS.includes(variant as Variant)) {
      throw new Error(`Unknown variant: ${variant}`);
    }
  }

  return {
    project: values.get("project") ?? "git",
    docRoot: path.resolve(values.get("doc-root") ?? "src/souko/doc"),
    outRoot: path.resolve(values.get("out-root") ?? "bench/data/ablation-docs"),
    variants: variants as Variant[],
    overwrite: values.has("overwrite"),
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  const info = await stat(filePath).catch(() => undefined);
  return info !== undefined;
}

async function ensureEmptyTarget(dir: string, overwrite: boolean): Promise<void> {
  if (await pathExists(dir)) {
    if (!overwrite) {
      throw new Error(`Target already exists: ${dir} (use --overwrite to replace)`);
    }
    await rm(dir, { recursive: true, force: true });
  }
  await mkdir(dir, { recursive: true });
}

function shouldSkipEntry(name: string): boolean {
  return name.startsWith(".") || SKIP_DIRS.has(name);
}

function isDocFile(name: string): boolean {
  return name.endsWith(".json") || name.endsWith(".md");
}

async function copyDocTree(sourceRoot: string, targetRoot: string): Promise<number> {
  const entries = (await readdir(sourceRoot, { withFileTypes: true }))
    .filter((entry) => !shouldSkipEntry(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  let copied = 0;

  await mkdir(targetRoot, { recursive: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      copied += await copyDocTree(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || !isDocFile(entry.name)) continue;
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    copied += 1;
  }

  return copied;
}

function stripEdgesFromNodes(raw: Record<string, unknown>): { next: Record<string, unknown>; changed: boolean } {
  if (!Array.isArray(raw.nodes)) return { next: raw, changed: false };
  let changed = false;
  const nextNodes = raw.nodes.map((node) => {
    if (!node || typeof node !== "object") return node;
    const edges = (node as { edges?: unknown }).edges;
    if (!Array.isArray(edges) || edges.length > 0) changed = true;
    return { ...(node as Record<string, unknown>), edges: [] };
  });
  return { next: { ...raw, nodes: nextNodes }, changed };
}

async function stripEdgesInDir(root: string): Promise<number> {
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => !shouldSkipEntry(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  let updates = 0;

  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      updates += await stripEdgesInDir(full);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "flows.json") continue;

    const raw = JSON.parse(await readFile(full, "utf-8")) as Record<string, unknown>;
    const { next, changed } = stripEdgesFromNodes(raw);
    if (changed) {
      await writeJson(full, next);
      updates += 1;
    }
  }

  return updates;
}

async function collectMdFiles(root: string, base: string, out: string[]): Promise<void> {
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => !shouldSkipEntry(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await collectMdFiles(full, base, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(path.relative(base, full));
    }
  }
}

function safeRefFromPath(relativePath: string, used: Map<string, number>): string {
  const leaf = path.basename(relativePath, path.extname(relativePath));
  const safe = leaf
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "page";
  const count = used.get(safe) ?? 0;
  used.set(safe, count + 1);
  return count === 0 ? safe : `${safe}-${count + 1}`;
}

function markdownDescription(content: string, fallback: string): { title: string; description: string } {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => /^#{1,3}\s+/.test(line));
  const paragraph = lines.find((line) => !line.startsWith("#") && !line.startsWith("```") && !line.startsWith("|"));
  const title = heading?.replace(/^#+\s+/, "").trim() || fallback;
  const raw = paragraph || title;
  const description = raw.length > 240 ? `${raw.slice(0, 237)}...` : raw;
  return { title, description };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function writeEmptyFlows(projectDir: string): Promise<void> {
  await writeJson(path.join(projectDir, "flows.json"), { flows: [] });
}

async function buildFull(sourceProject: string, targetProject: string, overwrite: boolean): Promise<void> {
  await ensureEmptyTarget(targetProject, overwrite);
  const copied = await copyDocTree(sourceProject, targetProject);
  if (copied === 0) throw new Error(`No documentation files copied from ${sourceProject}`);
}

async function buildNoEdges(sourceProject: string, targetProject: string, overwrite: boolean): Promise<void> {
  await buildFull(sourceProject, targetProject, overwrite);
  await stripEdgesInDir(targetProject);
  await writeEmptyFlows(targetProject);
}

async function buildFlatMd(sourceProject: string, targetProject: string, project: string, overwrite: boolean): Promise<void> {
  const mdFiles: string[] = [];
  await collectMdFiles(sourceProject, sourceProject, mdFiles);
  mdFiles.sort((a, b) => a.localeCompare(b));
  if (mdFiles.length === 0) {
    throw new Error(`No markdown files found under ${sourceProject}`);
  }

  await ensureEmptyTarget(targetProject, overwrite);

  const flatDir = path.join(targetProject, FLAT_MODULE);
  await mkdir(flatDir, { recursive: true });

  const used = new Map<string, number>();
  const manifest: FlatEntry[] = [];
  const nodes: Record<string, unknown>[] = [];

  for (const rel of mdFiles) {
    const sourcePath = path.join(sourceProject, rel);
    const content = await readFile(sourcePath, "utf-8");
    const ref = safeRefFromPath(rel, used);
    const { title, description } = markdownDescription(content, ref);
    const outputFile = `${FLAT_MODULE}/${ref}.md`;

    await writeFile(path.join(targetProject, outputFile), content, "utf-8");
    manifest.push({
      sourcePath: rel.split(path.sep).join("/"),
      outputFile,
      ref,
      title,
    });
    nodes.push({
      name: ref,
      description,
      edges: [],
      codeScope: [],
      child: { type: "page", ref },
    });
  }

  await writeJson(path.join(targetProject, "top.json"), {
    status: "done",
    retryCount: 0,
    sessionId: "ablation-flat-md",
    description: `Flat Markdown doc-drill wrapper for ${project}. Original module hierarchy, typed edges, flows, and source scopes are intentionally removed.`,
    nodes: [{
      name: FLAT_MODULE,
      description: `Flat list of ${nodes.length} documentation pages. Drill once to see every page at the same level.`,
      codeScope: [],
      edges: [],
    }],
  });

  await writeJson(path.join(flatDir, `${FLAT_MODULE}.json`), {
    status: "done",
    retryCount: 0,
    sessionId: "ablation-flat-md",
    description: `Flat Markdown index for ${project}. All leaf documentation pages are siblings; there are no typed edges, flows, source scopes, or original parent-child module groupings.`,
    codeScope: [],
    nodes,
  });

  await writeEmptyFlows(targetProject);
  await writeJson(path.join(targetProject, "manifest.json"), {
    project,
    variant: "flat-md",
    entries: manifest,
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const sourceProject = path.join(options.docRoot, options.project);

  await assertDirectory(options.docRoot, "Documentation root");
  await assertDirectory(sourceProject, "Project docs directory");
  await assertFile(path.join(sourceProject, "top.json"), "Project top.json");

  for (const variant of options.variants) {
    const targetRoot = path.join(options.outRoot, variant);
    const targetProject = path.join(targetRoot, options.project);

    if (variant === "full") {
      await buildFull(sourceProject, targetProject, options.overwrite);
    } else if (variant === "no-edges") {
      await buildNoEdges(sourceProject, targetProject, options.overwrite);
    } else {
      await buildFlatMd(sourceProject, targetProject, options.project, options.overwrite);
    }
    console.log(`[${variant}] ${targetProject}`);
  }

  const selected = options.variants.join(", ");
  console.log(`Ablation docs generated for variants: ${selected}`);
  console.log(`Output root: ${options.outRoot}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
