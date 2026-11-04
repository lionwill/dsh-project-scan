import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanWorkspace } from './scanner.js';
import { createScheduler } from './scheduler.js';
import { createRunner } from './runner.js';
import { createStore } from './store.js';
import { createLLM } from './llm.js';
import { createDshLlm } from './dsh-llm.js';
import { createWorkspaces } from './workspaces.js';
import { createFsBrowse } from './fs-browse.js';
import { createPreferences } from './preferences.js';
import { createDiskUsage } from './disk-usage.js';
import { createMonitor } from './monitor.js';
import { createUpdater } from './updater.js';
import { createExternalRuns } from './external-runs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const DATA_DIR = path.resolve(process.env.PROJECT_SCAN_DATA_DIR || path.join(APP_DIR, 'data'));
const WORKSPACE_ROOT = path.resolve(process.env.PROJECT_SCAN_ROOT || path.resolve(APP_DIR, '..'));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8790);
const VERSION = '1.0.0';
const FENCE = String.fromCharCode(96, 96, 96);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type'
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf'
};

let scanConfig = {};
try {
  scanConfig = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'config.json'), 'utf8'));
} catch (err) {
  scanConfig = {};
}

const store = createStore({ dataDir: DATA_DIR, root: WORKSPACE_ROOT });
const dshLlm = createDshLlm({ log: function (message) { console.log(message); } });
const llm = createLLM({
  dataDir: DATA_DIR,
  log: function (message) { console.log(message); },
  dshLlm: dshLlm,
  getSelection: function () { return preferences.getSettings().llmSelection; }
});
const workspaces = createWorkspaces({
  dataDir: DATA_DIR,
  defaultRoot: WORKSPACE_ROOT,
  log: function (message) { console.log(message); }
});
const fsBrowse = createFsBrowse({ defaultRoot: WORKSPACE_ROOT });
const preferences = createPreferences({
  dataDir: DATA_DIR,
  log: function (message) { console.log(message); }
});
const diskUsage = createDiskUsage({ log: function (message) { console.log(message); } });
const monitor = createMonitor({ log: function (message) { console.log(message); } });
const updater = createUpdater({
  appDir: APP_DIR,
  log: function (message) { console.log(message); },
  onEvent: function (payload) { broadcast('update', payload); }
});
const externalRuns = createExternalRuns({
  log: function (message) { console.log(message); },
  getProjects: function () { return store.allProjects().map(function (project) { return { id: project.id, path: project.path }; }); }
});
let externalRunsTimer = null;
const MAX_WORKSPACES = 10;
const sseClients = new Set();
const activeRuns = new Map();
let scanning = false;
let pendingScan = false;
let lastScanError = null;
let enrichTimer = null;
let enrichmentInFlight = false;
let diskTimer = null;
let diskInFlight = false;

function runningProjectRefs() {
  const list = [];
  for (const [projectId, run] of activeRuns) {
    if (!run || !run.pid) continue;
    if (run.status !== 'starting' && run.status !== 'running') continue;
    list.push({ projectId: projectId, pid: run.pid, status: run.status });
  }
  return list;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function isRunActiveStatus(status) {
  return status === 'starting' || status === 'running';
}

/** 扫描器服务自身也会作为一条「运行中」记录展示（它由外部 start.sh 启动，不能单独重启/停止）。 */
function scannerRunningEntry() {
  const uptimeSec = Math.round(process.uptime());
  return {
    projectId: null,
    name: '项目雷达扫描器',
    workspaceId: null,
    workspaceName: '本地服务',
    parentId: null,
    relPath: '',
    status: 'running',
    url: 'http://' + HOST + ':' + PORT + '/',
    pid: process.pid,
    startedAt: new Date(Date.now() - uptimeSec * 1000).toISOString(),
    uptimeSec: uptimeSec,
    command: null,
    isScannerProject: true,
    kind: 'scanner'
  };
}

/** 当前 runner 管理且处于 starting/running 的项目（含子项目）。默认把扫描器自身也放最前面。 */
function listRunningProjects(options) {
  const opts = options || {};
  const running = [];
  for (const project of store.allProjects()) {
    const run = runner.state(project.id);
    if (!run || !isRunActiveStatus(run.status)) continue;
    running.push({
      projectId: project.id,
      name: project.name,
      workspaceId: project.workspaceId || 'main',
      workspaceName: project.workspaceName || path.basename(WORKSPACE_ROOT),
      parentId: project.parentId || null,
      relPath: project.relPath || '',
      status: run.status,
      url: run.url || null,
      pid: run.pid == null ? null : run.pid,
      startedAt: run.startedAt || null,
      uptimeSec: run.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(run.startedAt)) / 1000)) : 0,
      command: run.command || null,
      isScannerProject: path.resolve(project.path) === APP_DIR
    });
  }
  // 外部启动的实例（不是本服务 runner 启动的）：也列入「运行中」，前端以只读方式展示
  if (opts.includeExternal !== false) {
    for (const project of store.allProjects()) {
      if (isScannerProject(project)) continue;
      const managed = runner.state(project.id);
      if (managed && isRunActiveStatus(managed.status)) continue;
      const external = externalRuns.matchFor(project.id);
      if (!external) continue;
      running.push({
        projectId: project.id,
        name: project.name,
        workspaceId: project.workspaceId || 'main',
        workspaceName: project.workspaceName || path.basename(WORKSPACE_ROOT),
        parentId: project.parentId || null,
        relPath: project.relPath || '',
        status: 'running',
        url: external.url,
        pid: external.pid,
        startedAt: null,
        uptimeSec: 0,
        command: null,
        isScannerProject: false,
        isExternalProject: true,
        external: true
      });
    }
  }
  running.sort(function (a, b) {
    return String(b.startedAt || '').localeCompare(String(a.startedAt || ''));
  });
  if (opts.includeScanner !== false) running.unshift(scannerRunningEntry());
  return running;
}

async function waitForRunExit(projectId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = runner.state(projectId);
    if (!run || !isRunActiveStatus(run.status)) return true;
    await sleep(120);
  }
  const current = runner.state(projectId);
  return !current || !isRunActiveStatus(current.status);
}

async function restartProjectRun(project) {
  const current = runner.state(project.id);
  if (!current || !isRunActiveStatus(current.status)) {
    const error = new Error('这个项目当前没有在运行。');
    error.code = 'NOT_RUNNING';
    throw error;
  }
  runner.stop(project.id);
  const exited = await waitForRunExit(project.id, 8000);
  if (!exited) {
    const error = new Error('停止旧实例超时，未能重启。');
    error.code = 'RESTART_TIMEOUT';
    throw error;
  }
  return runner.run(project);
}

async function stopAllRunning(includeScanner) {
  const entries = listRunningProjects({ includeScanner: false });
  const stopped = [];
  const failed = [];
  for (const entry of entries) {
    try {
      runner.stop(entry.projectId);
    } catch (err) {
      failed.push({ projectId: entry.projectId, message: String((err && err.message) || err) });
    }
  }
  const pending = new Set(entries.map(function (entry) { return entry.projectId; }));
  for (const item of failed) pending.delete(item.projectId);
  const deadline = Date.now() + 8000;
  while (pending.size > 0 && Date.now() < deadline) {
    for (const projectId of Array.from(pending)) {
      const run = runner.state(projectId);
      if (!run || !isRunActiveStatus(run.status)) pending.delete(projectId);
    }
    if (pending.size > 0) await sleep(120);
  }
  for (const entry of entries) {
    if (pending.has(entry.projectId)) failed.push({ projectId: entry.projectId, message: '停止超时' });
    else stopped.push(entry.projectId);
  }
  const allowScannerStop = String(process.env.PROJECT_SCAN_ALLOW_SCANNER_STOP || 'on').toLowerCase() !== 'off';
  const scannerStopped = Boolean(includeScanner && allowScannerStop);
  if (scannerStopped) {
    setTimeout(function () { shutdown('stop-all'); }, 500);
  }
  return {
    stopped: stopped,
    failed: failed,
    includeScanner: Boolean(includeScanner),
    scannerStopped: scannerStopped
  };
}

function applyMonitorSetting(enabled) {
  try {
    if (enabled) {
      monitor.setEnabled(true);
      monitor.start(runningProjectRefs);
    } else {
      monitor.setEnabled(false);
      monitor.stop();
    }
  } catch (err) {
    console.error('[monitor] 切换监控状态失败：' + ((err && err.message) || err));
  }
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  }, CORS));
  res.end(data);
}

function apiError(res, status, code, message) {
  json(res, status, { error: { code: code, message: message } });
}

function sendEvent(res, event, data) {
  try {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  } catch (err) {
    sseClients.delete(res);
  }
}

function broadcast(event, data) {
  for (const client of sseClients) sendEvent(client, event, data);
}

const runner = createRunner({
  root: WORKSPACE_ROOT,
  onUpdate: function (run) {
    if (run && run.projectId) {
      if (run.status === 'starting' || run.status === 'running') activeRuns.set(run.projectId, run);
      else activeRuns.delete(run.projectId);
    }
    broadcast('run', run);
  }
});

const scheduler = createScheduler({
  intervalMinutes: Number(process.env.SCAN_INTERVAL_MINUTES || 20),
  startHour: Number(process.env.SCAN_START_HOUR || 9),
  endHour: Number(process.env.SCAN_END_HOUR || 20),
  runScan: async function (context) {
    const result = await doScan((context && context.reason) || 'scheduler');
    return { meta: currentMeta(), diff: (result && result.diff) || null };
  },
  onEvent: function (type, payload) {
    broadcast(type, payload);
  }
});

/** 给扫描出来的项目补上工作区信息，并保证项目 id 全局唯一（非默认工作区加前缀）。 */
function stampWorkspaceProjects(projects, workspace, usedIds) {
  const prefix = workspace.isDefault ? '' : workspace.id + '--';
  return projects.map(function (project) {
    const oldParentId = project.id;
    const base = prefix + oldParentId;
    let id = base;
    let seq = 2;
    while (usedIds.has(id)) {
      id = base + '-' + seq;
      seq += 1;
    }
    usedIds.add(id);
    const stamped = Object.assign({}, project, {
      id: id,
      parentId: null,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: workspace.path
    });
    stamped.children = (project.children || []).map(function (child) {
      const suffix = String(child.id).indexOf(oldParentId) === 0
        ? String(child.id).slice(oldParentId.length)
        : '--' + String(child.id);
      const childId = id + suffix;
      usedIds.add(childId);
      return Object.assign({}, child, {
        id: childId,
        parentId: id,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspacePath: workspace.path
      });
    });
    return stamped;
  });
}

function reserveExistingIds(projects, usedIds) {
  for (const project of projects) {
    usedIds.add(project.id);
    for (const child of project.children || []) usedIds.add(child.id);
  }
}

/** 当前工作区列表 + 每个工作区的项目数（以内存中的工作区配置为准，统计来自 store）。 */
function workspaceMeta() {
  const stored = new Map();
  for (const item of Array.isArray(store.meta.workspaces) ? store.meta.workspaces : []) {
    stored.set(item.id, item);
  }
  const counts = new Map();
  for (const project of store.list()) {
    const key = project.workspaceId || 'main';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return workspaces.list().map(function (ws) {
    const previous = stored.get(ws.id) || {};
    return {
      id: ws.id,
      name: ws.name,
      path: ws.path,
      isDefault: Boolean(ws.isDefault),
      addedAt: ws.addedAt || null,
      projectCount: counts.get(ws.id) || 0,
      durationMs: previous.durationMs || 0,
      error: previous.error || null
    };
  });
}

function readJsonBody(req, limitBytes) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > (limitBytes || 64 * 1024)) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function isScannerProject(project) {
  return Boolean(project && project.path && path.resolve(project.path) === APP_DIR);
}

/** 扫描器项目（project-scan 自身）始终在运行（页面就是它提供的），注入一个合成 RunState。 */
function scannerServiceRunState(projectId) {
  const uptimeSec = Math.round(process.uptime());
  return {
    runId: 'scanner-service',
    projectId: projectId,
    status: 'running',
    url: 'http://' + HOST + ':' + PORT + '/',
    command: null,
    cwd: APP_DIR,
    pid: process.pid,
    startedAt: new Date(Date.now() - uptimeSec * 1000).toISOString(),
    endedAt: null,
    exitCode: null,
    log: ['[project-scan] 扫描器服务正在运行（由外部 start.sh 启动，不能单独停止）']
  };
}

/** 外部启动（非本服务 runner）的运行实例 → 兼容 RunState 的只读快照。 */
function externalRunState(projectId, entry) {
  return {
    runId: 'external-' + entry.pid,
    projectId: projectId,
    status: 'running',
    url: entry.url,
    command: null,
    cwd: entry.cwd,
    pid: entry.pid,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    log: ['[external] 检测到外部启动的服务：' + entry.command + '（PID ' + entry.pid + '）'],
    external: true
  };
}

/** 项目当前生效的运行状态：runner 管理的优先，其次外部检测到的实例。 */
function runStateFor(project) {
  const managed = runner.state(project.id);
  if (managed) return managed;
  if (isScannerProject(project)) return null;
  const external = externalRuns.matchFor(project.id);
  return external ? externalRunState(project.id, external) : null;
}

function serializeProject(project) {
  let runInfo;
  try {
    runInfo = runner.detect(project);
  } catch (err) {
    runInfo = {
      runnable: false,
      kind: 'none',
      command: null,
      runHint: '不可运行',
      reason: '运行入口检测失败'
    };
  }
  const payload = Object.assign({}, project, {
    runnable: Boolean(runInfo.runnable),
    runKind: runInfo.kind || 'none',
    runHint: runInfo.runHint || '',
    runInfo: runInfo,
    run: isScannerProject(project) ? scannerServiceRunState(project.id) : runStateFor(project),
    isScanner: isScannerProject(project),
    hidden: preferences.isHidden(project.parentId || project.id)
  });
  payload.children = (project.children || []).map(function (child) {
    return serializeProject(child);
  });
  return payload;
}

function currentMeta() {
  const schedulerStatus = scheduler.status();
  const topLevel = store.list();
  const meta = Object.assign({}, store.meta, {
    root: WORKSPACE_ROOT,
    version: VERSION,
    count: topLevel.length,
    subprojectCount: store.allProjects().length - topLevel.length,
    hiddenCount: topLevel.filter(function (project) { return preferences.isHidden(project.id); }).length,
    workspaces: workspaceMeta(),
    currentWorkspaceId: 'main',
    scheduler: Object.assign({}, schedulerStatus, { running: scanning }),
    llm: llm.status()
  });
  if (lastScanError) meta.lastScanError = lastScanError;
  return meta;
}

async function doScan(reason) {
  if (scanning) return { skipped: true };
  scanning = true;
  lastScanError = null;
  const startedAt = new Date().toISOString();
  broadcast('scan:start', { startedAt: startedAt, reason: reason || 'manual' });
  const t0 = Date.now();
  try {
    const workspaceList = workspaces.list();
    const previousProjects = store.list();
    const previousByWorkspace = new Map();
    for (const project of previousProjects) {
      const key = project.workspaceId || 'main';
      if (!previousByWorkspace.has(key)) previousByWorkspace.set(key, []);
      previousByWorkspace.get(key).push(project);
    }

    const usedIds = new Set();
    const merged = [];
    const workspaceStats = [];
    const excluded = [];
    const scanErrors = [];

    for (const workspace of workspaceList) {
      const wsStart = Date.now();
      try {
        const result = await scanWorkspace({ root: workspace.path, config: scanConfig });
        const stats = (result && result.stats) || {};
        const stamped = stampWorkspaceProjects(result.projects || [], workspace, usedIds);
        merged.push(...stamped);
        workspaceStats.push({
          id: workspace.id,
          name: workspace.name,
          path: workspace.path,
          isDefault: Boolean(workspace.isDefault),
          addedAt: workspace.addedAt || null,
          projectCount: stamped.length,
          durationMs: stats.durationMs || (Date.now() - wsStart),
          error: null
        });
        for (const item of stats.excluded || []) {
          excluded.push(Object.assign({ workspaceId: workspace.id, workspaceName: workspace.name }, item));
        }
      } catch (err) {
        // 单个工作区失败：保留它上一次的项目，不影响其他工作区
        const message = String((err && err.message) || err);
        const kept = previousByWorkspace.get(workspace.id) || [];
        reserveExistingIds(kept, usedIds);
        merged.push(...kept);
        workspaceStats.push({
          id: workspace.id,
          name: workspace.name,
          path: workspace.path,
          isDefault: Boolean(workspace.isDefault),
          addedAt: workspace.addedAt || null,
          projectCount: kept.length,
          durationMs: Date.now() - wsStart,
          error: message
        });
        scanErrors.push({ workspaceId: workspace.id, name: workspace.name, message: message });
        console.error('[scan] 工作区 ' + workspace.name + ' 扫描失败：' + message);
      }
    }

    const applied = store.applyScan(merged, { durationMs: Date.now() - t0 });
    store.setMeta({
      root: WORKSPACE_ROOT,
      scannedAt: new Date().toISOString(),
      scanDurationMs: Date.now() - t0,
      count: applied.projects.length,
      excluded: excluded,
      workspaces: workspaceStats,
      scanErrors: scanErrors
    });
    const changed = applied.diff.added + applied.diff.updated + applied.diff.removed > 0;
    if (changed || !fs.existsSync(path.join(DATA_DIR, 'projects.json'))) store.save();
    const projects = applied.projects.map(serializeProject);
    if (changed) broadcast('projects', { projects: projects });
    broadcast('scan:done', { meta: currentMeta(), diff: applied.diff });
    if (changed || !llm.status().lastRunAt) scheduleEnrichment(300);
    scheduleDiskUsage(400);
    console.log('[scan] ' + (reason || 'manual') + ' 完成：' + projects.length + ' 个项目 / ' + workspaceList.length + ' 个工作区，新增 ' + applied.diff.added + '，更新 ' + applied.diff.updated + '，移除 ' + applied.diff.removed + '，耗时 ' + (Date.now() - t0) + 'ms');
    return { diff: applied.diff, projects: projects };
  } catch (err) {
    lastScanError = { at: new Date().toISOString(), message: String((err && err.message) || err) };
    console.error('[scan] 失败：' + lastScanError.message);
    broadcast('scan:error', lastScanError);
    throw err;
  } finally {
    scanning = false;
    if (pendingScan) {
      pendingScan = false;
      setTimeout(function () { doScan('pending').catch(function () {}); }, 80);
    }
  }
}

function scheduleDiskUsage(delayMs) {
  if (diskTimer || diskInFlight) return;
  diskTimer = setTimeout(function () {
    diskTimer = null;
    runDiskUsage();
  }, Math.max(0, delayMs || 0));
  if (diskTimer && typeof diskTimer.unref === 'function') diskTimer.unref();
}

async function runDiskUsage() {
  if (diskInFlight) return;
  const projects = store.allProjects().map(function (project) {
    return { id: project.id, path: project.path };
  });
  if (projects.length === 0) return;
  diskInFlight = true;
  try {
    const result = await diskUsage.compute(projects);
    const applied = store.applyUsage(result);
    if (applied > 0) store.save();
    broadcast('projects', { projects: store.list().map(serializeProject) });
    console.log('[disk] 磁盘占用更新：' + applied + ' 个项目（' + projects.length + ' 个路径）');
  } catch (err) {
    console.error('[disk] 磁盘占用计算失败：' + ((err && err.message) || err));
  } finally {
    diskInFlight = false;
  }
}

function scheduleEnrichment(delayMs) {
  if (!llm.available) return;
  if (enrichTimer || enrichmentInFlight) return;
  enrichTimer = setTimeout(function () {
    enrichTimer = null;
    runEnrichment();
  }, Math.max(0, delayMs || 0));
  if (enrichTimer && typeof enrichTimer.unref === 'function') enrichTimer.unref();
}

async function runEnrichment() {
  if (!llm.available || enrichmentInFlight) return;
  if (scanning) {
    scheduleEnrichment(3000);
    return;
  }
  enrichmentInFlight = true;
  broadcast('llm:start', { startedAt: new Date().toISOString() });
  try {
    const result = await llm.enrich(store.allProjects());
    const applied = store.applyEnrichment(result.patches);
    if (applied > 0) store.save();
    broadcast('projects', { projects: store.list().map(serializeProject) });
    broadcast('llm:done', {
      meta: currentMeta(),
      enriched: result.stats.enriched,
      failed: result.stats.failed,
      cached: result.stats.cached,
      durationMs: result.stats.durationMs
    });
    console.log('[llm] 摘要更新：' + applied + ' 个项目（请求 ' + result.stats.enriched + '，缓存 ' + result.stats.cached + '，失败 ' + result.stats.failed + '）');
  } catch (err) {
    console.error('[llm] 摘要生成失败：' + ((err && err.stack) || err));
    broadcast('llm:done', {
      meta: currentMeta(),
      enriched: 0,
      failed: 0,
      cached: 0,
      durationMs: 0,
      error: String((err && err.message) || err)
    });
  } finally {
    enrichmentInFlight = false;
  }
}

function cleanMarkdown(raw) {
  const lines = String(raw).replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(FENCE) || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (trimmed.startsWith('![') || trimmed.startsWith('[![')) continue;
    kept.push(line);
  }
  let text = kept.join('\n');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/[*_|>]/g, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

async function readmeExcerptFor(project) {
  if (!project || !project.readmePath) return '';
  const base = path.resolve(project.path);
  const abs = path.resolve(base, project.readmePath);
  if (abs !== base && !abs.startsWith(base + path.sep)) return '';
  try {
    const stat = await fsp.stat(abs);
    if (!stat.isFile() || stat.size > 512 * 1024) return '';
    const raw = await fsp.readFile(abs, 'utf8');
    return cleanMarkdown(raw).slice(0, 1800);
  } catch (err) {
    return '';
  }
}

function serveFile(res, filePath, cacheControl) {
  fs.stat(filePath, function (err, stat) {
    if (err || !stat.isFile()) return notFoundPage(res);
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': cacheControl || 'no-cache'
    };
    res.writeHead(200, headers);
    const stream = fs.createReadStream(filePath);
    stream.on('error', function () {
      try { res.destroy(); } catch (e) {}
    });
    stream.pipe(res);
  });
}

function notFoundPage(res) {
  const body = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>404 · 项目雷达</title>' +
    '<style>html,body{margin:0;height:100%;background:#000;color:#fff;font-family:ui-sans-serif,system-ui,sans-serif}' +
    'main{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}' +
    'h1{font-size:48px;font-weight:600;margin:0;letter-spacing:-0.02em}p{color:#9b9b9b;margin:0}' +
    'a{color:#c6f24e;text-decoration:none;margin-top:8px}</style></head><body><main>' +
    '<h1>404</h1><p>这个页面不在雷达范围内。</p><a href="/">回到项目雷达</a></main></body></html>';
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function handleStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch (err) {
    return notFoundPage(res);
  }
  if (!rel || rel === '/') rel = '/index.html';
  if (rel.indexOf('\u0000') !== -1) return notFoundPage(res);
  const abs = path.resolve(PUBLIC_DIR, '.' + rel);
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) return notFoundPage(res);
  return serveFile(res, abs);
}

function handlePreview(req, res, url) {
  const match = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
  if (!match) return notFoundPage(res);
  let id;
  try { id = decodeURIComponent(match[1]); } catch (err) { return notFoundPage(res); }
  const project = store.getProject(id);
  if (!project) return notFoundPage(res);
  let rel = match[2] || '/';
  try { rel = decodeURIComponent(rel); } catch (err) { rel = '/'; }
  if (rel.endsWith('/')) rel += 'index.html';
  const base = path.resolve(project.path);
  const abs = path.resolve(base, '.' + rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    return apiError(res, 403, 'FORBIDDEN', '路径不在项目目录内。');
  }
  return serveFile(res, abs);
}

function handleEvents(req, res) {
  res.writeHead(200, Object.assign({
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  }, CORS));
  res.write(': connected\n\n');
  sendEvent(res, 'hello', { meta: currentMeta() });
  sseClients.add(res);
  req.on('close', function () {
    sseClients.delete(res);
  });
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method || 'GET';

  /* ---------- AI 摘要渠道（设置里的渠道 + 模型选择） ---------- */

  if (method === 'GET' && pathname === '/api/llm/channels') {
    const discovered = dshLlm.listChannels();
    const selection = preferences.getSettings().llmSelection;
    return json(res, 200, {
      dsh: discovered.dsh,
      selection: selection,
      effective: dshLlm.describeSelection(selection),
      defaultProvider: discovered.defaultProvider,
      defaultModel: discovered.defaultModel,
      channels: discovered.channels
    });
  }

  if (method === 'POST' && pathname === '/api/llm/selection') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return apiError(res, 400, 'INVALID_JSON', '请求体必须是合法 JSON。');
    }
    if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'selection')) {
      return apiError(res, 400, 'INVALID_BODY', '请求体需要 selection 字段（{provider, model} 或 null）。');
    }
    let selection = null;
    if (body.selection !== null) {
      try {
        const target = dshLlm.resolveSelection(body.selection);
        selection = { provider: target.provider, model: target.model };
      } catch (err) {
        const code = err && err.code;
        if (code === 'CHANNEL_NOT_FOUND' || code === 'MODEL_NOT_FOUND') {
          return apiError(res, 404, code, String((err && err.message) || err));
        }
        if (code === 'KEY_MISSING') {
          return apiError(res, 422, 'KEY_MISSING', String((err && err.message) || err));
        }
        return apiError(res, 400, 'INVALID_BODY', String((err && err.message) || '渠道选择不合法。'));
      }
    }
    preferences.updateSettings({ llmSelection: selection });
    preferences.saveSettings();
    llm.refreshConfig();
    const enrichScheduled = llm.available;
    if (enrichScheduled) scheduleEnrichment(300);
    return json(res, 200, {
      selection: preferences.getSettings().llmSelection,
      effective: dshLlm.describeSelection(selection),
      enrichScheduled: enrichScheduled
    });
  }

  if (method === 'GET' && pathname === '/api/settings') {
    return json(res, 200, Object.assign({}, preferences.getSettings(), { intervalMs: 1000 }));
  }

  if (method === 'POST' && pathname === '/api/settings') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return apiError(res, 400, 'INVALID_JSON', '请求体必须是合法 JSON。');
    }
    if (!body || typeof body !== 'object') {
      return apiError(res, 400, 'INVALID_BODY', '请求体需要 monitorEnabled 或 autoUpdate 字段。');
    }
    const hasMonitor = typeof body.monitorEnabled === 'boolean';
    const hasAutoUpdate = typeof body.autoUpdate === 'boolean';
    if (!hasMonitor && !hasAutoUpdate) {
      return apiError(res, 400, 'INVALID_BODY', 'monitorEnabled / autoUpdate 必须是 true 或 false。');
    }
    const patch = {};
    if (hasMonitor) patch.monitorEnabled = body.monitorEnabled;
    if (hasAutoUpdate) patch.autoUpdate = body.autoUpdate;
    preferences.updateSettings(patch);
    preferences.saveSettings();
    if (hasMonitor) applyMonitorSetting(body.monitorEnabled);
    return json(res, 200, {
      settings: Object.assign({}, preferences.getSettings(), { intervalMs: 1000 }),
      monitor: monitor.snapshot()
    });
  }

  if (method === 'GET' && pathname === '/api/update/status') {
    return json(res, 200, updater.status());
  }

  if (method === 'POST' && pathname === '/api/update/check') {
    if (String(process.env.PROJECT_SCAN_AUTO_UPDATE || '').toLowerCase() === 'off') {
      return json(res, 200, { started: false, checking: false, message: '自动更新已在部署级关闭（PROJECT_SCAN_AUTO_UPDATE=off）。' });
    }
    const current = updater.status();
    if (current.checking) {
      return json(res, 409, { started: false, checking: true, message: '正在检查更新，请稍候。' });
    }
    if (!fs.existsSync(path.join(APP_DIR, '.git'))) {
      return json(res, 200, { started: false, checking: false, message: '应用目录不是 git 仓库，无法自动更新。' });
    }
    updater.check({ enabled: true });
    return json(res, 202, { started: true, checking: true });
  }

  if (method === 'GET' && pathname === '/api/monitor') {
    const enabled = Boolean(preferences.getSettings().monitorEnabled);
    if (!enabled) {
      return json(res, 200, {
        enabled: false,
        sampling: false,
        intervalMs: 1000,
        at: null,
        supported: { cpu: false, gpuPerProcess: false, network: false },
        system: { cpuPercent: null, gpuPercent: null, memoryUsedBytes: null },
        projects: [],
        overhead: { ticks: 0, ownCpuMs: 0, commandCalls: 0, commandMs: 0, nettopRunning: false }
      });
    }
    return json(res, 200, monitor.snapshot());
  }

  if (method === 'GET' && pathname === '/api/running') {
    const projects = listRunningProjects();
    return json(res, 200, {
      count: projects.length,
      scanner: { pid: process.pid, uptimeSec: Math.round(process.uptime()) },
      projects: projects
    });
  }

  if (method === 'POST' && pathname === '/api/running/stop-all') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      body = {};
    }
    const includeScanner = Boolean(body && body.includeScanner === true);
    const result = await stopAllRunning(includeScanner);
    return json(res, 200, result);
  }

  if (method === 'GET' && pathname === '/api/health') {
    return json(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()), version: VERSION, root: WORKSPACE_ROOT });
  }

  if (method === 'GET' && pathname === '/api/status') {
    return json(res, 200, currentMeta());
  }

  if (method === 'GET' && pathname === '/api/projects') {
    const projects = store.list().map(serializeProject);
    return json(res, 200, { projects: projects, meta: currentMeta() });
  }

  if (method === 'GET' && pathname === '/api/workspaces') {
    return json(res, 200, {
      workspaces: workspaceMeta(),
      current: 'main',
      home: os.homedir(),
      limit: MAX_WORKSPACES
    });
  }

  if (method === 'POST' && pathname === '/api/workspaces') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return apiError(res, 400, 'INVALID_JSON', '请求体必须是合法 JSON。');
    }
    const result = workspaces.add(body && body.path);
    if (!result || !result.ok) {
      const code = (result && result.code) || 'INVALID_PATH';
      const statusMap = {
        INVALID_PATH: 400,
        NOT_DIRECTORY: 400,
        NOT_READABLE: 400,
        FORBIDDEN_PATH: 400,
        WORKSPACE_EXISTS: 409,
        MAX_WORKSPACES: 422
      };
      return apiError(res, statusMap[code] || 400, code, (result && result.error) || '工作区添加失败。');
    }
    workspaces.save();
    const ws = result.workspace;
    const item = {
      id: ws.id,
      name: ws.name,
      path: ws.path,
      isDefault: false,
      addedAt: ws.addedAt || new Date().toISOString(),
      projectCount: 0,
      durationMs: 0,
      error: null
    };
    broadcast('workspaces', { workspaces: workspaceMeta(), added: item.id });
    if (scanning) pendingScan = true;
    doScan('workspace-add').catch(function () {});
    return json(res, 201, { workspace: item, scanStarted: true });
  }

  const workspaceMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
  if (method === 'DELETE' && workspaceMatch) {
    let id;
    try { id = decodeURIComponent(workspaceMatch[1]); } catch (err) { id = workspaceMatch[1]; }
    const result = workspaces.remove(id);
    if (!result || !result.ok) {
      const rawCode = (result && result.code) || 'WORKSPACE_NOT_FOUND';
      if (rawCode === 'DEFAULT_WORKSPACE') return apiError(res, 400, 'DEFAULT_WORKSPACE', '默认工作区不能删除。');
      const code = rawCode === 'NOT_FOUND' ? 'WORKSPACE_NOT_FOUND' : rawCode;
      return apiError(res, 404, code, (result && result.error) || '没有找到这个工作区。');
    }
    workspaces.save();
    const removedProjects = store.removeByWorkspace(id);
    store.save();
    broadcast('projects', { projects: store.list().map(serializeProject) });
    broadcast('workspaces', { workspaces: workspaceMeta(), removed: id, removedProjects: removedProjects });
    if (scanning) pendingScan = true;
    doScan('workspace-remove').catch(function () {});
    return json(res, 200, { removed: true, removedProjects: removedProjects });
  }

  if (method === 'GET' && pathname === '/api/fs/dirs') {
    const target = url.searchParams.get('path') || WORKSPACE_ROOT;
    try {
      const listing = await Promise.resolve(
        fsBrowse.list(target, { hidden: url.searchParams.get('hidden') === '1' })
      );
      return json(res, 200, listing);
    } catch (err) {
      const code = (err && err.code) || 'INVALID_PATH';
      return apiError(res, 400, code, (err && err.message) || '无法读取这个目录。');
    }
  }

  if (method === 'POST' && pathname === '/api/scan') {
    if (scanning) return apiError(res, 409, 'SCAN_RUNNING', '扫描正在进行中，请稍候。');
    doScan('manual').catch(function () {});
    return json(res, 202, { started: true });
  }

  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (method === 'GET' && runMatch) {
    let runId;
    try { runId = decodeURIComponent(runMatch[1]); } catch (err) { runId = runMatch[1]; }
    const found = runner.logs(runId);
    if (!found) return apiError(res, 404, 'RUN_NOT_FOUND', '没有找到这次运行记录。');
    return json(res, 200, found);
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)(?:\/(run|stop|hidden|restart))?$/);
  if (projectMatch) {
    let id;
    try { id = decodeURIComponent(projectMatch[1]); } catch (err) { id = projectMatch[1]; }
    const project = store.getProject(id);
    if (!project) return apiError(res, 404, 'PROJECT_NOT_FOUND', '没有找到这个项目，它可能已经被移走。');
    const action = projectMatch[2];

    if (!action && method === 'GET') {
      const excerpt = await readmeExcerptFor(project);
      return json(res, 200, { project: serializeProject(project), readmeExcerpt: excerpt });
    }

    if (action === 'hidden' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return apiError(res, 400, 'INVALID_JSON', '请求体必须是合法 JSON。');
      }
      if (!body || typeof body.hidden !== 'boolean') {
        return apiError(res, 400, 'INVALID_BODY', 'hidden 必须是 true 或 false。');
      }
      const targetId = project.parentId || project.id;
      preferences.setHidden(targetId, body.hidden);
      preferences.save();
      broadcast('projects', { projects: store.list().map(serializeProject) });
      return json(res, 200, {
        project: serializeProject(project),
        hiddenCount: store.list().filter(function (item) { return preferences.isHidden(item.id); }).length
      });
    }

    if (action === 'restart' && method === 'POST') {
      if (isScannerProject(project)) {
        return apiError(res, 400, 'SCANNER_EXTERNAL', '扫描器由外部 start.sh 启动，不能在这里重启；如需停止，请在「运行中」弹层勾选「包含当前扫描器」后全部停止。');
      }
      const runInfo = runner.detect(project);
      if (!runInfo.runnable) {
        return apiError(res, 422, 'NOT_RUNNABLE', runInfo.reason || '这个项目暂时无法自动运行。');
      }
      try {
        const run = await restartProjectRun(project);
        broadcast('run', run);
        return json(res, 200, { run: run });
      } catch (err) {
        if (err && err.code === 'NOT_RUNNING') {
          return apiError(res, 409, 'NOT_RUNNING', err.message || '这个项目当前没有在运行。');
        }
        if (err && err.code === 'RESTART_TIMEOUT') {
          return apiError(res, 500, 'RESTART_TIMEOUT', err.message || '停止旧实例超时，未能重启。');
        }
        console.error('[restart] 重启失败：' + ((err && err.stack) || err));
        return apiError(res, 500, 'RESTART_FAILED', '重启失败：' + ((err && err.message) || err));
      }
    }

    if (action === 'run' && method === 'POST') {
      if (isScannerProject(project)) {
        return apiError(res, 409, 'ALREADY_RUNNING', '扫描器服务正在运行（由外部 start.sh 启动），不能在这里重复启动。');
      }
      const runInfo = runner.detect(project);
      if (!runInfo.runnable) {
        return apiError(res, 422, 'NOT_RUNNABLE', runInfo.reason || '这个项目暂时无法自动运行。');
      }
      try {
        const run = await runner.run(project);
        broadcast('run', run);
        return json(res, 200, { run: run });
      } catch (err) {
        if (err && err.code === 'ALREADY_RUNNING') {
          return apiError(res, 409, 'ALREADY_RUNNING', err.message || '这个项目已经在运行。');
        }
        if (err && err.code === 'NOT_RUNNABLE') {
          return apiError(res, 422, 'NOT_RUNNABLE', err.message || '这个项目暂时无法自动运行。');
        }
        console.error('[run] 启动失败：' + ((err && err.stack) || err));
        return apiError(res, 500, 'RUN_FAILED', '启动失败：' + ((err && err.message) || err));
      }
    }

    if (action === 'stop' && method === 'POST') {
      if (isScannerProject(project)) {
        return apiError(res, 400, 'SCANNER_EXTERNAL', '扫描器由外部启动，不能单独停止；请在「运行中」弹层勾选「包含当前扫描器」后全部停止。');
      }
      const run = runner.stop(project.id);
      if (!run) return apiError(res, 404, 'NOT_RUNNING', '这个项目当前没有运行实例。');
      broadcast('run', run);
      return json(res, 200, { run: run });
    }
  }

  return apiError(res, 404, 'NOT_FOUND', '接口不存在。');
}

const server = http.createServer(function (req, res) {
  let url;
  try {
    url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
  } catch (err) {
    return apiError(res, 400, 'BAD_REQUEST', '请求地址无效。');
  }
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (url.pathname === '/api/events' && method === 'GET') {
    return handleEvents(req, res);
  }

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url).catch(function (err) {
      console.error('[api] ' + ((err && err.stack) || err));
      if (!res.headersSent) apiError(res, 500, 'INTERNAL', '服务器内部错误：' + ((err && err.message) || err));
    });
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return apiError(res, 405, 'METHOD_NOT_ALLOWED', '不支持的请求方法。');
  }

  if (url.pathname.startsWith('/preview/')) return handlePreview(req, res, url);
  return handleStatic(req, res, url);
});

const heartbeat = setInterval(function () {
  for (const client of sseClients) {
    try {
      client.write(': ping\n\n');
    } catch (err) {
      sseClients.delete(client);
    }
  }
}, 25000);
heartbeat.unref();

async function start() {
  workspaces.load();
  preferences.load();
  applyMonitorSetting(Boolean(preferences.getSettings().monitorEnabled));
  if (preferences.getSettings().monitorEnabled) {
    console.log('[project-scan] 运行时监控：已开启（每 1 秒采样）');
  }
  const workspaceList = workspaces.list();
  console.log('[project-scan] 默认工作区：' + WORKSPACE_ROOT);
  if (workspaceList.length > 1) {
    console.log('[project-scan] 已加入 ' + workspaceList.length + ' 个工作区：' + workspaceList.map(function (ws) { return ws.name; }).join('、'));
  }
  store.load();
  console.log('[project-scan] 读取到历史索引 ' + store.list().length + ' 个项目');
  scheduler.start();
  try {
    await scheduler.triggerNow('startup');
  } catch (err) {
    console.error('[project-scan] 启动扫描失败，服务继续启动：' + ((err && err.message) || err));
  }
  server.on('error', function (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error('[project-scan] 端口 ' + PORT + ' 已被占用，请设置 PORT 环境变量后重试。');
      process.exit(1);
    }
    console.error('[project-scan] 服务错误：' + ((err && err.stack) || err));
    process.exit(1);
  });
  server.listen(PORT, HOST, function () {
    console.log('[project-scan] 已启动：http://' + HOST + ':' + PORT);
    console.log('[project-scan] 扫描窗口：每天 ' + scheduler.status().windowStartHour + ':00 到 ' + scheduler.status().windowEndHour + ':00，每 ' + scheduler.status().intervalMinutes + ' 分钟一次');
    scheduleDiskUsage(1200);
    // 外部启动实例检测：每 5 秒刷新一次，有变化时推送项目列表（卡片运行状态实时更新）
    async function refreshExternalRuns() {
      try {
        const result = await externalRuns.refresh();
        if (result.changed) {
          broadcast('projects', { projects: store.list().map(serializeProject) });
        }
      } catch (err) {
        console.error('[external-runs] 刷新失败：' + ((err && err.message) || err));
      }
    }
    externalRunsTimer = setInterval(refreshExternalRuns, 5000);
    if (externalRunsTimer && typeof externalRunsTimer.unref === 'function') externalRunsTimer.unref();
    refreshExternalRuns();
    // 启动时后台静默检查 git 更新（默认开启，可在设置里关闭；PROJECT_SCAN_AUTO_UPDATE=off 部署级关闭）
    const autoUpdateEnv = String(process.env.PROJECT_SCAN_AUTO_UPDATE || '').toLowerCase();
    const autoUpdateEnabled = autoUpdateEnv !== 'off' && Boolean(preferences.getSettings().autoUpdate);
    if (autoUpdateEnabled) {
      updater.start({ enabled: true, delayMs: 2000 });
    } else {
      console.log('[project-scan] 自动更新：已关闭');
    }
    if (llm.available) {
      const llmInfo = llm.status();
      if (llmInfo.source === 'dsh' || llmInfo.source === 'selection') {
        const label = llmInfo.source === 'selection' ? '设置中选择的 DSH 渠道' : '复用 DSH 默认渠道';
        console.log('[project-scan] LLM 摘要：' + llmInfo.model + '（' + label + ' ' + (llmInfo.channelName || llmInfo.provider) + '）');
      } else {
        console.log('[project-scan] LLM 摘要：' + llmInfo.model + '（可用）');
      }
      scheduleEnrichment(800);
    } else {
      const llmInfo = llm.status();
      console.log('[project-scan] LLM 摘要：' + (llmInfo.error ? '渠道不可用（' + llmInfo.error + '）' : '未配置 API key') + '，使用文档启发式摘要');
    }
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[project-scan] 收到 ' + signal + '，正在退出');
  try { scheduler.stop(); } catch (err) {}
  try { monitor.setEnabled(false); monitor.stop(); } catch (err) {}
  try { if (externalRunsTimer) clearInterval(externalRunsTimer); } catch (err) {}
  try { await runner.shutdown(); } catch (err) {}
  for (const client of sseClients) {
    try { client.end(); } catch (err) {}
  }
  try { store.save(); } catch (err) {}
  try { workspaces.save(); } catch (err) {}
  try { preferences.save(); } catch (err) {}
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 3000).unref();
}

process.on('SIGINT', function () { shutdown('SIGINT'); });
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('uncaughtException', function (err) {
  console.error('[project-scan] 未捕获异常：' + ((err && err.stack) || err));
});
process.on('unhandledRejection', function (err) {
  console.error('[project-scan] 未处理 Promise 拒绝：' + ((err && err.stack) || err));
});

start();
