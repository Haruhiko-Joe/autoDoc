import { WriterOutput } from "../schemas/schema.js";
import type { IWriter, Language } from "../schemas/schema.js";
import { writerInstruction } from "../instructions/writer.js";
import { CodexAgent } from "./codexBase.js";

export class codexWriter extends CodexAgent<typeof WriterOutput> implements IWriter {
  constructor(language: Language = "zh") {
    super(language, {
      profile: "writer",
      instruction: writerInstruction,
      outputSchema: WriterOutput,
      errorPrefix: "codexWriter",
    });
  }
}
