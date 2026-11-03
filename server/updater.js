/**
 * server/updater.js — 轻量的 git 自动更新（启动时后台检查，fast-forward 拉取）
 *
 * 行为：
 *  - 只在服务启动时（或设置里点「立即检查」）跑一次；后台异步，不阻塞服务启动；
 *  - 仅当目录是 git 仓库、配置了 origin、工作区没有未提交的已跟踪修改时，
 *    才会 fetch + fast-forward 合并；不做强制覆盖、不处理分叉；
 *  - 更新完成后按文件类型判断影响：server/**、package.json、start.sh、config.json → 需要重启；
 *    public/**（除 styles.css）→ 需要刷新页面；只有 styles.css → 仅样式更新，toast 即可；
 *  - 不修改 data/，不写 DSH 配置；失败只记录状态，不影响服务。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';

const BACKEND_PREFIXES = ['server/', 'package.json', 'start.sh', 'config.json'];
const STYLE_FILE = 'public/styles.css';

function runGit(appDir, args, timeoutMs) {
  return new Promise(function (resolve) {
    execFile(
      'git',
      args,
      {
        cwd: appDir,
        timeout: timeoutMs || 20000,
        maxBuffer: 4 * 1024 * 1024,
        env: Object.assign({}, process.env, {
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '/bin/true',
          GIT_PAGER: 'cat',
          LC_ALL: 'C'
        })
      },
      function (error, stdout, stderr) {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: error || null
        });
      }
    );
  });
}

function classifyChanges(files) {
  const backend = [];
  const frontend = [];
  const styleOnly = [];
  const other = [];
  for (const file of files) {
    if (BACKEND_PREFIXES.some(function (prefix) { return file === prefix || file.startsWith(prefix); })) backend.push(file);
    else if (file.startsWith('public/')) {
      if (file === STYLE_FILE) styleOnly.push(file);
      else frontend.push(file);
    } else other.push(file);
  }
  return {
    backend: backend,
    frontend: frontend,
    styleOnly: styleOnly,
    other: other,
    needRestart: backend.length > 0,
    needRefresh: frontend.length > 0,
    onlyStyle: files.length > 0 && frontend.length === 0 && backend.length === 0 && other.length === 0 && styleOnly.length > 0
  };
}

/**
 * @param {{ appDir: string, log?: (msg: string) => void,
 *           run?: (args: string[], options?: object) => Promise<{code:number, stdout:string, stderr:string}>,
 *           onEvent?: (payload: object) => void }} options
 */
export function createUpdater(options) {
  const opts = options || {};
  const appDir = opts.appDir;
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {};
  const run = typeof opts.run === 'function' ? opts.run : function (args, runOptions) {
    return runGit(appDir, args, runOptions && runOptions.timeoutMs);
  };

  let checking = false;
  let status = {
    enabled: false,
    checking: false,
    lastCheckedAt: null,
    lastResult: null
  };

  function snapshot() {
    return Object.assign({}, status, { checking: checking });
  }

  function finish(result) {
    status = {
      enabled: result.enabled,
      checking: false,
      lastCheckedAt: new Date().toISOString(),
      lastResult: result
    };
    try {
      onEvent(snapshot());
    } catch (err) {
      /* 广播失败不影响更新状态 */
    }
    return Object.assign({}, status, { checking: false });
  }

  async function check(checkOptions) {
    const checkOpts = checkOptions || {};
    const enabled = checkOpts.enabled !== false;
    status.enabled = enabled;
    if (!enabled) {
      return finish({ status: 'disabled', message: '自动更新已关闭', changedFiles: [], needRestart: false, needRefresh: false, onlyStyle: false });
    }
    if (checking) return snapshot();
    checking = true;
    try {
      if (!fs.existsSync(appDir)) {
        return finish({ status: 'error', message: '应用目录不存在', changedFiles: [], needRestart: false, needRefresh: false, onlyStyle: false });
      }
      if (!fs.existsSync(appDir + '/.git')) {
        return finish({ status: 'no-git', message: '应用目录不是 git 仓库，跳过自动更新', changedFiles: [], needRestart: false, needRefresh: false, onlyStyle: false });
      }

      const inside = await run(['rev-parse', '--is-inside-work-tree']);
      if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
        return finish({ status: 'no-git', message: '无法读取 git 仓库信息，跳过自动更新', changedFiles: [], needRestart: false, needRefresh: false, onlyStyle: false });
      }

      const dirty = await run(['status', '--porcelain', '--untracked-files=no']);
      if (dirty.code !== 0) {
        return finish({ status: 'error', message: '读取工作区状态失败', changedFiles: [], needRestart: false, needRefresh: false, onlyStyle: false });
      }
      if (dirty.stdout.trim() !== '') {
        return finish({ status: 'dirty', message: '工作区有未提交的修改，跳过自动更新', changedFiles: [], needRestart: false, needRefresh: false, onlyStyle: false });
      }

      const remote = await run(['remote', 'get-url', 'origin']);
      if (remote.code !== 0 || remote.stdout.trim() === '') {
        return finish({ status: 'no-remote', message: '没有配置 git 远端 origin，跳过自动更新', changedFiles: [], needRestart: false, needRefresh: false, onlyStyle: false });
      }

      const before = await run(['rev-parse', 'HEAD']);
      const beforeSha = before.stdout.trim();
      if (before.code !== 0 || !beforeSha) {
        return finish({ status: 'error', message: '读取本地版本失败', changedFiles: [], needRestart: false, needRefresh: false, onlyStyle: false });
      }

      const branch = await run(['symbolic-ref', '--short', 'HEAD']);
      const branchName = branch.stdout.trim() || 'main';
      const fetchResult = await run(['fetch', '--quiet', 'origin'], { timeoutMs: 30000 });
      if (fetchResult.code !== 0) {
        return finish({ status: 'error', message: '拉取远端信息失败（网络或权限）', changedFiles: [], needRestart: false, needRefresh: false, onlyStyle: false });
      }

      const remoteRef = await run(['rev-parse', '--verify', 'origin/' + branchName]);
      const remoteSha = remoteRef.stdout.trim();
      if (remoteRef.code !== 0 || !remoteSha) {
        return finish({ status: 'no-remote', message: '远端没有 ' + branchName + ' 分支，跳过自动更新', changedFiles: [], needRestart: false, needRefresh: false, onlyStyle: false });
      }
      if (remoteSha === beforeSha) {
        return finish({ status: 'up-to-date', message: '已是最新版本', changedFiles: [], needRestart: false, needRefresh: false, onlyStyle: false });
      }

      const merge = await run(['merge', '--ff-only', 'origin/' + branchName], { timeoutMs: 30000 });
      if (merge.code !== 0) {
        return finish({
          status: 'skipped',
          message: '本地与远端历史不一致，已跳过自动更新',
          changedFiles: [],
          needRestart: false,
          needRefresh: false,
          onlyStyle: false
        });
      }

      const after = await run(['rev-parse', 'HEAD']);
      const afterSha = after.stdout.trim();
      const diff = await run(['diff', '--name-only', beforeSha, afterSha]);
      const changedFiles = diff.stdout
        .split(/\r?\n/)
        .map(function (line) { return line.trim(); })
        .filter(Boolean);
      const changes = classifyChanges(changedFiles);
      const summary = '已更新 ' + changedFiles.length + ' 个文件';
      const message = changes.needRestart
        ? summary + '，包含后端变更，需要重启服务后生效'
        : changes.needRefresh
          ? summary + '，包含前端变更，需要刷新页面后生效'
          : changes.onlyStyle
            ? summary + '（样式更新）'
            : summary;
      const result = {
        status: 'updated',
        message: message,
        before: beforeSha,
        after: afterSha,
        changedFiles: changedFiles,
        needRestart: changes.needRestart,
        needRefresh: changes.needRefresh,
        onlyStyle: changes.onlyStyle
      };
      log('[updater] ' + message + '（' + beforeSha.slice(0, 7) + ' -> ' + afterSha.slice(0, 7) + '）');
      return finish(result);
    } catch (err) {
      return finish({
        status: 'error',
        message: '自动更新失败：' + String((err && err.message) || err),
        changedFiles: [],
        needRestart: false,
        needRefresh: false,
        onlyStyle: false
      });
    } finally {
      checking = false;
      status.checking = false;
    }
  }

  return {
    check: check,
    status: snapshot,
    /** 启动时调用：默认延迟执行一次，后台静默，不阻塞服务启动。 */
    start: function (startOptions) {
      const startOpts = startOptions || {};
      const enabled = startOpts.enabled !== false;
      status.enabled = enabled;
      if (!enabled) return null;
      const timer = setTimeout(function () {
        check({ enabled: true });
      }, Number(startOpts.delayMs || 2000));
      if (timer && typeof timer.unref === 'function') timer.unref();
      return timer;
    }
  };
}

export default createUpdater;
