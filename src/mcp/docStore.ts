import { readFile, writeFile, mkdir, readdir, stat, rm, open, rename } from "node:fs/promises"
import path from "node:path"
import ignore, { type Ignore } from "ignore"
import { Graph, TopGraph, type GraphT, type TopGraphT } from "./schema.js"

export class VersionMismatchError extends Error {
  constructor(
    public readonly relPath: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `Version mismatch for ${relPath}: client supplied baseVersion=${expected}, server has version=${actual}. Re-read the file and retry.`,
    )
    this.name = "VersionMismatchError"
  }
}

export interface SnapshotSource {
  type: "commit" | "pr" | "manual" | "agent"
  ref?: string
}

export interface SnapshotMeta {
  source?: SnapshotSource
  summary?: string
}

export interface HistoryEntry {
  version: number
  ts: string
  source?: SnapshotSource
  summary?: string
}

export interface SourceReadRequest {
  path: string
  start: number
  end: number
}

export interface SourceFileContent {
  path: string
  start: number
  end: number
  content: string
}

export interface DocFileContent {
  path: string
  content: string
}

const MAX_SOURCE_FILE_BYTES = 1024 * 1024 // 1 MB
const BINARY_SNIFF_BYTES = 8 * 1024

export class DocStore {
  constructor(
    public readonly docRoot: string,
    private readonly resolveRepoDir: (project: string) => string,
  ) {}

  // ─── Path helpers ───────────────────────────────────────────

  private projectDir(project: string): string {
    if (!project || project.includes("..") || project.includes("/") || project.includes("\\")) {
      throw new Error(`Invalid project: ${project}`)
    }
    return path.join(this.docRoot, project)
  }

  private resolveWithin(project: string, rel: string): string {
    const base = this.projectDir(project)
    const full = path.resolve(base, rel)
    if (full !== base && !full.startsWith(base + path.sep)) {
      throw new Error(`Path escapes project: ${rel}`)
    }
    return full
  }

  private graphFilePath(project: string, nodeId: string): string {
    const parts = nodeId.split("/").filter(Boolean)
    if (parts.length === 0) throw new Error("nodeId required")
    const lastName = parts[parts.length - 1]
    return this.resolveWithin(project, path.join(...parts, `${lastName}.json`))
  }

  private topFilePath(project: string): string {
    return this.resolveWithin(project, "top.json")
  }

  private pageFilePath(project: string, nodeId: string, ref: string): string {
    const parts = nodeId.split("/").filter(Boolean)
    return this.resolveWithin(project, path.join(...parts, `${ref}.md`))
  }

  private historyDir(filePath: string): string {
    return path.join(path.dirname(filePath), ".history")
  }

  // ─── Listings ───────────────────────────────────────────────

  async listProjects(): Promise<{ name: string; description: string }[]> {
    const entries = await readdir(this.docRoot, { withFileTypes: true }).catch(() => [])
    const out: { name: string; description: string }[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      try {
        const top = await this.readTop(e.name)
        out.push({ name: e.name, description: top.description })
      } catch {
        // skip dirs without valid top.json
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  // ─── Reads ──────────────────────────────────────────────────

  async readTop(project: string): Promise<TopGraphT> {
    const raw = JSON.parse(await readFile(this.topFilePath(project), "utf-8"))
    return TopGraph.parse(raw)
  }

  async readGraph(project: string, nodeId: string): Promise<GraphT> {
    const raw = JSON.parse(await readFile(this.graphFilePath(project, nodeId), "utf-8"))
    return Graph.parse(raw)
  }

  async readPage(
    project: string,
    nodeId: string,
    ref: string,
  ): Promise<{ content: string; version: number }> {
    const graph = await this.readGraph(project, nodeId)
    const version = graph.pageVersions?.[ref] ?? 0
    const content = await readFile(this.pageFilePath(project, nodeId, ref), "utf-8")
    return { content, version }
  }

  async searchNodes(
    project: string,
    query: string,
  ): Promise<{ nodeId: string; name: string; description: string; type: "graph" | "page" }[]> {
    const q = query.toLowerCase()
    const results: { nodeId: string; name: string; description: string; type: "graph" | "page" }[] = []

    const top = await this.readTop(project).catch(() => null)
    if (!top) return results

    for (const node of top.nodes) {
      if (node.name.toLowerCase().includes(q) || node.description.toLowerCase().includes(q)) {
        results.push({ nodeId: node.name, name: node.name, description: node.description, type: "graph" })
      }
    }

    const recurse = async (parentId: string): Promise<void> => {
      const graph = await this.readGraph(project, parentId).catch(() => null)
      if (!graph) return
      for (const node of graph.nodes) {
        const childId = `${parentId}/${node.child.ref}`
        if (node.name.toLowerCase().includes(q) || node.description.toLowerCase().includes(q)) {
          results.push({ nodeId: childId, name: node.name, description: node.description, type: node.child.type })
        }
        if (node.child.type === "graph") {
          await recurse(childId)
        }
      }
    }

    for (const node of top.nodes) {
      await recurse(node.name)
    }

    return results
  }

  // ─── Snapshot ──────────────────────────────────────────────

  private async snapshot(filePath: string, version: number, meta?: SnapshotMeta): Promise<void> {
    try {
      const data = await readFile(filePath)
      const dir = this.historyDir(filePath)
      await mkdir(dir, { recursive: true })
      const base = path.basename(filePath)
      const ext = path.extname(base)
      const stem = base.slice(0, base.length - ext.length)
      await writeFile(path.join(dir, `${stem}.v${version}${ext}`), data)
      const entry: HistoryEntry = {
        version,
        ts: new Date().toISOString(),
        ...(meta?.source ? { source: meta.source } : {}),
        ...(meta?.summary ? { summary: meta.summary } : {}),
      }
      const metaFile = path.join(dir, "_meta.jsonl")
      await writeFile(metaFile, JSON.stringify(entry) + "\n", { flag: "a" })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
    }
  }

  // ─── Top writes ─────────────────────────────────────────────

  async writeTop(project: string, next: TopGraphT, baseVersion: number): Promise<TopGraphT> {
    const filePath = this.topFilePath(project)
    const current = await this.readTop(project)
    if (current.version !== baseVersion) {
      throw new VersionMismatchError("top.json", baseVersion, current.version)
    }
    await this.snapshot(filePath, current.version)
    const written: TopGraphT = { ...next, version: baseVersion + 1 }
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(written, null, 2))
    return written
  }

  // ─── Graph writes ───────────────────────────────────────────

  async writeGraph(
    project: string,
    nodeId: string,
    next: GraphT,
    baseVersion: number,
  ): Promise<GraphT> {
    const filePath = this.graphFilePath(project, nodeId)
    const current = await this.readGraph(project, nodeId)
    if (current.version !== baseVersion) {
      throw new VersionMismatchError(nodeId, baseVersion, current.version)
    }
    await this.snapshot(filePath, current.version)
    const written: GraphT = { ...next, version: baseVersion + 1 }
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(written, null, 2))
    return written
  }

  // ─── Page writes ────────────────────────────────────────────

  async writePage(
    project: string,
    nodeId: string,
    ref: string,
    content: string,
    baseVersion: number,
  ): Promise<{ version: number; graphVersion: number }> {
    const graph = await this.readGraph(project, nodeId)
    const currentPageVersion = graph.pageVersions?.[ref] ?? 0
    if (currentPageVersion !== baseVersion) {
      throw new VersionMismatchError(
        `${nodeId}/${ref}.md`,
        baseVersion,
        currentPageVersion,
      )
    }

    const pageFile = this.pageFilePath(project, nodeId, ref)
    await this.snapshot(pageFile, currentPageVersion)
    await mkdir(path.dirname(pageFile), { recursive: true })
    await writeFile(pageFile, content)

    // Bump pageVersions in parent graph (separate version lane from graph.version).
    const graphFile = this.graphFilePath(project, nodeId)
    await this.snapshot(graphFile, graph.version)
    const nextGraph: GraphT = {
      ...graph,
      pageVersions: { ...(graph.pageVersions ?? {}), [ref]: currentPageVersion + 1 },
      version: graph.version + 1,
    }
    await writeFile(graphFile, JSON.stringify(nextGraph, null, 2))

    return { version: currentPageVersion + 1, graphVersion: nextGraph.version }
  }

  async patchPage(
    project: string,
    nodeId: string,
    ref: string,
    edits: { old_text: string; new_text: string }[],
    baseVersion: number,
  ): Promise<{ version: number; graphVersion: number; appliedCount: number }> {
    const graph = await this.readGraph(project, nodeId)
    const currentPageVersion = graph.pageVersions?.[ref] ?? 0
    if (currentPageVersion !== baseVersion) {
      throw new VersionMismatchError(
        `${nodeId}/${ref}.md`,
        baseVersion,
        currentPageVersion,
      )
    }

    const pageFile = this.pageFilePath(project, nodeId, ref)
    let content = await readFile(pageFile, "utf-8")

    for (const edit of edits) {
      const count = content.split(edit.old_text).length - 1
      if (count === 0) {
        throw new Error(`TextNotFound: "${edit.old_text.slice(0, 80)}"`)
      }
      if (count > 1) {
        throw new Error(`AmbiguousMatch: "${edit.old_text.slice(0, 80)}" matches ${count} times`)
      }
      content = content.replace(edit.old_text, edit.new_text)
    }

    await this.snapshot(pageFile, currentPageVersion)
    await writeFile(pageFile, content)

    const graphFile = this.graphFilePath(project, nodeId)
    await this.snapshot(graphFile, graph.version)
    const nextGraph: GraphT = {
      ...graph,
      pageVersions: { ...(graph.pageVersions ?? {}), [ref]: currentPageVersion + 1 },
      version: graph.version + 1,
    }
    await writeFile(graphFile, JSON.stringify(nextGraph, null, 2))

    return { version: currentPageVersion + 1, graphVersion: nextGraph.version, appliedCount: edits.length }
  }

  // ─── Create helpers (no version check — used internally by create_node) ─

  async createEmptyPage(
    project: string,
    nodeId: string,
    ref: string,
    content: string,
  ): Promise<void> {
    const filePath = this.pageFilePath(project, nodeId, ref)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, content)
  }

  async createPlaceholderSubgraph(
    project: string,
    parentNodeId: string,
    ref: string,
    description: string,
    codeScope: string[],
  ): Promise<void> {
    const childNodeId = `${parentNodeId}/${ref}`
    const filePath = this.graphFilePath(project, childNodeId)
    await mkdir(path.dirname(filePath), { recursive: true })
    const placeholder: GraphT = {
      description,
      codeScope,
      nodes: [],
      version: 0,
    }
    await writeFile(filePath, JSON.stringify(placeholder, null, 2))
  }

  // ─── Deletes ────────────────────────────────────────────────

  async deletePageFile(project: string, nodeId: string, ref: string): Promise<void> {
    const filePath = this.pageFilePath(project, nodeId, ref)
    try {
      const graph = await this.readGraph(project, nodeId)
      const version = graph.pageVersions?.[ref] ?? 0
      await this.snapshot(filePath, version)
    } catch {
      // best-effort snapshot
    }
    await rm(filePath, { force: true })
  }

  async deleteSubgraphDir(project: string, nodeId: string): Promise<void> {
    const graphFile = this.graphFilePath(project, nodeId)
    try {
      const graph = await this.readGraph(project, nodeId)
      await this.snapshot(graphFile, graph.version)
    } catch {
      // best-effort snapshot
    }
    const dir = path.dirname(graphFile)
    const histDir = path.join(dir, ".history")
    try {
      const histStat = await stat(histDir)
      if (histStat.isDirectory()) {
        const subgraphName = path.basename(dir)
        const parentDir = path.dirname(dir)
        const tombDir = path.join(parentDir, ".tombstones", subgraphName, `${Date.now()}`)
        await mkdir(tombDir, { recursive: true })
        await rename(histDir, path.join(tombDir, ".history"))
      }
    } catch {
      // no .history to preserve
    }
    await rm(dir, { recursive: true, force: true })
  }

  // ─── History ────────────────────────────────────────────────

  async readHistorySnapshot(
    project: string,
    relPath: string,
    version: number,
  ): Promise<string> {
    const full = this.resolveWithin(project, relPath)
    const dir = this.historyDir(full)
    const base = path.basename(full)
    const ext = path.extname(base)
    const stem = base.slice(0, base.length - ext.length)
    return await readFile(path.join(dir, `${stem}.v${version}${ext}`), "utf-8")
  }

  async listHistory(project: string, relPath: string): Promise<HistoryEntry[]> {
    const full = this.resolveWithin(project, relPath)
    const dir = this.historyDir(full)
    const base = path.basename(full)
    const ext = path.extname(base)
    const stem = base.slice(0, base.length - ext.length)

    const metaMap = new Map<number, HistoryEntry>()
    try {
      const raw = await readFile(path.join(dir, "_meta.jsonl"), "utf-8")
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue
        const entry = JSON.parse(line) as HistoryEntry
        metaMap.set(entry.version, entry)
      }
    } catch {
      // no _meta.jsonl yet
    }

    const entries: HistoryEntry[] = []
    try {
      const files = await readdir(dir)
      const re = new RegExp(`^${escapeForRegex(stem)}\\.v(\\d+)${escapeForRegex(ext)}$`)
      for (const f of files) {
        const m = f.match(re)
        if (!m) continue
        const version = parseInt(m[1]!, 10)
        const meta = metaMap.get(version)
        entries.push(meta ?? { version, ts: "" })
      }
    } catch {
      // no .history dir
    }
    entries.sort((a, b) => b.version - a.version)
    return entries
  }

  // ─── Revert ─────────────────────────────────────────────────

  async revert(
    project: string,
    relPath: string,
    toVersion: number,
    baseVersion: number,
  ): Promise<{ relPath: string; newVersion: number }> {
    const snapshot = await this.readHistorySnapshot(project, relPath, toVersion)

    if (relPath === "top.json") {
      const parsed = TopGraph.parse(JSON.parse(snapshot))
      const written = await this.writeTop(project, parsed, baseVersion)
      return { relPath, newVersion: written.version }
    }

    if (relPath.endsWith(".json")) {
      const parts = relPath.split("/")
      const fileName = parts.pop()!
      const stemFromFile = fileName.slice(0, -5)
      const lastDir = parts[parts.length - 1]
      if (stemFromFile !== lastDir) {
        throw new Error(`Unexpected graph file layout: ${relPath}`)
      }
      const nodeId = parts.join("/")
      const parsed = Graph.parse(JSON.parse(snapshot))
      const written = await this.writeGraph(project, nodeId, parsed, baseVersion)
      return { relPath, newVersion: written.version }
    }

    if (relPath.endsWith(".md")) {
      const parts = relPath.split("/")
      const fileName = parts.pop()!
      const ref = fileName.slice(0, -3)
      const nodeId = parts.join("/")
      const { version } = await this.writePage(project, nodeId, ref, snapshot, baseVersion)
      return { relPath, newVersion: version }
    }

    throw new Error(`Unsupported revert target: ${relPath}`)
  }

  // ─── Source code access ─────────────────────────────────────

  private repoDir(project: string): string {
    if (!project || project.includes("..") || project.includes("/") || project.includes("\\")) {
      throw new Error(`Invalid project: ${project}`)
    }
    return this.resolveRepoDir(project)
  }

  private resolveWithinRepo(project: string, rel: string): string {
    const base = this.repoDir(project)
    const full = path.resolve(base, rel)
    if (full !== base && !full.startsWith(base + path.sep)) {
      throw new Error(`Path escapes repo: ${rel}`)
    }
    return full
  }

  private async loadGitignore(repoRoot: string): Promise<Ignore> {
    const ig = ignore()
    ig.add(".git")
    try {
      const raw = await readFile(path.join(repoRoot, ".gitignore"), "utf-8")
      ig.add(raw)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
    }
    return ig
  }

  private async listRepoCandidates(project: string): Promise<string[]> {
    const repoRoot = this.repoDir(project)
    try {
      await stat(repoRoot)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return []
      throw e
    }
    const ig = await this.loadGitignore(repoRoot)
    const results: string[] = []

    const recurse = async (dir: string, relDir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        const rel = relDir ? `${relDir}/${e.name}` : e.name
        if (e.isDirectory()) {
          if (ig.ignores(`${rel}/`)) continue
          await recurse(path.join(dir, e.name), rel)
        } else if (e.isFile() || e.isSymbolicLink()) {
          if (ig.ignores(rel)) continue
          const full = path.join(dir, e.name)
          if (await isBinaryFile(full)) continue
          results.push(rel)
        }
      }
    }

    await recurse(repoRoot, "")
    results.sort()
    return results
  }

  async listSourceFiles(
    project: string,
    patterns: string[],
  ): Promise<{ pattern: string; files: string[] }[]> {
    if (patterns.length === 0) return []
    const candidates = await this.listRepoCandidates(project)
    return patterns.map((pattern) => {
      const re = new RegExp(pattern)
      return { pattern, files: candidates.filter((f) => re.test(f)) }
    })
  }

  async readSourceFiles(
    project: string,
    requests: SourceReadRequest[],
  ): Promise<SourceFileContent[]> {
    const out: SourceFileContent[] = []
    for (const req of requests) {
      let full: string
      try {
        full = this.resolveWithinRepo(project, req.path)
      } catch {
        continue
      }
      let fileStat
      try {
        fileStat = await stat(full)
      } catch {
        continue
      }
      if (!fileStat.isFile()) continue
      if (fileStat.size > MAX_SOURCE_FILE_BYTES) continue
      if (await isBinaryFile(full)) continue

      const raw = await readFile(full, "utf-8")
      const lines = raw.split("\n")
      const totalLines = lines.length
      const resolvedStart = req.start <= 0 ? 1 : req.start
      const resolvedEnd = req.end === -1 ? totalLines : req.end
      let content = ""
      if (resolvedStart <= totalLines && resolvedStart <= resolvedEnd) {
        const sliceEnd = Math.min(resolvedEnd, totalLines)
        content = lines.slice(resolvedStart - 1, sliceEnd).join("\n")
      }
      out.push({
        path: req.path,
        start: resolvedStart,
        end: resolvedEnd,
        content,
      })
    }
    return out
  }

  // ─── Doc batch access ───────────────────────────────────────

  private async listDocNodeIds(project: string): Promise<string[]> {
    const base = this.projectDir(project)
    try {
      await stat(base)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return []
      throw e
    }
    const results: string[] = []

    try {
      await stat(path.join(base, "top.json"))
      results.push("")
    } catch {
      // no top.json
    }

    const recurse = async (dir: string, prefix: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name.startsWith("_")) continue
        if (e.isFile()) {
          if (e.name.endsWith(".md")) {
            const stem = e.name.slice(0, -3)
            results.push(prefix ? `${prefix}/${stem}` : stem)
          } else if (e.name.endsWith(".json")) {
            const stem = e.name.slice(0, -5)
            if (prefix && stem === path.basename(dir)) {
              results.push(prefix)
            }
          }
        } else if (e.isDirectory()) {
          const childPrefix = prefix ? `${prefix}/${e.name}` : e.name
          await recurse(path.join(dir, e.name), childPrefix)
        }
      }
    }

    await recurse(base, "")
    results.sort()
    return results
  }

  async listDocs(
    project: string,
    patterns: string[],
  ): Promise<{ pattern: string; docs: string[] }[]> {
    if (patterns.length === 0) return []
    const candidates = await this.listDocNodeIds(project)
    return patterns.map((pattern) => {
      const re = new RegExp(pattern)
      return { pattern, docs: candidates.filter((id) => re.test(id)) }
    })
  }

  async readDocs(project: string, paths: string[]): Promise<DocFileContent[]> {
    const out: DocFileContent[] = []
    for (const nodeId of paths) {
      const resolved = await this.resolveDocFile(project, nodeId)
      if (!resolved) continue
      try {
        const content = await readFile(resolved, "utf-8")
        out.push({ path: nodeId, content })
      } catch {
        // skip unreadable
      }
    }
    return out
  }

  private async resolveDocFile(project: string, nodeId: string): Promise<string | null> {
    if (nodeId === "") {
      const p = this.topFilePath(project)
      return (await fileExists(p)) ? p : null
    }
    const parts = nodeId.split("/").filter(Boolean)
    if (parts.length === 0) return null
    // Prefer leaf page .md; fall back to subgraph .json
    let pageFile: string
    try {
      pageFile = this.resolveWithin(project, path.join(...parts) + ".md")
    } catch {
      return null
    }
    if (await fileExists(pageFile)) return pageFile
    let graphFile: string
    try {
      const last = parts[parts.length - 1]
      graphFile = this.resolveWithin(project, path.join(...parts, `${last}.json`))
    } catch {
      return null
    }
    if (await fileExists(graphFile)) return graphFile
    return null
  }
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isFile()
  } catch {
    return false
  }
}

async function isBinaryFile(filePath: string): Promise<boolean> {
  let fh
  try {
    fh = await open(filePath, "r")
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES)
    const { bytesRead } = await fh.read(buf, 0, BINARY_SNIFF_BYTES, 0)
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true
    }
    return false
  } catch {
    return true
  } finally {
    await fh?.close()
  }
}
