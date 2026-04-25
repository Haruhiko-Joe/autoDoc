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
  const files = issue.files.length > 0 ? `\n   相关文件: ${issue.files.join(", ")}` : "";
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

  scaffoldReviewFeedbackPrompt(current: RawTopGraph, feedback: string): string {
    return this.appendKnowledge([
      "用户人工审查了你的顶层模块拆解，并要求重做。",
      "",
      "## 当前候选拆解",
      "```json",
      JSON.stringify(current, null, 2),
      "```",
      "",
      "## 用户反馈",
      feedback,
      "",
      "请根据用户反馈重新输出完整的顶层模块图。",
    ].join("\n"));
  }

  decomposerPrompt(
    nodeId: string,
    graph: Graph,
    ancestorContext: AncestorContext | null,
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
    return this.appendKnowledge(parts.join("\n"));
  }

  graphCheckerPrompt(nodeId: string, rawGraph: RawGraph): string {
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
    ].join("\n"));
  }

  decomposerFixPrompt(issues: CheckerIssue[]): string {
    const parts = ["你的子图产出经过 Checker 校验未通过，存在以下问题：", ""];

    issues.forEach((issue, i) => parts.push(formatIssue(issue, i)));
    parts.push("");

    parts.push(
      "请根据以上问题修正你的输出：",
      "- edges[].target 必须指向当前图中实际存在的节点名称",
      "- codeScope 中的路径必须是目标仓库中实际存在的文件或目录",
      "- 每个节点的 description 必须非空且有意义",
      "- child.ref 使用简洁英文标识符，不含空格和特殊字符",
      "",
      "请重新输出完整的、修正后的子图 JSON。",
    );

    return parts.join("\n");
  }

  decomposerReviewFeedbackPrompt(nodeId: string, current: RawGraph, feedback: string): string {
    return this.appendKnowledge([
      `用户人工审查了模块 "${nodeId}" 的子图拆解，并要求重做。`,
      "",
      "## 当前候选拆解",
      "```json",
      JSON.stringify(current, null, 2),
      "```",
      "",
      "## 用户反馈",
      feedback,
      "",
      "请根据用户反馈重新输出完整的子图 JSON。",
    ].join("\n"));
  }

  writerPrompt(node: GraphNode, ancestorContext: AncestorContext | null): string {
    const parts = [
      `Write comprehensive Markdown documentation for the module "${node.name}".`,
      `Description: ${node.description}`,
      `Code scope (files/directories to read): ${node.codeScope.join(", ")}`,
      `Repository root: ${this.repoPath}`,
    ];
    if (ancestorContext) {
      parts.push(`\nAncestor context (the module hierarchy above this node):\n${JSON.stringify(ancestorContext, null, 2)}`);
    }
    return this.appendKnowledge(parts.join("\n"));
  }

  flowPrompt(): string {
    return `Analyze the documented codebase and produce 3-7 typical business interaction flows.\nRepository root: ${this.repoPath}`;
  }

  private appendKnowledge(prompt: string): string {
    if (!this.knowledge) return prompt;
    const header = this.language === "en" ? "# Repository Domain Knowledge" : "# 仓库领域知识";
    return `${prompt}\n\n${header}\n${this.knowledge}`;
  }
}
