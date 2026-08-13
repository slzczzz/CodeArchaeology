import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DecisionRecord, DecisionSummary } from './types';

/** 决策存储：将决策记录持久化到本地 JSON 文件 */
export class DecisionStore {
  private records: DecisionRecord[] = [];
  private storagePath: string;
  private maxRecords: number;
  private _onDidUpdate = new vscode.EventEmitter<void>();
  readonly onDidUpdate: vscode.Event<void> = this._onDidUpdate.event;

  constructor(context: vscode.ExtensionContext) {
    this.storagePath = path.join(context.globalStorageUri.fsPath, 'decisions.json');
    this.maxRecords = vscode.workspace.getConfiguration('decisionArchaeologist').get('maxRecords', 1000);
    this.load();

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('decisionArchaeologist.maxRecords')) {
          this.maxRecords = vscode.workspace.getConfiguration('decisionArchaeologist').get('maxRecords', 1000);
        }
      })
    );
  }

  /** 添加一条记录 */
  addRecord(record: DecisionRecord): void {
    this.records.push(record);

    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }

    this.save();
    this._onDidUpdate.fire();
  }

  /** 获取所有记录（按时间降序排列） */
  getRecords(): DecisionRecord[] {
    return [...this.records].reverse();
  }

  /** 获取记录总数 */
  getCount(): number {
    return this.records.length;
  }

  /** 清空所有记录 */
  clear(): void {
    this.records = [];
    this.save();
    this._onDidUpdate.fire();
  }

  /** 汇总今日记录与增删行数 */
  getSummary(): DecisionSummary {
    const now = new Date();
    const todayKey = this.toDayKey(now);
    let today = 0;
    let totalDeleted = 0;
    let totalAdded = 0;

    for (const record of this.records) {
      if (this.toDayKey(new Date(record.timestamp)) === todayKey) {
        today++;
      }
      totalDeleted += record.deletedLines;
      totalAdded += record.addedLines;
    }

    return { today, totalDeleted, totalAdded };
  }

  /** 从磁盘加载 */
  private load(): void {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(this.storagePath)) {
        const data = fs.readFileSync(this.storagePath, 'utf-8');
        this.records = JSON.parse(data);
      }
    } catch (e) {
      this.records = [];
    }
  }

  /** 保存到磁盘 */
  private save(): void {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.storagePath, JSON.stringify(this.records, null, 2), 'utf-8');
    } catch (e) {
      // 静默失败
    }
  }

  private toDayKey(date: Date): string {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
}
