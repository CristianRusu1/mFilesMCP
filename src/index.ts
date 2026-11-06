#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerStructureTools } from "./tools/structure.js";
import { registerCompositeTools } from "./tools/composite.js";
import { registerSearchTools } from "./tools/search.js";
import { registerObjectTools } from "./tools/objects.js";
import { registerStructureWriteTools } from "./tools/structure-writes.js";
import { writesEnabled } from "./tools/shared.js";
import { debug, logError } from "./logger.js";

async function main() {
  const server = new McpServer(
    {
      name: "mcp-mfiles",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {} },
    },
  );

  registerAuthTools(server);
  registerStructureTools(server);
  registerCompositeTools(server);
  registerSearchTools(server);
  if (writesEnabled()) {
    registerObjectTools(server);
    registerStructureWriteTools(server);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  debug(
    `mcp-mfiles server started on stdio (writes ${writesEnabled() ? "enabled" : "disabled"})`,
  );
}

main().catch((err) => {
  logError(err);
  process.exit(1);
});
