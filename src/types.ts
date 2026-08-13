/** 决策事件类型 */
export type ActionType =
  | 'delete-function'
  | 'delete-bulk'
  | 'replace-solution'
  | 'back-to-origin'
  | 'record-break'
  | 'loop-reminder'
  | 'abandonment-cost'
  | 'debug-cleanup'
  | 'early-morning'
  | 'late-night'
  | 'start-working'
  | 'delete-test'
  | 'test-edit'
  | 'add-comment'
  | 'delete-comment'
  | 'add-code'
  | 'copy-paste'
  | 'format-only'
  | 'fix-typo'
  | 'config-change'
  | 'todo-cleanup'
  | 'sunk-cost'
  | 'delete-small'
  | 'tweak'
  | 'multi-file'
  | 'quick-undo'
  | 'refactor'
  | 'delete-old-code'
  | 'back-and-forth'
  | 'general';

/** 一条决策记录 */
export interface DecisionRecord {
  id: string;
  timestamp: number;
  filePath: string;
  fileName: string;
  actionType: ActionType;
  deletedLines: number;
  addedLines: number;
  message: string;
  contextSnippet: string;
  detailed: boolean;
}

/** 差异结果 */
export interface DiffResult {
  removed: string[];
  added: string[];
  hunks: DiffHunk[];
  isFormatOnly: boolean;
}

/** 一个连续差异块 */
export interface DiffHunk {
  oldStart: number;
  newStart: number;
  removed: string[];
  added: string[];
}

/** 模板上下文 */
export interface TemplateContext {
  fileName: string;
  fnName?: string;
  lines: number;
  count: number;
  hour: number;
  lifetime?: string;
  lifetimeDays?: number;
  previousMax?: number;
  addedLines?: number;
  deletedLines?: number;
  commentCount?: number;
  language?: string;
  duplicated?: number;
}

/** 侧边栏汇总信息 */
export interface DecisionSummary {
  today: number;
  totalDeleted: number;
  totalAdded: number;
}

/** 存储事件 */
export interface StoreEvent {
  type: 'record-added' | 'records-cleared';
  record?: DecisionRecord;
}
