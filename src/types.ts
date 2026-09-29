/** 决策事件类型 */
export type ActionType =
  // ── 删除类 ──
  | 'delete-function'
  | 'delete-bulk'
  | 'delete-small'
  | 'delete-test'
  | 'delete-old-code'
  | 'delete-comment'
  | 'delete-guard'
  | 'delete-error-handling'
  | 'empty-file'
  | 'debug-cleanup'
  | 'todo-cleanup'
  // ── 新增类 ──
  | 'add-code'
  | 'add-comment'
  | 'add-todo'
  // ── 修改类 ──
  | 'replace-solution'
  | 'refactor'
  | 'tweak'
  | 'fix-typo'
  | 'format-only'
  | 'config-change'
  | 'dependency-change'
  | 'import-change'
  | 'rename-refactor'
  | 'test-edit'
  | 'copy-paste'
  | 'comment-out-code'
  | 'uncomment-code'
  | 'function-churn'
  // ── 时间类 ──
  | 'early-morning'
  | 'late-night'
  | 'start-working'
  // ── 行为类 ──
  | 'back-to-origin'
  | 'quick-undo'
  | 'back-and-forth'
  | 'loop-reminder'
  | 'abandonment-cost'
  | 'record-break'
  | 'sunk-cost'
  | 'multi-file'
  | 'general'
  // ── 元事件（跨会话/统计洞察）──
  | 'late-night-streak'
  | 'pattern-discovery'
  | 'self-contradiction'
  | 'empty-handed';

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
  /** 连续凌晨编码天数 */
  streak?: number;
  /** 星期几（如“周四”） */
  weekday?: string;
  /** 时段（如“下午”） */
  timeBucket?: string;
  /** 同一模式重复次数 */
  patternCount?: number;
  /** TODO/FIXME 等标记名 */
  marker?: string;
  /** 被删防御代码的类型描述 */
  guardKind?: string;
  /** 依赖包名 */
  dependency?: string;
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
