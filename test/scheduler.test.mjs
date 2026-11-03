import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNextRun, createScheduler } from '../server/scheduler.js';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** 本地时区的日期构造，避免测试依赖运行环境时区。 */
function at(year, month, day, hour, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

function iso(date) {
  return date.toISOString();
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 假时钟 + 假定时器：测试里不真等待。 */
function createFakeClock(startDate) {
  let nowMs = startDate.getTime();
  const timers = [];
  let seq = 0;

  const clock = {
    now() {
      return new Date(nowMs);
    },
    setTimeout(fn, delay) {
      seq += 1;
      const entry = {
        id: seq,
        fn,
        delay: Math.max(0, Number(delay) || 0),
        due: nowMs + Math.max(0, Number(delay) || 0),
        cancelled: false,
        fired: false
      };
      timers.push(entry);
      return entry.id;
    },
    clearTimeout(id) {
      const entry = timers.find((item) => item.id === id);
      if (entry) entry.cancelled = true;
    },
    pending() {
      return timers
        .filter((item) => !item.cancelled && !item.fired)
        .sort((a, b) => a.due - b.due || a.id - b.id);
    },
    peek() {
      const pending = clock.pending();
      return pending[0] || null;
    },
    setNow(date) {
      nowMs = date.getTime();
    },
    /** 推进到目标时间，沿途按顺序触发所有到期的定时器。 */
    async advanceTo(targetDate) {
      const targetMs = targetDate.getTime();
      for (;;) {
        const next = clock.pending()[0];
        if (!next || next.due > targetMs) break;
        nowMs = Math.max(nowMs, next.due);
        next.fired = true;
        next.fn();
        await flush();
      }
      nowMs = targetMs;
      await flush();
    },
    /** 手动提前触发当前最早的定时器（模拟系统时间回拨 / 计时器抖动）。 */
    async fireEarly() {
      const next = clock.pending()[0];
      if (!next) return null;
      next.fired = true;
      next.fn();
      await flush();
      return next;
    }
  };

  return clock;
}

function makeScheduler(clock, extra = {}) {
  const scans = [];
  const events = [];
  let diff = { added: 1, updated: 2, removed: 0, unchanged: 3 };
  const scheduler = createScheduler(Object.assign({
    now: () => clock.now(),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    runScan: async (context) => {
      scans.push({ reason: context && context.reason, at: clock.now().toISOString() });
      return { meta: {}, diff };
    },
    onEvent: (type, payload) => events.push({ type, payload })
  }, extra));
  return {
    scheduler,
    scans,
    events,
    setDiff(nextDiff) {
      diff = nextDiff;
    }
  };
}

// ---------------------------------------------------------------------------
// computeNextRun
// ---------------------------------------------------------------------------

test('computeNextRun：窗口内每 20 分钟一个刻度', () => {
  const cases = [
    [at(2026, 10, 29, 8, 0), at(2026, 10, 29, 9, 0)],
    [at(2026, 10, 29, 8, 59, 59), at(2026, 10, 29, 9, 0)],
    [at(2026, 10, 29, 9, 0), at(2026, 10, 29, 9, 20)],
    [at(2026, 10, 29, 9, 0, 1), at(2026, 10, 29, 9, 20)],
    [at(2026, 10, 29, 9, 10), at(2026, 10, 29, 9, 20)],
    [at(2026, 10, 29, 9, 19, 59), at(2026, 10, 29, 9, 20)],
    [at(2026, 10, 29, 9, 20), at(2026, 10, 29, 9, 40)],
    [at(2026, 10, 29, 9, 21), at(2026, 10, 29, 9, 40)],
    [at(2026, 10, 29, 12, 0), at(2026, 10, 29, 12, 20)],
    [at(2026, 10, 29, 19, 59), at(2026, 10, 29, 20, 0)],
    [at(2026, 10, 29, 20, 0), at(2026, 10, 30, 9, 0)],
    [at(2026, 10, 29, 20, 0, 1), at(2026, 10, 30, 9, 0)],
    [at(2026, 10, 29, 23, 30), at(2026, 10, 30, 9, 0)]
  ];
  for (const [now, expected] of cases) {
    assert.equal(computeNextRun(now, 9, 20, 20).getTime(), expected.getTime(), 'now=' + iso(now));
  }
});

test('computeNextRun：跨月 / 跨年 / 次日边界', () => {
  assert.equal(computeNextRun(at(2026, 10, 31, 21, 0), 9, 20, 20).getTime(), at(2026, 11, 1, 9, 0).getTime());
  assert.equal(computeNextRun(at(2026, 12, 31, 22, 0), 9, 20, 20).getTime(), at(2027, 1, 1, 9, 0).getTime());
  assert.equal(computeNextRun(at(2026, 10, 29, 3, 0), 9, 20, 20).getTime(), at(2026, 10, 29, 9, 0).getTime());
});

test('computeNextRun：结果严格晚于 now，且整分整秒', () => {
  const samples = [
    at(2026, 10, 29, 0, 0, 0),
    at(2026, 10, 29, 8, 0, 0),
    at(2026, 10, 29, 9, 0, 0),
    at(2026, 10, 29, 9, 0, 1),
    at(2026, 10, 29, 13, 37, 42),
    at(2026, 10, 29, 19, 59, 59),
    at(2026, 10, 29, 20, 0, 0),
    at(2026, 10, 29, 23, 59, 59)
  ];
  for (const now of samples) {
    const next = computeNextRun(now, 9, 20, 20);
    assert.ok(next.getTime() > now.getTime(), 'next 必须严格晚于 now：' + iso(now));
    assert.equal(next.getSeconds(), 0);
    assert.equal(next.getMilliseconds(), 0);
    const minutes = next.getHours() * 60 + next.getMinutes();
    assert.ok(minutes >= 9 * 60 && minutes <= 20 * 60, '结果应落在 09:00-20:00 窗口内：' + iso(next));
  }
});

test('computeNextRun：自定义窗口与间隔', () => {
  // 30 分钟间隔
  assert.equal(computeNextRun(at(2026, 10, 29, 9, 10), 9, 20, 30).getTime(), at(2026, 10, 29, 9, 30).getTime());
  assert.equal(computeNextRun(at(2026, 10, 29, 9, 30), 9, 20, 30).getTime(), at(2026, 10, 29, 10, 0).getTime());
  assert.equal(computeNextRun(at(2026, 10, 29, 19, 40), 9, 20, 30).getTime(), at(2026, 10, 29, 20, 0).getTime());
  assert.equal(computeNextRun(at(2026, 10, 29, 20, 0), 9, 20, 30).getTime(), at(2026, 10, 30, 9, 0).getTime());
  // 45 分钟间隔：最后刻度是 19:30，19:31 之后直接等次日
  assert.equal(computeNextRun(at(2026, 10, 29, 9, 0), 9, 20, 45).getTime(), at(2026, 10, 29, 9, 45).getTime());
  assert.equal(computeNextRun(at(2026, 10, 29, 19, 29), 9, 20, 45).getTime(), at(2026, 10, 29, 19, 30).getTime());
  assert.equal(computeNextRun(at(2026, 10, 29, 19, 31), 9, 20, 45).getTime(), at(2026, 10, 30, 9, 0).getTime());
  // 自定义窗口 08:00-18:00
  assert.equal(computeNextRun(at(2026, 10, 29, 7, 0), 8, 18, 20).getTime(), at(2026, 10, 29, 8, 0).getTime());
  assert.equal(computeNextRun(at(2026, 10, 29, 17, 59), 8, 18, 20).getTime(), at(2026, 10, 29, 18, 0).getTime());
  assert.equal(computeNextRun(at(2026, 10, 29, 18, 0), 8, 18, 20).getTime(), at(2026, 10, 30, 8, 0).getTime());
  // 默认参数
  assert.equal(computeNextRun(at(2026, 10, 29, 8, 0)).getTime(), at(2026, 10, 29, 9, 0).getTime());
});

test('computeNextRun：非法时间抛 TypeError', () => {
  assert.throws(() => computeNextRun(new Date('not-a-date'), 9, 20, 20), TypeError);
  assert.throws(() => computeNextRun('nope', 9, 20, 20), TypeError);
  assert.throws(() => computeNextRun(undefined, 9, 20, 20), TypeError);
});

// ---------------------------------------------------------------------------
// createScheduler：status / 定时触发
// ---------------------------------------------------------------------------

test('scheduler：start 后 status 与契约 meta.scheduler 同构，并挂载下一次 09:00', () => {
  const clock = createFakeClock(at(2026, 10, 29, 8, 0));
  const { scheduler } = makeScheduler(clock);

  const status = scheduler.start();
  assert.deepEqual(
    Object.keys(status).sort(),
    ['enabled', 'intervalMinutes', 'lastResult', 'lastRunAt', 'nextRunAt', 'running', 'windowEndHour', 'windowStartHour'].sort()
  );
  assert.equal(status.enabled, true);
  assert.equal(status.running, false);
  assert.equal(status.windowStartHour, 9);
  assert.equal(status.windowEndHour, 20);
  assert.equal(status.intervalMinutes, 20);
  assert.equal(status.lastRunAt, null);
  assert.equal(status.lastResult, null);
  assert.equal(status.nextRunAt, iso(at(2026, 10, 29, 9, 0)));

  const timer = clock.peek();
  assert.ok(timer, '应挂载一个定时器');
  assert.equal(timer.delay, HOUR, '距离 09:00 应还有 1 小时');

  scheduler.stop();
});

test('scheduler：到点触发一次，并推进 nextRunAt 到 09:20', async () => {
  const clock = createFakeClock(at(2026, 10, 29, 8, 0));
  const { scheduler, scans } = makeScheduler(clock);
  scheduler.start();

  await clock.advanceTo(at(2026, 10, 29, 9, 0));
  assert.equal(scans.length, 1);
  assert.equal(scans[0].reason, 'schedule');
  assert.equal(scans[0].at, iso(at(2026, 10, 29, 9, 0)));

  const status = scheduler.status();
  assert.equal(status.running, false);
  assert.equal(status.lastRunAt, iso(at(2026, 10, 29, 9, 0)));
  assert.equal(status.nextRunAt, iso(at(2026, 10, 29, 9, 20)));
  assert.deepEqual(status.lastResult, { added: 1, updated: 2, removed: 0, unchanged: 3 });

  await clock.advanceTo(at(2026, 10, 29, 9, 20));
  assert.equal(scans.length, 2);
  assert.equal(scheduler.status().nextRunAt, iso(at(2026, 10, 29, 9, 40)));

  scheduler.stop();
});

test('scheduler：20:00 是当天最后一个触发点，之后等到次日 09:00', async () => {
  const clock = createFakeClock(at(2026, 10, 29, 19, 40));
  const { scheduler, scans } = makeScheduler(clock);
  scheduler.start();
  assert.equal(scheduler.status().nextRunAt, iso(at(2026, 10, 29, 20, 0)));

  await clock.advanceTo(at(2026, 10, 29, 20, 0));
  assert.equal(scans.length, 1);
  assert.equal(scheduler.status().nextRunAt, iso(at(2026, 10, 30, 9, 0)));

  await clock.advanceTo(at(2026, 10, 29, 23, 59));
  assert.equal(scans.length, 1, '窗口外不应触发扫描');

  await clock.advanceTo(at(2026, 10, 30, 9, 0));
  assert.equal(scans.length, 2);
  assert.equal(scans[1].at, iso(at(2026, 10, 30, 9, 0)));

  scheduler.stop();
});

test('scheduler：窗口外启动时等到次日 09:00', async () => {
  const clock = createFakeClock(at(2026, 10, 29, 22, 0));
  const { scheduler, scans } = makeScheduler(clock);
  scheduler.start();
  assert.equal(scheduler.status().nextRunAt, iso(at(2026, 10, 30, 9, 0)));

  await clock.advanceTo(at(2026, 10, 29, 23, 59));
  assert.equal(scans.length, 0);

  await clock.advanceTo(at(2026, 10, 30, 9, 0));
  assert.equal(scans.length, 1);

  scheduler.stop();
});

test('scheduler：自定义窗口 / 间隔会体现在 status 与触发时刻', async () => {
  const clock = createFakeClock(at(2026, 10, 29, 8, 5));
  const { scheduler, scans } = makeScheduler(clock, { startHour: 8, endHour: 18, intervalMinutes: 30 });
  const status = scheduler.start();
  assert.equal(status.windowStartHour, 8);
  assert.equal(status.windowEndHour, 18);
  assert.equal(status.intervalMinutes, 30);
  assert.equal(status.nextRunAt, iso(at(2026, 10, 29, 8, 30)));

  await clock.advanceTo(at(2026, 10, 29, 8, 30));
  assert.equal(scans.length, 1);
  assert.equal(scheduler.status().nextRunAt, iso(at(2026, 10, 29, 9, 0)));

  scheduler.stop();
});

// ---------------------------------------------------------------------------
// createScheduler：triggerNow / 跳过 / 纠偏 / stop / 错误
// ---------------------------------------------------------------------------

test('scheduler：triggerNow 立即扫描并更新 nextRunAt', async () => {
  const clock = createFakeClock(at(2026, 10, 29, 9, 5));
  const { scheduler, scans } = makeScheduler(clock);
  scheduler.start();
  assert.equal(scheduler.status().nextRunAt, iso(at(2026, 10, 29, 9, 20)));

  const result = await scheduler.triggerNow('手动扫描');
  assert.equal(result.started, true);
  assert.equal(scans.length, 1);
  assert.equal(scans[0].reason, '手动扫描');
  assert.equal(scans[0].at, iso(at(2026, 10, 29, 9, 5)));

  const status = scheduler.status();
  assert.equal(status.lastRunAt, iso(at(2026, 10, 29, 9, 5)));
  assert.equal(status.nextRunAt, iso(at(2026, 10, 29, 9, 20)));

  await clock.advanceTo(at(2026, 10, 29, 9, 20));
  assert.equal(scans.length, 2);
  assert.equal(scans[1].reason, 'schedule');

  scheduler.stop();
});

test('scheduler：triggerNow 扫描进行中会跳过而不是排队', async () => {
  const clock = createFakeClock(at(2026, 10, 29, 9, 5));
  let resolveScan;
  const pending = new Promise((resolve) => {
    resolveScan = resolve;
  });
  const calls = [];
  const scheduler = createScheduler({
    now: () => clock.now(),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    runScan: () => {
      calls.push(clock.now().toISOString());
      return pending;
    },
    onEvent: () => {}
  });
  scheduler.start();

  const first = scheduler.triggerNow('manual');
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(scheduler.status().running, true);

  const second = await scheduler.triggerNow('manual');
  assert.equal(second.started, false);
  assert.equal(second.reason, 'running');
  assert.equal(calls.length, 1, '扫描进行中不应再次调用 runScan');

  resolveScan({ meta: {}, diff: { added: 0, updated: 0, removed: 0, unchanged: 0 } });
  const firstResult = await first;
  assert.equal(firstResult.started, true);
  assert.equal(scheduler.status().running, false);

  scheduler.stop();
});

test('scheduler：定时触发时上一次仍在进行会跳过并推进下一次', async () => {
  const clock = createFakeClock(at(2026, 10, 29, 8, 59));
  let resolveScan;
  const pending = new Promise((resolve) => {
    resolveScan = resolve;
  });
  const calls = [];
  const events = [];
  const scheduler = createScheduler({
    now: () => clock.now(),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    runScan: () => {
      calls.push(clock.now().toISOString());
      return pending;
    },
    onEvent: (type, payload) => events.push({ type, payload })
  });
  scheduler.start();

  await clock.advanceTo(at(2026, 10, 29, 9, 0));
  assert.equal(calls.length, 1);
  assert.equal(scheduler.status().running, true);

  await clock.advanceTo(at(2026, 10, 29, 9, 20));
  assert.equal(calls.length, 1, '扫描进行中不应重复触发');
  assert.ok(events.some((event) => event.type === 'scan:skip'), '应发出 scan:skip 事件');
  assert.equal(scheduler.status().nextRunAt, iso(at(2026, 10, 29, 9, 40)));

  resolveScan({ meta: {}, diff: { added: 0, updated: 0, removed: 0, unchanged: 0 } });
  await flush();
  assert.equal(scheduler.status().running, false);

  scheduler.stop();
});

test('scheduler：定时器提前触发会自我纠偏，不扫描', async () => {
  const clock = createFakeClock(at(2026, 10, 29, 8, 0));
  const { scheduler, scans } = makeScheduler(clock);
  scheduler.start();

  await clock.fireEarly();
  assert.equal(scans.length, 0, '提前触发不应扫描');
  assert.equal(scheduler.status().nextRunAt, iso(at(2026, 10, 29, 9, 0)));

  const timer = clock.peek();
  assert.ok(timer, '应重新挂载定时器');
  assert.equal(timer.delay, HOUR, '应重新挂到 09:00');

  await clock.advanceTo(at(2026, 10, 29, 9, 0));
  assert.equal(scans.length, 1, '纠偏后到点仍应正常扫描');

  scheduler.stop();
});

test('scheduler：runScan 抛错时记录 scan:error 并继续调度', async () => {
  const clock = createFakeClock(at(2026, 10, 29, 8, 59));
  let count = 0;
  const events = [];
  const scheduler = createScheduler({
    now: () => clock.now(),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    runScan: async () => {
      count += 1;
      if (count === 1) throw new Error('boom');
      return { meta: {}, diff: { added: 0, updated: 0, removed: 0, unchanged: 0 } };
    },
    onEvent: (type, payload) => events.push({ type, payload })
  });
  scheduler.start();

  await clock.advanceTo(at(2026, 10, 29, 9, 0));
  assert.equal(count, 1);
  assert.equal(scheduler.status().running, false);
  assert.ok(events.some((event) => event.type === 'scan:error' && event.payload.message === 'boom'));
  assert.equal(scheduler.status().nextRunAt, iso(at(2026, 10, 29, 9, 20)));

  await clock.advanceTo(at(2026, 10, 29, 9, 20));
  assert.equal(count, 2, '出错后调度应继续');

  scheduler.stop();
});

test('scheduler：stop 清理定时器，之后不再触发', async () => {
  const clock = createFakeClock(at(2026, 10, 29, 8, 0));
  const { scheduler, scans } = makeScheduler(clock);
  scheduler.start();
  assert.equal(clock.pending().length, 1);

  const status = scheduler.stop();
  assert.equal(status.enabled, false);
  assert.equal(status.nextRunAt, null);
  assert.equal(clock.pending().length, 0, 'stop 后不应残留定时器');

  await clock.advanceTo(at(2026, 10, 29, 12, 0));
  assert.equal(scans.length, 0);
});

test('scheduler：start 幂等，不会重复挂载导致一次触发扫描两次', async () => {
  const clock = createFakeClock(at(2026, 10, 29, 8, 0));
  const { scheduler, scans } = makeScheduler(clock);
  scheduler.start();
  scheduler.start();
  scheduler.start();

  await clock.advanceTo(at(2026, 10, 29, 9, 0));
  assert.equal(scans.length, 1, '重复 start 不应产生重复触发');

  scheduler.stop();
});

test('scheduler：start 之前 status 为未启用', () => {
  const clock = createFakeClock(at(2026, 10, 29, 8, 0));
  const { scheduler } = makeScheduler(clock);
  const status = scheduler.status();
  assert.equal(status.enabled, false);
  assert.equal(status.running, false);
  assert.equal(status.nextRunAt, null);
  assert.equal(status.lastRunAt, null);
  assert.equal(status.lastResult, null);
});
