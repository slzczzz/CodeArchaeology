import * as vscode from 'vscode';
import { DecisionTracker } from './DecisionTracker';
import { DecisionStore } from './DecisionStore';
import { DecisionViewProvider } from './DecisionViewProvider';

/** 激活扩展 */
export function activate(context: vscode.ExtensionContext): void {
  console.log('[代码考古] 激活');

  // 初始化存储
  const store = new DecisionStore(context);

  // 初始化追踪器
  const tracker = new DecisionTracker(store);
  context.subscriptions.push(tracker);

  // 注册 Webview View Provider（侧边栏视图）
  const provider = new DecisionViewProvider(context, store);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DecisionViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // 监听文档保存事件
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      // 只监听文件系统中的文件，跳过临时文件、git 等
      if (doc.uri.scheme === 'file' && !doc.fileName.includes('.git')) {
        tracker.onDidSaveTextDocument(doc);
      }
    })
  );

  // 注册命令：打开侧边栏
  context.subscriptions.push(
    vscode.commands.registerCommand('decisionArchaeologist.openView', () => {
      vscode.commands.executeCommand('workbench.view.extension.decision-archaeologist');
    })
  );

  // 注册命令：清空记录
  context.subscriptions.push(
    vscode.commands.registerCommand('decisionArchaeologist.clearRecords', () => {
      store.clear();
      vscode.window.showInformationMessage('决策记录已清空');
    })
  );

  // 状态栏提示（可选）
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = '🦴';
  statusBarItem.tooltip = '代码考古';
  statusBarItem.command = 'decisionArchaeologist.openView';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  console.log('[代码考古] 已就绪');
}

/** 停用扩展 */
export function deactivate(): void {
  console.log('[代码考古] 已停用');
}
