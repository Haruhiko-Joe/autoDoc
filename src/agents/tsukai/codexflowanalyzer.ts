import { FlowAnalyzerOutput } from "../schemas/schema.js";
import type { IFlowAnalyzer, Language } from "../schemas/schema.js";
import { flowAnalyzerInstruction } from "../instructions/flowanalyzer.js";
import { CodexAgent } from "./codexBase.js";

export class codexFlowAnalyzer extends CodexAgent<typeof FlowAnalyzerOutput> implements IFlowAnalyzer {
  private readonly docDir: string;
  private readonly project: string;

  constructor(docDir: string, project: string, language: Language = "zh") {
    super(language, {
      profile: "flowanalyzer",
      instruction: flowAnalyzerInstruction,
      outputSchema: FlowAnalyzerOutput,
      errorPrefix: "codexFlowAnalyzer",
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
