import { RawGraph } from "../schemas/schema.js";
import type { IDecomposer, Language } from "../schemas/schema.js";
import { decomposerInstruction } from "../instructions/decomposer.js";
import { CodexAgent } from "./codexBase.js";

export class codexDecomposer extends CodexAgent<typeof RawGraph> implements IDecomposer {
  constructor(language: Language = "zh") {
    super(language, {
      profile: "decomposer",
      instruction: decomposerInstruction,
      outputSchema: RawGraph,
      errorPrefix: "codexDecomposer",
    });
  }
}
