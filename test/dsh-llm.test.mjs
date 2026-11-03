import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDshLlm } from '../server/dsh-llm.js';

const SECRET = 'test-key-opencode-1234567890';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'project-scan-dsh-llm-'));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function patchYaml(options) {
  const opts = options || {};
  const provider = opts.provider || 'opencode-go';
  const model = opts.model || 'deepseek-v4.1-flash';
  const keyEnv = opts.keyEnv || 'OPENCODE_GO_API_KEY';
  const extraProvider = opts.extraProvider || '';
  const apiLine = opts.api ? '        api: ' + opts.api + '\n' : '';
  const baseLine = opts.baseURL ? '        baseURL: ' + opts.baseURL + '\n' : '';
  return [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      ' + provider + ':',
    '        apiKeyEnv: ' + keyEnv,
    apiLine + baseLine + extraProvider,
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: ' + provider,
    '    model: ' + model,
    '- id: ui-theme',
    '  name: "@deepseek-ai/dsh-client-ui-theme"',
    '  config:',
    '    preference: light',
    ''
  ].filter(function (line) { return line !== ''; }).join('\n');
}

function makeHome(options) {
  const opts = options || {};
  const home = tmpDir('project-scan-dsh-home-');
  write(path.join(home, 'profiles', opts.profile || 'web', 'cordis.patch.yml'), patchYaml(opts));
  if (opts.credentials !== false) {
    write(
      path.join(home, '.credentials.yaml'),
      ['version: 1', 'refs:', '  OPENCODE_GO_API_KEY: ' + SECRET, '  ACME_KEY: test-key-acme-123456', ''].join('\n')
    );
  }
  return home;
}

test('dsh-llm：读取 DSH 默认模型与渠道配置', function () {
  const home = makeHome();
  const dsh = createDshLlm({ dshHome: home, env: {}, profile: 'web' });
  const target = dsh.resolve();
  assert.equal(target.provider, 'opencode-go');
  assert.equal(target.model, 'deepseek-v4.1-flash');
  assert.equal(target.api, 'openai-completions');
  assert.equal(target.baseUrl, 'https://opencode.ai/inference/go/v1');
  assert.equal(target.apiKey, SECRET);
  assert.equal(target.keySource, 'dsh-credentials');
  assert.equal(target.opencode, true);
  assert.equal(target.profile, 'web');
  assert.ok(target.keyMasked);
  assert.ok(!target.keyMasked.includes('1234567890'), 'keyMasked 不能暴露完整 key');
});

test('dsh-llm：显式 baseURL / api / displayName 优先于内置默认值', function () {
  const home = makeHome({
    provider: 'acme-gateway',
    baseURL: 'https://acme.test/v1',
    api: 'openai-completions',
    keyEnv: 'ACME_KEY',
    model: 'acme-chat'
  });
  const dsh = createDshLlm({ dshHome: home, env: {} });
  const target = dsh.resolve();
  assert.equal(target.provider, 'acme-gateway');
  assert.equal(target.model, 'acme-chat');
  assert.equal(target.baseUrl, 'https://acme.test/v1');
  assert.equal(target.apiKey, 'test-key-acme-123456');
  assert.equal(target.opencode, false);
});

test('dsh-llm：key 缺失时从环境变量回退；DSH 不存在时返回 null', function () {
  const home = makeHome({ credentials: false });
  const fromEnv = createDshLlm({ dshHome: home, env: { OPENCODE_GO_API_KEY: SECRET }, profile: 'web' });
  assert.equal(fromEnv.resolve().apiKey, SECRET);
  assert.equal(fromEnv.resolve().keySource, 'env');

  const emptyHome = tmpDir('project-scan-dsh-llm-empty-');
  const missing = createDshLlm({ dshHome: emptyHome, env: {} });
  assert.equal(missing.resolve(), null);

  const noDefault = tmpDir('project-scan-dsh-llm-nodefault-');
  write(path.join(noDefault, 'profiles', 'web', 'cordis.patch.yml'), '- id: ui-theme\n  config:\n    preference: light\n');
  assert.equal(createDshLlm({ dshHome: noDefault, env: {} }).resolve(), null);
});

test('dsh-llm：非 OpenAI 兼容渠道被忽略；缺 key 渠道列出但不可解析', function () {
  const home = makeHome({ api: 'anthropic-messages' });
  assert.equal(createDshLlm({ dshHome: home, env: {} }).resolve(), null, '非 OpenAI 兼容渠道不参与默认解析');
  assert.deepEqual(createDshLlm({ dshHome: home, env: {} }).listChannels().channels, []);

  const noKeyHome = makeHome({ credentials: false, keyEnv: 'MISSING_KEY' });
  assert.throws(
    function () { createDshLlm({ dshHome: noKeyHome, env: {} }).resolve(); },
    function (err) {
      assert.equal(err.code, 'KEY_MISSING');
      return true;
    }
  );
});

test('dsh-llm：列出渠道与模型（先渠道后模型），不含完整 key', function () {
  const home = makeHome({
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    extraProvider: [
      '        modelOverrides:',
      '          deepseek-v4.1-flash:',
      '            name: "DeepSeek V4.1 Flash ×0.125"',
      '          glm-5.3:',
      '            name: "GLM-5.3 ×0.667"'
    ].join('\n')
  });
  const dsh = createDshLlm({ dshHome: home, env: {}, profile: 'web' });
  const listed = dsh.listChannels();
  assert.equal(listed.dsh.found, true);
  assert.equal(listed.defaultProvider, 'opencode-go');
  assert.equal(listed.defaultModel, 'deepseek-v4.1-flash');
  assert.equal(listed.channels.length, 1);
  const channel = listed.channels[0];
  assert.equal(channel.id, 'opencode-go');
  assert.equal(channel.api, 'openai-completions');
  assert.equal(channel.keyConfigured, true);
  assert.deepEqual(channel.models.map(function (m) { return m.id; }), ['deepseek-v4.1-flash', 'glm-5.3']);
  assert.equal(channel.models[0].name, 'DeepSeek V4.1 Flash ×0.125');
  assert.equal(channel.defaultModel, 'deepseek-v4.1-flash');
  assert.ok(!JSON.stringify(listed).includes(SECRET), '渠道列表不得包含完整 key');
});

test('dsh-llm：按用户选择解析渠道+模型，错误码齐全', function () {
  const home = makeHome({
    provider: 'opencode-go',
    extraProvider: [
      '        modelOverrides:',
      '          deepseek-v4.1-flash:',
      '            name: "DeepSeek V4.1 Flash"',
      '          glm-5.3:',
      '            name: "GLM-5.3"'
    ].join('\n')
  });
  const dsh = createDshLlm({ dshHome: home, env: {} });
  const target = dsh.resolveSelection({ provider: 'opencode-go', model: 'glm-5.3' });
  assert.equal(target.provider, 'opencode-go');
  assert.equal(target.model, 'glm-5.3');
  assert.equal(target.baseUrl, 'https://opencode.ai/inference/go/v1');
  assert.equal(target.apiKey, SECRET);
  assert.equal(target.opencode, true);

  assert.throws(function () { dsh.resolveSelection({ provider: 'nope', model: 'm' }); }, /找不到渠道/);
  assert.throws(function () { dsh.resolveSelection({ provider: 'opencode-go', model: 'nope' }); }, /没有模型/);
  assert.throws(function () { dsh.resolveSelection({ provider: '', model: '' }); }, /需要 provider 与 model/);

  const described = dsh.describeSelection({ provider: 'opencode-go', model: 'glm-5.3' });
  assert.equal(described.source, 'custom');
  assert.equal(described.channelName, 'OpenCode Go');
  assert.equal(described.keyConfigured, true);
  assert.ok(described.keyMasked);
  assert.ok(!JSON.stringify(described).includes(SECRET));
});

test('dsh-llm：多 profile 时优先 DSH_PROFILE / 指定 profile', function () {
  const home = tmpDir('project-scan-dsh-llm-multi-');
  write(path.join(home, 'profiles', 'cli', 'cordis.patch.yml'), patchYaml({ profile: 'cli', model: 'deepseek-flash' }));
  write(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), patchYaml({ profile: 'web', model: 'deepseek-v4-pro' }));
  write(path.join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  OPENCODE_GO_API_KEY: ' + SECRET + '\n');

  const byEnv = createDshLlm({ dshHome: home, env: { DSH_PROFILE: 'web' } });
  assert.equal(byEnv.resolve().model, 'deepseek-v4-pro');

  const byOption = createDshLlm({ dshHome: home, env: {}, profile: 'cli' });
  assert.equal(byOption.resolve().model, 'deepseek-flash');

  const auto = createDshLlm({ dshHome: home, env: {} });
  assert.equal(auto.resolve().profile, 'cli', '未指定 profile 时按名称排序取第一个');
});
