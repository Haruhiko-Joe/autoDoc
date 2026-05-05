import { readFile, writeFile, mkdir, readdir, stat, lstat, realpath, rm, open } from "node:fs/promises"
import path from "node:path"
import ignore, { type Ignore } from "ignore"
import {
  Graph,
  TopGraph,
  type GraphEdgeT,
  type GraphNodeT,
  type GraphT,
  type ScaffoldNodeT,
  type TopGraphT,
} from "./schema.js"
import {
  FlowAnalyzerOutput,
  type FlowAnalyzerOutput as FlowAnalyzerOutputT,
} from "../agents/schemas/schema.js"
import { DocGit } from "./docGit.js"
import { withDocProjectLock } from "./docLock.js"
import { assertProjectName } from "../souko/registry.js"

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
    public readonly docGit: DocGit,
  ) {}

  // ─── Path helpers ───────────────────────────────────────────

  private projectDir(project: string): string {
    assertProjectName(project)
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

  private flowsFilePath(project: string): string {
    return this.resolveWithin(project, "flows.json")
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
  ): Promise<{ content: string }> {
    const content = await readFile(this.pageFilePath(project, nodeId, ref), "utf-8")
    return { content }
  }

  async readFlows(project: string): Promise<FlowAnalyzerOutputT> {
    const filePath = this.flowsFilePath(project)
    try {
      const raw = JSON.parse(await readFile(filePath, "utf-8"))
      return FlowAnalyzerOutput.parse(raw)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`flows.json has not been generated for project: ${project}`)
      }
      throw e
    }
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

  // ─── Top writes ─────────────────────────────────────────────

  async writeTop(project: string, next: TopGraphT): Promise<TopGraphT> {
    return withDocProjectLock(project, () => this.writeTopUnlocked(project, next))
  }

  async updateTop(
    project: string,
    patch: { description?: string; nodes?: ScaffoldNodeT[] },
  ): Promise<TopGraphT> {
    return withDocProjectLock(project, async () => {
      const current = await this.readTop(project)
      return this.writeTopUnlocked(project, {
        ...current,
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.nodes !== undefined ? { nodes: patch.nodes } : {}),
      })
    })
  }

  private async writeTopUnlocked(project: string, next: TopGraphT): Promise<TopGraphT> {
    const filePath = this.topFilePath(project)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(next, null, 2))
    return next
  }

  // ─── Graph writes ───────────────────────────────────────────

  async writeGraph(project: string, nodeId: string, next: GraphT): Promise<GraphT> {
    return withDocProjectLock(project, () => this.writeGraphUnlocked(project, nodeId, next))
  }

  async updateGraphMeta(
    project: string,
    nodeId: string,
    patch: { description?: string; codeScope?: string[] },
  ): Promise<GraphT> {
    return withDocProjectLock(project, async () => {
      const current = await this.readGraph(project, nodeId)
      return this.writeGraphUnlocked(project, nodeId, {
        ...current,
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.codeScope !== undefined ? { codeScope: patch.codeScope } : {}),
      })
    })
  }

  async updateNode(
    project: string,
    parentNodeId: string,
    nodeName: string,
    patch: { name?: string; description?: string; codeScope?: string[]; edges?: GraphEdgeT[] },
  ): Promise<GraphT> {
    return withDocProjectLock(project, async () => {
      const parent = await this.readGraph(project, parentNodeId)
      const idx = parent.nodes.findIndex((n) => n.name === nodeName)
      if (idx < 0) throw new Error(`Node not found: ${nodeName}`)
      const current = parent.nodes[idx]
      if (!current) throw new Error(`Node not found: ${nodeName}`)
      const nextNodes = parent.nodes.slice()
      nextNodes[idx] = {
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        codeScope: patch.codeScope ?? current.codeScope,
        edges: patch.edges ?? current.edges,
        child: current.child,
      }
      return this.writeGraphUnlocked(project, parentNodeId, { ...parent, nodes: nextNodes })
    })
  }

  private async writeGraphUnlocked(project: string, nodeId: string, next: GraphT): Promise<GraphT> {
    const filePath = this.graphFilePath(project, nodeId)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(next, null, 2))
    return next
  }

  // ─── Page writes ────────────────────────────────────────────

  async writePage(
    project: string,
    nodeId: string,
    ref: string,
    content: string,
  ): Promise<void> {
    await withDocProjectLock(project, () => this.writePageUnlocked(project, nodeId, ref, content))
  }

  async patchPage(
    project: string,
    nodeId: string,
    ref: string,
    edits: { old_text: string; new_text: string }[],
  ): Promise<{ appliedCount: number }> {
    return withDocProjectLock(project, async () => {
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

      await writeFile(pageFile, content)
      return { appliedCount: edits.length }
    })
  }

  private async writePageUnlocked(
    project: string,
    nodeId: string,
    ref: string,
    content: string,
  ): Promise<void> {
    const pageFile = this.pageFilePath(project, nodeId, ref)
    await mkdir(path.dirname(pageFile), { recursive: true })
    await writeFile(pageFile, content)
  }

  // ─── Create helpers ─────────────────────────────────────────

  async createEmptyPage(
    project: string,
    nodeId: string,
    ref: string,
    content: string,
  ): Promise<void> {
    await withDocProjectLock(project, () => this.createEmptyPageUnlocked(project, nodeId, ref, content))
  }

  private async createEmptyPageUnlocked(
    project: string,
    nodeId: string,
    ref: string,
    content: string,
  ): Promise<void> {
    const filePath = this.pageFilePath(project, nodeId, ref)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, content, { flag: "wx" })
  }

  async childArtifactExists(
    project: string,
    parentNodeId: string,
    ref: string,
    type: "page" | "graph",
  ): Promise<boolean> {
    const filePath = type === "page"
      ? this.pageFilePath(project, parentNodeId, ref)
      : this.graphFilePath(project, `${parentNodeId}/${ref}`)
    return fileExists(filePath)
  }

  async createPlaceholderSubgraph(
    project: string,
    parentNodeId: string,
    ref: string,
    description: string,
    codeScope: string[],
  ): Promise<void> {
    await withDocProjectLock(project, () =>
      this.createPlaceholderSubgraphUnlocked(project, parentNodeId, ref, description, codeScope),
    )
  }

  private async createPlaceholderSubgraphUnlocked(
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
    }
    await writeFile(filePath, JSON.stringify(placeholder, null, 2), { flag: "wx" })
  }

  async createNode(
    project: string,
    parentNodeId: string,
    node: GraphNodeT,
    initialContent?: string,
  ): Promise<GraphT> {
    return withDocProjectLock(project, async () => {
      const parentFile = this.graphFilePath(project, parentNodeId)
      const originalParent = await readFile(parentFile, "utf-8")
      const parent = Graph.parse(JSON.parse(originalParent))

      if (parent.nodes.some((n) => n.name === node.name)) {
        throw new Error(`Sibling node already exists: ${node.name}`)
      }
      if (parent.nodes.some((n) => n.child.ref === node.child.ref)) {
        throw new Error(`Sibling child ref already exists: ${node.child.ref}`)
      }
      if (await this.childArtifactExists(project, parentNodeId, node.child.ref, node.child.type)) {
        throw new Error(`Child artifact already exists: ${node.child.ref}`)
      }

      let childCreated = false
      try {
        if (node.child.type === "page") {
          await this.createEmptyPageUnlocked(project, parentNodeId, node.child.ref, initialContent ?? "")
        } else {
          await this.createPlaceholderSubgraphUnlocked(
            project,
            parentNodeId,
            node.child.ref,
            node.description,
            node.codeScope,
          )
        }
        childCreated = true

        return await this.writeGraphUnlocked(project, parentNodeId, {
          ...parent,
          nodes: [...parent.nodes, node],
        })
      } catch (e) {
        await writeFile(parentFile, originalParent).catch(() => {})
        if (childCreated) {
          if (node.child.type === "page") {
            await this.deletePageFileUnlocked(project, parentNodeId, node.child.ref).catch(() => {})
          } else {
            await this.deleteSubgraphDirUnlocked(project, `${parentNodeId}/${node.child.ref}`).catch(() => {})
          }
        }
        throw e
      }
    })
  }

  // ─── Deletes ────────────────────────────────────────────────

  async deletePageFile(project: string, nodeId: string, ref: string): Promise<void> {
    await withDocProjectLock(project, () => this.deletePageFileUnlocked(project, nodeId, ref))
  }

  private async deletePageFileUnlocked(project: string, nodeId: string, ref: string): Promise<void> {
    const filePath = this.pageFilePath(project, nodeId, ref)
    await rm(filePath, { force: true })
  }

  async deleteSubgraphDir(project: string, nodeId: string): Promise<void> {
    await withDocProjectLock(project, () => this.deleteSubgraphDirUnlocked(project, nodeId))
  }

  private async deleteSubgraphDirUnlocked(project: string, nodeId: string): Promise<void> {
    const graphFile = this.graphFilePath(project, nodeId)
    const dir = path.dirname(graphFile)
    await rm(dir, { recursive: true, force: true })
  }

  async deleteNode(project: string, parentNodeId: string, nodeName: string): Promise<GraphT> {
    return withDocProjectLock(project, async () => {
      const parentFile = this.graphFilePath(project, parentNodeId)
      const originalParent = await readFile(parentFile, "utf-8")
      const parent = Graph.parse(JSON.parse(originalParent))
      const target = parent.nodes.find((n) => n.name === nodeName)
      if (!target) throw new Error(`Node not found: ${nodeName}`)

      try {
        const written = await this.writeGraphUnlocked(project, parentNodeId, {
          ...parent,
          nodes: parent.nodes.filter((n) => n.name !== nodeName),
        })
        if (target.child.type === "page") {
          await this.deletePageFileUnlocked(project, parentNodeId, target.child.ref)
        } else {
          await this.deleteSubgraphDirUnlocked(project, `${parentNodeId}/${target.child.ref}`)
        }
        return written
      } catch (e) {
        await writeFile(parentFile, originalParent).catch(() => {})
        throw e
      }
    })
  }

  // ─── Git-backed helpers ────────────────────────────────────

  async resolveNodeId(project: string, nodeId: string): Promise<string> {
    return this.resolveNodeIdToRelPath(project, nodeId)
  }

  private async resolveNodeIdToRelPath(project: string, nodeId: string): Promise<string> {
    const abs = await this.resolveDocFile(project, nodeId)
    if (!abs) throw new Error(`Doc not found: ${nodeId}`)
    const base = this.projectDir(project)
    return path.relative(base, abs).split(path.sep).join("/")
  }

  // ─── Source code access ─────────────────────────────────────

  private repoDir(project: string): string {
    assertProjectName(project)
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

  private async realPathIsWithinRepo(project: string, full: string): Promise<boolean> {
    const base = await realpath(this.repoDir(project))
    const resolved = await realpath(full)
    return resolved === base || resolved.startsWith(base + path.sep)
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
        } else if (e.isFile()) {
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
      let linkStat
      try {
        linkStat = await lstat(full)
      } catch {
        continue
      }
      if (linkStat.isSymbolicLink()) continue
      let fileStat
      try {
        fileStat = await stat(full)
      } catch {
        continue
      }
      if (!fileStat.isFile()) continue
      if (!(await this.realPathIsWithinRepo(project, full).catch(() => false))) continue
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
