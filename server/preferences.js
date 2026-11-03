import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SETTINGS = { monitorEnabled: false, llmSelection: null, autoUpdate: true };

/** AI 摘要渠道选择只接受 { provider, model } 两个非空字符串；其他形状一律忽略。 */
function normalizeLlmSelection(value) {
  if (!value || typeof value !== 'object') return null;
  const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!provider || !model) return null;
  return { provider: provider, model: model };
}

function cloneSelection(selection) {
  if (!selection) return null;
  return { provider: selection.provider, model: selection.model };
}

/**
 * 用户偏好（Preferences）。
 *
 * 1) 隐藏项目：在「设置」里勾选隐藏的顶层项目，持久化在 <dataDir>/hidden.json：
 *      { "version": 1, "hiddenIds": ["project-a", ...] }
 * 2) 运行时监控开关 + AI 摘要渠道选择：持久化在 <dataDir>/settings.json：
 *      { "version": 3, "monitorEnabled": false,
 *        "llmSelection": { "provider": "opencode-go", "model": "deepseek-v4.1-flash" } | null,
 *        "autoUpdate": true }
 *      null 表示跟随 DSH 默认模型；只保存 provider/model，不保存任何 token。
 *      version 1 / 2 的旧设置文件仍可读取。
 */
export function createPreferences(options) {
  const opts = options || {};
  const dataDir = path.resolve(opts.dataDir || path.join(process.cwd(), 'data'));
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  const hiddenFile = path.join(dataDir, 'hidden.json');
  const settingsFile = path.join(dataDir, 'settings.json');

  let hidden = new Set();
  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let loaded = false;

  function normalizeIds(list) {
    const set = new Set();
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const id = item.trim();
      if (id) set.add(id);
    }
    return set;
  }

  function atomicWrite(file, payload) {
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

  function loadHidden() {
    try {
      const raw = fs.readFileSync(hiddenFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.hiddenIds)) {
        hidden = normalizeIds(parsed.hiddenIds);
      } else {
        hidden = new Set();
        log('[preferences] hidden.json 结构不合法，按空配置处理');
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        log('[preferences] 读取隐藏配置失败，按空配置处理：' + String((err && err.message) || err));
      }
      hidden = new Set();
    }
  }

  function loadSettings() {
    settings = Object.assign({}, DEFAULT_SETTINGS);
    try {
      const raw = fs.readFileSync(settingsFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.monitorEnabled === 'boolean') {
        settings.monitorEnabled = parsed.monitorEnabled;
      }
      if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'llmSelection')) {
        settings.llmSelection = normalizeLlmSelection(parsed.llmSelection);
      }
      if (parsed && typeof parsed.autoUpdate === 'boolean') {
        settings.autoUpdate = parsed.autoUpdate;
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        log('[preferences] 读取运行时设置失败，使用默认值：' + String((err && err.message) || err));
      }
    }
  }

  function load() {
    loadHidden();
    loadSettings();
    loaded = true;
    return stats();
  }

  function saveHidden() {
    atomicWrite(hiddenFile, { version: 1, hiddenIds: Array.from(hidden).sort() });
    return hidden.size;
  }

  function saveSettings() {
    atomicWrite(settingsFile, {
      version: 3,
      monitorEnabled: Boolean(settings.monitorEnabled),
      llmSelection: cloneSelection(settings.llmSelection),
      autoUpdate: Boolean(settings.autoUpdate)
    });
    return getSettings();
  }

  /** 同时写隐藏配置与运行时设置（shutdown 等场景调用）。 */
  function save() {
    const hiddenCount = saveHidden();
    saveSettings();
    return hiddenCount;
  }

  function hiddenIds() {
    return Array.from(hidden).sort();
  }

  function isHidden(id) {
    return hidden.has(String(id));
  }

  /** 幂等：返回是否发生了变化。 */
  function setHidden(id, shouldHide) {
    const key = String(id == null ? '' : id).trim();
    if (!key) return false;
    const before = hidden.has(key);
    if (shouldHide) hidden.add(key);
    else hidden.delete(key);
    return hidden.has(key) !== before;
  }

  function hiddenCount() {
    return hidden.size;
  }

  function getSettings() {
    return Object.assign({}, settings, { llmSelection: cloneSelection(settings.llmSelection) });
  }

  /**
   * 只接受已知字段：
   *  - monitorEnabled 必须是 boolean；
   *  - llmSelection 必须是 { provider, model } 两个非空字符串，或显式 null（跟随 DSH 默认）。
   *    非法值忽略并保留旧值。
   */
  function updateSettings(patch) {
    if (!patch || typeof patch !== 'object') return getSettings();
    if (typeof patch.monitorEnabled === 'boolean') {
      settings.monitorEnabled = patch.monitorEnabled;
    }
    if (typeof patch.autoUpdate === 'boolean') {
      settings.autoUpdate = patch.autoUpdate;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'llmSelection')) {
      if (patch.llmSelection === null) {
        settings.llmSelection = null;
      } else {
        const normalized = normalizeLlmSelection(patch.llmSelection);
        if (normalized) settings.llmSelection = normalized;
      }
    }
    return getSettings();
  }

  function stats() {
    return {
      hiddenCount: hidden.size,
      hiddenIds: hiddenIds(),
      settings: getSettings(),
      loaded: loaded
    };
  }

  return {
    load: load,
    save: save,
    saveHidden: saveHidden,
    saveSettings: saveSettings,
    hiddenIds: hiddenIds,
    isHidden: isHidden,
    setHidden: setHidden,
    hiddenCount: hiddenCount,
    getSettings: getSettings,
    updateSettings: updateSettings,
    stats: stats
  };
}
