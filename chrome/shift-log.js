(() => {
  'use strict';

  const HOUR = 3_600_000;
  const MAX_EVENTS = 1200;
  const DUTY_MATCH_VERSION = 1;
  const engine = globalThis.ChatEngine;

  function journal(s) {
    return s.shiftLogs ??= { active: null, pending: [] };
  }

  function append(log, event) {
    if (log.events.length >= MAX_EVENTS) {
      log.events.splice(1, 1);
      log.omitted += 1;
    }
    log.events.push(event);
  }

  function hold(log, event) {
    const held = log.held ??= { events: [], hours: {} };
    const hour = engine.calendarPeriodAt(event.at);
    const totals = held.hours[hour] ??= { checked: 0, notified: 0, omitted: 0 };
    if (event.event === 'chat_checked') totals.checked += 1;
    if (event.event === 'notification_delivered' && !['offline', 'connecting'].includes(event.details?.kind)) {
      totals.notified += 1;
    }
    if (held.events.length >= MAX_EVENTS) {
      const removed = held.events.shift();
      held.hours[engine.calendarPeriodAt(removed.at)].omitted += 1;
    }
    held.events.push(event);
  }

  function acceptBefore(log, cutoff) {
    const held = log.held;
    if (!held) return;
    held.events = held.events.filter(event => {
      if (event.at >= cutoff) return true;
      append(log, event);
      return false;
    });
    for (const [period, totals] of Object.entries(held.hours)) {
      if (Number(period) >= cutoff) continue;
      log.omitted += totals.omitted;
      delete held.hours[period];
    }
    if (Object.keys(held.hours).length === 0) delete log.held;
  }

  function record(s, at, event, details) {
    const log = s.shiftLogs?.active;
    if (!log) return;
    const entry = details ? { at, event, details } : { at, event };
    if (Number.isFinite(log.lastDutyPeriod) && at >= log.lastDutyPeriod + HOUR) hold(log, entry);
    else append(log, entry);
  }

  function start(s, now) {
    const logs = journal(s);
    if (logs.active) {
      record(s, now, 'monitor_resumed');
      return;
    }
    logs.active = {
      id: crypto.randomUUID(), openedAt: now, firstDutyPeriod: null, lastDutyPeriod: null,
      nextOnDuty: null, dutyMatchVersion: DUTY_MATCH_VERSION,
      initialChecked: s.checked || 0, initialNotified: s.notified || 0, events: [], omitted: 0
    };
    record(s, now, 'monitor_started', { mode: s.scan.mode, pinnedInstant: s.scan.pinnedImmediate !== false });
  }

  function finish(s, endedAt, reason, details, now = endedAt) {
    const logs = s.shiftLogs;
    const log = logs?.active;
    if (!log) return;
    // A delayed schedule lookup can close an earlier session while monitoring is already awake again.
    acceptBefore(log, reason === 'schedule' ? endedAt : Infinity);
    const { held, ...resolved } = log;
    const unconfirmed = Object.values(held?.hours ?? {});
    const checked = (s.checked || 0) - log.initialChecked - unconfirmed.reduce((sum, hour) => sum + hour.checked, 0);
    const notified = (s.notified || 0) - log.initialNotified - unconfirmed.reduce((sum, hour) => sum + hour.notified, 0);
    append(resolved, { at: now, event: 'shift_finished', details: { reason, ...details } });
    logs.pending.push({
      ...resolved, endedAt, reason, checked, notified, retryAt: 0, downloadId: null
    });
    logs.active = null;
    return held;
  }

  function markDuty(log, period, now) {
    log.firstDutyPeriod ??= period;
    log.lastDutyPeriod = period;
    log.nextOnDuty = null;
    acceptBefore(log, period + HOUR);
    append(log, { at: now, event: 'duty_hour_confirmed', details: { hourUtc: new Date(period).toISOString() } });
  }

  function migrateDutyMatch(log) {
    if (!log || log.dutyMatchVersion === DUTY_MATCH_VERSION) return;
    log.dutyMatchVersion = DUTY_MATCH_VERSION;
    log.nextOnDuty = null;
    if (!Number.isFinite(log.lastDutyPeriod)) return;
    const boundary = log.lastDutyPeriod + HOUR;
    log.events = log.events.filter(event => {
      if (event.at < boundary) return true;
      hold(log, event);
      return false;
    });
  }

  function acceptCurrentHour(log, period, held) {
    const totals = held?.hours[period];
    if (!totals) return;
    log.initialChecked -= totals.checked;
    log.initialNotified -= totals.notified;
    log.omitted += totals.omitted;
    for (const event of held.events) {
      if (engine.calendarPeriodAt(event.at) === period) append(log, event);
    }
  }

  function observe(s, now, enabled, confirmed) {
    const scan = s.scan;
    if (!scan.curatorName) return;
    const calendar = engine.calendarPeriodAt(now);
    const cached = [scan.prepared, scan.calendarRoster];
    if (scan.appliedPeriod === scan.period) {
      cached.unshift({ period: scan.period, names: scan.roster, directory: scan.directory });
    }
    if (confirmed) cached.unshift(confirmed);
    const rosterAt = period => cached.find(entry => entry?.period === period && Array.isArray(entry.names));
    const onDuty = roster => roster ? engine.curatorDuty(scan, roster.names, roster.directory) : null;

    const currentDuty = onDuty(rosterAt(calendar));
    let log = s.shiftLogs?.active;
    let held;
    migrateDutyMatch(log);
    while (Number.isFinite(log?.lastDutyPeriod)) {
      const next = log.lastDutyPeriod + HOUR;
      const upcoming = rosterAt(next);
      if (upcoming) log.nextOnDuty = onDuty(upcoming);
      if (now < next || typeof log.nextOnDuty !== 'boolean') break;
      if (!log.nextOnDuty) {
        held = finish(s, next, 'schedule', undefined, now);
        log = null;
        break;
      }
      markDuty(log, next, now);
    }
    if (currentDuty === true && (enabled || log) && !Number.isFinite(log?.lastDutyPeriod)) {
      if (!log) {
        start(s, now);
        log = s.shiftLogs.active;
        acceptCurrentHour(log, calendar, held);
      }
      markDuty(log, calendar, now);
      log.nextOnDuty = onDuty(rosterAt(calendar + HOUR));
    }
  }

  function missingHour(s, now) {
    const log = s.shiftLogs?.active;
    if (!Number.isFinite(log?.lastDutyPeriod) || typeof log.nextOnDuty === 'boolean') return null;
    const next = log.lastDutyPeriod + HOUR;
    const calendar = engine.calendarPeriodAt(now);
    return next < calendar || (!s.scan.enabled && next === calendar) ? next : null;
  }

  function confirmHour(s, now, period, names, directory = []) {
    if (!Array.isArray(names) || !Number.isFinite(period) || missingHour(s, now) !== period) return false;
    observe(s, now, s.scan.enabled, { period, names, directory });
    return missingHour(s, now) !== period;
  }

  function nextBoundary(s, now) {
    const log = s.shiftLogs?.active;
    if (!Number.isFinite(log?.lastDutyPeriod)) return Infinity;
    const next = log.lastDutyPeriod + HOUR;
    return next > now ? next : Infinity;
  }

  function filename(report) {
    const stamp = new Date(report.endedAt).toISOString().replaceAll(':', '-');
    return `shkolkovo-shift-${stamp}-${report.id.slice(0, 8)}.log`;
  }

  function render(report, version) {
    const local = globalThis.ShkolkovoTime.local();
    const utc = at => new Date(at).toISOString();
    const entered = at => `${local.label(at)} (${utc(at)})`;
    const lines = [
      `Школково — журнал смены · Chrome ${version}`,
      `Начало журнала: ${entered(report.openedAt)}`,
      Number.isFinite(report.firstDutyPeriod) ? `Первый подтверждённый час: ${entered(report.firstDutyPeriod)}` : '',
      `Окончание: ${entered(report.endedAt)}`,
      `Причина: ${report.reason === 'schedule' ? 'по расписанию' : report.reason === 'curator_changed' ? 'смена куратора' : 'вручную'}`,
      `Проверено чатов: ${report.checked} · Уведомлений о чатах: ${report.notified}`,
      `Пропущено старых событий при переполнении журнала: ${report.omitted}`,
      '',
      ...report.events.slice().sort((a, b) => a.at - b.at)
        .map(({ at, event, details }) => `${utc(at)}  ${event}${details ? '  ' + JSON.stringify(details) : ''}`)
    ];
    return '\uFEFF' + lines.join('\n') + '\n';
  }

  globalThis.ShkolkovoShiftLog = Object.freeze({
    start, record, observe, missingHour, confirmHour, finish, nextBoundary, filename, render
  });
})();
