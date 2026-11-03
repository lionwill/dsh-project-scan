/**
 * server/disk-usage.js — 项目文件夹磁盘占用（CONTRACT.md「磁盘占用」/ 第 4 节）
 *
 * 职责：
 *  - compute(projects, opts?): 用系统 du -sk 计算每个项目目录的总计磁盘占用
 *    （包含 node_modules / .venv / assets 等全部内容），并发度默认 4。
 *  - status(): 最近一轮的 running / lastRunAt / durationMs / computed / failed。
 *
 * 设计要点：
 *  - du 用 execFile 直接调用（不经过 shell），路径原样作为参数传入，天然避免注入与转义问题；
 *    输出格式为「SIZE\tPATH」，-k 表示 1024 字节块，所以 bytes = SIZE * 1024。
 *  - 单个项目失败（不存在 / 权限 / du 不可用 / 输出异常）只记录可读中文 error，绝不让整轮 compute 抛异常。
 *  - 同一时间只跑一轮：compute 进行中再次调用会复用当前这一轮的结果，避免扫描、手动触发叠加 du 风暴。
 *  - 返回 Map<projectId, { bytes: number|null, at: ISO 字符串, error: string|null }>。
 *  - run 可注入（测试里伪造 du 输出，不真的执行 du）。
 */

import { execFile } from 'node:child_process';

const DEFAULT_CONCURRENCY = 4;      // 契约：du 并发度 4
const MAX_CONCURRENCY = 16;
const DU_TIMEOUT_MS = 20000;        // 单目录超时；正常项目 0.01~0.35s，留足余量
const DU_MAX_BUFFER = 4 * 1024 * 1024;
const KB = 1024;

/** 默认命令执行器：execFile（不走 shell），返回 { stdout, stderr }；失败时把 stdout/stderr 挂到 error 上。 */
function defaultRun(command, args, options) {
  const opts = options || {};
  return new Promise(function (resolve, reject) {
    execFile(
      command,
      args,
      { timeout: DU_TIMEOUT_MS, maxBuffer: DU_MAX_BUFFER, ...opts },
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

function normalizeConcurrency(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(numeric)));
}

/** run 的返回值允许是 { stdout }、字符串或 null，统一取 stdout 文本。 */
function stdoutOf(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result.stdout === 'string') return result.stdout;
  if (result.stdout == null) return '';
  return String(result.stdout);
}

/**
 * 解析 du -sk 输出：「SIZE\tPATH」或「SIZE PATH」，单位 KB。
 * 正常单路径只有一行；若出现多行（不同 du 实现 / 异常情况）按行求和，保证至少不丢失占用。
 */
function parseDuOutput(stdout) {
  const lines = String(stdout == null ? '' : stdout).split(/\r?\n/);
  let bytes = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)(?:\s+.*)?$/);
    if (!match) continue;
    const sizeKb = Number(match[1]);
    if (!Number.isFinite(sizeKb) || sizeKb < 0) continue;
    const lineBytes = sizeKb * KB;
    bytes = bytes == null ? lineBytes : bytes + lineBytes;
  }
  return bytes;
}

/** 把 du 失败原因翻译成可读中文。 */
function describeDuError(err) {
  const error = err || {};
  const code = error.code;
  const stderr = typeof error.stderr === 'string' ? error.stderr : '';
  const message = String(error.message || '');
  const combined = (stderr + '\n' + message).toLowerCase();

  if (error.killed || code === 'ETIMEDOUT' || /timed out|timeout/.test(combined)) {
    return 'du 执行超时';
  }
  // 命令本身不存在（spawn du ENOENT）与 du 报告路径不存在（exit 1 + stderr）要区分开
  if (code === 'ENOENT' && stderr.trim() === '' && /enoent|not found/i.test(message)) {
    return '系统缺少 du 命令，无法计算磁盘占用';
  }
  if (/permission denied|operation not permitted|eacces/.test(combined)) {
    return '没有权限读取该目录';
  }
  if (/no such file or directory|not a directory|enoent/.test(combined)) {
    return '目录不存在或已被移除';
  }
  if (code === 'ENOMEM' || code === 'EMFILE' || code === 'ENFILE') {
    return '系统资源不足，暂时无法计算磁盘占用';
  }
  const detail = message || stderr.trim() || (code != null ? '退出码 ' + code : '未知错误');
  return '计算磁盘占用失败：' + detail.slice(0, 200);
}

export function createDiskUsage(options) {
  const opts = options || {};
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  const run = typeof opts.run === 'function' ? opts.run : defaultRun;

  const state = {
    running: false,
    lastRunAt: null,
    durationMs: null,
    computed: 0,
    failed: 0
  };
  let inflight = null;

  async function measureOne(project) {
    const at = new Date().toISOString();
    const id = project && project.id != null ? String(project.id) : '';
    const target = project && project.path != null ? String(project.path).trim() : '';

    if (!id) {
      return { id: '', record: { bytes: null, at: at, error: '项目缺少 id，无法计算磁盘占用' } };
    }
    if (!target) {
      return { id: id, record: { bytes: null, at: at, error: '项目缺少路径，无法计算磁盘占用' } };
    }

    try {
      const result = await run('du', ['-sk', target], { timeout: DU_TIMEOUT_MS });
      const bytes = parseDuOutput(stdoutOf(result));
      if (bytes == null) {
        return { id: id, record: { bytes: null, at: at, error: 'du 输出无法解析，未能得到磁盘占用' } };
      }
      return { id: id, record: { bytes: bytes, at: at, error: null } };
    } catch (err) {
      return { id: id, record: { bytes: null, at: at, error: describeDuError(err) } };
    }
  }

  /**
   * 计算一批项目的磁盘占用。
   * @param {Array<{id: string, path: string}>} projects
   * @param {{concurrency?: number}} [computeOptions]
   * @returns {Promise<Map<string, {bytes: number|null, at: string, error: string|null}>>}
   */
  function compute(projects, computeOptions) {
    if (inflight) return inflight; // 同一时间只跑一轮：复用进行中的这一轮

    const list = Array.isArray(projects) ? projects.filter(Boolean) : [];
    const config = computeOptions || {};
    const concurrency = normalizeConcurrency(config.concurrency);
    const startedAt = Date.now();

    state.running = true;

    const promise = (async function () {
      const results = new Map();
      let computed = 0;
      let failed = 0;
      try {
        let cursor = 0;
        async function worker() {
          for (;;) {
            if (cursor >= list.length) return;
            const index = cursor;
            cursor += 1;
            const outcome = await measureOne(list[index]);
            if (outcome.id) results.set(outcome.id, outcome.record);
            if (outcome.record.error) failed += 1;
            else computed += 1;
          }
        }
        const workerCount = Math.min(concurrency, list.length);
        const workers = [];
        for (let i = 0; i < workerCount; i++) workers.push(worker());
        await Promise.all(workers);
      } finally {
        const durationMs = Date.now() - startedAt;
        state.running = false;
        state.lastRunAt = new Date().toISOString();
        state.durationMs = durationMs;
        state.computed = computed;
        state.failed = failed;
        inflight = null;
        if (list.length > 0) {
          log('[disk-usage] 完成：成功 ' + computed + '，失败 ' + failed + '，耗时 ' + durationMs + 'ms');
        }
      }
      return results;
    })();

    inflight = promise;
    // compute 设计为永不 reject；这里兜底，避免调用方不 await 时产生未处理拒绝。
    promise.catch(function () {});
    return promise;
  }

  function status() {
    return {
      running: state.running,
      lastRunAt: state.lastRunAt,
      durationMs: state.durationMs,
      computed: state.computed,
      failed: state.failed
    };
  }

  return { compute: compute, status: status };
}
