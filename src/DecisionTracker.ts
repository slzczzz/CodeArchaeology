import * as vscode from 'vscode';
import { DiffResult, DiffHunk, DecisionRecord, ActionType, TemplateContext } from './types';
import { generateMessage } from './templates';
import { DecisionStore } from './DecisionStore';
import { TrackerConfig, isExcluded, readConfig } from './config';

interface FileMeta {
  firstSeenAt: number;
  lastSavedAt: number;
  saveCount: number;
  lastAddedCount: number;
}

interface HistoryEntry {
  content: string;
  savedAt: number;
}

interface DiffOp {
  type: 'equal' | 'remove' | 'add';
  value: string;
}

const MAX_MYERS_D = 400;
const MYERS_AREA_LIMIT = 1_000_000;

/** 决策追踪器：监听文件保存事件，计算差异，分类事件，生成记录 */
export class DecisionTracker {
  /** 星期几中文标签 */
  private static readonly WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  /** 文件内容快照 */
  private snapshots = new Map<string, string>();

  /** 文件元信息：首次出现时间、保存次数、上次新增行数 */
  private fileMeta = new Map<string, FileMeta>();

  /** 文件内容历史（用于“回到原点”“代码年龄”检测） */
  private contentHistory = new Map<string, HistoryEntry[]>();

  /** 某次保存中涉及的文件集合（用于检测多文件改动） */
  private recentSaves: Map<string, number> = new Map();

  /** 当天是否已经记录过开工类事件 */
  private introRecordDay?: string;

  /** 已打开但尚未保存改动的文档（用于“空手而归”） */
  private openedDocs = new Map<string, { openedAt: number; saved: boolean }>();

  /** 函数增删历史：文件名 → 函数名 → 统计 */
  private functionHistory = new Map<
    string,
    Map<string, { added: number; removed: number; churnReported: boolean }>
  >();

  /** 历史最大单次删除行数 */
  private maxDeletedLines: number;

  /** 最近一次“连续凌晨”提醒的日期 */
  private lastStreakReportDay?: string;

  /** 最近一次“模式发现”提醒的键 */
  private lastPatternReportKey?: string;

  /** 当前配置快照 */
  private config: TrackerConfig;

  private store: DecisionStore;

  constructor(store: DecisionStore) {
    this.store = store;
    this.config = readConfig();
    this.maxDeletedLines = this.getHistoricalMaxDeletedLines();
  }

  /** 更新配置（由扩展在配置变更时调用） */
  updateConfig(config: TrackerConfig): void {
    this.config = config;
  }

  /** 处理文档打开事件：记录打开时间，用于“空手而归” */
  onDidOpenTextDocument(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== 'file' || isExcluded(doc.fileName, this.config)) {
      return;
    }
    this.openedDocs.set(doc.fileName, { openedAt: Date.now(), saved: false });
  }

  /** 处理文档关闭事件：打开期间未产生任何改动则记为“空手而归” */
  onDidCloseTextDocument(doc: vscode.TextDocument): void {
    const filePath = doc.fileName;
    const opened = this.openedDocs.get(filePath);
    this.openedDocs.delete(filePath);

    if (!opened || opened.saved || isExcluded(filePath, this.config)) {
      return;
    }
    if (this.isDisabled('empty-handed')) {
      return;
    }

    const dwellMinutes = Math.max(1, Math.floor((Date.now() - opened.openedAt) / 60_000));
    if (dwellMinutes < 1) {
      return;
    }

    const ctx: TemplateContext = {
      fileName: this.getShortFileName(filePath),
      lines: 0,
      count: 1,
      hour: new Date().getHours(),
      language: this.getLanguage(filePath),
      lifetime: this.formatLifetime(dwellMinutes),
    };
    this.store.addRecord(this.buildSimpleRecord(filePath, 'empty-handed', ctx));
  }

  /** 处理文档保存事件 */
  onDidSaveTextDocument(doc: vscode.TextDocument): void {
    const filePath = doc.fileName;
    const newContent = doc.getText();
    const oldContent = this.snapshots.get(filePath);

    if (isExcluded(filePath, this.config)) {
      return;
    }

    if (oldContent === undefined) {
      this.snapshots.set(filePath, newContent);
      this.fileMeta.set(filePath, {
        firstSeenAt: Date.now(),
        lastSavedAt: Date.now(),
        saveCount: 0,
        lastAddedCount: 0,
      });
      this.contentHistory.set(filePath, [{ content: newContent, savedAt: Date.now() }]);

      if (this.shouldEmitIntroRecord()) {
        const hour = new Date().getHours();
        const actionType = hour >= 5 && hour <= 9 ? 'early-morning' : 'start-working';
        if (!this.isDisabled(actionType)) {
          this.store.addRecord(this.createSimpleRecord(filePath, actionType));
        }
      }
      return;
    }

    if (oldContent === newContent) {
      return;
    }

    const diff = this.computeDiff(oldContent.split('\n'), newContent.split('\n'));
    if (diff.removed.length === 0 && diff.added.length === 0) {
      return;
    }

    // 低于最小改动行数阈值，视为琐碎变更不记录
    if (diff.removed.length + diff.added.length < this.config.minChangedLines) {
      return;
    }

    const openedDoc = this.openedDocs.get(filePath);
    if (openedDoc) {
      openedDoc.saved = true;
    }

    const prevMeta = this.fileMeta.get(filePath);
    const meta = prevMeta ?? {
      firstSeenAt: Date.now(),
      lastSavedAt: Date.now(),
      saveCount: 0,
      lastAddedCount: 0,
    };
    meta.saveCount++;
    meta.lastSavedAt = Date.now();
    meta.lastAddedCount = diff.added.length;
    this.fileMeta.set(filePath, meta);
    this.snapshots.set(filePath, newContent);

    const history = this.contentHistory.get(filePath) ?? [];
    history.push({ content: newContent, savedAt: Date.now() });
    if (history.length > 20) {
      history.shift();
    }
    this.contentHistory.set(filePath, history);

    this.trackMultiFile(filePath);

    for (const record of this.classifyActions(diff, doc, oldContent, prevMeta)) {
      if (!this.isDisabled(record.actionType)) {
        this.store.addRecord(record);
      }
    }
  }

  /** 事件类型是否被用户禁用 */
  private isDisabled(type: ActionType): boolean {
    return this.config.disabledEvents.includes(type);
  }

  /** 获取当天键值（本地时间） */
  private getDayKey(timestamp: number = Date.now()): string {
    const date = new Date(timestamp);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /** 是否应记录当天的开工事件 */
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

  /** 计算行级差异：优先 Myers，超大差异回退到前后缀裁剪 */
  private computeDiff(oldLines: string[], newLines: string[]): DiffResult {
    if (oldLines.length === 0 && newLines.length === 0) {
      return { removed: [], added: [], hunks: [], isFormatOnly: false };
    }

    if (
      oldLines.length * newLines.length > MYERS_AREA_LIMIT ||
      oldLines.length + newLines.length > 10_000
    ) {
      return this.computeDiffFallback(oldLines, newLines);
    }

    const ops = this.myersDiff(oldLines, newLines);
    if (!ops) {
      return this.computeDiffFallback(oldLines, newLines);
    }

    const removed: string[] = [];
    const added: string[] = [];
    const hunks: DiffHunk[] = [];
    let current: DiffHunk | null = null;
    let oldIndex = 0;
    let newIndex = 0;

    for (const op of ops) {
      if (op.type === 'equal') {
        oldIndex++;
        newIndex++;
        current = null;
        continue;
      }

      if (!current) {
        current = { oldStart: oldIndex, newStart: newIndex, removed: [], added: [] };
        hunks.push(current);
      }

      if (op.type === 'remove') {
        removed.push(op.value);
        current.removed.push(op.value);
        oldIndex++;
      } else {
        added.push(op.value);
        current.added.push(op.value);
        newIndex++;
      }
    }

    return {
      removed,
      added,
      hunks,
      isFormatOnly: this.isFormatOnly(removed, added),
    };
  }

  /** 前后缀裁剪的简化差异（超大文件兜底） */
  private computeDiffFallback(oldLines: string[], newLines: string[]): DiffResult {
    let start = 0;
    while (
      start < oldLines.length &&
      start < newLines.length &&
      oldLines[start] === newLines[start]
    ) {
      start++;
    }

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

    const removed = oldLines.slice(start, oldEnd + 1);
    const added = newLines.slice(start, newEnd + 1);
    const hunks: DiffHunk[] =
      removed.length > 0 || added.length > 0
        ? [{ oldStart: start, newStart: start, removed, added }]
        : [];

    return { removed, added, hunks, isFormatOnly: this.isFormatOnly(removed, added) };
  }

  /** Myers O(ND) 行级 diff；编辑距离超过上限时返回 null */
  private myersDiff(a: string[], b: string[]): DiffOp[] | null {
    const n = a.length;
    const m = b.length;
    const maxD = Math.min(n + m, MAX_MYERS_D);
    const offset = maxD;
    const v = new Array<number>(2 * maxD + 1).fill(0);
    const trace: number[][] = [];

    for (let d = 0; d <= maxD; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x: number;
        if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
          x = v[k + 1 + offset];
        } else {
          x = v[k - 1 + offset] + 1;
        }
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) {
          x++;
          y++;
        }
        v[k + offset] = x;
        if (x >= n && y >= m) {
          return this.backtrackMyers(trace, a, b, d, offset);
        }
      }
    }

    return null;
  }

  /** 从 Myers trace 回溯出操作序列 */
  private backtrackMyers(
    trace: number[][],
    a: string[],
    b: string[],
    finalD: number,
    offset: number
  ): DiffOp[] {
    const ops: DiffOp[] = [];
    let x = a.length;
    let y = b.length;

    for (let d = finalD; d >= 0; d--) {
      const prevV = trace[d];
      const k = x - y;
      let prevK: number;
      if (k === -d || (k !== d && prevV[k - 1 + offset] < prevV[k + 1 + offset])) {
        prevK = k + 1;
      } else {
        prevK = k - 1;
      }
      const prevX = prevV[prevK + offset];
      const prevY = prevX - prevK;

      while (x > prevX && y > prevY) {
        ops.unshift({ type: 'equal', value: a[x - 1] });
        x--;
        y--;
      }

      if (d === 0) {
        break;
      }

      if (x === prevX) {
        ops.unshift({ type: 'add', value: b[y - 1] });
        y--;
      } else {
        ops.unshift({ type: 'remove', value: a[x - 1] });
        x--;
      }
    }

    return ops;
  }

  /** 仅格式变化：行数相同，且每行忽略空白后完全一致 */
  private isFormatOnly(removed: string[], added: string[]): boolean {
    if (removed.length === 0 || removed.length !== added.length) {
      return false;
    }
    let differs = false;
    for (let i = 0; i < removed.length; i++) {
      const r = this.normalizeWhitespace(removed[i]);
      const a = this.normalizeWhitespace(added[i]);
      if (r !== a) {
        return false;
      }
      if (removed[i] !== added[i]) {
        differs = true;
      }
    }
    return differs;
  }

  private normalizeWhitespace(line: string): string {
    return line.replace(/\s+/g, ' ').trim();
  }

  /**
   * 检测是否为测试文件。
   * 按「目录约定 + 命名约定」判断，而非路径子串匹配，
   * 避免 latest-update.ts / inspect.ts / contest.ts / perspective.ts 之类被误判。
   */
  private isTestFile(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const segments = normalized.split('/');
    const fileName = segments[segments.length - 1] || '';
    const lowerName = fileName.toLowerCase();

    // 1) 目录约定：test/ tests/ __tests__/ spec/ e2e/ cypress/ ...
    const testDir = /^(__tests__|__mocks__|__snapshots__|tests?|specs?|e2e|testing|cypress)$/;
    if (segments.slice(0, -1).some((seg) => testDir.test(seg.toLowerCase()))) {
      return true;
    }

    // 2) 点号后缀约定：foo.test.ts / foo.spec.tsx / foo.cy.js
    if (/\.(test|spec|tests|cy)\.[a-z0-9]+$/i.test(lowerName)) {
      return true;
    }

    // 3) 下划线后缀约定：foo_test.py / foo_spec.rb / foo_test.go
    if (/_(test|spec)s?\.[a-z0-9]+$/i.test(lowerName)) {
      return true;
    }

    // 4) 大驼峰约定：FooTest.java / FooTests.cs / FooSpec.kt
    //    要求 Test/Spec 首字母大写，天然避开 latest / contest / inspect / perspective
    const baseName = fileName.replace(/\.[a-z0-9]+$/i, '');
    if (/(?:^|[A-Za-z0-9])(?:Tests?|Specs?)$/.test(baseName)) {
      return true;
    }

    return false;
  }

  /**
   * 检测配置类文件。
   * 仅在扩展名或文件名明显是配置时才判定，
   * 避免把 data.json / users.json / feed.xml 这类数据文件当成配置。
   */
  private isConfigFile(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    const fileName = normalized.split('/').pop() || '';

    // 点 rc 风格：.eslintrc / .prettierrc / .babelrc / .eslintrc.json
    if (/^\.[a-z0-9_-]+rc(\.[a-z0-9]+)?$/.test(fileName)) {
      return true;
    }

    // 环境变量文件：.env / .env.local / .env.production
    if (/^\.env(\.[a-z0-9_-]+)?$/.test(fileName)) {
      return true;
    }

    // 明确的配置类扩展名
    if (/\.(ya?ml|toml|ini|cfg|conf|properties|editorconfig)$/.test(fileName)) {
      return true;
    }

    // JSON 仅在文件名明显是配置时才算配置
    if (fileName.endsWith('.json')) {
      return (
        /^(tsconfig|jsconfig|package|composer|bower|angular|nest-cli|tslint|eslint|prettier|babel|jest|vitest|nodemon|vercel|netlify)/.test(
          fileName
        ) || /(config|settings|manifest|options)(\.[a-z0-9]+)?\.json$/.test(fileName)
      );
    }

    return false;
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
    if (added.length > 0) {
      return false;
    }
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

  /** 判断一行是否为注释 */
  private isCommentLine(line: string): boolean {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return false;
    }
    return (
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      (trimmed.startsWith('*') && !trimmed.startsWith('*=')) ||
      trimmed.startsWith('*/') ||
      trimmed.startsWith('<!--') ||
      trimmed.startsWith('-->') ||
      /^#(\s|$|!)/.test(trimmed) ||
      /^--\s/.test(trimmed) ||
      trimmed.startsWith('"""') ||
      trimmed.startsWith("'''") ||
      /^\*\s*@/.test(trimmed)
    );
  }

  /** 统计行数组中的注释行数 */
  private countCommentLines(lines: string[]): number {
    return lines.filter((line) => this.isCommentLine(line)).length;
  }

  /** 是否为真正的注释新增（注释行占非空行多数） */
  private isCommentAddition(added: string[]): boolean {
    const nonEmptyLines = added
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (nonEmptyLines.length === 0) {
      return false;
    }

    const commentLines = this.countCommentLines(added);
    return commentLines > 0 && commentLines >= Math.ceil(nonEmptyLines.length / 2);
  }

  /** 是否为注释删除（被删内容中注释占多数） */
  private isCommentOnly(removed: string[]): boolean {
    if (removed.length < 2) {
      return false;
    }
    const commentLines = this.countCommentLines(removed);
    return commentLines >= Math.ceil(removed.length / 2);
  }

  /** 是否为清理 TODO/FIXME 等标记 */
  private isTodoCleanup(removed: string[]): boolean {
    return removed.some((line) => /\b(TODO|FIXME|HACK|XXX|BUG|TEMP)\b/i.test(line));
  }

  /** 新增内容是否写下了 TODO/FIXME */
  private isTodoAdded(added: string[]): boolean {
    return added.some((line) => /\b(TODO|FIXME|HACK|XXX)\b/i.test(line));
  }

  /** 提取 TODO/FIXME 等标记名 */
  private detectTodoMarker(lines: string[]): string | undefined {
    for (const line of lines) {
      const match = line.match(/\b(TODO|FIXME|HACK|XXX|BUG|TEMP)\b/i);
      if (match) {
        return match[1].toUpperCase();
      }
    }
    return undefined;
  }

  /** 整个文件是否被清空 */
  private isEmptyFile(diff: DiffResult, doc: vscode.TextDocument): boolean {
    if (diff.removed.length === 0) {
      return false;
    }
    // 空文件经过 split('\n') 会得到一个空行，需按“是否有非空内容”判断
    if (diff.added.some((line) => line.trim().length > 0)) {
      return false;
    }
    return doc.getText().trim().length === 0;
  }

  /** 是否为依赖清单文件 */
  private isDependencyFile(filePath: string): boolean {
    const name = (filePath.replace(/\\/g, '/').split('/').pop() || '').toLowerCase();
    return [
      'package.json',
      'requirements.txt',
      'pipfile',
      'cargo.toml',
      'go.mod',
      'gemfile',
      'pom.xml',
      'build.gradle',
      'composer.json',
    ].includes(name);
  }

  /** 变更行是否像依赖声明 */
  private looksLikeDependencyChange(removed: string[], added: string[]): boolean {
    const lines = [...removed, ...added].map((line) => line.trim()).filter((line) => line.length > 0);
    if (lines.length === 0) {
      return false;
    }
    const depLike = lines.filter(
      (line) =>
        /^"?[a-z@][\w@./-]*"?\s*:/.test(line) ||
        /^[a-z0-9][\w.-]*\s*(==|>=|<=|~=|>|<|\^|~)/.test(line) ||
        /^(dependencies|devDependencies|peerDependencies|require|replace|version)\b/.test(line)
    ).length;
    return depLike >= Math.ceil(lines.length * 0.5);
  }

  /** 从依赖变更中猜测包名 */
  private extractDependencyName(removed: string[], added: string[]): string | undefined {
    for (const line of [...added, ...removed]) {
      const match =
        line.match(/^\s*"([^"]+)"\s*:/) || line.match(/^\s*([A-Za-z0-9@._-]+)\s*(==|>=|<=|~=|>|<)/);
      if (match && !/^(dependencies|devDependencies|peerDependencies|scripts|version|name)$/.test(match[1])) {
        return match[1];
      }
    }
    return undefined;
  }

  /** 删除内容是否以错误处理为主（try/catch/throw/异常上报） */
  private isErrorHandlingRemoval(removed: string[]): boolean {
    if (removed.length < 2) {
      return false;
    }
    const matches = removed.filter(
      (line) =>
        /\btry\s*\{/.test(line) ||
        /\bcatch\b/.test(line) ||
        /\bfinally\b/.test(line) ||
        /\.catch\s*\(/.test(line) ||
        /\bthrow\s+/.test(line) ||
        /logger?\.(error|warn|fatal)/.test(line) ||
        /reportError|trackError|logError|Sentry|Bugsnag/.test(line) ||
        /\bexception\b/i.test(line)
    ).length;
    return matches >= 2 && matches >= Math.ceil(removed.length * 0.4);
  }

  /** 删除内容是否像防御性判断，返回描述 */
  private detectGuardRemoval(removed: string[]): string | undefined {
    if (removed.length === 0 || removed.length > 6) {
      return undefined;
    }
    const text = removed.join('\n');
    if (/\bfunction\b|=>\s*\{/.test(text)) {
      return undefined;
    }
    if (/if\s*\(\s*!\s*\w+\s*\)\s*(return|\{)/.test(text)) {
      return '空值判断';
    }
    if (/if\s*\([^)]*(==|===)\s*(null|undefined|void 0)/.test(text)) {
      return 'null 判断';
    }
    if (/\?\?|\?\./.test(text)) {
      return '可选链兜底';
    }
    if (/if\s*\([^)]*\.length\s*(===|==|<=|>)\s*0/.test(text)) {
      return '边界判断';
    }
    if (/\bassert\b|throw\s+new\s+\w*Error/.test(text)) {
      return '兜底断言';
    }
    return undefined;
  }

  /** 去掉行首注释符号，返回被注释的原始代码 */
  private stripCommentPrefix(line: string): string {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) {
      return trimmed.slice(2).trim();
    }
    if (trimmed.startsWith('/*') && trimmed.endsWith('*/') && trimmed.length > 4) {
      return trimmed.slice(2, -2).trim();
    }
    if (trimmed.startsWith('<!--') && trimmed.endsWith('-->') && trimmed.length > 7) {
      return trimmed.slice(4, -3).trim();
    }
    if (/^#\s/.test(trimmed)) {
      return trimmed.slice(1).trim();
    }
    if (/^--\s/.test(trimmed)) {
      return trimmed.slice(2).trim();
    }
    return '';
  }

  /** 是否为“把代码注释掉” */
  private isCommentOutCode(removed: string[], added: string[]): boolean {
    return this.isCommentToggle(removed, added, true);
  }

  /** 是否为“取消注释恢复代码” */
  private isUncommentCode(removed: string[], added: string[]): boolean {
    return this.isCommentToggle(removed, added, false);
  }

  /**
   * 判定注释/取消注释。
   * commented=true 时新增行应为删除行的注释版本（注释掉代码）；
   * commented=false 时删除行应为新增行的注释版本（取消注释）。
   */
  private isCommentToggle(removed: string[], added: string[], commented: boolean): boolean {
    const plain = commented ? removed : added;
    const marked = commented ? added : removed;
    if (plain.length < 2 || marked.length < 2) {
      return false;
    }
    if (Math.abs(plain.length - marked.length) > Math.max(1, plain.length * 0.3)) {
      return false;
    }
    const count = Math.min(plain.length, marked.length);
    let matched = 0;
    for (let i = 0; i < count; i++) {
      const code = plain[i].trim();
      const stripped = this.stripCommentPrefix(marked[i]);
      if (code.length === 0 || stripped.length === 0) {
        continue;
      }
      if (code === stripped) {
        matched++;
      }
    }
    return matched >= 2 && matched >= Math.ceil(count * 0.6);
  }

  /** 变更是否全部是 import/require/include 语句 */
  private isImportChange(removed: string[], added: string[]): boolean {
    const lines = [...removed, ...added].map((line) => line.trim()).filter((line) => line.length > 0);
    if (lines.length === 0) {
      return false;
    }
    const importLike = (line: string): boolean =>
      /^import\s/.test(line) ||
      /^from\s+['"].+['"]\s+import\b/.test(line) ||
      /^require\s*\(/.test(line) ||
      /^(const|let|var)\s+.+=\s*require\(/.test(line) ||
      /^#include\s/.test(line) ||
      /^(use|extern crate|mod)\s+[A-Za-z]/.test(line) ||
      /^using\s+[A-Za-z]/.test(line);
    const count = lines.filter(importLike).length;
    return count >= 1 && count >= Math.ceil(lines.length * 0.8);
  }

  /** 是否像一次大范围重命名：多个 1:1 差异块，仅标识符不同 */
  private isRenameRefactor(diff: DiffResult): boolean {
    if (diff.hunks.length < 3) {
      return false;
    }
    let renameLike = 0;
    for (const hunk of diff.hunks) {
      if (hunk.removed.length !== 1 || hunk.added.length !== 1) {
        continue;
      }
      if (this.isIdentifierOnlyChange(hunk.removed[0], hunk.added[0])) {
        renameLike++;
      }
    }
    return renameLike >= 3 && renameLike >= Math.ceil(diff.hunks.length * 0.6);
  }

  /** 两行是否仅有一个标识符不同 */
  private isIdentifierOnlyChange(before: string, after: string): boolean {
    const tokenPattern = /[A-Za-z_$][\w$]*|\d+|\S/g;
    const beforeTokens = before.match(tokenPattern) || [];
    const afterTokens = after.match(tokenPattern) || [];
    if (beforeTokens.length !== afterTokens.length || beforeTokens.length < 3) {
      return false;
    }
    let diffIndex = -1;
    for (let i = 0; i < beforeTokens.length; i++) {
      if (beforeTokens[i] !== afterTokens[i]) {
        if (diffIndex !== -1) {
          return false;
        }
        diffIndex = i;
      }
    }
    if (diffIndex === -1) {
      return false;
    }
    const identifier = /^[A-Za-z_$][\w$]*$/;
    return identifier.test(beforeTokens[diffIndex]) && identifier.test(afterTokens[diffIndex]);
  }

  /** 记录函数增删，返回发生反复增删的函数名 */
  private trackFunctionChurn(
    filePath: string,
    removed: string[],
    added: string[]
  ): string | undefined {
    const addedFns = this.detectFunctionNames(added);
    const removedFns = this.detectFunctionNames(removed);
    if (addedFns.length === 0 && removedFns.length === 0) {
      return undefined;
    }

    let perFile = this.functionHistory.get(filePath);
    if (!perFile) {
      perFile = new Map();
      this.functionHistory.set(filePath, perFile);
    }

    for (const name of addedFns) {
      const entry = perFile.get(name) ?? { added: 0, removed: 0, churnReported: false };
      entry.added++;
      perFile.set(name, entry);
    }

    let churned: string | undefined;
    for (const name of removedFns) {
      const entry = perFile.get(name) ?? { added: 0, removed: 0, churnReported: false };
      entry.removed++;
      perFile.set(name, entry);
      if (!entry.churnReported && entry.added >= 2 && entry.removed >= 2) {
        entry.churnReported = true;
        churned = name;
      }
    }
    return churned;
  }

  /** 提取代码行中的函数名 */
  private detectFunctionNames(lines: string[]): string[] {
    const names: string[] = [];
    const patterns = [
      /\bfunction\s+([A-Za-z_$][\w$]*)/g,
      /\bdef\s+([A-Za-z_$][\w$]*)/g,
      /\bfn\s+([A-Za-z_$][\w$]*)/g,
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g,
      /^\s*(?:public|private|protected|static|async|\s)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g,
    ];
    for (const line of lines) {
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          if (match[1] && !names.includes(match[1])) {
            names.push(match[1]);
          }
        }
      }
    }
    return names;
  }

  /** 连续凌晨编码天数（含今天，从历史记录推导） */
  private getLateNightStreakDays(): number {
    const nightDays = new Set<string>();
    for (const record of this.store.getRecords()) {
      const hour = new Date(record.timestamp).getHours();
      if (record.actionType === 'late-night' || record.actionType === 'late-night-streak' || (hour >= 0 && hour < 5)) {
        nightDays.add(this.getDayKey(record.timestamp));
      }
    }

    nightDays.add(this.getDayKey());

    let streak = 0;
    const cursor = new Date();
    while (streak < 30) {
      if (!nightDays.has(this.getDayKey(cursor.getTime()))) {
        break;
      }
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  /** 将小时划分为时段 */
  private getTimeBucket(hour: number): { key: string; label: string } {
    if (hour < 5) {
      return { key: 'dawn', label: '凌晨' };
    }
    if (hour < 12) {
      return { key: 'morning', label: '上午' };
    }
    if (hour < 18) {
      return { key: 'afternoon', label: '下午' };
    }
    return { key: 'evening', label: '晚上' };
  }

  /** 模式发现：同一星期几 + 同一时段反复推翻自己的代码 */
  private detectPattern():
    | { weekday: string; timeBucket: string; patternCount: number }
    | undefined {
    const now = new Date();
    const weekday = DecisionTracker.WEEKDAY_LABELS[now.getDay()];
    const bucket = this.getTimeBucket(now.getHours());
    const reportKey = `${now.getDay()}-${bucket.key}`;
    if (this.lastPatternReportKey === reportKey) {
      return undefined;
    }

    const countingTypes: ActionType[] = [
      'delete-function',
      'delete-bulk',
      'delete-small',
      'back-to-origin',
      'replace-solution',
      'refactor',
      'delete-old-code',
      'delete-guard',
      'delete-error-handling',
    ];

    const count = this.store.getRecords().filter((record) => {
      if (!countingTypes.includes(record.actionType)) {
        return false;
      }
      const date = new Date(record.timestamp);
      return date.getDay() === now.getDay() && this.getTimeBucket(date.getHours()).key === bucket.key;
    }).length;

    if (count >= 4) {
      this.lastPatternReportKey = reportKey;
      return { weekday, timeBucket: bucket.label, patternCount: count + 1 };
    }
    return undefined;
  }

  /** 自相矛盾：写回的代码块与近期（1 小时前至 7 天内）删除过的代码一致 */
  private isSelfContradiction(added: string[]): boolean {
    const block = added.map((line) => line.trim()).filter((line) => line.length > 0);
    if (block.length < 3) {
      return false;
    }
    const signature = block.join('\n');
    const now = Date.now();
    return this.store.getRecords().some((record) => {
      if (record.deletedLines < block.length) {
        return false;
      }
      const age = now - record.timestamp;
      if (age < 60 * 60 * 1000 || age > 7 * 24 * 60 * 60 * 1000) {
        return false;
      }
      return record.contextSnippet.includes(signature);
    });
  }

  /** 是否回到原点：当前内容与历史某个旧版本完全相同 */
  private isBackToOrigin(filePath: string, newContent: string): boolean {
    const history = this.contentHistory.get(filePath);
    if (!history || history.length < 3) {
      return false;
    }
    for (let i = 0; i < history.length - 2; i++) {
      if (history[i].content === newContent) {
        return true;
      }
    }
    return false;
  }

  /** 秒写秒删：紧接上一次“新增”后 60 秒内删掉 */
  private isQuickUndo(diff: DiffResult, prevMeta?: FileMeta): boolean {
    if (diff.added.length > 0 || diff.removed.length === 0) {
      return false;
    }
    if (!prevMeta || prevMeta.saveCount < 1 || prevMeta.lastAddedCount === 0) {
      return false;
    }
    return Date.now() - prevMeta.lastSavedAt < 60_000;
  }

  /** 反复修改：有增有删且保存次数达到 4 次 */
  private isBackAndForth(removed: string[], added: string[], saveCount: number): boolean {
    return removed.length > 0 && added.length > 0 && saveCount >= 4;
  }

  /** 循环提醒：有增有删且保存次数达到 8 次 */
  private isLoopReminder(removed: string[], added: string[], saveCount: number): boolean {
    return removed.length > 0 && added.length > 0 && saveCount >= 8;
  }

  /** 放弃成本：纯删除，且被删代码已存在至少 1 小时 */
  private isAbandonmentCost(diff: DiffResult, deletedAgeMinutes: number): boolean {
    return diff.removed.length > 0 && diff.added.length === 0 && deletedAgeMinutes >= 60;
  }

  /** 复制粘贴：新增块在旧文件或其他已保存文件中出现过 */
  private isCopyPaste(diff: DiffResult, oldContent: string, filePath: string): boolean {
    for (const hunk of diff.hunks) {
      if (hunk.added.length < 3) {
        continue;
      }
      const block = hunk.added.map((line) => line.trim()).filter((line) => line.length > 0);
      if (block.length < 3) {
        continue;
      }
      const signature = block.join('\n');
      if (oldContent.includes(signature)) {
        return true;
      }
      for (const [path, snapshot] of this.snapshots) {
        if (path === filePath) {
          continue;
        }
        if (snapshot.includes(signature)) {
          return true;
        }
      }
    }
    return false;
  }

  /** 小规模近义修改：拼接后编辑距离很小 */
  private isFixTypo(removed: string[], added: string[]): boolean {
    if (removed.length === 0 || added.length === 0 || removed.length > 3 || added.length > 3) {
      return false;
    }
    const r = removed.join('\n').trim();
    const a = added.join('\n').trim();
    if (r === a || Math.abs(r.length - a.length) > 2) {
      return false;
    }
    return this.levenshtein(r, a) <= 3;
  }

  private levenshtein(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array<number>(n + 1);
    let curr = new Array<number>(n + 1);
    for (let j = 0; j <= n; j++) {
      prev[j] = j;
    }
    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      }
      [prev, curr] = [curr, prev];
    }
    return prev[n];
  }

  /** 估计被删代码第一次出现到现在的时间（分钟） */
  private estimateDeletedCodeAgeMinutes(removed: string[], filePath: string): number {
    const history = this.contentHistory.get(filePath);
    if (history && history.length > 0) {
      const signature = removed.slice(0, 10).join('\n');
      for (let i = 0; i < history.length; i++) {
        if (history[i].content.includes(signature)) {
          return Math.max(0, (Date.now() - history[i].savedAt) / 60_000);
        }
      }
    }
    const meta = this.fileMeta.get(filePath);
    return meta ? Math.max(0, (Date.now() - meta.firstSeenAt) / 60_000) : 0;
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

  /** 获取文件扩展名作为语言标识 */
  private getLanguage(filePath: string): string {
    const match = filePath.match(/\.([a-zA-Z0-9]+)$/);
    return match ? match[1].toLowerCase() : '';
  }

  /** 提取上下文片段 */
  private extractContext(oldContent: string, removed: string[]): string {
    if (removed.length === 0) {
      return '';
    }
    const lines = oldContent.split('\n');
    const removedText = removed.join('\n');

    const idx = oldContent.indexOf(removedText);
    if (idx < 0) {
      return removedText.slice(0, 200);
    }

    const before = oldContent.substring(0, idx).split('\n');
    const after = oldContent.substring(idx + removedText.length).split('\n');
    const contextBefore = before.slice(-2).join('\n');
    const contextAfter = after.slice(0, 2).join('\n');

    let ctx = '';
    if (contextBefore) {
      ctx += contextBefore + '\n';
    }
    ctx += removedText;
    if (contextAfter) {
      ctx += '\n' + contextAfter;
    }

    return ctx.length > 500 ? ctx.slice(0, 500) + '...' : ctx;
  }

  /** 追踪多文件改动 */
  private trackMultiFile(filePath: string): void {
    const now = Date.now();
    this.recentSaves.set(filePath, now);

    const cutoff = now - 5000;
    for (const [key, time] of this.recentSaves) {
      if (time < cutoff) {
        this.recentSaves.delete(key);
      }
    }
  }

  /** 判断是否有多文件改动 */
  private isMultiFileBatch(): number {
    return new Set(this.recentSaves.keys()).size;
  }

  /** 创建一条简单记录（开工、存盘等无 diff 事件） */
  private createSimpleRecord(filePath: string, actionType: ActionType): DecisionRecord {
    const ctx: TemplateContext = {
      fileName: this.getShortFileName(filePath),
      lines: 0,
      count: 1,
      hour: new Date().getHours(),
      language: this.getLanguage(filePath),
    };
    return this.buildSimpleRecord(filePath, actionType, ctx);
  }

  /** 构建不带 diff 的简单记录 */
  private buildSimpleRecord(
    filePath: string,
    actionType: ActionType,
    ctx: TemplateContext
  ): DecisionRecord {
    const message = generateMessage(actionType, ctx, this.config.toneStyle);

    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      filePath,
      fileName: ctx.fileName,
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
    oldContent: string,
    prevMeta?: FileMeta
  ): DecisionRecord[] {
    const { removed, added } = diff;
    const removedCount = removed.length;
    const addedCount = added.length;
    if (removedCount === 0 && addedCount === 0) {
      return [];
    }

    const filePath = doc.fileName;
    const hour = new Date().getHours();
    const isLateNight = hour >= 0 && hour < 5;
    const meta = this.fileMeta.get(filePath);
    const saveCount = meta?.saveCount ?? 1;
    const lifetimeMinutes = meta
      ? Math.max(1, Math.floor((Date.now() - meta.firstSeenAt) / 60_000))
      : 1;
    const deletedAgeMinutes = this.estimateDeletedCodeAgeMinutes(removed, filePath);
    const deletedAgeDays = deletedAgeMinutes / (60 * 24);

    const ctx: TemplateContext = {
      fileName: this.getShortFileName(filePath),
      lines: removedCount || addedCount,
      count: saveCount,
      hour,
      fnName: this.detectDeletedFunction(removed),
      addedLines: addedCount,
      deletedLines: removedCount,
      lifetime: saveCount > 1 ? this.formatLifetime(lifetimeMinutes) : undefined,
      lifetimeDays: deletedAgeDays,
      language: this.getLanguage(filePath),
    };

    const records: DecisionRecord[] = [];

    // 深夜模式作为附加标记
    if (isLateNight) {
      records.push(this.buildRecord(filePath, 'late-night', diff, ctx, oldContent));
    }

    // 秒写秒删
    if (records.length <= (isLateNight ? 1 : 0) && this.isQuickUndo(diff, prevMeta)) {
      ctx.lines = Math.max(0, Math.floor((Date.now() - (prevMeta?.lastSavedAt ?? Date.now())) / 1000));
      records.push(this.buildRecord(filePath, 'quick-undo', diff, ctx, oldContent));
    }

    // 绕回原点
    if (records.length <= (isLateNight ? 1 : 0) && this.isBackToOrigin(filePath, doc.getText()) && removedCount > 0) {
      ctx.lines = removedCount;
      records.push(this.buildRecord(filePath, 'back-to-origin', diff, ctx, oldContent));
    }

    const mainSlot = records.length;
    const addMain = (type: ActionType, overrides: Partial<TemplateContext> = {}) => {
      if (records.length !== mainSlot) {
        return;
      }
      records.push(this.buildRecord(filePath, type, diff, { ...ctx, ...overrides }, oldContent));
    };

    // 预先计算被删内容的防御性判断类型
    const guardKind =
      removedCount > 0 && addedCount === 0 ? this.detectGuardRemoval(removed) : undefined;

    // 主分类：从具体到通用
    if (this.isEmptyFile(diff, doc)) {
      addMain('empty-file');
    } else if (diff.isFormatOnly) {
      addMain('format-only');
    } else if (this.isDependencyFile(filePath) && this.looksLikeDependencyChange(removed, added)) {
      addMain('dependency-change', { dependency: this.extractDependencyName(removed, added) });
    } else if (removedCount > 0 && addedCount === 0 && this.isTestFile(filePath)) {
      addMain('delete-test');
    } else if (removedCount > 0 && addedCount > 0 && this.isTestFile(filePath)) {
      addMain('test-edit');
    } else if (removedCount > 0 && addedCount === 0 && ctx.fnName) {
      addMain('delete-function');
    } else if (removedCount >= 2 && removedCount >= addedCount && this.isErrorHandlingRemoval(removed)) {
      addMain('delete-error-handling');
    } else if (guardKind) {
      addMain('delete-guard', { guardKind });
    } else if (this.isDebugCleanup(removed, added)) {
      addMain('debug-cleanup');
    } else if (removedCount > 0 && addedCount === 0 && this.isTodoCleanup(removed)) {
      addMain('todo-cleanup', { marker: this.detectTodoMarker(removed) });
    } else if (removedCount > 0 && addedCount === 0 && this.isCommentOnly(removed)) {
      addMain('delete-comment', { commentCount: this.countCommentLines(removed) });
    } else if (this.isCommentOutCode(removed, added)) {
      addMain('comment-out-code');
    } else if (this.isUncommentCode(removed, added)) {
      addMain('uncomment-code');
    } else if (removedCount === 0 && addedCount > 0 && this.isTodoAdded(added)) {
      addMain('add-todo', { marker: this.detectTodoMarker(added) });
    } else if (removedCount === 0 && addedCount > 0 && this.isCommentAddition(added)) {
      addMain('add-comment', { commentCount: this.countCommentLines(added) });
    } else if (this.isImportChange(removed, added)) {
      addMain('import-change');
    } else if (this.isRenameRefactor(diff)) {
      addMain('rename-refactor');
    } else if (this.isCopyPaste(diff, oldContent, filePath)) {
      addMain('copy-paste', { duplicated: addedCount });
    } else if (removedCount === 0 && addedCount >= 3) {
      addMain('add-code');
    } else if (removedCount > 0 && addedCount === 0 && deletedAgeDays >= 1) {
      addMain('delete-old-code', { lifetime: `${Math.floor(deletedAgeDays)} 天` });
    } else if (removedCount >= 10 && addedCount === 0) {
      addMain('delete-bulk');
    } else if (removedCount > 0 && addedCount === 0) {
      addMain('delete-small');
    } else if (removedCount > 10 && addedCount > 10) {
      addMain('refactor');
    } else if (removedCount >= 3 && addedCount >= 3) {
      addMain('replace-solution');
    } else if (this.isConfigFile(filePath)) {
      addMain('config-change');
    } else if (this.isFixTypo(removed, added)) {
      addMain('fix-typo');
    } else if (removedCount > 0 && addedCount > 0 && removedCount <= 3 && addedCount <= 3) {
      addMain('tweak');
    } else {
      const multiFileCount = this.isMultiFileBatch();
      if (multiFileCount >= 2) {
        addMain('multi-file', { lines: multiFileCount });
      } else {
        addMain('general');
      }
    }

    // 附加事件：可与主事件叠加
    if (this.isBackAndForth(removed, added, saveCount)) {
      records.push(this.buildRecord(filePath, 'back-and-forth', diff, ctx, oldContent));
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

    if (this.isLoopReminder(removed, added, saveCount)) {
      records.push(this.buildRecord(filePath, 'loop-reminder', diff, ctx, oldContent));
    }

    if (this.isAbandonmentCost(diff, deletedAgeMinutes)) {
      records.push(
        this.buildRecord(
          filePath,
          'abandonment-cost',
          diff,
          { ...ctx, lifetime: this.formatLifetime(Math.max(1, Math.floor(deletedAgeMinutes))) },
          oldContent
        )
      );
    }

    if (removedCount >= 5 && addedCount === 0) {
      const deletedCommentCount = this.countCommentLines(removed);
      if (deletedCommentCount >= 3) {
        records.push(
          this.buildRecord(
            filePath,
            'sunk-cost',
            diff,
            { ...ctx, commentCount: deletedCommentCount },
            oldContent
          )
        );
      }
    }

    // 元事件：函数反复增删
    const churnName = this.trackFunctionChurn(filePath, removed, added);
    if (churnName) {
      records.push(
        this.buildRecord(filePath, 'function-churn', diff, { ...ctx, fnName: churnName }, oldContent)
      );
    }

    // 元事件：连续凌晨编码
    if (isLateNight) {
      const streak = this.getLateNightStreakDays();
      const today = this.getDayKey();
      if (streak >= 3 && this.lastStreakReportDay !== today) {
        this.lastStreakReportDay = today;
        records.push(
          this.buildRecord(filePath, 'late-night-streak', diff, { ...ctx, streak }, oldContent)
        );
      }
    }

    // 元事件：模式发现（同一星期几 + 同一时段反复推翻）
    const pattern = this.detectPattern();
    if (pattern) {
      records.push(
        this.buildRecord(filePath, 'pattern-discovery', diff, { ...ctx, ...pattern }, oldContent)
      );
    }

    // 元事件：自相矛盾（写回之前删过的代码）
    if (removedCount === 0 && addedCount >= 3 && this.isSelfContradiction(added)) {
      records.push(this.buildRecord(filePath, 'self-contradiction', diff, ctx, oldContent));
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
    const message = generateMessage(actionType, ctx, this.config.toneStyle);

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
    this.fileMeta.clear();
    this.contentHistory.clear();
    this.recentSaves.clear();
    this.openedDocs.clear();
    this.functionHistory.clear();
  }
}
