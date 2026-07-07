import { allTools } from '../build/tools/index.js';

const requiredTaskTools = [
  'bitrix24_get_current_user',
  'bitrix24_search_users',
  'bitrix24_list_my_tasks',
  'bitrix24_list_tasks_by_user',
  'bitrix24_get_task_full',
  'bitrix24_get_task_messages',
  'bitrix24_get_task_file_info',
  'bitrix24_get_my_task_counters'
];

const toolNames = allTools.map((tool) => tool.name);
const resourceUris = [
  'bitrix24://tools',
  ...toolNames.map((toolName) => `bitrix24://tools/${encodeURIComponent(toolName)}`)
];
const result = {
  count: toolNames.length,
  requiredTaskTools: {
    present: requiredTaskTools.filter((toolName) => toolNames.includes(toolName)),
    missing: requiredTaskTools.filter((toolName) => !toolNames.includes(toolName))
  },
  requiredTaskResources: {
    present: requiredTaskTools
      .map((toolName) => `bitrix24://tools/${encodeURIComponent(toolName)}`)
      .filter((uri) => resourceUris.includes(uri)),
    missing: requiredTaskTools
      .map((toolName) => `bitrix24://tools/${encodeURIComponent(toolName)}`)
      .filter((uri) => !resourceUris.includes(uri))
  },
  tools: allTools.map((tool) => ({
    name: tool.name,
    description: tool.description
  })),
  resources: resourceUris
};

console.log(JSON.stringify(result, null, 2));

if (result.requiredTaskTools.missing.length > 0 || result.requiredTaskResources.missing.length > 0) {
  process.exit(1);
}
