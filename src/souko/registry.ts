import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface ProjectMeta {
  sourceUrl: string;
  branch: string;
  head: string;
  lastUpdated: string;
  lastProcessedSha?: string;
  lastUpdateError?: string;
}

export interface RegistryFile {
  version: 1;
  projects: Record<string, ProjectMeta>;
}

export const SOUKO_DIR = path.resolve("src/souko");
export const REPO_ROOT = path.join(SOUKO_DIR, "repo");
export const DOC_ROOT = path.join(SOUKO_DIR, "doc");
export const KNOWLEDGE_ROOT = path.join(SOUKO_DIR, "knowledge");
const REGISTRY_PATH = path.join(SOUKO_DIR, "projects.json");

const empty = (): RegistryFile => ({ version: 1, projects: {} });

export function validateProjectName(name: unknown): name is string {
  return typeof name === "string"
    && name.length > 0
    && !name.includes("..")
    && !name.includes("/")
    && !name.includes("\\")
    && !name.startsWith(".");
}

export function assertProjectName(name: unknown): asserts name is string {
  if (!validateProjectName(name)) {
    throw new Error(`Invalid project: ${String(name)}`);
  }
}

export async function readRegistry(): Promise<RegistryFile> {
  try {
    const raw = await readFile(REGISTRY_PATH, "utf-8");
    const parsed = JSON.parse(raw) as RegistryFile;
    if (!parsed || typeof parsed !== "object" || !parsed.projects) return empty();
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw e;
  }
}

export async function getProject(name: string): Promise<ProjectMeta | undefined> {
  assertProjectName(name);
  const reg = await readRegistry();
  return reg.projects[name];
}

async function writeRegistry(reg: RegistryFile): Promise<void> {
  await mkdir(SOUKO_DIR, { recursive: true });
  await writeFile(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

export async function upsertProject(name: string, meta: ProjectMeta): Promise<void> {
  assertProjectName(name);
  const reg = await readRegistry();
  reg.projects[name] = meta;
  await writeRegistry(reg);
}

export async function removeProject(name: string): Promise<void> {
  assertProjectName(name);
  const reg = await readRegistry();
  delete reg.projects[name];
  await writeRegistry(reg);
}

export function repoDirOf(name: string): string {
  assertProjectName(name);
  return path.join(REPO_ROOT, name);
}

export function docDirOf(name: string): string {
  assertProjectName(name);
  return path.join(DOC_ROOT, name);
}

export function knowledgePathOf(name: string): string {
  assertProjectName(name);
  return path.join(KNOWLEDGE_ROOT, `${name}.md`);
}

export function knowledgeDraftPathOf(name: string): string {
  assertProjectName(name);
  return path.join(KNOWLEDGE_ROOT, `.draft-${name}.md`);
}
