import { AnswerVerifierOutput } from "../schemas/schema.js";
import type { IAnswerVerifier, Language } from "../schemas/schema.js";
import { answerVerifierInstruction } from "../instructions/answerverifier.js";
import { CodexAgent } from "./codexBase.js";

export class codexAnswerVerifier extends CodexAgent<typeof AnswerVerifierOutput> implements IAnswerVerifier {
  constructor(language: Language = "zh") {
    super(language, {
      profile: "answerverifier",
      instruction: answerVerifierInstruction,
      outputSchema: AnswerVerifierOutput,
      errorPrefix: "codexAnswerVerifier",
    });
  }
}
