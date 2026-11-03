import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFsBrowse } from '../server/fs-browse.js';

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

function errorCode(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
}

/** 临时沙箱：base 下有 default-root 与 data 等目录，测试结束整目录删除。 */
function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'project-scan-fs-'));
  const defaultRoot = mkdir(path.join(base, 'default-root'));
  t.after(function () {
    try { fs.chmodSync(base, 0o755); } catch (err) { /* ignore */ }
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (err) { /* ignore */ }
  });
  return {
    base: base,
    defaultRoot: defaultRoot,
    makeDir: function (name) { return mkdir(path.join(base, name)); },
    makeBrowse: function (extra) {
      return createFsBrowse(Object.assign({ defaultRoot: defaultRoot }, extra || {}));
    }
  };
}

test('只列目录、按名称排序、默认跳过隐藏目录和文件', function (t) {
  const s = sandbox(t);
  const root = s.makeDir('list-root');
  mkdir(path.join(root, 'zeta'));
  mkdir(path.join(root, 'alpha'));
  mkdir(path.join(root, 'beta'));
  mkdir(path.join(root, '.hidden-dir'));
  fs.writeFileSync(path.join(root, 'note.txt'), 'x');
  fs.writeFileSync(path.join(root, '.dotfile'), 'x');

  const browse = s.makeBrowse();
  const result = browse.list(root);

  assert.equal(result.path, path.resolve(root));
  assert.equal(result.realPath, real(root));
  assert.equal(result.parent, path.dirname(real(root)));
  assert.equal(result.isRoot, false);
  assert.equal(result.home, os.homedir());
  assert.deepEqual(result.entries.map(function (item) { return item.name; }), ['alpha', 'beta', 'zeta']);
  for (const entry of result.entries) {
    assert.equal(entry.path, path.join(real(root), entry.name));
    assert.equal(entry.hasProjectMarker, false);
  }
});

test('hidden 选项包含隐藏目录', function (t) {
  const s = sandbox(t);
  const root = s.makeDir('hidden-root');
  mkdir(path.join(root, '.cache-dir'));
  mkdir(path.join(root, 'public-dir'));
  const browse = s.makeBrowse();

  const hiddenOff = browse.list(root);
  assert.deepEqual(hiddenOff.entries.map(function (item) { return item.name; }), ['public-dir']);

  const hiddenOn = browse.list(root, { hidden: true });
  assert.deepEqual(hiddenOn.entries.map(function (item) { return item.name; }).sort(), ['.cache-dir', 'public-dir']);
  assert.equal(browse.list(root, { hidden: '1' }).entries.length, 2);
  assert.equal(browse.list(root, { hidden: false }).entries.length, 1);
});

test('isRoot 与 parent 反映默认工作区根', function (t) {
  const s = sandbox(t);
  const child = mkdir(path.join(s.defaultRoot, 'child-dir'));
  const browse = s.makeBrowse({ defaultRoot: s.defaultRoot });

  const rootList = browse.list(s.defaultRoot);
  assert.equal(rootList.isRoot, true);
  assert.equal(rootList.realPath, real(s.defaultRoot));
  assert.equal(rootList.parent, path.dirname(real(s.defaultRoot)));
  assert.deepEqual(rootList.entries.map(function (item) { return item.name; }), ['child-dir']);

  const childList = browse.list(child);
  assert.equal(childList.isRoot, false);
  assert.equal(childList.parent, real(s.defaultRoot));
  assert.deepEqual(childList.entries, []);
});

test('hasProjectMarker 识别 README.md/package.json/.git/index.html/project.godot/requirements.txt', function (t) {
  const s = sandbox(t);
  const root = s.makeDir('marker-root');
  const withJson = mkdir(path.join(root, 'a-package'));
  fs.writeFileSync(path.join(withJson, 'package.json'), '{}');
  const withReadme = mkdir(path.join(root, 'b-readme'));
  fs.writeFileSync(path.join(withReadme, 'README.md'), '# hi');
  const withGit = mkdir(path.join(root, 'c-git'));
  mkdir(path.join(withGit, '.git'));
  const withGodot = mkdir(path.join(root, 'd-godot'));
  fs.writeFileSync(path.join(withGodot, 'project.godot'), 'config_version=5');
  const withIndex = mkdir(path.join(root, 'e-static'));
  fs.writeFileSync(path.join(withIndex, 'index.html'), '<!doctype html>');
  const withReq = mkdir(path.join(root, 'f-python'));
  fs.writeFileSync(path.join(withReq, 'requirements.txt'), 'flask');
  mkdir(path.join(root, 'g-plain'));

  const browse = s.makeBrowse();
  const byName = new Map();
  for (const entry of browse.list(root).entries) byName.set(entry.name, entry.hasProjectMarker);

  assert.equal(byName.get('a-package'), true);
  assert.equal(byName.get('b-readme'), true);
  assert.equal(byName.get('c-git'), true);
  assert.equal(byName.get('d-godot'), true);
  assert.equal(byName.get('e-static'), true);
  assert.equal(byName.get('f-python'), true);
  assert.equal(byName.get('g-plain'), false);
});

test('条目上限 300 条，超出部分截断', function (t) {
  const s = sandbox(t);
  const root = s.makeDir('many-root');
  for (let i = 0; i < 320; i += 1) {
    const name = 'd' + String(i).padStart(3, '0');
    mkdir(path.join(root, name));
  }
  const browse = s.makeBrowse();
  const result = browse.list(root);
  assert.equal(result.entries.length, 300);
  assert.equal(result.entries[0].name, 'd000');
  assert.equal(result.entries[299].name, 'd299');
});

test('非法路径抛错：不存在 / 文件 / 空路径 / 非字符串 / 父级是文件', function (t) {
  const s = sandbox(t);
  const browse = s.makeBrowse();
  const filePath = path.join(s.base, 'plain.txt');
  fs.writeFileSync(filePath, 'x');

  assert.equal(errorCode(function () { browse.list(path.join(s.base, 'missing-dir')); }), 'INVALID_PATH');
  assert.equal(errorCode(function () { browse.list(filePath); }), 'NOT_DIRECTORY');
  assert.equal(errorCode(function () { browse.list(path.join(filePath, 'child-dir')); }), 'INVALID_PATH');
  assert.equal(errorCode(function () { browse.list(''); }), 'INVALID_PATH');
  assert.equal(errorCode(function () { browse.list('   '); }), 'INVALID_PATH');
  assert.equal(errorCode(function () { browse.list(null); }), 'INVALID_PATH');
  assert.equal(errorCode(function () { browse.list(42); }), 'INVALID_PATH');
});

test('支持 ~ 与相对路径（相对进程 cwd）', function (t) {
  const s = sandbox(t);
  const browse = s.makeBrowse();

  const homeList = browse.list('~');
  assert.equal(homeList.realPath, real(os.homedir()));
  assert.ok(Array.isArray(homeList.entries));

  const cwd = process.cwd();
  const relList = browse.list('.');
  assert.equal(relList.path, cwd);
  assert.equal(relList.realPath, real(cwd));
  assert.ok(Array.isArray(relList.entries));

  const unsupported = errorCode(function () { browse.list('~someuser/dir'); });
  assert.equal(unsupported, 'INVALID_PATH');
});

test('符号链接目录不出现在列表中（不跟随）', function (t) {
  const s = sandbox(t);
  const root = s.makeDir('symlink-root');
  mkdir(path.join(root, 'real-dir'));
  fs.symlinkSync(path.join(root, 'real-dir'), path.join(root, 'link-dir'), 'dir');

  const browse = s.makeBrowse();
  const names = browse.list(root).entries.map(function (item) { return item.name; });
  assert.deepEqual(names, ['real-dir']);
});

test('无权限目录抛 NOT_READABLE', function (t) {
  if (isRootUser()) {
    t.skip('以 root 运行时无法通过 chmod 模拟权限错误');
    return;
  }
  const s = sandbox(t);
  const root = s.makeDir('permission-root');
  const locked = mkdir(path.join(root, 'locked-dir'));
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
    const browse = s.makeBrowse();
    assert.equal(errorCode(function () { browse.list(locked); }), 'NOT_READABLE');
  } finally {
    fs.chmodSync(locked, originalMode);
  }
});

test('以符号链接路径浏览时 path 回显请求路径、realPath 为真实路径', function (t) {
  const s = sandbox(t);
  const root = s.makeDir('real-browse-root');
  mkdir(path.join(root, 'inner-dir'));
  const link = path.join(s.base, 'browse-link');
  fs.symlinkSync(root, link, 'dir');

  const browse = s.makeBrowse();
  const result = browse.list(link);
  assert.equal(result.path, path.resolve(link));
  assert.equal(result.realPath, real(root));
  assert.deepEqual(result.entries.map(function (item) { return item.name; }), ['inner-dir']);
  assert.equal(result.entries[0].path, path.join(real(root), 'inner-dir'));
});
