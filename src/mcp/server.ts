import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { DocStore } from "./docStore.js"
import { registerQueryTools } from "./tools/query.js"
import { registerMutateTools } from "./tools/mutate.js"

export function buildMcpServer(store: DocStore): McpServer {
  const mcp = new McpServer({
    name: "acceed",
    version: "0.1.0",
  })
  registerQueryTools(mcp, store)
  registerMutateTools(mcp, store)
  return mcp
}