import * as vscode from 'vscode';
import { DecisionRecord, ActionType } from './types';
import { DecisionStore } from './DecisionStore';

/**
 * 决策视图提供器
 * 在侧边栏中以 Webview 形式展示决策记录
 */
export class DecisionViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'decisionArchaeologist.view';
  private _view?: vscode.WebviewView;
  private store: DecisionStore;

  constructor(
    private readonly context: vscode.ExtensionContext,
    store: DecisionStore
  ) {
    this.store = store;

    // 监听新记录到来，更新视图
    store.onDidUpdate(() => {
      this.refresh();
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.html = this.getHtml();

    // 监听来自 Webview 的消息
    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case 'requestClear':
          this.confirmClear();
          break;
        case 'openFile':
          this.openFile(message.filePath);
          break;
        case 'copySnippet':
          this.copySnippet(message.recordId);
          break;
        case 'deleteRecord':
          this.deleteRecord(message.recordId);
          break;
        case 'recordMenu':
          this.showRecordMenu(message.recordId, message.filePath);
          break;
        case 'export':
          this.exportRecords();
          break;
        case 'refresh':
          this.refresh();
          break;
      }
    });

    // 初始加载数据
    this.refresh();
  }

  /** 通过原生模态确认后清空记录 */
  private async confirmClear(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      '确定清空所有决策记录吗？此操作不可撤销。',
      { modal: true },
      '清空'
    );
    if (choice !== '清空') {
      return;
    }
    this.store.clear();
    vscode.window.showInformationMessage('决策记录已清空');
  }

  /** 刷新视图 */
  private refresh(): void {
    if (!this._view) return;
    const records = this.store.getRecords();
    this._view.webview.postMessage({
      command: 'updateRecords',
      records,
      totalCount: this.store.getCount(),
      summary: this.store.getSummary(),
    });
  }

  /** 打开文件 */
  private openFile(filePath: string): void {
    vscode.workspace.openTextDocument(filePath).then(
      (doc) => vscode.window.showTextDocument(doc),
      () => {
        vscode.window.showWarningMessage(`文件不存在: ${filePath}`);
      }
    );
  }

  /** 复制某条记录的被删代码到剪贴板 */
  private async copySnippet(recordId: string): Promise<void> {
    const record = this.store.getRecords().find((r) => r.id === recordId);
    if (!record || !record.contextSnippet) {
      vscode.window.showWarningMessage('这条记录没有可复制的代码片段');
      return;
    }
    await vscode.env.clipboard.writeText(record.contextSnippet);
    vscode.window.showInformationMessage('已复制被删代码片段');
  }

  /** 删除单条记录 */
  private deleteRecord(recordId: string): void {
    if (!recordId) {
      return;
    }
    this.store.deleteRecord(recordId);
    vscode.window.showInformationMessage('已删除该条记录');
  }

  /** 卡片右键菜单 */
  private async showRecordMenu(recordId: string, filePath: string): Promise<void> {
    const record = this.store.getRecords().find((r) => r.id === recordId);
    const items: vscode.QuickPickItem[] = [];
    if (record?.contextSnippet) {
      items.push({ label: '$(copy) 复制被删代码' });
    }
    items.push({ label: '$(go-to-file) 打开文件' });
    items.push({ label: '$(trash) 删除此条记录' });

    const picked = await vscode.window.showQuickPick(items, { title: '记录操作' });
    if (!picked) {
      return;
    }
    if (picked.label.includes('复制')) {
      await this.copySnippet(recordId);
    } else if (picked.label.includes('打开')) {
      this.openFile(filePath);
    } else if (picked.label.includes('删除')) {
      this.deleteRecord(recordId);
    }
  }

  /** 导出记录为 Markdown 或 JSON */
  private async exportRecords(): Promise<void> {
    const records = this.store.getRecords();
    if (records.length === 0) {
      vscode.window.showInformationMessage('还没有可导出的记录');
      return;
    }

    const format = await vscode.window.showQuickPick(
      [
        { label: 'Markdown', description: '适合写周报、复盘' },
        { label: 'JSON', description: '完整数据，便于二次处理' },
      ],
      { title: '选择导出格式' }
    );
    if (!format) {
      return;
    }

    const isMarkdown = format.label === 'Markdown';
    const today = new Date().toISOString().slice(0, 10);
    const defaultName = `code-archaeology-${today}.${isMarkdown ? 'md' : 'json'}`;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;

    const target = await vscode.window.showSaveDialog({
      defaultUri: workspaceRoot ? vscode.Uri.joinPath(workspaceRoot, defaultName) : undefined,
      filters: isMarkdown ? { Markdown: ['md'] } : { JSON: ['json'] },
    });
    if (!target) {
      return;
    }

    const content = isMarkdown ? this.toMarkdown(records) : JSON.stringify(records, null, 2);
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf-8'));
    vscode.window.showInformationMessage(`已导出 ${records.length} 条记录`);
  }

  /** 生成 Markdown 报告 */
  private toMarkdown(records: DecisionRecord[]): string {
    const lines: string[] = [
      '# 代码考古报告',
      '',
      `导出时间：${new Date().toLocaleString()}`,
      `记录条数：${records.length}`,
      '',
    ];

    const byDay = new Map<string, DecisionRecord[]>();
    for (const record of records) {
      const date = new Date(record.timestamp);
      const pad = (n: number) => `${n}`.padStart(2, '0');
      const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      const bucket = byDay.get(key);
      if (bucket) {
        bucket.push(record);
      } else {
        byDay.set(key, [record]);
      }
    }

    for (const [day, items] of byDay) {
      lines.push(`## ${day}`, '');
      for (const record of items) {
        const time = new Date(record.timestamp).toLocaleTimeString();
        lines.push(`- \`${time}\` **${record.fileName}** — ${record.message}`);
        if (record.deletedLines || record.addedLines) {
          lines.push(`  - 删 ${record.deletedLines} 行 / 增 ${record.addedLines} 行`);
        }
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  /** 生成 Webview HTML */
  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --bg: var(--vscode-sideBar-background, #1e1e1e);
      --fg: var(--vscode-sideBar-foreground, #cccccc);
      --border: var(--vscode-sideBar-border, #333333);
      --card-bg: var(--vscode-editor-background, #252526);
      --card-border: var(--vscode-editorWidget-border, #454545);
      --secondary: var(--vscode-descriptionForeground, #888888);
      --link: var(--vscode-textLink-foreground, #3794ff);
      --badge: var(--vscode-badge-background, #4d4d4d);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg);
      color: var(--fg);
      padding: 0;
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .header {
      padding: 12px 16px 8px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .title {
      font-size: 14px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .title .badge {
      font-size: 11px;
      font-weight: 400;
      background: var(--badge);
      padding: 1px 6px;
      border-radius: 8px;
      opacity: 0.7;
    }
    .actions {
      display: flex;
      gap: 4px;
    }
    .actions button {
      background: none;
      border: none;
      color: var(--secondary);
      cursor: pointer;
      font-size: 16px;
      padding: 2px 6px;
      border-radius: 4px;
      transition: all 0.15s;
    }
    .actions button:hover {
      background: var(--badge);
      color: var(--fg);
    }
    .toolbar {
      padding: 8px 12px 4px;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .toolbar input {
      flex: 1;
      min-width: 0;
      background: var(--card-bg);
      color: var(--fg);
      border: 1px solid var(--card-border);
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
    }
    .toolbar input:focus {
      outline: none;
      border-color: var(--link);
    }
    .summary-line {
      font-size: 11px;
      color: var(--secondary);
      white-space: nowrap;
    }
    .content {
      flex: 1;
      overflow-y: auto;
      padding: 8px 12px;
    }
    .empty {
      text-align: center;
      padding: 40px 16px;
      color: var(--secondary);
    }
    .empty .big-emoji { font-size: 48px; display: block; margin-bottom: 12px; }
    .empty .hint { font-size: 12px; margin-top: 8px; opacity: 0.6; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 10px 12px;
      margin-bottom: 8px;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .card:hover {
      opacity: 0.85;
    }
    .card-header {
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }
    .card-emoji {
      font-size: 18px;
      line-height: 1.3;
      flex-shrink: 0;
      width: 24px;
      text-align: center;
    }
    .card-body {
      flex: 1;
      min-width: 0;
    }
    .card-message {
      font-size: 13px;
      line-height: 1.4;
      word-break: break-word;
    }
    .card-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 4px;
      font-size: 11px;
      color: var(--secondary);
    }
    .card-meta .file {
      color: var(--link);
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 200px;
    }
    .card-meta .file:hover {
      text-decoration: underline;
    }
    .card-meta .time {
      flex-shrink: 0;
    }
    .card-meta .stats {
      flex-shrink: 0;
    }
    .card-detail {
      display: none;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--card-border);
    }
    .card.expanded .card-detail {
      display: block;
    }
    .card-detail pre {
      font-size: 11px;
      background: var(--bg);
      padding: 8px;
      border-radius: 4px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 200px;
      overflow-y: auto;
      color: var(--fg);
      opacity: 0.8;
    }
    .card-detail .stats-line {
      font-size: 11px;
      margin-bottom: 6px;
      color: var(--secondary);
    }
    .type-label {
      display: inline-block;
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--badge);
      color: var(--fg);
      opacity: 0.7;
      flex-shrink: 0;
      white-space: nowrap;
    }
    select {
      background: var(--card-bg);
      color: var(--fg);
      border: 1px solid var(--card-border);
      border-radius: 4px;
      padding: 4px 6px;
      font-size: 12px;
      flex-shrink: 0;
      max-width: 96px;
    }
    select:focus { outline: none; border-color: var(--link); }
    .summary-row {
      padding: 0 12px 6px;
      flex-shrink: 0;
    }
    .day-group { margin-bottom: 2px; }
    .day-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 2px;
      cursor: pointer;
      font-size: 11px;
      color: var(--secondary);
      user-select: none;
      position: sticky;
      top: 0;
      background: var(--bg);
      z-index: 2;
    }
    .day-header:hover { color: var(--fg); }
    .day-caret { display: inline-block; transition: transform 0.15s; }
    .day-group.collapsed .day-caret { transform: rotate(-90deg); }
    .day-group.collapsed .day-body { display: none; }
    .day-label { font-weight: 600; }
    .day-count {
      background: var(--badge);
      border-radius: 8px;
      padding: 0 6px;
      font-size: 10px;
      opacity: 0.8;
    }
    .card-actions {
      display: flex;
      gap: 6px;
      margin-top: 8px;
      flex-wrap: wrap;
    }
    .act {
      background: none;
      border: 1px solid var(--card-border);
      color: var(--fg);
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .act:hover { background: var(--badge); border-color: var(--link); }
    .stats-panel {
      display: none;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      max-height: 45vh;
      overflow-y: auto;
    }
    .stat-block { margin-bottom: 12px; }
    .stat-title { font-size: 11px; font-weight: 600; color: var(--secondary); margin-bottom: 6px; }
    .stat-empty { font-size: 11px; color: var(--secondary); opacity: 0.6; }
    .stat-row { display: flex; align-items: center; gap: 6px; font-size: 11px; margin-bottom: 4px; }
    .stat-name { flex-shrink: 0; width: 72px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .stat-bar { flex: 1; height: 6px; background: var(--badge); border-radius: 3px; overflow: hidden; }
    .stat-bar i { display: block; height: 100%; background: var(--link); border-radius: 3px; }
    .stat-val { flex-shrink: 0; color: var(--secondary); }
    .spark { display: flex; align-items: flex-end; gap: 4px; height: 64px; }
    .spark-col { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; }
    .spark-col i { display: block; width: 100%; background: var(--link); opacity: 0.7; border-radius: 2px; }
    .spark-col span { font-size: 9px; color: var(--secondary); margin-top: 3px; }
    @media (prefers-color-scheme: light) {
      .card-detail pre { opacity: 0.9; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">
      🦴 代码考古
      <span class="badge" id="countBadge">0</span>
      <span class="badge" id="todayBadge">今日 0</span>
    </div>
    <div class="actions">
      <button id="statsBtn" title="统计面板">📊</button>
      <button id="sortBtn" title="按时间排序">🕒</button>
      <button id="refreshBtn" title="刷新">🔄</button>
      <button id="exportBtn" title="导出记录">⬇️</button>
      <button id="clearBtn" title="清空记录">🗑️</button>
    </div>
  </div>
  <div class="toolbar">
    <input id="filterInput" type="text" placeholder="筛选文件名或事件">
    <select id="categorySelect">
      <option value="all">全部</option>
      <option value="delete">删除类</option>
      <option value="add">新增类</option>
      <option value="edit">修改类</option>
      <option value="habit">习惯类</option>
      <option value="time">时间类</option>
      <option value="other">其他</option>
    </select>
  </div>
  <div class="summary-row"><span class="summary-line" id="summaryLine"></span></div>
  <div class="stats-panel" id="statsPanel"></div>
  <div class="content" id="recordList">
    <div class="empty">
      <span class="big-emoji">🦕</span>
      <div>还没有决策记录</div>
      <div class="hint">保存文件时，我会自动记录你的每一次决策</div>
    </div>
  </div>

  <script>
    (function() {
      const vscode = acquireVsCodeApi();
      const list = document.getElementById('recordList');
      const badge = document.getElementById('countBadge');

      // 表情映射
      const emojiMap = {
        'delete-function': '💀',
        'delete-bulk': '🗑️',
        'replace-solution': '🔄',
        'back-to-origin': '🔁',
        'record-break': '🏆',
        'loop-reminder': '🌀',
        'abandonment-cost': '⏳',
        'debug-cleanup': '🧹',
        'early-morning': '☀️',
        'late-night': '🌙',
        'start-working': '🚀',
        'delete-test': '🧪',
        'test-edit': '🧪',
        'delete-comment': '🗨️',
        'add-comment': '📝',
        'add-code': '➕',
        'copy-paste': '📋',
        'format-only': '🎨',
        'fix-typo': '🔤',
        'config-change': '⚙️',
        'todo-cleanup': '🧾',
        'sunk-cost': '💬',
        'delete-small': '✂️',
        'delete-guard': '🛡️',
        'delete-error-handling': '🚨',
        'empty-file': '🕳️',
        'add-todo': '📌',
        'dependency-change': '📚',
        'import-change': '🔗',
        'rename-refactor': '🏷️',
        'comment-out-code': '🙈',
        'uncomment-code': '👁️',
        'function-churn': '🔀',
        'late-night-streak': '🌗',
        'pattern-discovery': '🔍',
        'self-contradiction': '🪞',
        'empty-handed': '🚪',
        'tweak': '🔧',
        'multi-file': '📦',
        'quick-undo': '⚡',
        'refactor': '🏗️',
        'delete-old-code': '🕸️',
        'back-and-forth': '🎢',
        'general': '✏️',
      };

      function getEmoji(type) {
        return emojiMap[type] || '❓';
      }

      function formatTime(ts) {
        const d = new Date(ts);
        const pad = n => n.toString().padStart(2, '0');
        const h = pad(d.getHours());
        const m = pad(d.getMinutes());
        const s = pad(d.getSeconds());
        return h + ':' + m + ':' + s;
      }

      function formatDate(ts) {
        const d = new Date(ts);
        const now = new Date();
        if (d.toDateString() === now.toDateString()) {
          return '今天 ' + formatTime(ts);
        }
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        if (d.toDateString() === yesterday.toDateString()) {
          return '昨天 ' + formatTime(ts);
        }
        return d.getMonth() + 1 + '/' + d.getDate() + ' ' + formatTime(ts);
      }

      function getTypeLabel(type) {
        const labels = {
          'delete-function': '删函数',
          'delete-bulk': '批量删除',
          'replace-solution': '换方案',
          'back-to-origin': '绕回原点',
          'record-break': '破纪录',
          'loop-reminder': '循环提醒',
          'abandonment-cost': '放弃成本',
          'debug-cleanup': '清理调试',
          'early-morning': '早晨开工',
          'late-night': '深夜编码',
          'start-working': '开始工作',
          'delete-test': '删测试',
          'test-edit': '改测试',
          'delete-comment': '删注释',
          'add-comment': '加注释',
          'add-code': '新增代码',
          'copy-paste': '复制粘贴',
          'format-only': '格式调整',
          'fix-typo': '修小错',
          'config-change': '改配置',
          'todo-cleanup': '清 TODO',
          'sunk-cost': '沉没成本',
          'delete-small': '少量删除',
          'delete-guard': '删防御',
          'delete-error-handling': '删错误处理',
          'empty-file': '清空文件',
          'add-todo': '写 TODO',
          'dependency-change': '依赖变更',
          'import-change': '整理导入',
          'rename-refactor': '批量重命名',
          'comment-out-code': '注释掉代码',
          'uncomment-code': '取消注释',
          'function-churn': '函数反复增删',
          'late-night-streak': '连续凌晨',
          'pattern-discovery': '模式发现',
          'self-contradiction': '自相矛盾',
          'empty-handed': '空手而归',
          'tweak': '微调',
          'multi-file': '多文件',
          'quick-undo': '秒写秒删',
          'refactor': '重构',
          'delete-old-code': '清理旧代码',
          'back-and-forth': '反复修改',
          'general': '编辑',
        };
        return labels[type] || type;
      }

      function getShortPath(fp) {
        if (!fp) return '';
        const parts = fp.replace(/\\\\/g, '/').split('/');
        return parts[parts.length - 1] || fp;
      }

      let allRecords = [];
      let summary = { today: 0, totalDeleted: 0, totalAdded: 0 };
      let sortMode = 'time';
      const collapsedDays = {};

      // 类别分组，用于下拉筛选
      const CATEGORIES = {
        all: null,
        delete: ['delete-function', 'delete-bulk', 'delete-small', 'delete-test', 'delete-old-code', 'delete-comment', 'delete-guard', 'delete-error-handling', 'empty-file', 'debug-cleanup', 'todo-cleanup'],
        add: ['add-code', 'add-comment', 'add-todo'],
        edit: ['replace-solution', 'refactor', 'tweak', 'fix-typo', 'format-only', 'config-change', 'dependency-change', 'import-change', 'rename-refactor', 'test-edit', 'copy-paste', 'comment-out-code', 'uncomment-code', 'function-churn'],
        habit: ['back-to-origin', 'quick-undo', 'back-and-forth', 'loop-reminder', 'abandonment-cost', 'record-break', 'sunk-cost', 'multi-file', 'late-night-streak', 'pattern-discovery', 'self-contradiction', 'empty-handed'],
        time: ['early-morning', 'late-night', 'start-working'],
        other: ['general'],
      };

      function renderRecords(records, nextSummary) {
        allRecords = records || [];
        summary = nextSummary || summary;
        badge.textContent = allRecords.length;
        const todayBadge = document.getElementById('todayBadge');
        if (todayBadge) todayBadge.textContent = '今日 ' + summary.today;
        const summaryLine = document.getElementById('summaryLine');
        if (summaryLine) summaryLine.textContent = '累计删 ' + summary.totalDeleted + ' 行 / 增 ' + summary.totalAdded + ' 行';
        renderList();
      }

      function dayKey(ts) {
        const d = new Date(ts);
        return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
      }

      function dayLabel(ts) {
        const d = new Date(ts);
        const now = new Date();
        const key = dayKey(ts);
        if (key === dayKey(now.getTime())) return '今天';
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        if (key === dayKey(yesterday.getTime())) return '昨天';
        return (d.getMonth() + 1) + '月' + d.getDate() + '日';
      }

      function matchesCategory(r) {
        const sel = document.getElementById('categorySelect');
        const key = sel ? sel.value : 'all';
        const types = CATEGORIES[key];
        if (!types) return true;
        return types.indexOf(r.actionType) >= 0;
      }

      function getFiltered() {
        const input = document.getElementById('filterInput');
        const q = (input && input.value || '').trim().toLowerCase();
        const filtered = allRecords.filter(r => {
          if (!matchesCategory(r)) return false;
          if (!q) return true;
          const file = (r.fileName || '').toLowerCase();
          const type = getTypeLabel(r.actionType).toLowerCase();
          return file.includes(q) || type.includes(q);
        });
        if (sortMode === 'deleted') {
          filtered.sort((a, b) => (b.deletedLines || 0) - (a.deletedLines || 0) || b.timestamp - a.timestamp);
        } else {
          filtered.sort((a, b) => b.timestamp - a.timestamp);
        }
        return filtered;
      }

      function renderList() {
        const filtered = getFiltered();

        if (!filtered.length) {
          const hint = allRecords.length > 0 ? '没有匹配的记录' : '还没有决策记录';
          list.innerHTML = '<div class="empty"><span class="big-emoji">🦕</span><div>' + hint + '</div><div class="hint">保存文件时，我会自动记录你的每一次决策</div></div>';
          return;
        }

        // 按天分组（按删除行数排序时合并为一组）
        const groups = [];
        const index = {};
        for (const r of filtered) {
          const key = sortMode === 'time' ? dayKey(r.timestamp) : 'sorted';
          if (index[key] === undefined) {
            index[key] = groups.length;
            groups.push({
              key: key,
              label: sortMode === 'time' ? dayLabel(r.timestamp) : '按删除行数排序',
              items: [],
            });
          }
          groups[index[key]].items.push(r);
        }

        let html = '';
        for (const group of groups) {
          const collapsed = collapsedDays[group.key] ? ' collapsed' : '';
          html += '<div class="day-group' + collapsed + '" data-day="' + group.key + '">';
          html += '  <div class="day-header"><span class="day-caret">▾</span><span class="day-label">' + escapeHtml(group.label) + '</span><span class="day-count">' + group.items.length + '</span></div>';
          html += '  <div class="day-body">';
          for (const r of group.items) {
            html += renderCard(r);
          }
          html += '  </div>';
          html += '</div>';
        }
        list.innerHTML = html;
        bindListEvents();
      }

      function renderCard(r) {
        const emoji = getEmoji(r.actionType);
        const time = formatTime(r.timestamp);
        const label = getTypeLabel(r.actionType);
        const fileDisplay = getShortPath(r.filePath);
        const stats = r.deletedLines > 0 || r.addedLines > 0
          ? '-' + r.deletedLines + ' / +' + r.addedLines
          : '';

        let html = '';
        html += '<div class="card" data-id="' + escapeHtml(r.id || '') + '" data-path="' + (r.filePath || '').replace(/"/g, '&quot;') + '">';
        html += '  <div class="card-header">';
        html += '    <div class="card-emoji">' + emoji + '</div>';
        html += '    <div class="card-body">';
        html += '      <div class="card-message">' + escapeHtml(r.message) + '</div>';
        html += '      <div class="card-meta">';
        html += '        <span class="type-label">' + label + '</span>';
        html += '        <span class="file" title="' + escapeHtml(r.filePath) + '">' + escapeHtml(fileDisplay) + '</span>';
        html += '        <span class="time">' + time + '</span>';
        if (stats) html += '        <span class="stats">' + stats + '</span>';
        html += '      </div>';
        html += '    </div>';
        html += '  </div>';
        html += '  <div class="card-detail">';
        html += '    <div class="stats-line">删 ' + r.deletedLines + ' 行 / 增 ' + r.addedLines + ' 行</div>';
        if (r.contextSnippet) {
          html += '    <pre>' + escapeHtml(r.contextSnippet) + '</pre>';
        }
        html += '    <div class="card-actions">';
        if (r.contextSnippet) {
          html += '<button class="act" data-act="copy">复制被删代码</button>';
        }
        html += '<button class="act" data-act="open">打开文件</button>';
        html += '<button class="act" data-act="delete">删除此条</button>';
        html += '    </div>';
        html += '  </div>';
        html += '</div>';
        return html;
      }

      function bindListEvents() {
        list.querySelectorAll('.card').forEach(card => {
          card.addEventListener('click', (e) => {
            if (e.target.classList.contains('file')) return;
            if (e.target.classList.contains('act')) return;
            card.classList.toggle('expanded');
          });
          card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            vscode.postMessage({
              command: 'recordMenu',
              filePath: card.dataset.path,
              recordId: card.dataset.id,
            });
          });
          const fileEl = card.querySelector('.file');
          if (fileEl) {
            fileEl.addEventListener('click', (e) => {
              e.stopPropagation();
              if (card.dataset.path) vscode.postMessage({ command: 'openFile', filePath: card.dataset.path });
            });
          }
          card.querySelectorAll('.act').forEach(btn => {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              const act = btn.dataset.act;
              if (act === 'open') vscode.postMessage({ command: 'openFile', filePath: card.dataset.path });
              else if (act === 'copy') vscode.postMessage({ command: 'copySnippet', recordId: card.dataset.id });
              else if (act === 'delete') vscode.postMessage({ command: 'deleteRecord', recordId: card.dataset.id });
            });
          });
        });

        list.querySelectorAll('.day-header').forEach(header => {
          header.addEventListener('click', () => {
            const group = header.parentElement;
            group.classList.toggle('collapsed');
            collapsedDays[group.dataset.day] = group.classList.contains('collapsed');
          });
        });
      }

      // 统计面板：类型分布 / 删除最多的文件 / 最近 7 天
      function renderStats() {
        const panel = document.getElementById('statsPanel');
        if (!panel) return;
        if (panel.style.display === 'block') {
          panel.style.display = 'none';
          return;
        }

        const counts = {};
        const deletedTop = {};
        for (const r of allRecords) {
          counts[r.actionType] = (counts[r.actionType] || 0) + 1;
          if (r.deletedLines > 0) {
            deletedTop[r.fileName] = (deletedTop[r.fileName] || 0) + r.deletedLines;
          }
        }

        const typeRows = Object.keys(counts)
          .map(k => ({ k: k, v: counts[k] }))
          .sort((a, b) => b.v - a.v)
          .slice(0, 8);
        const maxType = typeRows.length ? typeRows[0].v : 1;

        const fileRows = Object.keys(deletedTop)
          .map(k => ({ k: k, v: deletedTop[k] }))
          .sort((a, b) => b.v - a.v)
          .slice(0, 5);

        const days = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          days.push({ key: dayKey(d.getTime()), label: (d.getMonth() + 1) + '/' + d.getDate(), count: 0, deleted: 0 });
        }
        for (const r of allRecords) {
          const key = dayKey(r.timestamp);
          for (const slot of days) {
            if (slot.key === key) {
              slot.count++;
              slot.deleted += r.deletedLines || 0;
            }
          }
        }
        let maxDay = 1;
        for (const d of days) {
          if (d.count > maxDay) maxDay = d.count;
        }

        let html = '';
        html += '<div class="stat-block"><div class="stat-title">类型分布</div>';
        if (!typeRows.length) html += '<div class="stat-empty">暂无数据</div>';
        for (const row of typeRows) {
          const pct = Math.round(row.v / maxType * 100);
          html += '<div class="stat-row"><span class="stat-name">' + getTypeLabel(row.k) + '</span><span class="stat-bar"><i style="width:' + pct + '%"></i></span><span class="stat-val">' + row.v + '</span></div>';
        }
        html += '</div>';

        html += '<div class="stat-block"><div class="stat-title">删除最多的文件</div>';
        if (!fileRows.length) html += '<div class="stat-empty">暂无数据</div>';
        for (const row of fileRows) {
          html += '<div class="stat-row"><span class="stat-name" title="' + escapeHtml(row.k) + '">' + escapeHtml(getShortPath(row.k)) + '</span><span class="stat-val">-' + row.v + ' 行</span></div>';
        }
        html += '</div>';

        html += '<div class="stat-block"><div class="stat-title">最近 7 天</div><div class="spark">';
        for (const d of days) {
          const h = Math.round(d.count / maxDay * 100);
          html += '<div class="spark-col" title="' + d.label + '：' + d.count + ' 条 / 删 ' + d.deleted + ' 行"><i style="height:' + Math.max(2, h) + '%"></i><span>' + d.label + '</span></div>';
        }
        html += '</div></div>';

        panel.innerHTML = html;
        panel.style.display = 'block';
      }

      function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      // 接收来自扩展的消息
      window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.command) {
          case 'updateRecords':
            renderRecords(msg.records, msg.summary);
            break;
        }
      });

      // 按钮事件
      document.getElementById('refreshBtn').addEventListener('click', () => {
        vscode.postMessage({ command: 'refresh' });
      });
      document.getElementById('clearBtn').addEventListener('click', () => {
        vscode.postMessage({ command: 'requestClear' });
      });
      document.getElementById('exportBtn').addEventListener('click', () => {
        vscode.postMessage({ command: 'export' });
      });
      document.getElementById('statsBtn').addEventListener('click', renderStats);
      const sortBtn = document.getElementById('sortBtn');
      sortBtn.addEventListener('click', () => {
        sortMode = sortMode === 'time' ? 'deleted' : 'time';
        sortBtn.textContent = sortMode === 'time' ? '🕒' : '📉';
        sortBtn.title = sortMode === 'time' ? '按时间排序' : '按删除行数排序';
        renderList();
      });
      document.getElementById('filterInput').addEventListener('input', renderList);
      document.getElementById('categorySelect').addEventListener('change', renderList);
    })();
  </script>
</body>
</html>`;
  }
}
