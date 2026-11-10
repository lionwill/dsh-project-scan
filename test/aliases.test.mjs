import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAliases, normalizeAlias, MAX_ALIAS_LENGTH } from '../server/aliases.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'project-scan-aliases-'));
}

test('aliases：normalizeAlias 去空白、折叠空格、去控制字符', function () {
  assert.equal(normalizeAlias('  项目  别名 '), '项目 别名');
  assert.equal(normalizeAlias('a\tb\nc'), 'a b c');
  assert.equal(normalizeAlias('  '), null);
  assert.equal(normalizeAlias(null), null);
  assert.equal(normalizeAlias(123), null);
  assert.equal(MAX_ALIAS_LENGTH, 48);
});

test('aliases：设置、读取、清除并原子持久化', function () {
  const dataDir = tmpDir();
  const aliases = createAliases({ dataDir: dataDir });
  assert.equal(aliases.load(), 0);
  assert.equal(aliases.get('alpha-tool'), null);

  const set = aliases.set('alpha-tool', '  我的  工具 ');
  assert.deepEqual(set, { alias: '我的 工具', changed: true });
  assert.equal(aliases.get('alpha-tool'), '我的 工具');
  assert.equal(aliases.count(), 1);
  aliases.save();

  const file = path.join(dataDir, 'aliases.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.aliases['alpha-tool'], '我的 工具');

  const reloaded = createAliases({ dataDir: dataDir });
  reloaded.load();
  assert.equal(reloaded.get('alpha-tool'), '我的 工具');

  const cleared = reloaded.set('alpha-tool', '   ');
  assert.deepEqual(cleared, { alias: null, changed: true });
  assert.equal(reloaded.get('alpha-tool'), null);
  reloaded.save();
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.aliases['alpha-tool'], undefined);
});

test('aliases：超长别称与非法 id 被拒绝', function () {
  const aliases = createAliases({ dataDir: tmpDir() });
  aliases.load();
  assert.equal(aliases.set('p', 'x'.repeat(MAX_ALIAS_LENGTH + 1)), null);
  assert.equal(aliases.get('p'), null);
  const exact = 'x'.repeat(MAX_ALIAS_LENGTH);
  assert.equal(aliases.set('p', exact).alias, exact);
  assert.deepEqual(aliases.set('', 'x'), { alias: null, changed: false });
});

test('aliases：文件损坏时降级为空并继续可用', function () {
  const dataDir = tmpDir();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'aliases.json'), '{ broken');
  const logs = [];
  const aliases = createAliases({ dataDir: dataDir, log: function (msg) { logs.push(msg); } });
  assert.equal(aliases.load(), 0);
  assert.equal(logs.length > 0, true);
  aliases.set('p', '别称');
  aliases.save();
  const reloaded = createAliases({ dataDir: dataDir });
  reloaded.load();
  assert.equal(reloaded.get('p'), '别称');
});
