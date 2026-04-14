import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

class GitError extends Error {
  constructor(message: string, public readonly stderr: string, public readonly code: number | null) {
    super(message);
    this.name = "GitError";
  }
}

interface GitRunOptions {
  cwd?: string;
  input?: string;
}

function run(args: string[], opts: GitRunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new GitError(`git ${args[0]} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`, stderr, code));
      }
    });
  });
}

export async function clone(url: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  await run(["clone", "--depth", "1", "--no-tags", url, dest]);
  // promote the shallow clone so future fetches can compute diffs
  await run(["fetch", "--unshallow"], { cwd: dest }).catch(() => undefined);
}

export async function fetchAndPull(dest: string): Promise<void> {
  await run(["fetch", "--all", "--prune"], { cwd: dest });
  // fast-forward the current branch to its upstream
  const branch = await getCurrentBranch(dest);
  await run(["reset", "--hard", `origin/${branch}`], { cwd: dest });
}

export async function getHead(dest: string): Promise<string> {
  return (await run(["rev-parse", "HEAD"], { cwd: dest })).trim();
}

export async function getCurrentBranch(dest: string): Promise<string> {
  // After a shallow clone, HEAD may be detached on the remote default branch.
  // `git symbolic-ref` returns refs/heads/<branch>; fall back to remote HEAD.
  try {
    const ref = (await run(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: dest })).trim();
    if (ref) return ref;
  } catch { /* detached */ }
  const remote = (await run(["rev-parse", "--abbrev-ref", "origin/HEAD"], { cwd: dest })).trim();
  return remote.replace(/^origin\//, "");
}

export async function diffNameOnly(dest: string, fromCommit: string, toCommit: string): Promise<string[]> {
  const out = await run(["diff", "--name-only", `${fromCommit}..${toCommit}`], { cwd: dest });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

export async function diffPatch(
  dest: string,
  fromCommit: string,
  toCommit: string,
  paths?: string[],
): Promise<string> {
  const args = ["diff", "--unified=3", `${fromCommit}..${toCommit}`];
  if (paths && paths.length > 0) {
    args.push("--", ...paths);
  }
  return await run(args, { cwd: dest });
}

/**
 * Extract a project name from a git URL.
 * Handles: git@host:owner/repo.git, https://host/owner/repo.git, ssh://user@host:port/owner/repo.git
 */
export function projectNameFromUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) throw new Error("empty git url");
  // strip optional .git suffix
  const noSuffix = trimmed.replace(/\.git$/i, "");
  // take everything after the last '/' or ':'
  const lastSlash = noSuffix.lastIndexOf("/");
  const lastColon = noSuffix.lastIndexOf(":");
  const cut = Math.max(lastSlash, lastColon);
  const name = cut >= 0 ? noSuffix.slice(cut + 1) : noSuffix;
  if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
    throw new Error(`Cannot derive project name from git URL: ${url}`);
  }
  return name;
}
