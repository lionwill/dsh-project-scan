/**
 * test/runner.test.mjs — server/runner.js 的单元/集成测试
 *
 * 覆盖：
 *  - detect 的检测顺序与分类（npm/pnpm/yarn、start.sh/run.sh、index.html、Godot、Python、Xcode、不可运行）
 *  - 检测结果缓存（updatedAt 变化后失效）
 *  - static 预览 run/stop/state/logs、ALREADY_RUNNING
 *  - 真实启动一个本地 HTTP 服务：端口捕获、running、日志、stop 杀掉进程组（ps 校验）
 *  - 进程失败 / 命令不存在 → failed + 可读日志
 *  - 端口捕获超时 → 保持 running、url=null
 *  - open 类命令没有 url 也正常返回（用假 open 脚本，避免真的启动 GUI 应用）
 *  - logs() 最近 20 条记录保留策略
 *  - shutdown() 清理子进程且幂等
 *
 * 全部使用 /tmp 下的临时项目目录，不依赖网络、不占用 8790 端口、不碰工作区已有项目。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { createRunner } from '../server/runner.js';

const BASE = await mkdtemp('/tmp/project-scan-runner-');
let caseSeq = 0;

after(async function () {
  await rm(BASE, { recursive: true, force: true });
});

/** 每个用例独立根目录 + 独立 runner；用例结束后 shutdown 并删除临时目录。 */
async function setup(t, runnerOptions = {}) {
  const root = join(BASE, 'case-' + (caseSeq += 1));
  await mkdir(root, { recursive: true });
  const updates = [];
  const runner = createRunner(
    Object.assign(
      {
        root,
        onUpdate: function (run) {
          updates.push(run);
        }
      },
      runnerOptions
    )
  );
  t.after(async function () {
    try {
      await runner.shutdown();
    } catch (err) {
      /* 清理失败不掩盖测试本身的失败 */
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, runner, updates };
}

/** 在临时根目录下创建项目目录与文件，返回 Project 形状的对象。 */
async function createProject(root, name, files = {}) {
  const projectDir = join(root, name);
  await mkdir(projectDir, { recursive: true });
  for (const [relPath, fileContent] of Object.entries(files)) {
    const filePath = join(projectDir, relPath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, fileContent, 'utf8');
  }
  return {
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    dir: name,
    path: projectDir
  };
}

/** 轮询等待某个状态成立。 */
async function waitFor(readFn, predicate, timeoutMs = 5000, intervalMs = 40) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await readFn();
    if (predicate(last)) return last;
    await new Promise(function (resolve) {
      setTimeout(resolve, intervalMs);
    });
  }
  throw new Error('等待超时，最后状态：' + JSON.stringify(last));
}

/**
 * 校验进程（及其进程组）确实不存在。
 * 注：本机 DSH 沙箱禁止执行 ps（spawn EPERM），因此用 kill(pid, 0) 系统调用探测；
 * 进程不存在时抛 ESRCH，进程存在但无权限时抛 EPERM。
 */
async function assertProcessGone(pid) {
  function isAlive(targetPid) {
    try {
      process.kill(targetPid, 0);
      return true;
    } catch (err) {
      return !(err && err.code === 'ESRCH');
    }
  }

  // 子进程退出事件与进程组清理之间可能有毫秒级窗口，这里最多等 3 秒
  const deadline = Date.now() + 3000;
  let alive = true;
  let groupAlive = true;
  while (Date.now() < deadline) {
    alive = isAlive(pid);
    groupAlive = isAlive(-pid);
    if (!alive && !groupAlive) break;
    await new Promise(function (resolve) {
      setTimeout(resolve, 50);
    });
  }
  assert.equal(alive, false, '进程 ' + pid + ' 应该已经被杀掉');
  assert.equal(groupAlive, false, '进程组 ' + pid + ' 应该已经被清理');
}

const HTTP_SERVER_SOURCE = [
  "import http from 'node:http';",
  'const server = http.createServer(function (req, res) {',
  "  res.writeHead(200, { 'content-type': 'text/plain' });",
  "  res.end('runner-ok');",
  '});',
  "server.listen(0, '127.0.0.1', function () {",
  '  const port = server.address().port;',
  "  console.log('Local:   http://localhost:' + port + '/');",
  '});',
  ''
].join('\n');

/* ------------------------------------------------------------------ */
/* detect                                                             */
/* ------------------------------------------------------------------ */

test('detect：按契约顺序识别 package.json scripts / 锁文件 / shell 脚本 / 静态 / Godot / Python / Xcode / 不可运行', async function (t) {
  const { root, runner } = await setup(t);

  const npmProject = await createProject(root, 'npm-app', {
    'package.json': JSON.stringify({ name: 'npm-app', scripts: { dev: 'node server.js' } }),
    'package-lock.json': '{}'
  });
  assert.deepEqual(runner.detect(npmProject), {
    runnable: true,
    kind: 'command',
    command: 'npm run dev',
    runHint: 'npm run dev',
    reason: null
  });

  const pnpmProject = await createProject(root, 'pnpm-app', {
    'package.json': JSON.stringify({ scripts: { start: 'vite' } }),
    'pnpm-lock.yaml': 'lockfileVersion: 9\n'
  });
  assert.equal(runner.detect(pnpmProject).command, 'pnpm run start');

  const yarnProject = await createProject(root, 'yarn-app', {
    'package.json': JSON.stringify({ scripts: { serve: 'node app.js' } }),
    'yarn.lock': ''
  });
  assert.equal(runner.detect(yarnProject).command, 'yarn run serve');

  const priorityProject = await createProject(root, 'priority-app', {
    'package.json': JSON.stringify({
      scripts: { preview: 'node p.js', serve: 'node s.js', start: 'node a.js', dev: 'node d.js' }
    })
  });
  assert.equal(runner.detect(priorityProject).command, 'npm run dev');

  const bashFallback = await createProject(root, 'bash-app', {
    'package.json': JSON.stringify({ scripts: { build: 'tsc' } }),
    'start.sh': '#!/usr/bin/env bash\nnode server.js\n'
  });
  assert.equal(runner.detect(bashFallback).command, 'bash start.sh');

  const runShProject = await createProject(root, 'runsh-app', {
    'run.sh': '#!/usr/bin/env bash\nnode server.js\n'
  });
  assert.deepEqual(runner.detect(runShProject), {
    runnable: true,
    kind: 'command',
    command: 'bash run.sh',
    runHint: 'bash run.sh',
    reason: null
  });

  const staticProject = await createProject(root, 'static-app', {
    'index.html': '<!doctype html><title>static</title>'
  });
  assert.deepEqual(runner.detect(staticProject), {
    runnable: true,
    kind: 'static',
    command: null,
    runHint: '静态页面预览',
    reason: null
  });

  // package.json 优先于 index.html
  const mixedProject = await createProject(root, 'mixed-app', {
    'package.json': JSON.stringify({ scripts: { dev: 'node d.js' } }),
    'index.html': '<h1>mixed</h1>'
  });
  assert.equal(runner.detect(mixedProject).command, 'npm run dev');

  const godotProject = await createProject(root, 'godot-app', {
    'project.godot': '[application]\nconfig/name="demo"\n'
  });
  const godotInfo = runner.detect(godotProject);
  assert.equal(godotInfo.kind, 'open');
  assert.equal(godotInfo.runnable, true);
  assert.match(godotInfo.command, /^open -a Godot /);
  assert.equal(godotInfo.runHint, 'Godot 项目');

  const pythonProject = await createProject(root, 'python-app', {
    'server.py': 'print("hello")\n'
  });
  assert.deepEqual(runner.detect(pythonProject), {
    runnable: true,
    kind: 'command',
    command: 'python3 server.py',
    runHint: 'python3 server.py',
    reason: null
  });

  const xcodeProject = await createProject(root, 'xcode-app', {});
  await mkdir(join(xcodeProject.path, 'Demo.xcodeproj'), { recursive: true });
  const xcodeInfo = runner.detect(xcodeProject);
  assert.equal(xcodeInfo.kind, 'open');
  assert.match(xcodeInfo.command, /^open .*Demo\.xcodeproj$/);
  assert.equal(xcodeInfo.runHint, 'Xcode 项目');

  const noneProject = await createProject(root, 'none-app', { 'README.md': '# nothing\n' });
  const noneInfo = runner.detect(noneProject);
  assert.equal(noneInfo.runnable, false);
  assert.equal(noneInfo.kind, 'none');
  assert.equal(noneInfo.command, null);
  assert.match(noneInfo.reason, /没有找到可识别的运行入口/);

  // 路径不存在 / 非法入参也不抛异常
  assert.equal(runner.detect({ id: 'ghost', path: join(root, 'ghost') }).runnable, false);
  assert.equal(runner.detect(null).runnable, false);
});

test('detect：检测结果按项目 mtime 缓存，updatedAt 变化后失效', async function (t) {
  const { root, runner } = await setup(t);
  const project = await createProject(root, 'cache-app', {
    'package.json': JSON.stringify({ scripts: { dev: 'node d.js' } })
  });

  assert.equal(runner.detect(project).command, 'npm run dev');
  // 第二次调用命中缓存
  assert.equal(runner.detect(project).command, 'npm run dev');

  // 只改文件内容（目录 mtime 不变）时，靠 scanner 提供的 updatedAt 使缓存失效
  await writeFile(join(project.path, 'package.json'), JSON.stringify({ scripts: { serve: 'node s.js' } }));
  assert.equal(runner.detect(project).command, 'npm run dev'); // 旧 updatedAt：仍命中缓存
  assert.equal(
    runner.detect(Object.assign({}, project, { updatedAt: new Date().toISOString() })).command,
    'npm run serve'
  );
});

/* ------------------------------------------------------------------ */
/* 静态预览                                                            */
/* ------------------------------------------------------------------ */

test('static：run 直接返回 /preview/<id>/，stop/state/logs 可用，重复 run 抛 ALREADY_RUNNING', async function (t) {
  const { root, runner } = await setup(t);
  const project = await createProject(root, 'static-demo', {
    'index.html': '<!doctype html><title>demo</title>'
  });

  assert.equal(runner.detect(project).kind, 'static');
  const run = await runner.run(project);
  assert.equal(run.status, 'running');
  assert.equal(run.url, '/preview/static-demo/');
  assert.equal(run.pid, null);
  assert.equal(run.command, null);
  assert.equal(run.projectId, 'static-demo');
  assert.equal(run.cwd, project.path);
  assert.equal(run.endedAt, null);
  assert.equal(run.exitCode, null);
  assert.match(run.runId, /^run-\d+-[a-z0-9]+$/);
  assert.ok(Array.isArray(run.log) && run.log.length >= 1);

  await assert.rejects(
    function () {
      return runner.run(project);
    },
    function (err) {
      assert.equal(err.code, 'ALREADY_RUNNING');
      return true;
    }
  );

  assert.equal(runner.state('static-demo').status, 'running');
  const found = runner.logs(run.runId);
  assert.ok(found);
  assert.equal(found.run.runId, run.runId);
  assert.ok(found.logs.length >= 1);

  const stopped = runner.stop('static-demo');
  assert.equal(stopped.status, 'exited');
  assert.equal(stopped.exitCode, 0);
  assert.ok(stopped.endedAt);
  assert.equal(runner.state('static-demo').status, 'exited');
  assert.equal(runner.stop('static-demo'), null);

  // 未知 runId / projectId
  assert.equal(runner.logs('run-does-not-exist'), null);
  assert.equal(runner.state('unknown-project'), null);
});

test('logs：只保留最近 20 条运行记录', async function (t) {
  const { root, runner } = await setup(t);
  const project = await createProject(root, 'many-runs', { 'index.html': '<h1>x</h1>' });

  const runIds = [];
  for (let i = 0; i < 21; i += 1) {
    const run = await runner.run(project);
    runIds.push(run.runId);
    assert.equal(runner.stop(project.id).status, 'exited');
  }

  assert.equal(runner.logs(runIds[0]), null, '第 1 条记录应已被淘汰');
  assert.ok(runner.logs(runIds[20]), '最新记录应可查询');
  assert.equal(runner.logs(runIds[20]).run.runId, runIds[20]);
});

/* ------------------------------------------------------------------ */
/* 真实进程：端口捕获 + 停止                                            */
/* ------------------------------------------------------------------ */

test('command：启动 HTTP 服务并捕获端口，stop 用 SIGTERM 杀掉进程组', async function (t) {
  const { root, runner, updates } = await setup(t);
  const project = await createProject(root, 'live-app', {
    'package.json': JSON.stringify({ name: 'live-app', scripts: { dev: 'node server.mjs' } }),
    'server.mjs': HTTP_SERVER_SOURCE
  });

  const run = await runner.run(project);
  assert.equal(run.status, 'running');
  assert.match(run.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(typeof run.pid, 'number');
  assert.equal(run.command, 'npm run dev');
  assert.equal(run.cwd, project.path);
  assert.equal(run.endedAt, null);
  assert.equal(run.exitCode, null);

  // 服务确实可以访问（localhost，不依赖外网）
  const response = await fetch(run.url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'runner-ok');

  // 状态变化回调里有 starting 与 running
  assert.ok(updates.some(function (item) { return item.status === 'starting'; }));
  assert.ok(updates.some(function (item) { return item.status === 'running' && item.url === run.url; }));
  assert.equal(runner.state(project.id).status, 'running');

  // 日志里应有捕获到的那行输出
  const found = runner.logs(run.runId);
  assert.ok(found.logs.some(function (line) { return line.includes('localhost:'); }), '日志应包含捕获到的地址行');

  await assert.rejects(
    function () {
      return runner.run(project);
    },
    function (err) {
      assert.equal(err.code, 'ALREADY_RUNNING');
      return true;
    }
  );

  const pid = run.pid;
  const stopped = runner.stop(project.id);
  assert.ok(stopped);
  assert.equal(stopped.pid, pid);
  assert.equal(stopped.status, 'running'); // stop 立即返回，退出由进程事件异步更新

  const finalState = await waitFor(
    function () {
      return runner.state(project.id);
    },
    function (state) {
      return state && state.status === 'exited';
    }
  );
  assert.equal(finalState.status, 'exited');
  assert.ok(finalState.endedAt);
  await assertProcessGone(pid);

  // 已结束的实例再 stop 返回 null
  assert.equal(runner.stop(project.id), null);
});

test('command：项目自带 .venv 时优先使用虚拟环境（start.sh 里的 python3 指向 .venv）', async function (t) {
  const { root, runner } = await setup(t);
  const project = await createProject(root, 'venv-app', {
    'start.sh':
      '#!/usr/bin/env bash\n' +
      'echo "VENV=$VIRTUAL_ENV"\n' +
      'echo "PY=$(command -v python3)"\n' +
      'sleep 0.2\n'
  });
  const venvBin = join(project.path, '.venv', 'bin');
  await mkdir(venvBin, { recursive: true });
  await writeFile(join(venvBin, 'python'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  await writeFile(join(venvBin, 'python3'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

  const run = await runner.run(project);
  const logs = runner.logs(run.runId).logs.join('\n');
  assert.match(logs, /使用项目虚拟环境/);
  assert.match(logs, /VENV=.*\.venv/);
  assert.match(logs, /PY=.*\.venv\/bin\/python/);
  await waitFor(
    function () {
      return runner.state(project.id);
    },
    function (state) {
      return state && state.status === 'exited';
    }
  );
});

test('command：启动输出没有地址时，从 README 文档化端口探测并捕获', async function (t) {
  const { root, runner } = await setup(t, { portTimeoutMs: 1200 });
  const port = await new Promise(function (resolve) {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', function () {
      const actual = probe.address().port;
      probe.close(function () {
        resolve(actual);
      });
    });
  });

  const project = await createProject(root, 'doc-url-app', {
    'README.md': '# doc-url-app\n\n启动后打开 http://127.0.0.1:' + port + ' 即可。\n',
    'start.sh': '#!/usr/bin/env bash\nexec node silent-server.mjs\n',
    'silent-server.mjs':
      "import http from 'node:http';\n" +
      'const server = http.createServer(function (req, res) { res.end("doc-ok"); });\n' +
      "server.listen(" + port + ", '127.0.0.1');\n"
  });

  const run = await runner.run(project);
  assert.equal(run.status, 'running');
  assert.equal(run.url, 'http://127.0.0.1:' + port);
  const response = await fetch(run.url);
  assert.equal(await response.text(), 'doc-ok');
  const logs = runner.logs(run.runId).logs.join('\n');
  assert.match(logs, /来自项目文档/);
  runner.stop(project.id);
  await waitFor(
    function () {
      return runner.state(project.id);
    },
    function (state) {
      return state && state.status === 'exited';
    }
  );
});

test('command：进程失败或命令不存在时落到 failed 状态并给出可读日志', async function (t) {
  const { root, runner } = await setup(t);

  const failingProject = await createProject(root, 'failing-app', {
    'start.sh': '#!/usr/bin/env bash\nexit 3\n'
  });
  const failedRun = await runner.run(failingProject);
  assert.equal(failedRun.status, 'failed');
  assert.equal(failedRun.exitCode, 3);
  assert.ok(failedRun.endedAt);
  assert.match(failedRun.log.join('\n'), /exitCode=3/);
  assert.equal(runner.state(failingProject.id).status, 'failed');
  assert.equal(runner.stop(failingProject.id), null);

  const missingProject = await createProject(root, 'missing-command', {
    'start.sh': '#!/usr/bin/env bash\nnonexistent-command-xyz-123\n'
  });
  const missingRun = await runner.run(missingProject);
  assert.equal(missingRun.status, 'failed');
  assert.equal(missingRun.exitCode, 127);
  assert.match(missingRun.log.join('\n'), /not found|未找到|命令/i);
});

test('command：端口捕获超时后保持 running、url=null', async function (t) {
  const { root, runner } = await setup(t, { portTimeoutMs: 400 });
  const project = await createProject(root, 'no-url-app', {
    'start.sh': '#!/usr/bin/env bash\nsleep 10\n'
  });

  const started = Date.now();
  const run = await runner.run(project);
  const elapsed = Date.now() - started;
  assert.equal(run.status, 'running');
  assert.equal(run.url, null);
  assert.ok(elapsed >= 300, '应等待端口捕获超时，实际 ' + elapsed + 'ms');
  assert.ok(elapsed < 5000, '超时后应立即返回，实际 ' + elapsed + 'ms');

  assert.ok(runner.stop(project.id));
  const finalState = await waitFor(
    function () {
      return runner.state(project.id);
    },
    function (state) {
      return state && state.status === 'exited';
    }
  );
  assert.equal(finalState.status, 'exited');
  await assertProcessGone(run.pid);
});

/* ------------------------------------------------------------------ */
/* open 类命令 / shutdown                                              */
/* ------------------------------------------------------------------ */

test('open：macOS open 类命令没有 url 也正常返回 running', async function (t) {
  const { root, runner } = await setup(t);
  const project = await createProject(root, 'godot-app', {
    'project.godot': '[application]\nconfig/name="demo"\n'
  });

  // 用假的 open 脚本，避免测试真的启动 GUI 应用
  const fakeBin = join(root, 'fakebin');
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(fakeBin, 'open'), '#!/usr/bin/env bash\nsleep 1\nexit 0\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = fakeBin + ':' + (originalPath || '');
  t.after(function () {
    process.env.PATH = originalPath;
  });

  const info = runner.detect(project);
  assert.equal(info.kind, 'open');

  const run = await runner.run(project);
  assert.equal(run.status, 'running');
  assert.equal(run.url, null);
  assert.match(run.command, /^open -a Godot /);

  const finalState = await waitFor(
    function () {
      return runner.state(project.id);
    },
    function (state) {
      return state && state.status === 'exited';
    }
  );
  assert.equal(finalState.status, 'exited');
  assert.equal(finalState.exitCode, 0);
});

test('shutdown：清理全部子进程与定时器，且可重复调用', async function (t) {
  const { root, runner } = await setup(t);
  const project = await createProject(root, 'shutdown-app', {
    'run.sh': '#!/usr/bin/env bash\nnode server.mjs\n',
    'server.mjs': HTTP_SERVER_SOURCE
  });

  const run = await runner.run(project);
  assert.equal(run.status, 'running');
  assert.ok(run.url);

  await runner.shutdown();
  await assertProcessGone(run.pid);
  assert.equal(runner.state(project.id).status, 'exited');

  await runner.shutdown(); // 幂等
  assert.equal(runner.stop(project.id), null);
});
