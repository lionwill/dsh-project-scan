/**
 * server/scheduler.js — 扫描调度器
 *
 * 规则（本地时区）：每天 startHour:00 到 endHour:00 之间，每 intervalMinutes 分钟触发一次
 * （默认 09:00、09:20 ... 20:00）；窗口外不扫描，等到次日 startHour:00。
 *
 * 实现要点：
 * - 用 setTimeout 自我纠偏（每次触发后按真实当前时间重新计算下一次），不用 setInterval；
 * - 扫描进行中再次触发会跳过，不排队；
 * - triggerNow(reason) 支持手动触发，并立即把 nextRunAt 推进到当前时刻之后；
 * - stop() 清理定时器；status() 返回与契约 meta.scheduler 同构的对象。
 *
 * 说明：index.js 的 runScan 内部已经负责广播 scan:start / scan:done（SSE 契约），
 * 因此本调度器不重复发这两个事件，只发补充事件 scan:skip / scan:error，避免前端收到重复事件。
 */

function toValidDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError('computeNextRun 需要一个有效的时间');
  }
  return date;
}

function clampHour(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(23, Math.max(0, Math.trunc(num)));
}

function positiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.max(1, Math.trunc(num));
}

/** 某天的 hour:00:00.000（本地时区）。 */
function startOfDay(date, hour) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, 0, 0, 0);
}

/** 往后 n 天的 hour:00:00.000（本地时区）。 */
function startOfDayPlus(date, days, hour) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, hour, 0, 0, 0);
}

/**
 * 计算下一次扫描时间：严格晚于 now 的下一个窗口内时间点。
 * @param {Date|number|string} now
 * @param {number} [startHour=9]
 * @param {number} [endHour=20]
 * @param {number} [intervalMinutes=20]
 * @returns {Date}
 */
export function computeNextRun(now, startHour = 9, endHour = 20, intervalMinutes = 20) {
  const current = toValidDate(now);
  const start = clampHour(startHour, 9);
  const end = clampHour(endHour, 20);
  const interval = positiveInt(intervalMinutes, 20);
  const currentMs = current.getTime();

  // 窗口非法（结束早于开始）：当天没有可触发时间，直接等次日
  if (end < start) return startOfDayPlus(current, 1, start);

  const dayStart = startOfDay(current, start);
  if (currentMs < dayStart.getTime()) return dayStart;

  const windowEnd = startOfDay(current, end);
  if (currentMs < windowEnd.getTime()) {
    // 窗口内：找到严格晚于 now 的下一个刻度
    const elapsedMinutes = (currentMs - dayStart.getTime()) / 60000;
    const step = Math.floor(elapsedMinutes / interval) + 1;
    const totalMinutes = start * 60 + step * interval;
    const candidate = new Date(
      current.getFullYear(),
      current.getMonth(),
      current.getDate(),
      Math.floor(totalMinutes / 60),
      totalMinutes % 60,
      0,
      0
    );
    if (candidate.getTime() <= windowEnd.getTime()) return candidate;
    return startOfDayPlus(current, 1, start);
  }

  // 窗口已结束（含恰好 endHour:00）：等次日窗口开始
  return startOfDayPlus(current, 1, start);
}

/**
 * 创建调度器。
 * @param {{
 *   intervalMinutes?: number,
 *   startHour?: number,
 *   endHour?: number,
 *   runScan?: (context?: {reason?: string, startedAt?: Date}) => Promise<{meta?: object, diff?: object}>,
 *   onEvent?: (type: string, payload: object) => void,
 *   now?: () => Date,
 *   setTimeout?: Function,
 *   clearTimeout?: Function,
 *   earlyFireToleranceMs?: number
 * }} [options]
 */
export function createScheduler(options = {}) {
  const opts = options || {};
  const intervalMinutes = positiveInt(opts.intervalMinutes, 20);
  const startHour = clampHour(opts.startHour, 9);
  const endHour = clampHour(opts.endHour, 20);
  const runScan = typeof opts.runScan === 'function' ? opts.runScan : async () => ({ meta: null, diff: null });
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const nowFn = typeof opts.now === 'function' ? opts.now : () => new Date();
  const setTimer = typeof opts.setTimeout === 'function' ? opts.setTimeout : setTimeout;
  const clearTimer = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : clearTimeout;
  const earlyFireToleranceMs = Number.isFinite(Number(opts.earlyFireToleranceMs))
    ? Math.max(0, Number(opts.earlyFireToleranceMs))
    : 250;

  let started = false;
  let running = false;
  let timer = null;
  let nextRunAt = null;
  let lastRunAt = null;
  let lastResult = null;

  function currentTime() {
    return toValidDate(nowFn());
  }

  function emit(type, payload) {
    try {
      onEvent(type, payload);
    } catch (err) {
      console.error('[scheduler] onEvent 处理失败：' + String((err && err.message) || err));
    }
  }

  function clearTimerSafe() {
    if (timer !== null) {
      try {
        clearTimer(timer);
      } catch {
        // 忽略清理失败
      }
      timer = null;
    }
  }

  function armAt(target, from) {
    clearTimerSafe();
    const delay = Math.max(0, target.getTime() - from.getTime());
    timer = setTimer(handleTimer, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /** 以 base 为基准重新规划 nextRunAt，并返回新的计划时间。 */
  function planFrom(base) {
    nextRunAt = computeNextRun(base, startHour, endHour, intervalMinutes);
    return nextRunAt;
  }

  async function execute(reason) {
    if (running) {
      emit('scan:skip', {
        reason: '上一次扫描仍在进行中，本次触发已跳过',
        trigger: reason,
        at: currentTime().toISOString()
      });
      return { started: false, reason: 'running' };
    }
    running = true;
    const startedAt = currentTime();
    lastRunAt = startedAt;
    try {
      const result = await runScan({ reason, startedAt });
      const diff = result && result.diff ? result.diff : null;
      if (diff) lastResult = diff;
      return { started: true, result };
    } catch (err) {
      const message = String((err && err.message) || err);
      emit('scan:error', { at: currentTime().toISOString(), trigger: reason, message });
      console.error('[scheduler] 扫描失败：' + message);
      return { started: false, reason: 'error', error: message };
    } finally {
      running = false;
    }
  }

  function handleTimer() {
    timer = null;
    if (!started) return;
    const current = currentTime();
    // 定时器提前触发（系统时间回拨 / 计时器抖动）：重新挂到同一目标，不扫描
    if (nextRunAt && current.getTime() < nextRunAt.getTime() - earlyFireToleranceMs) {
      armAt(nextRunAt, current);
      return;
    }
    // 先规划下一次，再执行扫描：这样长扫描期间 meta 里的 nextRunAt 依然准确
    const target = planFrom(current);
    armAt(target, current);
    void execute('schedule');
  }

  /** 启动调度：只负责挂载下一次触发，启动扫描由调用方（index.js）自行触发。 */
  function start() {
    started = true;
    const current = currentTime();
    const target = planFrom(current);
    armAt(target, current);
    return status();
  }

  /** 停止调度：清理定时器。 */
  function stop() {
    started = false;
    clearTimerSafe();
    nextRunAt = null;
    return status();
  }

  /** 手动触发一次扫描，并立即更新 nextRunAt。扫描进行中会跳过。 */
  async function triggerNow(reason) {
    const label = typeof reason === 'string' && reason.trim() ? reason.trim() : 'manual';
    const current = currentTime();
    const target = planFrom(current);
    if (started) armAt(target, current);
    const result = await execute(label);
    // 扫描耗时可能跨过计划时间点：结束时若计划时间已过，重新规划
    const after = currentTime();
    if (started && nextRunAt && after.getTime() >= nextRunAt.getTime()) {
      const next = planFrom(after);
      armAt(next, after);
    }
    return result;
  }

  /** 与契约 meta.scheduler 同构的状态对象。 */
  function status() {
    return {
      enabled: started,
      running,
      windowStartHour: startHour,
      windowEndHour: endHour,
      intervalMinutes,
      lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
      nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
      lastResult
    };
  }

  return { start, stop, status, triggerNow };
}
