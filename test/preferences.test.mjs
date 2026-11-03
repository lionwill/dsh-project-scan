import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPreferences } from '../server/preferences.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'project-scan-prefs-'));
}

test('preferences：默认空配置', function () {
  const dataDir = tmpDir();
  const prefs = createPreferences({ dataDir: dataDir });
  prefs.load();
  assert.deepEqual(prefs.hiddenIds(), []);
  assert.equal(prefs.hiddenCount(), 0);
  assert.equal(prefs.isHidden('a'), false);
});

test('preferences：隐藏/恢复幂等并持久化', function () {
  const dataDir = tmpDir();
  const prefs = createPreferences({ dataDir: dataDir });
  prefs.load();
  assert.equal(prefs.setHidden('project-a', true), true);
  assert.equal(prefs.setHidden('project-a', true), false);
  assert.equal(prefs.setHidden('project-b', true), true);
  assert.equal(prefs.isHidden('project-a'), true);
  assert.equal(prefs.hiddenCount(), 2);
  prefs.save();

  const reloaded = createPreferences({ dataDir: dataDir });
  reloaded.load();
  assert.deepEqual(reloaded.hiddenIds(), ['project-a', 'project-b']);
  assert.equal(reloaded.isHidden('project-b'), true);

  assert.equal(reloaded.setHidden('project-a', false), true);
  assert.equal(reloaded.isHidden('project-a'), false);
  assert.equal(reloaded.hiddenCount(), 1);
  reloaded.save();

  const third = createPreferences({ dataDir: dataDir });
  third.load();
  assert.deepEqual(third.hiddenIds(), ['project-b']);
});

test('preferences：损坏配置降级为空并打日志', function () {
  const dataDir = tmpDir();
  fs.writeFileSync(path.join(dataDir, 'hidden.json'), '{ not-json');
  const logs = [];
  const prefs = createPreferences({
    dataDir: dataDir,
    log: function (message) { logs.push(message); }
  });
  prefs.load();
  assert.deepEqual(prefs.hiddenIds(), []);
  assert.equal(prefs.hiddenCount(), 0);
  assert.ok(logs.length >= 1);

  // 结构不合法也降级
  fs.writeFileSync(path.join(dataDir, 'hidden.json'), JSON.stringify({ version: 1, hiddenIds: 'nope' }));
  const second = createPreferences({ dataDir: dataDir, log: function (message) { logs.push(message); } });
  second.load();
  assert.deepEqual(second.hiddenIds(), []);
});

test('preferences：忽略非法 id 并去重', function () {
  const dataDir = tmpDir();
  fs.writeFileSync(
    path.join(dataDir, 'hidden.json'),
    JSON.stringify({ version: 1, hiddenIds: ['a', 'a', '', '  ', 123, null, 'b'] })
  );
  const prefs = createPreferences({ dataDir: dataDir });
  prefs.load();
  assert.deepEqual(prefs.hiddenIds(), ['a', 'b']);
  assert.equal(prefs.setHidden('   ', true), false);
  assert.equal(prefs.hiddenCount(), 2);
});

test('preferences：save 创建目录并可用 stats 读取', function () {
  const dataDir = path.join(tmpDir(), 'nested', 'data');
  const prefs = createPreferences({ dataDir: dataDir });
  prefs.load();
  prefs.setHidden('x', true);
  prefs.save();
  assert.equal(fs.existsSync(path.join(dataDir, 'hidden.json')), true);
  const stats = prefs.stats();
  assert.equal(stats.hiddenCount, 1);
  assert.deepEqual(stats.hiddenIds, ['x']);
  assert.equal(stats.loaded, true);
});
test('preferences：运行时设置默认关闭、可持久化、非法字段被忽略', function () {
  const dataDir = tmpDir();
  const prefs = createPreferences({ dataDir: dataDir });
  prefs.load();
  assert.deepEqual(prefs.getSettings(), { monitorEnabled: false, llmSelection: null, autoUpdate: true });

  prefs.updateSettings({ monitorEnabled: true, unknownKey: 'x' });
  assert.deepEqual(prefs.getSettings(), { monitorEnabled: true, llmSelection: null, autoUpdate: true });
  prefs.saveSettings();

  const reloaded = createPreferences({ dataDir: dataDir });
  reloaded.load();
  assert.deepEqual(reloaded.getSettings(), { monitorEnabled: true, llmSelection: null, autoUpdate: true });

  reloaded.updateSettings({ monitorEnabled: 'yes' });
  assert.equal(reloaded.getSettings().monitorEnabled, true, '非 boolean 值应被忽略');

  fs.writeFileSync(path.join(dataDir, 'settings.json'), '{ broken');
  const broken = createPreferences({ dataDir: dataDir });
  broken.load();
  assert.deepEqual(broken.getSettings(), { monitorEnabled: false, llmSelection: null, autoUpdate: true }, '损坏设置降级为默认值');

  broken.updateSettings({ monitorEnabled: false });
  broken.save();
  assert.equal(fs.existsSync(path.join(dataDir, 'settings.json')), true);
  assert.equal(fs.existsSync(path.join(dataDir, 'hidden.json')), true);
});

test('preferences：AI 摘要渠道选择（只存 provider/model，不存 token；v1 兼容）', function () {
  const dataDir = tmpDir();
  const prefs = createPreferences({ dataDir: dataDir });
  prefs.load();
  assert.equal(prefs.getSettings().llmSelection, null);

  prefs.updateSettings({ llmSelection: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } });
  assert.deepEqual(prefs.getSettings().llmSelection, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' });
  prefs.saveSettings();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.equal(saved.version, 3);
  assert.deepEqual(saved.llmSelection, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' });
  assert.ok(!JSON.stringify(saved).toLowerCase().includes('key'), 'settings.json 不保存 token');

  const reloaded = createPreferences({ dataDir: dataDir });
  reloaded.load();
  assert.deepEqual(reloaded.getSettings().llmSelection, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' });

  reloaded.updateSettings({ llmSelection: { provider: '', model: 'x' } });
  assert.equal(reloaded.getSettings().llmSelection.provider, 'opencode-go', '非法选择应被忽略');
  reloaded.updateSettings({ llmSelection: null });
  assert.equal(reloaded.getSettings().llmSelection, null);

  // v1 设置文件兼容
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, monitorEnabled: true }));
  const legacy = createPreferences({ dataDir: dataDir });
  legacy.load();
  assert.equal(legacy.getSettings().monitorEnabled, true);
  assert.equal(legacy.getSettings().llmSelection, null);
});

test('preferences：自动更新开关（默认开启、可关闭、持久化）', function () {
  const dataDir = tmpDir();
  const prefs = createPreferences({ dataDir: dataDir });
  prefs.load();
  assert.equal(prefs.getSettings().autoUpdate, true);

  prefs.updateSettings({ autoUpdate: false });
  prefs.saveSettings();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.equal(saved.version, 3);
  assert.equal(saved.autoUpdate, false);

  const reloaded = createPreferences({ dataDir: dataDir });
  reloaded.load();
  assert.equal(reloaded.getSettings().autoUpdate, false);
  reloaded.updateSettings({ autoUpdate: 'yes' });
  assert.equal(reloaded.getSettings().autoUpdate, false, '非 boolean 值应被忽略');
});
