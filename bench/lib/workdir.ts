import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import type { Variant } from "./schemas.ts";
import { getSkillContent } from "./skill-content.ts";

export interface SetupOptions {
  project: string;
  variant: Variant;
  ablationDocsRoot: string;
  validationRoot: string;
  skillTemplateDir: string;
  sourceDocRoot?: string;
  force?: boolean;
}

const SKIP_NAMES = new Set(["_pending", ".git"]);
const DEFAULT_SOURCE_DOC_ROOT = "src/souko/doc";

export async function setupWorkdir(opts: SetupOptions): Promise<string> {
  const workdir = path.join(opts.validationRoot, opts.variant, opts.project);

  if (!opts.force && await isGitRepo(workdir)) {
    cleanWorkdir(workdir);
    return workdir;
  }

  const ablationDir = path.join(opts.ablationDocsRoot, opts.variant, opts.project);
  if (!(await stat(ablationDir).catch(() => null))?.isDirectory()) {
    console.log(`[setup] ablation docs missing for ${opts.variant}/${opts.project}, generating...`);
    await generateAblationDocs(opts);
  }

  await rm(workdir, { recursive: true, force: true });
  await mkdir(workdir, { recursive: true });

  if (opts.variant === "flat-md") {
    await setupFlatMd(opts, workdir);
  } else {
    await setupWithSkill(opts, workdir);
  }

  execSync("git init && git add -A && git commit -m initial", {
    cwd: workdir,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@local", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@local" },
  });

  return workdir;
}

export function cleanWorkdir(workdir: string): void {
  execSync("git clean -fdx && git checkout .", { cwd: workdir, stdio: "pipe" });
}

// ---------------------------------------------------------------------------
// Auto-generate ablation docs from source docs
// ---------------------------------------------------------------------------

async function generateAblationDocs(opts: SetupOptions): Promise<void> {
  const sourceDocRoot = path.resolve(opts.sourceDocRoot ?? DEFAULT_SOURCE_DOC_ROOT);
  const sourceProject = path.join(sourceDocRoot, opts.project);
  if (!(await stat(sourceProject).catch(() => null))?.isDirectory()) {
    throw new Error(`Source docs not found: ${sourceProject}. Run ACCEED doc generation first.`);
  }

  const script = path.resolve("bench/scripts/generate-ablation-docs.ts");
  execSync([
    "pnpm", "exec", "tsx", script,
    "--project", opts.project,
    "--doc-root", sourceDocRoot,
    "--out-root", opts.ablationDocsRoot,
    "--variants", opts.variant,
    "--overwrite",
  ].join(" "), { cwd: path.resolve("."), stdio: "inherit" });
}

// ---------------------------------------------------------------------------
// Working directory setup — skill-based variants (full / no-edges)
// ---------------------------------------------------------------------------

async function setupWithSkill(opts: SetupOptions, workdir: string): Promise<void> {
  const variant = opts.variant as "full" | "no-edges";
  const sourceDocDir = path.join(opts.ablationDocsRoot, opts.variant, opts.project);
  const prefixes = [".codex", ".claude"] as const;

  for (const prefix of prefixes) {
    const skillDir = path.join(workdir, prefix, "skills", "doc-drill");
    const scriptsDir = path.join(skillDir, "scripts");
    await mkdir(scriptsDir, { recursive: true });

    const relSkillDir = `${prefix}/skills/doc-drill`;
    await writeFile(path.join(skillDir, "SKILL.md"), getSkillContent(variant, opts.project, relSkillDir));

    await copyFile(
      path.join(opts.skillTemplateDir, "scripts", "browse.mjs"),
      path.join(scriptsDir, "browse.mjs"),
    );

    await copyDocTree(sourceDocDir, path.join(skillDir, "doc", opts.project));
  }
}

// ---------------------------------------------------------------------------
// Working directory setup — flat markdown (no skill)
// ---------------------------------------------------------------------------

async function setupFlatMd(opts: SetupOptions, workdir: string): Promise<void> {
  const flatMdSource = path.join(opts.ablationDocsRoot, "flat-md", opts.project, "FlatMarkdown");
  const targetDocsDir = path.join(workdir, "docs");
  await mkdir(targetDocsDir, { recursive: true });

  if (!(await stat(flatMdSource).catch(() => null))?.isDirectory()) {
    throw new Error(`FlatMarkdown directory not found: ${flatMdSource}`);
  }

  const entries = await readdir(flatMdSource, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    await copyFile(
      path.join(flatMdSource, entry.name),
      path.join(targetDocsDir, entry.name),
    );
  }

  if ((await readdir(targetDocsDir)).length === 0) {
    throw new Error(`No markdown files found in ${flatMdSource}`);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function copyDocTree(source: string, target: string): Promise<void> {
  if (!(await stat(source).catch(() => null))?.isDirectory()) {
    throw new Error(`Documentation source not found: ${source}`);
  }

  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_NAMES.has(entry.name)) continue;
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDocTree(src, dst);
    } else if (entry.isFile() && (entry.name.endsWith(".json") || entry.name.endsWith(".md"))) {
      await copyFile(src, dst);
    }
  }
}

async function isGitRepo(dir: string): Promise<boolean> {
  const gitDir = path.join(dir, ".git");
  return (await stat(gitDir).catch(() => null))?.isDirectory() === true;
}
