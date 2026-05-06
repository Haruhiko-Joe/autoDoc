import { RawTopGraph } from "../schemas/schema.js";
import type { IScaffold, Language } from "../schemas/schema.js";
import { scaffoldInstruction } from "../instructions/scaffold.js";
import { CodexAgent } from "./codexBase.js";

export class codexScaffold extends CodexAgent<typeof RawTopGraph> implements IScaffold {
  constructor(language: Language = "zh") {
    super(language, {
      profile: "scaffold",
      instruction: scaffoldInstruction,
      outputSchema: RawTopGraph,
      errorPrefix: "codexScaffold",
    });
  }
}
