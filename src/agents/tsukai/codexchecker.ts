import { CheckerOutput } from "../schemas/schema.js";
import type { IChecker, Language } from "../schemas/schema.js";
import { checkerInstruction } from "../instructions/checker.js";
import { CodexAgent } from "./codexBase.js";

export class codexChecker extends CodexAgent<typeof CheckerOutput> implements IChecker {
  constructor(language: Language = "zh") {
    super(language, {
      profile: "checker",
      instruction: checkerInstruction,
      outputSchema: CheckerOutput,
      errorPrefix: "codexChecker",
    });
  }
}
