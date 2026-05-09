import {
  claudeScaffold, claudeDecomposer, claudeChecker, claudeWriter, claudeFlowAnalyzer,
  codexScaffold, codexDecomposer, codexChecker, codexWriter, codexFlowAnalyzer,
} from "../../agents/tsukai/index.js";
import type {
  IChecker,
  IDecomposer,
  IFlowAnalyzer,
  IScaffold,
  IWriter,
  Language,
} from "../../agents/schemas/schema.js";
import type { AgentBackend, AgentBackends, AgentRole } from "./types.js";

export const DEFAULT_AGENT_BACKENDS: AgentBackends = {
  scaffold: "codex",
  decomposer: "codex",
  writer: "codex",
  checker: "claude",
  flowAnalyzer: "codex",
};

export function resolveAgentBackends(options?: {
  agentBackend?: AgentBackend
  agentBackends?: Partial<AgentBackends>
}): AgentBackends {
  const fallback = options?.agentBackend;
  return {
    scaffold: options?.agentBackends?.scaffold ?? fallback ?? DEFAULT_AGENT_BACKENDS.scaffold,
    decomposer: options?.agentBackends?.decomposer ?? fallback ?? DEFAULT_AGENT_BACKENDS.decomposer,
    writer: options?.agentBackends?.writer ?? fallback ?? DEFAULT_AGENT_BACKENDS.writer,
    checker: options?.agentBackends?.checker ?? fallback ?? DEFAULT_AGENT_BACKENDS.checker,
    flowAnalyzer: options?.agentBackends?.flowAnalyzer ?? fallback ?? DEFAULT_AGENT_BACKENDS.flowAnalyzer,
  };
}

export class AgentFactory {
  constructor(
    private readonly agentBackends: AgentBackends,
    private readonly language: Language,
  ) {}

  getBackend(role: AgentRole): AgentBackend {
    return this.agentBackends[role];
  }

  makeChecker(): IChecker {
    return this.getBackend("checker") === "claude" ? new claudeChecker(this.language) : new codexChecker(this.language);
  }

  makeScaffold(): IScaffold {
    return this.getBackend("scaffold") === "claude" ? new claudeScaffold(this.language) : new codexScaffold(this.language);
  }

  makeDecomposer(): IDecomposer {
    return this.getBackend("decomposer") === "claude" ? new claudeDecomposer(this.language) : new codexDecomposer(this.language);
  }

  makeWriter(): IWriter {
    return this.getBackend("writer") === "claude" ? new claudeWriter(this.language) : new codexWriter(this.language);
  }

  makeFlowAnalyzer(docDir: string, projectName: string): IFlowAnalyzer {
    return this.getBackend("flowAnalyzer") === "claude"
      ? new claudeFlowAnalyzer(docDir, projectName, this.language)
      : new codexFlowAnalyzer(docDir, projectName, this.language);
  }
}
