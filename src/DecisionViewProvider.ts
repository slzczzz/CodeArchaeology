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
        case 'clear':
          this.store.clear();
          break;
        case 'openFile':
          this.openFile(message.filePath);
          break;
        case 'refresh':
          this.refresh();
          break;
      }
    });

    // 初始加载数据
    this.refresh();
  }

  /** 刷新视图 */
  private refresh(): void {
    if (!this._view) return;
    const records = this.store.getRecords();
    this._view.webview.postMessage({
      command: 'updateRecords',
      records,
      totalCount: this.store.getCount(),
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
    </div>
    <div class="actions">
      <button id="refreshBtn" title="刷新">🔄</button>
      <button id="clearBtn" title="清空记录">🗑️</button>
    </div>
  </div>
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
        'add-comment': '📝',
        'add-code': '➕',
        'sunk-cost': '💬',
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
          'add-comment': '加注释',
          'add-code': '新增代码',
          'sunk-cost': '沉没成本',
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

      function renderRecords(records) {
        if (!records || records.length === 0) {
          list.innerHTML = '<div class="empty"><span class="big-emoji">🦕</span><div>还没有决策记录</div><div class="hint">保存文件时，我会自动记录你的每一次决策</div></div>';
          badge.textContent = '0';
          return;
        }

        badge.textContent = records.length;

        let html = '';
        for (const r of records) {
          const emoji = getEmoji(r.actionType);
          const time = formatDate(r.timestamp);
          const label = getTypeLabel(r.actionType);
          const fileDisplay = getShortPath(r.filePath);
          const stats = r.deletedLines > 0 || r.addedLines > 0
            ? '-' + r.deletedLines + ' / +' + r.addedLines
            : '';

          html += '<div class="card" data-path="' + r.filePath.replace(/"/g, '&quot;') + '">';
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
          if (r.contextSnippet) {
            html += '  <div class="card-detail">';
            html += '    <div class="stats-line">删 ' + r.deletedLines + ' 行 / 增 ' + r.addedLines + ' 行</div>';
            html += '    <pre>' + escapeHtml(r.contextSnippet) + '</pre>';
            html += '  </div>';
          }
          html += '</div>';
        }
        list.innerHTML = html;

        // 点击卡片展开详情 / 双击文件名打开文件
        list.querySelectorAll('.card').forEach(card => {
          card.addEventListener('click', (e) => {
            // 如果点了文件名链接，不切换展开
            if (e.target.classList.contains('file')) return;
            card.classList.toggle('expanded');
          });
          card.querySelector('.file')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const path = card.dataset.path;
            if (path) vscode.postMessage({ command: 'openFile', filePath: path });
          });
        });
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
            renderRecords(msg.records);
            break;
        }
      });

      // 按钮事件
      document.getElementById('refreshBtn').addEventListener('click', () => {
        vscode.postMessage({ command: 'refresh' });
      });
      document.getElementById('clearBtn').addEventListener('click', () => {
        if (confirm('确定清空所有决策记录吗？')) {
          vscode.postMessage({ command: 'clear' });
        }
      });
    })();
  </script>
</body>
</html>`;
  }
}
