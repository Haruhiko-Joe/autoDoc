import { readFile, writeFile, mkdir, readdir, stat, rm } from "node:fs/promises"
import path from "node:path"
import {
  Graph,
  TopGraph,
  type GraphT,
  type TopGraphT,
  type GraphNodeT,
} from "./schema.js"

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

export interface SearchHit {
  name: string
  description: string
  path: string
  type: "graph" | "page"
}

export class DocStore {
  constructor(public readonly docRoot: string) {}

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
    const content = await readFile(this.pageFilePath(project, nodeId, ref), "utf-8")
    const graph = await this.readGraph(project, nodeId)
    const version = graph.pageVersions?.[ref] ?? 0
    return { content, version }
  }

  // ─── Snapshot ──────────────────────────────────────────────

  private async snapshot(filePath: string, version: number): Promise<void> {
    try {
      const data = await readFile(filePath)
      const dir = this.historyDir(filePath)
      await mkdir(dir, { recursive: true })
      const base = path.basename(filePath)
      const ext = path.extname(base)
      const stem = base.slice(0, base.length - ext.length)
      await writeFile(path.join(dir, `${stem}.v${version}${ext}`), data)
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
    await rm(dir, { recursive: true, force: true })
  }

  // ─── History ────────────────────────────────────────────────

  async listHistory(
    project: string,
    relPath: string,
  ): Promise<{ version: number; mtime: string }[]> {
    const full = this.resolveWithin(project, relPath)
    const dir = this.historyDir(full)
    const base = path.basename(full)
    const ext = path.extname(base)
    const stem = base.slice(0, base.length - ext.length)
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const escapedExt = ext.replace(/\./g, "\\.")
    const re = new RegExp(`^${escapeRegex(stem)}\\.v(\\d+)${escapedExt}$`)
    const out: { version: number; mtime: string }[] = []
    for (const e of entries) {
      if (!e.isFile()) continue
      const m = e.name.match(re)
      if (!m) continue
      const s = await stat(path.join(dir, e.name))
      out.push({ version: Number(m[1]), mtime: s.mtime.toISOString() })
    }
    return out.sort((a, b) => a.version - b.version)
  }

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

  // ─── Search ─────────────────────────────────────────────────

  async search(project: string, query: string): Promise<SearchHit[]> {
    const q = query.toLowerCase()
    const base = this.projectDir(project)
    const results: SearchHit[] = []

    const scan = async (dir: string, prefix: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (
          !e.isFile() ||
          !e.name.endsWith(".json") ||
          e.name === "flows.json" ||
          e.name === "top.json"
        ) continue
        try {
          const raw = JSON.parse(await readFile(path.join(dir, e.name), "utf-8"))
          const nodes = (raw?.nodes ?? []) as GraphNodeT[]
          for (const n of nodes) {
            if (
              n.name?.toLowerCase().includes(q) ||
              n.description?.toLowerCase().includes(q)
            ) {
              const childType = (n.child?.type ?? "graph") as "graph" | "page"
              const ref = n.child?.ref ?? n.name
              const nodePath = prefix ? `${prefix}/${ref}` : ref
              results.push({
                name: n.name,
                description: n.description,
                path: nodePath,
                type: childType,
              })
            }
          }
        } catch {
          // skip malformed
        }
      }
      for (const e of entries) {
        if (
          e.isDirectory() &&
          !e.name.startsWith("_") &&
          !e.name.startsWith(".")
        ) {
          await scan(
            path.join(dir, e.name),
            prefix ? `${prefix}/${e.name}` : e.name,
          )
        }
      }
    }

    // also search top.json nodes
    try {
      const top = await this.readTop(project)
      for (const n of top.nodes) {
        if (
          n.name.toLowerCase().includes(q) ||
          n.description.toLowerCase().includes(q)
        ) {
          results.push({
            name: n.name,
            description: n.description,
            path: n.name,
            type: "graph",
          })
        }
      }
    } catch {}

    await scan(base, "")
    return results
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
