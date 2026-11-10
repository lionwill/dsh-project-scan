import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const PORT = 18991;
const BASE = 'http://127.0.0.1:' + PORT;

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeWorkspace() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-scan-e2e-'));

  // alpha：Node 项目 + README，更新时间较旧
  const alpha = path.join(tmp, 'alpha-tool');
  write(path.join(alpha, 'README.md'), '# 阿尔法工具\n\n这是一个用于端到端测试的 Node 项目，提供数据整理能力。\n');
  write(path.join(alpha, 'package.json'), JSON.stringify({ name: 'alpha-tool', scripts: { dev: 'node server.js' } }, null, 2));
  write(path.join(alpha, 'server.js'), 'console.log("alpha");\n');
  write(path.join(alpha, 'node_modules', 'ignored.js'), 'x');
  const old = new Date('2026-01-02T03:04:05.000Z');
  fs.utimesSync(path.join(alpha, 'README.md'), old, old);
  fs.utimesSync(path.join(alpha, 'package.json'), old, old);
  fs.utimesSync(path.join(alpha, 'server.js'), old, old);

  // beta：静态页面项目，更新时间较新
  const beta = path.join(tmp, 'beta-site');
  write(path.join(beta, 'README.md'), '# 贝塔站点\n\n一个纯静态的展示页面，用于验证静态预览。\n');
  write(path.join(beta, 'index.html'), '<!doctype html><html><body>BETA PREVIEW</body></html>');
  const fresh = new Date('2026-06-07T08:09:10.000Z');
  fs.utimesSync(path.join(beta, 'README.md'), fresh, fresh);
  fs.utimesSync(path.join(beta, 'index.html'), fresh, fresh);

  // delta：只有 README，没有运行入口
  const delta = path.join(tmp, 'delta-docs');
  write(path.join(delta, 'README.md'), '# 德尔塔文档\n\n只有说明文档，没有任何可运行入口。\n');
  const deltaTime = new Date('2026-03-04T05:06:07.000Z');
  fs.utimesSync(path.join(delta, 'README.md'), deltaTime, deltaTime);

  // parent-app：包含一个可独立运行的子项目（模拟 toolkit-app/toolkit_fetcher）
  const parent = path.join(tmp, 'parent-app');
  write(path.join(parent, 'README.md'), '# 父项目\n\n一个包含可独立运行子项目的父项目。\n');
  write(path.join(parent, 'child-app', 'README.md'), '# 子项目\n\n一个可以单独启动的子项目，用于验证下钻。\n');
  write(path.join(parent, 'child-app', 'package.json'), JSON.stringify({ name: 'child-app', scripts: { dev: 'node server.js' } }, null, 2));
  write(path.join(parent, 'child-app', 'server.js'), 'console.log("child");\n');
  const parentTime = new Date('2026-02-03T04:05:06.000Z');
  ['README.md', 'child-app/README.md', 'child-app/package.json', 'child-app/server.js'].forEach(function (rel) {
    const target = path.join(parent, rel);
    fs.utimesSync(target, parentTime, parentTime);
  });

  // gamma：空目录，不应被收录
  fs.mkdirSync(path.join(tmp, 'gamma-empty'), { recursive: true });

  return tmp;
}

/** 额外工作区：gamma-app（含子项目 sub-app）与 omega-static 两个项目。 */
function makeExtraWorkspace() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-scan-extra-'));
  const gamma = path.join(tmp, 'gamma-app');
  write(path.join(gamma, 'README.md'), '# 伽马应用\n\n额外工作区里的 Node 项目，用于验证跨工作区扫描。\n');
  write(path.join(gamma, 'package.json'), JSON.stringify({ name: 'gamma-app', scripts: { dev: 'node server.js' } }, null, 2));
  write(path.join(gamma, 'server.js'), 'console.log("gamma");\n');
  write(path.join(gamma, 'sub-app', 'README.md'), '# 子应用\n\n额外工作区项目的子项目。\n');
  write(path.join(gamma, 'sub-app', 'package.json'), JSON.stringify({ name: 'sub-app', scripts: { start: 'node s.js' } }, null, 2));
  write(path.join(gamma, 'sub-app', 's.js'), 'console.log("sub");\n');

  const omega = path.join(tmp, 'omega-static');
  write(path.join(omega, 'README.md'), '# 欧米伽静态站\n\n额外工作区里的静态页面。\n');
  write(path.join(omega, 'index.html'), '<!doctype html><html><body>OMEGA</body></html>');

  const stamp = new Date('2026-05-06T07:08:09.000Z');
  ['gamma-app/README.md', 'gamma-app/package.json', 'gamma-app/server.js', 'gamma-app/sub-app/README.md', 'gamma-app/sub-app/package.json', 'gamma-app/sub-app/s.js', 'omega-static/README.md', 'omega-static/index.html'].forEach(function (rel) {
    fs.utimesSync(path.join(tmp, rel), stamp, stamp);
  });
  return tmp;
}

async function waitForProjects(predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  let last = null;
  while (Date.now() < deadline) {
    const res = await fetch(BASE + '/api/projects');
    if (res.ok) {
      last = await res.json();
      if (predicate(last)) return last;
    }
    await new Promise(function (resolve) { setTimeout(resolve, 150); });
  }
  throw new Error('等待项目列表超时：' + JSON.stringify(last && last.meta && last.meta.workspaces));
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return await res.json();
    } catch (err) {
      // 还没起来
    }
    await new Promise(function (resolve) { setTimeout(resolve, 120); });
  }
  throw new Error('服务在 ' + timeoutMs + 'ms 内没有启动');
}

async function readSSEFirstEvent(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  try {
    const res = await fetch(BASE + '/api/events', { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const reader = res.body.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value || new Uint8Array());
    controller.abort();
    return text;
  } finally {
    clearTimeout(timer);
  }
}

test('项目雷达 HTTP API 端到端', async function (t) {
  const workspace = makeWorkspace();
  const extraWorkspace = makeExtraWorkspace();
  const child = spawn(process.execPath, [path.join(APP_DIR, 'server', 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      PROJECT_SCAN_ROOT: workspace,
      PROJECT_SCAN_DATA_DIR: path.join(workspace, '.data'),
      PROJECT_SCAN_LLM: 'off',
      PROJECT_SCAN_ALLOW_SCANNER_STOP: 'off',
      PROJECT_SCAN_AUTO_UPDATE: 'off'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', function (chunk) { output += chunk.toString(); });
  child.stderr.on('data', function (chunk) { output += chunk.toString(); });

  t.after(async function () {
    try { child.kill('SIGTERM'); } catch (err) {}
    await new Promise(function (resolve) { setTimeout(resolve, 600); });
    try { child.kill('SIGKILL'); } catch (err) {}
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(extraWorkspace, { recursive: true, force: true });
  });

  const health = await waitForHealth(20000);
  assert.equal(health.ok, true);
  assert.equal(health.root, workspace);

  await t.test('GET /api/projects 返回按更新时间倒序的项目', async function () {
    const res = await fetch(BASE + '/api/projects');
    assert.equal(res.status, 200);
    const body = await res.json();
    const ids = body.projects.map(function (p) { return p.id; });
    assert.ok(ids.includes('alpha-tool'), '应包含 alpha-tool，实际：' + ids.join(','));
    assert.ok(ids.includes('beta-site'), '应包含 beta-site，实际：' + ids.join(','));
    assert.ok(!ids.includes('gamma-empty'), '空目录不应被收录');
    assert.ok(ids.includes('delta-docs'), '只有 README 的目录也算项目');
    assert.ok(ids.includes('parent-app'), '包含子项目的父项目应被收录');
    assert.equal(body.projects[0].id, 'beta-site', '最新的项目应排第一');

    const parentProject = body.projects.find(function (p) { return p.id === 'parent-app'; });
    assert.ok(Array.isArray(parentProject.children), '顶层项目应带 children 数组');
    assert.equal(parentProject.children.length, 1, 'parent-app 应有 1 个子项目');
    const child = parentProject.children[0];
    assert.equal(child.id, 'parent-app--child-app');
    assert.equal(child.parentId, 'parent-app');
    assert.equal(child.relPath, 'child-app');
    assert.equal(child.depth, 1);
    assert.deepEqual(child.children, []);
    assert.equal(child.runInfo.runnable, true, '子项目应可运行');
    assert.match(child.runInfo.runHint, /npm run dev/);
    assert.match(child.summary, /子项目/);
    assert.equal(parentProject.runInfo.runnable, false, '父项目自身不可运行');
    assert.equal(body.meta.subprojectCount, 1);
    assert.equal(body.meta.llm.enabled, false, '测试环境应关闭 LLM');
    const alpha = body.projects.find(function (p) { return p.id === 'alpha-tool'; });
    assert.equal(alpha.name, '阿尔法工具');
    assert.match(alpha.summary, /端到端测试/);
    assert.equal(alpha.readmePath, 'README.md');
    assert.ok(alpha.fileCount >= 3);
    assert.ok(alpha.runnable === true);
    assert.equal(alpha.runKind, 'command');
    assert.match(alpha.runHint, /npm run dev/);
    assert.ok(Array.isArray(alpha.tags));
    assert.equal(typeof alpha.updatedAt, 'string');
    assert.ok(body.meta.scannedAt);
    assert.equal(body.meta.scheduler.windowStartHour, 9);
    assert.equal(body.meta.scheduler.windowEndHour, 20);
    assert.equal(body.meta.scheduler.intervalMinutes, 20);
    assert.ok(body.meta.scheduler.nextRunAt);
    assert.ok(body.meta.scheduler.lastResult);
  });

  await t.test('磁盘占用：扫描后异步计算文件夹总计大小', async function () {
    const listing = await waitForProjects(function (data) {
      const alpha = data.projects.find(function (p) { return p.id === 'alpha-tool'; });
      return Boolean(alpha && typeof alpha.diskUsageBytes === 'number' && alpha.diskUsageBytes > 0);
    }, 15000);
    const alpha = listing.projects.find(function (p) { return p.id === 'alpha-tool'; });
    assert.ok(alpha.diskUsageBytes > 100, '磁盘占用应大于 0');
    assert.ok(typeof alpha.diskUsageAt === 'string');
    assert.equal(alpha.diskUsageError, null);

    const parent = listing.projects.find(function (p) { return p.id === 'parent-app'; });
    assert.ok(parent.children.length > 0);
    assert.ok(typeof parent.children[0].diskUsageBytes === 'number', '子项目也应计算磁盘占用');
  });

  await t.test('项目别称 API：设置 / 原名 / 清除 / 校验 / 持久化', async function () {
    const listBefore = await (await fetch(BASE + '/api/projects')).json();
    const alpha = listBefore.projects.find(function (p) { return p.id === 'alpha-tool'; });
    assert.ok(alpha);
    assert.equal(alpha.alias, null);
    assert.equal(alpha.originalName, null);

    const setRes = await fetch(BASE + '/api/projects/alpha-tool/alias', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias: '  阿尔法  别名 ' })
    });
    assert.equal(setRes.status, 200);
    const setBody = await setRes.json();
    assert.equal(setBody.alias, '阿尔法 别名');
    assert.equal(setBody.project.name, '阿尔法 别名');
    assert.equal(setBody.project.alias, '阿尔法 别名');
    assert.equal(setBody.project.originalName, '阿尔法工具');

    const detail = await (await fetch(BASE + '/api/projects/alpha-tool')).json();
    assert.equal(detail.project.name, '阿尔法 别名');
    assert.equal(detail.project.originalName, '阿尔法工具');

    const listAfter = await (await fetch(BASE + '/api/projects')).json();
    const alphaAfter = listAfter.projects.find(function (p) { return p.id === 'alpha-tool'; });
    assert.equal(alphaAfter.name, '阿尔法 别名');
    assert.equal(alphaAfter.alias, '阿尔法 别名');

    const aliasFile = path.join(workspace, '.data', 'aliases.json');
    const saved = JSON.parse(fs.readFileSync(aliasFile, 'utf8'));
    assert.equal(saved.aliases['alpha-tool'], '阿尔法 别名');

    // 子项目 id 也支持
    const childRes = await fetch(BASE + '/api/projects/parent-app--child-app/alias', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias: '子项目别名' })
    });
    assert.equal(childRes.status, 200);
    const childBody = await childRes.json();
    assert.equal(childBody.project.name, '子项目别名');
    assert.equal(childBody.project.originalName, '子项目');

    const tooLong = await fetch(BASE + '/api/projects/alpha-tool/alias', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias: 'x'.repeat(49) })
    });
    assert.equal(tooLong.status, 400);
    assert.equal((await tooLong.json()).error.code, 'ALIAS_TOO_LONG');

    const invalid = await fetch(BASE + '/api/projects/alpha-tool/alias', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias: 123 })
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'INVALID_BODY');

    const missing = await fetch(BASE + '/api/projects/no-such-project/alias', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias: 'x' })
    });
    assert.equal(missing.status, 404);

    // 清除别名：恢复原名、originalName 归 null
    const clearRes = await fetch(BASE + '/api/projects/alpha-tool/alias', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias: '' })
    });
    assert.equal(clearRes.status, 200);
    const clearBody = await clearRes.json();
    assert.equal(clearBody.alias, null);
    assert.equal(clearBody.project.name, '阿尔法工具');
    assert.equal(clearBody.project.alias, null);
    assert.equal(clearBody.project.originalName, null);

    // 清理子项目别名，避免影响后续用例
    await fetch(BASE + '/api/projects/parent-app--child-app/alias', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias: null })
    });
  });

  await t.test('运行时设置与监控 API（默认关闭）', async function () {
    const settingsRes = await fetch(BASE + '/api/settings');
    assert.equal(settingsRes.status, 200);
    const settings = await settingsRes.json();
    assert.equal(settings.monitorEnabled, false);
    assert.equal(settings.intervalMs, 1000);
    assert.equal(settings.autoUpdate, true, '自动更新默认开启');

    const autoOff = await fetch(BASE + '/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoUpdate: false })
    });
    assert.equal(autoOff.status, 200);
    const autoOffBody = await autoOff.json();
    assert.equal(autoOffBody.settings.autoUpdate, false);
    // 恢复默认，避免影响后续用例
    await fetch(BASE + '/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoUpdate: true })
    });

    const updateStatus = await fetch(BASE + '/api/update/status');
    assert.equal(updateStatus.status, 200);
    const update = await updateStatus.json();
    assert.equal(typeof update.enabled, 'boolean');
    assert.equal(update.checking, false);
    assert.equal(update.lastResult, null);

    const updateCheck = await fetch(BASE + '/api/update/check', { method: 'POST' });
    assert.equal(updateCheck.status, 200);
    const updateCheckBody = await updateCheck.json();
    assert.equal(updateCheckBody.started, false, '测试环境部署级关闭自动更新');
    assert.match(updateCheckBody.message, /PROJECT_SCAN_AUTO_UPDATE=off/);

    const offBody = await (await fetch(BASE + '/api/monitor')).json();
    assert.equal(offBody.enabled, false);
    assert.deepEqual(offBody.projects, []);
    assert.equal(typeof offBody.overhead.ticks, 'number');

    const onRes = await fetch(BASE + '/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monitorEnabled: true })
    });
    assert.equal(onRes.status, 200);
    const onBody = await onRes.json();
    assert.equal(onBody.settings.monitorEnabled, true);
    assert.ok(onBody.monitor);

    const onSnapshot = await (await fetch(BASE + '/api/monitor')).json();
    assert.equal(onSnapshot.enabled, true);
    assert.equal(typeof onSnapshot.sampling, 'boolean');
    assert.deepEqual(onSnapshot.projects, [], '没有运行中项目时不应有项目指标');

    const invalid = await fetch(BASE + '/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monitorEnabled: 'yes' })
    });
    assert.equal(invalid.status, 400);
    const invalidBody = await invalid.json();
    assert.equal(invalidBody.error.code, 'INVALID_BODY');

    const resetRes = await fetch(BASE + '/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monitorEnabled: false })
    });
    assert.equal(resetRes.status, 200);
    const afterReset = await (await fetch(BASE + '/api/settings')).json();
    assert.equal(afterReset.monitorEnabled, false);
  });

  await t.test('GET /api/workspaces 默认只有主工作区', async function () {
    const res = await fetch(BASE + '/api/workspaces');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.current, 'main');
    assert.equal(body.limit, 10);
    assert.equal(body.workspaces.length, 1);
    assert.equal(body.workspaces[0].id, 'main');
    assert.equal(body.workspaces[0].isDefault, true);
    assert.equal(body.workspaces[0].projectCount, 4);
    assert.ok(body.home);
  });

  await t.test('POST /api/workspaces 添加额外工作区并触发跨工作区扫描', async function () {
    const res = await fetch(BASE + '/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: extraWorkspace })
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.scanStarted, true);
    assert.match(body.workspace.id, /^ws-/);
    assert.equal(body.workspace.isDefault, false);

    const wsId = body.workspace.id;
    const listing = await waitForProjects(function (data) {
      return data.projects.some(function (p) { return p.workspaceId === wsId; });
    });
    assert.equal(listing.meta.workspaces.length, 2);
    const mainWs = listing.meta.workspaces.find(function (w) { return w.id === 'main'; });
    const extraWs = listing.meta.workspaces.find(function (w) { return w.id === wsId; });
    assert.equal(extraWs.projectCount, 2);
    assert.equal(mainWs.projectCount, 4);

    const gamma = listing.projects.find(function (p) { return p.id === wsId + '--gamma-app'; });
    assert.ok(gamma, '额外工作区项目 id 应带工作区前缀，实际：' + listing.projects.map(function (p) { return p.id; }).join(','));
    assert.equal(gamma.workspaceId, wsId);
    assert.equal(gamma.workspaceName, path.basename(extraWorkspace));
    assert.equal(gamma.workspacePath, fs.realpathSync(extraWorkspace));
    assert.equal(gamma.children.length, 1);
    assert.equal(gamma.children[0].id, wsId + '--gamma-app--sub-app');
    assert.equal(gamma.children[0].parentId, gamma.id);
    assert.equal(gamma.children[0].workspaceId, wsId);

    const detail = await fetch(BASE + '/api/projects/' + encodeURIComponent(gamma.id));
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.equal(detailBody.project.workspaceName, path.basename(extraWorkspace));

    // 重复添加
    const duplicate = await fetch(BASE + '/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: extraWorkspace })
    });
    assert.equal(duplicate.status, 409);
    const duplicateBody = await duplicate.json();
    assert.equal(duplicateBody.error.code, 'WORKSPACE_EXISTS');

    // 无效路径
    const invalid = await fetch(BASE + '/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: path.join(extraWorkspace, 'does-not-exist') })
    });
    assert.equal(invalid.status, 400);
  });

  await t.test('GET /api/fs/dirs 浏览目录', async function () {
    const res = await fetch(BASE + '/api/fs/dirs?path=' + encodeURIComponent(extraWorkspace));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.path, extraWorkspace);
    assert.equal(body.realPath, fs.realpathSync(extraWorkspace));
    assert.equal(body.parent, path.dirname(fs.realpathSync(extraWorkspace)));
    const names = body.entries.map(function (entry) { return entry.name; });
    assert.ok(names.includes('gamma-app'));
    assert.ok(names.includes('omega-static'));
    const gammaEntry = body.entries.find(function (entry) { return entry.name === 'gamma-app'; });
    assert.equal(gammaEntry.hasProjectMarker, true);

    const fileRes = await fetch(BASE + '/api/fs/dirs?path=' + encodeURIComponent(path.join(extraWorkspace, 'gamma-app', 'README.md')));
    assert.equal(fileRes.status, 400);
    const missingRes = await fetch(BASE + '/api/fs/dirs?path=' + encodeURIComponent(path.join(extraWorkspace, 'nope')));
    assert.equal(missingRes.status, 400);
  });

  await t.test('DELETE /api/workspaces 移除工作区与项目，默认工作区不可删', async function () {
    const defaultDelete = await fetch(BASE + '/api/workspaces/main', { method: 'DELETE' });
    assert.equal(defaultDelete.status, 400);
    const defaultBody = await defaultDelete.json();
    assert.equal(defaultBody.error.code, 'DEFAULT_WORKSPACE');

    const missingDelete = await fetch(BASE + '/api/workspaces/ws-does-not-exist', { method: 'DELETE' });
    assert.equal(missingDelete.status, 404);
    const missingBody = await missingDelete.json();
    assert.equal(missingBody.error.code, 'WORKSPACE_NOT_FOUND');

    const wsRes = await fetch(BASE + '/api/workspaces');
    const wsBody = await wsRes.json();
    const extra = wsBody.workspaces.find(function (w) { return !w.isDefault; });
    assert.ok(extra);
    const removed = await fetch(BASE + '/api/workspaces/' + encodeURIComponent(extra.id), { method: 'DELETE' });
    assert.equal(removed.status, 200);
    const removedBody = await removed.json();
    assert.equal(removedBody.removed, true);
    assert.equal(removedBody.removedProjects, 2);

    const listing = await waitForProjects(function (data) {
      return data.meta.workspaces.length === 1 && !data.projects.some(function (p) { return p.workspaceId === extra.id; });
    });
    assert.equal(listing.meta.workspaces.length, 1);
    assert.equal(listing.projects.length, 4);
  });

  await t.test('隐藏项目：隐藏/恢复、hidden 字段与 meta.hiddenCount', async function () {
    async function postHidden(id, hidden) {
      return fetch(BASE + '/api/projects/' + encodeURIComponent(id) + '/hidden', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hidden: hidden })
      });
    }

    const hideBeta = await postHidden('beta-site', true);
    assert.equal(hideBeta.status, 200);
    const hideBetaBody = await hideBeta.json();
    assert.equal(hideBetaBody.project.hidden, true);
    assert.equal(hideBetaBody.hiddenCount, 1);

    let listing = await (await fetch(BASE + '/api/projects')).json();
    assert.equal(listing.meta.hiddenCount, 1);
    assert.equal(listing.projects.find(function (p) { return p.id === 'beta-site'; }).hidden, true);
    assert.equal(listing.projects.filter(function (p) { return p.hidden; }).length, 1);
    assert.equal(listing.projects.find(function (p) { return p.id === 'alpha-tool'; }).hidden, false);

    // 子项目 id 等价作用于父项目
    const hideChild = await postHidden('parent-app--child-app', true);
    assert.equal(hideChild.status, 200);
    assert.equal((await hideChild.json()).hiddenCount, 2);
    listing = await (await fetch(BASE + '/api/projects')).json();
    const parent = listing.projects.find(function (p) { return p.id === 'parent-app'; });
    assert.equal(parent.hidden, true);
    assert.equal(parent.children[0].hidden, true);

    // 详情也带 hidden
    const detail = await (await fetch(BASE + '/api/projects/beta-site')).json();
    assert.equal(detail.project.hidden, true);

    // 恢复
    const unhideBeta = await postHidden('beta-site', false);
    assert.equal(unhideBeta.status, 200);
    assert.equal((await unhideBeta.json()).hiddenCount, 1);
    const unhideParent = await postHidden('parent-app', false);
    assert.equal((await unhideParent.json()).hiddenCount, 0);

    listing = await (await fetch(BASE + '/api/projects')).json();
    assert.equal(listing.meta.hiddenCount, 0);
    assert.equal(listing.projects.filter(function (p) { return p.hidden; }).length, 0);

    // 非法 body / 未知项目
    const invalid = await fetch(BASE + '/api/projects/beta-site/hidden', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hidden: 'yes' })
    });
    assert.equal(invalid.status, 400);
    const invalidBody = await invalid.json();
    assert.equal(invalidBody.error.code, 'INVALID_BODY');

    const missing = await postHidden('not-a-project', true);
    assert.equal(missing.status, 404);
    const missingBody = await missing.json();
    assert.equal(missingBody.error.code, 'PROJECT_NOT_FOUND');
  });

  await t.test('GET /api/projects/:id 支持子项目 id', async function () {
    const res = await fetch(BASE + '/api/projects/parent-app--child-app');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.project.id, 'parent-app--child-app');
    assert.equal(body.project.parentId, 'parent-app');
    assert.match(body.readmeExcerpt, /子项目/);
    assert.equal(body.project.runInfo.runnable, true);
  });

  await t.test('GET /api/projects/:id 返回详情与 README 摘录', async function () {
    const res = await fetch(BASE + '/api/projects/alpha-tool');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.project.id, 'alpha-tool');
    assert.match(body.readmeExcerpt, /阿尔法工具/);
    const missing = await fetch(BASE + '/api/projects/not-exist');
    assert.equal(missing.status, 404);
    const err = await missing.json();
    assert.equal(err.error.code, 'PROJECT_NOT_FOUND');
  });

  await t.test('静态资源与品牌 404', async function () {
    const home = await fetch(BASE + '/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type') || '', /text\/html/);
    const missing = await fetch(BASE + '/definitely-not-here.html');
    assert.equal(missing.status, 404);
  });

  await t.test('静态项目：运行 -> 预览 -> 停止', async function () {
    const runRes = await fetch(BASE + '/api/projects/beta-site/run', { method: 'POST' });
    assert.equal(runRes.status, 200);
    const runBody = await runRes.json();
    assert.equal(runBody.run.status, 'running');
    assert.equal(runBody.run.url, '/preview/beta-site/');
    assert.equal(runBody.run.projectId, 'beta-site');

    const preview = await fetch(BASE + '/preview/beta-site/');
    assert.equal(preview.status, 200);
    assert.match(await preview.text(), /BETA PREVIEW/);

    const traversal = await fetch(BASE + '/preview/beta-site/..%2f..%2fetc%2fpasswd');
    assert.ok(traversal.status === 403 || traversal.status === 404, '路径穿越必须被拦截');

    const duplicate = await fetch(BASE + '/api/projects/beta-site/run', { method: 'POST' });
    assert.equal(duplicate.status, 409);
    const duplicateBody = await duplicate.json();
    assert.equal(duplicateBody.error.code, 'ALREADY_RUNNING');

    const logsRes = await fetch(BASE + '/api/runs/' + encodeURIComponent(runBody.run.runId));
    assert.equal(logsRes.status, 200);
    const logsBody = await logsRes.json();
    assert.ok(Array.isArray(logsBody.logs));

    const stopRes = await fetch(BASE + '/api/projects/beta-site/stop', { method: 'POST' });
    assert.equal(stopRes.status, 200);
    const stopBody = await stopRes.json();
    assert.equal(stopBody.run.status, 'exited');
  });

  await t.test('运行中管理：列表 / 重启 / 全部停止（不包含扫描器）', async function () {
    let running = await (await fetch(BASE + '/api/running')).json();
    assert.equal(running.count, 1, '扫描器自身也应在运行中列表里');
    assert.equal(running.projects.length, 1);
    const scannerEntry = running.projects[0];
    assert.equal(scannerEntry.isScannerProject, true);
    assert.equal(scannerEntry.projectId, null);
    assert.match(scannerEntry.name, /扫描器/);
    assert.equal(scannerEntry.status, 'running');
    assert.match(scannerEntry.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.ok(running.scanner.pid > 0);
    assert.equal(typeof running.scanner.uptimeSec, 'number');

    const runRes = await fetch(BASE + '/api/projects/beta-site/run', { method: 'POST' });
    assert.equal(runRes.status, 200);
    running = await (await fetch(BASE + '/api/running')).json();
    assert.equal(running.count, 2);
    assert.equal(running.projects[0].isScannerProject, true);
    const entry = running.projects.find(function (item) { return item.projectId === 'beta-site'; });
    assert.ok(entry);
    assert.equal(entry.status, 'running');
    assert.equal(entry.url, '/preview/beta-site/');
    assert.equal(entry.isScannerProject, false);
    assert.ok(entry.uptimeSec >= 0);
    assert.equal(entry.workspaceId, 'main');

    const restart = await fetch(BASE + '/api/projects/beta-site/restart', { method: 'POST' });
    assert.equal(restart.status, 200);
    const restartBody = await restart.json();
    assert.equal(restartBody.run.status, 'running');
    assert.equal(restartBody.run.url, '/preview/beta-site/');
    running = await (await fetch(BASE + '/api/running')).json();
    assert.equal(running.count, 2);

    const notRunning = await fetch(BASE + '/api/projects/alpha-tool/restart', { method: 'POST' });
    assert.equal(notRunning.status, 409);
    const notRunningBody = await notRunning.json();
    assert.equal(notRunningBody.error.code, 'NOT_RUNNING');

    const notRunnable = await fetch(BASE + '/api/projects/delta-docs/restart', { method: 'POST' });
    assert.equal(notRunnable.status, 422);

    const stopAll = await fetch(BASE + '/api/running/stop-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ includeScanner: false })
    });
    assert.equal(stopAll.status, 200);
    const stopBody = await stopAll.json();
    assert.deepEqual(stopBody.stopped, ['beta-site']);
    assert.deepEqual(stopBody.failed, []);
    assert.equal(stopBody.includeScanner, false);
    assert.equal(stopBody.scannerStopped, false);
    running = await (await fetch(BASE + '/api/running')).json();
    assert.equal(running.count, 1, '停止全部项目后只剩扫描器自身');
    assert.equal(running.projects[0].isScannerProject, true);
    assert.equal((await fetch(BASE + '/api/health')).status, 200);

    // 环境变量禁止关停扫描器时，includeScanner=true 也不会退出
    const guarded = await fetch(BASE + '/api/running/stop-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ includeScanner: true })
    });
    assert.equal(guarded.status, 200);
    const guardedBody = await guarded.json();
    assert.equal(guardedBody.scannerStopped, false);
    assert.equal((await fetch(BASE + '/api/health')).status, 200);
  });

  await t.test('不可运行项目返回 422', async function () {
    const res = await fetch(BASE + '/api/projects/delta-docs/run', { method: 'POST' });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_RUNNABLE');
    assert.ok(body.error.message.length > 0);
  });

  await t.test('POST /api/scan 手动触发扫描', async function () {
    const res = await fetch(BASE + '/api/scan', { method: 'POST' });
    assert.ok([202, 409].includes(res.status));
    const body = await res.json();
    if (res.status === 202) assert.equal(body.started, true);
  });

  await t.test('GET /api/events 推送 hello 事件', async function () {
    const text = await readSSEFirstEvent(5000);
    assert.match(text, /event: hello/);
    assert.match(text, /"count":4/);
  });

  await t.test('进程输出包含启动日志', async function () {
    assert.match(output, /\[project-scan\] 已启动/);
  });
});
function sleepMs(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

test('stop-all 包含扫描器：独立服务会被优雅关闭', async function () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-scan-scanner-stop-'));
  const PORT2 = 18992;
  const BASE2 = 'http://127.0.0.1:' + PORT2;
  const child = spawn(process.execPath, [path.join(APP_DIR, 'server', 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT2),
      PROJECT_SCAN_ROOT: tmp,
      PROJECT_SCAN_DATA_DIR: path.join(tmp, '.data'),
      PROJECT_SCAN_LLM: 'off',
      PROJECT_SCAN_ALLOW_SCANNER_STOP: 'on',
      PROJECT_SCAN_AUTO_UPDATE: 'off'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', function (chunk) { output += chunk.toString(); });
  child.stderr.on('data', function (chunk) { output += chunk.toString(); });
  const exited = new Promise(function (resolve) {
    child.on('exit', function (code, signal) { resolve({ code: code, signal: signal }); });
  });
  try {
    const deadline = Date.now() + 15000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(BASE2 + '/api/health');
        if (res.ok) { healthy = true; break; }
      } catch (err) { /* 等待启动 */ }
      await sleepMs(150);
    }
    assert.ok(healthy, '独立服务应启动成功：' + output.slice(-300));

    const res = await fetch(BASE2 + '/api/running/stop-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ includeScanner: true })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.scannerStopped, true);
    assert.deepEqual(body.stopped, [], '扫描器自身不计入项目 stopped 列表');

    const result = await Promise.race([
      exited,
      sleepMs(10000).then(function () { return { timeout: true }; })
    ]);
    assert.ok(!result.timeout, '扫描器应退出');
    assert.equal(result.code, 0);
  } finally {
    try { child.kill('SIGKILL'); } catch (err) { /* ignore */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/** 设置里的 AI 摘要渠道选择：独立服务 + 临时 DSH home（不访问网络）。 */
test('AI 摘要渠道选择 API（DSH 渠道 + 模型下拉）', async function () {
  const PORT5 = 18994;
  const BASE5 = 'http://127.0.0.1:' + PORT5;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'project-scan-llm-sel-ws-'));
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'project-scan-llm-sel-dsh-'));

  write(path.join(workspace, 'demo-app', 'README.md'), '# 演示应用\n\n用于渠道选择 API 测试的示例项目。\n');
  write(path.join(workspace, 'demo-app', 'package.json'), JSON.stringify({ name: 'demo-app', scripts: { dev: 'node index.js' } }, null, 2));
  write(path.join(workspace, 'demo-app', 'index.js'), 'console.log("demo");\n');

  write(path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      opencode-go:',
    '        displayName: OpenCode Go',
    '        apiKeyEnv: OPENCODE_GO_API_KEY',
    '        modelOverrides:',
    '          deepseek-v4.1-flash:',
    '            name: "DeepSeek V4.1 Flash ×0.125"',
    '          glm-5.3:',
    '            name: "GLM-5.3 ×0.667"',
    '      acme-gateway:',
    '        displayName: Acme Gateway',
    '        apiKeyEnv: ACME_KEY',
    '        api: openai-completions',
    '        baseURL: http://127.0.0.1:1/v1',
    '        models:',
    '          - id: acme-flash',
    '            name: Acme Flash',
    '      anthropic-only:',
    '        displayName: Anthropic Only',
    '        apiKeyEnv: ACME_KEY',
    '        api: anthropic-messages',
    '        baseURL: http://127.0.0.1:1/anthropic',
    '        models:',
    '          - id: claude-flash',
    '      no-key:',
    '        displayName: No Key',
    '        apiKeyEnv: MISSING_KEY',
    '        api: openai-completions',
    '        baseURL: http://127.0.0.1:1/v1',
    '        models:',
    '          - id: m1',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: opencode-go',
    '    model: deepseek-v4.1-flash',
    ''
  ].join('\n'));
  write(path.join(dshHome, '.credentials.yaml'), [
    'version: 1',
    'refs:',
    '  OPENCODE_GO_API_KEY: test-key-opencode-123456',
    '  ACME_KEY: test-key-acme-123456',
    ''
  ].join('\n'));

  const child = spawn(process.execPath, [path.join(APP_DIR, 'server', 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT5),
      PROJECT_SCAN_ROOT: workspace,
      PROJECT_SCAN_DATA_DIR: path.join(workspace, '.data'),
      PROJECT_SCAN_DSH_HOME: dshHome,
      PROJECT_SCAN_LLM: 'on',
      PROJECT_SCAN_ALLOW_SCANNER_STOP: 'off',
      PROJECT_SCAN_AUTO_UPDATE: 'off'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', function (chunk) { output += chunk.toString(); });
  child.stderr.on('data', function (chunk) { output += chunk.toString(); });

  try {
    const deadline = Date.now() + 20000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(BASE5 + '/api/health');
        if (res.ok) { healthy = true; break; }
      } catch (err) { /* 等待启动 */ }
      await sleepMs(150);
    }
    assert.ok(healthy, '独立服务应启动成功：' + output.slice(-400));

    const listRes = await fetch(BASE5 + '/api/llm/channels');
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.equal(list.dsh.found, true);
    assert.equal(list.selection, null);
    assert.equal(list.effective.source, 'default');
    assert.equal(list.effective.provider, 'opencode-go');
    assert.equal(list.effective.model, 'deepseek-v4.1-flash');
    const ids = list.channels.map(function (channel) { return channel.id; });
    assert.deepEqual(ids, ['opencode-go', 'acme-gateway', 'no-key'], '只列 OpenAI 兼容渠道');
    const opencode = list.channels[0];
    assert.equal(opencode.keyConfigured, true);
    assert.ok(opencode.keyMasked);
    assert.deepEqual(opencode.models.map(function (model) { return model.id; }), ['deepseek-v4.1-flash', 'glm-5.3']);
    assert.equal(opencode.models[0].name, 'DeepSeek V4.1 Flash ×0.125');
    const noKey = list.channels.find(function (channel) { return channel.id === 'no-key'; });
    assert.equal(noKey.keyConfigured, false);
    assert.ok(noKey.reason);
    assert.ok(!JSON.stringify(list).includes('test-key-opencode-123456'), '渠道列表不得返回完整 key');
    assert.ok(!JSON.stringify(list).includes('test-key-acme-123456'));

    const invalid = await fetch(BASE5 + '/api/llm/selection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selection: { provider: 'opencode-go' } })
    });
    assert.equal(invalid.status, 400);

    const notFound = await fetch(BASE5 + '/api/llm/selection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selection: { provider: 'nope', model: 'x' } })
    });
    assert.equal(notFound.status, 404);
    assert.equal((await notFound.json()).error.code, 'CHANNEL_NOT_FOUND');

    const badModel = await fetch(BASE5 + '/api/llm/selection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selection: { provider: 'opencode-go', model: 'nope' } })
    });
    assert.equal(badModel.status, 404);
    assert.equal((await badModel.json()).error.code, 'MODEL_NOT_FOUND');

    const keyMissing = await fetch(BASE5 + '/api/llm/selection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selection: { provider: 'no-key', model: 'm1' } })
    });
    assert.equal(keyMissing.status, 422);
    assert.equal((await keyMissing.json()).error.code, 'KEY_MISSING');

    const selectRes = await fetch(BASE5 + '/api/llm/selection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selection: { provider: 'opencode-go', model: 'glm-5.3' } })
    });
    assert.equal(selectRes.status, 200);
    const selected = await selectRes.json();
    assert.deepEqual(selected.selection, { provider: 'opencode-go', model: 'glm-5.3' });
    assert.equal(selected.effective.source, 'custom');
    assert.equal(selected.effective.model, 'glm-5.3');
    assert.equal(selected.effective.channelName, 'OpenCode Go');
    assert.equal(selected.enrichScheduled, true);

    const settingsRes = await fetch(BASE5 + '/api/settings');
    assert.equal(settingsRes.status, 200);
    const settings = await settingsRes.json();
    assert.deepEqual(settings.llmSelection, { provider: 'opencode-go', model: 'glm-5.3' });

    const savedSettings = JSON.parse(fs.readFileSync(path.join(workspace, '.data', 'settings.json'), 'utf8'));
    assert.equal(savedSettings.version, 3);
    assert.deepEqual(savedSettings.llmSelection, { provider: 'opencode-go', model: 'glm-5.3' });
    assert.ok(!JSON.stringify(savedSettings).includes('test-key-'), 'settings.json 不保存 token');

    const afterList = await (await fetch(BASE5 + '/api/llm/channels')).json();
    assert.deepEqual(afterList.selection, { provider: 'opencode-go', model: 'glm-5.3' });
    assert.equal(afterList.effective.source, 'custom');

    const resetRes = await fetch(BASE5 + '/api/llm/selection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selection: null })
    });
    assert.equal(resetRes.status, 200);
    const reset = await resetRes.json();
    assert.equal(reset.selection, null);
    assert.equal(reset.effective.source, 'default');
  } finally {
    try { child.kill('SIGTERM'); } catch (err) { /* ignore */ }
    await sleepMs(500);
    try { child.kill('SIGKILL'); } catch (err) { /* ignore */ }
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(dshHome, { recursive: true, force: true });
  }
});
