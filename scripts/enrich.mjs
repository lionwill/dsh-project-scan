/**
 * scripts/enrich.mjs — 手动触发一次「扫描 + LLM 摘要 + README 归一化」。
 *
 * 用法：
 *   node scripts/enrich.mjs            # 只对已有索引做 LLM 富化
 *   node scripts/enrich.mjs --scan     # 先重新扫描工作区，再做 LLM 富化
 *   node scripts/enrich.mjs --scan --report   # 额外打印每个项目的摘要
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../server/store.js';
import { createLLM } from '../server/llm.js';
import { scanWorkspace } from '../server/scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.PROJECT_SCAN_DATA_DIR || path.join(APP_DIR, 'data'));
const WORKSPACE_ROOT = path.resolve(process.env.PROJECT_SCAN_ROOT || path.resolve(APP_DIR, '..'));
const args = new Set(process.argv.slice(2));

const store = createStore({ dataDir: DATA_DIR, root: WORKSPACE_ROOT });
store.load();

if (args.has('--scan')) {
  const startedAt = Date.now();
  const result = await scanWorkspace({ root: WORKSPACE_ROOT });
  const applied = store.applyScan(result.projects || [], result.stats || {});
  store.save();
  console.log('[enrich] 扫描完成：' + applied.projects.length + ' 个顶层项目，' +
    store.allProjects().length + ' 个项目（含子项目），耗时 ' + (Date.now() - startedAt) + 'ms');
}

const llm = createLLM({ dataDir: DATA_DIR, log: function (message) { console.log(message); } });
if (!llm.available) {
  console.log('[enrich] LLM 不可用（未配置 API key 或 PROJECT_SCAN_LLM=off），只保留启发式摘要。');
  process.exit(0);
}

const all = store.allProjects();
console.log('[enrich] 开始生成摘要：' + all.length + ' 个项目，模型 ' + llm.model);
const result = await llm.enrich(all);
const applied = store.applyEnrichment(result.patches);
store.save();
console.log('[enrich] 完成：更新 ' + applied + ' 个项目，请求 ' + result.stats.enriched +
  '，缓存 ' + result.stats.cached + '，失败 ' + result.stats.failed + '，耗时 ' + result.stats.durationMs + 'ms');

if (args.has('--report')) {
  for (const project of store.allProjects()) {
    const label = project.parentId ? project.parentId + ' / ' + project.relPath : project.id;
    console.log('\n[' + label + '] ' + project.name);
    console.log('  摘要：' + project.summary);
    console.log('  来源：' + (project.summarySource || 'unknown') +
      (project.docAlias ? '（复制 ' + project.docAlias.from + ' 为 README.md）' : '') +
      (project.readmePath ? '，文档 ' + project.readmePath : ''));
  }
}
