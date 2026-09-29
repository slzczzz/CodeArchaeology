import * as vscode from 'vscode';

/** 运行时配置快照 */
export interface TrackerConfig {
  /** 评语风格 */
  toneStyle: string;
  /** 最大保留记录数 */
  maxRecords: number;
  /** 单次改动的最小总行数（低于该值不记录） */
  minChangedLines: number;
  /** 记录保留天数，0 表示不限制 */
  retentionDays: number;
  /** 需要忽略的路径 glob */
  excludeGlobs: string[];
  /** 被禁用的事件类型 */
  disabledEvents: string[];
}

/** 默认排除的目录与文件（构建产物、依赖、锁文件等） */
export const DEFAULT_EXCLUDE_GLOBS: string[] = [
  '**/node_modules/**',
  '**/bower_components/**',
  '**/out/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/target/**',
  '**/vendor/**',
  '**/.venv/**',
  '**/venv/**',
  '**/env/**',
  '**/__pycache__/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.cache/**',
  '**/.idea/**',
  '**/.vscode-test/**',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/composer.lock',
  '**/Cargo.lock',
];

const CONFIG_SECTION = 'decisionArchaeologist';

/** 读取一次完整配置 */
export function readConfig(): TrackerConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const exclude = config.get<string[]>('exclude', DEFAULT_EXCLUDE_GLOBS);
  const disabled = config.get<string[]>('disabledEvents', []);
  return {
    toneStyle: config.get<string>('toneStyle', 'balanced') || 'balanced',
    maxRecords: config.get<number>('maxRecords', 1000),
    minChangedLines: config.get<number>('minChangedLines', 1),
    retentionDays: config.get<number>('retentionDays', 0),
    excludeGlobs: Array.isArray(exclude) ? exclude : DEFAULT_EXCLUDE_GLOBS,
    disabledEvents: Array.isArray(disabled) ? disabled : [],
  };
}

const regExpCache = new Map<string, RegExp>();

/**
 * 将 glob 转换为正则。
 * 支持 `**`、`*`、`?` 与 `{a,b}` 花括号展开。
 */
export function globToRegExp(glob: string): RegExp {
  const cached = regExpCache.get(glob);
  if (cached) {
    return cached;
  }

  const normalized = glob.replace(/\\/g, '/');
  let source = '';
  let i = 0;

  while (i < normalized.length) {
    const char = normalized[i];

    if (char === '*') {
      if (normalized[i + 1] === '*') {
        // `**/` 匹配任意层级目录（含零层）
        if (normalized[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 3;
          continue;
        }
        source += '.*';
        i += 2;
        continue;
      }
      source += '[^/]*';
      i += 1;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      i += 1;
      continue;
    }

    if (char === '{') {
      const close = normalized.indexOf('}', i);
      if (close > -1) {
        const parts = normalized
          .slice(i + 1, close)
          .split(',')
          .map((part) => escapeRegExp(part));
        source += `(?:${parts.join('|')})`;
        i = close + 1;
        continue;
      }
    }

    source += escapeRegExp(char);
    i += 1;
  }

  const regExp = new RegExp(`^${source}$`);
  regExpCache.set(glob, regExp);
  return regExp;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 判断路径是否命中任意一个 glob */
export function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  if (!globs || globs.length === 0) {
    return false;
  }
  const normalized = filePath.replace(/\\/g, '/');
  return globs.some((glob) => {
    try {
      return globToRegExp(glob).test(normalized);
    } catch {
      return false;
    }
  });
}

/** 判断路径是否应被忽略 */
export function isExcluded(filePath: string, config: TrackerConfig): boolean {
  if (filePath.replace(/\\/g, '/').includes('/.git/')) {
    return true;
  }
  return matchesAnyGlob(filePath, config.excludeGlobs);
}

/** 获取配置变更监听 */
export function onConfigChanged(listener: (config: TrackerConfig) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(CONFIG_SECTION)) {
      listener(readConfig());
    }
  });
}
