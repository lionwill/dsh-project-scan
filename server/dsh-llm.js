/**
 * server/dsh-llm.js — 轻量复用本机 DSH 的渠道与模型（用于 AI 摘要）
 *
 * 只做三件事：
 *   1) 从 DSH profile 的 cordis.patch.yml 读出 llm-pi-ai 配置的渠道（provider）与模型名；
 *   2) 解析渠道的 apiKeyEnv（key 只从环境变量 / DSH 凭据文件读取，不在本项目保存或缓存）；
 *   3) 返回 OpenAI 兼容请求所需的最少信息（baseURL / model / key）。
 *
 * 不实现完整的 LLM 接入：只支持 OpenAI 兼容的 Chat Completions；模型/渠道数据都来自 DSH 配置。
 * 不修改 DSH 目录，完整 key 不写日志、不写 data/、不返回给前端（只给掩码）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 少数常见 provider 的默认显示名（DSH 配置里没写 displayName 时兜底）。 */
const DEFAULT_NAMES = {
  'opencode-go': 'OpenCode Go',
  opencode: 'OpenCode',
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  openrouter: 'OpenRouter'
};

/** 少数常见 provider 的默认接口地址（DSH 配置里没写 baseURL 时兜底）。 */
const DEFAULT_BASE_URLS = {
  'opencode-go': 'https://opencode.ai/inference/go/v1',
  opencode: 'https://opencode.ai/inference/v1',
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1'
};

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    return null;
  }
}

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch (err) {
    return false;
  }
}

function trimQuotes(value) {
  const text = String(value || '').trim();
  if (text.length >= 2 && ((text[0] === '"' && text.endsWith('"')) || (text[0] === "'" && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function channelError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 顶层数组条目：以 `- ` 开头的行开启一个新块。 */
function splitEntries(text) {
  const entries = [];
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^-\s/.test(line)) {
      current = [line];
      entries.push(current);
    } else if (current) {
      current.push(line);
    }
  }
  return entries;
}

function entryId(blockText) {
  const idMatch = blockText.match(/^-\s+id:\s*(\S+)/m);
  if (idMatch) return idMatch[1];
  const nameMatch = blockText.match(/^-\s+name:\s*(.+)$/m);
  return nameMatch ? trimQuotes(nameMatch[1]) : '';
}

function fieldValue(blockText, field) {
  const match = blockText.match(new RegExp('^\\s+' + field + ':\\s*(.+)$', 'm'));
  return match ? trimQuotes(match[1]) : '';
}

/** 取 `providers:` 下某个 provider 的配置块（保留块内所有行，用于继续解析 models / modelOverrides）。 */
function providerBlock(blockText, provider) {
  const lines = blockText.split(/\r?\n/);
  let providersIndent = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s+providers:\s*$/.test(lines[i])) {
      providersIndent = lines[i].match(/^\s*/)[0].length;
      break;
    }
  }
  if (providersIndent === -1) return null;
  const providerIndent = providersIndent + 2;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(\s+)([A-Za-z0-9._-]+):\s*$/);
    if (!match || match[1].length !== providerIndent) continue;
    if (match[2] === provider) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= providerIndent) break;
    block.push(line);
  }
  return { indent: providerIndent, lines: block, text: block.join('\n') };
}

/** 找到某个 `key:` 锚点所在行号（锚点缩进已知）。 */
function anchorIndex(lines, indent) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.match(/^\s*/)[0].length === indent && /:\s*$/.test(line)) return i;
  }
  return -1;
}

/** 解析 provider 块里的 models 列表：[{ id, name }]。 */
function parseModelsList(block) {
  const lines = block.lines;
  let modelsIndent = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s+models:\s*$/.test(lines[i])) {
      modelsIndent = lines[i].match(/^\s*/)[0].length;
      break;
    }
  }
  if (modelsIndent === -1) return [];
  const models = [];
  let item = null;
  for (let i = anchorIndex(lines, modelsIndent) + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= modelsIndent) break;
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch) {
      const idMatch = listMatch[1].match(/^id:\s*(.+)$/);
      item = { id: idMatch ? trimQuotes(idMatch[1]) : '', name: '' };
      if (item.id) models.push(item);
      continue;
    }
    if (!item) continue;
    const nameMatch = line.match(/^\s+name:\s*(.+)$/);
    if (nameMatch) item.name = trimQuotes(nameMatch[1]);
  }
  return models.filter(function (model) { return isNonEmptyString(model.id); });
}

/** 解析 provider 块里的 modelOverrides 映射：key 是模型 id，value.name 是显示名。 */
function parseModelOverrides(block) {
  const lines = block.lines;
  let overridesIndent = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s+modelOverrides:\s*$/.test(lines[i])) {
      overridesIndent = lines[i].match(/^\s*/)[0].length;
      break;
    }
  }
  if (overridesIndent === -1) return [];
  const models = [];
  let current = null;
  for (let i = anchorIndex(lines, overridesIndent) + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= overridesIndent) break;
    const entryMatch = line.match(/^(\s+)([A-Za-z0-9._-]+):\s*$/);
    if (entryMatch && entryMatch[1].length === overridesIndent + 2) {
      current = { id: entryMatch[2], name: '' };
      models.push(current);
      continue;
    }
    if (!current) continue;
    const nameMatch = line.match(/^\s+name:\s*(.+)$/);
    if (nameMatch) current.name = trimQuotes(nameMatch[1]);
  }
  return models.filter(function (model) { return isNonEmptyString(model.id); });
}

/** 从 .credentials.yaml 的 refs 里取一个 key（按行解析，不引 YAML 依赖）。 */
function credentialValue(credentialsText, refName) {
  if (!credentialsText) return '';
  const lines = credentialsText.split(/\r?\n/);
  let inRefs = false;
  let refsIndent = -1;
  for (const line of lines) {
    if (/^\s*refs:\s*$/.test(line)) {
      inRefs = true;
      refsIndent = line.match(/^\s*/)[0].length;
      continue;
    }
    if (!inRefs) continue;
    if (line.trim() === '') continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= refsIndent) break;
    const match = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$/);
    if (match && match[1] === refName) return trimQuotes(match[2]);
  }
  return '';
}

/** 掩码显示 key，只保留首尾。 */
export function maskKey(key) {
  const value = String(key || '');
  if (!value) return '';
  if (value.length <= 8) return '***';
  return value.slice(0, 4) + '…' + value.slice(-4);
}

/**
 * @param {{ dshHome?: string, profile?: string, env?: object, log?: (msg: string) => void }} options
 */
export function createDshLlm(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  const dshHome = path.resolve(opts.dshHome || env.PROJECT_SCAN_DSH_HOME || env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const preferredProfile = opts.profile || env.DSH_PROFILE || '';

  function profilePatchPath() {
    const profilesDir = path.join(dshHome, 'profiles');
    if (!isDir(profilesDir)) return null;
    if (preferredProfile) {
      const preferred = path.join(profilesDir, preferredProfile, 'cordis.patch.yml');
      if (fs.existsSync(preferred)) return preferred;
    }
    try {
      const names = fs
        .readdirSync(profilesDir, { withFileTypes: true })
        .filter(function (entry) { return entry.isDirectory() && !entry.name.startsWith('.'); })
        .map(function (entry) { return entry.name; })
        .sort();
      for (const name of names) {
        const candidate = path.join(profilesDir, name, 'cordis.patch.yml');
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch (err) {
      return null;
    }
    return null;
  }

  /** 解析 DSH 配置：默认模型 + 所有 OpenAI 兼容渠道及其模型。 */
  function discover() {
    const patchPath = profilePatchPath();
    const result = { home: dshHome, found: Boolean(patchPath), profile: null, defaultProvider: '', defaultModel: '', channels: [] };
    if (!patchPath) return result;
    result.profile = path.basename(path.dirname(patchPath));
    const patchText = readText(patchPath);
    if (!patchText) return result;
    const entries = splitEntries(patchText);
    let llmEntry = '';
    for (const entry of entries) {
      const block = entry.join('\n');
      const id = entryId(block);
      if (id === 'agent-default-model' || /dsh-agent-default-model/.test(id)) {
        result.defaultProvider = fieldValue(block, 'provider');
        result.defaultModel = fieldValue(block, 'model');
      } else if (id === 'llm-pi-ai' || /dsh-llm-pi-ai/.test(id)) {
        llmEntry = block;
      }
    }
    if (!llmEntry) return result;

    const credentialsText = readText(path.join(dshHome, '.credentials.yaml'));
    const lines = llmEntry.split(/\r?\n/);
    let providersIndent = -1;
    for (const line of lines) {
      if (/^\s+providers:\s*$/.test(line)) {
        providersIndent = line.match(/^\s*/)[0].length;
        break;
      }
    }
    if (providersIndent === -1) return result;
    const providerIds = [];
    for (const line of lines) {
      const match = line.match(/^(\s+)([A-Za-z0-9._-]+):\s*$/);
      if (match && match[1].length === providersIndent + 2) providerIds.push(match[2]);
    }

    for (const providerId of providerIds) {
      const block = providerBlock(llmEntry, providerId);
      if (!block) continue;
      const api = fieldValue(block.text, 'api') || 'openai-completions';
      if (api !== 'openai-completions') continue; // 最小实现只接 OpenAI 兼容渠道
      const baseUrl = (fieldValue(block.text, 'baseURL') || DEFAULT_BASE_URLS[providerId] || '').replace(/\/+$/, '');
      if (!baseUrl) continue;
      const keyEnv = fieldValue(block.text, 'apiKeyEnv') || '';
      const models = dedupeModels(parseModelsList(block).concat(parseModelOverrides(block)));
      const defaultModel = providerId === result.defaultProvider ? result.defaultModel : '';
      if (models.length === 0 && defaultModel) models.push({ id: defaultModel, name: defaultModel });
      if (models.length === 0) continue;
      const resolvedKey = resolveKey(keyEnv, credentialsText);
      result.channels.push({
        id: providerId,
        name: fieldValue(block.text, 'displayName') || DEFAULT_NAMES[providerId] || providerId,
        api: api,
        baseUrl: baseUrl,
        keyEnv: keyEnv,
        keyConfigured: Boolean(resolvedKey.value),
        keyMasked: resolvedKey.value ? maskKey(resolvedKey.value) : '',
        keySource: resolvedKey.value ? resolvedKey.source : null,
        models: models,
        defaultModel: defaultModel || models[0].id,
        reason: resolvedKey.value ? null : '缺少 API key：' + (keyEnv || 'apiKeyEnv 未配置')
      });
    }
    return result;
  }

  function dedupeModels(models) {
    const seen = new Set();
    const out = [];
    for (const model of models) {
      if (!model || !isNonEmptyString(model.id) || seen.has(model.id)) continue;
      seen.add(model.id);
      out.push({ id: model.id, name: model.name || model.id });
    }
    return out;
  }

  function resolveKey(keyEnv, credentialsText) {
    if (!isNonEmptyString(keyEnv)) return { value: '', source: null };
    if (isNonEmptyString(env[keyEnv])) return { value: String(env[keyEnv]).trim(), source: 'env' };
    const stored = credentialValue(credentialsText, keyEnv);
    if (stored) return { value: stored, source: 'dsh-credentials' };
    return { value: '', source: null };
  }

  /** 对外（前端）渠道列表：不含完整 key。 */
  function listChannels() {
    const discovered = discover();
    return {
      dsh: { home: discovered.home, found: discovered.found, profile: discovered.profile },
      defaultProvider: discovered.defaultProvider,
      defaultModel: discovered.defaultModel,
      channels: discovered.channels.map(function (channel) {
        return {
          id: channel.id,
          name: channel.name,
          api: channel.api,
          keyConfigured: channel.keyConfigured,
          keyMasked: channel.keyMasked,
          keySource: channel.keySource,
          models: channel.models,
          defaultModel: channel.defaultModel,
          reason: channel.reason
        };
      })
    };
  }

  function findChannel(channels, provider) {
    return channels.find(function (channel) { return channel.id === provider; }) || null;
  }

  /** 默认渠道（DSH 的 agent-default-model）→ 内部目标；不可用返回 null / 抛错。 */
  function resolve() {
    const discovered = discover();
    if (!discovered.found) return null;
    if (!discovered.defaultProvider || !discovered.defaultModel) return null;
    const channel = findChannel(discovered.channels, discovered.defaultProvider);
    if (!channel) return null;
    if (!channel.keyConfigured) {
      throw channelError('KEY_MISSING', 'DSH 渠道 ' + channel.name + ' ' + (channel.reason || '缺少 API key'));
    }
    return targetOf(channel, discovered.defaultModel, 'default', discovered);
  }

  /** 用户选择 { provider, model } → 内部目标；错误带稳定 code。 */
  function resolveSelection(selection) {
    if (!selection || typeof selection !== 'object') {
      throw channelError('INVALID_SELECTION', '需要 provider 与 model 两个非空字符串。');
    }
    const provider = isNonEmptyString(selection.provider) ? String(selection.provider).trim() : '';
    const model = isNonEmptyString(selection.model) ? String(selection.model).trim() : '';
    if (!provider || !model) throw channelError('INVALID_SELECTION', '需要 provider 与 model 两个非空字符串。');
    const discovered = discover();
    const channel = findChannel(discovered.channels, provider);
    if (!channel) throw channelError('CHANNEL_NOT_FOUND', '找不到渠道：' + provider);
    if (!channel.models.some(function (item) { return item.id === model; })) {
      throw channelError('MODEL_NOT_FOUND', '渠道「' + channel.name + '」没有模型 ' + model);
    }
    if (!channel.keyConfigured) {
      throw channelError('KEY_MISSING', '渠道「' + channel.name + '」' + (channel.reason || '缺少 API key'));
    }
    return targetOf(channel, model, 'custom', discovered);
  }

  function targetOf(channel, model, source, discovered) {
    const credentialsText = readText(path.join(dshHome, '.credentials.yaml'));
    const resolvedKey = resolveKey(channel.keyEnv, credentialsText);
    return {
      source: source,
      provider: channel.id,
      providerName: channel.name,
      model: model,
      modelName: (channel.models.find(function (item) { return item.id === model; }) || {}).name || model,
      api: channel.api,
      baseUrl: channel.baseUrl,
      apiKey: resolvedKey.value,
      keyMasked: maskKey(resolvedKey.value),
      keySource: resolvedKey.source,
      opencode: /^opencode(-go)?$/.test(channel.id),
      profile: discovered.profile,
      dshHome: discovered.home
    };
  }

  function describeSelection(selection) {
    try {
      if (selection) {
        const target = resolveSelection(selection);
        return {
          source: 'custom',
          provider: target.provider,
          model: target.model,
          channelName: target.providerName,
          api: target.api,
          keyConfigured: true,
          keyMasked: target.keyMasked,
          baseUrlHost: hostOf(target.baseUrl),
          error: null
        };
      }
      const target = resolve();
      if (!target) {
        return { source: 'default', provider: null, model: null, channelName: null, api: null, keyConfigured: false, keyMasked: '', baseUrlHost: null, error: '未找到 DSH 默认模型配置' };
      }
      return {
        source: 'default',
        provider: target.provider,
        model: target.model,
        channelName: target.providerName,
        api: target.api,
        keyConfigured: true,
        keyMasked: target.keyMasked,
        baseUrlHost: hostOf(target.baseUrl),
        error: null
      };
    } catch (err) {
      const normalized = selection && typeof selection === 'object' ? selection : {};
      return {
        source: selection ? 'custom' : 'default',
        provider: normalized.provider || null,
        model: normalized.model || null,
        channelName: null,
        api: null,
        keyConfigured: false,
        keyMasked: '',
        baseUrlHost: null,
        error: String((err && err.message) || err)
      };
    }
  }

  function hostOf(baseUrl) {
    try {
      return new URL(baseUrl).host;
    } catch (err) {
      return null;
    }
  }

  /** 兼容旧接口：返回默认渠道的描述（不含完整 key）。 */
  function describe() {
    const info = describeSelection(null);
    return {
      available: info.keyConfigured && !info.error,
      provider: info.provider,
      model: info.model,
      keyMasked: info.keyMasked,
      keySource: info.source === 'default' ? 'dsh-credentials' : null,
      reason: info.error
    };
  }

  return {
    dshHome: dshHome,
    discover: discover,
    listChannels: listChannels,
    resolve: resolve,
    resolveSelection: resolveSelection,
    describe: describe,
    describeSelection: describeSelection,
    maskKey: maskKey
  };
}

export default createDshLlm;
