import { normalizeChecklistTitle } from './checklist-mapper.js';
import { ChecklistItem, ChecklistItemInput, ChecklistOperation, ChecklistSyncPlan } from './checklist-types.js';

export type ChecklistMatchBy = 'id' | 'title' | 'id_or_title';

export interface PlanChecklistSyncOptions {
  mode: 'merge' | 'sync';
  matchBy: ChecklistMatchBy;
  deleteMissing: boolean;
}

function changed(current: ChecklistItem, input: ChecklistItemInput): boolean {
  return (input.title !== undefined && current.title !== input.title)
    || (input.sort !== undefined && current.sortIndex !== input.sort)
    || (input.important !== undefined && current.isImportant !== input.important)
    || (input.parentId !== undefined && current.parentId !== input.parentId);
}

function findMatch(current: ChecklistItem[], input: ChecklistItemInput, matchBy: ChecklistMatchBy, consumed: Set<number>): ChecklistItem | undefined {
  const byId = input.id === undefined ? undefined : current.find(item => item.id === input.id && !consumed.has(item.id));
  if (matchBy === 'id') return byId;
  if (matchBy === 'id_or_title' && byId) return byId;
  const title = normalizeChecklistTitle(input.title);
  return current.find(item => !consumed.has(item.id) && normalizeChecklistTitle(item.title) === title);
}

export function planChecklistSync(current: ChecklistItem[], desired: ChecklistItemInput[], options: PlanChecklistSyncOptions): ChecklistSyncPlan {
  const consumed = new Set<number>();
  const operations: ChecklistOperation[] = [];
  let unchanged = 0;
  const orderedExistingIds: number[] = [];

  for (const input of desired) {
    const match = findMatch(current, input, options.matchBy, consumed);
    if (!match) {
      operations.push({ type: 'add', item: input });
      continue;
    }
    consumed.add(match.id);
    orderedExistingIds.push(match.id);
    if (changed(match, input)) {
      operations.push({ type: 'update', itemId: match.id, item: input });
    }
    if (input.completed !== undefined && input.completed !== match.isComplete) {
      operations.push({ type: input.completed ? 'complete' : 'renew', itemId: match.id });
    }
    if (!changed(match, input) && (input.completed === undefined || input.completed === match.isComplete)) unchanged++;
  }

  // Ordering is handled after adds. For existing items this supplies an
  // explicit move plan; newly created items receive their desired SORT_INDEX.
  for (let index = 1; index < orderedExistingIds.length; index++) {
    const itemId = orderedExistingIds[index];
    const afterItemId = orderedExistingIds[index - 1];
    const currentIndex = current.findIndex(item => item.id === itemId);
    if (currentIndex > 0 && current[currentIndex - 1]?.id !== afterItemId) {
      operations.push({ type: 'move', itemId, afterItemId });
    }
  }

  const deleteOperations = options.mode === 'sync' && options.deleteMissing
    ? current.filter(item => !consumed.has(item.id)).map(item => ({ type: 'delete' as const, itemId: item.id }))
    : [];
  operations.push(...deleteOperations);
  const phase: Record<ChecklistOperation['type'], number> = {
    add: 0,
    update: 1,
    complete: 2,
    renew: 2,
    move: 3,
    delete: 4
  };
  operations.sort((left, right) => phase[left.type] - phase[right.type]);
  return { operations, unchanged, deleteCount: deleteOperations.length };
}

export function assertChecklistDeleteConfirmation(plan: ChecklistSyncPlan, confirmDelete: boolean): void {
  if (plan.deleteCount > 5 && !confirmDelete) {
    throw new Error(`Sync would delete ${plan.deleteCount} items. Set confirm_delete=true to proceed.`);
  }
}
