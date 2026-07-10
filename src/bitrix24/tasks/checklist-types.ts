export type ChecklistAction = 'add' | 'modify' | 'remove' | 'toggle' | 'reorder';

export interface ChecklistItem {
  id: number;
  taskId: number;
  title: string;
  isComplete: boolean;
  isImportant: boolean;
  sortIndex: number;
  parentId: number | null;
  createdBy: number | null;
  toggledBy: number | null;
  toggledDate: string | null;
  attachments?: unknown;
  raw?: Record<string, unknown>;
}

export interface ChecklistItemInput {
  id?: number;
  title: string;
  completed?: boolean;
  important?: boolean;
  sort?: number;
  parentId?: number | null;
}

export interface ChecklistUpdateInput {
  title?: string;
  sortIndex?: number;
  isImportant?: boolean;
  parentId?: number | null;
}

export interface ChecklistOperation {
  type: 'add' | 'update' | 'complete' | 'renew' | 'move' | 'delete';
  itemId?: number;
  afterItemId?: number;
  item?: ChecklistItemInput;
}

export interface ChecklistSyncPlan {
  operations: ChecklistOperation[];
  unchanged: number;
  deleteCount: number;
}
