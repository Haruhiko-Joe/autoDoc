import { spawn } from "node:child_process"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { withDocProjectLock } from "./docLock.js"
import { assertProjectName } from "../souko/registry.js"

export interface DocGitHead {
  sha: string
  shortSha: string
  date: string
  message: string
}

export interface DocGitStatus {
  dirty: boolean
  fileCount: number
  files: string[]
  head?: DocGitHead
}

export interface DocGitCommitResult {
  committed: boolean
  sha?: string
  shortSha?: string
}

export interface DocBlameLine {
  line: number
  sha: string
  shortSha: string
  author: string
  time: string
  message: string
  content: string
}

function run(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => { stdout += d.toString() })
    child.stderr.on("data", (d) => { stderr += d.toString() })
    child.on("error", (err) => reject(err))
    child.on("close", (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`git ${args[0]} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`))
    })
  })
}

const DOC_GITIGNORE = `update-log.jsonl
.DS_Store
.snapshots/
.tombstones/
`

export class DocGit {
  constructor(private readonly docRoot: string) {}

  private dir(project: string): string {
    assertProjectName(project)
    return path.join(this.docRoot, project)
  }

  private resolveRel(project: string, relPath: string): string {
    const d = this.dir(project)
    const full = path.resolve(d, relPath)
    if (full !== d && !full.startsWith(d + path.sep)) {
      throw new Error(`Path escapes project: ${relPath}`)
    }
    return full
  }

  async ensureRepo(project: string): Promise<void> {
    return withDocProjectLock(project, async () => {
      const d = this.dir(project)
      await mkdir(d, { recursive: true })
      const gitDir = path.join(d, ".git")
      try {
        await stat(gitDir)
        return
      } catch { /* not initialized yet */ }
      await run(["init"], d)
      await run(["config", "user.name", "autoDoc"], d).catch(() => {})
      await run(["config", "user.email", "autodoc@example.local"], d).catch(() => {})
      await writeFile(path.join(d, ".gitignore"), DOC_GITIGNORE)
      await run(["add", ".gitignore"], d)
      await run(["commit", "-m", "init", "--allow-empty"], d)
    })
  }

  async status(project: string): Promise<DocGitStatus> {
    return withDocProjectLock(project, async () => {
      await this.ensureRepo(project)
      const d = this.dir(project)
      const rawStatus = await run(["status", "--porcelain", "--untracked-files=all"], d)
      const files = rawStatus
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
      const head = await this.head(project).catch(() => undefined)
      return { dirty: files.length > 0, fileCount: files.length, files, ...(head ? { head } : {}) }
    })
  }

  async commitAll(project: string, message: string): Promise<DocGitCommitResult> {
    return withDocProjectLock(project, async () => {
      const trimmed = message.trim()
      if (!trimmed) throw new Error("Commit message required")
      await this.ensureRepo(project)
      const d = this.dir(project)
      await run(["add", "-A"], d)
      try {
        await run(["diff", "--cached", "--quiet"], d)
        return { committed: false }
      } catch { /* has staged changes */ }
      await run(["commit", "-m", trimmed], d)
      const head = await this.head(project)
      return { committed: true, sha: head.sha, shortSha: head.shortSha }
    })
  }

  async head(project: string): Promise<DocGitHead> {
    await this.ensureRepo(project)
    const d = this.dir(project)
    const raw = await run(["log", "-1", "--format=%H%x00%h%x00%aI%x00%s"], d)
    const [sha, shortSha, date, message] = raw.trim().split("\0")
    return {
      sha: sha ?? "",
      shortSha: shortSha ?? "",
      date: date ?? "",
      message: message ?? "",
    }
  }

  async blame(project: string, relPath: string): Promise<DocBlameLine[]> {
    return withDocProjectLock(project, async () => {
      await this.ensureRepo(project)
      const d = this.dir(project)
      const filePath = this.resolveRel(project, relPath)
      const content = await readFile(filePath, "utf-8")
      try {
        const raw = await run(["blame", "--line-porcelain", "--", relPath], d)
        return this.parseBlame(raw)
      } catch {
        return content.split("\n").map((line, index) => ({
          line: index + 1,
          sha: "0000000000000000000000000000000000000000",
          shortSha: "working",
          author: "Uncommitted",
          time: "",
          message: "Not committed yet",
          content: line,
        }))
      }
    })
  }

  private parseBlame(raw: string): DocBlameLine[] {
    const result: DocBlameLine[] = []
    let current: {
      sha: string
      author: string
      time: string
      message: string
    } | null = null

    for (const line of raw.split("\n")) {
      if (/^[0-9a-f]{40} /.test(line) || line.startsWith("0000000000000000000000000000000000000000 ")) {
        const sha = line.split(" ")[0] ?? ""
        current = { sha, author: "", time: "", message: "" }
      } else if (current && line.startsWith("author ")) {
        current.author = line.slice("author ".length)
      } else if (current && line.startsWith("author-time ")) {
        const seconds = Number(line.slice("author-time ".length))
        current.time = Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : ""
      } else if (current && line.startsWith("summary ")) {
        current.message = line.slice("summary ".length)
      } else if (current && line.startsWith("\t")) {
        result.push({
          line: result.length + 1,
          sha: current.sha,
          shortSha: current.sha.startsWith("0000000") ? "working" : current.sha.slice(0, 7),
          author: current.author || "Unknown",
          time: current.time,
          message: current.message || "No commit message",
          content: line.slice(1),
        })
      }
    }

    return result
  }
}
