/**
 * server/scanner.js — 工作区项目发现 / 子项目下钻 / 文档发现 / README 摘要 / 更新时间 / 技术标签
 *
 * 只读模块：只读取目录名、文件 mtime、README、package.json 与 git 元信息，
 * 绝不写入被扫描的项目目录。
 *
 * 导出：
 *   scanWorkspace(options) -> { projects, stats }
 *   summarizeReadme(raw)   -> { title, summary }
 *   slugify(name)          -> string
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(APP_DIR, 'config.json');

/** 没有可读文档时的固定兜底文案（与契约一致）。 */
export const FALLBACK_SUMMARY = '这个目录还没有 README，暂时无法读取用途概要。';

/** 视觉色板 token。 */
export const ACCENTS = ['lime', 'sky', 'amber', 'violet', 'rose', 'teal'];

/** 源码扩展名（契约列表 + 常见补充）。 */
const SOURCE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.sh', '.bash', '.html', '.htm',
  '.gd', '.swift', '.java', '.kt', '.rs', '.go', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.cs', '.rb', '.php', '.lua', '.vue', '.svelte', '.scala', '.sbt', '.dart', '.mm'
]);

/** 可执行脚本类扩展名（.html 不算脚本）。 */
const SCRIPT_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.sh', '.bash', '.gd', '.swift',
  '.java', '.kt', '.rs', '.go', '.c', '.cc', '.cpp', '.cs', '.rb', '.php', '.lua',
  '.pl', '.scala', '.sbt', '.dart', '.mm', '.ex', '.exs'
]);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.psd', '.avif', '.bmp', '.tiff', '.ico', '.heic']);

/** 任何层级都跳过的重目录（另：所有以 . 开头的目录默认跳过）。 */
const DEFAULT_SKIP_DIRS = [
  'node_modules', 'dist', 'build', 'coverage', 'target', 'vendor', 'Pods',
  'DerivedData', 'bower_components', '__pycache__', 'venv', 'site-packages'
];

/** 默认配置（config.json 会覆盖同名项）。 */
export const DEFAULT_CONFIG = {
  // 顶层目录名 -> 排除原因；也可写成字符串数组（统一原因：配置排除）
  excludeDirs: {},
  // 强制收录的顶层目录名（优先级高于 excludeDirs 与隐藏规则）
  includeDirs: [],
  skipDirs: DEFAULT_SKIP_DIRS,
  maxDepth: 5,
  concurrency: 6,
  readmeMaxBytes: 64 * 1024,
  packageJsonMaxBytes: 256 * 1024,
  gitTimeoutMs: 5000,
  // 子项目下钻：相对顶层项目根的最大深度 / 每父上限 / 全工作区上限
  children: {
    maxDepth: 2,
    maxPerParent: 12,
    maxTotal: 60
  }
};

const MANIFEST_FILES = {
  packageJson: ['package.json'],
  godot: ['project.godot'],
  requirements: ['requirements.txt'],
  pyproject: ['pyproject.toml', 'Pipfile'],
  indexHtml: ['index.html'],
  makefile: ['Makefile', 'makefile', 'GNUmakefile'],
  startSh: ['start.sh'],
  runSh: ['run.sh'],
  cmake: ['CMakeLists.txt'],
  gradle: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']
};

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 稳定哈希（FNV-1a 32bit），用于 accent 等“按名字固定”的取值。 */
export function hashString(input) {
  const str = String(input == null ? '' : input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 目录名 / 项目名 / 相对路径 -> URL 安全且稳定的 id 片段。 */
export function slugify(name) {
  const base = String(name == null ? '' : name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/['"\u2018\u2019\u201c\u201d]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'project';
}

function accentFor(id) {
  return ACCENTS[hashString(id) % ACCENTS.length];
}

function prettifyName(name) {
  const value = String(name == null ? '' : name)
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value || String(name == null ? '' : name);
}

function toIso(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

async function readTextFile(file, maxBytes) {
  let handle = null;
  try {
    handle = await fsp.open(file, 'r');
    const buffer = Buffer.alloc(Math.max(1, Math.min(maxBytes, 4 * 1024 * 1024)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }
}

async function readJsonFile(file, maxBytes) {
  const raw = await readTextFile(file, maxBytes);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function runGit(args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || ''));
    });
  });
}

/** 并发受限的 map（并发上限默认 6）。 */
async function mapPool(items, limit, worker) {
  const size = Math.max(1, Math.min(Number(limit) || 6, items.length || 1));
  let cursor = 0;
  const runners = new Array(size).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

let cachedFileConfig = null;

async function loadFileConfig() {
  if (cachedFileConfig) return cachedFileConfig;
  const raw = await readTextFile(CONFIG_PATH, 128 * 1024);
  let parsed = {};
  if (raw) {
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value;
    } catch {
      parsed = {};
    }
  }
  cachedFileConfig = parsed;
  return cachedFileConfig;
}

function normalizeExcludeDirs(input) {
  const result = {};
  if (!input) return result;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string' && item.trim()) result[item.trim()] = '配置排除（config.json）';
    }
    return result;
  }
  if (typeof input === 'object') {
    for (const [dir, reason] of Object.entries(input)) {
      if (!dir) continue;
      result[dir] = typeof reason === 'string' && reason.trim() ? reason.trim() : '配置排除（config.json）';
    }
  }
  return result;
}

function normalizeChildrenConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const pick = (value, fallback, min, max) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(num)));
  };
  return {
    maxDepth: pick(source.maxDepth, DEFAULT_CONFIG.children.maxDepth, 1, 3),
    maxPerParent: pick(source.maxPerParent, DEFAULT_CONFIG.children.maxPerParent, 1, 50),
    maxTotal: pick(source.maxTotal, DEFAULT_CONFIG.children.maxTotal, 0, 500)
  };
}

function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const skipDirs = new Set(DEFAULT_SKIP_DIRS);
  if (Array.isArray(input.skipDirs)) {
    for (const name of input.skipDirs) {
      if (typeof name === 'string' && name.trim()) skipDirs.add(name.trim());
    }
  }
  const includeDirs = Array.isArray(input.includeDirs)
    ? input.includeDirs.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];
  return {
    excludeDirs: normalizeExcludeDirs(input.excludeDirs || input.exclude),
    includeDirs,
    skipDirs,
    maxDepth: Number.isFinite(Number(input.maxDepth)) ? Math.max(0, Math.min(Number(input.maxDepth), 12)) : DEFAULT_CONFIG.maxDepth,
    concurrency: Number.isFinite(Number(input.concurrency)) ? Math.max(1, Math.min(Number(input.concurrency), 16)) : DEFAULT_CONFIG.concurrency,
    readmeMaxBytes: Number.isFinite(Number(input.readmeMaxBytes)) ? Number(input.readmeMaxBytes) : DEFAULT_CONFIG.readmeMaxBytes,
    packageJsonMaxBytes: Number.isFinite(Number(input.packageJsonMaxBytes)) ? Number(input.packageJsonMaxBytes) : DEFAULT_CONFIG.packageJsonMaxBytes,
    gitTimeoutMs: Number.isFinite(Number(input.gitTimeoutMs)) ? Number(input.gitTimeoutMs) : DEFAULT_CONFIG.gitTimeoutMs,
    children: normalizeChildrenConfig(input.children)
  };
}

// ---------------------------------------------------------------------------
// README / 文档摘要
// ---------------------------------------------------------------------------

const HEADING_H1_RE = /^\s{0,3}#\s+(.+?)\s*#*\s*$/;
const HEADING_ANY_RE = /^\s{0,3}#{1,6}\s/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_RE = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/;
const TABLE_RE = /^\s*\|/;
const QUOTE_RE = /^\s*>/;
const HTML_LINE_RE = /^\s*<\/?[a-zA-Z][^>]*>/;
const IMAGE_LINE_RE = /^\s*!\[/;
const BADGE_LINE_RE = /^\s*\[!\[/;
const LINKREF_RE = /^\s*\[[^\]]+\]:\s*\S+/;
const INDENTED_CODE_RE = /^(?: {4,}|\t)/;
const FENCE_RE = /^(\x60{3,}|~{3,})/;
const INLINE_CODE_RE = new RegExp('\x60+([^\x60]*)\x60+', 'g');
const ESCAPE_RE = /\\([\\\x60*_{}\[\]()#+\-.!|>])/g;

function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–');
}

/** 清洗行内 markdown，得到纯文本。 */
function cleanInline(input) {
  let text = String(input == null ? '' : input);
  // 徽章 / 图片（先处理嵌套徽章，再处理普通图片）
  text = text.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(/!\[[^\]]*\]\[[^\]]*\]/g, ' ');
  // 链接
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  // HTML 标签 / 注释
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<[^>]*>/g, ' ');
  // 行内代码
  text = text.replace(INLINE_CODE_RE, '$1');
  // 强调 / 删除线
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(.*?)\1/g, '$2');
  text = text.replace(/~~(.*?)~~/g, '$1');
  // 转义字符
  text = text.replace(ESCAPE_RE, '$1');
  text = decodeEntities(text);
  return text.replace(/\s+/g, ' ').trim();
}

/** 摘要截断：最多 max 个字符，尽量不截断在半个标点/空格上。 */
function truncateSummary(text, max = 220) {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  let cut = value.slice(0, max - 1);
  cut = cut.replace(/[\s，、；：,;:·—–-]+$/u, '');
  if (!cut) cut = value.slice(0, max - 1);
  return cut + '…';
}

/**
 * 从文档原文提取标题与第一段有效摘要。
 * - title：文档中第一个 H1（跳过代码块内的注释行）
 * - summary：第一段有效正文，去除徽章/图片/HTML/代码块/标题/列表标记后 <= 220 字
 */
export function summarizeReadme(raw) {
  const text = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized.trim()) return { title: null, summary: FALLBACK_SUMMARY };

  const lines = normalized.split('\n');

  // 跳过 YAML front matter（文件首行的 --- 到下一个 ---/...）
  let start = 0;
  if (lines.length > 0 && lines[0].trim() === '---') {
    for (let i = 1; i < Math.min(lines.length, 80); i += 1) {
      const value = lines[i].trim();
      if (value === '---' || value === '...') {
        start = i + 1;
        break;
      }
    }
  }

  let title = null;
  let inFence = false;
  let fenceChar = '';
  const blocks = [];

  for (let i = start; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // 代码块围栏开关（三个反引号或三个波浪号）
    const fenceMatch = trimmed.match(FENCE_RE);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = marker;
        blocks.push({ blank: true });
      } else if (marker === fenceChar) {
        inFence = false;
        fenceChar = '';
        blocks.push({ blank: true });
      }
      continue;
    }
    if (inFence) continue;

    if (!trimmed) {
      blocks.push({ blank: true });
      continue;
    }

    if (title === null) {
      const headingMatch = rawLine.match(HEADING_H1_RE);
      if (headingMatch) {
        const cleaned = cleanInline(headingMatch[1]);
        if (cleaned) title = cleaned.slice(0, 160);
      }
    }

    // 结构性行：打断段落，不进入正文
    if (
      HEADING_ANY_RE.test(rawLine) ||
      HR_RE.test(trimmed) ||
      LIST_RE.test(rawLine) ||
      TABLE_RE.test(rawLine) ||
      QUOTE_RE.test(rawLine) ||
      INDENTED_CODE_RE.test(rawLine)
    ) {
      blocks.push({ blank: true });
      continue;
    }

    // 徽章 / 图片 / HTML / 链接定义：跳过但不断段
    if (
      IMAGE_LINE_RE.test(trimmed) ||
      BADGE_LINE_RE.test(trimmed) ||
      HTML_LINE_RE.test(trimmed) ||
      LINKREF_RE.test(trimmed)
    ) {
      continue;
    }

    blocks.push({ text: trimmed });
  }

  let paragraph = [];
  const flush = () => {
    if (!paragraph.length) return '';
    const cleaned = cleanInline(paragraph.join(' '));
    paragraph = [];
    return cleaned.length >= 2 ? cleaned : '';
  };

  for (const block of blocks) {
    if (block.blank) {
      const summary = flush();
      if (summary) return { title, summary: truncateSummary(summary) };
    } else if (block.text) {
      paragraph.push(block.text);
    }
  }
  const tail = flush();
  if (tail) return { title, summary: truncateSummary(tail) };

  return { title, summary: FALLBACK_SUMMARY };
}

// ---------------------------------------------------------------------------
// 文档发现（README 优先，其次根目录其他 *.md，再其次 docs/**/*.md 前 3 个）
// ---------------------------------------------------------------------------

const MD_RE = /\.md$/i;
const README_STRICT_RE = /^readme\.(md|markdown|txt)$/i;
const README_LOOSE_RE = /^readme[^/]*\.(md|markdown|txt)$/i;
/** 低相关度文档：不作为用途摘要来源 */
const LOW_RELEVANCE_DOC_RE = /^(license|licence|copying|changelog|changes|history|contributing|code[_-]?of[_-]?conduct|security|authors|maintainers|notice|todo)\b/i;
/** 文档文件名关键词权重：命中越多越像“项目说明” */
const DOC_KEYWORDS = [
  ['instructions', 10], ['channels', 10], ['about', 9], ['overview', 9], ['introduction', 9],
  ['intro', 8], ['description', 8], ['project', 7], ['usage', 8], ['guide', 8],
  ['quickstart', 8], ['getting-started', 8], ['getting_started', 8], ['setup', 7],
  ['install', 7], ['development', 8], ['architecture', 8], ['design', 6], ['api', 5],
  ['documentation', 8], ['docs', 6], ['summary', 6], ['notes', 3], ['report', 3], ['spec', 3],
  ['说明', 9], ['介绍', 9], ['概述', 9], ['使用', 8], ['指南', 8], ['架构', 8],
  ['设计', 6], ['开发', 7], ['报告', 4], ['总结', 5]
];

function scoreDocName(name) {
  const base = String(name || '').toLowerCase().replace(MD_RE, '');
  if (LOW_RELEVANCE_DOC_RE.test(base)) return -100;
  let score = 0;
  for (const [keyword, weight] of DOC_KEYWORDS) {
    if (base.includes(keyword)) score += weight;
  }
  return score;
}

function pickReadmeName(entries) {
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const rank = (name) => {
    const lower = name.toLowerCase();
    if (lower === 'readme.md') return 0;
    if (lower === 'readme.markdown') return 1;
    if (lower === 'readme.txt') return 2;
    return 3;
  };
  const strict = files.filter((name) => README_STRICT_RE.test(name));
  if (strict.length > 0) {
    strict.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return strict[0];
  }
  const loose = files.filter((name) => README_LOOSE_RE.test(name));
  if (loose.length > 0) {
    loose.sort((a, b) => a.localeCompare(b));
    return loose[0];
  }
  return null;
}

/** docs 目录下（递归，深度 <= 4）的 *.md，按路径排序取前 limit 个。 */
async function listDocsDirCandidates(abs, config, limit) {
  const docsDir = path.join(abs, 'docs');
  const found = [];
  async function walk(dir, rel, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || config.skipDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const relPath = rel + '/' + entry.name;
      if (entry.isDirectory()) {
        await walk(full, relPath, depth + 1);
      } else if (entry.isFile() && MD_RE.test(entry.name)) {
        found.push(relPath);
      }
    }
  }
  await walk(docsDir, 'docs', 0);
  found.sort((a, b) => a.localeCompare(b));
  return found.slice(0, Math.max(0, limit));
}

/**
 * 文档发现：README* 优先；没有 README 时取根目录其他 *.md（按文件名相关度排序）
 * 以及 docs 目录下的 *.md 前 3 个。返回第一个能提取出有效摘要的文档。
 */
async function discoverDocument(abs, entries, config) {
  const readmeName = pickReadmeName(entries);
  if (readmeName) {
    const raw = await readTextFile(path.join(abs, readmeName), config.readmeMaxBytes);
    const info = summarizeReadme(raw);
    const usable = info.summary !== FALLBACK_SUMMARY;
    return {
      readmePath: readmeName,
      readmeTitle: info.title,
      summary: info.summary,
      summarySource: usable ? 'readme' : 'fallback',
      isReadme: true
    };
  }

  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const rootDocs = files
    .filter((name) => MD_RE.test(name) && !/^readme/i.test(name))
    .map((name) => ({ name, score: scoreDocName(name) }))
    .filter((item) => item.score > -100)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 6)
    .map((item) => item.name);

  const candidates = rootDocs.concat(await listDocsDirCandidates(abs, config, 3));
  for (const relPath of candidates) {
    const raw = await readTextFile(path.join(abs, relPath), config.readmeMaxBytes);
    const info = summarizeReadme(raw);
    if (info.summary !== FALLBACK_SUMMARY) {
      return {
        readmePath: relPath,
        readmeTitle: info.title,
        summary: info.summary,
        summarySource: 'readme',
        isReadme: false
      };
    }
  }

  return {
    readmePath: null,
    readmeTitle: null,
    summary: FALLBACK_SUMMARY,
    summarySource: 'fallback',
    isReadme: false
  };
}

// ---------------------------------------------------------------------------
// 项目文件遍历与统计
// ---------------------------------------------------------------------------

function summarizeDirEntries(rel, entries) {
  const markers = {
    packageJson: false,
    projectGodot: false,
    startSh: false,
    runSh: false,
    serverPy: false,
    appPy: false,
    mainPy: false,
    readmeMd: false,
    requirements: false,
    pyproject: false
  };
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name === 'package.json') markers.packageJson = true;
    else if (name === 'project.godot') markers.projectGodot = true;
    else if (name === 'start.sh') markers.startSh = true;
    else if (name === 'run.sh') markers.runSh = true;
    else if (name === 'server.py') markers.serverPy = true;
    else if (name === 'app.py') markers.appPy = true;
    else if (name === 'main.py') markers.mainPy = true;
    else if (/^readme\.md$/i.test(name)) markers.readmeMd = true;
    else if (name === 'requirements.txt') markers.requirements = true;
    else if (name === 'pyproject.toml') markers.pyproject = true;
  }
  return {
    rel,
    name: path.basename(rel),
    depth: rel.split('/').length,
    markers
  };
}

async function collectFacts(dir, config, options = {}) {
  const wantDirIndex = options.dirIndex === true;
  const facts = {
    fileCount: 0,
    sizeBytes: 0,
    maxMtime: 0,
    minMtime: 0,
    extCounts: Object.create(null),
    srcCount: 0,
    scriptCount: 0,
    imageCount: 0,
    mdCount: 0,
    dirIndex: new Map()
  };
  const stack = [{ dir, depth: 0, rel: '' }];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // 记录深度 1-2 的目录入口信息，供子项目下钻使用（不额外做 I/O）
    if (wantDirIndex && current.depth >= 1 && current.depth <= config.children.maxDepth) {
      facts.dirIndex.set(current.rel, summarizeDirEntries(current.rel, entries));
    }
    for (const entry of entries) {
      const name = entry.name;
      // 隐藏文件/目录一律跳过（.git / .venv / .next / .DS_Store ...）
      if (name.startsWith('.')) continue;
      const full = path.join(current.dir, name);
      if (entry.isDirectory()) {
        if (current.depth + 1 > config.maxDepth) continue;
        if (config.skipDirs.has(name)) continue;
        stack.push({ dir: full, depth: current.depth + 1, rel: current.rel ? current.rel + '/' + name : name });
        continue;
      }
      if (!entry.isFile()) continue; // 符号链接 / 设备文件不统计
      let stat;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      facts.fileCount += 1;
      facts.sizeBytes += stat.size;
      if (stat.mtimeMs > facts.maxMtime) facts.maxMtime = stat.mtimeMs;
      if (!facts.minMtime || stat.mtimeMs < facts.minMtime) facts.minMtime = stat.mtimeMs;
      const ext = path.extname(name).toLowerCase();
      if (ext) {
        facts.extCounts[ext] = (facts.extCounts[ext] || 0) + 1;
        if (SOURCE_EXTS.has(ext)) facts.srcCount += 1;
        if (SCRIPT_EXTS.has(ext)) facts.scriptCount += 1;
        if (IMAGE_EXTS.has(ext)) facts.imageCount += 1;
        if (ext === '.md' || ext === '.markdown') facts.mdCount += 1;
      }
    }
  }
  return facts;
}

function detectManifests(entries) {
  const files = new Set();
  const dirs = new Set();
  for (const entry of entries) {
    if (entry.isDirectory()) dirs.add(entry.name);
    else if (entry.isFile()) files.add(entry.name);
  }
  const found = {
    packageJson: false,
    godot: false,
    requirements: false,
    pyproject: false,
    indexHtml: false,
    makefile: false,
    startSh: false,
    runSh: false,
    cmake: false,
    gradle: false,
    xcode: null,
    sln: null
  };
  for (const name of MANIFEST_FILES.packageJson) if (files.has(name)) found.packageJson = true;
  for (const name of MANIFEST_FILES.godot) if (files.has(name)) found.godot = true;
  for (const name of MANIFEST_FILES.requirements) if (files.has(name)) found.requirements = true;
  for (const name of MANIFEST_FILES.pyproject) if (files.has(name)) found.pyproject = true;
  for (const name of MANIFEST_FILES.indexHtml) if (files.has(name)) found.indexHtml = true;
  for (const name of MANIFEST_FILES.makefile) if (files.has(name)) found.makefile = true;
  for (const name of MANIFEST_FILES.startSh) if (files.has(name)) found.startSh = true;
  for (const name of MANIFEST_FILES.runSh) if (files.has(name)) found.runSh = true;
  for (const name of MANIFEST_FILES.cmake) if (files.has(name)) found.cmake = true;
  for (const name of MANIFEST_FILES.gradle) if (files.has(name)) found.gradle = true;
  for (const name of dirs) {
    if (/\.xcodeproj$/.test(name) || /\.xcworkspace$/.test(name)) {
      found.xcode = name;
      break;
    }
  }
  for (const name of files) {
    if (/\.sln$/.test(name)) {
      found.sln = name;
      break;
    }
  }
  return found;
}

async function readGitInfo(dir, hasGitDir, timeoutMs) {
  if (!hasGitDir) return { isRepo: false };
  try {
    const branchRaw = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir, timeoutMs);
    const branch = branchRaw.trim() || null;
    let lastCommitAt = null;
    let lastCommitSubject = null;
    try {
      const logRaw = await runGit(['log', '-1', '--format=%ct%n%s'], dir, timeoutMs);
      const logLines = logRaw.split('\n');
      const seconds = Number(String(logLines[0] || '').trim());
      if (Number.isFinite(seconds) && seconds > 0) lastCommitAt = new Date(seconds * 1000).toISOString();
      const subject = logLines.slice(1).join(' ').trim();
      if (subject) lastCommitSubject = subject.slice(0, 200);
    } catch {
      // 空仓库 / 无提交：保留 isRepo，提交信息为 null
    }
    return { isRepo: true, branch, lastCommitAt, lastCommitSubject };
  } catch {
    // 契约：git 读取失败静默降级
    return { isRepo: false };
  }
}

function detectPackageManager(rootFiles) {
  if (rootFiles.has('pnpm-lock.yaml')) return 'pnpm';
  if (rootFiles.has('yarn.lock')) return 'yarn';
  if (rootFiles.has('bun.lockb') || rootFiles.has('bun.lock')) return 'bun';
  return 'npm';
}

function deriveRunHint({ manifests, pkg, rootFiles }) {
  if (pkg && pkg.scripts && typeof pkg.scripts === 'object') {
    for (const scriptName of ['dev', 'start', 'serve', 'preview']) {
      const command = pkg.scripts[scriptName];
      if (typeof command === 'string' && command.trim()) {
        const manager = detectPackageManager(rootFiles);
        return { runnable: true, runKind: 'command', runHint: manager + ' run ' + scriptName };
      }
    }
  }
  if (manifests.startSh) return { runnable: true, runKind: 'command', runHint: './start.sh' };
  if (manifests.runSh) return { runnable: true, runKind: 'command', runHint: './run.sh' };
  if (manifests.indexHtml) return { runnable: true, runKind: 'static', runHint: '静态页面预览' };
  if (manifests.godot) return { runnable: true, runKind: 'open', runHint: 'Godot 项目' };
  for (const entry of ['server.py', 'app.py', 'main.py']) {
    if (rootFiles.has(entry)) return { runnable: true, runKind: 'command', runHint: 'python3 ' + entry };
  }
  if (manifests.xcode) return { runnable: true, runKind: 'open', runHint: 'Xcode 项目' };
  return { runnable: false, runKind: 'none', runHint: '未检测到运行入口' };
}

function deriveKind({ facts, manifests, pkg }) {
  if (pkg) return 'node';
  if (manifests.godot) return 'godot';
  if (manifests.xcode) return 'xcode';
  if (manifests.gradle) return 'gradle';
  if (manifests.requirements || manifests.pyproject) return 'python';
  if (manifests.indexHtml) return 'static';

  const ext = facts.extCounts;
  const py = ext['.py'] || 0;
  const js = (ext['.js'] || 0) + (ext['.mjs'] || 0) + (ext['.cjs'] || 0) + (ext['.jsx'] || 0) + (ext['.ts'] || 0) + (ext['.tsx'] || 0);
  const html = ext['.html'] || 0;
  const go = ext['.go'] || 0;
  const jvm = (ext['.scala'] || 0) + (ext['.java'] || 0) + (ext['.kt'] || 0);
  const rust = ext['.rs'] || 0;

  // 素材目录（几乎只有图片 + 极少量脚本；超大图片工作区直接视为素材）
  if (facts.imageCount >= 5000) return 'assets';
  if (facts.imageCount >= 100 && facts.scriptCount <= 3) return 'assets';
  if (go >= 10 || jvm >= 10 || rust >= 10) return 'unknown';
  if (py >= 2 && py >= js) return 'python';
  if (js >= 2) return 'node';
  if (html >= 1) return 'static';
  if (facts.srcCount === 0 && facts.mdCount > 0) return 'docs';
  if (facts.srcCount === 0 && facts.imageCount > 0) return 'assets';
  if (py >= 1) return 'python';
  if (js >= 1) return 'node';
  return 'unknown';
}

function deriveTags({ facts, manifests, pkg, git }) {
  const tags = [];
  const add = (tag) => {
    if (tag && !tags.includes(tag) && tags.length < 4) tags.push(tag);
  };
  const ext = facts.extCounts;
  const deps = pkg
    ? Object.keys(Object.assign({}, pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies))
    : [];

  if (pkg) add('Node');
  if (deps.includes('three')) add('Three.js');
  if (deps.includes('react') || deps.includes('react-dom')) add('React');
  if (deps.includes('vue')) add('Vue');
  if (deps.includes('next')) add('Next.js');
  if (deps.includes('vite')) add('Vite');
  if (deps.includes('express')) add('Express');
  if (deps.includes('electron')) add('Electron');
  if (deps.includes('typescript') || (ext['.ts'] || 0) + (ext['.tsx'] || 0) >= 3) add('TypeScript');
  if (manifests.godot) add('Godot');
  if (manifests.xcode) add('Xcode');
  if ((ext['.swift'] || 0) > 0) add('Swift');
  if (manifests.gradle) add('Android');
  if ((ext['.go'] || 0) >= 5) add('Go');
  if ((ext['.scala'] || 0) >= 5) add('Scala');
  if ((ext['.rs'] || 0) >= 5) add('Rust');
  if ((ext['.java'] || 0) >= 5) add('Java');
  if (manifests.requirements || manifests.pyproject || (ext['.py'] || 0) >= 2) add('Python');
  if ((ext['.html'] || 0) > 0) add('HTML');
  if ((ext['.css'] || 0) >= 3) add('CSS');
  if ((ext['.js'] || 0) + (ext['.mjs'] || 0) + (ext['.jsx'] || 0) >= 5) add('JavaScript');
  if (facts.imageCount >= 20) add('Assets');
  if (git.isRepo) add('Git');
  if ((ext['.sh'] || 0) > 0) add('Shell');
  if (tags.length === 0 && facts.mdCount > 0) add('Docs');
  return tags;
}

function deriveName({ dir, relPath, readmeTitle, pkg }) {
  if (readmeTitle) return readmeTitle.slice(0, 160);
  if (pkg && typeof pkg.name === 'string' && pkg.name.trim()) {
    return prettifyName(pkg.name).slice(0, 160);
  }
  if (relPath) return prettifyName(String(relPath).replace(/\//g, ' ')).slice(0, 160);
  return prettifyName(dir).slice(0, 160);
}

// ---------------------------------------------------------------------------
// 子项目下钻
// ---------------------------------------------------------------------------

function hasCompanionDoc(markers) {
  return Boolean(markers.readmeMd || markers.packageJson || markers.requirements || markers.pyproject);
}

/** 强运行入口判定：命中任一才算「可独立运行的项目根」。 */
async function strongChildEntry(abs, dirInfo, config) {
  const markers = dirInfo.markers;
  if (markers.projectGodot) return 'project.godot';
  if (dirInfo.name.endsWith('.xcodeproj')) return 'xcodeproj';
  const companion = hasCompanionDoc(markers);
  if (companion && (markers.startSh || markers.runSh)) return 'script-entry';
  if (companion && (markers.serverPy || markers.appPy || markers.mainPy)) return 'python-entry';
  if (markers.packageJson) {
    const pkg = await readJsonFile(path.join(abs, dirInfo.rel, 'package.json'), config.packageJsonMaxBytes);
    const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : null;
    if (scripts) {
      for (const scriptName of ['dev', 'start', 'serve', 'preview']) {
        if (typeof scripts[scriptName] === 'string' && scripts[scriptName].trim()) {
          return 'package.json:' + scriptName;
        }
      }
    }
  }
  return null;
}

/**
 * 在顶层项目内下钻，返回子项目相对路径列表（深度 <= maxDepth）。
 * - 一旦某目录判定为子项目，不再进入它内部下钻；
 * - 只有 index.html 的目录不算（不会命中任何强入口）；
 * - 父项目自身的 Xcode 工程文件（*.xcodeproj）不算子项目，父项目本身即可运行。
 */
async function detectChildCandidates({ abs, dirIndex, manifests, config }) {
  const maxDepth = config.children.maxDepth;
  const maxPerParent = config.children.maxPerParent;
  const all = Array.from(dirIndex.values())
    .filter((item) => item.depth >= 1 && item.depth <= maxDepth)
    .sort((a, b) => a.rel.localeCompare(b.rel));
  const depth1 = all.filter((item) => item.depth === 1);
  const depth2 = all.filter((item) => item.depth === 2);

  const result = [];
  for (const dirInfo of depth1) {
    if (result.length >= maxPerParent) break;
    // 父项目自身的工程文件不算子项目
    if (manifests.xcode && dirInfo.rel === manifests.xcode) continue;
    const hit = await strongChildEntry(abs, dirInfo, config);
    if (hit) {
      result.push(dirInfo.rel);
      continue;
    }
    // 未命中则继续向下钻一层
    const children = depth2.filter((item) => item.rel.startsWith(dirInfo.rel + '/'));
    for (const childInfo of children) {
      if (result.length >= maxPerParent) break;
      const childHit = await strongChildEntry(abs, childInfo, config);
      if (childHit) result.push(childInfo.rel);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 单个项目构建
// ---------------------------------------------------------------------------

async function buildProject(abs, config, context) {
  let entries;
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch {
    return null;
  }

  const rootFiles = new Set();
  const rootDirs = new Set();
  for (const entry of entries) {
    if (entry.isDirectory()) rootDirs.add(entry.name);
    else if (entry.isFile()) rootFiles.add(entry.name);
  }

  const hasGitDir = rootDirs.has('.git') || rootFiles.has('.git');
  const manifests = detectManifests(entries);
  const facts = await collectFacts(abs, config, { dirIndex: context.withDirIndex === true });
  const doc = await discoverDocument(abs, entries, config);
  const pkg = rootFiles.has('package.json')
    ? await readJsonFile(path.join(abs, 'package.json'), config.packageJsonMaxBytes)
    : null;
  const git = await readGitInfo(abs, hasGitDir, config.gitTimeoutMs);

  let updatedMs = facts.maxMtime;
  let updatedSource = 'files';
  if (git.isRepo && git.lastCommitAt) {
    const gitMs = Date.parse(git.lastCommitAt);
    if (Number.isFinite(gitMs) && gitMs > updatedMs) {
      updatedMs = gitMs;
      updatedSource = 'git';
    }
  }
  if (!updatedMs) {
    try {
      const stat = await fsp.stat(abs);
      updatedMs = stat.mtimeMs;
      updatedSource = 'dir';
    } catch {
      updatedMs = Date.now();
      updatedSource = 'dir';
    }
  }
  const updatedAt = toIso(updatedMs) || new Date().toISOString();
  const createdAt = toIso(facts.minMtime) || updatedAt;

  const dirName = context.dirName;
  const relPath = context.relPath || '';
  const name = deriveName({
    dir: dirName,
    relPath,
    readmeTitle: doc.isReadme ? doc.readmeTitle : null,
    pkg
  });
  const run = deriveRunHint({ manifests, pkg, rootFiles });

  const project = {
    id: null,
    dir: dirName,
    name,
    path: abs,
    updatedAt,
    updatedSource,
    createdAt,
    summary: doc.summary,
    readmeTitle: doc.readmeTitle,
    readmePath: doc.readmePath,
    tags: deriveTags({ facts, manifests, pkg, git }),
    kind: deriveKind({ facts, manifests, pkg }),
    fileCount: facts.fileCount,
    sizeBytes: facts.sizeBytes,
    git,
    runnable: run.runnable,
    runKind: run.runKind,
    runHint: run.runHint,
    accent: null,
    parentId: context.parentId || null,
    relPath,
    depth: context.depth || 0,
    summarySource: doc.summarySource,
    docAlias: null,
    llm: null,
    children: [],
    firstSeenAt: updatedAt,
    lastChangedAt: updatedAt
  };

  return {
    project,
    facts,
    manifests,
    rootFiles,
    rootDirs,
    entries,
    hasReadme: doc.isReadme,
    hasGitDir
  };
}

/** 顶层项目：构建字段并判定是否算项目；同时收集子项目候选。 */
async function inspectProject({ root, dir, config }) {
  const abs = path.join(root, dir);
  const built = await buildProject(abs, config, {
    dirName: dir,
    parentId: null,
    relPath: '',
    depth: 0,
    withDirIndex: true
  });
  if (!built) return null;

  const manifests = built.manifests;
  const manifestHit =
    manifests.packageJson || manifests.godot || manifests.requirements || manifests.pyproject ||
    manifests.indexHtml || manifests.makefile || manifests.startSh || manifests.runSh ||
    manifests.cmake || manifests.gradle || Boolean(manifests.xcode) || Boolean(manifests.sln);
  const hasMarker = built.hasReadme || built.hasGitDir || manifestHit;
  // 项目判定：README/.git/项目清单文件任一，或 >=2 个源码文件，或至少 1 个可执行脚本。
  const looksLikeProject = hasMarker || built.facts.srcCount >= 2 || built.facts.scriptCount >= 1;
  if (!looksLikeProject) return null;

  const childCandidates = await detectChildCandidates({
    abs,
    dirIndex: built.facts.dirIndex,
    manifests,
    config
  });

  return { project: built.project, childCandidates };
}

/** 子项目：按相对路径构建 Project 字段（depth 1 或 2）。 */
async function inspectChild({ parentProject, relPath, config }) {
  const segments = String(relPath).split('/').filter(Boolean);
  const abs = path.join(parentProject.path, ...segments);
  const built = await buildProject(abs, config, {
    dirName: segments[segments.length - 1],
    parentId: parentProject.id,
    relPath,
    depth: segments.length,
    withDirIndex: false
  });
  return built ? built.project : null;
}

// ---------------------------------------------------------------------------
// 工作区扫描
// ---------------------------------------------------------------------------

/**
 * 扫描工作区根目录下的一级目录，返回顶层项目列表（每个项目的 children 里放子项目）与统计。
 * @param {{root?: string, config?: object}} [options]
 */
export async function scanWorkspace(options = {}) {
  const startedAt = Date.now();
  const root = path.resolve(
    (options && options.root) ||
    process.env.PROJECT_SCAN_ROOT ||
    path.resolve(APP_DIR, '..')
  );

  let rootStat;
  try {
    rootStat = await fsp.stat(root);
  } catch {
    throw new Error('工作区目录不可读：' + root);
  }
  if (!rootStat.isDirectory()) throw new Error('工作区路径不是目录：' + root);

  const fileConfig = await loadFileConfig();
  const mergedConfig = Object.assign({}, fileConfig, (options && options.config) || {});
  const config = normalizeConfig(mergedConfig);

  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    throw new Error('无法读取工作区目录：' + root + '（' + String((err && err.message) || err) + '）');
  }

  const forced = new Set(config.includeDirs);
  const candidates = [];
  const excluded = [];

  const dirNames = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirNames.push(entry.name);
      continue;
    }
    if (entry.isSymbolicLink()) {
      try {
        const stat = await fsp.stat(path.join(root, entry.name));
        if (stat.isDirectory()) dirNames.push(entry.name);
      } catch {
        // 断链，忽略
      }
    }
  }
  dirNames.sort((a, b) => a.localeCompare(b));

  for (const dir of dirNames) {
    if (forced.has(dir)) {
      candidates.push(dir);
      continue;
    }
    if (dir.startsWith('.')) {
      excluded.push({ dir, reason: '隐藏目录（系统缓存 / 工具配置）' });
      continue;
    }
    const configuredReason = config.excludeDirs[dir];
    if (configuredReason) {
      excluded.push({ dir, reason: configuredReason });
      continue;
    }
    candidates.push(dir);
  }

  const scanned = [];
  await mapPool(candidates, config.concurrency, async (dir) => {
    try {
      const inspected = await inspectProject({ root, dir, config });
      if (inspected) scanned.push(inspected);
      else excluded.push({ dir, reason: '未检测到项目特征（没有 README / 项目文件 / 源码）' });
    } catch (err) {
      excluded.push({ dir, reason: '扫描失败：' + String((err && err.message) || err) });
    }
  });

  // 顶层 id 去重：按目录名排序后依次分配，保证结果稳定
  scanned.sort((a, b) => a.project.dir.localeCompare(b.project.dir));
  const usedIds = new Set();
  for (const item of scanned) {
    const project = item.project;
    let id = slugify(project.dir);
    if (usedIds.has(id)) {
      let suffix = 2;
      while (usedIds.has(id + '-' + suffix)) suffix += 1;
      id = id + '-' + suffix;
    }
    usedIds.add(id);
    project.id = id;
    project.accent = accentFor(id);
  }

  // 全局子项目上限：按父目录名顺序分配配额
  const maxTotal = config.children.maxTotal;
  let childBudget = maxTotal;
  const planned = [];
  for (const item of scanned) {
    const limit = Math.min(item.childCandidates.length, childBudget);
    if (limit > 0) {
      planned.push({ parent: item.project, relPaths: item.childCandidates.slice(0, limit) });
      childBudget -= limit;
    }
  }

  const childResults = [];
  await mapPool(planned, Math.min(4, config.concurrency), async (entry) => {
    const children = [];
    for (const relPath of entry.relPaths) {
      try {
        const child = await inspectChild({ parentProject: entry.parent, relPath, config });
        if (child) children.push(child);
      } catch {
        // 单个子项目失败不影响整轮扫描
      }
    }
    childResults.push({ parent: entry.parent, children });
  });

  // 子项目 id 去重：父 id + "--" + relPath slug，全局唯一
  childResults.sort((a, b) => a.parent.dir.localeCompare(b.parent.dir));
  for (const entry of childResults) {
    entry.children.sort((a, b) => a.relPath.localeCompare(b.relPath));
    for (const child of entry.children) {
      let id = entry.parent.id + '--' + slugify(child.relPath);
      if (usedIds.has(id)) {
        let suffix = 2;
        while (usedIds.has(id + '-' + suffix)) suffix += 1;
        id = id + '-' + suffix;
      }
      usedIds.add(id);
      child.id = id;
      child.parentId = entry.parent.id;
      child.accent = accentFor(id);
    }
    entry.parent.children = entry.children;
  }

  const projects = scanned.map((item) => item.project);
  let subprojects = 0;
  for (const project of projects) subprojects += project.children.length;

  projects.sort((a, b) => {
    const byTime = String(b.updatedAt).localeCompare(String(a.updatedAt));
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });
  excluded.sort((a, b) => a.dir.localeCompare(b.dir));

  return {
    projects,
    stats: {
      durationMs: Date.now() - startedAt,
      included: projects.length,
      excluded,
      subprojects
    }
  };
}
