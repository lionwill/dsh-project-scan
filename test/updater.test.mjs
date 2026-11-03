import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUpdater } from '../server/updater.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'project-scan-updater-'));
}

/** 造一个含 .git 目录的临时应用目录（只用于让 updater 认为是 git 仓库）。 */
function makeAppDir() {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

function fakeRun(responses) {
  const calls = [];
  const run = async function (args, options) {
    const key = args.join(' ');
    calls.push(key);
    const response = responses[key];
    if (typeof response === 'function') return response(args, options);
    if (response === undefined) return { code: 1, stdout: '', stderr: 'unexpected: ' + key };
    return Object.assign({ code: 0, stdout: '', stderr: '' }, response);
  };
  run.calls = calls;
  return run;
}

const BASE_RESPONSES = {
  'rev-parse --is-inside-work-tree': { stdout: 'true\n' },
  'status --porcelain --untracked-files=no': { stdout: '' },
  'remote get-url origin': { stdout: 'https://example.test/repo.git\n' },
  'symbolic-ref --short HEAD': { stdout: 'main\n' },
  'fetch --quiet origin': { stdout: '' },
  'rev-parse --verify origin/main': { stdout: '2222222\n' },
  'merge --ff-only origin/main': { stdout: 'Updating\n' }
};

function appDirWithGit() {
  return makeAppDir();
}

test('updater：关闭时直接返回 disabled，不执行任何 git 命令', async function () {
  const run = fakeRun({});
  const updater = createUpdater({ appDir: appDirWithGit(), run: run });
  const result = await updater.check({ enabled: false });
  assert.equal(result.lastResult.status, 'disabled');
  assert.equal(run.calls.length, 0);
});

test('updater：不是 git 仓库时返回 no-git', async function () {
  const updater = createUpdater({ appDir: tmpDir(), run: fakeRun({}) });
  const result = await updater.check({ enabled: true });
  assert.equal(result.lastResult.status, 'no-git');
});

test('updater：工作区有未提交修改时跳过', async function () {
  const run = fakeRun(Object.assign({}, BASE_RESPONSES, {
    'status --porcelain --untracked-files=no': { stdout: ' M server/index.js\n' }
  }));
  const updater = createUpdater({ appDir: appDirWithGit(), run: run });
  const result = await updater.check({ enabled: true });
  assert.equal(result.lastResult.status, 'dirty');
  assert.equal(result.checking, false);
});

test('updater：已是最新版本时返回 up-to-date', async function () {
  const run = fakeRun(Object.assign({}, BASE_RESPONSES, {
    'rev-parse HEAD': { stdout: '2222222\n' }
  }));
  const updater = createUpdater({ appDir: appDirWithGit(), run: run });
  const result = await updater.check({ enabled: true });
  assert.equal(result.lastResult.status, 'up-to-date');
  assert.equal(result.lastResult.needRestart, false);
});

test('updater：pull 到后端变更时标记需要重启', async function () {
  let headReads = 0;
  const run = fakeRun(Object.assign({}, BASE_RESPONSES, {
    'rev-parse HEAD': function () {
      headReads += 1;
      return { code: 0, stdout: headReads === 1 ? '1111111\n' : '2222222\n', stderr: '' };
    },
    'diff --name-only 1111111 2222222': { stdout: 'server/index.js\nserver/updater.js\n' }
  }));
  const updater = createUpdater({ appDir: appDirWithGit(), run: run });
  const result = await updater.check({ enabled: true });
  assert.equal(result.lastResult.status, 'updated');
  assert.equal(result.lastResult.needRestart, true);
  assert.equal(result.lastResult.needRefresh, false);
  assert.equal(result.lastResult.onlyStyle, false);
  assert.deepEqual(result.lastResult.changedFiles, ['server/index.js', 'server/updater.js']);
});

test('updater：只更新 styles.css 时标记仅样式', async function () {
  let headReads = 0;
  const run = fakeRun(Object.assign({}, BASE_RESPONSES, {
    'rev-parse HEAD': function () {
      headReads += 1;
      return { code: 0, stdout: headReads === 1 ? '1111111\n' : '2222222\n', stderr: '' };
    },
    'diff --name-only 1111111 2222222': { stdout: 'public/styles.css\n' }
  }));
  const updater = createUpdater({ appDir: appDirWithGit(), run: run });
  const result = await updater.check({ enabled: true });
  assert.equal(result.lastResult.onlyStyle, true);
  assert.equal(result.lastResult.needRefresh, false);
  assert.equal(result.lastResult.needRestart, false);
});

test('updater：更新 public/app.js 时需要刷新页面', async function () {
  let headReads = 0;
  const run = fakeRun(Object.assign({}, BASE_RESPONSES, {
    'rev-parse HEAD': function () {
      headReads += 1;
      return { code: 0, stdout: headReads === 1 ? '1111111\n' : '2222222\n', stderr: '' };
    },
    'diff --name-only 1111111 2222222': { stdout: 'public/app.js\npublic/styles.css\n' }
  }));
  const updater = createUpdater({ appDir: appDirWithGit(), run: run });
  const result = await updater.check({ enabled: true });
  assert.equal(result.lastResult.needRefresh, true);
  assert.equal(result.lastResult.needRestart, false);
  assert.equal(result.lastResult.onlyStyle, false);
});

test('updater：fetch 失败 / ff-only 失败时优雅降级', async function () {
  const fetchFail = fakeRun(Object.assign({}, BASE_RESPONSES, {
    'fetch --quiet origin': { code: 128, stdout: '', stderr: 'network error' }
  }));
  const updater1 = createUpdater({ appDir: appDirWithGit(), run: fetchFail });
  assert.equal((await updater1.check({ enabled: true })).lastResult.status, 'error');

  const mergeFail = fakeRun(Object.assign({}, BASE_RESPONSES, {
    'rev-parse HEAD': { stdout: '1111111\n' },
    'merge --ff-only origin/main': { code: 1, stdout: '', stderr: 'diverged' }
  }));
  const updater2 = createUpdater({ appDir: appDirWithGit(), run: mergeFail });
  const result = await updater2.check({ enabled: true });
  assert.equal(result.lastResult.status, 'skipped');
});

test('updater：onEvent 收到状态广播；status() 返回快照', async function () {
  const events = [];
  const run = fakeRun(Object.assign({}, BASE_RESPONSES, {
    'rev-parse HEAD': { stdout: '2222222\n' }
  }));
  const updater = createUpdater({
    appDir: appDirWithGit(),
    run: run,
    onEvent: function (payload) { events.push(payload); }
  });
  const before = updater.status();
  assert.equal(before.checking, false);
  assert.equal(before.lastResult, null);
  await updater.check({ enabled: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].lastResult.status, 'up-to-date');
  assert.ok(events[0].lastCheckedAt);
});

test('updater：本地已领先远端（merge 空操作）时按已最新处理', async function () {
  const run = fakeRun(Object.assign({}, BASE_RESPONSES, {
    'rev-parse HEAD': { stdout: '3333333\n' },
    'rev-parse --verify origin/main': { stdout: '2222222\n' },
    'merge --ff-only origin/main': { stdout: 'Already up to date.\n' }
  }));
  const updater = createUpdater({ appDir: appDirWithGit(), run: run });
  const result = await updater.check({ enabled: true });
  assert.equal(result.lastResult.status, 'up-to-date');
  assert.deepEqual(result.lastResult.changedFiles, []);
});
