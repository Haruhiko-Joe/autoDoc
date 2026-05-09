import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { DOC_ROOT } from "./registry.js";

export interface UpdateLogEntry {
  ts: string;
  taskId: string;
  sha: string;
  title: string;
  markdown: string;
}

function logPath(project: string): string {
  return path.join(DOC_ROOT, project, "update-log.jsonl");
}

export async function appendUpdateLog(project: string, entry: UpdateLogEntry): Promise<void> {
  const p = logPath(project);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(entry) + "\n", { flag: "a" });
}

export async function readUpdateLog(project: string): Promise<UpdateLogEntry[]> {
  try {
    const raw = await readFile(logPath(project), "utf-8");
    return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as UpdateLogEntry);
  } catch {
    return [];
  }
}

export async function getLastProcessedEntry(project: string): Promise<UpdateLogEntry | undefined> {
  const log = await readUpdateLog(project);
  return log[log.length - 1];
}
