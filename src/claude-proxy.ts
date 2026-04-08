import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

const PROXY_PORT = Number(process.env.CLAUDE_PROXY_PORT ?? 8787);
const TARGET_BASE_URL = process.env.CLAUDE_PROXY_TARGET_BASE_URL ?? "https://wanqing-api.corp.kuaishou.com/api/gateway/v1";
const TARGET_MODEL = process.env.CLAUDE_PROXY_TARGET_MODEL ?? "ep-5wie4c-1770729260902533469";
const FALLBACK_TOKEN = process.env.CLAUDE_PROXY_BEARER_TOKEN?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
const EXPOSED_MODELS = [
  "claude-opus-4-6",
  "claude-opus-4-6[1m]",
  "claude-sonnet-4-6",
  "claude-sonnet-4-6[1m]",
  "claude-haiku-4-5",
  TARGET_MODEL,
];

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function getForwardPath(pathname: string, search: string): string {
  let normalizedPath = pathname;
  while (normalizedPath === "/v1" || normalizedPath.startsWith("/v1/")) {
    normalizedPath = normalizedPath.slice(3) || "/";
  }
  if (normalizedPath === "/") {
    return `${TARGET_BASE_URL}${search}`;
  }
  const path = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
  return `${TARGET_BASE_URL}${path}${search}`;
}

function getBearerToken(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization?.trim();
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.trim()) {
    return apiKeyHeader.trim();
  }

  if (Array.isArray(apiKeyHeader)) {
    const first = apiKeyHeader.find((item) => item.trim());
    if (first) return first.trim();
  }

  return FALLBACK_TOKEN || null;
}

function rewriteBody(contentType: string | undefined, body: Buffer): { body: Buffer; requestedModel: string | null } {
  if (!body.length || !contentType?.includes("application/json")) {
    return { body, requestedModel: null };
  }

  try {
    const payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    const requestedModel = typeof payload.model === "string" ? payload.model : null;
    if (requestedModel) {
      payload.model = TARGET_MODEL;
    }
    return { body: Buffer.from(JSON.stringify(payload)), requestedModel };
  } catch {
    return { body, requestedModel: null };
  }
}

function writeJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function setResponseHeaders(res: ServerResponse, headers: Headers): void {
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (lower === "content-length" || lower === "content-encoding" || lower === "transfer-encoding" || lower === "connection") {
      continue;
    }
    res.setHeader(key, value);
  }
}

async function handleProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `127.0.0.1:${PROXY_PORT}`}`);

  if (req.method === "HEAD" && (url.pathname === "/" || url.pathname === "/v1")) {
    res.writeHead(200).end();
    return;
  }

  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
    writeJson(res, 200, { ok: true, targetBaseUrl: TARGET_BASE_URL, targetModel: TARGET_MODEL });
    return;
  }

  if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    writeJson(res, 200, {
      data: EXPOSED_MODELS.map((id) => ({
        id,
        type: "model",
        display_name: id === TARGET_MODEL ? "Internal Claude Endpoint" : id,
      })),
    });
    return;
  }

  const token = getBearerToken(req);
  if (!token) {
    writeJson(res, 400, { error: "Missing API key. Set ANTHROPIC_API_KEY or CLAUDE_PROXY_BEARER_TOKEN." });
    return;
  }

  const { body, requestedModel } = rewriteBody(req.headers["content-type"], await readRequestBody(req));
  const forwardUrl = getForwardPath(url.pathname, url.search);
  console.log(`[Claude Proxy] ${req.method ?? "GET"} ${url.pathname}${url.search} model=${requestedModel ?? "-"}`);
  const upstreamHeaders = new Headers();

  for (const [key, rawValue] of Object.entries(req.headers)) {
    if (rawValue == null) continue;
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "authorization" || lower === "x-api-key" || lower === "content-length") {
      continue;
    }
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    upstreamHeaders.set(key, value);
  }

  upstreamHeaders.set("Authorization", `Bearer ${token}`);

  const upstream = await fetch(forwardUrl, {
    method: req.method,
    headers: upstreamHeaders,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  console.log(`[Claude Proxy] upstream ${upstream.status} ${req.method ?? "GET"} ${url.pathname}`);

  setResponseHeaders(res, upstream.headers);
  res.writeHead(upstream.status, upstream.statusText);

  if (!upstream.body) {
    res.end();
    return;
  }

  Readable.fromWeb(upstream.body as globalThis.ReadableStream<Uint8Array>).pipe(res);
}

const server = createServer((req, res) => {
  handleProxy(req, res).catch((error) => {
    writeJson(res, 502, {
      error: error instanceof Error ? error.message : String(error),
      targetBaseUrl: TARGET_BASE_URL,
      targetModel: TARGET_MODEL,
    });
  });
});

server.listen(PROXY_PORT, "127.0.0.1", () => {
  console.log(`[Claude Proxy] Listening on http://127.0.0.1:${PROXY_PORT}`);
  console.log(`[Claude Proxy] Forwarding to ${TARGET_BASE_URL}/messages`);
  console.log(`[Claude Proxy] Rewriting all model names to ${TARGET_MODEL}`);
});
