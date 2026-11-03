import test from 'node:test';
import assert from 'node:assert/strict';

import { createMonitor } from '../server/monitor.js';

const HOUR_MS = 3600 * 1000;
const BASE_NOW = 1700000000000;

// ps -axo pid=,ppid=,time=,rss= 的典型输出（无表头，rss 单位 KB）
const PS_BASE = [
  '  100     1   0:10.00  10240',
  '  101   100   0:05.00  20480',
  '  102   100   0:02.00   5120',
  '  999     1   0:01.00   4096'
].join('\n');

const RUNNING_P1 = [{ projectId: 'p1', pid: 100, status: 'running' }];

function cpuSample(user, sys, idle) {
  return [{ times: { user: user, nice: 0, sys: sys, idle: idle, irq: 0 } }];
}

/** 可注入的假 run：记录调用并按 handler 返回/抛错；未提供 handler 的命令返回空输出。 */
function makeRun(handlers) {
  const calls = [];
  async function run(command, args, options) {
    calls.push({ command: command, args: args, options: options });
    const handler = handlers[command];
    if (typeof handler !== 'function') return { stdout: '' };
    return handler(args, calls);
  }
  run.calls = calls;
  run.count = function (command) {
    return calls.filter(function (call) { return call.command === command; }).length;
  };
  return run;
}

function setup(options) {
  const config = options || {};
  const handlers = Object.assign({
    ps: function () { return { stdout: PS_BASE }; },
    ioreg: function () { return { stdout: '' }; },
    vm_stat: function () { return { stdout: '' }; },
    nettop: function () { return { stdout: ',bytes_in,bytes_out,\n' }; },
    pgrep: function () { return { stdout: '' }; }
  }, config.handlers || {});

  const run = makeRun(handlers);
  const state = { nowMs: config.nowMs == null ? BASE_NOW : config.nowMs };
  let running = config.running || [];
  let cpus = config.cpus || cpuSample(100, 100, 800);

  const monitor = createMonitor({
    intervalMs: HOUR_MS,
    gpuIntervalMs: config.gpuIntervalMs || 2000,
    memoryIntervalMs: config.memoryIntervalMs || 5000,
    treeIntervalMs: config.treeIntervalMs || 2000,
    now: function () { return state.nowMs; },
    cpus: function () { return cpus; },
    run: run
  });
  monitor.start(function () { return running; });
  if (config.enabled !== false) monitor.setEnabled(true);

  return {
    monitor: monitor,
    run: run,
    state: state,
    advance: function (ms) { state.nowMs += ms; },
    setRunning: function (list) { running = list; },
    setCpus: function (list) { cpus = list; }
  };
}

/* ------------------------------------------------------------------ */
/* 开关与「不 spawn」保证                                              */
/* ------------------------------------------------------------------ */

test('默认关闭：不采样、不 spawn 任何命令、项目指标为空', async function () {
  const h = setup({ enabled: false, running: RUNNING_P1 });

  const before = h.monitor.snapshot();
  assert.equal(before.enabled, false);
  assert.equal(before.sampling, false);
  assert.deepEqual(before.projects, []);
  assert.equal(h.monitor.isEnabled(), false);

  const snap = await h.monitor.sampleOnce();
  assert.equal(h.run.calls.length, 0);
  assert.equal(snap.enabled, false);
  assert.deepEqual(snap.projects, []);
  assert.equal(snap.overhead.ticks, 0);
  assert.equal(snap.overhead.commandCalls, 0);

  h.monitor.stop();
});

test('开启但没有运行中项目：跳过整轮采样，不 spawn 任何命令', async function () {
  const h = setup({ running: [] });

  const snap = await h.monitor.sampleOnce();
  assert.equal(h.run.calls.length, 0);
  assert.deepEqual(snap.projects, []);
  assert.equal(snap.sampling, true);
  assert.equal(snap.overhead.ticks, 1);
  assert.equal(snap.overhead.commandCalls, 0);
  assert.equal(snap.overhead.nettopRunning, false);

  // 已退出 / 非 running 状态的项目同样不算运行中
  h.setRunning([{ projectId: 'p1', pid: 100, status: 'exited' }]);
  await h.monitor.sampleOnce();
  assert.equal(h.run.calls.length, 0);
  assert.deepEqual(h.monitor.snapshot().projects, []);

  h.monitor.stop();
});

/* ------------------------------------------------------------------ */
/* ps 可用：进程树 CPU / 内存                                          */
/* ------------------------------------------------------------------ */

test('ps 可用：进程树 CPU 时间差分与 RSS 求和，首帧 cpuPercent=null', async function () {
  let psText = PS_BASE;
  const h = setup({
    running: RUNNING_P1,
    handlers: { ps: function () { return { stdout: psText }; } }
  });

  const first = await h.monitor.sampleOnce();
  assert.equal(first.supported.cpu, true);
  assert.equal(first.supported.gpuPerProcess, false);

  const row1 = first.projects[0];
  assert.equal(row1.projectId, 'p1');
  assert.equal(row1.pid, 100);
  assert.equal(row1.processCount, 3); // 100 + 101 + 102，999 不属于该树
  assert.equal(row1.cpuPercent, null); // 首帧没有 CPU 时间基线
  assert.equal(row1.memoryBytes, (10240 + 20480 + 5120) * 1024);
  assert.equal(row1.gpuPercent, null);

  h.advance(1000);
  psText = [
    '  100     1   0:11.00  11264',
    '  101   100   0:07.00  24576',
    '  102   100   0:02.00   6144',
    '  999     1   0:09.00   4096'
  ].join('\n');

  const second = await h.monitor.sampleOnce();
  const row2 = second.projects[0];
  // 树内 CPU 时间增量：1s + 2s + 0s = 3s，实际 elapsed 1s → 300%
  assert.equal(row2.cpuPercent, 300);
  assert.equal(row2.memoryBytes, (11264 + 24576 + 6144) * 1024);
  assert.equal(second.projects.length, 1);
  assert.equal(h.run.count('pgrep'), 0); // ps 可用时不走 pgrep

  h.monitor.stop();
});

test('ps 被禁止（EPERM）：降级 supported.cpu=false，用 pgrep 递归拿进程数并缓存 2 秒', async function () {
  const childrenOf = { 100: [101, 102], 101: [103] };
  const h = setup({
    running: RUNNING_P1,
    handlers: {
      ps: function () {
        const err = new Error('spawn ps EPERM');
        err.code = 'EPERM';
        throw err;
      },
      pgrep: function (args) {
        const parent = Number(args[1]);
        const children = childrenOf[parent];
        if (!children) {
          const err = new Error('exit 1');
          err.code = 1;
          throw err; // 无子进程时 pgrep 退出码 1
        }
        return { stdout: children.join('\n') + '\n' };
      }
    }
  });

  const first = await h.monitor.sampleOnce();
  assert.equal(first.supported.cpu, false);
  assert.equal(first.supported.gpuPerProcess, false);
  const row = first.projects[0];
  assert.equal(row.cpuPercent, null);
  assert.equal(row.memoryBytes, null);
  assert.equal(row.processCount, 4); // 100 + 101 + 102 + 103
  assert.equal(h.run.count('ps'), 1);

  const pgrepAfterFirst = h.run.count('pgrep');
  assert.equal(pgrepAfterFirst, 4); // 100 一层、101/102 一层、103 一层

  // 1 秒后再采样：进程树缓存 2 秒内不刷新 → 不再调用 pgrep；ps 也不再重试
  h.advance(1000);
  const second = await h.monitor.sampleOnce();
  assert.equal(second.projects[0].processCount, 4);
  assert.equal(second.projects[0].cpuPercent, null);
  assert.equal(h.run.count('pgrep'), pgrepAfterFirst);
  assert.equal(h.run.count('ps'), 1);

  // 超过 2 秒后刷新树缓存
  h.advance(1500);
  await h.monitor.sampleOnce();
  assert.equal(h.run.count('pgrep'), pgrepAfterFirst * 2);

  h.monitor.stop();
});

test('ps 输出为空视为不可用并降级，不抛异常', async function () {
  const h = setup({
    running: RUNNING_P1,
    handlers: { ps: function () { return { stdout: '' }; } }
  });

  const snap = await h.monitor.sampleOnce();
  assert.equal(snap.supported.cpu, false);
  assert.equal(snap.projects[0].cpuPercent, null);
  assert.equal(snap.projects[0].memoryBytes, null);
  assert.equal(snap.projects[0].processCount, 1);

  h.monitor.stop();
});

test('provider 抛错时采样不崩溃', async function () {
  const h = setup({ running: [] });
  h.monitor.start(function () { throw new Error('provider boom'); });

  const snap = await h.monitor.sampleOnce();
  assert.deepEqual(snap.projects, []);
  assert.equal(h.run.calls.length, 0);

  h.monitor.stop();
});

/* ------------------------------------------------------------------ */
/* GPU / 系统内存                                                      */
/* ------------------------------------------------------------------ */

test('ioreg GPU：取 Device Utilization % 最大值，按 gpuIntervalMs 节流', async function () {
  const gpuHigh = [
    '"PerformanceStatistics" = {"Device Utilization %"=12,"Tiler Utilization %"=88}',
    '"PerformanceStatistics" = {"Device Utilization %"=67}'
  ].join('\n');
  const gpuLow = '"PerformanceStatistics" = {"Device Utilization %"=15}';
  let ioregSeq = 0;

  const h = setup({
    running: RUNNING_P1,
    handlers: {
      ioreg: function () {
        ioregSeq += 1;
        return { stdout: ioregSeq === 1 ? gpuHigh : gpuLow };
      }
    }
  });

  const s1 = await h.monitor.sampleOnce();
  assert.equal(s1.system.gpuPercent, 67);
  assert.equal(s1.projects[0].gpuPercent, null); // 无法按进程统计 GPU
  assert.equal(h.run.count('ioreg'), 1);

  h.advance(1000);
  const s2 = await h.monitor.sampleOnce();
  assert.equal(h.run.count('ioreg'), 1); // 未满 2 秒，不重复采样
  assert.equal(s2.system.gpuPercent, 67);

  h.advance(1000);
  const s3 = await h.monitor.sampleOnce();
  assert.equal(h.run.count('ioreg'), 2);
  assert.equal(s3.system.gpuPercent, 15);

  h.monitor.stop();
});

test('ioreg 失败：system.gpuPercent 降级为 null，不抛异常', async function () {
  const h = setup({
    running: RUNNING_P1,
    handlers: {
      ioreg: function () {
        const err = new Error('spawn ioreg EPERM');
        err.code = 'EPERM';
        throw err;
      }
    }
  });

  const snap = await h.monitor.sampleOnce();
  assert.equal(snap.system.gpuPercent, null);
  assert.equal(snap.projects.length, 1);

  h.monitor.stop();
});

test('vm_stat：解析已用内存（active+wired+compressor），按 memoryIntervalMs 节流', async function () {
  const vmOut = function (active, wired, compressor) {
    return [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                                     4812.',
      'Pages active:                                 ' + active + '.',
      'Pages inactive:                               215962.',
      'Pages wired down:                             ' + wired + '.',
      'Pages occupied by compressor:                 ' + compressor + '.'
    ].join('\n');
  };
  let vmSeq = 0;
  const h = setup({
    running: RUNNING_P1,
    handlers: {
      vm_stat: function () {
        vmSeq += 1;
        return { stdout: vmSeq === 1 ? vmOut(216874, 229857, 50000) : vmOut(100000, 100000, 10000) };
      }
    }
  });

  const s1 = await h.monitor.sampleOnce();
  assert.equal(s1.system.memoryUsedBytes, (216874 + 229857 + 50000) * 16384);
  assert.equal(h.run.count('vm_stat'), 1);

  h.advance(1000);
  await h.monitor.sampleOnce();
  assert.equal(h.run.count('vm_stat'), 1); // 5 秒节流内不重复

  h.advance(4000);
  const s3 = await h.monitor.sampleOnce();
  assert.equal(h.run.count('vm_stat'), 2);
  assert.equal(s3.system.memoryUsedBytes, (100000 + 100000 + 10000) * 16384);

  h.monitor.stop();
});

test('vm_stat 解析失败时 memoryUsedBytes 为 null', async function () {
  const h = setup({
    running: RUNNING_P1,
    handlers: { vm_stat: function () { return { stdout: 'garbage output' }; } }
  });
  const snap = await h.monitor.sampleOnce();
  assert.equal(snap.system.memoryUsedBytes, null);
  h.monitor.stop();
});

/* ------------------------------------------------------------------ */
/* 网络：每轮单次 nettop + 累计值差分                                   */
/* ------------------------------------------------------------------ */

test('nettop：每轮单次 -L 1 采样，累计值按实际 elapsed 差分并按进程树归属', async function () {
  // pid 100 是项目根进程；101 是其子进程；999 不在进程树内
  const snapshots = [
    ',bytes_in,bytes_out,\n' +
      'node.100,10000,20000,\n' +
      'node.101,3000,4000,\n' +
      'chrome.999,500000,900000,\n',
    ',bytes_in,bytes_out,\n' +
      'node.100,13000,24000,\n' +   // +3000 rx / +4000 tx
      'node.101,3000,5000,\n' +     // +0 rx / +1000 tx
      'chrome.999,500500,900900,\n',
    ',bytes_in,bytes_out,\n' +
      'node.100,14500,27000,\n' +   // 相对上一轮 +1500 rx / +3000 tx
      'node.101,3000,5000,\n'
  ];
  let seq = 0;
  const h = setup({
    running: RUNNING_P1,
    handlers: {
      nettop: function () {
        const output = snapshots[Math.min(seq, snapshots.length - 1)];
        seq += 1;
        return { stdout: output };
      }
    }
  });

  const s1 = await h.monitor.sampleOnce();
  assert.equal(s1.supported.network, true);
  assert.equal(s1.overhead.nettopRunning, true);
  assert.equal(s1.projects[0].netRxBytesPerSec, 0); // 首轮只建立基线
  assert.equal(s1.projects[0].netTxBytesPerSec, 0);

  h.advance(1000);
  const s2 = await h.monitor.sampleOnce();
  const row2 = s2.projects[0];
  // (pid100 +3000,+4000) + (pid101 +0,+1000)，elapsed 1000ms → 3000 / 5000 B/s
  assert.equal(row2.netRxBytesPerSec, 3000);
  assert.equal(row2.netTxBytesPerSec, 5000);

  h.advance(500);
  const s3 = await h.monitor.sampleOnce();
  const row3 = s3.projects[0];
  // +1500 rx / +3000 tx，elapsed 500ms → 3000 / 6000 B/s（证明用的是实际 elapsed 不是固定 1s）
  assert.equal(row3.netRxBytesPerSec, 3000);
  assert.equal(row3.netTxBytesPerSec, 6000);

  // 网络采样使用「每轮单次 -L 1 采样」，不是常驻流，也不是 -L N>1
  const nettopCalls = h.run.calls.filter(function (call) { return call.command === 'nettop'; });
  assert.equal(nettopCalls.length, 3);
  assert.deepEqual(nettopCalls[0].args, ['-P', '-L', '1', '-n', '-x', '-J', 'bytes_in,bytes_out']);

  h.monitor.stop();
});

test('nettop 失败：supported.network=false，网络指标为 null，降级后不再重试', async function () {
  const h = setup({
    running: RUNNING_P1,
    handlers: {
      nettop: function () {
        const err = new Error('spawn nettop EPERM');
        err.code = 'EPERM';
        throw err;
      }
    }
  });

  const first = await h.monitor.sampleOnce();
  assert.equal(first.supported.network, false);
  assert.equal(first.overhead.nettopRunning, false);
  assert.equal(first.projects[0].netRxBytesPerSec, null);
  assert.equal(first.projects[0].netTxBytesPerSec, null);

  h.advance(1000);
  const second = await h.monitor.sampleOnce();
  assert.equal(second.supported.network, false);
  assert.equal(h.run.count('nettop'), 1); // 已降级，不再尝试
  assert.equal(second.projects[0].netRxBytesPerSec, null);

  h.monitor.stop();
});

test('没有运行中项目时停止网络采样并重置基线，恢复后重新建立基线', async function () {
  const snapshots = [
    ',bytes_in,bytes_out,\nnode.100,10000,20000,\n',
    ',bytes_in,bytes_out,\nnode.100,20000,40000,\n',
    ',bytes_in,bytes_out,\nnode.100,90000,190000,\n'
  ];
  let seq = 0;
  const h = setup({
    running: RUNNING_P1,
    handlers: {
      nettop: function () {
        const output = snapshots[Math.min(seq, snapshots.length - 1)];
        seq += 1;
        return { stdout: output };
      }
    }
  });

  await h.monitor.sampleOnce(); // 基线 A
  h.advance(1000);
  const s2 = await h.monitor.sampleOnce(); // A→B: +10000/+20000 B/s
  assert.equal(s2.projects[0].netRxBytesPerSec, 10000);
  assert.equal(s2.projects[0].netTxBytesPerSec, 20000);

  const nettopCallsBefore = h.run.count('nettop');
  h.setRunning([]);
  h.advance(1000);
  const s3 = await h.monitor.sampleOnce();
  assert.deepEqual(s3.projects, []);
  assert.equal(s3.overhead.nettopRunning, false);
  assert.equal(h.run.count('nettop'), nettopCallsBefore); // 没有运行项目时不 spawn nettop

  // 恢复运行：首轮重新建立基线，不把停顿期间累计的差值算成瞬时爆发
  h.setRunning(RUNNING_P1);
  h.advance(1000);
  const s4 = await h.monitor.sampleOnce();
  assert.equal(h.run.count('nettop'), nettopCallsBefore + 1);
  assert.equal(s4.projects[0].netRxBytesPerSec, 0);
  assert.equal(s4.projects[0].netTxBytesPerSec, 0);
  assert.equal(s4.overhead.nettopRunning, true);

  h.monitor.stop();
});

/* ------------------------------------------------------------------ */
/* overhead / 并发保护 / 生命周期 / 系统 CPU                            */
/* ------------------------------------------------------------------ */

test('overhead 统计随采样递增（ticks / commandCalls / commandMs / ownCpuMs）', async function () {
  let h;
  h = setup({
    running: RUNNING_P1,
    handlers: {
      ps: function () {
        h.advance(5); // 模拟命令耗时
        return { stdout: PS_BASE };
      }
    }
  });

  const s1 = await h.monitor.sampleOnce();
  h.advance(1000);
  const s2 = await h.monitor.sampleOnce();
  h.advance(1000);
  const s3 = await h.monitor.sampleOnce();

  assert.deepEqual(
    [s1.overhead.ticks, s2.overhead.ticks, s3.overhead.ticks],
    [1, 2, 3]
  );
  assert.ok(s3.overhead.commandCalls > s1.overhead.commandCalls);
  assert.ok(s3.overhead.commandMs > s1.overhead.commandMs);
  assert.equal(typeof s1.overhead.ownCpuMs, 'number');
  assert.ok(s1.overhead.ownCpuMs >= 0);
  assert.equal(typeof s1.overhead.nettopRunning, 'boolean');

  // 关闭后停止采样，overhead 不再变化
  h.monitor.setEnabled(false);
  const ticks = h.monitor.snapshot().overhead.ticks;
  await h.monitor.sampleOnce();
  assert.equal(h.monitor.snapshot().overhead.ticks, ticks);

  h.monitor.stop();
});

test('sampleOnce 并发保护：进行中再次调用复用同一轮，不重复执行命令', async function () {
  const h = setup({ running: RUNNING_P1 });

  const first = h.monitor.sampleOnce();
  const second = h.monitor.sampleOnce();
  assert.equal(second, first);

  const snaps = await Promise.all([first, second]);
  assert.equal(snaps[0], snaps[1]);
  assert.equal(h.run.count('ps'), 1);

  h.monitor.stop();
});

test('setEnabled(false) 立即停止采样并清空项目指标；stop() 结束生命周期', async function () {
  const h = setup({ running: RUNNING_P1 });
  await h.monitor.sampleOnce();
  assert.equal(h.monitor.snapshot().projects.length, 1);
  assert.equal(h.monitor.status().sampling, true);

  const status = h.monitor.setEnabled(false);
  assert.equal(status.enabled, false);
  assert.equal(status.sampling, false);

  const snap = h.monitor.snapshot();
  assert.equal(snap.enabled, false);
  assert.deepEqual(snap.projects, []);
  assert.equal(snap.overhead.nettopRunning, false);

  h.monitor.stop();
  const afterStop = h.monitor.status();
  assert.equal(afterStop.started, false);
  assert.equal(afterStop.sampling, false);
  assert.equal(h.monitor.isEnabled(), false);
});

test('system.cpuPercent 由 os.cpus 差分计算', async function () {
  const h = setup({ running: [], cpus: cpuSample(100, 100, 800) });

  const s1 = await h.monitor.sampleOnce();
  assert.equal(s1.system.cpuPercent, null); // 首帧没有基线

  h.setCpus(cpuSample(200, 120, 880));
  const s2 = await h.monitor.sampleOnce();
  // total 1000→1200 (+200)，idle 800→880 (+80) → 已用 120/200 = 60%
  assert.equal(s2.system.cpuPercent, 60);

  h.monitor.stop();
});

test('snapshot / status 字段结构符合 CONTRACT.md', async function () {
  const h = setup({ running: RUNNING_P1 });
  await h.monitor.sampleOnce();

  const snap = h.monitor.snapshot();
  assert.deepEqual(Object.keys(snap).sort(), [
    'at', 'enabled', 'intervalMs', 'overhead', 'projects', 'sampling', 'supported', 'system'
  ]);
  assert.deepEqual(Object.keys(snap.supported).sort(), ['cpu', 'gpuPerProcess', 'network']);
  assert.equal(snap.supported.gpuPerProcess, false);
  assert.deepEqual(Object.keys(snap.system).sort(), ['cpuPercent', 'gpuPercent', 'memoryUsedBytes']);
  assert.deepEqual(Object.keys(snap.overhead).sort(), [
    'commandCalls', 'commandMs', 'nettopRunning', 'ownCpuMs', 'ticks'
  ]);
  assert.equal(snap.intervalMs, HOUR_MS);
  assert.ok(Number.isFinite(Date.parse(snap.at)));

  const row = snap.projects[0];
  assert.deepEqual(Object.keys(row).sort(), [
    'cpuPercent', 'gpuPercent', 'memoryBytes', 'netRxBytesPerSec', 'netTxBytesPerSec',
    'pid', 'processCount', 'projectId'
  ]);
  assert.equal(row.gpuPercent, null);

  const status = h.monitor.status();
  assert.equal(status.enabled, true);
  assert.equal(status.sampling, true);
  assert.equal(status.started, true);
  assert.equal(typeof status.overhead.commandCalls, 'number');

  h.monitor.stop();
});

test('start 之前 setEnabled(true) 不采样；start 之后才开始采样循环', async function () {
  const run = makeRun({});
  const monitor = createMonitor({ intervalMs: HOUR_MS, run: run, cpus: function () { return cpuSample(1, 1, 1); } });
  monitor.setEnabled(true);
  assert.equal(monitor.status().sampling, false); // 未 start，不进入采样循环
  assert.equal(monitor.isEnabled(), true);

  monitor.start(function () { return RUNNING_P1; });
  assert.equal(monitor.status().sampling, true);

  const snap = await monitor.sampleOnce();
  assert.equal(snap.enabled, true);
  assert.equal(snap.projects.length, 1);

  monitor.stop();
});
