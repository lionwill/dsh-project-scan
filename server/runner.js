/**
 * server/runner.js — 项目运行模块
 *
 * 职责（见 CONTRACT.md 第 4 节）：
 *  - detect(project): 识别项目可运行入口（package.json scripts → start.sh/run.sh → index.html
 *    静态预览 → project.godot → python → *.xcodeproj → 不可运行），按项目 mtime 缓存。
 *  - run(project): 启动子进程（detached 进程组），20 秒内捕获 localhost 端口，返回 RunState。
 *  - stop(projectId): SIGTERM 进程组，3 秒后 SIGKILL。
 *  - state(projectId) / logs(runId): 查询最近状态与日志（日志环形缓冲 200 行，保留最近 20 条运行记录）。
 *  - shutdown(): 清理全部子进程与定时器，避免服务退出后遗留进程。
 *
 * 约束：零第三方依赖、ESM；只读项目目录，绝不写入项目目录；spawn 失败必须落到 failed 状态而不是抛异常。
 */

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const LOG_LIMIT = 200;                 // RunState.log 环形缓冲行数
const RUN_RECORD_LIMIT = 20;           // logs(runId) 可查询的最近运行记录条数
const DEFAULT_PORT_TIMEOUT_MS = 20000; // 契约：20 秒内捕获端口
const DEFAULT_STOP_GRACE_MS = 3000;    // 契约：SIGTERM 后 3 秒 SIGKILL
const BACKGROUND_CAPTURE_MS = 120000;  // 超时后继续后台等待地址打印的时长
const DOC_PROBE_TIMEOUT_MS = 1500;     // 探测文档端口是否在监听的超时
const MAX_CAPTURE_BUFFER = 8192;       // 端口捕获用的滚动缓冲
const MAX_LOG_LINE = 4000;             // 单行日志截断长度，避免超长行撑爆内存
const DETECT_CACHE_LIMIT = 500;
const SCRIPT_PRIORITY = ['dev', 'start', 'serve', 'preview'];
const NONE_REASON =
  '没有找到可识别的运行入口（package.json scripts / start.sh / run.sh / index.html / Godot / Python / Xcode 均未命中）';

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch (err) {
    return false;
  }
}

function isDirectory(dirPath) {
  try {
    return statSync(dirPath).isDirectory();
  } catch (err) {
    return false;
  }
}

function packageManagerFor(dir) {
  if (isFile(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (isFile(join(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/** 把参数安全地放进 sh 命令行（命令最终以 shell: true 启动）。 */
function quoteShellArg(value) {
  const text = String(value == null ? '' : value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  const escaped = text.replace(/["\\$\x60]/g, function (ch) {
    return '\\' + ch;
  });
  return '"' + escaped + '"';
}

function cloneRunInfo(info) {
  return {
    runnable: Boolean(info && info.runnable),
    kind: (info && info.kind) || 'none',
    command: info && info.command != null ? info.command : null,
    runHint: info && info.runHint != null ? info.runHint : null,
    reason: info && info.reason != null ? info.reason : null
  };
}

function makeRunnerError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function nowIso() {
  return new Date().toISOString();
}

function newRunId() {
  return 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

/** 对外返回的运行状态一律是快照，避免调用方（HTTP 序列化 / SSE）改动内部状态。 */
function snapshotRun(run) {
  if (!run) return null;
  return {
    runId: run.runId,
    projectId: run.projectId,
    status: run.status,
    url: run.url == null ? null : run.url,
    command: run.command == null ? null : run.command,
    cwd: run.cwd,
    pid: run.pid == null ? null : run.pid,
    startedAt: run.startedAt,
    endedAt: run.endedAt == null ? null : run.endedAt,
    exitCode: run.exitCode == null ? null : run.exitCode,
    log: Array.isArray(run.log) ? run.log.slice() : []
  };
}

function appendLog(run, rawLine) {
  let line = String(rawLine == null ? '' : rawLine);
  if (line.length > MAX_LOG_LINE) line = line.slice(0, MAX_LOG_LINE) + '…';
  run.log.push(line);
  if (run.log.length > LOG_LIMIT) run.log.splice(0, run.log.length - LOG_LIMIT);
}

/* 端口捕获：http(s)://localhost:PORT / 127.0.0.1:PORT / 0.0.0.0:PORT，
 * 也接受不带协议的 “localhost:PORT”（例如 “Local: localhost:5173”）。 */
const HTTP_LOCAL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/gi;
const PLAIN_LOCAL_RE = /(?:^|[\s([{"'=:：])(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})(?=$|[^\d])/gi;

function toValidPort(raw) {
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function extractLocalPort(text) {
  let match;
  HTTP_LOCAL_RE.lastIndex = 0;
  while ((match = HTTP_LOCAL_RE.exec(text)) !== null) {
    const port = toValidPort(match[1]);
    if (port) return port;
  }
  PLAIN_LOCAL_RE.lastIndex = 0;
  while ((match = PLAIN_LOCAL_RE.exec(text)) !== null) {
    const port = toValidPort(match[1]);
    if (port) return port;
  }
  return null;
}

/** 项目自带的 Python 虚拟环境（如 示例 Python 项目的 .venv），运行 start.sh 时需要优先使用。 */
function findProjectVenv(dir) {
  const candidates = [join(dir, '.venv', 'bin'), join(dir, 'venv', 'bin')];
  for (const binDir of candidates) {
    try {
      if (statSync(join(binDir, 'python')).isFile()) return binDir;
    } catch (err) {
      // 继续尝试下一个
    }
  }
  return null;
}

function readTextLimited(filePath, maxBytes) {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return '';
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    return '';
  }
}

/**
 * 从项目文档（README、其他 md、start.sh、package.json、.env.example）里找本机端口。
 * 用于启动输出没有打印地址、或地址打印得太晚的情况。
 */
function documentedPorts(dir) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    return [];
  }
  const files = [];
  const readme = entries.find(function (name) {
    return /^readme(\.(md|markdown|txt))?$/i.test(name);
  });
  if (readme) files.push(readme);
  entries
    .filter(function (name) {
      return /\.(md|markdown|txt)$/i.test(name) && !/^readme/i.test(name);
    })
    .sort()
    .slice(0, 3)
    .forEach(function (name) { files.push(name); });
  ['start.sh', 'run.sh', 'package.json', '.env.example', '.env'].forEach(function (name) {
    if (entries.indexOf(name) !== -1) files.push(name);
  });

  const ports = [];
  const seen = new Set();
  const patterns = [
    /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0):(\d{2,5})/g,
    /(?:^|[\s"'(=])(?:127\.0\.0\.1|localhost):(\d{2,5})(?!\d)/g,
    /--port[\s=]+["']?(\d{2,5})/g,
    /PORT[\s:=]+["']?(\d{2,5})/g
  ];
  for (const name of files) {
    const text = readTextLimited(join(dir, name), 64 * 1024);
    if (!text) continue;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const port = toValidPort(match[1]);
        if (port && !seen.has(port)) {
          seen.add(port);
          ports.push(port);
        }
      }
    }
    if (ports.length >= 8) break;
  }
  return ports;
}

/** 探测 http://127.0.0.1:PORT/ 是否有服务在监听（任何 HTTP 响应都算）。 */
async function probeHttpPort(port, timeoutMs) {
  if (typeof globalThis.fetch !== 'function') return false;
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  try {
    await globalThis.fetch('http://127.0.0.1:' + port + '/', {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual'
    });
    return true;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 结束整个进程组（detached 启动时子进程是进程组组长）。 */
function terminateProcessGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch (err) {
    /* 进程组不存在时回退为单进程 kill */
  }
  try {
    process.kill(pid, signal);
  } catch (err) {
    /* 进程已经退出，忽略 */
  }
}

/* ------------------------------------------------------------------ */
/* createRunner                                                        */
/* ------------------------------------------------------------------ */

/**
 * @param {{ root?: string, onUpdate?: (run: object) => void, portTimeoutMs?: number, stopGraceMs?: number }} options
 *   root 缺省为 process.cwd()；portTimeoutMs / stopGraceMs 仅供测试覆盖默认值，生产使用契约默认（20s / 3s）。
 */
export function createRunner(options = {}) {
  const root = options.root ? resolve(String(options.root)) : process.cwd();
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : null;
  const portTimeoutMs =
    Number.isFinite(options.portTimeoutMs) && options.portTimeoutMs > 0
      ? Number(options.portTimeoutMs)
      : DEFAULT_PORT_TIMEOUT_MS;
  const stopGraceMs =
    Number.isFinite(options.stopGraceMs) && options.stopGraceMs > 0
      ? Number(options.stopGraceMs)
      : DEFAULT_STOP_GRACE_MS;

  /** @type {Map<string, { key: string, info: object }>} */
  const detectCache = new Map();
  /** projectId -> 正在运行的 runtime entry */
  const active = new Map();
  /** projectId -> 当前或最近一次 RunState */
  const current = new Map();
  /** runId -> RunState（最近 RUN_RECORD_LIMIT 条） */
  const records = new Map();
  /** runId 的插入顺序，用于淘汰旧记录 */
  const recordOrder = [];
  let shuttingDown = false;

  /* ---------------- 对外通知 ---------------- */

  function notify(run) {
    if (!onUpdate) return;
    try {
      onUpdate(snapshotRun(run));
    } catch (err) {
      // onUpdate 属于调用方（index.js 的 SSE 广播），不能影响运行模块
      console.error('[runner] onUpdate 回调异常：' + ((err && err.message) || err));
    }
  }

  function resolveEntry(entry) {
    if (!entry || !entry.resolveDone) return;
    const resolveDone = entry.resolveDone;
    entry.resolveDone = null;
    entry.resolved = true;
    resolveDone(snapshotRun(entry.run));
  }

  /* ---------------- 运行记录 ---------------- */

  function isRunActive(run) {
    const entry = active.get(run.projectId);
    return Boolean(entry && entry.run === run);
  }

  function pruneRecords() {
    while (recordOrder.length > RUN_RECORD_LIMIT) {
      let removed = false;
      for (let i = 0; i < recordOrder.length; i += 1) {
        const run = records.get(recordOrder[i]);
        if (!run || !isRunActive(run)) {
          records.delete(recordOrder[i]);
          recordOrder.splice(i, 1);
          removed = true;
          break;
        }
      }
      if (!removed) break;
    }
  }

  function addRecord(run) {
    records.set(run.runId, run);
    recordOrder.push(run.runId);
    pruneRecords();
  }

  /* ---------------- 定时器 ---------------- */

  function clearCaptureTimer(entry) {
    if (entry.captureTimer) {
      clearTimeout(entry.captureTimer);
      entry.captureTimer = null;
    }
  }

  function clearBackgroundTimer(entry) {
    if (entry.backgroundTimer) {
      clearTimeout(entry.backgroundTimer);
      entry.backgroundTimer = null;
    }
  }

  function clearKillTimer(entry) {
    if (entry.killTimer) {
      clearTimeout(entry.killTimer);
      entry.killTimer = null;
    }
  }

  /* ---------------- 输出处理 ---------------- */

  function flushPartial(entry) {
    for (const streamName of ['stdout', 'stderr']) {
      const rest = entry.partial[streamName];
      if (rest) {
        appendLog(entry.run, rest);
        entry.partial[streamName] = '';
      }
    }
  }

  function handleOutput(entry, chunk, streamName) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    // 端口捕获使用滚动缓冲，避免端口串被切在两次 data 事件之间
    entry.captureBuf = (entry.captureBuf + text).slice(-MAX_CAPTURE_BUFFER);
    if (entry.captureEnabled) maybeCaptureUrl(entry);

    // 日志按行切分（\r 也当换行处理，兼容进度条输出）
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const combined = entry.partial[streamName] + normalized;
    const lines = combined.split('\n');
    entry.partial[streamName] = lines.pop() || '';
    for (const line of lines) appendLog(entry.run, line);
    if (entry.partial[streamName].length > MAX_LOG_LINE) {
      appendLog(entry.run, entry.partial[streamName].slice(0, MAX_LOG_LINE));
      entry.partial[streamName] = '';
    }
  }

  function applyCapturedUrl(entry, port, source) {
    if (entry.finished || entry.run.url) return;
    entry.run.url = 'http://127.0.0.1:' + port;
    entry.run.status = 'running';
    entry.captureEnabled = false;
    clearCaptureTimer(entry);
    clearBackgroundTimer(entry);
    appendLog(
      entry.run,
      '[project-scan] 已捕获访问地址：' + entry.run.url + (source === 'doc' ? '（来自项目文档）' : '')
    );
    notify(entry.run);
    resolveEntry(entry);
  }

  function maybeCaptureUrl(entry) {
    if (entry.finished || entry.run.url) return;
    const port = extractLocalPort(entry.captureBuf);
    if (!port) return;
    applyCapturedUrl(entry, port, 'output');
  }

  function startBackgroundCapture(entry) {
    clearBackgroundTimer(entry);
    if (!entry.captureEnabled) return;
    entry.backgroundTimer = setTimeout(function () {
      entry.backgroundTimer = null;
      entry.captureEnabled = false;
    }, BACKGROUND_CAPTURE_MS);
    if (entry.backgroundTimer && typeof entry.backgroundTimer.unref === 'function') {
      entry.backgroundTimer.unref();
    }
  }

  /** 启动输出里没有地址时，尝试从 README / start.sh 里读取文档化的本机端口并探测。 */
  async function tryDocumentedUrl(entry) {
    if (!entry.dir) return false;
    const ports = documentedPorts(entry.dir);
    for (const port of ports) {
      if (entry.finished || entry.run.url) return Boolean(entry.run.url);
      const alive = await probeHttpPort(port, DOC_PROBE_TIMEOUT_MS);
      if (alive) {
        applyCapturedUrl(entry, port, 'doc');
        return true;
      }
    }
    return false;
  }

  function resolveWithoutUrl(entry) {
    if (entry.finished || entry.run.url) return;
    entry.run.status = 'running';
    appendLog(entry.run, '[project-scan] 未在启动输出中发现访问地址，继续在后台等待 120 秒；也可在日志里确认端口');
    notify(entry.run);
    resolveEntry(entry);
    startBackgroundCapture(entry);
  }

  function startCaptureTimer(entry) {
    clearCaptureTimer(entry);
    entry.captureTimer = setTimeout(function () {
      entry.captureTimer = null;
      if (entry.finished || entry.run.url || entry.run.status !== 'starting') return;
      void tryDocumentedUrl(entry)
        .then(function (found) {
          if (found) return;
          resolveWithoutUrl(entry);
        })
        .catch(function () {
          resolveWithoutUrl(entry);
        });
    }, portTimeoutMs);
  }

  /* ---------------- 运行结束 ---------------- */

  function finalizeRun(entry, status, exitCode, systemLogLine) {
    const run = entry.run;
    run.status = status;
    run.exitCode = exitCode == null ? null : exitCode;
    run.endedAt = nowIso();
    clearCaptureTimer(entry);
    clearBackgroundTimer(entry);
    clearKillTimer(entry);
    entry.captureEnabled = false;
    flushPartial(entry);
    if (systemLogLine) appendLog(run, systemLogLine);
    active.delete(entry.projectId);
    current.set(entry.projectId, run);
    notify(run);
    resolveEntry(entry);
  }

  function finishRun(entry, code, signal) {
    if (entry.finished) return;
    entry.finished = true;
    entry.exited = true;
    // 被信号终止（code === null，例如 stop 的 SIGTERM）按正常结束处理；
    // 非 0 退出码按失败处理。
    let status = 'exited';
    if (code !== 0 && code !== null && !entry.stopping) status = 'failed';
    const systemLine =
      status === 'failed'
        ? '[project-scan] 进程异常退出（exitCode=' + code + (signal ? ', signal=' + signal : '') + '）'
        : null;
    finalizeRun(entry, status, code, systemLine);
    // 主动停止时，进程组组长退出后可能还有子进程残留：补一刀 SIGKILL 清理整个进程组
    if (entry.stopping && entry.child && entry.child.pid) {
      terminateProcessGroup(entry.child.pid, 'SIGKILL');
    }
    if (entry.onExitResolve) {
      const resolve = entry.onExitResolve;
      entry.onExitResolve = null;
      resolve();
    }
  }

  function failEntry(entry, message) {
    if (entry.finished) return;
    entry.finished = true;
    entry.exited = true;
    finalizeRun(entry, 'failed', null, '[project-scan] ' + message);
    if (entry.onExitResolve) {
      const resolve = entry.onExitResolve;
      entry.onExitResolve = null;
      resolve();
    }
  }

  /* ---------------- detect ---------------- */

  function resolveProjectDir(project) {
    if (!project || typeof project !== 'object') return null;
    const raw = project.path || (project.dir ? join(root, String(project.dir)) : null);
    if (!raw) return null;
    // 绝对路径原样使用；相对路径按 root 解析
    return resolve(root, String(raw));
  }

  function projectIdOf(project) {
    if (project && project.id) return String(project.id);
    const fallback = project && (project.dir || (project.path ? basename(project.path) : ''));
    const slug = String(fallback || 'project')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug || 'project';
  }

  function noneInfo(reason) {
    return {
      runnable: false,
      kind: 'none',
      command: null,
      runHint: '未检测到运行入口',
      reason: reason || NONE_REASON
    };
  }

  function detectUncached(project, dir) {
    let stat;
    try {
      stat = statSync(dir);
    } catch (err) {
      return noneInfo('项目目录不存在或无法读取');
    }
    if (!stat.isDirectory()) return noneInfo('项目路径不是一个目录');

    // 1. package.json 的 scripts：dev > start > serve > preview
    const pkgPath = join(dir, 'package.json');
    if (isFile(pkgPath)) {
      let pkg = null;
      try {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      } catch (err) {
        pkg = null;
      }
      const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : null;
      if (scripts) {
        for (const scriptName of SCRIPT_PRIORITY) {
          const scriptValue = scripts[scriptName];
          if (typeof scriptValue === 'string' && scriptValue.trim()) {
            const command = packageManagerFor(dir) + ' run ' + scriptName;
            return {
              runnable: true,
              kind: 'command',
              command,
              runHint: command,
              reason: null
            };
          }
        }
      }
    }

    // 2. start.sh / run.sh（用 bash 执行，不要求可执行位）
    for (const scriptName of ['start.sh', 'run.sh']) {
      if (isFile(join(dir, scriptName))) {
        const command = 'bash ' + quoteShellArg(scriptName);
        return { runnable: true, kind: 'command', command, runHint: command, reason: null };
      }
    }

    // 3. index.html：静态预览，不起子进程
    if (isFile(join(dir, 'index.html'))) {
      return { runnable: true, kind: 'static', command: null, runHint: '静态页面预览', reason: null };
    }

    // 4. Godot 项目
    if (isFile(join(dir, 'project.godot'))) {
      const command = 'open -a Godot ' + quoteShellArg(dir);
      return { runnable: true, kind: 'open', command, runHint: 'Godot 项目', reason: null };
    }

    // 5. Python 入口
    for (const pyFile of ['server.py', 'app.py', 'main.py']) {
      if (isFile(join(dir, pyFile))) {
        const command = 'python3 ' + pyFile;
        return { runnable: true, kind: 'command', command, runHint: command, reason: null };
      }
    }

    // 6. Xcode 工程
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      entries = [];
    }
    for (const entryName of entries) {
      if (!entryName.endsWith('.xcodeproj')) continue;
      if (!isDirectory(join(dir, entryName))) continue;
      const command = 'open ' + quoteShellArg(join(dir, entryName));
      return { runnable: true, kind: 'open', command, runHint: 'Xcode 项目', reason: null };
    }

    // 7. 不可运行
    return noneInfo(NONE_REASON);
  }

  function detect(project) {
    const dir = resolveProjectDir(project);
    if (!dir) return cloneRunInfo(noneInfo('项目路径无效，无法检测运行入口'));

    // 缓存键 = 项目目录 mtime + scanner 提供的 updatedAt；避免每次请求都读盘
    let dirMtime = 'missing';
    try {
      dirMtime = String(statSync(dir).mtimeMs);
    } catch (err) {
      dirMtime = 'missing';
    }
    const cacheKey = dirMtime + '|' + (project && project.updatedAt ? project.updatedAt : '');
    const cached = detectCache.get(dir);
    if (cached && cached.key === cacheKey) return cloneRunInfo(cached.info);

    const info = detectUncached(project, dir);
    if (detectCache.size >= DETECT_CACHE_LIMIT) detectCache.clear();
    detectCache.set(dir, { key: cacheKey, info });
    return cloneRunInfo(info);
  }

  /* ---------------- run ---------------- */

  function createEntry(runState, kind) {
    const entry = {
      projectId: runState.projectId,
      run: runState,
      kind,
      child: null,
      finished: false,
      exited: false,
      stopping: false,
      captureEnabled: kind === 'command',
      captureBuf: '',
      partial: { stdout: '', stderr: '' },
      captureTimer: null,
      backgroundTimer: null,
      killTimer: null,
      resolveDone: null,
      resolved: false,
      dir: runState.cwd || null,
      done: null,
      onExitResolve: null
    };
    entry.done = new Promise(function (resolveDone) {
      entry.resolveDone = resolveDone;
    });
    return entry;
  }

  async function run(project) {
    const dir = resolveProjectDir(project);
    const projectId = projectIdOf(project);
    if (!dir) throw makeRunnerError('NOT_RUNNABLE', '项目路径无效，无法运行。');
    if (active.has(projectId)) {
      throw makeRunnerError('ALREADY_RUNNING', '这个项目已经在运行中，请先停止。');
    }
    const info = detect(project);
    if (!info.runnable || info.kind === 'none') {
      throw makeRunnerError('NOT_RUNNABLE', info.reason || '这个项目暂时无法自动运行。');
    }

    const runState = {
      runId: newRunId(),
      projectId,
      status: 'starting',
      url: null,
      command: info.command == null ? null : info.command,
      cwd: dir,
      pid: null,
      startedAt: nowIso(),
      endedAt: null,
      exitCode: null,
      log: []
    };
    const entry = createEntry(runState, info.kind);
    current.set(projectId, runState);
    addRecord(runState);
    active.set(projectId, entry); // 同一项目同时只允许一个运行实例

    // 静态预览：不需要子进程，直接置 running 并返回 /preview/<id>/
    if (info.kind === 'static') {
      runState.status = 'running';
      runState.url = '/preview/' + encodeURIComponent(projectId) + '/';
      appendLog(runState, '[project-scan] 静态预览已就绪：' + runState.url + '（无需启动子进程）');
      notify(runState);
      return snapshotRun(runState);
    }

    // 项目自带 Python 虚拟环境时优先使用：start.sh 里的 pip / python3 会解析到 .venv，
    // 避免系统 python 缺依赖或 pip 无权限写 ~/Library/Python（示例 Python 项目就是这种情况）。
    const venvBin = findProjectVenv(dir);
    if (venvBin) {
      appendLog(runState, '[project-scan] 使用项目虚拟环境：' + resolve(venvBin, '..'));
    }

    notify(runState); // starting 状态先通知一次（SSE）

    const env = Object.assign({}, process.env, { FORCE_COLOR: '0' });
    if (venvBin) {
      env.PATH = venvBin + (env.PATH ? ':' + env.PATH : '');
      env.VIRTUAL_ENV = resolve(venvBin, '..');
      env.PIP_DISABLE_PIP_VERSION_CHECK = '1';
    }
    let child = null;
    try {
      child = spawn(runState.command, {
        cwd: dir,
        shell: true,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env
      });
    } catch (err) {
      failEntry(entry, '启动失败：' + ((err && err.message) || err));
      return entry.done;
    }

    entry.child = child;
    runState.pid = child.pid == null ? null : child.pid;

    if (child.stdout) {
      child.stdout.on('data', function (chunk) {
        handleOutput(entry, chunk, 'stdout');
      });
      child.stdout.on('error', function () {});
    }
    if (child.stderr) {
      child.stderr.on('data', function (chunk) {
        handleOutput(entry, chunk, 'stderr');
      });
      child.stderr.on('error', function () {});
    }

    child.on('spawn', function () {
      if (runState.pid == null && child.pid != null) runState.pid = child.pid;
      if (entry.finished) return;
      if (info.kind === 'open') {
        // open 类命令（macOS open）没有端口可捕获：进程起来即视为 running，url 保持 null
        entry.captureEnabled = false;
        runState.status = 'running';
        notify(runState);
        resolveEntry(entry);
      } else {
        startCaptureTimer(entry);
      }
    });

    child.on('error', function (err) {
      failEntry(entry, '启动失败：' + ((err && err.message) || err));
    });

    child.on('exit', function (code, signal) {
      finishRun(entry, code, signal);
    });

    child.on('close', function () {
      flushPartial(entry);
    });

    // 极端情况：starting 状态的回调里就被 stop()/shutdown() 结束掉了，
    // 此时子进程刚启动，需要立刻清理，避免遗留进程。
    if (entry.finished) {
      terminateProcessGroup(child.pid, 'SIGKILL');
      return entry.done;
    }

    return entry.done;
  }

  /* ---------------- stop ---------------- */

  function stop(projectId) {
    const id = String(projectId);
    const entry = active.get(id);
    if (!entry) return null;

    // 静态预览没有子进程：直接把状态置为 exited
    if (entry.kind === 'static' || !entry.child) {
      if (entry.finished) {
        active.delete(id);
        return null;
      }
      entry.finished = true;
      entry.exited = true;
      finalizeRun(entry, 'exited', 0, null);
      return snapshotRun(entry.run);
    }

    if (entry.finished) {
      active.delete(id);
      return null;
    }

    entry.stopping = true;
    terminateProcessGroup(entry.child.pid, 'SIGTERM');
    if (!entry.killTimer) {
      entry.killTimer = setTimeout(function () {
        entry.killTimer = null;
        if (!entry.finished) terminateProcessGroup(entry.child.pid, 'SIGKILL');
      }, stopGraceMs);
    }
    return snapshotRun(entry.run);
  }

  /* ---------------- state / logs ---------------- */

  function state(projectId) {
    return snapshotRun(current.get(String(projectId)) || null);
  }

  function logs(runId) {
    const run = records.get(String(runId));
    if (!run) return null;
    return { run: snapshotRun(run), logs: run.log.slice() };
  }

  /* ---------------- shutdown ---------------- */

  function shutdownEntry(entry) {
    if (entry.kind === 'static' || !entry.child || entry.finished) {
      if (!entry.finished) {
        entry.finished = true;
        entry.exited = true;
        finalizeRun(entry, 'exited', 0, null);
      }
      return Promise.resolve();
    }
    if (entry.finished) return Promise.resolve();

    entry.stopping = true;
    return new Promise(function (resolveShutdown) {
      let settled = false;
      let killTimer = null;
      let hardTimer = null;

      function done() {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (hardTimer) clearTimeout(hardTimer);
        entry.onExitResolve = null;
        resolveShutdown();
      }

      entry.onExitResolve = done;
      terminateProcessGroup(entry.child.pid, 'SIGTERM');

      killTimer = setTimeout(function () {
        terminateProcessGroup(entry.child.pid, 'SIGKILL');
        hardTimer = setTimeout(done, 500);
        hardTimer.unref();
      }, Math.min(700, stopGraceMs));
      killTimer.unref();

      if (entry.finished) done();
    });
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const entries = Array.from(active.values());
    await Promise.all(
      entries.map(function (entry) {
        return shutdownEntry(entry);
      })
    );
    active.clear();
    for (const entry of entries) {
      clearCaptureTimer(entry);
      clearKillTimer(entry);
      if (entry.finished) continue;
      // 兜底：理论上 shutdownEntry 已经 finalize 过
      entry.finished = true;
      entry.exited = true;
      finalizeRun(entry, 'exited', null, null);
    }
  }

  return { detect, run, stop, state, logs, shutdown };
}
