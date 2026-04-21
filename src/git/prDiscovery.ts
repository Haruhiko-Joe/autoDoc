import { spawn } from "node:child_process";

function run(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args[0]} failed (${code}): ${stderr.trim()}`));
    });
  });
}

function runCmd(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} failed (${code}): ${stderr.trim()}`));
    });
  });
}

// ─── Types ───

export interface PrInfo {
  id: string;
  number?: number;
  title: string;
  body?: string;
  sha: string;
  mergedAt: string;
}

export interface CommitInfo {
  id: string;
  sha: string;
  title: string;
  mergedAt: string;
}

// ─── Fetch latest ───

export async function fetchLatest(repoDir: string): Promise<void> {
  await run(["fetch", "origin"], repoDir);
}

// ─── GitHub PR discovery (gh CLI) ───

export async function isGhAvailable(repoDir: string): Promise<boolean> {
  try {
    await runCmd("gh", ["auth", "status"], repoDir);
    await runCmd("gh", ["repo", "view", "--json", "name"], repoDir);
    return true;
  } catch {
    return false;
  }
}

export async function listMergedPrsSince(repoDir: string, sinceSha: string, baseBranch: string): Promise<PrInfo[]> {
  const sinceDate = (await run(["show", "-s", "--format=%cI", sinceSha], repoDir)).trim();
  const raw = await runCmd("gh", [
    "pr", "list",
    "--base", baseBranch,
    "--state", "merged",
    "--json", "number,title,body,mergeCommit,mergedAt",
    "--limit", "500",
  ], repoDir);
  const prs = JSON.parse(raw) as {
    number: number;
    title: string;
    body: string;
    mergeCommit: { oid: string };
    mergedAt: string;
  }[];
  return prs
    .filter((pr) => pr.mergedAt > sinceDate)
    .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt))
    .map((pr) => ({
      id: `pr-${pr.number}`,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      sha: pr.mergeCommit.oid,
      mergedAt: pr.mergedAt,
    }));
}

// ─── Git commit discovery (fallback) ───

export async function listCommitsSince(repoDir: string, sinceSha: string): Promise<CommitInfo[]> {
  const log = await run([
    "log", "--first-parent", "--format=%H|%cI|%s",
    `${sinceSha}..HEAD`,
  ], repoDir);
  return log
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, date, ...rest] = line.split("|");
      return {
        id: `commit-${sha!.slice(0, 7)}`,
        sha: sha!,
        title: rest.join("|"),
        mergedAt: date!,
      };
    })
    .reverse();
}

// ─── Diff helpers ───

export async function diffNameOnly(repoDir: string, sha: string): Promise<string[]> {
  const out = await run(["diff", "--name-only", `${sha}^`, sha], repoDir).catch(() => "");
  return out.trim().split("\n").filter(Boolean);
}

export async function diffPatch(repoDir: string, sha: string, maxBytes = 200_000): Promise<string> {
  const out = await run(["show", "--first-parent", "-p", "--stat", sha], repoDir).catch(() => "");
  return out.length > maxBytes
    ? out.slice(0, maxBytes) + "\n... (truncated)"
    : out;
}
