import { KnowledgeTurn } from "../schemas/schema.js";
import type { IKnowledge, Language } from "../schemas/schema.js";
import { knowledgeInstruction } from "../instructions/knowledge.js";
import { CodexAgent } from "./codexBase.js";

export class codexKnowledge extends CodexAgent<typeof KnowledgeTurn> implements IKnowledge {
  constructor(language: Language = "zh") {
    super(language, {
      profile: "knowledge",
      instruction: knowledgeInstruction,
      outputSchema: KnowledgeTurn,
      errorPrefix: "codexKnowledge",
    });
  }
}
