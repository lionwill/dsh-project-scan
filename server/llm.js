/**
 * server/llm.js — 项目文档理解与摘要（LLM 复核）
 *
 * 职责：
 *  - 读取每个项目（含子项目）的文档候选：README 优先，其次项目根其他 md 文件与 docs 子目录；
 *  - 调用 OpenAI 兼容的 Chat Completions 接口（默认 DeepSeek），让模型判断：
 *      1) 哪份文档实质上是该项目的 README；
 *      2) 用中文写一句准确的用途概要；
 *      3) 最多 4 个技术标签。
 *  - 仅当项目当前没有任何 README 文件时，才允许把判定为事实 README 的文档复制为 README.md
 *    （用户已确认；PROJECT_SCAN_README_COPY=off 可关闭；绝不覆盖已有文件）。
 *  - 结果按项目内容指纹缓存到 data/llm-cache.json，只有内容变化才重新请求。
 *  - 无 key、网络失败、返回非法 JSON 时优雅降级：不抛异常，返回已成功的 patches。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PROMPT_VERSION = 'v4';
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-flash';
const MAX_DOCS = 3;
const DOC_EXCERPT_CHARS = 1400;
const MAX_README_COPY_BYTES = 256 * 1024;
const CACHE_LIMIT = 300;

const README_RE = /^readme(\.[a-z0-9]+)?$/i;
const MD_RE = /\.(md|markdown|txt)$/i;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.godot', '.venv', 'venv', '__pycache__',
  '.gradle', '.next', '.cache', 'target', 'coverage', '.turbo', '.parcel-cache',
  'site-packages', 'Pods', 'DerivedData'
]);
const RELEVANT_DOC_WORDS = ['readme', 'channel', 'instruction', 'develop', 'dev', 'guide', 'doc', 'intro', 'about', 'usage', 'manual', '说明', '介绍', '文档'];

function isoNow() {
  return new Date().toISOString();
}

function hashText(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function readCredentialsKey() {
  try {
    const file = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m);
    return match ? match[1] : '';
  } catch (err) {
    return '';
  }
}

/**
 * 解析生效的 LLM 配置，优先级：
 *   1) 用户在设置里选择的 DSH 渠道 + 模型（data/settings.json 的 llmSelection）
 *   2) 显式环境变量覆盖（PROJECT_SCAN_LLM_API_KEY / _BASE_URL / _MODEL）
 *   3) 本机 DSH 的默认模型（agent-default-model，见 server/dsh-llm.js）
 *   4) 旧行为：DEEPSEEK_API_KEY / DSH 凭据 + 默认 DeepSeek 兼容接口
 * 选择渠道后若渠道不可用，本轮直接失败并记录原因，不静默回退。
 */
function resolveConfig(options) {
  const opts = options || {};
  const env = process.env;
  const enabledEnv = String(env.PROJECT_SCAN_LLM || 'on').toLowerCase();
  const envDisabled = enabledEnv === 'off' || enabledEnv === '0' || enabledEnv === 'false';
  const userEnabled = typeof opts.getEnabled === 'function' ? opts.getEnabled() !== false : true;
  const disabled = envDisabled || !userEnabled;

  let selection = null;
  if (!disabled && typeof opts.getSelection === 'function') {
    try {
      selection = opts.getSelection() || null;
    } catch (err) {
      selection = null;
    }
  }

  const common = {
    timeoutMs: Number(opts.timeoutMs || env.PROJECT_SCAN_LLM_TIMEOUT_MS || 45000),
    concurrency: Math.max(1, Math.min(6, Number(opts.concurrency || env.PROJECT_SCAN_LLM_CONCURRENCY || 3))),
    allowReadmeCopy: String(env.PROJECT_SCAN_README_COPY || 'on').toLowerCase() !== 'off',
    fetchImpl: opts.fetchImpl || globalThis.fetch,
    log: typeof opts.log === 'function' ? opts.log : function () {}
  };
  const legacyModel = String(opts.model || env.PROJECT_SCAN_LLM_MODEL || DEFAULT_MODEL);
  const legacyBaseUrl = String(opts.baseUrl || env.PROJECT_SCAN_LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

  if (selection) {
    if (!opts.dshLlm || typeof opts.dshLlm.resolveSelection !== 'function') {
      return Object.assign({}, common, {
        enabled: false, source: 'selection', apiKey: '', baseUrl: '', model: selection.model,
        provider: selection.provider, channelName: null, keyMasked: '', opencodeSession: null,
        error: 'AI 摘要渠道模块不可用。'
      });
    }
    try {
      const target = opts.dshLlm.resolveSelection(selection);
      return Object.assign({}, common, {
        enabled: true,
        source: 'selection',
        apiKey: target.apiKey,
        baseUrl: target.baseUrl,
        model: target.model,
        provider: target.provider,
        channelName: target.providerName || target.provider,
        keyMasked: target.keyMasked || maskKey(target.apiKey),
        opencodeSession: target.opencode ? 'project-scan-' + process.pid : null,
        error: ''
      });
    } catch (err) {
      return Object.assign({}, common, {
        enabled: false,
        source: 'selection',
        apiKey: '',
        baseUrl: '',
        model: selection.model,
        provider: selection.provider,
        channelName: null,
        keyMasked: '',
        opencodeSession: null,
        error: String((err && err.message) || err)
      });
    }
  }

  const explicitApiKey = String(opts.apiKey || env.PROJECT_SCAN_LLM_API_KEY || '').trim();
  if (explicitApiKey) {
    return Object.assign({}, common, {
      enabled: !disabled,
      source: 'env',
      apiKey: explicitApiKey,
      baseUrl: legacyBaseUrl,
      model: legacyModel,
      provider: 'deepseek-compatible',
      channelName: null,
      keyMasked: maskKey(explicitApiKey),
      opencodeSession: null,
      error: ''
    });
  }

  let dshError = '';
  if (!disabled && opts.dshLlm && typeof opts.dshLlm.resolve === 'function') {
    try {
      const target = opts.dshLlm.resolve();
      if (target) {
        return Object.assign({}, common, {
          enabled: true,
          source: 'dsh',
          apiKey: target.apiKey,
          baseUrl: target.baseUrl,
          model: target.model,
          provider: target.provider,
          channelName: target.providerName || target.provider,
          keyMasked: target.keyMasked || maskKey(target.apiKey),
          opencodeSession: target.opencode ? 'project-scan-' + process.pid : null,
          error: ''
        });
      }
    } catch (err) {
      dshError = String((err && err.message) || err);
    }
  }

  const legacyKey = String(env.DEEPSEEK_API_KEY || readCredentialsKey() || '').trim();
  if (!disabled && legacyKey) {
    return Object.assign({}, common, {
      enabled: true,
      source: 'env',
      apiKey: legacyKey,
      baseUrl: legacyBaseUrl,
      model: legacyModel,
      provider: 'deepseek-compatible',
      channelName: null,
      keyMasked: maskKey(legacyKey),
      opencodeSession: null,
      error: ''
    });
  }

  return Object.assign({}, common, {
    enabled: false,
    source: 'off',
    apiKey: '',
    baseUrl: legacyBaseUrl,
    model: legacyModel,
    provider: 'deepseek-compatible',
    channelName: null,
    keyMasked: '',
    opencodeSession: null,
    error: disabled ? '' : dshError || ''
  });
}

/** 掩码显示 key，只保留首尾。 */
function maskKey(key) {
  const value = String(key || '');
  if (!value) return '';
  if (value.length <= 8) return '***';
  return value.slice(0, 4) + '…' + value.slice(-4);
}

/* ------------------------------------------------------------------ */
/* 文档候选                                                            */
/* ------------------------------------------------------------------ */

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (err) {
    return false;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return [];
  }
}

function hasReadme(dir) {
  return listDir(dir).some(function (entry) {
    return entry.isFile() && README_RE.test(entry.name);
  });
}

function relevanceScore(name) {
  const lower = name.toLowerCase();
  let score = 0;
  RELEVANT_DOC_WORDS.forEach(function (word, index) {
    if (lower.indexOf(word) !== -1) score += RELEVANT_DOC_WORDS.length - index;
  });
  return score;
}

async function readDocText(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size > 64 * 1024) return '';
    const raw = await fsp.readFile(filePath, 'utf8');
    return raw;
  } catch (err) {
    return '';
  }
}

async function collectDocs(project) {
  const dir = project.path;
  const entries = listDir(dir);
  const docs = [];

  const readme = entries.find(function (entry) { return entry.isFile() && README_RE.test(entry.name); });
  if (readme) {
    const text = await readDocText(path.join(dir, readme.name));
    if (text) docs.push({ name: readme.name, text: text, isReadme: true });
  }

  if (docs.length === 0) {
    const rootDocs = entries
      .filter(function (entry) { return entry.isFile() && MD_RE.test(entry.name) && !README_RE.test(entry.name); })
      .map(function (entry) { return entry.name; })
      .sort(function (a, b) { return relevanceScore(b) - relevanceScore(a) || a.localeCompare(b); });
    for (const name of rootDocs.slice(0, MAX_DOCS)) {
      const text = await readDocText(path.join(dir, name));
      if (text) docs.push({ name: name, text: text, isReadme: false });
    }
  }

  if (docs.length === 0) {
    const docsDir = path.join(dir, 'docs');
    const nested = listDir(docsDir)
      .filter(function (entry) { return entry.isFile() && MD_RE.test(entry.name); })
      .map(function (entry) { return 'docs/' + entry.name; })
      .slice(0, MAX_DOCS);
    for (const rel of nested) {
      const text = await readDocText(path.join(dir, rel));
      if (text) docs.push({ name: rel, text: text, isReadme: false });
    }
  }

  // 顶层项目自身没有任何文档时，用子项目的 README 作为上下文（只用于理解用途，不作为复制来源）
  if (docs.length === 0 && Array.isArray(project.children)) {
    for (const child of project.children.slice(0, 3)) {
      if (!child.readmePath || !child.path) continue;
      const base = path.resolve(child.path);
      const abs = path.resolve(base, child.readmePath);
      if (abs !== base && !abs.startsWith(base + path.sep)) continue;
      const text = await readDocText(abs);
      if (text) {
        docs.push({
          name: (child.relPath || child.id) + '/' + child.readmePath,
          text: text,
          isReadme: false,
          contextOnly: true
        });
      }
    }
  }

  return docs.map(function (doc) {
    return {
      name: doc.name,
      isReadme: doc.isReadme,
      contextOnly: Boolean(doc.contextOnly),
      excerpt: doc.text.slice(0, DOC_EXCERPT_CHARS),
      fullText: doc.text
    };
  });
}

/* ------------------------------------------------------------------ */
/* Prompt / 结果校验                                                   */
/* ------------------------------------------------------------------ */

function buildMessages(project, docs) {
  const topEntries = listDir(project.path)
    .filter(function (entry) { return !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'); })
    .map(function (entry) { return entry.isDirectory() ? entry.name + '/' : entry.name; })
    .slice(0, 30);

  const payload = {
    project: {
      dir: project.dir || path.basename(project.path || ''),
      relPath: project.relPath || '',
      name: project.name || '',
      kind: project.kind || 'unknown',
      fileCount: project.fileCount || 0,
      tags: project.tags || [],
      hasReadme: Boolean(project.readmePath && README_RE.test(path.basename(project.readmePath))),
      readmePath: project.readmePath || null
    },
    topEntries: topEntries,
    docs: docs.map(function (doc) { return { name: doc.name, isReadme: doc.isReadme, excerpt: doc.excerpt }; })
  };

  const system = [
    '你是本地项目档案整理助手，负责给工作区里的项目写准确的用途概要。',
    '输入是一个项目目录的元信息和若干文档片段。请输出严格的 JSON 对象，不要输出任何解释或 markdown。',
    'JSON 字段：',
    '1. summary：中文用途概要，40 到 120 字。具体说明这个项目是做什么的、产出是什么、面向谁。不要营销词，不要空话，不要以「这是一个」开头，不要使用破折号。',
    '2. name：项目短名，4 到 16 个字，中文优先，概括项目本身而不是文档标题；不要包含版本号、日期、作者、文件路径。',
    '3. readmeDoc：候选文档里哪一份实质上是这个项目的 README。只有整份文档就是项目说明时才选；变更日志、设计草稿、专题资料不要选。如果项目完全没有 README，而候选文档是唯一能说明项目用途的根目录文档（哪怕它侧重某个专题，例如渠道说明、使用说明），也可以选它作为 readmeDoc，系统会把它复制为 README.md。没有合适文档时为 null。',
    '4. tags：最多 4 个技术或领域标签，每个不超过 8 个汉字或 12 个字符。',
    '5. confidence：0 到 1 的小数，表示你对 summary 的把握。',
    '如果文档信息不足以判断用途，summary 就基于目录名、文件类型与项目结构谨慎描述，不要编造具体功能。'
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(payload) }
  ];
}

function parseJsonContent(content) {
  const text = String(content || '').trim();
  if (!text) throw new Error('模型返回为空');
  try {
    return JSON.parse(text);
  } catch (err) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('模型返回不是合法 JSON');
  }
}

function normalizeResult(raw, docs) {
  const result = {};
  const summary = String(raw && raw.summary ? raw.summary : '').replace(/\s+/g, ' ').trim();
  if (summary.length < 8 || summary.length > 300) throw new Error('summary 长度不合法');
  result.summary = summary;
  result.summarySource = 'llm';

  const name = String(raw && raw.name ? raw.name : '').replace(/\s+/g, ' ').trim();
  result.name = name.length >= 2 && name.length <= 30 ? name : null;

  // 只有项目自身的文档才有资格被判定为「事实 README」并被复制；子项目文档仅作上下文
  const candidateNames = new Set(
    docs.filter(function (doc) { return !doc.contextOnly; }).map(function (doc) { return doc.name; })
  );
  const readmeDoc = raw && raw.readmeDoc ? String(raw.readmeDoc).trim() : null;
  result.readmeDoc = readmeDoc && candidateNames.has(readmeDoc) ? readmeDoc : null;

  const tags = Array.isArray(raw && raw.tags) ? raw.tags : [];
  result.tags = tags
    .map(function (tag) { return String(tag || '').trim(); })
    .filter(function (tag) { return tag.length > 0 && tag.length <= 12; })
    .filter(function (tag, index, arr) { return arr.indexOf(tag) === index; })
    .slice(0, 4);

  const confidence = Number(raw && raw.confidence);
  result.confidence = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null;
  return result;
}

/* ------------------------------------------------------------------ */
/* createLLM                                                           */
/* ------------------------------------------------------------------ */

export function createLLM(options) {
  const opts = options || {};
  const dataDir = path.resolve(opts.dataDir || path.join(process.cwd(), 'data'));
  let config = resolveConfig(opts);
  const log = config.log;
  const cacheFile = path.join(dataDir, 'llm-cache.json');
  const copyLogFile = path.join(dataDir, 'readme-copies.log');

  let cache = { version: PROMPT_VERSION, entries: {} };
  let copiedDocs = new Map();
  let status = {
    enabled: config.enabled,
    source: config.source,
    provider: config.provider,
    channelName: config.channelName || null,
    model: config.model,
    keyMasked: config.keyMasked,
    error: config.error || null,
    running: false,
    lastRunAt: null,
    durationMs: 0,
    enriched: 0,
    failed: 0,
    cached: 0
  };

  /** 重新解析配置（设置里切换渠道/模型后调用；每轮 enrich 开始时也会重新解析）。 */
  function refreshConfig() {
    config = resolveConfig(opts);
    status.enabled = config.enabled;
    status.source = config.source;
    status.provider = config.provider;
    status.channelName = config.channelName || null;
    status.model = config.model;
    status.keyMasked = config.keyMasked;
    status.error = config.error || null;
    return config;
  }

  function loadCopyLog() {
    copiedDocs = new Map();
    try {
      const text = fs.readFileSync(copyLogFile, 'utf8');
      text.split(String.fromCharCode(10)).forEach(function (line) {
        const match = line.match(/^\[([^\]]+)\]\s+(\S+)\s+复制\s+(\S+)\s+->\s+README\.md/);
        if (match) copiedDocs.set(match[2], { from: match[3], copied: true, copiedAt: match[1] });
      });
    } catch (err) {
      copiedDocs = new Map();
    }
  }

  function loadCache() {
    loadCopyLog();
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (parsed && parsed.entries && typeof parsed.entries === 'object') {
        cache = { version: PROMPT_VERSION, entries: parsed.entries };
      }
    } catch (err) {
      cache = { version: PROMPT_VERSION, entries: {} };
    }
  }

  function saveCache() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const keys = Object.keys(cache.entries);
      if (keys.length > CACHE_LIMIT) {
        keys
          .sort(function (a, b) { return (cache.entries[a].at || '').localeCompare(cache.entries[b].at || ''); })
          .slice(0, keys.length - CACHE_LIMIT)
          .forEach(function (key) { delete cache.entries[key]; });
      }
      const tmp = cacheFile + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(cache));
      fs.renameSync(tmp, cacheFile);
    } catch (err) {
      log('[llm] 缓存写入失败：' + String((err && err.message) || err));
    }
  }

  function fingerprint(project) {
    return [
      PROMPT_VERSION,
      config.model,
      project.id,
      project.updatedAt || '',
      project.fileCount || 0,
      project.readmePath || '',
      project.kind || ''
    ].join('|');
  }

  async function requestCompletion(messages) {
    const body = {
      model: config.model,
      messages: messages,
      temperature: 0.2,
      max_tokens: 1500,
      response_format: { type: 'json_object' }
    };
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(function () { controller.abort(); }, config.timeoutMs);
      try {
        const response = await config.fetchImpl(config.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: Object.assign(
            {
              'content-type': 'application/json',
              authorization: 'Bearer ' + config.apiKey
            },
            config.opencodeSession ? { 'x-opencode-session': config.opencodeSession } : {}
          ),
          body: JSON.stringify(body),
          signal: controller.signal
        });
        if (!response.ok) {
          const text = await response.text().catch(function () { return ''; });
          const error = new Error('LLM HTTP ' + response.status + ' ' + text.slice(0, 160));
          error.status = response.status;
          throw error;
        }
        const data = await response.json();
        const choice = data && data.choices && data.choices[0] ? data.choices[0] : null;
        const content = choice && choice.message ? choice.message.content : '';
        if (!content || !String(content).trim()) {
          lastError = new Error('模型返回为空');
          if (attempt < 2) {
            await sleep(600 * (attempt + 1));
            continue;
          }
          throw lastError;
        }
        return parseJsonContent(content);
      } catch (err) {
        lastError = err;
        const status = err && err.status;
        if (status && status !== 429 && status < 500) break;
        if (attempt < 2) await sleep(800 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error('LLM 请求失败');
  }

  function prettifyDirName(dirName) {
    const value = String(dirName || '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
    return value || String(dirName || '');
  }

  function withH1(text, name) {
    const heading = '# ' + name;
    const normalized = String(text).replace(/\r\n?/g, String.fromCharCode(10));
    const lines = normalized.split(String.fromCharCode(10));
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].trim()) continue;
      if (/^#\s+/.test(lines[i])) {
        lines[i] = heading;
        return lines.join(String.fromCharCode(10));
      }
      break;
    }
    return heading + String.fromCharCode(10, 10) + normalized;
  }

  /**
   * 把「事实 README」文档复制为项目根 README.md；仅当项目完全没有 README 时执行。
   * 复制时把一级标题改写成项目短名（LLM 给的名字优先，否则目录名），
   * 避免卡片名变成文档标题（如「下载渠道说明 (CHANNELS)」）。
   * 已经复制过的项目会修正其 README 一级标题，让项目名稳定。
   */
  function maybeWriteReadme(project, result, docs) {
    if (!config.allowReadmeCopy) return null;
    const dir = project.path;
    if (!dir) return null;
    const displayName = String(result.name || prettifyDirName(project.dir || path.basename(dir))).trim().slice(0, 30);

    const copied = project.docAlias && project.docAlias.copied ? project.docAlias : copiedDocs.get(project.id);
    if (copied && project.readmePath === 'README.md' && result.name) {
      const readme = path.join(dir, 'README.md');
      try {
        const stat = fs.statSync(readme);
        if (stat.isFile() && stat.size <= MAX_README_COPY_BYTES) {
          const text = fs.readFileSync(readme, 'utf8');
          const fixed = withH1(text, displayName);
          if (fixed !== text) {
            fs.writeFileSync(readme, fixed);
            log('[llm] ' + project.id + ' 已修正复制 README 的一级标题为「' + displayName + '」');
          }
        }
      } catch (err) {
        // 修复失败不影响摘要
      }
      return { name: displayName, docAlias: copied };
    }

    if (!result.readmeDoc) return null;
    if (hasReadme(dir)) return null;
    const doc = docs.find(function (item) { return item.name === result.readmeDoc; });
    if (!doc || !doc.fullText) return null;
    if (doc.fullText.length > MAX_README_COPY_BYTES) return null;
    const target = path.join(dir, 'README.md');
    if (fs.existsSync(target)) return null;
    try {
      fs.writeFileSync(target, withH1(doc.fullText, displayName));
      const line = '[' + isoNow() + '] ' + (project.id || '') + ' 复制 ' + doc.name + ' -> README.md' + String.fromCharCode(10);
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(copyLogFile, line);
      log('[llm] ' + (project.id || '') + ' 已把 ' + doc.name + ' 复制为 README.md（标题：' + displayName + '）');
      return { docAlias: { from: doc.name, copied: true, copiedAt: isoNow() }, name: displayName };
    } catch (err) {
      log('[llm] 复制 README 失败：' + String((err && err.message) || err));
      return null;
    }
  }

  async function enrichProject(project) {
    const docs = await collectDocs(project);
    const key = fingerprint(project);
    const cached = cache.entries[key];
    let result;
    let cachedHit = false;

    if (cached && cached.result) {
      result = Object.assign({}, cached.result);
      cachedHit = true;
    } else {
      const messages = buildMessages(project, docs);
      const raw = await requestCompletion(messages);
      result = normalizeResult(raw, docs);
      cache.entries[key] = {
        at: isoNow(),
        result: {
          summary: result.summary,
          summarySource: 'llm',
          tags: result.tags,
          name: result.name,
          readmeDoc: result.readmeDoc,
          confidence: result.confidence
        }
      };
    }

    // README 复制 / 已复制 README 的标题修正，缓存命中时也要执行（保证项目名稳定）
    const writeResult = maybeWriteReadme(project, result, docs);
    const patch = {
      summary: result.summary,
      summarySource: 'llm',
      tags: result.tags && result.tags.length > 0 ? result.tags : project.tags,
      llm: {
        model: config.model,
        generatedAt: cachedHit ? cached.at : isoNow(),
        confidence: result.confidence,
        cached: cachedHit
      }
    };
    if (writeResult && writeResult.name) patch.name = writeResult.name;
    if (writeResult && writeResult.docAlias) {
      patch.readmePath = 'README.md';
      patch.docAlias = writeResult.docAlias;
    } else if (result.readmeDoc) {
      patch.readmePath = project.readmePath || result.readmeDoc;
      if (project.docAlias) patch.docAlias = project.docAlias;
    }
    return { patch: patch, cached: cachedHit };
  }

  async function enrich(projects) {
    refreshConfig();
    const list = Array.isArray(projects) ? projects : [];
    if (!config.enabled || list.length === 0) {
      if (list.length > 0 && config.error) {
        log('[llm] 本轮跳过：' + config.error);
      }
      return { patches: new Map(), stats: { enriched: 0, failed: 0, cached: 0, durationMs: 0 } };
    }
    loadCache();
    const startedAt = Date.now();
    status.running = true;
    status.lastRunAt = isoNow();
    let enriched = 0;
    let failed = 0;
    let cached = 0;
    const patches = new Map();
    const queue = list.slice();
    const total = queue.length;

    async function worker() {
      while (queue.length > 0) {
        const project = queue.shift();
        try {
          const result = await enrichProject(project);
          patches.set(project.id, result.patch);
          if (result.cached) cached += 1;
          else enriched += 1;
        } catch (err) {
          failed += 1;
          log('[llm] ' + project.id + ' 摘要失败：' + String((err && err.message) || err));
        }
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(config.concurrency, total); i += 1) workers.push(worker());
    await Promise.all(workers);
    saveCache();

    status.running = false;
    status.durationMs = Date.now() - startedAt;
    status.enriched = enriched;
    status.failed = failed;
    status.cached = cached;
    log('[llm] 完成：' + total + ' 个项目，请求 ' + enriched + '，缓存 ' + cached + '，失败 ' + failed + '，耗时 ' + status.durationMs + 'ms');
    return {
      patches: patches,
      stats: { enriched: enriched, failed: failed, cached: cached, durationMs: status.durationMs }
    };
  }

  return {
    get available() {
      return refreshConfig().enabled;
    },
    get model() {
      return refreshConfig().model;
    },
    status: function () {
      refreshConfig();
      return Object.assign({}, status);
    },
    refreshConfig: refreshConfig,
    enrich: enrich,
    hasReadme: hasReadme,
    collectDocs: collectDocs
  };
}
