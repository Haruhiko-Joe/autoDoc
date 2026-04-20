import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DocStore } from "../../mcp/docStore.js";
import { buildMcpServer } from "../../mcp/server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const docRoot = process.env.AUTODOC_DOC_ROOT
  ?? path.resolve(__dirname, "..", "doc");
const repoRoot = process.env.AUTODOC_REPO_ROOT
  ?? path.resolve(__dirname, "..", "..", "..", "..");

const store = new DocStore(docRoot, () => repoRoot);
const mcp = buildMcpServer(store);
const transport = new StdioServerTransport();
await mcp.connect(transport);
