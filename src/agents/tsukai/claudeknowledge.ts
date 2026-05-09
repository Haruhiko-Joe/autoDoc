import { KnowledgeTurn } from "../schemas/schema.js";
import type { IKnowledge, Language } from "../schemas/schema.js";
import { knowledgeInstruction } from "../instructions/knowledge.js";
import { ClaudeAgent } from "./claudeBase.js";

export class claudeKnowledge extends ClaudeAgent<typeof KnowledgeTurn> implements IKnowledge {
  constructor(language: Language = "zh") {
    super(language, {
      instruction: knowledgeInstruction,
      outputSchema: KnowledgeTurn,
      errorPrefix: "claudeKnowledge",
    });
  }
}
