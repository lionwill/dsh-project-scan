import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaces, MAX_WORKSPACES } from '../server/workspaces.js';

function mkdir(target) {
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function real(target) {
  return fs.realpathSync(target);
}

function isRootUser() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** 临时沙箱：base/default-root + base/data，测试结束整目录删除。 */
function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'project-scan-ws-'));
  const defaultRoot = mkdir(path.join(base, 'default-root'));
  const dataDir = path.join(base, 'data');
  t.after(function () {
    try { fs.chmodSync(base, 0o755); } catch (err) { /* ignore */ }
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (err) { /* ignore */ }
  });
  return {
    base: base,
    defaultRoot: defaultRoot,
    dataDir: dataDir,
    makeDir: function (name) { return mkdir(path.join(base, name)); },
    makeWorkspaces: function (extra) {
      return createWorkspaces(Object.assign({ dataDir: dataDir, defaultRoot: defaultRoot }, extra || {}));
    }
  };
}

test('默认工作区固定 main，由 defaultRoot 决定', function (t) {
  const s = sandbox(t);
  const ws = s.makeWorkspaces();
  const listed = ws.load();

  assert.equal(listed.length, 1);
  const main = listed[0];
  assert.equal(main.id, 'main');
  assert.equal(main.name, path.basename(s.defaultRoot));
  assert.equal(main.path, s.defaultRoot);
  assert.equal(main.isDefault, true);
  assert.ok(!Number.isNaN(Date.parse(main.addedAt)));
  assert.deepEqual(ws.defaultWorkspace(), main);
  assert.deepEqual(ws.get('main'), main);
  assert.equal(ws.get('ws-nope'), null);
  assert.deepEqual(ws.list(), listed);
  assert.equal(ws.limit, MAX_WORKSPACES);
});

test('默认工作区不可删除，未知工作区返回 NOT_FOUND', function (t) {
  const s = sandbox(t);
  const ws = s.makeWorkspaces();
  ws.load();

  const blocked = ws.remove('main');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'DEFAULT_WORKSPACE');
  assert.equal(ws.list().length, 1);

  const missing = ws.remove('ws-missing');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'NOT_FOUND');

  assert.equal(ws.remove('').code, 'NOT_FOUND');
  assert.equal(ws.remove(null).code, 'NOT_FOUND');
});

test('add 成功：realpath 归一、id 前缀、默认工作区始终在前', function (t) {
  const s = sandbox(t);
  const ws = s.makeWorkspaces();
  ws.load();
  const projectDir = s.makeDir('my-project');

  const result = ws.add(projectDir);
  assert.equal(result.ok, true);
  assert.equal(result.workspace.id, 'ws-my-project');
  assert.equal(result.workspace.name, 'my-project');
  assert.equal(result.workspace.path, real(projectDir));
  assert.equal(result.workspace.isDefault, false);
  assert.ok(!Number.isNaN(Date.parse(result.workspace.addedAt)));

  const listed = ws.list();
  assert.equal(listed.length, 2);
  assert.equal(listed[0].id, 'main');
  assert.equal(listed[1].id, 'ws-my-project');
  assert.deepEqual(ws.get('ws-my-project'), result.workspace);
  assert.equal(ws.get('ws-my-project').isDefault, false);
});

test('add 校验错误码：空 / 相对 / 不存在 / 文件 / 非字符串', function (t) {
  const s = sandbox(t);
  const ws = s.makeWorkspaces();
  ws.load();

  const cases = [
    [undefined, 'INVALID_PATH'],
    [null, 'INVALID_PATH'],
    [123, 'INVALID_PATH'],
    ['', 'INVALID_PATH'],
    ['   ', 'INVALID_PATH'],
    ['relative/path', 'INVALID_PATH'],
    [path.join(s.base, 'does-not-exist'), 'INVALID_PATH']
  ];
  for (const item of cases) {
    const res = ws.add(item[0]);
    assert.equal(res.ok, false, '输入 ' + String(item[0]) + ' 应失败');
    assert.equal(res.code, item[1], '输入 ' + String(item[0]));

    const resolved = ws.resolve(item[0]);
    assert.equal(resolved.ok, false);
    assert.equal(resolved.code, item[1]);
    assert.ok(typeof resolved.error === 'string' && resolved.error.length > 0);
  }

  const filePath = path.join(s.base, 'note.txt');
  fs.writeFileSync(filePath, 'x');
  const fileResult = ws.add(filePath);
  assert.equal(fileResult.ok, false);
  assert.equal(fileResult.code, 'NOT_DIRECTORY');
  assert.equal(ws.list().length, 1);
});

test('add 支持 ~ 展开（resolve 不改状态）', function (t) {
  const s = sandbox(t);
  const ws = s.makeWorkspaces();
  ws.load();

  const resolved = ws.resolve('~');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.realPath, real(os.homedir()));
  assert.equal(resolved.path, real(os.homedir()));

  const resolvedSlash = ws.resolve('~/');
  assert.equal(resolvedSlash.ok, true);
  assert.equal(resolvedSlash.realPath, real(os.homedir()));

  const unsupported = ws.resolve('~someone/dir');
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.code, 'INVALID_PATH');

  assert.equal(ws.list().length, 1, 'resolve 不应修改工作区列表');

  const added = ws.add('~');
  assert.equal(added.ok, true);
  assert.equal(added.workspace.path, real(os.homedir()));
  const removed = ws.remove(added.workspace.id);
  assert.equal(removed.ok, true);
  assert.equal(ws.list().length, 1);
});

test('重复路径（含符号链接、默认工作区自身）返回 WORKSPACE_EXISTS', function (t) {
  const s = sandbox(t);
  const ws = s.makeWorkspaces();
  ws.load();
  const projectDir = s.makeDir('dupe-me');

  assert.equal(ws.add(projectDir).ok, true);
  const again = ws.add(projectDir);
  assert.equal(again.ok, false);
  assert.equal(again.code, 'WORKSPACE_EXISTS');

  const alias = path.join(s.base, 'alias-link');
  fs.symlinkSync(projectDir, alias, 'dir');
  const viaLink = ws.add(alias);
  assert.equal(viaLink.ok, false);
  assert.equal(viaLink.code, 'WORKSPACE_EXISTS');

  const defaultAgain = ws.add(s.defaultRoot);
  assert.equal(defaultAgain.ok, false);
  assert.equal(defaultAgain.code, 'WORKSPACE_EXISTS');
  assert.equal(ws.list().length, 2);
});

test('add 生成 ws-<slug>，目录名冲突时追加 -2 / -3', function (t) {
  const s = sandbox(t);
  const ws = s.makeWorkspaces();
  ws.load();

  const first = mkdir(path.join(s.base, 'group-one', 'dup'));
  const second = mkdir(path.join(s.base, 'group-two', 'dup'));
  const third = mkdir(path.join(s.base, 'group-three', 'dup'));

  const a = ws.add(first);
  const b = ws.add(second);
  const c = ws.add(third);
  assert.equal(a.workspace.id, 'ws-dup');
  assert.equal(b.workspace.id, 'ws-dup-2');
  assert.equal(c.workspace.id, 'ws-dup-3');
  assert.equal(a.workspace.name, 'dup');
  assert.equal(b.workspace.name, 'dup');
  assert.equal(ws.list().length, 4);
});

test('remove 成功返回被移除的工作区，列表随之变化', function (t) {
  const s = sandbox(t);
  const ws = s.makeWorkspaces();
  ws.load();
  const a = ws.add(s.makeDir('alpha-ws')).workspace;
  const b = ws.add(s.makeDir('beta-ws')).workspace;
  assert.deepEqual(ws.list().map(function (item) { return item.id; }), ['main', a.id, b.id]);

  const removed = ws.remove(a.id);
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.workspace, a);
  assert.deepEqual(ws.list().map(function (item) { return item.id; }), ['main', b.id]);
  assert.equal(ws.get(a.id), null);

  assert.equal(ws.remove(a.id).code, 'NOT_FOUND');
  assert.equal(ws.list().length, 2);
});

test('总数上限 10（含默认工作区），超出返回 MAX_WORKSPACES', function (t) {
  const s = sandbox(t);
  const ws = s.makeWorkspaces();
  ws.load();

  const total = MAX_WORKSPACES;
  for (let i = 1; i < total; i += 1) {
    const d = s.makeDir('limit-' + i);
    const res = ws.add(d);
    assert.equal(res.ok, true, '第 ' + i + ' 个应成功');
  }
  assert.equal(ws.list().length, total);

  const overflow = ws.add(s.makeDir('limit-overflow'));
  assert.equal(overflow.ok, false);
  assert.equal(overflow.code, 'MAX_WORKSPACES');
  assert.equal(ws.list().length, total);
});

test('禁止把自身 data 目录（及其子目录）添加为工作区', function (t) {
  const s = sandbox(t);
  const ws = s.makeWorkspaces();
  ws.load();

  const dataResult = ws.add(s.dataDir);
  assert.equal(dataResult.ok, false);
  assert.equal(dataResult.code, 'FORBIDDEN_PATH');

  const nested = mkdir(path.join(s.dataDir, 'nested'));
  const nestedResult = ws.add(nested);
  assert.equal(nestedResult.ok, false);
  assert.equal(nestedResult.code, 'FORBIDDEN_PATH');
  assert.equal(ws.list().length, 1);
});

test('无权限目录返回 NOT_READABLE', function (t) {
  if (isRootUser()) {
    t.skip('以 root 运行时无法通过 chmod 模拟权限错误');
    return;
  }
  const s = sandbox(t);
  const ws = s.makeWorkspaces();
  ws.load();
  const locked = s.makeDir('locked-dir');
  const originalMode = fs.statSync(locked).mode & 0o777;
  fs.chmodSync(locked, 0o000);
  try {
    let readable = true;
    try {
      fs.accessSync(locked, fs.constants.R_OK);
    } catch (err) {
      readable = false;
    }
    if (readable) {
      t.skip('当前环境仍可读取 000 目录，跳过权限用例');
      return;
    }
    const result = ws.add(locked);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NOT_READABLE');

    const resolved = ws.resolve(locked);
    assert.equal(resolved.ok, false);
    assert.equal(resolved.code, 'NOT_READABLE');
  } finally {
    fs.chmodSync(locked, originalMode);
  }
});

test('save 原子持久化，重新 load 后一致（默认工作区 addedAt 保持首次时间）', function (t) {
  const s = sandbox(t);
  const ws = s.makeWorkspaces();
  ws.load();
  const a = ws.add(s.makeDir('persist-a')).workspace;
  const b = ws.add(s.makeDir('persist-b')).workspace;
  const before = ws.list();
  ws.save();

  const file = path.join(s.dataDir, 'workspaces.json');
  assert.equal(fs.existsSync(file), true);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.workspaces.map(function (item) { return item.id; }), ['main', a.id, b.id]);
  assert.equal(parsed.workspaces[0].isDefault, true);
  assert.deepEqual(fs.readdirSync(s.dataDir), ['workspaces.json'], '不应残留临时文件');

  const reloaded = s.makeWorkspaces();
  const listed = reloaded.load();
  assert.deepEqual(listed.map(function (item) { return item.id; }), before.map(function (item) { return item.id; }));
  assert.deepEqual(listed, before, '持久化后重新 load 应完全一致');
  assert.equal(reloaded.get(a.id).path, a.path);
  assert.equal(reloaded.get(b.id).addedAt, b.addedAt);
});

test('数据目录不存在时 save 自动创建', function (t) {
  const s = sandbox(t);
  assert.equal(fs.existsSync(s.dataDir), false);
  const ws = s.makeWorkspaces();
  ws.save();
  assert.equal(fs.existsSync(path.join(s.dataDir, 'workspaces.json')), true);
  const parsed = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'workspaces.json'), 'utf8'));
  assert.equal(parsed.workspaces.length, 1);
  assert.equal(parsed.workspaces[0].id, 'main');
});

test('workspaces.json 损坏时降级为空并打日志', function (t) {
  const s = sandbox(t);
  mkdir(s.dataDir);
  fs.writeFileSync(path.join(s.dataDir, 'workspaces.json'), '{ this is not json');
  const logs = [];
  const ws = s.makeWorkspaces({ log: function (message) { logs.push(message); } });

  const listed = ws.load();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'main');
  assert.ok(logs.some(function (message) { return message.indexOf('workspaces.json') !== -1; }), '应记录读取失败日志');

  const added = ws.add(s.makeDir('after-corrupt'));
  assert.equal(added.ok, true);
  ws.save();
  const parsed = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'workspaces.json'), 'utf8'));
  assert.equal(parsed.workspaces.length, 2);
});

test('load 过滤无效 / 重复 / 超上限的持久化记录，并保留 main 的 addedAt', function (t) {
  const s = sandbox(t);
  mkdir(s.dataDir);
  const dir1 = s.makeDir('keep-one');
  const dir2 = s.makeDir('keep-two');
  const mainAddedAt = '2024-01-01T00:00:00.000Z';
  fs.writeFileSync(path.join(s.dataDir, 'workspaces.json'), JSON.stringify({
    version: 1,
    workspaces: [
      { id: 'main', name: 'old-name', path: '/tmp/whatever', isDefault: true, addedAt: mainAddedAt },
      { id: 'ws-keep-one', name: 'keep-one', path: dir1, isDefault: false, addedAt: '2024-02-01T00:00:00.000Z' },
      { id: 'ws-dup-path', name: 'dup', path: dir1, isDefault: false, addedAt: '2024-03-01T00:00:00.000Z' },
      { id: 'ws-broken' },
      'not-an-object',
      { id: '', name: 'keep-two', path: dir2, isDefault: false, addedAt: '2024-04-01T00:00:00.000Z' }
    ]
  }));
  const logs = [];
  const ws = s.makeWorkspaces({ log: function (message) { logs.push(message); } });
  const listed = ws.load();

  assert.equal(listed.length, 3);
  assert.equal(listed[0].id, 'main');
  assert.equal(listed[0].addedAt, mainAddedAt);
  assert.equal(listed[0].name, path.basename(s.defaultRoot), '默认工作区名称始终以 defaultRoot 为准');
  assert.equal(listed[0].path, s.defaultRoot);
  assert.deepEqual(listed.slice(1).map(function (item) { return item.id; }), ['ws-keep-one', 'ws-keep-two']);
  assert.equal(listed[1].path, real(dir1));
  assert.equal(listed[2].path, real(dir2));
  assert.ok(logs.some(function (message) { return message.indexOf('忽略') !== -1; }));
});

test('list 返回副本：外部修改不影响内部状态', function (t) {
  const s = sandbox(t);
  const ws = s.makeWorkspaces();
  const listed = ws.load();
  listed[0].name = 'hacked';
  listed.push({ id: 'ws-fake', name: 'fake', path: '/', isDefault: false, addedAt: new Date().toISOString() });
  assert.equal(ws.list().length, 1);
  assert.equal(ws.list()[0].name, path.basename(s.defaultRoot));
  assert.equal(ws.get('ws-fake'), null);
});
