import { CheckerOutput } from "../schemas/schema.js";
import type { IChecker, Language } from "../schemas/schema.js";
import { checkerInstruction } from "../instructions/checker.js";
import { ClaudeAgent } from "./claudeBase.js";

export class claudeChecker extends ClaudeAgent<typeof CheckerOutput> implements IChecker {
  constructor(language: Language = "zh") {
    super(language, {
      instruction: checkerInstruction,
      outputSchema: CheckerOutput,
      errorPrefix: "claudeChecker",
    });
  }
}
