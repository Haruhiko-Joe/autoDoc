import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

type Variant = "full" | "no-edges" | "flat-md";

type Options = {
  project: string;
  docRoot: string;
  outRoot: string;
  variants: Variant[];
  overwrite: boolean;
};

const VARIANTS: readonly Variant[] = ["full", "no-edges", "flat-md"];
const SKIP_DIRS = new Set(["_pending"]);
const SKIP_JSON = new Set(["flows.json"]);

function usage(): string {
  return [
    "Usage: pnpm exec tsx bench/scripts/generate-ablation-docs.ts [options]",
    "",
    "Creates documentation variants for ablation experiments:",
    "  - full:     original ACCEED docs",
    "  - no-edges: remove typed edges from top/graph nodes (tree only)",
    "  - flat-md:  flatten all leaf markdown files into one directory",
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

async function removePendingDirs(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) return;
    const full = path.join(root, entry.name);
    if (SKIP_DIRS.has(entry.name)) {
      await rm(full, { recursive: true, force: true });
      return;
    }
    if (entry.name.startsWith(".")) return;
    await removePendingDirs(full);
  }));
}

function stripEdgesFromNodes(raw: Record<string, unknown>): { next: Record<string, unknown>; changed: boolean } {
  if (!Array.isArray(raw.nodes)) return { next: raw, changed: false };
  let changed = false;
  const nextNodes = raw.nodes.map((node) => {
    if (!node || typeof node !== "object") return node;
    const hasEdges = Object.prototype.hasOwnProperty.call(node, "edges");
    const edges = (node as { edges?: unknown }).edges;
    if (!hasEdges || !Array.isArray(edges) || edges.length > 0) {
      changed = true;
    }
    return { ...(node as Record<string, unknown>), edges: [] };
  });
  return { next: { ...raw, nodes: nextNodes }, changed };
}

async function stripEdgesInDir(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true });
  let updates = 0;
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      updates += await stripEdgesInDir(full);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    if (SKIP_JSON.has(entry.name)) continue;

    const raw = JSON.parse(await readFile(full, "utf-8")) as Record<string, unknown>;
    const { next, changed } = stripEdgesFromNodes(raw);
    if (changed) {
      await writeFile(full, JSON.stringify(next, null, 2), "utf-8");
      updates += 1;
    }
  }
  return updates;
}

async function collectMdFiles(root: string, base: string, out: string[]): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectMdFiles(full, base, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(path.relative(base, full));
    }
  }
}

function flattenName(relativePath: string, used: Map<string, number>): string {
  const noExt = relativePath.replace(/\.md$/i, "");
  const base = noExt.split(path.sep).join("__");
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return count === 0 ? `${base}.md` : `${base}__${count + 1}.md`;
}

async function buildFlatMd(sourceProject: string, targetProject: string, project: string, overwrite: boolean): Promise<void> {
  const mdFiles: string[] = [];
  await collectMdFiles(sourceProject, sourceProject, mdFiles);
  if (mdFiles.length === 0) {
    throw new Error(`No markdown files found under ${sourceProject}`);
  }

  await ensureEmptyTarget(targetProject, overwrite);

  const used = new Map<string, number>();
  const manifest: { sourcePath: string; outputFile: string }[] = [];
  for (const rel of mdFiles) {
    const sourcePath = path.join(sourceProject, rel);
    const outputFile = flattenName(rel, used);
    const content = await readFile(sourcePath, "utf-8");
    await writeFile(path.join(targetProject, outputFile), content, "utf-8");
    manifest.push({ sourcePath: rel.split(path.sep).join("/"), outputFile });
  }

  const manifestPath = path.join(targetProject, "manifest.json");
  const manifestContent = JSON.stringify({ project, entries: manifest }, null, 2);
  await writeFile(manifestPath, `${manifestContent}\n`, "utf-8");
}

async function copyProject(sourceProject: string, targetProject: string, overwrite: boolean): Promise<void> {
  if (await pathExists(targetProject)) {
    if (!overwrite) {
      throw new Error(`Target already exists: ${targetProject} (use --overwrite to replace)`);
    }
    await rm(targetProject, { recursive: true, force: true });
  }
  await mkdir(path.dirname(targetProject), { recursive: true });
  await cp(sourceProject, targetProject, { recursive: true });
  await removePendingDirs(targetProject);
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

    if (variant === "flat-md") {
      await buildFlatMd(sourceProject, targetProject, options.project, options.overwrite);
      continue;
    }

    await copyProject(sourceProject, targetProject, options.overwrite);

    if (variant === "no-edges") {
      await stripEdgesInDir(targetProject);
    }
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
