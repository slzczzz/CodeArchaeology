/**
 * 代码考古 · 轻量集成测试
 *
 * 不依赖任何测试框架：用假时钟 + vscode 桩驱动编译产物 out/，
 * 通过真实的保存事件序列验证事件分类、路径排除、配置开关与存储行为。
 *
 * 运行：npm test
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ───────────────────────── 假时钟（固定为周三下午） ─────────────────────────

const RealDate = Date;
let fakeNow = new RealDate('2026-09-30T15:00:00').getTime();

class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) {
      super(fakeNow);
    } else {
      super(...args);
    }
  }
  static now() {
    return fakeNow;
  }
}
global.Date = FakeDate;

function advance(ms) {
  fakeNow += ms;
}

// ───────────────────────── vscode 桩 ─────────────────────────

let configOverrides = {};

const vscodeStub = {
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => (key in configOverrides ? configOverrides[key] : fallback),
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    showInformationMessage() {},
    showWarningMessage() {},
  },
  EventEmitter: class {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
    dispose() {}
  },
  Uri: {
    file: (p) => ({ fsPath: p }),
    joinPath: (a, b) => ({ fsPath: `${a.fsPath}/${b}` }),
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.apply(this, arguments);
};

const outDir = path.join(__dirname, '..', 'out');
const { DecisionTracker } = require(path.join(outDir, 'DecisionTracker'));
const { DecisionStore } = require(path.join(outDir, 'DecisionStore'));

// ───────────────────────── 断言工具 ─────────────────────────

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ───────────────────────── 测试辅助 ─────────────────────────

class FakeStore {
  constructor() {
    this.records = [];
  }
  addRecord(record) {
    this.records.push(record);
  }
  getRecords() {
    return this.records.slice().reverse();
  }
  getCount() {
    return this.records.length;
  }
  deleteRecord(id) {
    this.records = this.records.filter((r) => r.id !== id);
  }
  clear() {
    this.records = [];
  }
}

function makeDoc(fileName, text) {
  return {
    fileName,
    uri: { scheme: 'file' },
    languageId: 'typescript',
    getText: () => text,
  };
}

function save(tracker, fileName, text) {
  tracker.onDidSaveTextDocument(makeDoc(fileName, text));
}

/**
 * 执行一次「两次保存」场景：第一次建立快照，第二次产生差异。
 * 返回第二次保存产生的记录，便于断言事件类型。
 */
function classify(fileName, before, after, config) {
  const restore = configOverrides;
  configOverrides = Object.assign({}, config || {});

  const store = new FakeStore();
  const tracker = new DecisionTracker(store);
  save(tracker, fileName, before);
  store.records.length = 0; // 丢弃开工记录噪声
  save(tracker, fileName, after);

  const result = {
    types: store.records.map((r) => r.actionType),
    records: store.records,
  };

  tracker.dispose();
  configOverrides = restore;
  return result;
}

function hasType(result, type) {
  return result.types.indexOf(type) >= 0;
}

// ───────────────────────── 事件分类 ─────────────────────────

{
  const r = classify(
    '/proj/src/util.ts',
    'function foo() {\n  return 1;\n}\nconst x = 1;',
    'const x = 1;'
  );
  check('删除整个函数 → delete-function', hasType(r, 'delete-function'), r.types.join(','));
}

{
  const r = classify(
    '/proj/src/util.ts',
    "console.log('a');\nconsole.log('b');\nconst x = 1;",
    'const x = 1;'
  );
  check('删除调试代码 → debug-cleanup', hasType(r, 'debug-cleanup'), r.types.join(','));
}

{
  const r = classify(
    '/proj/src/util.ts',
    'const a = 1;',
    'const a = 1;\n// 说明一下\n// 再说明一下'
  );
  check('新增注释 → add-comment', hasType(r, 'add-comment'), r.types.join(','));
}

{
  const r = classify('/proj/src/util.ts', 'const a = 1;\nconst b = 2;', 'const a = 1;');
  check('删除一行 → delete-small', hasType(r, 'delete-small'), r.types.join(','));
  check(
    '删除一行不会误判为加注释',
    !hasType(r, 'add-comment') && !hasType(r, 'add-code'),
    r.types.join(',')
  );
}

{
  const r = classify(
    '/proj/src/util.ts',
    'const a = 1;\nconst b = 2;',
    'const a = 1;\nconst b = 3000;'
  );
  check('小幅改动 → tweak', hasType(r, 'tweak'), r.types.join(','));
}

{
  const r = classify(
    '/proj/src/util.ts',
    'const a = 1;\nconst b = 2;',
    '// const a = 1;\n// const b = 2;'
  );
  check('把代码注释掉 → comment-out-code', hasType(r, 'comment-out-code'), r.types.join(','));
}

{
  const r = classify(
    '/proj/src/util.ts',
    '// const a = 1;\n// const b = 2;',
    'const a = 1;\nconst b = 2;'
  );
  check('取消注释 → uncomment-code', hasType(r, 'uncomment-code'), r.types.join(','));
}

{
  const r = classify('/proj/src/util.ts', 'const a = 1;', 'const a = 1;\n// TODO: 优化这里');
  check('写下 TODO → add-todo', hasType(r, 'add-todo'), r.types.join(','));
}

{
  const r = classify(
    '/proj/src/util.ts',
    "import a from 'a';\nimport b from 'b';\nconst x = 1;",
    "import a from 'a';\nconst x = 1;"
  );
  check('整理 import → import-change', hasType(r, 'import-change'), r.types.join(','));
}

{
  const r = classify('/proj/src/util.ts', 'line1\nline2\nline3', '');
  check('清空文件 → empty-file', hasType(r, 'empty-file'), r.types.join(','));
}

{
  const r = classify(
    '/proj/src/util.ts',
    'const a = get();\nif (!a) {\n  return;\n}\nconst b = 2;',
    'const a = get();\nconst b = 2;'
  );
  check('删除防御性判断 → delete-guard', hasType(r, 'delete-guard'), r.types.join(','));
}

{
  const r = classify(
    '/proj/src/util.ts',
    'try {\n  doWork();\n} catch (e) {\n  logger.error(e);\n}\nconst x = 1;',
    'doWork();\nconst x = 1;'
  );
  check(
    '删除错误处理 → delete-error-handling',
    hasType(r, 'delete-error-handling'),
    r.types.join(',')
  );
}

{
  const r = classify('/proj/src/util.ts', 'const a  =  1;', 'const a = 1;');
  check('仅格式变化 → format-only', hasType(r, 'format-only'), r.types.join(','));
}

{
  const r = classify(
    '/proj/package.json',
    '{\n  "dependencies": {\n    "lodash": "^4.17.21"\n  }\n}',
    '{\n  "dependencies": {\n    "lodash": "^4.17.21",\n    "axios": "^1.6.0"\n  }\n}'
  );
  check('依赖变更 → dependency-change', hasType(r, 'dependency-change'), r.types.join(','));
}

{
  const lines = [];
  for (let i = 1; i <= 12; i++) {
    lines.push(`const v${i} = ${i};`);
  }
  const r = classify('/proj/src/big.ts', `const keep = 1;\n${lines.join('\n')}`, 'const keep = 1;');
  check('大量删除 → delete-bulk', hasType(r, 'delete-bulk'), r.types.join(','));
  check('刷新纪录 → record-break', hasType(r, 'record-break'), r.types.join(','));
}

// ───────────────────────── 路径排除与配置开关 ─────────────────────────

{
  const r = classify('/proj/node_modules/pkg/index.js', 'const a = 1;', 'const a = 2;');
  check('排除 node_modules', r.types.length === 0, r.types.join(','));
}

{
  const r = classify('/proj/dist/bundle.js', 'const a = 1;', 'const a = 2;');
  check('排除 dist', r.types.length === 0, r.types.join(','));
}

{
  const r = classify('/proj/out/extension.js', 'const a = 1;', 'const a = 2;');
  check('排除 out', r.types.length === 0, r.types.join(','));
}

{
  const r = classify('/proj/package-lock.json', 'const a = 1;', 'const a = 2;');
  check('排除锁文件', r.types.length === 0, r.types.join(','));
}

{
  const r = classify(
    '/proj/custom/generated.ts',
    'const a = 1;',
    'const a = 2;',
    { exclude: ['**/custom/**'] }
  );
  check('支持自定义排除 glob', r.types.length === 0, r.types.join(','));
}

{
  const r = classify('/proj/src/util.ts', 'const a = 1;\nconst b = 2;', 'const a = 1;\nconst b = 3;', {
    minChangedLines: 5,
  });
  check('低于最小改动行数不记录', r.types.length === 0, r.types.join(','));
}

{
  const r = classify(
    '/proj/src/util.ts',
    'function foo() {\n  return 1;\n}\nconst x = 1;',
    'const x = 1;',
    { disabledEvents: ['delete-function'] }
  );
  check('禁用事件生效', !hasType(r, 'delete-function'), r.types.join(','));
}

// ───────────────────────── 测试文件与配置文件识别 ─────────────────────────

{
  const tracker = new DecisionTracker(new FakeStore());
  const testFiles = [
    'src/foo.test.ts',
    'src/foo.spec.tsx',
    'src/__tests__/a.ts',
    'tests/unit/thing.ts',
    'src/foo_test.py',
    'FooTest.java',
    'e2e/login.ts',
  ];
  const normalFiles = [
    'src/latest-update.ts',
    'src/inspect.ts',
    'src/contest.ts',
    'src/perspective.ts',
    'src/attestation.ts',
  ];
  check(
    '测试文件识别正确',
    testFiles.every((f) => tracker.isTestFile(f)) && normalFiles.every((f) => !tracker.isTestFile(f))
  );

  const configFiles = ['package.json', '.eslintrc.json', 'vite.config.json', 'deploy.yaml', '.env.local'];
  const normalJson = ['data/users.json', 'logs/output.json'];
  check(
    '配置文件识别正确',
    configFiles.every((f) => tracker.isConfigFile(f)) && normalJson.every((f) => !tracker.isConfigFile(f))
  );
  tracker.dispose();
}

// ───────────────────────── 空手而归 ─────────────────────────

{
  configOverrides = {};
  const store = new FakeStore();
  const tracker = new DecisionTracker(store);
  const doc = makeDoc('/proj/src/foo.ts', 'const a = 1;');

  tracker.onDidOpenTextDocument(doc);
  advance(2 * 60 * 1000);
  tracker.onDidCloseTextDocument(doc);
  check('打开未改动 → empty-handed', store.records.some((r) => r.actionType === 'empty-handed'));

  // 打开后有改动则不应触发
  store.records.length = 0;
  const doc2 = makeDoc('/proj/src/bar.ts', 'const a = 1;');
  tracker.onDidOpenTextDocument(doc2);
  save(tracker, '/proj/src/bar.ts', 'const a = 1;');
  save(tracker, '/proj/src/bar.ts', 'const a = 1;\nconst b = 2;');
  advance(2 * 60 * 1000);
  tracker.onDidCloseTextDocument(doc2);
  check(
    '打开并改动后不触发 empty-handed',
    !store.records.some((r) => r.actionType === 'empty-handed')
  );

  tracker.dispose();
}

// ───────────────────────── 存储层 ─────────────────────────

{
  configOverrides = {};
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-test-'));
  const context = { globalStorageUri: { fsPath: tmpDir }, subscriptions: { push() {} } };
  const storagePath = path.join(tmpDir, 'decisions.json');

  const record = (id, timestamp) => ({
    id,
    timestamp,
    filePath: '/x.ts',
    fileName: 'x.ts',
    actionType: 'general',
    deletedLines: 1,
    addedLines: 1,
    message: 'm',
    contextSnippet: '',
    detailed: true,
  });

  const store = new DecisionStore(context);
  store.addRecord(record('a', Date.now()));
  store.flush();

  const raw = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
  check('存储写入带版本号', raw.version === 2, JSON.stringify(raw).slice(0, 80));
  check('存储写入记录', Array.isArray(raw.records) && raw.records.length === 1);
  check('临时文件已清理', !fs.existsSync(`${storagePath}.tmp`));
  check('单条删除生效', (store.deleteRecord('a'), store.getCount() === 0));
  store.dispose();

  // 旧格式（纯数组）兼容
  fs.writeFileSync(storagePath, JSON.stringify([record('legacy', Date.now())]), 'utf-8');
  const legacy = new DecisionStore(context);
  check('兼容旧数组格式', legacy.getCount() === 1 && legacy.getRecords()[0].id === 'legacy');
  legacy.dispose();

  // 按保留天数裁剪
  fs.writeFileSync(
    storagePath,
    JSON.stringify({
      version: 2,
      records: [record('old', Date.now() - 40 * 24 * 3600 * 1000), record('new', Date.now())],
    }),
    'utf-8'
  );
  configOverrides = { retentionDays: 30 };
  const pruned = new DecisionStore(context);
  check(
    '按保留天数裁剪',
    pruned.getCount() === 1 && pruned.getRecords()[0].id === 'new',
    `count=${pruned.getCount()}`
  );
  pruned.dispose();
  configOverrides = {};

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ───────────────────────── 结果汇总 ─────────────────────────

const total = passed + failures.length;
if (failures.length > 0) {
  console.log(`\n✗ ${failures.length} / ${total} 个断言失败\n`);
  for (const failure of failures) {
    console.log(`  ✗ ${failure}`);
  }
  console.log('');
  process.exit(1);
}

console.log(`\n✓ 全部通过：${passed} / ${total} 个断言\n`);
