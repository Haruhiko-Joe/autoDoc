import { RawGraph } from "../schemas/schema.js";
import type { IDecomposer, Language } from "../schemas/schema.js";
import { decomposerInstruction } from "../instructions/decomposer.js";
import { ClaudeAgent } from "./claudeBase.js";

export class claudeDecomposer extends ClaudeAgent<typeof RawGraph> implements IDecomposer {
  constructor(language: Language = "zh") {
    super(language, {
      instruction: decomposerInstruction,
      outputSchema: RawGraph,
      errorPrefix: "claudeDecomposer",
    });
  }
}
