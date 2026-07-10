import { Bitrix24Client } from '../client.js';
import { mapChecklistItem } from './checklist-mapper.js';
import { ChecklistAction, ChecklistItem, ChecklistUpdateInput } from './checklist-types.js';

const ACTION_IDS: Record<ChecklistAction, number> = { add: 1, modify: 2, remove: 3, toggle: 4, reorder: 5 };

function fieldsForUpdate(input: ChecklistUpdateInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (input.title !== undefined) fields.TITLE = input.title;
  if (input.sortIndex !== undefined) fields.SORT_INDEX = input.sortIndex;
  if (input.isImportant !== undefined) fields.IS_IMPORTANT = input.isImportant ? 'Y' : 'N';
  if (input.parentId !== undefined) fields.PARENT_ID = input.parentId ?? 0;
  return fields;
}

export class TaskChecklistApi {
  constructor(private readonly client: Bitrix24Client) {}

  async list(taskId: number): Promise<ChecklistItem[]> {
    const result = await this.client.callRest<unknown>('task.checklistitem.getlist', { TASKID: taskId, ORDER: { SORT_INDEX: 'ASC', ID: 'ASC' } });
    return (Array.isArray(result) ? result : []).map((item) => mapChecklistItem(item as Record<string, unknown>));
  }

  async get(taskId: number, itemId: number): Promise<ChecklistItem> {
    const result = await this.client.callRest<unknown>('task.checklistitem.get', { TASKID: taskId, ITEMID: itemId });
    return mapChecklistItem((result as Record<string, unknown>)?.item as Record<string, unknown> || result as Record<string, unknown>);
  }

  async add(taskId: number, input: { title: string; sortIndex?: number; isComplete?: boolean; isImportant?: boolean; parentId?: number | null }): Promise<ChecklistItem> {
    const fields: Record<string, unknown> = { TITLE: input.title };
    if (input.sortIndex !== undefined) fields.SORT_INDEX = input.sortIndex;
    if (input.isComplete !== undefined) fields.IS_COMPLETE = input.isComplete ? 'Y' : 'N';
    if (input.isImportant !== undefined) fields.IS_IMPORTANT = input.isImportant ? 'Y' : 'N';
    if (input.parentId !== undefined) fields.PARENT_ID = input.parentId ?? 0;
    const result = await this.client.callRest<unknown>('task.checklistitem.add', { TASKID: taskId, FIELDS: fields });
    const itemId = Number((result as Record<string, unknown>)?.id ?? (result as Record<string, unknown>)?.ID ?? result);
    if (!Number.isFinite(itemId)) throw new Error('Bitrix24 did not return a checklist item ID');
    return this.get(taskId, itemId);
  }

  async update(taskId: number, itemId: number, input: ChecklistUpdateInput): Promise<void> {
    const fields = fieldsForUpdate(input);
    if (Object.keys(fields).length > 0) await this.client.callRest('task.checklistitem.update', { TASKID: taskId, ITEMID: itemId, FIELDS: fields });
  }
  async delete(taskId: number, itemId: number): Promise<void> { await this.client.callRest('task.checklistitem.delete', { TASKID: taskId, ITEMID: itemId }); }
  async complete(taskId: number, itemId: number): Promise<void> { await this.client.callRest('task.checklistitem.complete', { TASKID: taskId, ITEMID: itemId }); }
  async renew(taskId: number, itemId: number): Promise<void> { await this.client.callRest('task.checklistitem.renew', { TASKID: taskId, ITEMID: itemId }); }
  async moveAfter(taskId: number, itemId: number, afterItemId: number): Promise<void> { await this.client.callRest('task.checklistitem.moveafteritem', { TASKID: taskId, ITEMID: itemId, AFTERITEMID: afterItemId }); }
  async isActionAllowed(taskId: number, itemId: number, action: ChecklistAction): Promise<boolean> { return Boolean(await this.client.callRest('task.checklistitem.isactionallowed', { TASKID: taskId, ITEMID: itemId, ACTIONID: ACTION_IDS[action] })); }
  async actions(taskId: number, itemId?: number): Promise<Record<ChecklistAction, boolean> | null> {
    if (itemId === undefined) return null;
    const actions = Object.keys(ACTION_IDS) as ChecklistAction[];
    return Object.fromEntries(await Promise.all(actions.map(async action => [action, await this.isActionAllowed(taskId, itemId, action)]))) as Record<ChecklistAction, boolean>;
  }
}
