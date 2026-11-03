import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  scanWorkspace,
  summarizeReadme,
  slugify,
  hashString,
  FALLBACK_SUMMARY,
  ACCENTS
} from '../server/scanner.js';

const BT = String.fromCharCode(96);
const FENCE = BT + BT + BT;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KINDS = ['node', 'static', 'godot', 'python', 'xcode', 'gradle', 'assets', 'docs', 'unknown'];
const RUN_KINDS = ['command', 'static', 'open', 'none'];

// ---------------------------------------------------------------------------
// summarizeReadme
// ---------------------------------------------------------------------------

test('summarizeReadme：空内容 / 没有 README 时返回兜底文案', () => {
  for (const raw of ['', '   \n\t\n  ', null, undefined]) {
    const result = summarizeReadme(raw);
    assert.equal(result.title, null);
    assert.equal(result.summary, FALLBACK_SUMMARY);
  }
});

test('summarizeReadme：提取首个 H1 与第一段有效正文，跳过徽章 / 图片', () => {
  const raw = [
    '# Model Studio — 多对象场景打光',
    '',
    '[![npm](https://img.shields.io/npm/v/x.svg)](https://npm.im/x)',
    '![截图](./shot.png)',
    '',
    '一个本地网页应用，面向不会 Blender 的人做宣传物料。',
    '',
    '第二段不应该被取到。'
  ].join('\n');
  const result = summarizeReadme(raw);
  assert.equal(result.title, 'Model Studio — 多对象场景打光');
  assert.equal(result.summary, '一个本地网页应用，面向不会 Blender 的人做宣传物料。');
});

test('summarizeReadme：徽章开头的紧凑排版也能跳过', () => {
  const raw = [
    '# 项目',
    '[![build](https://img.shields.io/build.svg)](https://ci.example.com)',
    '![logo](./logo.png)',
    '',
    '真正的说明文字在这里。'
  ].join('\n');
  const result = summarizeReadme(raw);
  assert.equal(result.title, '项目');
  assert.equal(result.summary, '真正的说明文字在这里。');
});

test('summarizeReadme：跳过代码块，代码块里的 # 注释不能当成标题', () => {
  const raw = [
    FENCE + 'bash',
    '# 这是注释，不是 H1',
    'npm run dev',
    FENCE,
    '',
    '# 工具',
    '',
    '这是真正的说明。'
  ].join('\n');
  const result = summarizeReadme(raw);
  assert.equal(result.title, '工具');
  assert.equal(result.summary, '这是真正的说明。');
});

test('summarizeReadme：跳过 HTML 块并清洗行内 markdown', () => {
  const raw = [
    '<div align="center"><img src="logo.png" alt="logo"></div>',
    '',
    '# 标题',
    '',
    '说明文字，带 <b>加粗</b> 和 [链接](https://example.com) 以及 ' + BT + '代码' + BT + '。'
  ].join('\n');
  const result = summarizeReadme(raw);
  assert.equal(result.title, '标题');
  assert.equal(result.summary, '说明文字，带 加粗 和 链接 以及 代码。');
});

test('summarizeReadme：纯标题 / 只有列表时走兜底文案', () => {
  assert.equal(summarizeReadme('# 只有标题\n').title, '只有标题');
  assert.equal(summarizeReadme('# 只有标题\n').summary, FALLBACK_SUMMARY);
  assert.equal(summarizeReadme('# T\n\n- 第一项\n- 第二项\n').summary, FALLBACK_SUMMARY);
});

test('summarizeReadme：列表 / 表格 / 引用不会进入摘要', () => {
  const raw = [
    '# T',
    '',
    '- 第一项',
    '- 第二项',
    '',
    '| 列 | 说明 |',
    '| --- | --- |',
    '| a | b |',
    '',
    '> 引用也不算',
    '',
    '段落说明。'
  ].join('\n');
  assert.equal(summarizeReadme(raw).summary, '段落说明。');
});

test('summarizeReadme：超长摘要截断到 220 字以内', () => {
  const sentence = '这是一段很长的项目说明文字。';
  const raw = '# 长文\n\n' + sentence.repeat(40);
  const result = summarizeReadme(raw);
  assert.equal(result.title, '长文');
  assert.ok(result.summary.length <= 220, '摘要长度应 <= 220，实际 ' + result.summary.length);
  assert.ok(result.summary.length >= 180, '超长摘要不应被截得太短');
  assert.ok(result.summary.endsWith('…'));
});

test('summarizeReadme：跳过 YAML front matter，H1 可以出现在 H2 之后', () => {
  const raw = [
    '---',
    'title: 配置文件',
    'tags: [a, b]',
    '---',
    '',
    '## 副标题',
    '',
    '# 主标题',
    '',
    '正文第一段。'
  ].join('\n');
  const result = summarizeReadme(raw);
  assert.equal(result.title, '主标题');
  assert.equal(result.summary, '正文第一段。');
});

test('summarizeReadme：兼容 CRLF 换行与全角标点', () => {
  const raw = '# 标题\r\n\r\n第一段说明，包含全角标点。\r\n\r\n第二段。';
  const result = summarizeReadme(raw);
  assert.equal(result.title, '标题');
  assert.equal(result.summary, '第一段说明，包含全角标点。');
});

test('summarizeReadme：返回值形状固定', () => {
  const result = summarizeReadme('# T\n\n正文。');
  assert.deepEqual(Object.keys(result).sort(), ['summary', 'title']);
});

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

test('slugify：稳定、URL 安全、可重复', () => {
  assert.equal(slugify('demo_studio'), 'demo-studio');
  assert.equal(slugify('novel reader'), 'novel-reader');
  assert.equal(slugify('  Demo-motion-reel-main  '), 'demo-motion-reel-main');
  assert.equal(slugify('img-Crawler'), 'img-crawler');
  assert.equal(slugify('a__b'), 'a-b');
  assert.equal(slugify('中文 项目'), '中文-项目');
  assert.equal(slugify('Café Project'), 'cafe-project');
  assert.equal(slugify(''), 'project');
  assert.equal(slugify('!!!'), 'project');
  assert.equal(slugify(null), 'project');
  assert.equal(slugify(undefined), 'project');
  const once = slugify('Some Weird__Name!!');
  assert.equal(slugify(once), once);
  assert.match(once, /^[a-z0-9-]+$/);
});

test('hashString：同一输入稳定，不同输入大概率不同', () => {
  assert.equal(hashString('demo-studio'), hashString('demo-studio'));
  assert.notEqual(hashString('demo-studio'), hashString('demo-studios'));
  assert.ok(Number.isInteger(hashString('x')) && hashString('x') >= 0);
});

test('scanWorkspace：工作区不存在时抛出可读错误', async () => {
  await assert.rejects(
    () => scanWorkspace({ root: path.join(os.tmpdir(), 'project-scan-not-exists-' + Date.now()) }),
    /工作区目录不可读/
  );
});

// ---------------------------------------------------------------------------
// scanWorkspace：临时目录夹具
// ---------------------------------------------------------------------------

test('scanWorkspace：临时目录夹具验证收录 / 排除 / 名称 / 时间 / 摘要', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-scan-fixture-'));
  const t1 = new Date('2026-01-01T00:00:00.000Z');
  const t2 = new Date('2026-01-03T00:00:00.000Z');

  async function write(rel, content, mtime) {
    const file = path.join(root, rel);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
    if (mtime) await fsp.utimes(file, mtime, mtime);
  }

  try {
    await write('alpha_app/README.md', '# Alpha 应用\n\n这是 alpha 的第一段说明。\n\n第二段。\n', t1);
    await write('alpha_app/package.json', JSON.stringify({ name: 'alpha-app', scripts: { dev: 'node server.js' } }), t1);
    await write('alpha_app/package-lock.json', '{}', t1);
    await write('alpha_app/server.js', 'console.log(1);\n', t2);

    await write('beta/project.godot', 'config_version=5\n', t1);

    await write('gamma_tool/a.py', 'print(1)\n', t2);
    await write('gamma_tool/b.py', 'print(2)\n', t2);

    await write('nodejs/package.json', JSON.stringify({ name: 'node_js_tool' }), t1);
    await write('nodejs/index.js', 'export {};\n', t2);

    await write('one_script/run.py', 'print(1)\n', t2);

    await write('docs_only/README.md', '# 文档项目\n\n只有文档。\n', t1);

    await write('assets_only/1.png', 'x', t1);
    await write('assets_only/2.jpg', 'x', t1);
    await write('assets_only/notes.txt', 'x', t1);

    await write('skipme/index.js', 'export {};\n', t2);

    await write('fakegit/README.md', '# 假仓库\n\n说明。\n', t1);
    await write('fakegit/.git', 'gitdir: /nonexistent\n', t1);

    await write('.hidden/README.md', '# 隐藏\n', t1);

    const result = await scanWorkspace({ root, config: { excludeDirs: { skipme: '配置排除' }, concurrency: 4 } });
    const byDir = new Map(result.projects.map((project) => [project.dir, project]));

    assert.deepEqual(
      Array.from(byDir.keys()).sort(),
      ['alpha_app', 'beta', 'docs_only', 'fakegit', 'gamma_tool', 'nodejs', 'one_script'].sort()
    );
    assert.equal(result.stats.included, 7);

    const alpha = byDir.get('alpha_app');
    assert.equal(alpha.id, 'alpha-app');
    assert.equal(alpha.name, 'Alpha 应用');
    assert.equal(alpha.readmeTitle, 'Alpha 应用');
    assert.equal(alpha.readmePath, 'README.md');
    assert.equal(alpha.summary, '这是 alpha 的第一段说明。');
    assert.equal(alpha.kind, 'node');
    assert.equal(alpha.runnable, true);
    assert.equal(alpha.runKind, 'command');
    assert.equal(alpha.runHint, 'npm run dev');
    assert.equal(alpha.updatedAt, t2.toISOString());
    assert.equal(alpha.createdAt, t1.toISOString());
    assert.equal(alpha.updatedSource, 'files');
    assert.equal(alpha.git.isRepo, false);
    assert.ok(alpha.fileCount >= 4);
    assert.ok(alpha.tags.includes('Node'));
    assert.equal(alpha.accent, ACCENTS[hashString(alpha.id) % ACCENTS.length]);

    const beta = byDir.get('beta');
    assert.equal(beta.kind, 'godot');
    assert.equal(beta.name, 'beta');
    assert.equal(beta.readmePath, null);
    assert.equal(beta.summary, FALLBACK_SUMMARY);

    const gamma = byDir.get('gamma_tool');
    assert.equal(gamma.name, 'gamma tool');
    assert.equal(gamma.kind, 'python');

    assert.equal(byDir.get('nodejs').name, 'node js tool');
    assert.equal(byDir.get('docs_only').kind, 'docs');
    assert.equal(byDir.get('one_script').kind, 'python');

    const fakegit = byDir.get('fakegit');
    assert.equal(fakegit.readmeTitle, '假仓库');
    assert.equal(fakegit.git.isRepo, false, 'git 命令失败时应静默降级为 { isRepo: false }');

    const excludedDirs = new Map(result.stats.excluded.map((item) => [item.dir, item.reason]));
    assert.ok(excludedDirs.has('assets_only'), '纯素材目录应排除');
    assert.ok(excludedDirs.has('skipme'), '配置排除的目录应排除');
    assert.ok(excludedDirs.has('.hidden'), '隐藏目录应排除');
    assert.match(excludedDirs.get('assets_only'), /未检测到项目特征/);
    assert.equal(excludedDirs.get('skipme'), '配置排除');
    assert.match(excludedDirs.get('.hidden'), /隐藏目录/);

    assert.equal(result.stats.included + result.stats.excluded.length, 10);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspace：git 最后提交晚于文件 mtime 时 updatedAt 取提交时间、updatedSource=git', async (t) => {
  let gitOk = true;
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    gitOk = false;
  }
  if (!gitOk) {
    t.skip('当前环境没有 git，跳过 git 元信息测试');
    return;
  }

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-scan-git-'));
  const repo = path.join(root, 'gitrepo');
  const oldTime = new Date('2026-01-01T00:00:00.000Z');
  const commitIso = '2026-02-01T00:00:00.000Z';
  const commitSeconds = String(Date.parse(commitIso) / 1000);

  const gitEnv = Object.assign({}, process.env, {
    GIT_AUTHOR_NAME: 'Project Scan Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Project Scan Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_DATE: commitIso,
    GIT_COMMITTER_DATE: commitIso
  });

  try {
    await fsp.mkdir(repo, { recursive: true });
    const readme = path.join(repo, 'README.md');
    const mainJs = path.join(repo, 'main.js');
    await fsp.writeFile(readme, '# Git 项目\n\n这个项目用来验证 git 更新时间。\n');
    await fsp.writeFile(mainJs, 'export const answer = 42;\n');
    await fsp.utimes(readme, oldTime, oldTime);
    await fsp.utimes(mainJs, oldTime, oldTime);

    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', '初始提交'], { stdio: 'ignore', env: gitEnv });

    const result = await scanWorkspace({ root });
    const project = result.projects.find((item) => item.dir === 'gitrepo');
    assert.ok(project, 'git 仓库应被收录');
    assert.equal(project.git.isRepo, true);
    assert.equal(project.git.branch, 'main');
    assert.equal(project.git.lastCommitAt, commitIso);
    assert.equal(project.git.lastCommitSubject, '初始提交');
    assert.equal(project.updatedSource, 'git');
    assert.equal(project.updatedAt, commitIso);
    assert.equal(project.createdAt, oldTime.toISOString(), 'createdAt 仍取最早文件 mtime');
    assert.equal(Date.parse(project.updatedAt), Number(commitSeconds) * 1000);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 子项目下钻（临时目录夹具）
// ---------------------------------------------------------------------------

async function writeFixture(root, rel, content) {
  const file = path.join(root, rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
}

function pkgJson(name, scripts) {
  return JSON.stringify({ name, scripts });
}

test('scanWorkspace：子项目下钻识别强入口 / 深度 / 排除 index.html-only', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-scan-children-'));
  try {
    // 父项目自身：有 README 但没有任何运行入口
    await writeFixture(root, 'parent/README.md', '# 父项目\n\n父项目说明。\n');
    // 强入口 a：package.json + dev
    await writeFixture(root, 'parent/app-node/package.json', pkgJson('app-node', { dev: 'vite' }));
    // 弱入口：package.json 但没有 dev/start/serve/preview
    await writeFixture(root, 'parent/app-weak/package.json', pkgJson('app-weak', { build: 'vite build' }));
    // 只有 index.html → 不算
    await writeFixture(root, 'parent/static-only/index.html', '<html></html>');
    // 强入口 b：project.godot
    await writeFixture(root, 'parent/godot-game/project.godot', 'config_version=5');
    // 强入口 e：server.py + README
    await writeFixture(root, 'parent/py-service/server.py', 'print(1)');
    await writeFixture(root, 'parent/py-service/README.md', '# py service\n\npython 服务。\n');
    // server.py 但没有伴随文档 → 不算
    await writeFixture(root, 'parent/py-bare/server.py', 'print(1)');
    // 强入口 d：start.sh + requirements.txt
    await writeFixture(root, 'parent/script-app/start.sh', '#!/bin/sh\n');
    await writeFixture(root, 'parent/script-app/requirements.txt', '');
    // run.sh 但没有伴随文档 → 不算
    await writeFixture(root, 'parent/script-bare/run.sh', '#!/bin/sh\n');
    // 强入口 c：目录名以 .xcodeproj 结尾（放在深度 2，避免父项目根目录出现工程文件）
    await writeFixture(root, 'parent/xcode/Foo.xcodeproj/project.pbxproj', '// xcode');
    // 深度 2 强入口
    await writeFixture(root, 'parent/container/nested-app/package.json', pkgJson('nested-app', { start: 'node x' }));
    // 深度 3 → 超过下钻上限，不算
    await writeFixture(root, 'parent/container/deeper/too-deep/package.json', pkgJson('too-deep', { dev: 'vite' }));
    // 已识别子项目内部不再下钻
    await writeFixture(root, 'parent/app-node/inner-app/package.json', pkgJson('inner-app', { dev: 'vite' }));
    // 隐藏目录 / node_modules 一律跳过
    await writeFixture(root, 'parent/.hidden-app/package.json', pkgJson('hidden', { dev: 'vite' }));
    await writeFixture(root, 'parent/node_modules/dep/package.json', pkgJson('dep', { dev: 'vite' }));

    const result = await scanWorkspace({ root });
    assert.equal(result.projects.length, 1);
    const parent = result.projects[0];
    assert.equal(parent.id, 'parent');
    assert.equal(parent.runnable, false, '父项目自身不可运行');
    assert.equal(parent.depth, 0);
    assert.equal(result.stats.subprojects, parent.children.length);

    const rels = parent.children.map((child) => child.relPath);
    assert.deepEqual(
      new Set(rels),
      new Set(['xcode/Foo.xcodeproj', 'app-node', 'container/nested-app', 'godot-game', 'py-service', 'script-app'])
    );
    for (const excludedRel of [
      'app-weak', 'static-only', 'py-bare', 'script-bare',
      'container/deeper/too-deep', 'app-node/inner-app', '.hidden-app', 'node_modules/dep'
    ]) {
      assert.ok(!rels.includes(excludedRel), '不应识别为子项目：' + excludedRel);
    }
    // 子项目按 relPath 排序
    assert.deepEqual(rels, rels.slice().sort((a, b) => a.localeCompare(b)));
    assert.equal(parent.fileCount >= 14, true, '父项目 fileCount 应包含子项目文件');

    const byRel = new Map(parent.children.map((child) => [child.relPath, child]));
    const appNode = byRel.get('app-node');
    assert.equal(appNode.id, 'parent--app-node');
    assert.equal(appNode.dir, 'app-node');
    assert.equal(appNode.parentId, 'parent');
    assert.equal(appNode.depth, 1);
    assert.deepEqual(appNode.children, []);
    assert.equal(appNode.kind, 'node');
    assert.equal(appNode.runnable, true);
    assert.equal(appNode.runKind, 'command');
    assert.equal(appNode.runHint, 'npm run dev');
    assert.equal(appNode.readmePath, null);
    assert.equal(appNode.summarySource, 'fallback');
    assert.equal(appNode.summary, FALLBACK_SUMMARY);
    assert.equal(appNode.path, path.join(parent.path, 'app-node'));
    assert.ok(Number.isInteger(appNode.fileCount) && appNode.fileCount >= 1);
    assert.equal(appNode.accent, ACCENTS[hashString(appNode.id) % ACCENTS.length]);

    const nested = byRel.get('container/nested-app');
    assert.equal(nested.id, 'parent--container-nested-app');
    assert.equal(nested.depth, 2);
    assert.equal(nested.dir, 'nested-app');
    assert.equal(nested.runHint, 'npm run start');

    const pyService = byRel.get('py-service');
    assert.equal(pyService.readmePath, 'README.md');
    assert.equal(pyService.summarySource, 'readme');
    assert.equal(pyService.name, 'py service');
    assert.equal(pyService.runHint, 'python3 server.py');

    const godotGame = byRel.get('godot-game');
    assert.equal(godotGame.kind, 'godot');
    assert.equal(godotGame.runKind, 'open');

    const scriptApp = byRel.get('script-app');
    assert.equal(scriptApp.runHint, './start.sh');

    const xcode = byRel.get('xcode/Foo.xcodeproj');
    assert.equal(xcode.id, 'parent--xcode-foo-xcodeproj');
    assert.equal(xcode.depth, 2);
    assert.equal(xcode.dir, 'Foo.xcodeproj');
    assert.equal(xcode.kind, 'unknown');

    // 子项目 id 全局唯一
    const ids = parent.children.map((child) => child.id);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspace：父项目自身的 .xcodeproj 不算子项目', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-scan-own-xcode-'));
  try {
    await writeFixture(root, 'own-xcode/README.md', '# 自有 Xcode 项目\n\n说明。\n');
    await writeFixture(root, 'own-xcode/own-xcode.xcodeproj/project.pbxproj', '// xcode');
    const result = await scanWorkspace({ root });
    const project = result.projects.find((item) => item.dir === 'own-xcode');
    assert.ok(project);
    assert.deepEqual(project.children, [], '父项目自己的 .xcodeproj 是它的工程文件，不是子项目');
    assert.equal(result.stats.subprojects, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspace：每个父项目最多 12 个子项目', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-scan-cap-parent-'));
  try {
    await writeFixture(root, 'cap-parent/README.md', '# 多子项目\n\n说明。\n');
    for (let i = 1; i <= 13; i += 1) {
      const name = 'app-' + String(i).padStart(2, '0');
      await writeFixture(root, 'cap-parent/' + name + '/package.json', pkgJson(name, { dev: 'vite' }));
    }
    const result = await scanWorkspace({ root });
    const parent = result.projects.find((item) => item.dir === 'cap-parent');
    assert.ok(parent);
    assert.equal(parent.children.length, 12);
    assert.equal(result.stats.subprojects, 12);
    assert.deepEqual(
      parent.children.map((child) => child.relPath),
      ['app-01', 'app-02', 'app-03', 'app-04', 'app-05', 'app-06', 'app-07', 'app-08', 'app-09', 'app-10', 'app-11', 'app-12']
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspace：全工作区最多 60 个子项目', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-scan-cap-total-'));
  try {
    for (let p = 1; p <= 6; p += 1) {
      const parent = 'parent-' + p;
      await writeFixture(root, parent + '/README.md', '# ' + parent + '\n\n说明。\n');
      for (let i = 1; i <= 11; i += 1) {
        const name = 'app-' + String(i).padStart(2, '0');
        await writeFixture(root, parent + '/' + name + '/package.json', pkgJson(name, { dev: 'vite' }));
      }
    }
    const result = await scanWorkspace({ root });
    assert.equal(result.stats.subprojects, 60);
    let total = 0;
    for (const project of result.projects) total += project.children.length;
    assert.equal(total, 60);
    // 按父目录名顺序分配配额：parent-1..parent-5 各 11 个，parent-6 只剩 5 个
    const byDir = new Map(result.projects.map((project) => [project.dir, project]));
    for (let p = 1; p <= 5; p += 1) assert.equal(byDir.get('parent-' + p).children.length, 11);
    assert.equal(byDir.get('parent-6').children.length, 5);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspace：子项目 id 冲突时加序号，保证全局唯一', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-scan-dup-id-'));
  try {
    await writeFixture(root, 'dup-parent/README.md', '# 重名子项目\n\n说明。\n');
    await writeFixture(root, 'dup-parent/a-b/package.json', pkgJson('a-b', { dev: 'vite' }));
    await writeFixture(root, 'dup-parent/a_b/package.json', pkgJson('a_b', { dev: 'vite' }));
    const result = await scanWorkspace({ root });
    const parent = result.projects.find((item) => item.dir === 'dup-parent');
    assert.ok(parent);
    assert.equal(parent.children.length, 2);
    const ids = parent.children.map((child) => child.id);
    assert.equal(new Set(ids).size, 2, '子项目 id 必须唯一');
    assert.ok(ids.includes('dup-parent--a-b'));
    assert.ok(ids.includes('dup-parent--a-b-2'));
    for (const child of parent.children) {
      assert.equal(child.parentId, 'dup-parent');
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 文档发现（临时目录夹具）
// ---------------------------------------------------------------------------

test('文档发现：没有 README 时使用根目录 CHANNELS.md 作为摘要来源', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-scan-doc-channels-'));
  try {
    await writeFixture(root, 'music-like/CHANNELS.md', '# 下载渠道说明 (CHANNELS)\n\n本文档记录渠道机制与实测流程。\n\n## 下一节\n\n不取这段。\n');
    await writeFixture(root, 'music-like/server.py', 'print(1)\n');
    const result = await scanWorkspace({ root });
    const project = result.projects.find((item) => item.dir === 'music-like');
    assert.ok(project);
    assert.equal(project.readmePath, 'CHANNELS.md');
    assert.equal(project.readmeTitle, '下载渠道说明 (CHANNELS)');
    assert.equal(project.summary, '本文档记录渠道机制与实测流程。');
    assert.equal(project.summarySource, 'readme');
    assert.equal(project.docAlias, null);
    assert.equal(project.llm, null);
    assert.equal(project.name, 'music-like', '非 README 文档的 H1 不能当项目名');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('文档发现：README 优先于其他文档', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-scan-doc-priority-'));
  try {
    await writeFixture(root, 'p/README.md', '# 真标题\n\nREADME 摘要。\n');
    await writeFixture(root, 'p/CHANNELS.md', '# 渠道\n\n渠道摘要。\n');
    await writeFixture(root, 'p/index.js', 'export {};\n');
    const result = await scanWorkspace({ root });
    const project = result.projects.find((item) => item.dir === 'p');
    assert.equal(project.readmePath, 'README.md');
    assert.equal(project.readmeTitle, '真标题');
    assert.equal(project.summary, 'README 摘要。');
    assert.equal(project.name, '真标题');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('文档发现：根目录其他 md 按相关度排序（INSTRUCTIONS 优先于 CHANGELOG）', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-scan-doc-rank-'));
  try {
    await writeFixture(root, 'q/INSTRUCTIONS.md', '# 使用说明\n\n这是使用说明摘要。\n');
    await writeFixture(root, 'q/CHANGELOG.md', '# 变更\n\n变更记录摘要。\n');
    await writeFixture(root, 'q/index.js', 'export {};\n');
    const result = await scanWorkspace({ root });
    const project = result.projects.find((item) => item.dir === 'q');
    assert.equal(project.readmePath, 'INSTRUCTIONS.md');
    assert.equal(project.summary, '这是使用说明摘要。');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('文档发现：LICENSE 等低相关文档不作为摘要来源', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-scan-doc-license-'));
  try {
    await writeFixture(root, 'r/LICENSE.md', '# License\n\nMIT 许可协议。\n');
    await writeFixture(root, 'r/index.js', 'export {};\n');
    const result = await scanWorkspace({ root });
    const project = result.projects.find((item) => item.dir === 'r');
    assert.equal(project.readmePath, null);
    assert.equal(project.summary, FALLBACK_SUMMARY);
    assert.equal(project.summarySource, 'fallback');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('文档发现：没有根目录文档时使用 docs 目录下前 3 个 md', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-scan-doc-docs-'));
  try {
    await writeFixture(root, 's/docs/architecture.md', '# 架构\n\n架构说明。\n');
    await writeFixture(root, 's/docs/guide.md', '# 指南\n\n指南说明。\n');
    await writeFixture(root, 's/index.js', 'export {};\n');
    const result = await scanWorkspace({ root });
    const project = result.projects.find((item) => item.dir === 's');
    assert.equal(project.readmePath, 'docs/architecture.md');
    assert.equal(project.summary, '架构说明。');
    assert.equal(project.summarySource, 'readme');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('文档发现：README 存在但没有有效段落时保留 readmePath 并用兜底摘要', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-scan-doc-empty-'));
  try {
    await writeFixture(root, 't/README.md', '# 只有标题\n');
    await writeFixture(root, 't/index.js', 'export {};\n');
    const result = await scanWorkspace({ root });
    const project = result.projects.find((item) => item.dir === 't');
    assert.equal(project.readmePath, 'README.md');
    assert.equal(project.summary, FALLBACK_SUMMARY);
    assert.equal(project.summarySource, 'fallback');
    assert.equal(project.readmeTitle, '只有标题');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

