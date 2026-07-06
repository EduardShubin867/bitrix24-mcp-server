#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcpServer.js';
import { allTools } from './tools/index.js';

async function main() {
  console.error('Starting Bitrix24 MCP Server (stdio transport)...');
  console.error('Available tools:', allTools.map(t => t.name).join(', '));

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Bitrix24 MCP Server running on stdio transport');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
