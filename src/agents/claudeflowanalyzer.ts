import { query } from "@anthropic-ai/claude-agent-sdk";
import { FlowAnalyzerOutput, toOutputSchema } from "./schemas/schema.js";
import type { AgentResult, FlowAnalyzerOutput as FlowAnalyzerOutputType, Language } from "./schemas/schema.js";
import { flowAnalyzerInstruction } from "./instructions/flowanalyzer.js";
import { flowAnalyzerInstructionEn } from "./instructions/flowanalyzer.en.js";

const outputFormat = {
  type: "json_schema" as const,
  schema: toOutputSchema(FlowAnalyzerOutput),
};

export class claudeFlowAnalyzer {
  private sessionId: string | undefined;
  private cwd: string | undefined;
  private readonly docDir: string;
  private readonly project: string;
  private readonly language: Language;

  constructor(docDir: string, project: string, language: Language = "zh") {
    this.docDir = docDir;
    this.project = project;
    this.language = language;
  }

  getSessionId(): string | undefined { return this.sessionId; }

  restore(sessionId: string, workpath: string): void {
    this.sessionId = sessionId;
    this.cwd = workpath;
  }

  async run(prompt: string, workpath: string): Promise<AgentResult<FlowAnalyzerOutputType>> {
    if (this.sessionId) {
      throw new Error("Session already active. Use continue() or create a new claudeFlowAnalyzer instance.");
    }
    this.cwd = workpath;
    return this.execute(prompt);
  }

  async continue(prompt: string): Promise<AgentResult<FlowAnalyzerOutputType>> {
    if (!this.sessionId) {
      throw new Error("No active session. Call run() first.");
    }
    return this.execute(prompt, this.sessionId);
  }

  private async execute(
    prompt: string,
    resumeSessionId?: string,
  ): Promise<AgentResult<FlowAnalyzerOutputType>> {
    let sessionId = "";
    let result: FlowAnalyzerOutputType | undefined;

    const baseInstruction = this.language === "en" ? flowAnalyzerInstructionEn : flowAnalyzerInstruction;
    const systemPrompt = baseInstruction
      .replaceAll("{{DOC_DIR}}", this.docDir)
      .replaceAll("{{PROJECT}}", this.project);

    for await (const message of query({
      prompt,
      options: {
        model: "claude-opus-4-6",
        betas: ["context-1m-2025-08-07"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        tools: { type: "preset", preset: "claude_code" },
        allowedTools: ["Bash", "Read", "Glob", "Grep"],
        cwd: this.cwd,
        outputFormat,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: systemPrompt,
        },
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      },
    })) {
      if (message.type === "system" && message.subtype === "init") {
        this.sessionId = message.session_id;
        sessionId = message.session_id;
      }
      if (message.type === "result") {
        this.sessionId = message.session_id;
        sessionId = message.session_id;
        if (message.subtype === "success" && message.structured_output) {
          result = FlowAnalyzerOutput.parse(message.structured_output);
        } else {
          throw new Error(`claudeFlowAnalyzer failed: ${message.subtype}, result: ${JSON.stringify((message as Record<string, unknown>).result ?? "").slice(0, 500)}`);
        }
      }
    }

    if (!result) throw new Error("claudeFlowAnalyzer returned no result");
    return { sessionId, result };
  }
}
