import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRunLog } from "../../souko/runLog.js";
import type {
  AncestorContext as AncestorContextType,
  Graph as GraphType,
  GraphNode as GraphNodeType,
  IWriter,
  RawGraph as RawGraphType,
} from "../../agents/schemas/schema.js";
import type { AgentFactory } from "./agentFactory.js";
import type { GraphStore } from "./graphStore.js";
import type { PromptBuilder } from "./promptBuilder.js";
import { type Semaphore, withRetry, withSemaphore } from "./runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_TEMPLATE_DIR = path.resolve(__dirname, "..", "..", "skill-template");
const AUTODOC_MCP_TOOLS = [
  "list_projects",
  "get_top",
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

      let topResult = result;
      let finalSessionId = sessionId;

      const checker = agentFactory.makeChecker();
      for (let retry = 0; ; retry++) {
        await appendRunLog(store.projectName, `checker invoke scope=scaffold retry=${retry}`);
        const checkerPrompt = promptBuilder.scaffoldCheckerPrompt(topResult);

        const checkerResult = checker.getSessionId()
          ? await checker.continue(checkerPrompt)
          : await checker.run(checkerPrompt, repoPath);

        if (checkerResult.result.passed) {
          console.log("[Arranger] Scaffold check passed.");
          await appendRunLog(store.projectName, `checker pass scope=scaffold`);
          break;
        }
        if (retry >= 5) throw new Error(`Scaffold check failed after 5 retries: ${JSON.stringify(checkerResult.result.issues)}`);

        console.log(`[Arranger] Scaffold check failed (retry ${retry + 1}/5)`);
        await appendRunLog(store.projectName, `checker fail scope=scaffold retry=${retry + 1}`);
        await appendRunLog(store.projectName, `scaffold continue retry=${retry + 1}`);
        const fixed = await scaffold.continue(promptBuilder.scaffoldFixPrompt(checkerResult.result.issues));
        topResult = fixed.result;
        finalSessionId = fixed.sessionId;
      }

      return { topResult, finalSessionId };
    });

    await store.initializeFromScaffold(topResult, finalSessionId);
    console.log(`[Arranger] Scaffold complete. ${topResult.nodes.length} top-level modules.`);
  }

  async processGraphTask(nodeId: string, graph: GraphType): Promise<void> {
    const { promptBuilder, store } = this.options;
    const ancestorContext = await store.buildAncestorContext(nodeId);

    console.log(`[Arranger] Processing graph task: ${nodeId}`);
    await appendRunLog(store.projectName, `graph task start node=${nodeId}`);

    let rawGraph: RawGraphType;
    let decomposerSessionId: string;
    try {
      const result = await withRetry(async (attempt) => {
        const prompt = promptBuilder.decomposerPrompt(nodeId, graph, ancestorContext);
        const existing = attempt === 0 ? {
          rawGraph: graph.status === "checking" && graph.nodes.length > 0 ? { nodes: graph.nodes } : undefined,
          decomposerSessionId: graph.decomposerSessionId,
          checkerSessionId: graph.checkerSessionId,
        } : undefined;
        return this.decomposeAndCheck(nodeId, prompt, existing);
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
    await store.markGraphDecomposed(nodeId, rawGraph, decomposerSessionId);
  }

  async processPageTask(nodeId: string, ref: string, graph: GraphType): Promise<void> {
    const { store } = this.options;
    const ancestorContext = await store.buildAncestorContext(nodeId);
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
      content = await withRetry(() => this.writePage(pageNode, ancestorContext));
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
    const skillDir = path.join(repoPath, ".claude", "skills", "doc-drill");
    console.log(`[Arranger] Assembling doc-drill skill at ${skillDir}...`);
    await mkdir(skillDir, { recursive: true });
    await copyFile(
      path.join(SKILL_TEMPLATE_DIR, "SKILL.md"),
      path.join(skillDir, "SKILL.md"),
    );
    await this.writeClaudeMcpConfig(repoPath);
    await this.writeCodexMcpConfig(repoPath);
    console.log(`[Arranger] Skill assembled at ${skillDir}`);
    return skillDir;
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
  ): Promise<{ rawGraph: RawGraphType; decomposerSessionId: string }> {
    const { agentFactory, promptBuilder, repoPath, semaphore, store } = this.options;
    const decomposer = agentFactory.makeDecomposer();
    const checker = agentFactory.makeChecker();

    if (existing?.decomposerSessionId) {
      decomposer.restore(existing.decomposerSessionId, repoPath);
    }
    if (existing?.checkerSessionId) {
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

    for (let retry = 0; ; retry++) {
      const checkerPrompt = promptBuilder.graphCheckerPrompt(nodeId, rawGraph);
      const checkerMode = checker.getSessionId() ? "continue" : "run";
      await appendRunLog(store.projectName, `checker invoke scope=decomposer node=${nodeId} mode=${checkerMode} retry=${retry}`);
      const checkerResult = await withSemaphore(semaphore, () =>
        checker.getSessionId()
          ? checker.continue(checkerPrompt)
          : checker.run(checkerPrompt, repoPath),
      );

      if (checkerResult.result.passed) {
        console.log(`[Arranger] Decomposer check passed: ${nodeId}`);
        await appendRunLog(store.projectName, `checker pass scope=decomposer node=${nodeId}`);
        return { rawGraph, decomposerSessionId: decomposer.getSessionId() ?? "" };
      }
      if (retry >= 5) throw new Error(`Decomposer check failed after 5 retries for ${nodeId}`);

      console.log(`[Arranger] Decomposer check failed: ${nodeId} (retry ${retry + 1}/5)`);
      await appendRunLog(store.projectName, `checker fail scope=decomposer node=${nodeId} retry=${retry + 1}`);
      await appendRunLog(store.projectName, `decomposer continue node=${nodeId} retry=${retry + 1}`);
      rawGraph = (await withSemaphore(semaphore, () => decomposer.continue(promptBuilder.decomposerFixPrompt(checkerResult.result.issues)))).result;
    }
  }

  private async writePage(
    pageNode: GraphNodeType,
    ancestorContext: AncestorContextType | null,
  ): Promise<string> {
    const writer = this.options.agentFactory.makeWriter();
    return withSemaphore(this.options.semaphore, () =>
      this.generatePageContent(writer, pageNode, ancestorContext),
    );
  }

  private async generatePageContent(
    writer: IWriter,
    node: GraphNodeType,
    ancestorContext: AncestorContextType | null,
  ): Promise<string> {
    const { agentFactory, promptBuilder, repoPath, store } = this.options;

    console.log(`[Arranger] Generating page: ${node.name}`);
    await appendRunLog(store.projectName, `writer invoke node=${node.name} backend=${agentFactory.getBackend("writer")}`);

    const { result } = await writer.run(promptBuilder.writerPrompt(node, ancestorContext), repoPath);
    console.log(`[Arranger] Page generated: ${node.name}`);
    await appendRunLog(store.projectName, `writer return node=${node.name} len=${result.content.length}`);
    return result.content;
  }

  private mcpUrl(): string {
    return process.env.AUTODOC_PUBLIC_MCP_URL
      ?? process.env.AUTODOC_MCP_URL
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
        autodoc: { type: "http", url: this.mcpUrl() },
      },
    };
    await writeFile(filePath, JSON.stringify(next, null, 2));
  }

  private async writeCodexMcpConfig(repoPath: string): Promise<void> {
    const codexDir = path.join(repoPath, ".codex");
    const filePath = path.join(codexDir, "config.toml");
    await mkdir(codexDir, { recursive: true });
    const current = await readFile(filePath, "utf-8").catch(() => "");
    if (current.includes("[mcp_servers.autodoc]")) return;

    const block = [
      "[mcp_servers.autodoc]",
      `url = "${this.mcpUrl()}"`,
      `enabled_tools = [${AUTODOC_MCP_TOOLS.map((tool) => `"${tool}"`).join(", ")}]`,
      "",
    ].join("\n");
    await writeFile(filePath, current.trim() ? `${current.trimEnd()}\n\n${block}` : block);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
