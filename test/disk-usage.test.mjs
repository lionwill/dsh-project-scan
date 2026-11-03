import test from 'node:test';
import assert from 'node:assert/strict';

import { createDiskUsage } from '../server/disk-usage.js';

const KB = 1024;

/** 可注入的假 run：记录每次调用，按 handler 返回/抛错。 */
function makeRun(handler) {
  const calls = [];
  async function run(command, args, options) {
    calls.push({ command: command, args: args, options: options });
    return handler(command, args, options, calls);
  }
  run.calls = calls;
  return run;
}

function duOk(path, kb) {
  return { stdout: String(kb) + '\t' + path + '\n' };
}

function cmdError(message, extra) {
  return Object.assign(new Error(message), extra || {});
}

test('compute 解析 du -sk 输出，KB 转 bytes，路径原样作为参数传入', async () => {
  const run = makeRun(function (command, args) {
    assert.equal(command, 'du');
    assert.equal(args[0], '-sk');
    if (args[1] === '/tmp/project-a') return duOk(args[1], 2048);
    if (args[1] === '/tmp/project b') return duOk(args[1], 0);
    return { stdout: '1\t' + args[1] + '\n' };
  });
  const disk = createDiskUsage({ run: run });
  const result = await disk.compute([
    { id: 'a', path: '/tmp/project-a' },
    { id: 'b', path: '/tmp/project b' }
  ]);

  assert.ok(result instanceof Map);
  assert.equal(result.size, 2);

  const a = result.get('a');
  assert.equal(a.bytes, 2048 * KB);
  assert.equal(a.error, null);
  assert.equal(typeof a.at, 'string');
  assert.ok(Number.isFinite(Date.parse(a.at)));

  const b = result.get('b');
  assert.equal(b.bytes, 0);
  assert.equal(b.error, null);

  assert.equal(run.calls.length, 2);
  assert.deepEqual(run.calls[0].args, ['-sk', '/tmp/project-a']);
  assert.equal(typeof run.calls[0].options.timeout, 'number');
});

test('du 并发度不超过 4，且确实并行', async () => {
  let active = 0;
  let maxActive = 0;
  const run = makeRun(async function () {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(function (resolve) { setTimeout(resolve, 8); });
    active -= 1;
    return { stdout: '1\t/any\n' };
  });
  const disk = createDiskUsage({ run: run });
  const projects = [];
  for (let i = 0; i < 12; i++) projects.push({ id: 'p' + i, path: '/fake/p' + i });

  const result = await disk.compute(projects);
  assert.equal(result.size, 12);
  assert.equal(maxActive, 4);
  assert.equal(run.calls.length, 12);
});

test('单个项目失败只记录中文 error，不影响其他项目，status 统计成功/失败数', async () => {
  const run = makeRun(function (command, args) {
    const target = args[1];
    if (target.includes('missing')) {
      throw cmdError('Command failed: du -sk /x/missing', {
        code: 1,
        stderr: 'du: /x/missing: No such file or directory\n'
      });
    }
    if (target.includes('denied')) {
      throw cmdError('Command failed: du -sk /x/denied', {
        code: 1,
        stderr: 'du: /x/denied: Permission denied\n'
      });
    }
    if (target.includes('timeout')) {
      throw cmdError('Command failed: du -sk /x/timeout', { killed: true });
    }
    if (target.includes('garbage')) return { stdout: 'not-a-number\n' };
    return duOk(target, 10);
  });
  const disk = createDiskUsage({ run: run });
  const result = await disk.compute([
    { id: 'ok', path: '/x/ok' },
    { id: 'missing', path: '/x/missing' },
    { id: 'denied', path: '/x/denied' },
    { id: 'timeout', path: '/x/timeout' },
    { id: 'garbage', path: '/x/garbage' }
  ]);

  assert.equal(result.get('ok').bytes, 10 * KB);
  assert.equal(result.get('ok').error, null);

  for (const id of ['missing', 'denied', 'timeout', 'garbage']) {
    assert.equal(result.get(id).bytes, null, id + ' 失败时 bytes 必须为 null');
    assert.equal(typeof result.get(id).error, 'string');
    assert.ok(result.get(id).error.length > 0);
  }
  assert.match(result.get('missing').error, /不存在/);
  assert.match(result.get('denied').error, /没有权限/);
  assert.match(result.get('timeout').error, /超时/);
  assert.match(result.get('garbage').error, /无法解析/);

  const status = disk.status();
  assert.equal(status.running, false);
  assert.equal(status.computed, 1);
  assert.equal(status.failed, 4);
});

test('du 命令本身不存在时给出可读原因', async () => {
  const run = makeRun(function () {
    throw cmdError('spawn du ENOENT', { code: 'ENOENT' });
  });
  const disk = createDiskUsage({ run: run });
  const result = await disk.compute([{ id: 'a', path: '/x/a' }]);
  assert.match(result.get('a').error, /缺少 du/);
  assert.equal(result.get('a').bytes, null);
});

test('缺 id / 缺路径的项目不执行 du，记录中文 error，compute 不抛异常', async () => {
  const run = makeRun(function () {
    return duOk('/x', 1);
  });
  const disk = createDiskUsage({ run: run });
  const result = await disk.compute([{ id: 'no-path' }, { path: '/x/no-id' }]);

  assert.equal(run.calls.length, 0);
  assert.equal(result.size, 1);
  assert.match(result.get('no-path').error, /缺少路径/);
  assert.equal(disk.status().failed, 2);
});

test('run 返回值容错：字符串 / 空值', async () => {
  const disk = createDiskUsage({ run: async function () { return '3\t/p\n'; } });
  const ok = await disk.compute([{ id: 'a', path: '/p' }]);
  assert.equal(ok.get('a').bytes, 3 * KB);

  const disk2 = createDiskUsage({ run: async function () { return undefined; } });
  const bad = await disk2.compute([{ id: 'b', path: '/p' }]);
  assert.match(bad.get('b').error, /无法解析/);
});

test('du 输出多行时按行求和（防御性解析）', async () => {
  const disk = createDiskUsage({ run: async function () { return { stdout: '10\t/a\n5\t/b\n' }; } });
  const result = await disk.compute([{ id: 'a', path: '/a' }]);
  assert.equal(result.get('a').bytes, 15 * KB);
});

test('status 反映进行中与完成后的状态', async () => {
  let release;
  const gate = new Promise(function (resolve) { release = resolve; });
  const run = makeRun(async function () {
    await gate;
    return duOk('/p', 1);
  });
  const disk = createDiskUsage({ run: run });

  assert.deepEqual(disk.status(), {
    running: false,
    lastRunAt: null,
    durationMs: null,
    computed: 0,
    failed: 0
  });

  const promise = disk.compute([{ id: 'a', path: '/p' }]);
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.equal(disk.status().running, true);

  release();
  const result = await promise;
  assert.equal(result.get('a').bytes, 1 * KB);

  const status = disk.status();
  assert.equal(status.running, false);
  assert.equal(status.computed, 1);
  assert.equal(status.failed, 0);
  assert.equal(typeof status.durationMs, 'number');
  assert.ok(status.durationMs >= 0);
  assert.ok(Date.parse(status.lastRunAt) > 0);
});

test('同一时间只跑一轮：重复调用复用进行中的 promise，不重复执行 du', async () => {
  let release;
  const gate = new Promise(function (resolve) { release = resolve; });
  const run = makeRun(async function () {
    await gate;
    return duOk('/p', 7);
  });
  const disk = createDiskUsage({ run: run });
  const projects = [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }];

  const first = disk.compute(projects);
  const second = disk.compute(projects);
  assert.equal(second, first);

  await new Promise(function (resolve) { setImmediate(resolve); });
  release();
  const results = await Promise.all([first, second]);

  assert.equal(results[0], results[1]);
  assert.equal(run.calls.length, 2);
  assert.equal(results[0].get('a').bytes, 7 * KB);
  assert.equal(disk.status().computed, 2);
});

test('空项目列表：返回空 Map，不执行 du，仍记录一次运行', async () => {
  const run = makeRun(function () { return duOk('/x', 1); });
  const disk = createDiskUsage({ run: run });
  const result = await disk.compute([]);

  assert.ok(result instanceof Map);
  assert.equal(result.size, 0);
  assert.equal(run.calls.length, 0);
  const status = disk.status();
  assert.equal(status.computed, 0);
  assert.equal(status.failed, 0);
  assert.ok(Date.parse(status.lastRunAt) > 0);
});

test('非数组输入按空列表处理，不抛异常', async () => {
  const disk = createDiskUsage({ run: async function () { return duOk('/x', 1); } });
  const result = await disk.compute(null);
  assert.equal(result.size, 0);
});
