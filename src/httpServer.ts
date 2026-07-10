#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './mcpServer.js';
import { allTools } from './tools/index.js';

const REQUIRED_TASK_TOOL_NAMES = [
  'bitrix24_get_current_user',
  'bitrix24_search_users',
  'bitrix24_list_my_tasks',
  'bitrix24_list_tasks_by_user',
  'bitrix24_get_task_full',
  'bitrix24_get_task_messages',
  'bitrix24_get_task_file_info',
  'bitrix24_get_my_task_counters',
  'bitrix24_get_assistant_guide',
  'bitrix24_create_task_for_current_user',
  'bitrix24_update_task_safe',
  'bitrix24_find_my_tasks',
  'bitrix24_get_my_work_summary',
  'bitrix24_complete_task',
  'bitrix24_add_task_comment'
];

const REQUIRED_CHECKLIST_TOOL_NAMES = [
  'bitrix_task_checklist_list', 'bitrix_task_checklist_get', 'bitrix_task_checklist_add',
  'bitrix_task_checklist_update', 'bitrix_task_checklist_delete', 'bitrix_task_checklist_complete',
  'bitrix_task_checklist_reopen', 'bitrix_task_checklist_move', 'bitrix_task_checklist_actions',
  'bitrix_task_checklist_sync'
];

const PORT = Number(process.env.PORT) || 47365;
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const TRANSPORT_TYPE = 'http';
const ENTRYPOINT_FILENAME = new URL(import.meta.url).pathname;
const ALLOWED_ORIGINS = (process.env.MCP_ALLOWED_ORIGINS || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!AUTH_TOKEN) {
  console.error(
    'WARNING: MCP_AUTH_TOKEN is not set. The /mcp endpoint will accept unauthenticated requests. ' +
    'Set MCP_AUTH_TOKEN to require a Bearer token or /mcp/<token> URL token before exposing this server publicly.'
  );
}

const app = express();
app.use(express.json({ limit: '5mb' }));

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  const allowOrigin = ALLOWED_ORIGINS.includes('*')
    ? '*'
    : (origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] || '');

  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Last-Event-ID');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});

function getSingleQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  return undefined;
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!AUTH_TOKEN) {
    next();
    return;
  }

  const header = req.headers.authorization;
  const pathToken = req.params.token;
  const queryToken = getSingleQueryValue(req.query.token) || getSingleQueryValue(req.query.access_token);

  if (header === `Bearer ${AUTH_TOKEN}` || pathToken === AUTH_TOKEN || queryToken === AUTH_TOKEN) {
    next();
    return;
  }

  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized: missing or invalid token' },
    id: null
  });
}

function getHttpToolRegistrySnapshot() {
  const tools = allTools.map((tool) => tool.name);

  return {
    transport: TRANSPORT_TYPE,
    entrypoint: ENTRYPOINT_FILENAME,
    toolCount: tools.length,
    requiredTaskTools: {
      present: REQUIRED_TASK_TOOL_NAMES.filter((toolName) => tools.includes(toolName)),
      missing: REQUIRED_TASK_TOOL_NAMES.filter((toolName) => !tools.includes(toolName))
    },
    requiredChecklistTools: {
      present: REQUIRED_CHECKLIST_TOOL_NAMES.filter((toolName) => tools.includes(toolName)),
      missing: REQUIRED_CHECKLIST_TOOL_NAMES.filter((toolName) => !tools.includes(toolName))
    },
    tools,
    toolSchemas: allTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  };
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    transport: 'streamable-http',
    uptime: process.uptime()
  });
});

app.get('/debug/tools', requireAuth, (_req: Request, res: Response) => {
  res.json(getHttpToolRegistrySnapshot());
});

app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'bitrix24-mcp-server',
    transport: 'streamable-http',
    endpoint: AUTH_TOKEN ? '/mcp/<token>' : '/mcp',
    auth: AUTH_TOKEN ? 'Bearer token, /mcp/<token>, or ?token= query parameter' : 'disabled',
    tools: allTools.length
  });
});

const transports = new Map<string, StreamableHTTPServerTransport>();

async function handleMcpPost(req: Request, res: Response) {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        }
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          transports.delete(sid);
        }
      };

      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null
      });
    }
  }
}

async function handleMcpSessionRequest(req: Request, res: Response) {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  const transport = transports.get(sessionId)!;
  await transport.handleRequest(req, res);
}

app.post(['/mcp', '/mcp/:token'], requireAuth, handleMcpPost);
app.get(['/mcp', '/mcp/:token'], requireAuth, handleMcpSessionRequest);
app.delete(['/mcp', '/mcp/:token'], requireAuth, handleMcpSessionRequest);

const httpServer = app.listen(PORT, HOST, () => {
  const registry = getHttpToolRegistrySnapshot();

  console.error(`Bitrix24 MCP Server (Streamable HTTP) listening on http://${HOST}:${PORT}/mcp`);
  console.error(`MCP HTTP startup: transport=${registry.transport}`);
  console.error(`MCP HTTP startup: entrypoint=${registry.entrypoint}`);
  console.error(`MCP HTTP startup: total registered tools count=${registry.toolCount}`);
  console.error(`MCP HTTP startup: registered tools=${registry.tools.join(', ')}`);
});

async function shutdown() {
  console.error('Shutting down, closing active MCP sessions...');
  for (const [sessionId, transport] of transports) {
    try {
      await transport.close();
    } catch (error) {
      console.error(`Error closing session ${sessionId}:`, error);
    }
  }
  transports.clear();
  httpServer.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
