import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const LOG_DIR = path.resolve("log");

export async function appendRunLog(project: string, message: string): Promise<void> {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const line = `[${new Date().toISOString()}] ${message}\n`;
    await appendFile(path.join(LOG_DIR, `${project}.txt`), line);
  } catch {
    // logging must never break the pipeline
  }
}
