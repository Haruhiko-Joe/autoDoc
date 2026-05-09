import type { IncomingMessage, ServerResponse } from "node:http";

export interface HttpContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
}

export type RouteHandler = (ctx: HttpContext) => Promise<boolean>;

export function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

export function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}
