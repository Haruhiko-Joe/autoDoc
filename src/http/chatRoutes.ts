import OpenAI from "openai";
import { parseBody, type RouteHandler } from "./types.js";

export function createChatRoutes(): RouteHandler {
  return async ({ req, res, url }) => {
    if (req.method !== "POST" || url.pathname !== "/api/chat") return false;
    const body = (await parseBody(req)) as {
      messages: { role: "user" | "assistant"; content: string }[]
    };

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
      const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: process.env.OPENAI_BASE_URL,
      });

      const stream = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL ?? "gpt-4o",
        messages: body.messages,
        stream: true,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) send({ type: "text", text: delta });
      }
    } catch (e) {
      send({ type: "error", text: String(e) });
    }

    send({ type: "done" });
    res.end();
    return true;
  };
}
