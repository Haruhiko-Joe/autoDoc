import { Codex } from "@openai/codex-sdk";
import type { Thread } from "@openai/codex-sdk";
import { FlowAnalyzerOutput, toOutputSchema } from "../schemas/schema.js";
import type { AgentResult, FlowAnalyzerOutput as FlowAnalyzerOutputType, IFlowAnalyzer, Language } from "../schemas/schema.js";
import { flowAnalyzerInstruction } from "../instructions/cn/flowanalyzer.js";
import { flowAnalyzerInstructionEn } from "../instructions/en/flowanalyzer.js";

const outputSchema = toOutputSchema(FlowAnalyzerOutput);

export class codexFlowAnalyzer implements IFlowAnalyzer {
  private codex: Codex | null = null;
  private thread: Thread | null = null;
  private threadId: string | undefined;
  private cwd: string | undefined;
  private readonly docDir: string;
  private readonly project: string;
  private readonly language: Language;

  constructor(docDir: string, project: string, language: Language = "zh") {
    this.docDir = docDir;
    this.project = project;
    this.language = language;
  }

  getSessionId(): string | undefined { return this.threadId; }

  restore(sessionId: string, workpath: string): void {
    this.threadId = sessionId;
    this.cwd = workpath;
  }

  private getInstruction(): string {
    const base = this.language === "en" ? flowAnalyzerInstructionEn : flowAnalyzerInstruction;
    return base
      .replaceAll("{{DOC_DIR}}", this.docDir)
      .replaceAll("{{PROJECT}}", this.project);
  }

  async run(prompt: string, workpath: string): Promise<AgentResult<FlowAnalyzerOutputType>> {
    if (this.threadId) {
      throw new Error("Session already active. Use continue() or create a new codexFlowAnalyzer instance.");
    }
    this.cwd = workpath;
    this.codex = new Codex({
      config: {
        profile: "flowanalyzer",
        developer_instructions: this.getInstruction(),
      },
    });
    this.thread = this.codex.startThread({
      workingDirectory: workpath,
      skipGitRepoCheck: true,
    });
    return this.execute(prompt);
  }

  async continue(prompt: string): Promise<AgentResult<FlowAnalyzerOutputType>> {
    if (!this.threadId) {
      throw new Error("No active session. Call run() first.");
    }
    if (!this.codex) {
      this.codex = new Codex({
        config: {
          profile: "flowanalyzer",
          developer_instructions: this.getInstruction(),
        },
      });
    }
    if (!this.thread) {
      this.thread = this.codex.resumeThread(this.threadId, {
        workingDirectory: this.cwd,
        skipGitRepoCheck: true,
      });
    }
    return this.execute(prompt);
  }

  private async execute(prompt: string): Promise<AgentResult<FlowAnalyzerOutputType>> {
    if (!this.thread) throw new Error("No active thread");
    const turn = await this.thread.run(prompt, { outputSchema });
    const threadId = this.thread.id;
    if (!threadId) throw new Error("Thread has no ID after execution");
    this.threadId = threadId;
    const result = FlowAnalyzerOutput.parse(JSON.parse(turn.finalResponse));
    return { sessionId: threadId, result };
  }
}