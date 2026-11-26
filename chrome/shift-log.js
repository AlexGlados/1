(() => {
  'use strict';

  const HOUR = 3_600_000;
  const MAX_EVENTS = 1200;
  const engine = globalThis.ChatEngine;
  const identity = globalThis.ShkolkovoIdentity;

  function journal(s) {
    return s.shiftLogs ??= { active: null, pending: [] };
  }

  function record(s, at, event, details) {
    const log = s.shiftLogs?.active;
    if (!log) return;
    if (log.events.length >= MAX_EVENTS) {
      log.events.splice(1, 1);
      log.omitted++;
    }
    log.events.push(details ? { at, event, details } : { at, event });
  }

  function start(s, now) {
    const logs = journal(s);
    if (logs.active) {
      record(s, now, 'monitor_resumed');
      return;
    }
    logs.active = {
      id: crypto.randomUUID(), openedAt: now, firstDutyPeriod: null, lastDutyPeriod: null,
      nextOnDuty: null, initialChecked: s.checked || 0, initialNotified: s.notified || 0, events: [], omitted: 0
    };
    record(s, now, 'monitor_started', { mode: s.scan.mode, pinnedInstant: s.scan.pinnedImmediate !== false });
  }

  function finish(s, endedAt, reason, details, now = endedAt) {
    const logs = s.shiftLogs;
    const log = logs?.active;
    if (!log) return;
    // Keep the order of captured events even when Chrome wakes after the roster boundary.
    record(s, now, 'shift_finished', { reason, ...details });
    logs.pending.push({
      ...log, endedAt, reason, checked: (s.checked || 0) - log.initialChecked,
      notified: (s.notified || 0) - log.initialNotified, retryAt: 0, downloadId: null
    });
    logs.active = null;
  }

  function observe(s, now, enabled, confirmed) {
    const scan = s.scan;
    if (!scan.curatorName) return;
    const calendar = engine.calendarPeriodAt(now);
    const cached = [scan.prepared, scan.calendarRoster].filter(entry => entry?.names?.length);
    if (scan.appliedPeriod === scan.period) cached.unshift({ period: scan.period, names: scan.roster });
    if (confirmed) cached.unshift(confirmed);
    function onDuty(period) {
      const names = cached.find(entry => entry.period === period && Array.isArray(entry.names))?.names;
      return names ? names.some(name => identity.matches(name, scan.curatorName)) : null;
    }

    const currentDuty = onDuty(calendar);
    let log = s.shiftLogs?.active;
    if (Number.isFinite(log?.lastDutyPeriod)) {
      const next = log.lastDutyPeriod + HOUR;
      log.nextOnDuty = onDuty(next) ?? log.nextOnDuty;
      if (now >= next && log.nextOnDuty === false) {
        finish(s, next, 'schedule', undefined, now);
        log = null;
      } else if (now >= next && log.nextOnDuty === true) {
        log.lastDutyPeriod = next;
        log.nextOnDuty = null;
        record(s, now, 'duty_hour_confirmed', { hourUtc: new Date(next).toISOString() });
      }
    }
    if (currentDuty === true && (enabled || log)) {
      if (!log) {
        start(s, now);
        log = s.shiftLogs.active;
      }
      if (!Number.isFinite(log.lastDutyPeriod) || calendar > log.lastDutyPeriod) {
        log.firstDutyPeriod ??= calendar;
        log.lastDutyPeriod = calendar;
        log.nextOnDuty = null;
        record(s, now, 'duty_hour_confirmed', { hourUtc: new Date(calendar).toISOString() });
      }
      if (calendar === log.lastDutyPeriod) log.nextOnDuty = onDuty(calendar + HOUR) ?? log.nextOnDuty;
    }
  }

  function nextBoundary(s, now) {
    const log = s.shiftLogs?.active;
    if (!Number.isFinite(log?.lastDutyPeriod) || log.nextOnDuty === null) return Infinity;
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
      ...report.events.map(({ at, event, details }) => `${utc(at)}  ${event}${details ? '  ' + JSON.stringify(details) : ''}`)
    ];
    return '\uFEFF' + lines.join('\n') + '\n';
  }

  globalThis.ShkolkovoShiftLog = Object.freeze({ start, record, observe, finish, nextBoundary, filename, render });
})();
