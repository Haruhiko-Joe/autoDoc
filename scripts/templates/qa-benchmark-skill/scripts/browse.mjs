#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(skillDir, "config.json");

if (!existsSync(configPath)) {
  console.error(`Missing config.json at ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, "utf-8"));
const docRoot = config.docRoot;
const project = config.project;

if (typeof docRoot !== "string" || typeof project !== "string") {
  console.error("config.json must contain string fields: docRoot, project");
  process.exit(1);
}

const rest = process.argv.slice(2);
const base = resolve(docRoot, project);

if (!existsSync(base)) {
  console.error(`Project docs not found: ${base}`);
  process.exit(1);
}

if (rest.includes("--help") || rest.includes("-h")) {
  console.log([
    "Usage: node browse.mjs [module-path] [--read|--search <keyword>|--flows]",
    "",
    "Config is loaded from ../config.json:",
    `  project: ${project}`,
    `  docRoot: ${docRoot}`,
    "",
    "Examples:",
    "  node browse.mjs",
    "  node browse.mjs --flows",
    "  node browse.mjs --search transport",
    "  node browse.mjs CommandSurface",
    "  node browse.mjs CommandSurface/CommandDispatchCore --read",
  ].join("\n"));
  process.exit(0);
}

function readJSON(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function formatEdges(edges) {
  if (!edges || edges.length === 0) return "";
  return "\n" + edges.map((edge) => `    -> [${edge.type}] ${edge.target}: ${edge.description}`).join("\n");
}

function formatNode(node, indent = "") {
  const tag = node.child ? (node.child.type === "graph" ? ">" : "-") : "*";
  let line = `${indent}${tag} ${node.name}`;
  if (node.child) line += `  [${node.child.type}]`;
  line += `\n${indent}  ${node.description}`;
  if (node.codeScope && node.codeScope.length > 0) {
    line += `\n${indent}  scope: ${node.codeScope.join(", ")}`;
  }
  if (node.edges && node.edges.length > 0) {
    line += formatEdges(node.edges).replace(/^/gm, indent);
  }
  return line;
}

function formatFlow(flow, index) {
  const lines = [`## ${index + 1}. ${flow.title}`, flow.description, ""];
  if (flow.participants?.length > 0) {
    lines.push("Participants:");
    for (const participant of flow.participants) {
      const suffix = participant.docPath ? ` (${participant.docPath})` : "";
      lines.push(`  - ${participant.name}${suffix}: ${participant.description}`);
    }
    lines.push("");
  }
  if (flow.steps?.length > 0) {
    lines.push("Steps:");
    flow.steps.forEach((step, stepIndex) => {
      const edge = step.edgeType ? ` [${step.edgeType}]` : "";
      lines.push(`  ${stepIndex + 1}. ${step.from} -> ${step.to}${edge}: ${step.action}`);
      lines.push(`     ${step.detail}`);
      if (step.codeRef) lines.push(`     code: ${step.codeRef}`);
    });
  }
  return lines.join("\n");
}

function collectAllNodes(dir, prefix = "") {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isFile() && entry.endsWith(".json") && entry !== "top.json") {
      try {
        const graph = readJSON(full);
        if (graph.nodes) {
          const moduleName = basename(entry, ".json");
          const modulePath = prefix ? `${prefix}/${moduleName}` : moduleName;
          for (const node of graph.nodes) {
            results.push({ ...node, _modulePath: modulePath });
          }
        }
      } catch {}
    } else if (st.isDirectory() && !entry.startsWith("_") && !entry.startsWith(".")) {
      const sub = prefix ? `${prefix}/${entry}` : entry;
      results.push(...collectAllNodes(full, sub));
    }
  }
  return results;
}

function printAvailable(parentDir) {
  if (!existsSync(parentDir)) return;
  console.error("\nAvailable at this level:");
  for (const entry of readdirSync(parentDir)) {
    const full = join(parentDir, entry);
    const st = statSync(full);
    if (st.isDirectory() && !entry.startsWith("_") && !entry.startsWith(".")) {
      console.error(`  > ${entry}  [module]`);
    } else if (entry.endsWith(".md")) {
      console.error(`  - ${basename(entry, ".md")}  [page]`);
    }
  }
}

const searchIdx = rest.indexOf("--search");
const readFlag = rest.includes("--read");
const flowsFlag = rest.includes("--flows");

if (flowsFlag) {
  const flowsPath = join(base, "flows.json");
  if (!existsSync(flowsPath)) {
    console.error(`flows.json not found at ${flowsPath}`);
    process.exit(1);
  }
  const data = readJSON(flowsPath);
  const flows = Array.isArray(data.flows) ? data.flows : [];
  console.log(`# ${project} interaction flows\n`);
  if (flows.length === 0) {
    console.log("No flows found.");
  } else {
    flows.forEach((flow, index) => {
      console.log(formatFlow(flow, index));
      console.log();
    });
  }
} else if (searchIdx !== -1) {
  const keyword = rest.slice(searchIdx + 1).join(" ").toLowerCase();
  if (!keyword) {
    console.error("--search requires a keyword");
    process.exit(1);
  }

  console.log(`Searching "${keyword}" in ${project}...\n`);

  const topPath = join(base, "top.json");
  if (existsSync(topPath)) {
    const top = readJSON(topPath);
    for (const node of top.nodes) {
      if (node.name.toLowerCase().includes(keyword) || node.description.toLowerCase().includes(keyword)) {
        console.log(`[top] ${node.name}: ${node.description}\n`);
      }
    }
  }

  for (const node of collectAllNodes(base)) {
    if (node.name.toLowerCase().includes(keyword) || node.description.toLowerCase().includes(keyword)) {
      console.log(`[${node._modulePath}] ${node.name} [${node.child?.type || "?"}]: ${node.description}\n`);
    }
  }
} else if (rest.length === 0) {
  const topPath = join(base, "top.json");
  if (!existsSync(topPath)) {
    console.error(`top.json not found at ${topPath}`);
    process.exit(1);
  }
  const top = readJSON(topPath);

  console.log(`# ${project}`);
  console.log(`${top.description}\n`);
  console.log(`## Modules (${top.nodes.length})\n`);
  for (const node of top.nodes) {
    console.log(formatNode(node));
    console.log();
  }
  console.log("---");
  console.log("Drill into a module: node browse.mjs <ModuleName>");
  console.log("Search nodes: node browse.mjs --search <keyword>");
  console.log("Read flows: node browse.mjs --flows");
} else {
  const modulePath = rest.filter((part) => part !== "--read").join("/");
  const parts = modulePath.split("/");

  if (readFlag) {
    const mdPath = join(base, ...parts) + ".md";
    if (existsSync(mdPath)) {
      console.log(readFileSync(mdPath, "utf-8"));
    } else {
      const jsonName = parts[parts.length - 1] + ".json";
      const jsonPath = join(base, ...parts, jsonName);
      if (existsSync(jsonPath)) {
        console.error(`"${modulePath}" is a graph, not a leaf page. Drill into it first.`);
        console.error(`  node browse.mjs ${modulePath}`);
      } else {
        console.error(`Page not found: ${mdPath}`);
        printAvailable(join(base, ...parts.slice(0, -1)));
      }
      process.exit(1);
    }
  } else {
    const jsonName = parts[parts.length - 1] + ".json";
    const jsonPath = join(base, ...parts, jsonName);

    if (!existsSync(jsonPath)) {
      const mdPath = join(base, ...parts) + ".md";
      if (existsSync(mdPath)) {
        console.log(`"${modulePath}" is a leaf page. Use --read to view it.`);
        console.log(`  node browse.mjs ${modulePath} --read`);
      } else {
        console.error(`Module not found: ${jsonPath}`);
        printAvailable(join(base, ...parts.slice(0, -1)));
      }
      process.exit(1);
    }

    const graph = readJSON(jsonPath);
    console.log(`# ${parts[parts.length - 1]}`);
    console.log(`${graph.description}\n`);
    if (graph.codeScope && graph.codeScope.length > 0) {
      console.log(`Scope: ${graph.codeScope.join(", ")}\n`);
    }
    console.log(`## Children (${graph.nodes.length})\n`);
    for (const node of graph.nodes) {
      console.log(formatNode(node));
      console.log();
    }

    const graphs = graph.nodes.filter((node) => node.child?.type === "graph");
    const pages = graph.nodes.filter((node) => node.child?.type === "page");
    console.log("---");
    if (graphs.length > 0) console.log(`Drill deeper: ${graphs.map((node) => node.name).join(", ")}`);
    if (pages.length > 0) console.log(`Read pages: ${pages.map((node) => node.name).join(", ")}`);
  }
}
