import { RawTopGraph } from "../schemas/schema.js";
import type { IScaffold, Language } from "../schemas/schema.js";
import { scaffoldInstruction } from "../instructions/scaffold.js";
import { ClaudeAgent } from "./claudeBase.js";

export class claudeScaffold extends ClaudeAgent<typeof RawTopGraph> implements IScaffold {
  constructor(language: Language = "zh") {
    super(language, {
      instruction: scaffoldInstruction,
      outputSchema: RawTopGraph,
      errorPrefix: "claudeScaffold",
    });
  }
}
