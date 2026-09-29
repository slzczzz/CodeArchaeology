import * as vscode from 'vscode';
import { DecisionTracker } from './DecisionTracker';
import { DecisionStore } from './DecisionStore';
import { DecisionViewProvider } from './DecisionViewProvider';
import { onConfigChanged } from './config';

/** 扩展激活期间持有的存储实例，用于停用时落盘 */
let activeStore: DecisionStore | undefined;

/** 激活扩展 */
export function activate(context: vscode.ExtensionContext): void {
  console.log('[代码考古] 激活');

  // 初始化存储
  const store = new DecisionStore(context);
  activeStore = store;
  context.subscriptions.push(store);

  // 初始化追踪器
  const tracker = new DecisionTracker(store);
  context.subscriptions.push(tracker);

  // 配置变更时同步给追踪器
  context.subscriptions.push(onConfigChanged((config) => tracker.updateConfig(config)));

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
      // 仅处理真实文件，排除项（node_modules / out / dist 等）在追踪器内部过滤
      if (doc.uri.scheme === 'file') {
        tracker.onDidSaveTextDocument(doc);
      }
    })
  );

  // 监听文档打开 / 关闭，用于“空手而归”
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme === 'file') {
        tracker.onDidOpenTextDocument(doc);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === 'file') {
        tracker.onDidCloseTextDocument(doc);
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
  activeStore?.dispose();
  activeStore = undefined;
  console.log('[代码考古] 已停用');
}
