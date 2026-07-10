import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Bitrix24Client } from '../../bitrix24/client.js';
import { TaskChecklistApi } from '../../bitrix24/tasks/checklist-api.js';
import { assertChecklistDeleteConfirmation, planChecklistSync } from '../../bitrix24/tasks/checklist-sync.js';

const taskId = z.number().int().positive();
const itemId = z.number().int().positive();
const optionalParentId = z.number().int().positive().nullable().optional();
const checklistItemSchema = z.object({
  id: itemId.optional(), title: z.string().trim().min(1), completed: z.boolean().optional(),
  important: z.boolean().optional(), sort: z.number().int().optional(), parent_id: optionalParentId
});

const schemas = {
  list: z.object({ task_id: taskId }),
  get: z.object({ task_id: taskId, item_id: itemId }),
  add: z.object({ task_id: taskId, title: z.string().trim().min(1), sort_index: z.number().int().optional(), is_complete: z.boolean().optional(), is_important: z.boolean().optional(), parent_id: optionalParentId }),
  update: z.object({ task_id: taskId, item_id: itemId, title: z.string().trim().min(1).optional(), sort_index: z.number().int().optional(), is_complete: z.boolean().optional(), is_important: z.boolean().optional(), parent_id: optionalParentId }),
  delete: z.object({ task_id: taskId, item_id: itemId }),
  complete: z.object({ task_id: taskId, item_id: itemId }),
  reopen: z.object({ task_id: taskId, item_id: itemId }),
  move: z.object({ task_id: taskId, item_id: itemId, after_item_id: itemId.nullable().optional() }),
  actions: z.object({ task_id: taskId, item_id: itemId.optional() }),
  sync: z.object({ task_id: taskId, items: z.array(checklistItemSchema), mode: z.enum(['merge', 'sync']).default('merge'), match_by: z.enum(['id', 'title', 'id_or_title']).default('id_or_title'), delete_missing: z.boolean().default(false), confirm_delete: z.boolean().default(false), dry_run: z.boolean().default(false) })
};

function tool(name: string, description: string, properties: Record<string, object>, required: string[] = []): Tool {
  return { name, description, inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) } };
}
const ids = { task_id: { type: 'number', description: 'Bitrix24 task ID' }, item_id: { type: 'number', description: 'Checklist item ID' } };

export const checklistTools: Tool[] = [
  tool('bitrix_task_checklist_list', 'Get normalized checklist items for a task.', ids, ['task_id']),
  tool('bitrix_task_checklist_get', 'Get one normalized checklist item.', ids, ['task_id', 'item_id']),
  tool('bitrix_task_checklist_add', 'Add a checklist item and return the created item.', { ...ids, title: { type: 'string' }, sort_index: { type: 'number' }, is_complete: { type: 'boolean' }, is_important: { type: 'boolean' }, parent_id: { type: ['number', 'null'] } }, ['task_id', 'title']),
  tool('bitrix_task_checklist_update', 'Update checklist title, sort, importance or parent. Completion is changed through complete/reopen.', { ...ids, title: { type: 'string' }, sort_index: { type: 'number' }, is_complete: { type: 'boolean' }, is_important: { type: 'boolean' }, parent_id: { type: ['number', 'null'] } }, ['task_id', 'item_id']),
  tool('bitrix_task_checklist_delete', 'Delete a checklist item.', ids, ['task_id', 'item_id']),
  tool('bitrix_task_checklist_complete', 'Mark a checklist item complete.', ids, ['task_id', 'item_id']),
  tool('bitrix_task_checklist_reopen', 'Mark a checklist item incomplete.', ids, ['task_id', 'item_id']),
  tool('bitrix_task_checklist_move', 'Move an item after another item. Bitrix requires after_item_id; null cannot represent the first position.', { ...ids, after_item_id: { type: ['number', 'null'] } }, ['task_id', 'item_id']),
  tool('bitrix_task_checklist_actions', 'Check Bitrix24 add/modify/remove/toggle/reorder permissions for an item. item_id is required to query item actions.', ids, ['task_id']),
  tool('bitrix_task_checklist_sync', 'Safely merge or synchronize a task checklist. Use dry_run before delete_missing.', { task_id: ids.task_id, items: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' }, title: { type: 'string' }, completed: { type: 'boolean' }, important: { type: 'boolean' }, sort: { type: 'number' }, parent_id: { type: ['number', 'null'] } }, required: ['title'] } }, mode: { type: 'string', enum: ['merge', 'sync'], default: 'merge' }, match_by: { type: 'string', enum: ['id', 'title', 'id_or_title'], default: 'id_or_title' }, delete_missing: { type: 'boolean', default: false }, confirm_delete: { type: 'boolean', default: false }, dry_run: { type: 'boolean', default: false } }, ['task_id', 'items'])
];

export async function executeChecklistToolCall(name: string, rawArgs: unknown, client: Bitrix24Client): Promise<unknown | undefined> {
  if (!name.startsWith('bitrix_task_checklist_')) return undefined;
  const api = new TaskChecklistApi(client);
  const parse = <T>(schema: z.ZodType<T>): T => schema.parse(rawArgs);
  if (name === 'bitrix_task_checklist_list') { const a = parse(schemas.list); return { success: true, taskId: a.task_id, items: await api.list(a.task_id) }; }
  if (name === 'bitrix_task_checklist_get') { const a = parse(schemas.get); return { success: true, item: await api.get(a.task_id, a.item_id) }; }
  if (name === 'bitrix_task_checklist_add') { const a = parse(schemas.add); return { success: true, item: await api.add(a.task_id, { title: a.title, sortIndex: a.sort_index, isComplete: a.is_complete, isImportant: a.is_important, parentId: a.parent_id }) }; }
  if (name === 'bitrix_task_checklist_update') {
    const a = parse(schemas.update); await api.update(a.task_id, a.item_id, { title: a.title, sortIndex: a.sort_index, isImportant: a.is_important, parentId: a.parent_id });
    if (a.is_complete !== undefined) a.is_complete ? await api.complete(a.task_id, a.item_id) : await api.renew(a.task_id, a.item_id);
    return { success: true, item: await api.get(a.task_id, a.item_id) };
  }
  if (name === 'bitrix_task_checklist_delete') { const a = parse(schemas.delete); await api.delete(a.task_id, a.item_id); return { success: true, deleted: true, itemId: a.item_id }; }
  if (name === 'bitrix_task_checklist_complete') { const a = parse(schemas.complete); await api.complete(a.task_id, a.item_id); return { success: true, item: await api.get(a.task_id, a.item_id) }; }
  if (name === 'bitrix_task_checklist_reopen') { const a = parse(schemas.reopen); await api.renew(a.task_id, a.item_id); return { success: true, item: await api.get(a.task_id, a.item_id) }; }
  if (name === 'bitrix_task_checklist_move') { const a = parse(schemas.move); if (a.after_item_id == null) throw new Error('Bitrix24 requires after_item_id for moveafteritem; moving to the first position is not supported by this REST method.'); await api.moveAfter(a.task_id, a.item_id, a.after_item_id); return { success: true, item: await api.get(a.task_id, a.item_id) }; }
  if (name === 'bitrix_task_checklist_actions') { const a = parse(schemas.actions); return { success: true, taskId: a.task_id, itemId: a.item_id ?? null, actions: await api.actions(a.task_id, a.item_id) }; }
  if (name === 'bitrix_task_checklist_sync') {
    const a = parse(schemas.sync); const current = await api.list(a.task_id);
    const desired = a.items.map(item => ({ id: item.id, title: item.title, completed: item.completed, important: item.important, sort: item.sort, parentId: item.parent_id }));
    const mode = a.mode ?? 'merge';
    const matchBy = a.match_by ?? 'id_or_title';
    const deleteMissing = a.delete_missing ?? false;
    const dryRun = a.dry_run ?? false;
    const plan = planChecklistSync(current, desired, { mode, matchBy, deleteMissing });
    assertChecklistDeleteConfirmation(plan, a.confirm_delete ?? false);
    const summary = { added: 0, updated: 0, completed: 0, reopened: 0, moved: 0, deleted: 0, unchanged: plan.unchanged };
    if (dryRun) return { success: true, taskId: a.task_id, mode, dryRun: true, summary, operations: plan.operations, items: current };
    let failedOperation: unknown;
    try {
      for (const operation of plan.operations) {
        failedOperation = operation;
        if (operation.type === 'add' && operation.item) { await api.add(a.task_id, { title: operation.item.title, sortIndex: operation.item.sort, isComplete: operation.item.completed, isImportant: operation.item.important, parentId: operation.item.parentId }); summary.added++; }
        if (operation.type === 'update' && operation.itemId && operation.item) { await api.update(a.task_id, operation.itemId, { title: operation.item.title, sortIndex: operation.item.sort, isImportant: operation.item.important, parentId: operation.item.parentId }); summary.updated++; }
        if (operation.type === 'complete' && operation.itemId) { await api.complete(a.task_id, operation.itemId); summary.completed++; }
        if (operation.type === 'renew' && operation.itemId) { await api.renew(a.task_id, operation.itemId); summary.reopened++; }
        if (operation.type === 'move' && operation.itemId && operation.afterItemId) { await api.moveAfter(a.task_id, operation.itemId, operation.afterItemId); summary.moved++; }
        if (operation.type === 'delete' && operation.itemId) { await api.delete(a.task_id, operation.itemId); summary.deleted++; }
      }
    } catch (error) { return { success: false, error: 'CHECKLIST_SYNC_FAILED', message: error instanceof Error ? error.message : String(error), failedOperation, summary, pendingOperations: plan.operations.slice(plan.operations.indexOf(failedOperation as never) + 1) }; }
    return { success: true, taskId: a.task_id, mode, dryRun: false, summary, operations: plan.operations, items: await api.list(a.task_id) };
  }
  return undefined;
}
