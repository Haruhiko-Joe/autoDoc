import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteHandler } from "./types.js";

export function createMcpRoutes(
  handleMcp: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): RouteHandler {
  return async ({ req, res, url }) => {
    if (url.pathname !== "/mcp") return false;
    if (req.method === "POST") {
      await handleMcp(req, res);
    } else {
      res.writeHead(405).end("Method Not Allowed");
    }
    return true;
  };
}
