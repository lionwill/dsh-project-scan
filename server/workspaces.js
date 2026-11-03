import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 多工作区持久化。
 *
 * 默认工作区由 defaultRoot 决定，id 固定为 "main"，不可删除；额外工作区持久化在
 * <dataDir>/workspaces.json，结构为 { version: 1, workspaces: [...] }。
 * add / remove 只修改内存，由调用方决定何时 save()（见 CONTRACT.md §4）。
 *
 * 工作区对象：{ id, name, path, isDefault, addedAt }
 *   - id: "main"（默认）或 "ws-<slug>"（冲突时追加 -2 / -3 ...）
 *   - path: 目录的 realpath（默认工作区为 path.resolve(defaultRoot)）
 */

export const MAX_WORKSPACES = 10;

const DEFAULT_ID = 'main';
const FILE_VERSION = 1;

function isoNow() {
  return new Date().toISOString();
}

function failure(code, error) {
  return { ok: false, code: code, error: error };
}

function copyWorkspace(workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    isDefault: workspace.isDefault === true,
    addedAt: workspace.addedAt
  };
}

/** 与 scanner.js 的 slugify 保持一致的 id 片段规则（这里不 import，避免模块耦合）。 */
function slugify(name) {
  const base = String(name == null ? '' : name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/['"\u2018\u2019\u201c\u201d]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'workspace';
}

/** child 是否等于 parent 或位于 parent 内部（用 path.relative 判断，跨平台安全）。 */
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

export function createWorkspaces(options) {
  const opts = options || {};
  const dataDir = path.resolve(opts.dataDir || path.join(process.cwd(), 'data'));
  const defaultRoot = path.resolve(opts.defaultRoot || process.cwd());
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  const home = os.homedir();
  const file = path.join(dataDir, 'workspaces.json');

  let defaultAddedAt = isoNow();
  let customs = [];

  const defaultName = path.basename(defaultRoot) || defaultRoot;

  /** 尽力取 realpath；路径不存在（例如已被删除的工作区）时退回 path.resolve。 */
  function canonical(target) {
    try {
      return fs.realpathSync(target);
    } catch (err) {
      return path.resolve(target);
    }
  }

  function isForbiddenPath(target) {
    if (isInside(target, dataDir)) return true;
    const dataDirReal = canonical(dataDir);
    return dataDirReal !== dataDir && isInside(target, dataDirReal);
  }

  /** 展开 ~ 并转成绝对路径；不访问文件系统。 */
  function expand(inputPath) {
    if (typeof inputPath !== 'string') return failure('INVALID_PATH', '路径必须是字符串');
    const raw = inputPath.trim();
    if (!raw) return failure('INVALID_PATH', '路径不能为空');
    let target = raw;
    if (target === '~') {
      target = home;
    } else if (target.startsWith('~/')) {
      target = path.join(home, target.slice(2));
    } else if (target.startsWith('~')) {
      return failure('INVALID_PATH', '不支持 ~用户 形式的路径，请使用绝对路径');
    }
    if (!path.isAbsolute(target)) {
      return failure('INVALID_PATH', '请使用绝对路径（或 ~ 开头的家目录路径）');
    }
    return { ok: true, path: path.resolve(target) };
  }

  /** 只做校验，不改状态：{ ok, path?, realPath?, error?, code? } */
  function resolve(inputPath) {
    const expanded = expand(inputPath);
    if (!expanded.ok) return expanded;
    const target = expanded.path;

    let stat;
    try {
      stat = fs.statSync(target);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        return failure('INVALID_PATH', '路径不存在：' + target);
      }
      if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
        return failure('NOT_READABLE', '没有访问权限：' + target);
      }
      return failure('INVALID_PATH', '无法访问路径：' + target);
    }
    if (!stat.isDirectory()) {
      return failure('NOT_DIRECTORY', '不是目录：' + target);
    }
    try {
      fs.accessSync(target, fs.constants.R_OK | fs.constants.X_OK);
    } catch (err) {
      return failure('NOT_READABLE', '没有读取权限：' + target);
    }

    let realPath;
    try {
      realPath = fs.realpathSync(target);
    } catch (err) {
      return failure('INVALID_PATH', '无法解析路径：' + target);
    }

    if (isForbiddenPath(realPath) || isForbiddenPath(target)) {
      return failure('FORBIDDEN_PATH', '不能把 project-scan 自身的数据目录添加为工作区：' + target);
    }
    return { ok: true, path: realPath, realPath: realPath };
  }

  function defaultWorkspace() {
    return {
      id: DEFAULT_ID,
      name: defaultName,
      path: defaultRoot,
      isDefault: true,
      addedAt: defaultAddedAt
    };
  }

  function list() {
    const extras = customs
      .slice()
      .sort(function (a, b) {
        return String(a.addedAt || '').localeCompare(String(b.addedAt || ''));
      })
      .map(copyWorkspace);
    return [defaultWorkspace()].concat(extras);
  }

  function get(id) {
    if (typeof id !== 'string' || !id) return null;
    if (id === DEFAULT_ID) return defaultWorkspace();
    const found = customs.find(function (item) { return item.id === id; });
    return found ? copyWorkspace(found) : null;
  }

  function nextId(name, taken) {
    const slug = slugify(name);
    let candidate = 'ws-' + slug;
    let n = 2;
    while (taken.has(candidate)) {
      candidate = 'ws-' + slug + '-' + n;
      n += 1;
    }
    return candidate;
  }

  function add(inputPath) {
    const resolved = resolve(inputPath);
    if (!resolved.ok) return resolved;
    const realPath = resolved.realPath;

    const all = list();
    const existingPaths = new Set(all.map(function (item) { return canonical(item.path); }));
    if (existingPaths.has(realPath)) {
      return failure('WORKSPACE_EXISTS', '该目录已在工作区列表中：' + realPath);
    }
    if (all.length >= MAX_WORKSPACES) {
      return failure('MAX_WORKSPACES', '最多只能添加 ' + MAX_WORKSPACES + ' 个工作区');
    }

    const name = path.basename(realPath) || realPath;
    const taken = new Set(all.map(function (item) { return item.id; }));
    const workspace = {
      id: nextId(name, taken),
      name: name,
      path: realPath,
      isDefault: false,
      addedAt: isoNow()
    };
    customs.push(workspace);
    return { ok: true, workspace: copyWorkspace(workspace) };
  }

  function remove(id) {
    if (typeof id !== 'string' || !id) return failure('NOT_FOUND', '工作区不存在');
    if (id === DEFAULT_ID) return failure('DEFAULT_WORKSPACE', '默认工作区不可删除');
    const index = customs.findIndex(function (item) { return item.id === id; });
    if (index === -1) return failure('NOT_FOUND', '工作区不存在');
    const removed = customs.splice(index, 1)[0];
    return { ok: true, workspace: copyWorkspace(removed) };
  }

  function load() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch (err) {
      log('[workspaces] 创建数据目录失败：' + err.message);
    }

    const now = isoNow();
    let parsed = null;
    let missing = false;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      parsed = JSON.parse(raw);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        missing = true;
      } else {
        log('[workspaces] workspaces.json 读取失败，按空列表处理：' + (err && err.message ? err.message : String(err)));
      }
    }

    let nextDefaultAddedAt = now;
    const nextCustoms = [];
    const seenIds = new Set([DEFAULT_ID]);
    const seenPaths = new Set([canonical(defaultRoot)]);
    let dropped = 0;

    if (parsed && Array.isArray(parsed.workspaces)) {
      for (const item of parsed.workspaces) {
        if (!item || typeof item !== 'object') {
          dropped += 1;
          continue;
        }
        const isMain = item.id === DEFAULT_ID || item.isDefault === true;
        if (isMain) {
          if (typeof item.addedAt === 'string' && item.addedAt) nextDefaultAddedAt = item.addedAt;
          continue;
        }
        if (typeof item.path !== 'string' || !item.path.trim()) {
          dropped += 1;
          continue;
        }
        const abs = path.resolve(item.path);
        const real = canonical(abs);
        if (isForbiddenPath(real)) {
          dropped += 1;
          continue;
        }
        if (seenPaths.has(real)) {
          dropped += 1;
          continue;
        }
        if (nextCustoms.length >= MAX_WORKSPACES - 1) {
          dropped += 1;
          continue;
        }
        const name = typeof item.name === 'string' && item.name ? item.name : (path.basename(real) || real);
        let id = typeof item.id === 'string' && item.id ? item.id : '';
        if (!id || seenIds.has(id)) id = nextId(name, seenIds);
        seenIds.add(id);
        seenPaths.add(real);
        nextCustoms.push({
          id: id,
          name: name,
          path: real,
          isDefault: false,
          addedAt: typeof item.addedAt === 'string' && item.addedAt ? item.addedAt : now
        });
      }
    } else if (!missing && parsed) {
      log('[workspaces] workspaces.json 结构异常（缺少 workspaces 数组），按空列表处理');
    }

    if (dropped > 0) {
      log('[workspaces] 已忽略 ' + dropped + ' 条无效、重复或超上限的工作区记录');
    }

    defaultAddedAt = nextDefaultAddedAt;
    customs = nextCustoms;
    return list();
  }

  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const payload = { version: FILE_VERSION, workspaces: list() };
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (cleanupErr) { /* ignore */ }
      throw err;
    }
    return list();
  }

  return {
    load: load,
    list: list,
    get: get,
    defaultWorkspace: defaultWorkspace,
    add: add,
    remove: remove,
    save: save,
    resolve: resolve,
    get limit() { return MAX_WORKSPACES; },
    get home() { return home; }
  };
}
