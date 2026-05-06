import { WriterOutput } from "../schemas/schema.js";
import type { IWriter, Language } from "../schemas/schema.js";
import { writerInstruction } from "../instructions/writer.js";
import { ClaudeAgent } from "./claudeBase.js";

export class claudeWriter extends ClaudeAgent<typeof WriterOutput> implements IWriter {
  constructor(language: Language = "zh") {
    super(language, {
      instruction: writerInstruction,
      outputSchema: WriterOutput,
      errorPrefix: "claudeWriter",
    });
  }
}
