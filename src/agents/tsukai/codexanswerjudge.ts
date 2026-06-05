import { AnswerJudgeOutput } from "../schemas/schema.js";
import type { IAnswerJudge, Language } from "../schemas/schema.js";
import { answerJudgeInstruction } from "../instructions/answerjudge.js";
import { CodexAgent } from "./codexBase.js";

export class codexAnswerJudge extends CodexAgent<typeof AnswerJudgeOutput> implements IAnswerJudge {
  constructor(language: Language = "zh") {
    super(language, {
      profile: "answerjudge",
      instruction: answerJudgeInstruction,
      outputSchema: AnswerJudgeOutput,
      errorPrefix: "codexAnswerJudge",
    });
  }
}
