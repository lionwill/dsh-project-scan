import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseListeners,
  parseCwds,
  bestProject,
  createExternalRuns
} from '../server/external-runs.js';

function fakeRun(handler) {
  const calls = [];
  const run = async function (args) {
    calls.push(args.join(' '));
    return handler(args);
  };
  run.calls = calls;
  return run;
}

const LISTENERS = [
  'p638',
  'crapportd',
  'n*:59154',
  'p89205',
  'cdesign-collab-backend',
  'n*:10200',
  'n*:10201',
  'p1866',
  'cGitHub Desktop Helper (Renderer',
  'n127.0.0.1:58552',
  ''
].join('\n');

const CWDS = ['p638', 'fcwd', 'n/', 'p89205', 'fcwd', 'n/Users/demo/DHS/weavemind/backend', 'p1866', 'fcwd', 'n/Applications/GitHub Desktop.app', ''].join('\n');

test('external-runs：解析 lsof 监听端口与 cwd', function () {
  const processes = parseListeners(LISTENERS);
  assert.deepEqual(processes.map(function (p) { return p.pid; }), [638, 89205, 1866]);
  const weavemind = processes.find(function (p) { return p.pid === 89205; });
  assert.deepEqual(weavemind.ports, [10200, 10201]);
  assert.equal(weavemind.command, 'design-collab-backend');

  const cwds = parseCwds(CWDS);
  assert.equal(cwds.get(89205), '/Users/demo/DHS/weavemind/backend');
  assert.equal(cwds.get(638), '/');
});

test('external-runs：匹配项目取最长路径（子项目优先）', function () {
  const projects = [
    { id: 'weavemind', path: '/Users/demo/DHS/weavemind' },
    { id: 'weavemind--backend', path: '/Users/demo/DHS/weavemind/backend' },
    { id: 'other', path: '/Users/demo/other' }
  ];
  assert.equal(bestProject(projects, '/Users/demo/DHS/weavemind/backend').id, 'weavemind--backend');
  assert.equal(bestProject(projects, '/Users/demo/DHS/weavemind/frontend').id, 'weavemind');
  assert.equal(bestProject(projects, '/Users/demo/unknown'), null);
  assert.equal(bestProject(projects, '/Users/demo/DHS/weavemindx'), null);
});

test('external-runs：探测 HTML 端口并生成项目匹配；结果缓存与 changed 标记', async function () {
  const run = fakeRun(function (args) {
    if (args.indexOf('-iTCP') !== -1) return { code: 0, stdout: LISTENERS, stderr: '' };
    return { code: 0, stdout: CWDS, stderr: '' };
  });
  const probed = [];
  const probe = async function (url) {
    probed.push(url);
    if (url === 'http://127.0.0.1:10201/') return { status: 200, contentType: 'text/html; charset=utf-8' };
    return { status: 404, contentType: 'application/json' };
  };
  const external = createExternalRuns({
    run: run,
    probe: probe,
    getProjects: function () {
      return [{ id: 'ws-dhs--weavemind', path: '/Users/demo/DHS/weavemind' }];
    }
  });

  const first = await external.refresh();
  assert.equal(first.changed, true);
  const match = external.matchFor('ws-dhs--weavemind');
  assert.ok(match);
  assert.equal(match.port, 10201, '应优先选择返回 HTML 的端口');
  assert.equal(match.url, 'http://127.0.0.1:10201/');
  assert.equal(match.pid, 89205);
  assert.ok(probed.indexOf('http://127.0.0.1:10201/') !== -1);

  const second = await external.refresh();
  assert.equal(second.changed, false, '结果未变化时不应重复广播');
  assert.equal(external.matchFor('ws-dhs--weavemind').port, 10201);
});

test('external-runs：无 HTML 端口时选最高端口；无项目匹配/非项目 cwd 被忽略', async function () {
  const run = fakeRun(function (args) {
    if (args.indexOf('-iTCP') !== -1) return { code: 0, stdout: LISTENERS, stderr: '' };
    return { code: 0, stdout: CWDS, stderr: '' };
  });
  const external = createExternalRuns({
    run: run,
    probe: async function () { return { status: 404, contentType: '' }; },
    getProjects: function () { return []; }
  });
  await external.refresh();
  assert.equal(external.matchFor('ws-dhs--weavemind'), null, '没有项目配置时不匹配');

  const withProject = createExternalRuns({
    run: run,
    probe: async function () { return { status: 404, contentType: '' }; },
    getProjects: function () { return [{ id: 'ws-dhs--weavemind', path: '/Users/demo/DHS/weavemind' }]; }
  });
  await withProject.refresh();
  assert.equal(withProject.matchFor('ws-dhs--weavemind').port, 10201, '无 HTML 时选最高端口作为兜底');
});

test('external-runs：lsof 失败时降级为空匹配并记录错误', async function () {
  const external = createExternalRuns({
    run: fakeRun(function () { return { code: 1, stdout: '', stderr: 'lsof: Operation not permitted' }; }),
    probe: async function () { throw new Error('不应探测'); },
    getProjects: function () { return [{ id: 'p', path: '/x' }]; },
    log: function () {}
  });
  await external.refresh();
  assert.equal(external.matchFor('p'), null);
  assert.match(external.snapshot().error, /lsof/);
});
