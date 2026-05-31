import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { InsightItem } from "../agents/schemas/schema.js";
import { DOC_ROOT } from "./registry.js";

export interface InsightRecord {
  ts: string;
  scope: "decomposer" | "writer";
  nodeId: string;
  ref?: string;
  codeScope: string[];
  insights: InsightItem[];
}

function logPath(project: string): string {
  return path.join(DOC_ROOT, project, "insights.jsonl");
}

export async function appendInsight(project: string, record: InsightRecord): Promise<void> {
  const p = logPath(project);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(record) + "\n", { flag: "a" });
}

export async function readInsights(project: string): Promise<InsightRecord[]> {
  try {
    const raw = await readFile(logPath(project), "utf-8");
    return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as InsightRecord);
  } catch {
    return [];
  }
}
