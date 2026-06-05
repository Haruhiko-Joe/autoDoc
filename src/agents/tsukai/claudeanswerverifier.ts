import { AnswerVerifierOutput } from "../schemas/schema.js";
import type { IAnswerVerifier, Language } from "../schemas/schema.js";
import { answerVerifierInstruction } from "../instructions/answerverifier.js";
import { ClaudeAgent } from "./claudeBase.js";

export class claudeAnswerVerifier extends ClaudeAgent<typeof AnswerVerifierOutput> implements IAnswerVerifier {
  constructor(language: Language = "zh") {
    super(language, {
      instruction: answerVerifierInstruction,
      outputSchema: AnswerVerifierOutput,
      errorPrefix: "claudeAnswerVerifier",
      allowedTools: ["Bash(node *browse.mjs*)"],
    });
  }
}
