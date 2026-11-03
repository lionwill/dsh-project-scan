/**
 * server/monitor.js — 运行监控（CONTRACT.md「运行监控」/ 第 4 节）
 *
 * 职责：
 *  - start(provider) / stop()：监控生命周期。provider() -> [{ projectId, pid, status }]，
 *    由调用方（index.js）提供「当前正在运行中的项目根进程」。
 *  - setEnabled(bool) / isEnabled()：功能开关，默认关闭；关闭或没有运行中项目时绝不 spawn 任何采样子进程。
 *  - sampleOnce()：执行一轮采样（测试用，不依赖真实定时器）；enabled 时每 intervalMs(1000) 自动采样。
 *  - snapshot()：返回 CONTRACT.md §3 的 MonitorSnapshot。
 *
 * 采样实现与降级（重要）：
 *  - 进程树：优先 ps -axo pid=,ppid=,time=,rss= 一次拿全表，按 ppid 构图；
 *    本机 DSH 沙箱禁止 spawn ps/top（EPERM），此时 supported.cpu=false、cpuPercent/memoryBytes=null，
 *    进程树退回 pgrep -P <ppid> 递归（每 treeIntervalMs=2s 刷新树缓存），processCount 始终可得。
 *  - CPU：ps 的 time 字段（进程累计 CPU 时间）按进程差分，除以实际 elapsed 秒得到进程树 CPU%（100 = 一核）。
 *  - 内存：ps 的 rss（KB）按进程树求和；系统内存用 vm_stat（可选，允许 null）。
 *  - GPU：macOS 无法按进程统计 GPU。每 gpuIntervalMs(2s) 跑一次 ioreg -c IOAccelerator，
 *    解析 "Device Utilization %" 取最大值作为 system.gpuPercent；per-project gpuPercent 恒为 null。
 *  - 网络：实测 nettop -L N>1 非常重（每个 sample 约 1.4 CPU 秒），不能用常驻 -L 0，也不能 -L N>1。
 *    正确做法是每轮采样 spawn 一次 nettop -P -L 1 -n -x -J bytes_in,bytes_out（约 0.02~0.12s real），
 *    解析每个 name.pid,bytes_in,bytes_out 的进程累计值，与上一轮快照按实际 elapsed 毫秒差分得到 bytes/sec。
 *    连续调用 nettop 时计数器是进程累计值（跨独立进程调用持续增长），因此可以直接跨轮差分。
 *  - 任何外部命令失败都只降级为 null / supported=false，并记录日志，绝不抛异常影响服务。
 *
 * overhead 统计：ticks（采样轮次）、ownCpuMs（process.cpuUsage 差分累计）、commandCalls/commandMs
 * （外部命令调用次数与耗时），nettopRunning 表示网络采样当前是否可用且最近一轮成功
 * （改为每轮单次 nettop 后已无常驻子进程，该字段表示网络采样状态）。
 */

import { execFile } from 'node:child_process';
import os from 'node:os';

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_GPU_INTERVAL_MS = 2000;
const DEFAULT_MEMORY_INTERVAL_MS = 5000;
const DEFAULT_TREE_INTERVAL_MS = 2000;
const COMMAND_TIMEOUT_MS = { ps: 1500, pgrep: 1500, ioreg: 2500, vm_stat: 1500, nettop: 3000 };
const NETTOP_ARGS = ['-P', '-L', '1', '-n', '-x', '-J', 'bytes_in,bytes_out'];
const PS_ARGS = ['-axo', 'pid=,ppid=,time=,rss='];
const MAX_TREE_DEPTH = 12;
const MAX_TREE_PIDS = 2000;
const MAX_COMMAND_BUFFER = 8 * 1024 * 1024;

function noop() {}

function normalizeInterval(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 100) return fallback;
  return Math.floor(numeric);
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function describeError(err) {
  if (!err) return '未知错误';
  const code = err && err.code != null ? String(err.code) : '';
  const message = String((err && err.message) || code || '');
  if (/EPERM|EACCES|operation not permitted|permission denied/i.test(message)) {
    return '无权限执行（' + message.slice(0, 120) + '）';
  }
  if (err && err.killed) return '执行超时';
  if (code === 'ENOENT') return '命令不存在';
  return message.length > 160 ? message.slice(0, 160) + '…' : message || '未知错误';
}

/** 默认命令执行器：execFile（不走 shell），返回 { stdout, stderr }。 */
function defaultRun(command, args, options) {
  const opts = options || {};
  return new Promise(function (resolve, reject) {
    execFile(
      command,
      args,
      { timeout: 3000, maxBuffer: MAX_COMMAND_BUFFER, ...opts },
      function (err, stdout, stderr) {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout: stdout, stderr: stderr });
      }
    );
  });
}

function stdoutOf(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result.stdout === 'string') return result.stdout;
  if (result.stdout == null) return '';
  return String(result.stdout);
}

/* ------------------------------------------------------------------ */
/* 输出解析                                                            */
/* ------------------------------------------------------------------ */

/** ps 的 time 字段：[[DD-]HH:]MM:SS[.ss]。 */
function parseProcTime(raw) {
  if (raw == null) return null;
  let text = String(raw).trim();
  if (!text) return null;
  let days = 0;
  const dash = text.indexOf('-');
  if (dash > 0) {
    days = Number(text.slice(0, dash));
    text = text.slice(dash + 1);
    if (!Number.isFinite(days) || days < 0) return null;
  }
  const parts = text.split(':');
  if (parts.length < 1 || parts.length > 3) return null;
  const nums = [];
  for (const part of parts) {
    const num = part === '' ? NaN : Number(part);
    if (!Number.isFinite(num) || num < 0) return null;
    nums.push(num);
  }
  let seconds = 0;
  if (nums.length === 3) seconds = nums[0] * 3600 + nums[1] * 60 + nums[2];
  else if (nums.length === 2) seconds = nums[0] * 60 + nums[1];
  else seconds = nums[0];
  return days * 86400 + seconds;
}

/** 解析 ps -axo pid=,ppid=,time=,rss= → Map<pid, { ppid, cpuTimeSec, rssBytes }>。 */
function parsePsOutput(stdout) {
  const map = new Map();
  for (const line of String(stdout == null ? '' : stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s*$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cpuTimeSec = parseProcTime(match[3]);
    const rssKb = Number(match[4]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!Number.isFinite(rssKb) || rssKb < 0) continue;
    if (cpuTimeSec == null) continue;
    map.set(pid, { ppid: ppid, cpuTimeSec: cpuTimeSec, rssBytes: rssKb * 1024 });
  }
  return map;
}

/** 解析 pgrep -P 输出（每行一个 pid）。 */
function parsePidList(stdout) {
  const pids = [];
  for (const line of String(stdout == null ? '' : stdout).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const pid = Number(trimmed);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/** ioreg -c IOAccelerator 输出里 "Device Utilization %"=NN，取最大值（系统 GPU 利用率）。 */
function parseIoregGpu(stdout) {
  const text = String(stdout == null ? '' : stdout);
  const re = /["']?Device Utilization %["']?\s*=\s*(\d+(?:\.\d+)?)/g;
  let max = null;
  let match;
  while ((match = re.exec(text)) !== null) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    if (max == null || value > max) max = value;
  }
  if (max == null) return null;
  return Math.max(0, Math.min(100, Math.round(max)));
}

/** vm_stat → 已用内存字节数（active + wired + compressor 页 * page size）；解析不到时 null。 */
function parseVmStat(stdout) {
  const text = String(stdout == null ? '' : stdout);
  const pageMatch = text.match(/page size of (\d+) bytes/i);
  const pageSize = pageMatch ? Number(pageMatch[1]) : 4096;
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;

  function pages(label) {
    const re = new RegExp('^' + label + ':\\s+(\\d+)\\.?\\s*$', 'mi');
    const match = text.match(re);
    return match ? Number(match[1]) : 0;
  }
  const active = pages('Pages active');
  const wired = pages('Pages wired down');
  const compressor = pages('Pages occupied by compressor');
  const totalPages = active + wired + compressor;
  if (!Number.isFinite(totalPages) || totalPages <= 0) return null;
  return totalPages * pageSize;
}

/**
 * 解析 nettop -P -L 1 -x -J bytes_in,bytes_out 输出。
 * 首行是表头 ",bytes_in,bytes_out,"；之后每行 "进程名.pid,bytes_in,bytes_out,"（累计字节数）。
 * 返回 Map<pid, { rx, tx }>；bytes_in 是接收（rx），bytes_out 是发送（tx）。
 */
function parseNettopOutput(stdout) {
  const totals = new Map();
  for (const rawLine of String(stdout == null ? '' : stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 3) continue;
    const nameField = parts[0].trim();
    const nameMatch = nameField.match(/^(.*)\.(\d+)$/);
    if (!nameMatch) continue;
    const pid = Number(nameMatch[2]);
    const rx = Number(parts[1].trim());
    const tx = Number(parts[2].trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!Number.isFinite(rx) || rx < 0 || !Number.isFinite(tx) || tx < 0) continue;
    totals.set(pid, { rx: rx, tx: tx });
  }
  return totals;
}

/** 按 ppid 图收集进程树（含根进程），带深度与数量上限防御。 */
function collectTree(rootPid, childrenOf) {
  const pids = [];
  const seen = new Set();
  const queue = [rootPid];
  while (queue.length > 0 && pids.length < MAX_TREE_PIDS) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    pids.push(pid);
    const children = childrenOf.get(pid);
    if (!children) continue;
    for (const child of children) {
      if (!seen.has(child)) queue.push(child);
    }
  }
  return pids;
}

function cloneRow(row) {
  return {
    projectId: row.projectId,
    pid: row.pid,
    processCount: row.processCount,
    cpuPercent: row.cpuPercent,
    memoryBytes: row.memoryBytes,
    gpuPercent: row.gpuPercent,
    netRxBytesPerSec: row.netRxBytesPerSec,
    netTxBytesPerSec: row.netTxBytesPerSec
  };
}

/* ------------------------------------------------------------------ */
/* createMonitor                                                       */
/* ------------------------------------------------------------------ */

export function createMonitor(options) {
  const opts = options || {};
  const log = typeof opts.log === 'function' ? opts.log : noop;
  const run = typeof opts.run === 'function' ? opts.run : defaultRun;
  const cpus = typeof opts.cpus === 'function' ? opts.cpus : function () { return os.cpus(); };
  const now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };

  const intervalMs = normalizeInterval(opts.intervalMs, DEFAULT_INTERVAL_MS);
  const gpuIntervalMs = normalizeInterval(opts.gpuIntervalMs, DEFAULT_GPU_INTERVAL_MS);
  const memoryIntervalMs = normalizeInterval(opts.memoryIntervalMs, DEFAULT_MEMORY_INTERVAL_MS);
  const treeIntervalMs = normalizeInterval(opts.treeIntervalMs, DEFAULT_TREE_INTERVAL_MS);

  let provider = typeof opts.provider === 'function' ? opts.provider : null;
  let enabled = false;
  let started = false;
  let timer = null;
  let inflight = null;

  const supported = { cpu: null, gpuPerProcess: false, network: null };
  const system = { cpuPercent: null, gpuPercent: null, memoryUsedBytes: null };
  const overhead = { ticks: 0, ownCpuMs: 0, commandCalls: 0, commandMs: 0, nettopRunning: false };
  let projectsSnapshot = [];
  let at = null;

  // 进程 CPU / 内存（ps 差分）
  let psBroken = false;
  let psWarned = false;
  let prevPsAt = null;
  let prevCpuTimes = new Map();

  // ps 不可用时的 pgrep 进程树缓存
  const treeCache = new Map();

  // GPU / 系统内存节流
  let lastGpuAt = 0;
  let gpuWarned = false;
  let lastMemoryAt = 0;
  let memoryWarned = false;

  // 系统 CPU（os.cpus 差分）
  let prevCpuTotals = null;

  // 网络：每轮 nettop 累计值差分
  let nettopPrevTotals = new Map();
  let nettopPrevAt = null;
  let nettopWarned = false;

  /* ------------------------------ 基础工具 ------------------------------ */

  async function callCommand(command, args) {
    overhead.commandCalls += 1;
    const startedAt = now();
    try {
      const result = await run(command, args, { timeout: COMMAND_TIMEOUT_MS[command] || 3000 });
      return { stdout: stdoutOf(result) };
    } finally {
      overhead.commandMs += Math.max(0, now() - startedAt);
    }
  }

  function getRunningProjects() {
    if (typeof provider !== 'function') return [];
    let list;
    try {
      list = provider();
    } catch (err) {
      log('[monitor] 读取运行中项目失败（已忽略）：' + describeError(err));
      return [];
    }
    if (!Array.isArray(list)) return [];
    const result = [];
    const seen = new Set();
    for (const item of list) {
      if (!item) continue;
      const projectId = item.projectId != null ? String(item.projectId) : '';
      const pid = Number(item.pid);
      const status = item.status == null ? 'running' : String(item.status);
      if (!projectId || !Number.isInteger(pid) || pid <= 0) continue;
      if (status !== 'running') continue;
      if (seen.has(projectId)) continue;
      seen.add(projectId);
      result.push({ projectId: projectId, pid: pid });
    }
    return result;
  }

  function updateSystemCpu() {
    let idle = 0;
    let total = 0;
    const list = cpus() || [];
    for (const cpu of list) {
      const times = cpu && cpu.times ? cpu.times : null;
      if (!times) continue;
      for (const key of ['user', 'nice', 'sys', 'idle', 'irq']) {
        const value = Number(times[key]);
        if (Number.isFinite(value)) total += value;
      }
      idle += Number(times.idle) || 0;
    }
    if (!(total > 0)) return;
    if (prevCpuTotals && total > prevCpuTotals.total) {
      const deltaTotal = total - prevCpuTotals.total;
      const deltaIdle = Math.max(0, idle - prevCpuTotals.idle);
      const usedRatio = Math.max(0, Math.min(1, 1 - deltaIdle / deltaTotal));
      system.cpuPercent = round1(usedRatio * 100);
    }
    prevCpuTotals = { idle: idle, total: total };
  }

  /* ------------------------------ 进程树 / CPU / 内存 ------------------------------ */

  function markPsUnavailable(reason) {
    psBroken = true;
    supported.cpu = false;
    prevPsAt = null;
    prevCpuTimes = new Map();
    if (!psWarned) {
      psWarned = true;
      log('[monitor] ' + reason + '，进程 CPU/内存降级为不可用（supported.cpu=false）');
    }
  }

  async function getTreePids(projectId, rootPid) {
    const cached = treeCache.get(projectId);
    const current = now();
    if (cached && cached.rootPid === rootPid && current - cached.at < treeIntervalMs) {
      return cached.pids;
    }
    const pids = await collectTreeByPgrep(rootPid);
    treeCache.set(projectId, { rootPid: rootPid, pids: pids, at: now() });
    return pids;
  }

  async function collectTreeByPgrep(rootPid) {
    const all = [rootPid];
    const seen = new Set([rootPid]);
    let frontier = [rootPid];
    for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length > 0 && all.length < MAX_TREE_PIDS; depth++) {
      const childrenLists = await Promise.all(
        frontier.map(async function (pid) {
          try {
            const output = await callCommand('pgrep', ['-P', String(pid)]);
            return parsePidList(output.stdout);
          } catch (err) {
            return []; // pgrep 无匹配子进程时退出码 1，属于正常情况
          }
        })
      );
      const next = [];
      for (const children of childrenLists) {
        for (const child of children) {
          if (seen.has(child)) continue;
          seen.add(child);
          all.push(child);
          next.push(child);
        }
      }
      frontier = next;
    }
    return all;
  }

  async function sampleProjects(running) {
    let psMap = null;
    if (!psBroken) {
      try {
        const output = await callCommand('ps', PS_ARGS);
        const parsed = parsePsOutput(output.stdout);
        if (parsed.size === 0) {
          markPsUnavailable('ps 输出为空或被环境限制');
        } else {
          psMap = parsed;
          supported.cpu = true;
        }
      } catch (err) {
        markPsUnavailable('ps 不可用（' + describeError(err) + '）');
      }
    }

    const sampleAt = now();
    const elapsedSec = prevPsAt == null ? null : (sampleAt - prevPsAt) / 1000;

    let childrenOf = null;
    const currentCpuTimes = new Map();
    if (psMap) {
      childrenOf = new Map();
      for (const entry of psMap) {
        const pid = entry[0];
        const info = entry[1];
        currentCpuTimes.set(pid, info.cpuTimeSec);
        if (!childrenOf.has(info.ppid)) childrenOf.set(info.ppid, []);
        childrenOf.get(info.ppid).push(pid);
      }
    }

    const rows = [];
    const trees = new Map();
    const canComputeCpu = Boolean(psMap) && supported.cpu === true && elapsedSec != null && elapsedSec > 0;

    for (const item of running) {
      let treePids;
      let processCount;
      let memoryBytes = null;

      if (psMap) {
        treePids = collectTree(item.pid, childrenOf);
        if (treePids.length === 0) treePids = [item.pid]; // 根进程恰在两次采样间退出时的防御
        processCount = treePids.length;
        let rss = 0;
        for (const pid of treePids) {
          const info = psMap.get(pid);
          if (info) rss += info.rssBytes;
        }
        memoryBytes = rss;
      } else {
        treePids = await getTreePids(item.projectId, item.pid);
        if (treePids.length === 0) treePids = [item.pid];
        processCount = treePids.length;
        memoryBytes = null;
      }

      let cpuPercent = null;
      if (canComputeCpu) {
        let cpuSeconds = 0;
        for (const pid of treePids) {
          const current = currentCpuTimes.get(pid);
          const previous = prevCpuTimes.get(pid);
          if (current == null || previous == null) continue; // 新进程首帧没有基线
          const delta = current - previous;
          if (delta > 0) cpuSeconds += delta;
        }
        cpuPercent = round1((cpuSeconds / elapsedSec) * 100);
      }

      trees.set(item.projectId, treePids);
      rows.push({
        projectId: item.projectId,
        pid: item.pid,
        processCount: processCount,
        cpuPercent: cpuPercent,
        memoryBytes: memoryBytes,
        gpuPercent: null, // macOS 无法按进程统计 GPU
        netRxBytesPerSec: supported.network === false ? null : 0,
        netTxBytesPerSec: supported.network === false ? null : 0
      });
    }

    if (psMap) {
      prevCpuTimes = currentCpuTimes;
      prevPsAt = sampleAt;
    }
    return { rows: rows, trees: trees };
  }

  /* ------------------------------ GPU / 系统内存 ------------------------------ */

  async function maybeSampleGpu() {
    const current = now();
    if (lastGpuAt !== 0 && current - lastGpuAt < gpuIntervalMs) return;
    lastGpuAt = current;
    try {
      const output = await callCommand('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']);
      system.gpuPercent = parseIoregGpu(output.stdout);
    } catch (err) {
      system.gpuPercent = null;
      if (!gpuWarned) {
        gpuWarned = true;
        log('[monitor] ioreg GPU 采样失败（' + describeError(err) + '），system.gpuPercent 记为 null');
      }
    }
  }

  async function maybeSampleMemory() {
    const current = now();
    if (lastMemoryAt !== 0 && current - lastMemoryAt < memoryIntervalMs) return;
    lastMemoryAt = current;
    try {
      const output = await callCommand('vm_stat', []);
      system.memoryUsedBytes = parseVmStat(output.stdout);
    } catch (err) {
      system.memoryUsedBytes = null;
      if (!memoryWarned) {
        memoryWarned = true;
        log('[monitor] vm_stat 采样失败（' + describeError(err) + '），system.memoryUsedBytes 记为 null');
      }
    }
  }

  /* ------------------------------ 网络（每轮单次 nettop + 累计差分） ------------------------------ */

  function resetNetworkBaseline() {
    nettopPrevTotals = new Map();
    nettopPrevAt = null;
  }

  async function sampleNetwork(rows, trees) {
    if (supported.network === false) {
      for (const row of rows) {
        row.netRxBytesPerSec = null;
        row.netTxBytesPerSec = null;
      }
      overhead.nettopRunning = false;
      return;
    }

    let totals;
    try {
      const output = await callCommand('nettop', NETTOP_ARGS);
      totals = parseNettopOutput(output.stdout);
      supported.network = true;
      overhead.nettopRunning = true;
    } catch (err) {
      supported.network = false;
      overhead.nettopRunning = false;
      resetNetworkBaseline();
      for (const row of rows) {
        row.netRxBytesPerSec = null;
        row.netTxBytesPerSec = null;
      }
      if (!nettopWarned) {
        nettopWarned = true;
        log('[monitor] nettop 采样失败（' + describeError(err) + '），网络采集降级为不可用');
      }
      return;
    }

    const sampleAt = now();
    const rates = new Map();
    if (nettopPrevAt != null && totals.size > 0) {
      const elapsedSec = (sampleAt - nettopPrevAt) / 1000;
      if (elapsedSec > 0) {
        for (const entry of totals) {
          const pid = entry[0];
          const current = entry[1];
          const previous = nettopPrevTotals.get(pid);
          if (!previous) continue;
          const deltaRx = current.rx - previous.rx;
          const deltaTx = current.tx - previous.tx;
          if (deltaRx < 0 || deltaTx < 0) continue; // 进程重启导致计数回退：本轮跳过该 pid
          rates.set(pid, { rx: deltaRx / elapsedSec, tx: deltaTx / elapsedSec });
        }
      }
    }
    nettopPrevTotals = totals;
    nettopPrevAt = sampleAt;

    for (const row of rows) {
      const pids = trees.get(row.projectId) || [];
      let rx = 0;
      let tx = 0;
      for (const pid of pids) {
        const rate = rates.get(pid);
        if (!rate) continue;
        rx += rate.rx;
        tx += rate.tx;
      }
      row.netRxBytesPerSec = Math.max(0, Math.round(rx));
      row.netTxBytesPerSec = Math.max(0, Math.round(tx));
    }
  }

  /* ------------------------------ 单轮采样 ------------------------------ */

  async function runSample() {
    const cpuUsageStart = process.cpuUsage();
    overhead.ticks += 1;
    try {
      updateSystemCpu();
      const running = getRunningProjects();

      if (running.length === 0) {
        // 没有运行中的项目：跳过整轮采样，不 spawn 任何命令，并清空上一轮的项目指标
        projectsSnapshot = [];
        resetNetworkBaseline();
        overhead.nettopRunning = false;
      } else {
        const sampled = await sampleProjects(running);
        await Promise.all([maybeSampleGpu(), maybeSampleMemory(), sampleNetwork(sampled.rows, sampled.trees)]);
        projectsSnapshot = sampled.rows.map(cloneRow);
      }
      at = new Date(now()).toISOString();
    } catch (err) {
      log('[monitor] 采样异常（已忽略）：' + describeError(err));
    } finally {
      const usage = process.cpuUsage(cpuUsageStart);
      overhead.ownCpuMs += (usage.user + usage.system) / 1000;
    }
  }

  function sampleOnce() {
    if (!enabled) return Promise.resolve(snapshot());
    if (inflight) return inflight;
    const promise = runSample().then(
      function () {
        inflight = null;
        return snapshot();
      },
      function (err) {
        inflight = null;
        log('[monitor] 采样失败（已忽略）：' + describeError(err));
        return snapshot();
      }
    );
    inflight = promise;
    return promise;
  }

  function tick() {
    if (!enabled || !started) return;
    if (inflight) return; // 上一轮还没结束就跳过，避免采样叠加
    const promise = sampleOnce();
    if (promise && typeof promise.catch === 'function') promise.catch(noop);
  }

  function syncLoop() {
    const shouldRun = Boolean(enabled && started);
    if (shouldRun && !timer) {
      timer = setInterval(tick, intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    } else if (!shouldRun && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  /* ------------------------------ 生命周期 / 状态 ------------------------------ */

  function start(nextProvider) {
    if (typeof nextProvider === 'function') provider = nextProvider;
    started = true;
    syncLoop();
    return status();
  }

  function stop() {
    started = false;
    syncLoop();
    resetNetworkBaseline();
    overhead.nettopRunning = false;
    prevPsAt = null;
    prevCpuTimes = new Map();
    prevCpuTotals = null;
    treeCache.clear();
    return status();
  }

  function setEnabled(value) {
    const next = Boolean(value);
    if (next === enabled) {
      syncLoop();
      return status();
    }
    enabled = next;
    if (!enabled) {
      projectsSnapshot = [];
      resetNetworkBaseline();
      overhead.nettopRunning = false;
      prevPsAt = null;
      prevCpuTimes = new Map();
      prevCpuTotals = null;
      treeCache.clear();
    } else {
      lastGpuAt = 0; // 开启后立即采一次 GPU
      lastMemoryAt = 0;
    }
    syncLoop();
    return status();
  }

  function isEnabled() {
    return enabled;
  }

  function overheadSnapshot() {
    return {
      ticks: overhead.ticks,
      ownCpuMs: round2(overhead.ownCpuMs),
      commandCalls: overhead.commandCalls,
      commandMs: round1(overhead.commandMs),
      nettopRunning: Boolean(overhead.nettopRunning)
    };
  }

  function snapshot() {
    return {
      enabled: Boolean(enabled),
      sampling: Boolean(enabled && started),
      intervalMs: intervalMs,
      at: at,
      supported: {
        cpu: supported.cpu,
        gpuPerProcess: false,
        network: supported.network
      },
      system: {
        cpuPercent: system.cpuPercent,
        gpuPercent: system.gpuPercent,
        memoryUsedBytes: system.memoryUsedBytes
      },
      projects: projectsSnapshot.map(cloneRow),
      overhead: overheadSnapshot()
    };
  }

  function status() {
    return {
      enabled: Boolean(enabled),
      sampling: Boolean(enabled && started),
      started: Boolean(started),
      intervalMs: intervalMs,
      gpuIntervalMs: gpuIntervalMs,
      at: at,
      supported: {
        cpu: supported.cpu,
        gpuPerProcess: false,
        network: supported.network
      },
      overhead: overheadSnapshot()
    };
  }

  return {
    start: start,
    stop: stop,
    status: status,
    sampleOnce: sampleOnce,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    snapshot: snapshot
  };
}
