#!/usr/bin/env node

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join, resolve, basename } from "node:path"

const [,, docRoot, project, ...rest] = process.argv

if (!docRoot || !project) {
  console.error("Usage: node browse.mjs <doc-root> <project> [module-path] [--read|--search <kw>|--flows]")
  process.exit(1)
}

const base = resolve(docRoot, project)
if (!existsSync(base)) {
  console.error(`Project not found: ${base}`)
  process.exit(1)
}

// ─── Helpers ───

function readJSON(p) {
  return JSON.parse(readFileSync(p, "utf-8"))
}

function formatEdges(edges) {
  if (!edges || edges.length === 0) return ""
  return "\n" + edges.map(e => `    → [${e.type}] ${e.target}: ${e.description}`).join("\n")
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

function formatFlow(flow, index) {
  const lines = [`## ${index + 1}. ${flow.title}`, flow.description, ""]
  if (flow.participants?.length > 0) {
    lines.push("Participants:")
    for (const participant of flow.participants) {
      const suffix = participant.docPath ? ` (${participant.docPath})` : ""
      lines.push(`  - ${participant.name}${suffix}: ${participant.description}`)
    }
    lines.push("")
  }
  if (flow.steps?.length > 0) {
    lines.push("Steps:")
    flow.steps.forEach((step, stepIndex) => {
      const edge = step.edgeType ? ` [${step.edgeType}]` : ""
      lines.push(`  ${stepIndex + 1}. ${step.from} -> ${step.to}${edge}: ${step.action}`)
      lines.push(`     ${step.detail}`)
      if (step.codeRef) lines.push(`     code: ${step.codeRef}`)
    })
  }
  return lines.join("\n")
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
const flowsFlag = rest.includes("--flows")

if (flowsFlag) {
  const flowsPath = join(base, "flows.json")
  if (!existsSync(flowsPath)) {
    console.error(`flows.json not found at ${flowsPath}`)
    process.exit(1)
  }
  const data = readJSON(flowsPath)
  const flows = Array.isArray(data.flows) ? data.flows : []
  console.log(`# ${project} interaction flows\n`)
  if (flows.length === 0) {
    console.log("No flows found.")
  } else {
    flows.forEach((flow, index) => {
      console.log(formatFlow(flow, index))
      console.log()
    })
  }
} else if (searchIdx !== -1) {
  const keyword = rest.slice(searchIdx + 1).join(" ").toLowerCase()
  if (!keyword) {
    console.error("--search requires a keyword")
    process.exit(1)
  }

  console.log(`Searching "${keyword}" in ${project}...\n`)

  const topPath = join(base, "top.json")
  if (existsSync(topPath)) {
    const top = readJSON(topPath)
    for (const n of top.nodes) {
      if (n.name.toLowerCase().includes(keyword) || n.description.toLowerCase().includes(keyword)) {
        console.log(`[top] ${n.name}: ${n.description}\n`)
      }
    }
  }

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
    const mdPath = join(base, ...parts) + ".md"
    if (existsSync(mdPath)) {
      console.log(readFileSync(mdPath, "utf-8"))
    } else {
      // Check if it's a graph node instead of a leaf page
      const jsonName = parts[parts.length - 1] + ".json"
      const jsonPath = join(base, ...parts, jsonName)
      if (existsSync(jsonPath)) {
        console.error(`"${modulePath}" is a graph (sub-module), not a leaf page.`)
        console.error(`Drill into it first:`)
        console.error(`  node browse.mjs ${docRoot} ${project} ${modulePath}`)
      } else {
        console.error(`Page not found: ${mdPath}`)
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
  } else {
    const jsonName = parts[parts.length - 1] + ".json"
    const jsonPath = join(base, ...parts, jsonName)

    if (!existsSync(jsonPath)) {
      const mdPath = join(base, ...parts) + ".md"
      if (existsSync(mdPath)) {
        console.log(`"${modulePath}" is a leaf page. Use --read to view its content:`)
        console.log(`  node browse.mjs ${docRoot} ${project} ${modulePath} --read`)
      } else {
        console.error(`Module not found: ${jsonPath}`)
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
