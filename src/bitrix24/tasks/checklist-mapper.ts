import { ChecklistItem } from './checklist-types.js';

function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function yesNoToBoolean(value: unknown): boolean {
  return value === true || value === 'Y' || value === 'y' || value === 1 || value === '1';
}

export function normalizeChecklistTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function mapChecklistItem(raw: Record<string, unknown>): ChecklistItem {
  return {
    id: numberOrZero(raw.ID ?? raw.id),
    taskId: numberOrZero(raw.TASK_ID ?? raw.taskId ?? raw.task_id),
    title: String(raw.TITLE ?? raw.title ?? ''),
    isComplete: yesNoToBoolean(raw.IS_COMPLETE ?? raw.isComplete ?? raw.is_complete),
    isImportant: yesNoToBoolean(raw.IS_IMPORTANT ?? raw.isImportant ?? raw.is_important),
    sortIndex: numberOrZero(raw.SORT_INDEX ?? raw.sortIndex ?? raw.sort_index),
    parentId: numberOrNull(raw.PARENT_ID ?? raw.parentId ?? raw.parent_id),
    createdBy: numberOrNull(raw.CREATED_BY ?? raw.createdBy ?? raw.created_by),
    toggledBy: numberOrNull(raw.TOGGLED_BY ?? raw.toggledBy ?? raw.toggled_by),
    toggledDate: String(raw.TOGGLED_DATE ?? raw.toggledDate ?? raw.toggled_date ?? '') || null,
    ...(raw.ATTACHMENTS ?? raw.attachments ? { attachments: raw.ATTACHMENTS ?? raw.attachments } : {}),
    raw
  };
}
