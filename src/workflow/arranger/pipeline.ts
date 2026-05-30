import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRunLog } from "../../souko/runLog.js";
import type {
  AncestorContext as AncestorContextType,
  CheckerIssue as CheckerIssueType,
  Graph as GraphType,
  GraphNode as GraphNodeType,
  IChecker,
  IDecomposer,
  IScaffold,
  IWriter,
  RawGraph as RawGraphType,
  RawTopGraph as RawTopGraphType,
} from "../../agents/schemas/schema.js";
import type { AgentFactory } from "./agentFactory.js";
import type { GraphStore } from "./graphStore.js";
import type { PromptBuilder } from "./promptBuilder.js";
import { type Semaphore, withRetry, withSemaphore, withTimeout } from "./runtime.js";
import type { DecompositionReviewMode } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_TEMPLATE_DIR = path.resolve(__dirname, "..", "..", "skill-template");
const ACCEED_MCP_TOOLS = [
  "list_projects",
  "get_top",
  "get_flows",
  "get_graph",
  "get_page",
  "search_nodes",
  "list_source_files",
  "read_source_files",
  "list_docs",
  "read_docs",
  "patch_page",
  "update_page",
  "update_node",
  "update_graph_meta",
  "create_node",
  "delete_node",
  "update_top",
];

interface PipelineOptions {
  repoPath: string
  store: GraphStore
  agentFactory: AgentFactory
  promptBuilder: PromptBuilder
  semaphore: Semaphore
  decompositionReview: DecompositionReviewMode
  checkerEnabled: boolean
}

export class Pipeline {
  constructor(private readonly options: PipelineOptions) {}

  async runScaffold(): Promise<void> {
    const { agentFactory, promptBuilder, repoPath, store } = this.options;

    await appendRunLog(store.projectName, `scaffold invoke backend=${agentFactory.getBackend("scaffold")}`);
    const { topResult, finalSessionId } = await withRetry(async () => {
      const scaffold = agentFactory.makeScaffold();
      const { sessionId, result } = await scaffold.run(
        promptBuilder.scaffoldPrompt(),
        repoPath,
      );

      const checked = await this.checkScaffoldResult(result, scaffold, sessionId);
      return { topResult: checked.topResult, finalSessionId: checked.finalSessionId };
    });

    if (this.options.decompositionReview === "all") {
      await store.initializeScaffoldReview(topResult, finalSessionId);
      await appendRunLog(store.projectName, `scaffold awaiting-review nodes=${topResult.nodes.length}`);
    } else {
      await store.initializeFromScaffold(topResult, finalSessionId);
    }
    console.log(`[Arranger] Scaffold complete. ${topResult.nodes.length} top-level modules.`);
  }

  async processGraphTask(nodeId: string, graph: GraphType): Promise<void> {
    const { promptBuilder, store } = this.options;
    const ancestorContext = await store.buildAncestorContext(nodeId);
    const nodeKnowledge = await store.resolveNodeKnowledge(nodeId);

    console.log(`[Arranger] Processing graph task: ${nodeId}`);
    await appendRunLog(store.projectName, `graph task start node=${nodeId}`);

    let rawGraph: RawGraphType;
    let decomposerSessionId: string;
    try {
      const result = await withRetry(async (attempt) => {
        const prompt = promptBuilder.decomposerPrompt(nodeId, graph, ancestorContext, nodeKnowledge);
        const existing = attempt === 0 ? {
          rawGraph: graph.status === "checking" && graph.nodes.length > 0 ? { nodes: graph.nodes } : undefined,
          decomposerSessionId: graph.decomposerSessionId,
          checkerSessionId: graph.checkerSessionId,
        } : undefined;
        return withTimeout(() => this.decomposeAndCheck(nodeId, prompt, existing, nodeKnowledge), 15 * 60_000, `decomposer ${nodeId}`);
      });
      rawGraph = result.rawGraph;
      decomposerSessionId = result.decomposerSessionId;
    } catch (e) {
      console.error(`[Arranger] Decompose+check failed for ${nodeId}:`, e);
      await store.markGraphError(nodeId);
      return;
    }

    console.log(`[Arranger] Decomposed: ${nodeId} → ${rawGraph.nodes.length} child nodes`);
    await appendRunLog(store.projectName, `graph task done node=${nodeId} children=${rawGraph.nodes.length}`);
    if (this.options.decompositionReview === "all") {
      await store.markGraphAwaitingReview(nodeId, rawGraph, decomposerSessionId);
      await appendRunLog(store.projectName, `graph awaiting-review node=${nodeId} children=${rawGraph.nodes.length}`);
    } else {
      await store.markGraphDecomposed(nodeId, rawGraph, decomposerSessionId);
    }
  }

  async redoScaffoldReview(feedback: string): Promise<void> {
    const { agentFactory, promptBuilder, repoPath, store } = this.options;
    const sessionId = await store.getScaffoldReviewSession();
    const current = await store.getScaffoldReviewCandidate();
    const scaffold = agentFactory.makeScaffold();
    scaffold.restore(sessionId, repoPath);
    await appendRunLog(store.projectName, `scaffold review redo feedback-len=${feedback.length}`);
    const fixed = await scaffold.continue(promptBuilder.scaffoldReviewFeedbackPrompt(current, feedback));
    const checked = await this.checkScaffoldResult(fixed.result, scaffold, fixed.sessionId);
    if (!(await store.isScaffoldStillAwaitingReview(sessionId))) {
      await appendRunLog(store.projectName, `scaffold review redo aborted (state moved on)`);
      return;
    }
    await store.initializeScaffoldReview(checked.topResult, checked.finalSessionId);
    await appendRunLog(store.projectName, `scaffold review redo awaiting-review nodes=${checked.topResult.nodes.length}`);
  }

  async redoGraphReview(nodeId: string, feedback: string): Promise<void> {
    const { agentFactory, promptBuilder, repoPath, store } = this.options;
    const graph = await store.getGraphReview(nodeId);
    const nodeKnowledge = await store.resolveNodeKnowledge(nodeId);
    const sessionId = graph.decomposerSessionId ?? graph.sessionId;
    if (!sessionId) throw new Error(`Review has no decomposer session: ${nodeId}`);
    const decomposer = agentFactory.makeDecomposer();
    decomposer.restore(sessionId, repoPath);
    await appendRunLog(store.projectName, `graph review redo node=${nodeId} feedback-len=${feedback.length}`);
    const fixed = await decomposer.continue(promptBuilder.decomposerReviewFeedbackPrompt(nodeId, { nodes: graph.nodes }, feedback, nodeKnowledge));
    const checked = await this.checkRawGraphWithFix(nodeId, fixed.result, decomposer, nodeKnowledge);
    if (!(await store.isGraphStillAwaitingReview(nodeId, sessionId))) {
      await appendRunLog(store.projectName, `graph review redo aborted node=${nodeId} (state moved on)`);
      return;
    }
    await store.markGraphAwaitingReview(nodeId, checked.rawGraph, checked.decomposerSessionId);
    await appendRunLog(store.projectName, `graph review redo awaiting-review node=${nodeId} children=${checked.rawGraph.nodes.length}`);
  }

  async processPageTask(nodeId: string, ref: string, graph: GraphType): Promise<void> {
    const { store } = this.options;
    const ancestorContext = await store.buildAncestorContext(nodeId);
    const nodeKnowledge = await store.resolveNodeKnowledge(nodeId);
    const pageNode = store.findPageNode(graph, ref);
    if (!pageNode) {
      console.error(`[Arranger] Missing page node for ${nodeId}/${ref}`);
      await appendRunLog(store.projectName, `page task error node=${nodeId} ref=${ref} error=missing-page-node`);
      await store.markGraphError(nodeId);
      return;
    }

    await appendRunLog(store.projectName, `page task start node=${nodeId} ref=${ref}`);

    let content: string;
    try {
      content = await withRetry(() => withTimeout(() => this.writePage(pageNode, ancestorContext, nodeKnowledge), 10 * 60_000, `writer ${pageNode.name}`));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[Arranger] Write failed for ${nodeId}/${ref}:`, e);
      await appendRunLog(store.projectName, `page task error node=${nodeId} ref=${ref} error=${msg.slice(0, 200)}`);
      await store.markPageError(nodeId, ref);
      return;
    }

    await store.writePage(nodeId, ref, content);

    await store.markPageDone(nodeId, ref);
    await appendRunLog(store.projectName, `page task done node=${nodeId} ref=${ref}`);
    await store.finishNodeIfReady(nodeId);
  }

  async assembleSkill(repoPath: string): Promise<string> {
    const claudeSkillDir = path.join(repoPath, ".claude", "skills", "doc-drill");
    const codexSkillDir = path.join(repoPath, ".codex", "skills", "doc-drill");
    const templatePath = path.join(SKILL_TEMPLATE_DIR, "SKILL.md");
    console.log(`[Arranger] Assembling doc-drill skill at ${claudeSkillDir} and ${codexSkillDir}...`);
    await Promise.all(
      [claudeSkillDir, codexSkillDir].map(async (dir) => {
        await mkdir(dir, { recursive: true });
        await copyFile(templatePath, path.join(dir, "SKILL.md"));
      }),
    );
    await this.writeClaudeMcpConfig(repoPath);
    await this.writeCodexMcpConfig(repoPath);
    console.log(`[Arranger] Skill assembled.`);
    return codexSkillDir;
  }

  async runFlowAnalysis(): Promise<void> {
    const { agentFactory, promptBuilder, repoPath, store } = this.options;
    if (await store.hasFlows()) {
      console.log("[Arranger] flows.json already exists, skipping flow analysis.");
      return;
    }

    console.log("[Arranger] Running flow analysis...");
    await appendRunLog(store.projectName, `flowAnalyzer invoke backend=${agentFactory.getBackend("flowAnalyzer")}`);
    const { result } = await withRetry(async () => {
      const analyzer = agentFactory.makeFlowAnalyzer(store.docDir, store.projectName);
      return analyzer.run(promptBuilder.flowPrompt(), repoPath);
    });

    await store.writeFlows(result);
    console.log(`[Arranger] Flow analysis complete. ${result.flows.length} flows generated.`);
  }

  private async decomposeAndCheck(
    nodeId: string,
    prompt: string,
    existing?: { rawGraph?: RawGraphType; decomposerSessionId?: string; checkerSessionId?: string },
    nodeKnowledge?: string,
  ): Promise<{ rawGraph: RawGraphType; decomposerSessionId: string }> {
    const { agentFactory, promptBuilder, repoPath, semaphore, store } = this.options;
    const decomposer = agentFactory.makeDecomposer();
    const checker = this.options.checkerEnabled ? agentFactory.makeChecker() : undefined;

    if (existing?.decomposerSessionId) {
      decomposer.restore(existing.decomposerSessionId, repoPath);
    }
    if (checker && existing?.checkerSessionId) {
      checker.restore(existing.checkerSessionId, repoPath);
    }

    let rawGraph: RawGraphType;
    if (existing?.rawGraph) {
      rawGraph = existing.rawGraph;
    } else {
      const mode = decomposer.getSessionId() ? "continue" : "run";
      await appendRunLog(store.projectName, `decomposer invoke node=${nodeId} mode=${mode} backend=${agentFactory.getBackend("decomposer")}`);
      rawGraph = (await withSemaphore(semaphore, () =>
        decomposer.getSessionId()
          ? decomposer.continue(prompt)
          : decomposer.run(prompt, repoPath),
      )).result;
    }

    if (!this.options.checkerEnabled) {
      await appendRunLog(store.projectName, `checker skip scope=decomposer node=${nodeId}`);
      return { rawGraph, decomposerSessionId: decomposer.getSessionId() ?? "" };
    }

    const checked = await this.checkerLoop({
      scope: "decomposer",
      nodeId,
      initialResult: rawGraph,
      checker,
      getCheckerPrompt: (r) => promptBuilder.graphCheckerPrompt(nodeId, r, nodeKnowledge),
      runChecker: (c, prompt) => withSemaphore(semaphore, () =>
        c.getSessionId() ? c.continue(prompt) : c.run(prompt, repoPath)),
      fix: (issues) => withSemaphore(semaphore, async () => {
        const { result, sessionId } = await decomposer.continue(promptBuilder.decomposerFixPrompt(issues));
        return { result, sessionId };
      }),
    });
    return { rawGraph: checked.result, decomposerSessionId: decomposer.getSessionId() ?? "" };
  }

  private async checkerLoop<T>(opts: {
    scope: string;
    nodeId?: string;
    initialResult: T;
    checker?: IChecker;
    getCheckerPrompt: (result: T) => string;
    fix: (issues: CheckerIssueType[]) => Promise<{ result: T; sessionId: string }>;
    runChecker?: (checker: IChecker, prompt: string) => Promise<{ result: { passed: boolean; issues: CheckerIssueType[] } }>;
  }): Promise<{ result: T; sessionId: string }> {
    const { agentFactory, repoPath, store } = this.options;
    const checker = opts.checker ?? agentFactory.makeChecker();
    let result = opts.initialResult;
    let sessionId = "";
    const label = opts.nodeId ? `${opts.scope} node=${opts.nodeId}` : opts.scope;

    const runChecker = opts.runChecker ?? ((c: IChecker, prompt: string) =>
      c.getSessionId() ? c.continue(prompt) : c.run(prompt, repoPath));

    for (let retry = 0; ; retry++) {
      await appendRunLog(store.projectName, `checker invoke scope=${label} retry=${retry}`);
      const checkerResult = await runChecker(checker, opts.getCheckerPrompt(result));

      if (checkerResult.result.passed) {
        console.log(`[Arranger] ${opts.scope} check passed${opts.nodeId ? `: ${opts.nodeId}` : ""}.`);
        await appendRunLog(store.projectName, `checker pass scope=${label}`);
        return { result, sessionId };
      }
      if (retry >= 5) throw new Error(`${opts.scope} check failed after 5 retries${opts.nodeId ? ` for ${opts.nodeId}` : ""}: ${JSON.stringify(checkerResult.result.issues)}`);

      console.log(`[Arranger] ${opts.scope} check failed${opts.nodeId ? `: ${opts.nodeId}` : ""} (retry ${retry + 1}/5)`);
      await appendRunLog(store.projectName, `checker fail scope=${label} retry=${retry + 1}`);
      await appendRunLog(store.projectName, `${opts.scope} continue${opts.nodeId ? ` node=${opts.nodeId}` : ""} retry=${retry + 1}`);
      const fixed = await opts.fix(checkerResult.result.issues);
      result = fixed.result;
      sessionId = fixed.sessionId;
    }
  }

  private async checkScaffoldResult(
    initialTopResult: RawTopGraphType,
    scaffold: IScaffold,
    initialSessionId: string,
  ): Promise<{ topResult: RawTopGraphType; finalSessionId: string }> {
    const { promptBuilder, store } = this.options;
    if (!this.options.checkerEnabled) {
      await appendRunLog(store.projectName, `checker skip scope=scaffold`);
      return { topResult: initialTopResult, finalSessionId: initialSessionId };
    }

    const { result: topResult, sessionId } = await this.checkerLoop({
      scope: "scaffold",
      initialResult: initialTopResult,
      getCheckerPrompt: (r) => promptBuilder.scaffoldCheckerPrompt(r),
      fix: async (issues) => {
        const fixed = await scaffold.continue(promptBuilder.scaffoldFixPrompt(issues));
        return { result: fixed.result, sessionId: fixed.sessionId };
      },
    });
    return { topResult, finalSessionId: sessionId || initialSessionId };
  }

  private async checkRawGraphWithFix(
    nodeId: string,
    initialRawGraph: RawGraphType,
    decomposer: IDecomposer,
    nodeKnowledge?: string,
  ): Promise<{ rawGraph: RawGraphType; decomposerSessionId: string }> {
    const { promptBuilder, semaphore, store } = this.options;
    if (!this.options.checkerEnabled) {
      await appendRunLog(store.projectName, `checker skip scope=decomposer node=${nodeId}`);
      return { rawGraph: initialRawGraph, decomposerSessionId: decomposer.getSessionId() ?? "" };
    }

    const { result: rawGraph } = await this.checkerLoop({
      scope: "decomposer",
      nodeId,
      initialResult: initialRawGraph,
      getCheckerPrompt: (r) => promptBuilder.graphCheckerPrompt(nodeId, r, nodeKnowledge),
      runChecker: (c, prompt) => withSemaphore(this.options.semaphore, () =>
        c.getSessionId() ? c.continue(prompt) : c.run(prompt, this.options.repoPath)),
      fix: (issues) => withSemaphore(semaphore, async () => {
        const { result, sessionId } = await decomposer.continue(promptBuilder.decomposerFixPrompt(issues));
        return { result, sessionId };
      }),
    });
    return { rawGraph, decomposerSessionId: decomposer.getSessionId() ?? "" };
  }

  private async writePage(
    pageNode: GraphNodeType,
    ancestorContext: AncestorContextType | null,
    nodeKnowledge?: string,
  ): Promise<string> {
    const writer = this.options.agentFactory.makeWriter();
    return withSemaphore(this.options.semaphore, () =>
      this.generatePageContent(writer, pageNode, ancestorContext, nodeKnowledge),
    );
  }

  private async generatePageContent(
    writer: IWriter,
    node: GraphNodeType,
    ancestorContext: AncestorContextType | null,
    nodeKnowledge?: string,
  ): Promise<string> {
    const { agentFactory, promptBuilder, repoPath, store } = this.options;

    console.log(`[Arranger] Generating page: ${node.name}`);
    await appendRunLog(store.projectName, `writer invoke node=${node.name} backend=${agentFactory.getBackend("writer")}`);

    const { result } = await writer.run(promptBuilder.writerPrompt(node, ancestorContext, nodeKnowledge), repoPath);
    console.log(`[Arranger] Page generated: ${node.name}`);
    await appendRunLog(store.projectName, `writer return node=${node.name} len=${result.length}`);
    return result;
  }

  private mcpUrl(): string {
    return process.env.ACCEED_PUBLIC_MCP_URL
      ?? process.env.ACCEED_MCP_URL
      ?? `http://localhost:${process.env.PORT ?? 3100}/mcp`;
  }

  private async writeClaudeMcpConfig(repoPath: string): Promise<void> {
    const filePath = path.join(repoPath, ".mcp.json");
    const raw = await readFile(filePath, "utf-8").catch(() => "{}");
    const parsed: unknown = JSON.parse(raw);
    const current = isRecord(parsed) ? parsed : {};
    const mcpServers = isRecord(current.mcpServers) ? current.mcpServers : {};
    const next = {
      ...current,
      mcpServers: {
        ...mcpServers,
        acceed: { type: "http", url: this.mcpUrl() },
      },
    };
    await writeFile(filePath, JSON.stringify(next, null, 2));
  }

  private async writeCodexMcpConfig(repoPath: string): Promise<void> {
    const codexDir = path.join(repoPath, ".codex");
    const filePath = path.join(codexDir, "config.toml");
    await mkdir(codexDir, { recursive: true });
    const current = await readFile(filePath, "utf-8").catch(() => "");
    await writeFile(filePath, updateAcceedMcpBlock(current, this.mcpUrl()));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderAcceedMcpBlock(url: string): string {
  return [
    "[mcp_servers.acceed]",
    `url = "${url}"`,
    `enabled_tools = [${ACCEED_MCP_TOOLS.map((tool) => `"${tool}"`).join(", ")}]`,
    "",
  ].join("\n");
}

function updateAcceedMcpBlock(current: string, url: string): string {
  const block = renderAcceedMcpBlock(url);
  if (!current.trim()) return block;

  const lines = current.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "[mcp_servers.acceed]");
  if (start < 0) return `${current.trimEnd()}\n\n${block}`;

  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line === undefined || line.trim().startsWith("[")) break;
    end++;
  }

  const next = [
    ...lines.slice(0, start),
    ...block.trimEnd().split("\n"),
    ...lines.slice(end),
  ];
  return `${next.join("\n").trimEnd()}\n`;
}
