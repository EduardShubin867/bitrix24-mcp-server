import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { allTools, executeToolCall } from './tools/index.js';

const TOOL_CATALOG_URI = 'bitrix24://tools';

function getToolResourceUri(toolName: string): string {
  return `${TOOL_CATALOG_URI}/${encodeURIComponent(toolName)}`;
}

function getToolCatalog() {
  return allTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }));
}

export function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'bitrix24-mcp-server',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {},
        resources: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: allTools
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: TOOL_CATALOG_URI,
          name: 'bitrix24_registered_tools',
          description: 'Catalog of registered Bitrix24 MCP tools',
          mimeType: 'application/json'
        },
        ...allTools.map((tool) => ({
          uri: getToolResourceUri(tool.name),
          name: tool.name,
          description: `Registered MCP tool: ${tool.name}`,
          mimeType: 'application/json'
        }))
      ]
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === TOOL_CATALOG_URI) {
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({
              count: allTools.length,
              tools: getToolCatalog()
            }, null, 2)
          }
        ]
      };
    }

    if (uri.startsWith(`${TOOL_CATALOG_URI}/`)) {
      const toolName = decodeURIComponent(uri.slice(`${TOOL_CATALOG_URI}/`.length));
      const tool = allTools.find((candidate) => candidate.name === toolName);

      if (!tool) {
        throw new McpError(ErrorCode.InvalidRequest, `Unknown tool resource: ${toolName}`);
      }

      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema
            }, null, 2)
          }
        ]
      };
    }

    throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    console.error(`Executing tool: ${name} with args:`, JSON.stringify(args, null, 2));

    try {
      const result = await executeToolCall(name, args || {});

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      console.error(`Tool execution failed [${name}]:`, error);

      if (error instanceof McpError) {
        throw error;
      }

      throw new McpError(
        ErrorCode.InternalError,
        `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  return server;
}
