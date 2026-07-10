import assert from 'node:assert/strict';
import { mapChecklistItem, normalizeChecklistTitle } from '../build/bitrix24/tasks/checklist-mapper.js';
import { assertChecklistDeleteConfirmation, planChecklistSync } from '../build/bitrix24/tasks/checklist-sync.js';

const current = [
  mapChecklistItem({ ID: '1', TASK_ID: '9', TITLE: ' One   item ', IS_COMPLETE: 'N', IS_IMPORTANT: 'Y', SORT_INDEX: '100', PARENT_ID: '' }),
  mapChecklistItem({ ID: '2', TASK_ID: '9', TITLE: 'Remove me', IS_COMPLETE: 'Y', IS_IMPORTANT: 'N', SORT_INDEX: '200', PARENT_ID: '0' }),
  mapChecklistItem({ ID: '3', TASK_ID: '9', TITLE: 'Rename me', IS_COMPLETE: 'N', IS_IMPORTANT: 'N', SORT_INDEX: '300', PARENT_ID: '1' })
];

assert.equal(normalizeChecklistTitle('  A   MiXeD  title '), 'a mixed title');
assert.deepEqual(current[0], { ...current[0], id: 1, taskId: 9, isComplete: false, isImportant: true, parentId: null });

const plan = planChecklistSync(current, [
  { id: 1, title: 'One item', completed: true, important: false, sort: 10 },
  { id: 3, title: 'Renamed item', completed: false },
  { title: 'Added' }
], { mode: 'sync', matchBy: 'id_or_title', deleteMissing: true });
assert.equal(plan.operations.filter(operation => operation.type === 'add').length, 1);
assert.equal(plan.operations.filter(operation => operation.type === 'update').length, 2);
assert.equal(plan.operations.filter(operation => operation.type === 'complete').length, 1);
assert.deepEqual(plan.operations.filter(operation => operation.type === 'delete').map(operation => operation.itemId), [2]);

const titlePlan = planChecklistSync(current, [{ title: ' one item ' }], { mode: 'merge', matchBy: 'title', deleteMissing: false });
assert.equal(titlePlan.operations.filter(operation => operation.type === 'add').length, 0);
assert.equal(titlePlan.operations.filter(operation => operation.type === 'delete').length, 0);

const destructivePlan = planChecklistSync(
  Array.from({ length: 6 }, (_, index) => mapChecklistItem({ ID: String(index + 10), TASK_ID: '9', TITLE: `Item ${index}`, IS_COMPLETE: 'N', IS_IMPORTANT: 'N', SORT_INDEX: String(index) })),
  [], { mode: 'sync', matchBy: 'id', deleteMissing: true }
);
assert.throws(() => assertChecklistDeleteConfirmation(destructivePlan, false), /confirm_delete=true/);
assert.doesNotThrow(() => assertChecklistDeleteConfirmation(destructivePlan, true));

console.log('Checklist mapper and sync planner tests passed.');
