import type {
  AncestorContext,
  CheckerIssue,
  Graph,
  GraphNode,
  Language,
  RawGraph,
  RawTopGraph,
} from "../../agents/schemas/schema.js";

function formatIssue(issue: CheckerIssue, index: number): string {
  const severity = issue.severity === "error" ? "[ERROR]" : "[WARNING]";
  const files = issue.files.length > 0 ? `\n   Related files: ${issue.files.join(", ")}` : "";
  return `${index + 1}. ${severity} [${issue.type}] ${issue.description}${files}`;
}

export class PromptBuilder {
  constructor(
    private readonly repoPath: string,
    private readonly language: Language,
    private readonly knowledge: string,
  ) {}

  scaffoldPrompt(): string {
    return this.appendKnowledge(`Analyze the repository at ${this.repoPath} and produce the top-level module graph.`);
  }

  scaffoldCheckerPrompt(topResult: RawTopGraph): string {
    return this.appendKnowledge([
      `Validate the scaffold output for the top-level module graph.`,
      `Repository root: ${this.repoPath}`,
      ``,
      `## Graph JSON content:`,
      "```json",
      JSON.stringify(topResult, null, 2),
      "```",
    ].join("\n"));
  }

  scaffoldFixPrompt(issues: CheckerIssue[]): string {
    const parts = [
      "Your top-level module graph failed Checker validation with the following issues:",
      "",
    ];
    issues.forEach((issue, i) => parts.push(formatIssue(issue, i)));
    parts.push(
      "",
      "Please fix and re-output the complete top-level module graph, ensuring:",
      "- All codeScope paths actually exist in the target repository",
      "- All edges[].target point to node names that exist in the current graph",
      "- Each node's description is non-empty and meaningful",
    );
    return parts.join("\n");
  }

  scaffoldReviewFeedbackPrompt(current: RawTopGraph, feedback: string): string {
    return this.appendKnowledge([
      "The user has manually reviewed your top-level module decomposition and requested a redo.",
      "",
      "## Current candidate decomposition",
      "```json",
      JSON.stringify(current, null, 2),
      "```",
      "",
      "## User feedback",
      feedback,
      "",
      "Please re-output the complete top-level module graph based on the user's feedback.",
    ].join("\n"));
  }

  decomposerPrompt(
    nodeId: string,
    graph: Graph,
    ancestorContext: AncestorContext | null,
    nodeKnowledge?: string,
  ): string {
    const parts = [
      `Analyze the code scope and produce a sub-graph for the module "${nodeId}".`,
      `Description: ${graph.description}`,
      `Code scope (files/directories to analyze): ${graph.codeScope.join(", ")}`,
      `Repository root: ${this.repoPath}`,
    ];
    if (ancestorContext) {
      parts.push(`\nAncestor context (the module hierarchy above this node):\n${JSON.stringify(ancestorContext, null, 2)}`);
    }
    return this.appendKnowledge(parts.join("\n"), nodeKnowledge, false);
  }

  graphCheckerPrompt(nodeId: string, rawGraph: RawGraph, nodeKnowledge?: string): string {
    return this.appendKnowledge([
      `Validate the decomposer output (graph structure only) for module "${nodeId}".`,
      `Repository root: ${this.repoPath}`,
      ``,
      `## Graph JSON content:`,
      "```json",
      JSON.stringify(rawGraph, null, 2),
      "```",
      ``,
      `Note: Leaf Markdown documents have not been generated yet — validate graph structure only.`,
    ].join("\n"), nodeKnowledge, false);
  }

  decomposerFixPrompt(issues: CheckerIssue[]): string {
    const parts = ["Your subgraph output failed Checker validation with the following issues:", ""];

    issues.forEach((issue, i) => parts.push(formatIssue(issue, i)));
    parts.push("");

    parts.push(
      "Please fix your output based on the issues above:",
      "- edges[].target must point to node names that actually exist in the current graph",
      "- codeScope paths must be actually existing files or directories in the target repository",
      "- Each node's description must be non-empty and meaningful",
      "- child.ref must be a concise English identifier without spaces or special characters",
      "",
      "Please re-output the complete, corrected subgraph JSON.",
    );

    return parts.join("\n");
  }

  decomposerReviewFeedbackPrompt(nodeId: string, current: RawGraph, feedback: string, nodeKnowledge?: string): string {
    return this.appendKnowledge([
      `The user has manually reviewed the subgraph decomposition for module "${nodeId}" and requested a redo.`,
      "",
      "## Current candidate decomposition",
      "```json",
      JSON.stringify(current, null, 2),
      "```",
      "",
      "## User feedback",
      feedback,
      "",
      "Please re-output the complete subgraph JSON based on the user's feedback.",
    ].join("\n"), nodeKnowledge, false);
  }

  writerPrompt(node: GraphNode, ancestorContext: AncestorContext | null, nodeKnowledge?: string): string {
    const parts = [
      `Write comprehensive Markdown documentation for the module "${node.name}".`,
      `Description: ${node.description}`,
      `Code scope (files/directories to read): ${node.codeScope.join(", ")}`,
      `Repository root: ${this.repoPath}`,
    ];
    if (ancestorContext) {
      parts.push(`\nAncestor context (the module hierarchy above this node):\n${JSON.stringify(ancestorContext, null, 2)}`);
    }
    return this.appendKnowledge(parts.join("\n"), nodeKnowledge, false);
  }

  flowPrompt(): string {
    return `Analyze the documented codebase and produce 3-7 typical business interaction flows.\nRepository root: ${this.repoPath}`;
  }

  private appendKnowledge(prompt: string, nodeKnowledge?: string, topLevel = true): string {
    const parts = [prompt];
    if (topLevel && this.knowledge) {
      const header = this.language === "en" ? "# Repository Domain Knowledge" : "# 仓库领域知识";
      parts.push(`${header}\n${this.knowledge}`);
    }
    if (nodeKnowledge) {
      const header = this.language === "en"
        ? "# Module-Specific Knowledge"
        : "# 模块专属知识";
      parts.push(`${header}\n${nodeKnowledge}`);
    }
    return parts.join("\n\n");
  }
}
