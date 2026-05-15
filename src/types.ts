/** 决策事件类型 */
export type ActionType =
  | 'delete-function'    // 删函数
  | 'delete-bulk'       // 删大量代码
  | 'replace-solution'  // 换方案
  | 'back-to-origin'    // 绕回原点
  | 'record-break'      // 破纪录
  | 'loop-reminder'     // 循环提醒
  | 'abandonment-cost'  // 放弃成本
  | 'debug-cleanup'     // 删调试代码
  | 'early-morning'     // 早上开工
  | 'late-night'        // 深夜写码
  | 'start-working'     // 开始工作
  | 'delete-test'       // 删测试
  | 'add-comment'       // 加注释
  | 'add-code'          // 新增代码块
  | 'sunk-cost'         // 沉没成本
  | 'delete-small'      // 少量删除
  | 'tweak'             // 微调
  | 'multi-file'        // 多文件改动
  | 'quick-undo'        // 秒写秒删
  | 'refactor'          // 重构
  | 'delete-old-code'   // 删旧代码
  | 'back-and-forth'    // 反复修改
  | 'general';          // 通用

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
}

/** 模板上下文 */
export interface TemplateContext {
  fileName: string;
  fnName?: string;
  lines: number;
  count: number;
  hour: number;
  lifetime?: string;
  previousMax?: number;
  addedLines?: number;
  deletedLines?: number;
  commentCount?: number;
}

/** 存储事件 */
export interface StoreEvent {
  type: 'record-added' | 'records-cleared';
  record?: DecisionRecord;
}
