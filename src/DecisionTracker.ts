import * as vscode from 'vscode';
import { DiffResult, DecisionRecord, ActionType, TemplateContext } from './types';
import { generateMessage } from './templates';
import { DecisionStore } from './DecisionStore';

/**
 * 决策追踪器
 * 监听文件保存事件，计算差异，分类事件，生成记录
 */
export class DecisionTracker {
  /** 文件内容快照 */
  private snapshots = new Map<string, string>();
  
  /** 文件编辑计数器 */
  private editCounts = new Map<string, { count: number; firstEditTime: number }>();

  /** 文件修改历史（用于检测"回到原点"） */
  private contentHistory = new Map<string, string[]>();

  /** 某次保存中涉及的文件集合（用于检测多文件改动） */
  private recentSaves: Map<string, number> = new Map();

  /** 当天是否已经记录过开工类事件 */
  private introRecordDay?: string;

  /** 历史最大单次删除行数 */
  private maxDeletedLines: number;

  private store: DecisionStore;

  constructor(store: DecisionStore) {
    this.store = store;
    this.maxDeletedLines = this.getHistoricalMaxDeletedLines();
  }

  /** 处理文档保存事件 */
  onDidSaveTextDocument(doc: vscode.TextDocument): void {
    const filePath = doc.fileName;
    const newContent = doc.getText();
    const oldContent = this.snapshots.get(filePath);

    if (oldContent === undefined) {
      // 首次保存：仅快照，不生成记录
      this.snapshots.set(filePath, newContent);
      this.contentHistory.set(filePath, [newContent]);
      this.editCounts.set(filePath, { count: 0, firstEditTime: Date.now() });

      // 开工类事件按天收敛，避免每打开一个新文件都刷一条
      if (this.shouldEmitIntroRecord()) {
        const hour = new Date().getHours();
        const actionType = hour >= 5 && hour <= 9 ? 'early-morning' : 'start-working';
        const record = this.createSimpleRecord(filePath, actionType);
        this.store.addRecord(record);
      }
      return;
    }

    if (oldContent === newContent) {
      return; // 内容未变化
    }

    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    // 计算差异
    const diff = this.computeDiff(oldLines, newLines);

    // 更新快照
    this.snapshots.set(filePath, newContent);

    // 更新编辑计数
    const editInfo = this.editCounts.get(filePath) || { count: 0, firstEditTime: Date.now() };
    editInfo.count++;
    this.editCounts.set(filePath, editInfo);

    // 更新内容历史
    const history = this.contentHistory.get(filePath) || [];
    history.push(newContent);
    if (history.length > 10) history.shift(); // 保留最近10个版本
    this.contentHistory.set(filePath, history);

    // 检查多文件改动
    this.trackMultiFile(filePath);

    // 分类并创建记录
    const records = this.classifyActions(diff, doc, editInfo, oldContent);
    for (const record of records) {
      this.store.addRecord(record);
    }
  }

  /** 获取当天键值（本地时间） */
  private getDayKey(timestamp: number = Date.now()): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /** 是否应该记录当天的开工事件 */
  private shouldEmitIntroRecord(): boolean {
    const today = this.getDayKey();
    if (this.introRecordDay === today) {
      return false;
    }

    const hasTodayIntro = this.store.getRecords().some((record) => {
      if (record.actionType !== 'early-morning' && record.actionType !== 'start-working') {
        return false;
      }
      return this.getDayKey(record.timestamp) === today;
    });

    this.introRecordDay = today;
    return !hasTodayIntro;
  }

  /** 从历史记录中恢复最大单次删除行数 */
  private getHistoricalMaxDeletedLines(): number {
    return this.store.getRecords().reduce((max, record) => {
      return Math.max(max, record.deletedLines);
    }, 0);
  }

  /** 计算行级差异 */
  private computeDiff(oldLines: string[], newLines: string[]): DiffResult {
    const removed: string[] = [];
    const added: string[] = [];

    // 找共同前缀
    let start = 0;
    while (
      start < oldLines.length &&
      start < newLines.length &&
      oldLines[start] === newLines[start]
    ) {
      start++;
    }

    // 找共同后缀
    let oldEnd = oldLines.length - 1;
    let newEnd = newLines.length - 1;
    while (
      oldEnd >= start &&
      newEnd >= start &&
      oldLines[oldEnd] === newLines[newEnd]
    ) {
      oldEnd--;
      newEnd--;
    }

    // 被删除的（在旧内容中但不在新内容中的中间段）
    for (let i = start; i <= oldEnd; i++) {
      removed.push(oldLines[i]);
    }

    // 新添加的
    for (let i = start; i <= newEnd; i++) {
      added.push(newLines[i]);
    }

    return { removed, added };
  }

  /** 检测是否为测试文件 */
  private isTestFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return (
      lower.includes('test') ||
      lower.includes('spec') ||
      lower.includes('__tests__') ||
      lower.endsWith('.test.ts') ||
      lower.endsWith('.test.js') ||
      lower.endsWith('.spec.ts') ||
      lower.endsWith('.spec.js')
    );
  }

  /** 检测被删内容中是否包含函数定义 */
  private detectDeletedFunction(lines: string[]): string | undefined {
    for (const line of lines) {
      const match = line.match(
        /(?:function|def|fn|async\s+function|const\s+\w+\s*=\s*(?:async\s+)?\()\s*(\w+)?/
      );
      if (match) {
        return match[1] || 'anonymous function';
      }
    }
    return undefined;
  }

  /** 检测是否为调试代码清理 */
  private isDebugCleanup(removed: string[], added: string[]): boolean {
    if (added.length > 0) return false; // 纯粹删除
    const debugPatterns = [
      /console\.log/,
      /console\.debug/,
      /console\.warn/,
      /console\.error/,
      /print\(/,
      /System\.out\.println/,
      /NSLog/,
      /Debug\.write/,
      /puts\s+/,
      /printf/,
      /echo\s+/,
      /var_dump/,
      /dd\(/,
      /debugger/,
    ];
    const removedText = removed.join('\n');
    return debugPatterns.some((p) => p.test(removedText));
  }

  /** 判断一行是否为注释（多语言支持） */
  private isCommentLine(line: string): boolean {
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;
    return (
      // JS / TS / C / C++ / Java / Go / Rust / Swift / Kotlin / Dart
      trimmed.startsWith('//') ||
      // 块注释 start / continuation / end
      trimmed.startsWith('/*') ||
      (trimmed.startsWith('*') && !trimmed.startsWith('*=')) ||
      trimmed.startsWith('*/') ||
      // HTML / XML / Vue template
      trimmed.startsWith('<!--') ||
      trimmed.startsWith('-->') ||
      // Python / Ruby / Shell / YAML / TOML (# 后跟空格或行尾)
      /^#(\s|$|!)/.test(trimmed) ||
      // SQL / Lua / Haskell (--)
      /^--\s/.test(trimmed) ||
      // Python docstring
      trimmed.startsWith('"""') ||
      trimmed.startsWith("'''") ||
      // JSDoc / PHPDoc tag line
      /^\*\s*@/.test(trimmed)
    );
  }

  /** 统计行数组中注释行的数量 */
  private countCommentLines(lines: string[]): number {
    return lines.filter((line) => this.isCommentLine(line)).length;
  }

  /** 检测是否为真正的注释新增（注释行占非空行的多数） */
  private isCommentAddition(added: string[]): boolean {
    const nonEmptyLines = added
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (nonEmptyLines.length === 0) return false;

    const commentLines = this.countCommentLines(added);
    return commentLines > 0 && commentLines >= Math.ceil(nonEmptyLines.length / 2);
  }

  /** 检测是否为回到原点 */
  private isBackToOrigin(
    filePath: string,
    newContent: string
  ): boolean {
    const history = this.contentHistory.get(filePath);
    if (!history || history.length < 3) return false;
    // 检查当前内容是否与历史中的某个版本相似（回溯两步以上）
    for (let i = 0; i < history.length - 2; i++) {
      if (history[i] === newContent) {
        return true;
      }
    }
    return false;
  }

  /** 检测是否为秒写秒删 */
  private isQuickUndo(
    removed: string[],
    added: string[],
    editInfo: { count: number; firstEditTime: number }
  ): boolean {
    if (added.length > 0) return false;
    const elapsed = (Date.now() - editInfo.firstEditTime) / 1000;
    return removed.length <= 5 && elapsed < 30 && editInfo.count > 1;
  }

  /** 检测反复修改 */
  private isBackAndForth(
    removed: string[],
    added: string[],
    editInfo: { count: number; firstEditTime: number }
  ): boolean {
    return removed.length > 0 && added.length > 0 && editInfo.count >= 3;
  }

  /** 检测是否需要循环提醒 */
  private isLoopReminder(
    removed: string[],
    added: string[],
    editInfo: { count: number; firstEditTime: number }
  ): boolean {
    return removed.length > 0 && added.length > 0 && editInfo.count >= 6;
  }

  /** 检测是否触发放弃成本 */
  private isAbandonmentCost(
    removed: string[],
    added: string[],
    editInfo: { count: number; firstEditTime: number }
  ): boolean {
    if (removed.length === 0 || added.length > 0) {
      return false;
    }
    return Date.now() - editInfo.firstEditTime >= 60 * 60 * 1000;
  }

  /** 格式化持续时间 */
  private formatLifetime(minutes: number): string {
    if (minutes < 60) {
      return `${minutes} 分钟`;
    }

    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    if (restMinutes === 0) {
      return `${hours} 小时`;
    }
    return `${hours} 小时 ${restMinutes} 分钟`;
  }

  /** 获取文件名的简短显示 */
  private getShortFileName(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || filePath;
  }

  /** 提取上下文片段 */
  private extractContext(oldContent: string, removed: string[]): string {
    if (removed.length === 0) return '';
    const lines = oldContent.split('\n');
    const removedText = removed.join('\n');

    // 找到被删内容在旧内容中的位置
    const idx = oldContent.indexOf(removedText);
    if (idx < 0) return removedText.slice(0, 200);

    const before = oldContent.substring(0, idx).split('\n');
    const after = oldContent.substring(idx + removedText.length).split('\n');
    const contextBefore = before.slice(-2).join('\n');
    const contextAfter = after.slice(0, 2).join('\n');

    let ctx = '';
    if (contextBefore) ctx += contextBefore + '\n';
    ctx += removedText;
    if (contextAfter) ctx += '\n' + contextAfter;

    return ctx.length > 500 ? ctx.slice(0, 500) + '...' : ctx;
  }

  /** 追踪多文件改动 */
  private trackMultiFile(filePath: string): void {
    const now = Date.now();
    this.recentSaves.set(filePath, now);

    // 清除旧记录（超过5秒的）
    const cutoff = now - 5000;
    for (const [key, time] of this.recentSaves) {
      if (time < cutoff) this.recentSaves.delete(key);
    }
  }

  /** 判断是否为多文件改动 */
  private isMultiFileBatch(): number {
    // 5秒内保存了多个不同文件
    const files = new Set(this.recentSaves.keys());
    return files.size;
  }

  /** 创建一条简单记录（用于开工、存盘等无 diff 事件） */
  private createSimpleRecord(
    filePath: string,
    actionType: ActionType
  ): DecisionRecord {
    const hour = new Date().getHours();
    const ctx: TemplateContext = {
      fileName: this.getShortFileName(filePath),
      lines: 0,
      count: 1,
      hour,
    };
    const message = generateMessage(actionType, ctx);

    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      filePath,
      fileName: this.getShortFileName(filePath),
      actionType,
      deletedLines: 0,
      addedLines: 0,
      message,
      contextSnippet: '',
      detailed: false,
    };
  }

  /** 分类动作并生成记录 */
  private classifyActions(
    diff: DiffResult,
    doc: vscode.TextDocument,
    editInfo: { count: number; firstEditTime: number },
    oldContent: string
  ): DecisionRecord[] {
    const { removed, added } = diff;
    const removedCount = removed.length;
    const addedCount = added.length;
    const hour = new Date().getHours();
    const isLateNight = hour >= 0 && hour < 5;
    const filePath = doc.fileName;
    const lifetimeMinutes = Math.max(
      1,
      Math.floor((Date.now() - editInfo.firstEditTime) / 60000)
    );

    // 无明显变动
    if (removedCount === 0 && addedCount === 0) return [];

    // 构建模板上下文
    const ctx: TemplateContext = {
      fileName: this.getShortFileName(filePath),
      lines: removedCount || addedCount,
      count: editInfo.count,
      hour,
      fnName: this.detectDeletedFunction(removed),
      addedLines: addedCount,
      deletedLines: removedCount,
      lifetime: editInfo.count > 1
        ? this.formatLifetime(lifetimeMinutes)
        : undefined,
    };

    const records: DecisionRecord[] = [];

    // === 分类逻辑（优先级从高到低） ===

    // 1. 深夜模式
    if (isLateNight && (removedCount > 0 || addedCount > 0)) {
      ctx.hour = hour;
      records.push(this.buildRecord(filePath, 'late-night', diff, ctx, oldContent));
    }

    // 2. 秒写秒删
    if (records.length === 0 && this.isQuickUndo(removed, added, editInfo)) {
      ctx.lines = Math.floor((Date.now() - editInfo.firstEditTime) / 1000);
      records.push(this.buildRecord(filePath, 'quick-undo', diff, ctx, oldContent));
    }

    // 3. 回到原点
    if (records.length === 0 && this.isBackToOrigin(filePath, doc.getText()) && removedCount > 0) {
      ctx.lines = removedCount;
      records.push(this.buildRecord(filePath, 'back-to-origin', diff, ctx, oldContent));
    }

    // 4. 反复修改
    if (records.length === 0 && this.isBackAndForth(removed, added, editInfo)) {
      records.push(this.buildRecord(filePath, 'back-and-forth', diff, ctx, oldContent));
    }

    // 5. 删测试
    if (records.length === 0 && removedCount > 0 && addedCount === 0 && this.isTestFile(filePath)) {
      records.push(this.buildRecord(filePath, 'delete-test', diff, ctx, oldContent));
    }

    // 6. 清理调试代码
    if (records.length === 0 && this.isDebugCleanup(removed, added)) {
      records.push(this.buildRecord(filePath, 'debug-cleanup', diff, ctx, oldContent));
    }

    // 7. 加注释（注释行占新增行的多数时才触发）
    if (records.length === 0 && removedCount === 0 && addedCount > 0) {
      if (this.isCommentAddition(added)) {
        records.push(this.buildRecord(filePath, 'add-comment', diff, ctx, oldContent));
      }
    }

    // 7.5 新增代码块（纯新增且不是注释，至少 3 行）
    if (records.length === 0 && removedCount === 0 && addedCount >= 3) {
      records.push(this.buildRecord(filePath, 'add-code', diff, ctx, oldContent));
    }

    // 8. 删函数
    if (records.length === 0 && removedCount > 0 && addedCount === 0 && ctx.fnName) {
      records.push(this.buildRecord(filePath, 'delete-function', diff, ctx, oldContent));
    }

    // 9. 大量删除
    if (records.length === 0 && removedCount >= 10 && addedCount === 0) {
      records.push(this.buildRecord(filePath, 'delete-bulk', diff, ctx, oldContent));
    }

    // 10. 替换方案
    if (records.length === 0 && removedCount > 0 && addedCount > 0 && removedCount <= 10 && addedCount <= 10) {
      records.push(this.buildRecord(filePath, 'replace-solution', diff, ctx, oldContent));
    }

    // 11. 重构（大量的删+增）
    if (records.length === 0 && removedCount > 5 && addedCount > 5) {
      records.push(this.buildRecord(filePath, 'refactor', diff, ctx, oldContent));
    }

    // 12. 删除旧代码
    if (records.length === 0 && removedCount > 0 && addedCount === 0 && editInfo.count > 5) {
      ctx.lifetime = Math.max(1, Math.floor((Date.now() - editInfo.firstEditTime) / 86400000)).toString();
      records.push(this.buildRecord(filePath, 'delete-old-code', diff, ctx, oldContent));
    }

    // 13. 多文件改动
    const multiFileCount = this.isMultiFileBatch();
    if (records.length === 0 && multiFileCount >= 2) {
      ctx.lines = multiFileCount;
      records.push(this.buildRecord(filePath, 'multi-file', diff, ctx, oldContent));
    }

    // 14. 通用
    if (records.length === 0) {
      records.push(this.buildRecord(filePath, 'general', diff, ctx, oldContent));
    }

    if (removedCount >= 10 && removedCount > this.maxDeletedLines) {
      const specialCtx: TemplateContext = {
        ...ctx,
        lines: removedCount,
        previousMax: this.maxDeletedLines,
      };
      this.maxDeletedLines = removedCount;
      records.push(this.buildRecord(filePath, 'record-break', diff, specialCtx, oldContent));
    }

    if (this.isLoopReminder(removed, added, editInfo)) {
      records.push(this.buildRecord(filePath, 'loop-reminder', diff, ctx, oldContent));
    }

    if (this.isAbandonmentCost(removed, added, editInfo)) {
      const specialCtx: TemplateContext = {
        ...ctx,
        lifetime: this.formatLifetime(lifetimeMinutes),
      };
      records.push(this.buildRecord(filePath, 'abandonment-cost', diff, specialCtx, oldContent));
    }

    // 沉没成本：被删代码中注释行较多
    if (removedCount >= 5 && addedCount === 0) {
      const deletedCommentCount = this.countCommentLines(removed);
      if (deletedCommentCount >= 3) {
        const specialCtx: TemplateContext = {
          ...ctx,
          commentCount: deletedCommentCount,
        };
        records.push(this.buildRecord(filePath, 'sunk-cost', diff, specialCtx, oldContent));
      }
    }

    return records;
  }

  /** 构建记录对象 */
  private buildRecord(
    filePath: string,
    actionType: ActionType,
    diff: DiffResult,
    ctx: TemplateContext,
    oldContent: string
  ): DecisionRecord {
    const style = vscode.workspace
      .getConfiguration('decisionArchaeologist')
      .get<string>('toneStyle', 'balanced') || 'balanced';

    const message = generateMessage(actionType, ctx, style);

    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      filePath,
      fileName: ctx.fileName,
      actionType,
      deletedLines: diff.removed.length,
      addedLines: diff.added.length,
      message,
      contextSnippet: this.extractContext(oldContent, diff.removed),
      detailed: diff.removed.length > 0 || diff.added.length > 0,
    };
  }

  /** 清理资源 */
  dispose(): void {
    this.snapshots.clear();
    this.editCounts.clear();
    this.contentHistory.clear();
    this.recentSaves.clear();
  }
}
