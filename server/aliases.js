/**
 * server/aliases.js — 项目别称（用户自定义显示名）
 *
 * 交互：在项目抽屉里双击标题可修改别称；别称优先于扫描得到的名称显示，
 * 并在标题下用「原名：…」标注扫描名称。别称只影响展示，不影响扫描、运行与 AI 摘要。
 *
 * 持久化：<dataDir>/aliases.json
 *   { "version": 1, "aliases": { "project-id": "别称", "parent--child": "子项目别称" } }
 * 原子写；文件损坏时降级为空并在下次保存时覆盖。别称长度上限 48 个字符。
 */

import fs from 'node:fs';
import path from 'node:path';

export const MAX_ALIAS_LENGTH = 48;

/** 规范化别称：去首尾空白、折叠内部空白、去掉控制字符；空字符串返回 null。 */
export function normalizeAlias(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || null;
}

export function createAliases(options) {
  const opts = options || {};
  const dataDir = path.resolve(opts.dataDir || path.join(process.cwd(), 'data'));
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  const file = path.join(dataDir, 'aliases.json');

  let aliases = new Map();

  function atomicWrite(payload) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (cleanupErr) { /* ignore */ }
      throw err;
    }
  }

  function load() {
    aliases = new Map();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const source = parsed && parsed.aliases && typeof parsed.aliases === 'object' ? parsed.aliases : {};
      for (const [id, value] of Object.entries(source)) {
        if (typeof id !== 'string' || !id.trim()) continue;
        const normalized = normalizeAlias(value);
        if (normalized && normalized.length <= MAX_ALIAS_LENGTH) aliases.set(id.trim(), normalized);
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        log('[aliases] 读取别称失败，按空配置处理：' + String((err && err.message) || err));
      }
      aliases = new Map();
    }
    return aliases.size;
  }

  function save() {
    atomicWrite({ version: 1, aliases: Object.fromEntries(Array.from(aliases.entries()).sort(function (a, b) { return a[0].localeCompare(b[0]); })) });
    return aliases.size;
  }

  function get(id) {
    if (typeof id !== 'string') return null;
    return aliases.get(id.trim()) || null;
  }

  /** 设置 / 清除别称。返回 { alias, changed }；超长返 null（由调用方报错）。 */
  function set(id, value) {
    if (typeof id !== 'string' || !id.trim()) return { alias: null, changed: false };
    const key = id.trim();
    const normalized = normalizeAlias(value);
    if (normalized && normalized.length > MAX_ALIAS_LENGTH) return null;
    const before = aliases.get(key) || null;
    if (!normalized) {
      aliases.delete(key);
      return { alias: null, changed: before !== null };
    }
    aliases.set(key, normalized);
    return { alias: normalized, changed: before !== normalized };
  }

  function count() {
    return aliases.size;
  }

  return {
    load: load,
    save: save,
    get: get,
    set: set,
    count: count,
    file: file
  };
}

export default createAliases;
