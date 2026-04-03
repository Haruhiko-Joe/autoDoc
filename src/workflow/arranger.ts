import { readFile, writeFile, mkdir, readdir, access } from "node:fs/promises";
import path from "node:path";
import { Scaffold } from "../agents/scaffold.js";
import { Decomposer } from "../agents/decomposer.js";
import { Checker } from "../agents/checker.js";
import { Writer } from "../agents/writer.js";
import { TopGraph, Graph } from "../agents/schemas/schema.js";
import type {
  TopGraph as TopGraphType,
  Graph as GraphType,
  GraphStatus as GraphStatusType,
  AncestorContext as AncestorContextType,
  AncestorLayer as AncestorLayerType,
  AncestorEdge as AncestorEdgeType,
  GraphNode as GraphNodeType,
  RawTopGraph as RawTopGraphType,
  RawGraph as RawGraphType,
  CheckerIssue as CheckerIssueType,
} from "../agents/schemas/schema.js";

// ─── Checker issue 分类与格式化 ───

/** 图结构相关的 issue type */
const GRAPH_ISSUE_TYPES = new Set(["broken-target", "invalid-path", "empty-content", "missing-ref"]);
/** 文档内容相关的 issue type */
const DOC_ISSUE_TYPES = new Set(["missing-section", "empty-content", "invalid-path", "missing-ref"]);

function formatIssue(issue: CheckerIssueType, index: number): string {
  const severity = issue.severity === "error" ? "[ERROR]" : "[WARNING]";
  const files = issue.files.length > 0 ? `\n   相关文件: ${issue.files.join(", ")}` : "";
  return `${index + 1}. ${severity} [${issue.type}] ${issue.description}${files}`;
}

function buildDecomposerFixPrompt(issues: CheckerIssueType[]): string {
  const graphIssues = issues.filter((i) => GRAPH_ISSUE_TYPES.has(i.type));
  const docIssues = issues.filter((i) => DOC_ISSUE_TYPES.has(i.type) && (i.type === "missing-section" || i.type === "missing-ref"));

  const parts = ["你的子图产出经过 Checker 校验未通过，存在以下问题：", ""];

  if (graphIssues.length > 0) {
    parts.push("### 图结构问题");
    graphIssues.forEach((issue, i) => parts.push(formatIssue(issue, i)));
    parts.push("");
  }

  if (docIssues.length > 0) {
    parts.push("### 文档质量问题（可能需要调整节点的 description 或 codeScope 来辅助 Writer）");
    docIssues.forEach((issue, i) => parts.push(formatIssue(issue, i)));
    parts.push("");
  }

  parts.push(
    "请根据以上问题修正你的输出：",
    "- edges[].target 必须指向当前图中实际存在的节点名称",
    "- codeScope 中的路径必须是目标仓库中实际存在的文件或目录，请用 Glob 验证",
    "- 每个节点的 description 必须非空且有意义",
    "- child.ref 使用简洁英文标识符，不含空格和特殊字符",
    "",
    "请重新输出完整的、修正后的子图 JSON。",
  );

  return parts.join("\n");
}

function buildWriterFixPrompt(issues: CheckerIssueType[], nodeName: string): string {
  const relevant = issues.filter(
    (i) => DOC_ISSUE_TYPES.has(i.type) && i.description.toLowerCase().includes(nodeName.toLowerCase()),
  );
  // 如果没有匹配到特定节点的 issue，则传入所有文档相关的 issue
  const toShow = relevant.length > 0 ? relevant : issues.filter((i) => DOC_ISSUE_TYPES.has(i.type));
  if (toShow.length === 0) return "";

  const parts = [
    `你为模块 "${nodeName}" 生成的文档经过 Checker 校验发现以下问题：`,
    "",
  ];
  toShow.forEach((issue, i) => parts.push(formatIssue(issue, i)));
  parts.push(
    "",
    "请针对以上问题修正文档，确保：",
    "- 包含核心章节（概述与职责、关键流程）",
    "- 文档中引用的代码路径在目标仓库中实际存在",
    "- 内容具有实质性，而非占位符",
    "",
    "请重新输出修正后的完整文档。",
  );
  return parts.join("\n");
}

function buildScaffoldFixPrompt(issues: CheckerIssueType[]): string {
  const parts = [
    "你的顶层模块图经过 Checker 校验未通过，存在以下问题：",
    "",
  ];
  issues.forEach((issue, i) => parts.push(formatIssue(issue, i)));
  parts.push(
    "",
    "请修正后重新输出完整的顶层模块图，确保：",
    "- 所有 codeScope 路径在目标仓库中实际存在",
    "- 所有 edges[].target 指向当前图中存在的节点名称",
    "- 每个节点的 description 非空且有意义",
  );
  return parts.join("\n");
}

export interface NodeProgress {
  nodeId: string
  status: GraphStatusType
}

export interface Progress {
  phase: "scaffold" | "processing" | "idle"
  counts: Record<string, number>
  nodes: NodeProgress[]
}

export class Arranger {
  private readonly maxRetries: number;
  private repoPath = "";
  private docDir = "";
  private currentPhase: Progress["phase"] = "idle";

  constructor(options?: { maxRetries?: number }) {
    this.maxRetries = options?.maxRetries ?? 3;
  }

  /** 公开接口：查询当前进度（供 server 的 /api/status 调用） */
  async getProgress(): Promise<Progress> {
    if (!this.docDir) return { phase: "idle", counts: {}, nodes: [] };
    const counts = await this.countStatuses();
    const allNodeIds = await this.scanGraphNodes(this.docDir, "");
    const nodes: NodeProgress[] = [];
    for (const nodeId of allNodeIds) {
      try {
        const graph = await this.readGraph(nodeId);
        nodes.push({ nodeId, status: graph.status });
      } catch { /* skip */ }
    }
    return { phase: this.currentPhase, counts, nodes };
  }

  // ─── 唯一公开入口 ───

  async run(repoPath: string, docDir = path.resolve("web/doc", path.basename(path.resolve(repoPath)))): Promise<void> {
    this.repoPath = repoPath;
    this.docDir = docDir;

    await this.ensureDocDirs();

    const topExists = await this.fileExists(path.join(this.docDir, "top.json"));
    if (!topExists) {
      console.log("[Arranger] Running scaffold...");
      this.currentPhase = "scaffold";
      await this.runScaffold();
    } else {
      console.log("[Arranger] top.json already exists, skipping scaffold.");
    }

    this.currentPhase = "processing";
    await this.processLoop();
    this.currentPhase = "idle";
    console.log("[Arranger] Done.");
  }

  // ─── 目录初始化 ───

  private async ensureDocDirs(): Promise<void> {
    await mkdir(this.docDir, { recursive: true });
  }

  // ─── Scaffold（含 Checker 校验）───

  private async runScaffold(): Promise<void> {
    const scaffold = new Scaffold();
    const { sessionId, result } = await scaffold.run(
      `Analyze the repository at ${this.repoPath} and produce the top-level module graph.`,
      this.repoPath,
    );

    let topResult: RawTopGraphType = result;
    let finalSessionId = sessionId;

    // Checker 校验 Scaffold 产出，不通过则 scaffold.continue() 重试
    const checker = new Checker();
    let retryCount = 0;
    for (;;) {
      const graphContent = JSON.stringify(topResult, null, 2);
      const checkerPrompt = [
        `Validate the scaffold output for the top-level module graph.`,
        `Repository root: ${this.repoPath}`,
        ``,
        `## Graph JSON content:`,
        "```json",
        graphContent,
        "```",
      ].join("\n");

      const checkerResult = retryCount === 0
        ? await checker.run(checkerPrompt, this.repoPath)
        : await checker.continue(checkerPrompt);

      if (checkerResult.result.passed) {
        console.log("[Arranger] Scaffold check passed.");
        break;
      }

      retryCount++;
      if (retryCount > this.maxRetries) {
        throw new Error(`Scaffold failed after ${this.maxRetries} retries: ${JSON.stringify(checkerResult.result.issues)}`);
      }

      console.log(`[Arranger] Scaffold check failed (retry ${retryCount}/${this.maxRetries})`);
      const fixed = await scaffold.continue(buildScaffoldFixPrompt(checkerResult.result.issues));
      topResult = fixed.result;
      finalSessionId = fixed.sessionId;
    }

    // 校验通过，写入磁盘
    const topGraph: TopGraphType = {
      status: "done",
      retryCount,
      sessionId: finalSessionId,
      description: topResult.description,
      nodes: topResult.nodes,
    };
    await this.writeTopGraph(topGraph);
    console.log(`[Arranger] Scaffold complete. ${topResult.nodes.length} top-level modules.`);

    for (const node of topResult.nodes) {
      const nodeId = node.name;
      const pending: GraphType = {
        status: "pending",
        retryCount: 0,
        sessionId: "",
        description: node.description,
        codeScope: node.codeScope,
        nodes: [],
      };
      await this.writeGraph(nodeId, pending);
    }
  }

  // ─── 主循环 ───

  private async processLoop(): Promise<void> {
    // 恢复中断：decomposing/writing/checking 状态说明上次在管线中途崩溃，重置为 pending
    for (const status of ["decomposing", "writing", "checking"] as const) {
      const interrupted = await this.findGraphsByStatus(status);
      for (const { nodeId } of interrupted) {
        await this.updateGraphStatus(nodeId, "pending");
        console.log(`[Arranger] Reset interrupted graph: ${nodeId} (${status}) → pending`);
      }
    }

    for (let iteration = 1; ; iteration++) {
      const pending = await this.findGraphsByStatus("pending");
      if (pending.length === 0) break;

      const allStatuses = await this.countStatuses();
      console.log(
        `[Arranger] Iteration ${iteration}: ${allStatuses.pending} pending, ${allStatuses.done} done, ${allStatuses.error} error`,
      );

      // 并行处理所有 pending 节点（每个节点内部是原子管线）
      const results = await Promise.allSettled(
        pending.map(({ nodeId }) => this.processNode(nodeId)),
      );
      for (const r of results) {
        if (r.status === "rejected") {
          console.error("[Arranger] Pipeline failed:", r.reason);
        }
      }
    }
  }

  // ─── 单节点原子管线：Decomposer → Writer → Checker（循环直到通过）───

  private async processNode(nodeId: string): Promise<void> {
    const graph = await this.readGraph(nodeId);
    await this.updateGraphStatus(nodeId, "decomposing");
    console.log(`[Arranger] Processing: ${nodeId}`);

    const ancestorContext = await this.buildAncestorContext(nodeId);

    // 1. 首次运行 Decomposer
    const decomposer = new Decomposer();
    const decompParts = [
      `Analyze the code scope and produce a sub-graph for the module "${nodeId}".`,
      `Description: ${graph.description}`,
      `Code scope (files/directories to analyze): ${graph.codeScope.join(", ")}`,
      `Repository root: ${this.repoPath}`,
    ];
    if (ancestorContext) {
      decompParts.push(`\nAncestor context (the module hierarchy above this node):\n${JSON.stringify(ancestorContext, null, 2)}`);
    }
    let decompResult: { sessionId: string; result: RawGraphType };
    try {
      decompResult = await decomposer.run(decompParts.join("\n"), this.repoPath);
    } catch (e) {
      console.error(`[Arranger] Decomposer error for ${nodeId}:`, e);
      await this.updateGraphStatus(nodeId, "error");
      return;
    }

    // 2. 循环：Writer → Checker → (不通过则 Decomposer.continue)
    const checker = new Checker();
    // 为每个叶子节点维护 Writer 实例，以便 continue() 传递 Checker 反馈
    const writerInstances = new Map<string, Writer>();
    let lastCheckerIssues: CheckerIssueType[] | null = null;
    let retryCount = 0;

    for (;;) {
      const rawGraph = decompResult.result;
      console.log(`[Arranger] Decomposed: ${nodeId} → ${rawGraph.nodes.length} child nodes`);

      // 状态观测：writing
      await this.updateGraphStatus(nodeId, "writing");

      // 2a. 并行运行 Writer 为所有叶子节点生成 MD（内存中）
      //     首次用 run()，重试时用 continue() 传递 Checker 的反馈
      const pageNodes = rawGraph.nodes.filter((n) => n.child.type === "page");
      const pageContents = new Map<string, string>(); // ref → md content
      if (pageNodes.length > 0) {
        const writerResults = await Promise.allSettled(
          pageNodes.map(async (node) => {
            const ref = node.child.ref;
            const existingWriter = writerInstances.get(ref);

            let content: string;
            if (existingWriter && lastCheckerIssues) {
              // 重试：continue() 传递 Checker 反馈
              const writerFixPrompt = buildWriterFixPrompt(lastCheckerIssues, node.name);
              const { result } = await existingWriter.continue(writerFixPrompt || "请重新输出修正后的文档。");
              content = result.content;
            } else {
              // 首次生成
              const writer = new Writer();
              writerInstances.set(ref, writer);
              content = await this.generatePageContent(writer, node, ancestorContext);
            }
            return { ref, content };
          }),
        );
        for (const r of writerResults) {
          if (r.status === "fulfilled") {
            pageContents.set(r.value.ref, r.value.content);
          } else {
            console.error("[Arranger] Writer failed:", r.reason);
          }
        }
      }

      // 状态观测：checking
      await this.updateGraphStatus(nodeId, "checking");

      // 2b. Checker 校验（graph JSON + MD 内容全部通过 prompt 传入）
      const graphContent = JSON.stringify(rawGraph, null, 2);
      const mdSections: string[] = [];
      for (const node of pageNodes) {
        const content = pageContents.get(node.child.ref);
        if (content) {
          mdSections.push(`--- FILE: ${node.child.ref}.md (node: ${node.name}) ---\n${content}\n--- END FILE ---`);
        } else {
          mdSections.push(`--- FILE: ${node.child.ref}.md (node: ${node.name}) ---\n[WRITER FAILED]\n--- END FILE ---`);
        }
      }

      const checkerPrompt = [
        `Validate the decomposer and writer output for module "${nodeId}".`,
        `Repository root: ${this.repoPath}`,
        ``,
        `## Graph JSON content:`,
        "```json",
        graphContent,
        "```",
        ``,
        ...(mdSections.length > 0
          ? [`## Leaf Markdown documents:`, ``, ...mdSections]
          : [`## Leaf Markdown documents: (none)`]),
      ].join("\n");

      let checkerResult;
      try {
        checkerResult = retryCount === 0
          ? await checker.run(checkerPrompt, this.repoPath)
          : await checker.continue(checkerPrompt);
      } catch (e) {
        console.error(`[Arranger] Checker error for ${nodeId}:`, e);
        await this.updateGraphStatus(nodeId, "error");
        return;
      }

      // 2c. 通过 → 写入磁盘
      if (checkerResult.result.passed) {
        console.log(`[Arranger] Check passed: ${nodeId}`);
        // 写入 graph JSON（状态直接为 done）
        const finalGraph: GraphType = {
          ...graph,
          status: "done",
          sessionId: decompResult.sessionId,
          nodes: rawGraph.nodes,
        };
        await this.writeGraph(nodeId, finalGraph);

        // 写入所有 MD 文件
        for (const [ref, content] of pageContents) {
          const filePath = path.join(this.docDir, nodeId, `${ref}.md`);
          await mkdir(path.dirname(filePath), { recursive: true });
          await writeFile(filePath, content);
        }

        // 为 graph 类型子节点创建 pending 文件
        const graphNodes = rawGraph.nodes.filter((n) => n.child.type === "graph");
        for (const node of graphNodes) {
          const childId = `${nodeId}/${node.child.ref}`;
          const childPending: GraphType = {
            status: "pending",
            retryCount: 0,
            sessionId: "",
            description: node.description,
            codeScope: node.codeScope,
            nodes: [],
          };
          await this.writeGraph(childId, childPending);
        }

        return; // 管线结束
      }

      // 2d. 不通过 → 保存 issues，Decomposer.continue() 修复
      lastCheckerIssues = checkerResult.result.issues;
      retryCount++;

      if (retryCount > this.maxRetries) break;

      console.log(`[Arranger] Check failed: ${nodeId} (retry ${retryCount}/${this.maxRetries})`);
      try {
        decompResult = await decomposer.continue(buildDecomposerFixPrompt(lastCheckerIssues));
        // Decomposer 返回新图，可能产生新的 page 节点 → 旧 Writer 实例不再适用
        // 清除不再存在的 Writer 实例
        const newRefs = new Set(decompResult.result.nodes.filter((n) => n.child.type === "page").map((n) => n.child.ref));
        for (const ref of writerInstances.keys()) {
          if (!newRefs.has(ref)) writerInstances.delete(ref);
        }
      } catch (e) {
        console.error(`[Arranger] Decomposer continue error for ${nodeId}:`, e);
        await this.updateGraphStatus(nodeId, "error");
        return;
      }
    }

    // 超出最大重试次数
    console.error(`[Arranger] Max retries reached: ${nodeId}, marking as error`);
    const errorGraph: GraphType = { ...graph, status: "error", retryCount };
    await this.writeGraph(nodeId, errorGraph);
  }

  // ─── Writer（返回内容，不写入磁盘）───

  private async generatePageContent(
    writer: Writer,
    node: GraphNodeType,
    ancestorContext: AncestorContextType | null,
  ): Promise<string> {
    console.log(`[Arranger] Generating page: ${node.name}`);

    const parts = [
      `Write comprehensive Markdown documentation for the module "${node.name}".`,
      `Description: ${node.description}`,
      `Code scope (files/directories to read): ${node.codeScope.join(", ")}`,
      `Repository root: ${this.repoPath}`,
    ];
    if (ancestorContext) {
      parts.push(`\nAncestor context (the module hierarchy above this node):\n${JSON.stringify(ancestorContext, null, 2)}`);
    }

    const { result } = await writer.run(parts.join("\n"), this.repoPath);
    console.log(`[Arranger] Page generated: ${node.name}`);
    return result.content;
  }

  // ─── AncestorContext 构造 ───

  private async buildAncestorContext(nodeId: string): Promise<AncestorContextType | null> {
    const segments = nodeId.split("/");
    if (segments.length < 1) return null;

    const ancestors: AncestorLayerType[] = [];

    const extractEdges = (nodes: { name: string; edges: { target: string; type: string; description: string }[] }[]): AncestorEdgeType[] =>
      nodes.flatMap((n) =>
        n.edges.map((e) => ({
          source: n.name,
          target: e.target,
          type: e.type as AncestorEdgeType["type"],
          description: e.description,
        })),
      );

    // Layer 0: top.json
    const top = await this.readTopGraph();
    ancestors.push({
      name: "top",
      depth: 0,
      siblings: top.nodes.map((n: { name: string; description: string }) => ({ name: n.name, description: n.description })),
      edges: extractEdges(top.nodes),
    });

    // Layer 1+: each intermediate graph
    for (let i = 0; i < segments.length - 1; i++) {
      const parentId = segments.slice(0, i + 1).join("/");
      const parentGraph = await this.readGraph(parentId);
      ancestors.push({
        name: segments[i]!,
        depth: i + 1,
        siblings: parentGraph.nodes.map((n: { name: string; description: string }) => ({ name: n.name, description: n.description })),
        edges: extractEdges(parentGraph.nodes),
      });
    }

    return { path: segments, ancestors };
  }

  // ─── 文件扫描 ───

  private async findGraphsByStatus(
    status: GraphStatusType,
  ): Promise<Array<{ nodeId: string; graph: GraphType }>> {
    const allNodeIds = await this.scanGraphNodes(this.docDir, "");
    const results: Array<{ nodeId: string; graph: GraphType }> = [];
    for (const nodeId of allNodeIds) {
      try {
        const graph = await this.readGraph(nodeId);
        if (graph.status === status) {
          results.push({ nodeId, graph });
        }
      } catch {
        console.warn(`[Arranger] Skipping unreadable graph: ${nodeId}`);
      }
    }
    return results;
  }

  private async countStatuses(): Promise<Record<string, number>> {
    const counts: Record<string, number> = { pending: 0, decomposing: 0, writing: 0, checking: 0, done: 0, error: 0 };
    const allNodeIds = await this.scanGraphNodes(this.docDir, "");
    for (const nodeId of allNodeIds) {
      try {
        const graph = await this.readGraph(nodeId);
        counts[graph.status] = (counts[graph.status] ?? 0) + 1;
      } catch { /* skip */ }
    }
    return counts;
  }

  /** 递归扫描 doc/ 下匹配 {dirName}/{dirName}.json 模式的目录，返回 nodeId 列表 */
  private async scanGraphNodes(dir: string, prefix: string): Promise<string[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodeIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nodeId = prefix ? `${prefix}/${entry.name}` : entry.name;
      const selfJson = path.join(dir, entry.name, `${entry.name}.json`);
      if (await this.fileExists(selfJson)) {
        nodeIds.push(nodeId);
      }
      const sub = await this.scanGraphNodes(path.join(dir, entry.name), nodeId);
      nodeIds.push(...sub);
    }
    return nodeIds;
  }

  // ─── 文件 I/O ───

  private graphFilePath(nodeId: string): string {
    const lastName = nodeId.split("/").pop()!;
    return path.join(this.docDir, nodeId, `${lastName}.json`);
  }

  private async readGraph(nodeId: string): Promise<GraphType> {
    const raw = await readFile(this.graphFilePath(nodeId), "utf-8");
    return Graph.parse(JSON.parse(raw));
  }

  private async writeGraph(nodeId: string, graph: GraphType): Promise<void> {
    const filePath = this.graphFilePath(nodeId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(graph, null, 2));
  }

  private async updateGraphStatus(nodeId: string, status: GraphStatusType): Promise<void> {
    const graph = await this.readGraph(nodeId);
    graph.status = status;
    await this.writeGraph(nodeId, graph);
  }

  private async readTopGraph(): Promise<TopGraphType> {
    const filePath = path.join(this.docDir, "top.json");
    const raw = await readFile(filePath, "utf-8");
    return TopGraph.parse(JSON.parse(raw));
  }

  private async writeTopGraph(topGraph: TopGraphType): Promise<void> {
    const filePath = path.join(this.docDir, "top.json");
    await writeFile(filePath, JSON.stringify(topGraph, null, 2));
  }


  // ─── 工具 ───

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
