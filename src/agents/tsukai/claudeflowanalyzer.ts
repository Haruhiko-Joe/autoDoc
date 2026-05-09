import { FlowAnalyzerOutput } from "../schemas/schema.js";
import type { IFlowAnalyzer, Language } from "../schemas/schema.js";
import { flowAnalyzerInstruction } from "../instructions/flowanalyzer.js";
import { ClaudeAgent } from "./claudeBase.js";

export class claudeFlowAnalyzer extends ClaudeAgent<typeof FlowAnalyzerOutput> implements IFlowAnalyzer {
  private readonly docDir: string;
  private readonly project: string;

  constructor(docDir: string, project: string, language: Language = "zh") {
    super(language, {
      instruction: flowAnalyzerInstruction,
      outputSchema: FlowAnalyzerOutput,
      errorPrefix: "claudeFlowAnalyzer",
      allowedTools: ["Bash", "Read", "Glob", "Grep"],
    });
    this.docDir = docDir;
    this.project = project;
  }

  protected override getInstruction(): string {
    return super.getInstruction()
      .replaceAll("{{DOC_DIR}}", this.docDir)
      .replaceAll("{{PROJECT}}", this.project);
  }
}
