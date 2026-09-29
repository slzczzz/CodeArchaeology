import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DecisionRecord, DecisionSummary } from './types';

/** 存储文件结构版本号，便于将来迁移 */
const STORAGE_VERSION = 2;

/** 磁盘上的存储结构 */
export interface StorageFile {
  version: number;
  records: DecisionRecord[];
}

/** 决策存储：将决策记录持久化到本地 JSON 文件 */
export class DecisionStore implements vscode.Disposable {
  private records: DecisionRecord[] = [];
  private storagePath: string;
  private maxRecords: number;
  private retentionDays: number;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private _onDidUpdate = new vscode.EventEmitter<void>();
  readonly onDidUpdate: vscode.Event<void> = this._onDidUpdate.event;

  constructor(context: vscode.ExtensionContext) {
    this.storagePath = path.join(context.globalStorageUri.fsPath, 'decisions.json');
    const config = vscode.workspace.getConfiguration('decisionArchaeologist');
    this.maxRecords = config.get('maxRecords', 1000);
    this.retentionDays = config.get('retentionDays', 0);
    this.load();

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('decisionArchaeologist.maxRecords')) {
          this.maxRecords = vscode.workspace.getConfiguration('decisionArchaeologist').get('maxRecords', 1000);
          this.prune();
        }
        if (e.affectsConfiguration('decisionArchaeologist.retentionDays')) {
          this.retentionDays = vscode.workspace.getConfiguration('decisionArchaeologist').get('retentionDays', 0);
          this.prune();
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

    this.scheduleSave();
    this._onDidUpdate.fire();
  }

  /** 删除指定 id 的记录 */
  deleteRecord(id: string): void {
    const before = this.records.length;
    this.records = this.records.filter(r => r.id !== id);
    if (this.records.length !== before) {
      this.scheduleSave();
      this._onDidUpdate.fire();
    }
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
    this.scheduleSave();
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
      if (!fs.existsSync(this.storagePath)) {
        return;
      }
      const data = fs.readFileSync(this.storagePath, 'utf-8');
      this.records = this.parseRecords(JSON.parse(data));
      this.pruneQuiet();
    } catch (e) {
      this.records = [];
    }
  }

  /** 兼容旧格式（纯数组）与新格式（带版本号的对象） */
  private parseRecords(parsed: unknown): DecisionRecord[] {
    if (Array.isArray(parsed)) {
      return parsed as DecisionRecord[];
    }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as StorageFile).records)) {
      return (parsed as StorageFile).records;
    }
    return [];
  }

  /** 加载阶段的静默裁剪，不触发保存与事件 */
  private pruneQuiet(): void {
    if (this.retentionDays > 0) {
      const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
      this.records = this.records.filter(r => r.timestamp >= cutoff);
    }
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }

  /** 按保留天数 / 最大条数裁剪，变化时持久化 */
  private prune(): void {
    const before = this.records.length;
    this.pruneQuiet();
    if (this.records.length !== before) {
      this.scheduleSave();
      this._onDidUpdate.fire();
    }
  }

  /** 防抖保存：合并短时间内的多次写入 */
  private scheduleSave(): void {
    if (this.disposed) {
      return;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, 400);
  }

  /** 立即写盘（用于扩展停用前） */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (!this.disposed) {
      this.save();
    }
  }

  /** 保存到磁盘：先写临时文件再原子替换，避免中断导致文件损坏 */
  private save(): void {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const payload: StorageFile = { version: STORAGE_VERSION, records: this.records };
      const tmpPath = `${this.storagePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.storagePath);
    } catch (e) {
      // 静默失败
    }
  }

  /** 释放资源 */
  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (!this.disposed) {
      this.save();
    }
    this.disposed = true;
    this._onDidUpdate.dispose();
  }

  private toDayKey(date: Date): string {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
}
