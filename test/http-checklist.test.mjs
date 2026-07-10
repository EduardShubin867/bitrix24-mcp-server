import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const port = 47367;
const token = 'checklist-http-test';
const expectedTools = [
  'bitrix_task_checklist_list', 'bitrix_task_checklist_get', 'bitrix_task_checklist_add',
  'bitrix_task_checklist_update', 'bitrix_task_checklist_delete', 'bitrix_task_checklist_complete',
  'bitrix_task_checklist_reopen', 'bitrix_task_checklist_move', 'bitrix_task_checklist_actions',
  'bitrix_task_checklist_sync'
];
const server = spawn(process.execPath, ['build/httpServer.js'], {
  env: { ...process.env, PORT: String(port), MCP_AUTH_TOKEN: token, BITRIX24_WEBHOOK_URL: 'http://127.0.0.1:9/rest/1/test' },
  stdio: ['ignore', 'ignore', 'pipe']
});

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP MCP server did not start')), 5_000);
    server.stderr.on('data', chunk => {
      if (chunk.toString().includes('listening on')) { clearTimeout(timer); resolve(); }
    });
    server.once('error', reject);
  });
  const rpc = async (body, sessionId) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) }, body: JSON.stringify(body)
    });
    return { response, text: await response.text() };
  };
  const initialized = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  const sessionId = initialized.response.headers.get('mcp-session-id');
  assert.ok(sessionId, 'initialize must return Mcp-Session-Id');
  const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId);
  for (const name of expectedTools) assert.ok(listed.text.includes(name), `tools/list missing ${name}`);
  const called = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bitrix_task_checklist_list', arguments: { task_id: 253928 } } }, sessionId);
  assert.match(called.text, /success.*false/s, 'failed Bitrix request must be returned as a structured tool response');
  console.log('Checklist HTTP MCP smoke test passed.');
} finally {
  server.kill('SIGTERM');
  await once(server, 'exit');
}
