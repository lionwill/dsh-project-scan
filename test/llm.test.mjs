import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLLM } from '../server/llm.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'project-scan-llm-'));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeProject(root, options) {
  const opts = options || {};
  const dir = path.join(root, opts.dir || 'demo-project');
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, 'server.py'), 'print("demo")\n');
  if (opts.readme) write(path.join(dir, 'README.md'), opts.readme);
  if (opts.channels) write(path.join(dir, 'CHANNELS.md'), opts.channels);
  if (opts.extraMd) write(path.join(dir, opts.extraMd.name), opts.extraMd.content);
  return {
    id: opts.id || 'demo-project',
    dir: opts.dir || 'demo-project',
    name: opts.name || 'Demo Project',
    path: dir,
    relPath: '',
    depth: 0,
    updatedAt: opts.updatedAt || '2026-10-01T00:00:00.000Z',
    fileCount: 2,
    kind: 'python',
    tags: ['Python'],
    readmePath: opts.readme ? 'README.md' : null,
    children: []
  };
}

function fakeResponse(content) {
  return {
    ok: true,
    status: 200,
    json: async function () {
      return { choices: [{ message: { content: content } }] };
    },
    text: async function () { return ''; }
  };
}

test('llm: 无可用 key 时优雅降级', async function () {
  const dataDir = tmpDir();
  const project = makeProject(tmpDir(), { channels: '# 频道说明\n\n这个项目用于批量下载音乐并整理频道。\n' });
  const previous = process.env.PROJECT_SCAN_LLM;
  process.env.PROJECT_SCAN_LLM = 'off';
  try {
    const llm = createLLM({ dataDir: dataDir, apiKey: '', fetchImpl: async function () { throw new Error('不应该请求'); } });
    assert.equal(llm.available, false);
    assert.equal(llm.status().enabled, false);
    const result = await llm.enrich([project]);
    assert.equal(result.patches.size, 0);
    assert.equal(result.stats.enriched, 0);
  } finally {
    if (previous === undefined) delete process.env.PROJECT_SCAN_LLM;
    else process.env.PROJECT_SCAN_LLM = previous;
  }
});

test('llm: 读取非 README 文档、生成摘要、复制 README 并缓存', async function () {
  const dataDir = tmpDir();
  const root = tmpDir();
  const channelsText = '# 音乐频道说明\n\n这个项目用于从多个音乐频道批量抓取歌曲并下载到本地，支持频道筛选和断点续传。\n';
  const project = makeProject(root, { channels: channelsText });
  let calls = 0;
  const fetchImpl = async function (url, init) {
    calls += 1;
    assert.match(url, /\/chat\/completions$/);
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'deepseek-flash');
    const userPayload = JSON.parse(body.messages[1].content);
    assert.ok(userPayload.docs.some(function (doc) { return doc.name === 'CHANNELS.md'; }), '应把 CHANNELS.md 作为候选文档');
    return fakeResponse(JSON.stringify({
      name: '音乐下载器',
      summary: '从多个音乐频道批量抓取歌曲并下载到本地的工具，支持频道筛选与断点续传。',
      readmeDoc: 'CHANNELS.md',
      tags: ['Python', '爬虫', '下载器'],
      confidence: 0.92
    }));
  };
  const llm = createLLM({ dataDir: dataDir, apiKey: 'test-key', baseUrl: 'http://fake.local/v1', fetchImpl: fetchImpl });
  assert.equal(llm.available, true);

  const result = await llm.enrich([project]);
  const patch = result.patches.get('demo-project');
  assert.ok(patch);
  assert.match(patch.summary, /音乐频道/);
  assert.equal(patch.summarySource, 'llm');
  assert.equal(patch.readmePath, 'README.md');
  assert.equal(patch.docAlias.from, 'CHANNELS.md');
  assert.equal(patch.llm.model, 'deepseek-flash');
  assert.deepEqual(patch.tags, ['Python', '爬虫', '下载器']);
  assert.equal(patch.name, '音乐下载器');
  const copied = fs.readFileSync(path.join(project.path, 'README.md'), 'utf8');
  assert.match(copied, /^# 音乐下载器/);
  assert.match(copied, /音乐频道/);
  assert.equal(calls, 1);

  // 同一项目内容未变：走缓存，不再请求
  const again = await llm.enrich([project]);
  assert.equal(calls, 1);
  assert.equal(again.stats.cached, 1);
  assert.equal(again.patches.get('demo-project').summarySource, 'llm');
  assert.equal(again.patches.get('demo-project').llm.cached, true);
});

test('llm: 已有 README 时绝不覆盖，也不复制', async function () {
  const dataDir = tmpDir();
  const root = tmpDir();
  const readmeText = '# 原有说明\n\n这是项目自带的 README，不能被覆盖。\n';
  const project = makeProject(root, { readme: readmeText, channels: '# 频道说明\n\n另一个文档。\n' });
  const llm = createLLM({
    dataDir: dataDir,
    apiKey: 'test-key',
    fetchImpl: async function () {
      return fakeResponse(JSON.stringify({
        summary: '一个示例项目，用于验证已有 README 不会被覆盖的行为。',
        readmeDoc: 'CHANNELS.md',
        tags: ['Python'],
        confidence: 0.8
      }));
    }
  });
  const result = await llm.enrich([project]);
  const patch = result.patches.get('demo-project');
  // 已有 README 时，候选文档只有 README，CHANNELS.md 不在候选里，因此不会复制也不会改 readmePath
  assert.equal(patch.docAlias, undefined);
  assert.equal(patch.readmePath, undefined);
  assert.equal(fs.readFileSync(path.join(project.path, 'README.md'), 'utf8'), readmeText);
  assert.equal(fs.existsSync(path.join(project.path, 'CHANNELS.md')), true);
});

test('llm: readmeDoc 不在候选文档中时忽略，不复制', async function () {
  const dataDir = tmpDir();
  const root = tmpDir();
  const project = makeProject(root, { channels: '# 频道说明\n\n说明文档内容。\n' });
  const llm = createLLM({
    dataDir: dataDir,
    apiKey: 'test-key',
    fetchImpl: async function () {
      return fakeResponse(JSON.stringify({
        summary: '一个示例项目，用于验证非法文档名会被忽略，不会复制任何文件。',
        readmeDoc: 'NOT-EXIST.md',
        tags: ['Python'],
        confidence: 0.5
      }));
    }
  });
  const result = await llm.enrich([project]);
  const patch = result.patches.get('demo-project');
  assert.equal(patch.docAlias, undefined);
  assert.equal(patch.readmePath, undefined);
  assert.equal(fs.existsSync(path.join(project.path, 'README.md')), false);
});

test('llm: 接口失败与非法 JSON 不抛异常，记录失败数', async function () {
  const dataDir = tmpDir();
  const root = tmpDir();
  const project = makeProject(root, { channels: '# 说明\n\n内容足够长的一段项目说明文字。\n' });
  let calls = 0;
  const llm = createLLM({
    dataDir: dataDir,
    apiKey: 'test-key',
    fetchImpl: async function () {
      calls += 1;
      return { ok: false, status: 401, text: async function () { return 'unauthorized'; }, json: async function () { return {}; } };
    }
  });
  const result = await llm.enrich([project]);
  assert.equal(result.patches.size, 0);
  assert.equal(result.stats.failed, 1);
  assert.equal(calls, 1);
  assert.equal(llm.status().failed, 1);
});

test('llm: 已复制 README 会修正一级标题，避免项目名变成文档标题', async function () {
  const dataDir = tmpDir();
  const root = tmpDir();
  const project = makeProject(root, { readme: '# 下载渠道说明 (CHANNELS)\n\n项目说明内容足够长，用于验证标题修正行为。\n' });
  project.docAlias = { from: 'CHANNELS.md', copied: true, copiedAt: '2026-10-29T00:00:00.000Z' };
  project.readmePath = 'README.md';
  const llm = createLLM({
    dataDir: dataDir,
    apiKey: 'test-key',
    fetchImpl: async function () {
      return fakeResponse(JSON.stringify({
        name: '音乐下载器',
        summary: '一个面向个人的音乐批量下载工具，支持多渠道搜索并保存到本地目录。',
        readmeDoc: 'README.md',
        tags: ['Python'],
        confidence: 0.9
      }));
    }
  });
  const result = await llm.enrich([project]);
  assert.equal(result.patches.get('demo-project').name, '音乐下载器');
  const readme = fs.readFileSync(path.join(project.path, 'README.md'), 'utf8');
  assert.match(readme, /^# 音乐下载器/);
  assert.match(readme, /项目说明内容足够长/);
});

test('llm: collectDocs 优先 README，其次根目录相关 md', async function () {
  const dataDir = tmpDir();
  const root = tmpDir();
  const project = makeProject(root, { channels: '# 频道说明\n\n频道下载说明。\n' });
  const llm = createLLM({ dataDir: dataDir, apiKey: 'test-key', fetchImpl: async function () { throw new Error('不应该请求'); } });
  const docs = await llm.collectDocs(project);
  assert.ok(docs.length >= 1);
  assert.equal(docs[0].name, 'CHANNELS.md');
  assert.equal(llm.hasReadme(project.path), false);
});

test('llm：无显式 key 时复用 DSH 默认 LLM（含 opencode 会话头）', async function () {
  const dataDir = tmpDir();
  const project = makeProject(tmpDir(), { readme: '# DSH 复用\n\n验证默认复用 DSH 的 LLM。\n' });
  const calls = [];
  const dshLlm = {
    resolve: function () {
      return {
        provider: 'opencode-go',
        model: 'deepseek-v4.1-flash',
        api: 'openai-completions',
        baseUrl: 'https://opencode.test/v1',
        apiKey: 'dsh-test-key-abcdef',
        keyMasked: 'dsh-…cdef',
        keySource: 'dsh-credentials',
        opencode: true
      };
    }
  };
  const llm = createLLM({
    dataDir: dataDir,
    dshLlm: dshLlm,
    fetchImpl: async function (url, init) {
      calls.push({ url: url, init: init });
      return fakeResponse(JSON.stringify({
        name: 'DSH 项目',
        summary: '通过 DSH 默认渠道生成摘要的示例项目。',
        readmeDoc: null,
        tags: ['测试'],
        confidence: 0.8
      }));
    }
  });
  assert.equal(llm.available, true);
  assert.equal(llm.model, 'deepseek-v4.1-flash');
  const status = llm.status();
  assert.equal(status.source, 'dsh');
  assert.equal(status.provider, 'opencode-go');
  assert.ok(!JSON.stringify(status).includes('dsh-test-key-abcdef'));

  const result = await llm.enrich([project]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://opencode.test/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer dsh-test-key-abcdef');
  assert.ok(calls[0].init.headers['x-opencode-session'], 'opencode 渠道应带会话头');
  assert.equal(JSON.parse(calls[0].init.body).model, 'deepseek-v4.1-flash');
  assert.equal(result.patches.get('demo-project').summarySource, 'llm');
});

test('llm：PROJECT_SCAN_LLM=off 时即使 DSH 可用也关闭摘要', async function () {
  const dataDir = tmpDir();
  const previous = process.env.PROJECT_SCAN_LLM;
  process.env.PROJECT_SCAN_LLM = 'off';
  let resolved = false;
  try {
    const llm = createLLM({
      dataDir: dataDir,
      dshLlm: {
        resolve: function () {
          resolved = true;
          return { provider: 'opencode-go', model: 'm', api: 'openai-completions', baseUrl: 'https://x.test/v1', apiKey: 'k', opencode: false };
        }
      },
      fetchImpl: async function () { throw new Error('不应请求'); }
    });
    assert.equal(llm.available, false);
    const result = await llm.enrich([makeProject(tmpDir(), { readme: '# x\n\n关闭摘要验证。\n' })]);
    assert.equal(result.patches.size, 0);
    assert.equal(resolved, false, '关闭时不应读取 DSH 配置');
  } finally {
    if (previous === undefined) delete process.env.PROJECT_SCAN_LLM;
    else process.env.PROJECT_SCAN_LLM = previous;
  }
});

/* ------------------------------------------------------------------ */
/* 设置里选择的 DSH 渠道 + 模型                                        */
/* ------------------------------------------------------------------ */

function fakeDshLlm(targets) {
  return {
    resolve: function () {
      return targets.default || null;
    },
    resolveSelection: function (selection) {
      const target = targets[selection.provider + '/' + selection.model];
      if (!target) {
        const error = new Error('渠道「' + selection.provider + '」没有模型 ' + selection.model);
        error.code = 'MODEL_NOT_FOUND';
        throw error;
      }
      return target;
    }
  };
}

test('llm：使用设置里选择的渠道与模型（不缓存 token，key 来自环境/凭据）', async function () {
  const dataDir = tmpDir();
  const project = makeProject(tmpDir(), { readme: '# 选择渠道\n\n验证设置里选择渠道+模型后按该模型请求。\n' });
  const calls = [];
  let selection = { provider: 'opencode-go', model: 'glm-5.3' };
  const dshLlm = fakeDshLlm({
    default: { provider: 'opencode-go', providerName: 'OpenCode Go', model: 'deepseek-v4.1-flash', api: 'openai-completions', baseUrl: 'https://opencode.test/v1', apiKey: 'key-default-111', keyMasked: 'key-…111', opencode: true },
    'opencode-go/glm-5.3': { provider: 'opencode-go', providerName: 'OpenCode Go', model: 'glm-5.3', api: 'openai-completions', baseUrl: 'https://opencode.test/v1', apiKey: 'key-glm-222', keyMasked: 'key-…222', opencode: true }
  });
  const llm = createLLM({
    dataDir: dataDir,
    dshLlm: dshLlm,
    getSelection: function () { return selection; },
    fetchImpl: async function (url, init) {
      calls.push({ url: url, init: init });
      return fakeResponse(JSON.stringify({
        name: '选择渠道',
        summary: '使用设置中选择的渠道与模型生成摘要的示例项目。',
        readmeDoc: null,
        tags: ['测试'],
        confidence: 0.8
      }));
    }
  });
  assert.equal(llm.available, true);
  const info = llm.status();
  assert.equal(info.source, 'selection');
  assert.equal(info.model, 'glm-5.3');
  assert.equal(info.channelName, 'OpenCode Go');
  assert.ok(!JSON.stringify(info).includes('key-glm-222'));

  const first = await llm.enrich([project]);
  assert.equal(first.patches.get('demo-project').llm.model, 'glm-5.3');
  assert.equal(JSON.parse(calls[0].init.body).model, 'glm-5.3');

  // 设置里改成默认模型：refreshConfig 后按新模型重新请求（缓存指纹含模型）
  selection = null;
  llm.refreshConfig();
  assert.equal(llm.status().source, 'dsh');
  assert.equal(llm.status().model, 'deepseek-v4.1-flash');
  const second = await llm.enrich([project]);
  assert.equal(second.patches.get('demo-project').llm.model, 'deepseek-v4.1-flash');
  assert.equal(JSON.parse(calls[1].init.body).model, 'deepseek-v4.1-flash');
  assert.equal(calls.length, 2);
});

test('llm：选择的渠道不可用时不静默回退默认渠道', async function () {
  const dataDir = tmpDir();
  let calls = 0;
  const llm = createLLM({
    dataDir: dataDir,
    dshLlm: fakeDshLlm({
      default: { provider: 'opencode-go', providerName: 'OpenCode Go', model: 'deepseek-v4.1-flash', api: 'openai-completions', baseUrl: 'https://opencode.test/v1', apiKey: 'key-default-111', opencode: true }
    }),
    getSelection: function () { return { provider: 'gone', model: 'gone-model' }; },
    fetchImpl: async function () { calls += 1; throw new Error('不应请求'); }
  });
  const status = llm.status();
  assert.equal(status.enabled, false);
  assert.equal(status.source, 'selection');
  assert.match(status.error, /没有模型|找不到渠道/);
  const result = await llm.enrich([makeProject(tmpDir(), { readme: '# x\n\n渠道不可用验证。\n' })]);
  assert.equal(calls, 0);
  assert.equal(result.patches.size, 0);
});
