#!/usr/bin/env node

/**
 * doc-drill browse — progressive disclosure browser for autoDoc documentation
 *
 * Usage:
 *   node browse.mjs <doc-root> <project>                          # top-level overview
 *   node browse.mjs <doc-root> <project> <module-path>            # drill into a module
 *   node browse.mjs <doc-root> <project> <module-path> --read     # read leaf page
 *   node browse.mjs <doc-root> <project> --search <keyword>       # search across descriptions
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join, resolve, basename, relative } from "node:path"

const [,, docRoot, project, ...rest] = process.argv

if (!docRoot || !project) {
  console.error("Usage: node browse.mjs <doc-root> <project> [module-path] [--read|--search <kw>]")
  process.exit(1)
}

const base = resolve(docRoot, project)
if (!existsSync(base)) {
  console.error(`Project not found: ${base}`)
  process.exit(1)
}

// ─── Helpers ───

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf-8"))
}

function formatEdges(edges) {
  if (!edges || edges.length === 0) return ""
  const lines = edges.map(e => `    → [${e.type}] ${e.target}: ${e.description}`)
  return "\n" + lines.join("\n")
}

function formatNode(node, indent = "") {
  const tag = node.child ? (node.child.type === "graph" ? "▸" : "◦") : "•"
  let line = `${indent}${tag} ${node.name}`
  if (node.child) line += `  [${node.child.type}]`
  line += `\n${indent}  ${node.description}`
  if (node.codeScope && node.codeScope.length > 0) {
    line += `\n${indent}  scope: ${node.codeScope.join(", ")}`
  }
  if (node.edges && node.edges.length > 0) {
    line += formatEdges(node.edges).replace(/^/gm, indent)
  }
  return line
}

function collectAllNodes(dir, prefix = "") {
  const results = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isFile() && entry.endsWith(".json") && entry !== "top.json") {
      try {
        const graph = readJSON(full)
        if (graph.nodes) {
          const modName = basename(entry, ".json")
          const modPath = prefix ? `${prefix}/${modName}` : modName
          for (const n of graph.nodes) {
            results.push({ ...n, _modulePath: modPath })
          }
        }
      } catch {}
    } else if (st.isDirectory() && !entry.startsWith("_") && !entry.startsWith(".")) {
      const sub = prefix ? `${prefix}/${entry}` : entry
      results.push(...collectAllNodes(full, sub))
    }
  }
  return results
}

// ─── Commands ───

const searchIdx = rest.indexOf("--search")
const readFlag = rest.includes("--read")

if (searchIdx !== -1) {
  // ── Search mode ──
  const keyword = rest.slice(searchIdx + 1).join(" ").toLowerCase()
  if (!keyword) {
    console.error("--search requires a keyword")
    process.exit(1)
  }

  console.log(`🔍 Searching "${keyword}" in ${project}...\n`)

  // search top.json
  const topPath = join(base, "top.json")
  if (existsSync(topPath)) {
    const top = readJSON(topPath)
    for (const n of top.nodes) {
      if (n.name.toLowerCase().includes(keyword) || n.description.toLowerCase().includes(keyword)) {
        console.log(`[top] ${n.name}: ${n.description}\n`)
      }
    }
  }

  // search all sub-graphs
  const allNodes = collectAllNodes(base)
  for (const n of allNodes) {
    if (n.name.toLowerCase().includes(keyword) || n.description.toLowerCase().includes(keyword)) {
      console.log(`[${n._modulePath}] ${n.name} [${n.child?.type || "?"}]: ${n.description}\n`)
    }
  }
} else if (rest.length === 0) {
  // ── Top-level overview ──
  const topPath = join(base, "top.json")
  if (!existsSync(topPath)) {
    console.error(`top.json not found at ${topPath}`)
    process.exit(1)
  }
  const top = readJSON(topPath)

  console.log(`# ${project}`)
  console.log(`${top.description}\n`)
  console.log(`## Modules (${top.nodes.length})\n`)
  for (const node of top.nodes) {
    console.log(formatNode(node))
    console.log()
  }
  console.log("---")
  console.log("Drill into a module: node browse.mjs <doc-root> <project> <ModuleName>")
} else {
  // ── Module drill / page read ──
  const modulePath = rest.filter(r => r !== "--read").join("/")
  const parts = modulePath.split("/")

  if (readFlag) {
    // Read a leaf .md page
    const mdPath = join(base, ...parts) + ".md"
    if (!existsSync(mdPath)) {
      // try as dir/Name.md pattern
      const altPath = join(base, ...parts, parts[parts.length - 1]) + ".md"
      if (existsSync(altPath)) {
        console.log(readFileSync(altPath, "utf-8"))
      } else {
        console.error(`Page not found: ${mdPath}`)
        console.error(`Also tried: ${altPath}`)
        process.exit(1)
      }
    } else {
      console.log(readFileSync(mdPath, "utf-8"))
    }
  } else {
    // Drill into a module graph
    const jsonName = parts[parts.length - 1] + ".json"
    const jsonPath = join(base, ...parts, jsonName)

    if (!existsSync(jsonPath)) {
      // Maybe it's a leaf page — suggest --read
      const mdPath = join(base, ...parts) + ".md"
      if (existsSync(mdPath)) {
        console.log(`"${modulePath}" is a leaf page. Use --read to view its content:`)
        console.log(`  node browse.mjs ${docRoot} ${project} ${modulePath} --read`)
      } else {
        console.error(`Module not found: ${jsonPath}`)
        // list what's available at that level
        const parentDir = join(base, ...parts.slice(0, -1))
        if (existsSync(parentDir)) {
          console.error("\nAvailable at this level:")
          for (const e of readdirSync(parentDir)) {
            const s = statSync(join(parentDir, e))
            if (s.isDirectory() && !e.startsWith("_") && !e.startsWith(".")) {
              console.error(`  ▸ ${e}  [module]`)
            } else if (e.endsWith(".md")) {
              console.error(`  ◦ ${basename(e, ".md")}  [page]`)
            }
          }
        }
      }
      process.exit(1)
    }

    const graph = readJSON(jsonPath)

    console.log(`# ${parts[parts.length - 1]}`)
    console.log(`${graph.description}\n`)
    if (graph.codeScope && graph.codeScope.length > 0) {
      console.log(`Scope: ${graph.codeScope.join(", ")}\n`)
    }
    console.log(`## Children (${graph.nodes.length})\n`)
    for (const node of graph.nodes) {
      console.log(formatNode(node))
      console.log()
    }

    // Show navigation hints
    const graphs = graph.nodes.filter(n => n.child?.type === "graph")
    const pages = graph.nodes.filter(n => n.child?.type === "page")
    console.log("---")
    if (graphs.length > 0) {
      console.log(`Drill deeper: ${graphs.map(n => n.name).join(", ")}`)
    }
    if (pages.length > 0) {
      console.log(`Read pages:  ${pages.map(n => n.name).join(", ")}`)
    }
  }
}
