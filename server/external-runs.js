/**
 * server/external-runs.js — 检测「外部启动」的项目服务（不是本服务 runner 启动的）
 *
 * 背景：用户可能自己用终端启动了某个项目（例如 Rust 后端、cargo/二进制、python 服务），
 * 这时 project-scan 的 runner 不知道该实例存在，卡片会显示「不可运行/未运行」，与实际不符。
 *
 * 做法（零依赖）：
 *  1) 用 lsof 列出本机所有 TCP LISTEN 端口及所属 PID；
 *  2) 用 lsof 查这些 PID 的 cwd，把 cwd 落在某个扫描项目目录内的进程视为该项目的「外部运行实例」；
 *  3) 对候选端口做一次 HTTP 探测，优先选返回 text/html 的端口（后端 API 端口通常返回 JSON/404）；
 *  4) 结果缓存，由 index.js 定时刷新；失败只记录错误，不影响其他功能。
 *
 * 注意：只读本机进程信息，不修改任何项目；lsof 不可用时静默降级（不做外部检测）。
 */

import { execFile } from 'node:child_process';
import { sep } from 'node:path';

const DEFAULT_REFRESH_MS = 5000;
const PROBE_TIMEOUT_MS = 1200;

function defaultRun(args, timeoutMs) {
  return new Promise(function (resolve) {
    execFile(
      'lsof',
      args,
      { timeout: timeoutMs || 4000, maxBuffer: 4 * 1024 * 1024 },
      function (error, stdout, stderr) {
        resolve({
          code: error ? 1 : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: error || null
        });
      }
    );
  });
}

async function defaultProbe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return { status: response.status, contentType: response.headers.get('content-type') || '' };
  } catch (err) {
    return null;
  }
}

/** 解析 `lsof -Fpcn` 输出：每个 p 开始一个进程块，c 是命令，n 是监听地址。 */
export function parseListeners(stdout) {
  const processes = [];
  let current = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line) continue;
    const key = line[0];
    const value = line.slice(1);
    if (key === 'p') {
      current = { pid: Number(value), command: '', ports: [] };
      processes.push(current);
    } else if (key === 'c' && current) {
      current.command = value;
    } else if (key === 'n' && current) {
      const match = value.match(/:(\d{1,5})$/);
      if (match) {
        const port = Number(match[1]);
        if (port > 0 && current.ports.indexOf(port) === -1) current.ports.push(port);
      }
    }
  }
  return processes.filter(function (process) { return process.pid > 0 && process.ports.length > 0; });
}

/** 解析 `lsof -Fpn`（-d cwd）输出：pid -> cwd。 */
export function parseCwds(stdout) {
  const map = new Map();
  let pid = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line) continue;
    const key = line[0];
    const value = line.slice(1);
    if (key === 'p') pid = Number(value);
    else if (key === 'n' && pid) map.set(pid, value);
  }
  return map;
}

/** 找 cwd 所属项目：取路径前缀最长匹配（子项目优先于父项目）。 */
export function bestProject(projects, cwd) {
  let best = null;
  for (const project of projects || []) {
    if (!project || !project.path) continue;
    const root = project.path;
    if (cwd === root || cwd.indexOf(root + sep) === 0) {
      if (!best || root.length > best.path.length) best = project;
    }
  }
  return best;
}

/**
 * @param {{ run?: Function, probe?: Function, getProjects?: Function, log?: Function }} options
 */
export function createExternalRuns(options) {
  const opts = options || {};
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  const run = typeof opts.run === 'function' ? opts.run : defaultRun;
  const probe = typeof opts.probe === 'function' ? opts.probe : defaultProbe;
  const getProjects = typeof opts.getProjects === 'function' ? opts.getProjects : function () { return []; };

  let matches = new Map();
  let at = null;
  let error = null;
  let refreshing = false;
  let lastSignature = null;

  function snapshot() {
    return {
      at: at,
      error: error,
      matches: new Map(matches)
    };
  }

  function signature() {
    return JSON.stringify(
      Array.from(matches.entries())
        .sort(function (a, b) { return a[0].localeCompare(b[0]); })
        .map(function (entry) {
          const value = entry[1];
          return [entry[0], value.pid, value.port, value.url];
        })
    );
  }

  async function refresh() {
    if (refreshing) return { changed: false, snapshot: snapshot() };
    refreshing = true;
    let changed = false;
    try {
      const listeners = await run(['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
      if (listeners.code !== 0) {
        error = 'lsof 不可用，跳过外部运行检测';
        return { changed: false, snapshot: snapshot() };
      }
      const processes = parseListeners(listeners.stdout);
      let cwds = new Map();
      if (processes.length > 0) {
        const cwdResult = await run([
          '-nP',
          '-p',
          processes.map(function (process) { return process.pid; }).join(','),
          '-a',
          '-d',
          'cwd',
          '-Fpn'
        ]);
        if (cwdResult.code === 0) cwds = parseCwds(cwdResult.stdout);
      }

      const projects = getProjects() || [];
      const grouped = new Map();
      for (const process of processes) {
        const cwd = cwds.get(process.pid);
        if (!cwd || cwd === '/') continue;
        const project = bestProject(projects, cwd);
        if (!project) continue;
        if (!grouped.has(project.id)) grouped.set(project.id, []);
        grouped.get(project.id).push({
          pid: process.pid,
          command: process.command || '',
          cwd: cwd,
          ports: process.ports
        });
      }

      const nextMatches = new Map();
      for (const [projectId, candidates] of grouped.entries()) {
        let chosen = null;
        for (const candidate of candidates) {
          for (const port of candidate.ports) {
            const url = 'http://127.0.0.1:' + port + '/';
            const probed = await probe(url);
            const isHtml = Boolean(probed && /text\/html/i.test(probed.contentType || ''));
            const entry = {
              pid: candidate.pid,
              command: candidate.command,
              cwd: candidate.cwd,
              port: port,
              url: url,
              html: isHtml,
              status: probed ? probed.status : null
            };
            if (!chosen || (entry.html && !chosen.html) || (entry.html === chosen.html && entry.port > chosen.port)) {
              chosen = entry;
            }
            if (entry.html) break;
          }
        }
        if (chosen) nextMatches.set(projectId, chosen);
      }

      matches = nextMatches;
      at = new Date().toISOString();
      error = null;
      const nextSignature = signature();
      if (nextSignature !== lastSignature) {
        lastSignature = nextSignature;
        changed = true;
      }
    } catch (err) {
      error = String((err && err.message) || err);
      log('[external-runs] 检测失败：' + error);
    } finally {
      refreshing = false;
    }
    return { changed: changed, snapshot: snapshot() };
  }

  /** 同步查询某个项目的外部实例（在最近一次 refresh 结果里）。 */
  function matchFor(projectId) {
    return matches.get(projectId) || null;
  }

  return {
    refresh: refresh,
    snapshot: snapshot,
    matchFor: matchFor,
    start: function (startOptions) {
      const startOpts = startOptions || {};
      const timer = setInterval(function () {
        refresh();
      }, Number(startOpts.intervalMs || DEFAULT_REFRESH_MS));
      if (typeof timer.unref === 'function') timer.unref();
      refresh();
      return timer;
    },
    stop: function (timer) {
      if (timer) clearInterval(timer);
    }
  };
}

export default createExternalRuns;
