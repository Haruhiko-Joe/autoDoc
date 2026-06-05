import { AnswerJudgeOutput } from "../schemas/schema.js";
import type { IAnswerJudge, Language } from "../schemas/schema.js";
import { answerJudgeInstruction } from "../instructions/answerjudge.js";
import { ClaudeAgent } from "./claudeBase.js";

export class claudeAnswerJudge extends ClaudeAgent<typeof AnswerJudgeOutput> implements IAnswerJudge {
  constructor(language: Language = "zh") {
    super(language, {
      instruction: answerJudgeInstruction,
      outputSchema: AnswerJudgeOutput,
      errorPrefix: "claudeAnswerJudge",
      allowedTools: [],
    });
  }
}
