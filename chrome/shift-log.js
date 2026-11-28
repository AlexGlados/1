(() => {
  'use strict';

  const HOUR = 3_600_000;
  const MAX_EVENTS = 1200;
  const DUTY_MATCH_VERSION = 1;
  const engine = globalThis.ChatEngine;
  const referenceFields = ['chat_ref', 'episode_ref', 'notification_ref'];
  const timeSources = ['datetime', 'title', 'text'];
  const timeReasons = ['invalid_timestamp', 'future_timestamp', 'displayed_minute_unconfirmed',
    'displayed_minute_mismatch', 'displayed_precision_preferred'];

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

  function hold(owner, event) {
    const held = owner.held ??= { events: [], hours: {} };
    const hour = engine.calendarPeriodAt(event.at);
    const totals = held.hours[hour] ??= { checked: 0, notified: 0, omitted: 0 };
    totals.firstAt = Math.min(totals.firstAt ?? Infinity, event.at);
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
      log.openedAt = Math.min(log.openedAt, event.at);
      append(log, event);
      return false;
    });
    for (const [period, totals] of Object.entries(held.hours)) {
      if (Number(period) >= cutoff) continue;
      if (Number.isFinite(totals.firstAt)) log.openedAt = Math.min(log.openedAt, totals.firstAt);
      else if (totals.omitted) log.openedAt = Math.min(log.openedAt, Number(period));
      log.omitted += totals.omitted;
      delete held.hours[period];
    }
    if (Object.keys(held.hours).length === 0) delete log.held;
  }

  function record(s, at, event, details) {
    const log = s.shiftLogs?.active;
    const entry = details ? { at, event, details } : { at, event };
    if (log) {
      if (Number.isFinite(log.lastDutyPeriod) && at >= log.lastDutyPeriod + HOUR) hold(log, entry);
      else append(log, entry);
    } else if (at >= s.shiftLogs?.review?.period) {
      hold(s.shiftLogs.review, entry);
    }
  }

  function diagnostic(s, at, event, { chatId, episode, noticeId, kind }, details) {
    if (!s.shiftLogs?.active && !(at >= s.shiftLogs?.review?.period)) return;
    // Keep the identity lookup in local monitoring state, outside journal entries and reports.
    const index = s.notificationLogIndex ??= {};
    const reference = (...parts) => index[JSON.stringify(parts)] ??= crypto.randomUUID();
    const chatRef = chatId ? reference('chat', chatId) : null;
    const refs = {
      ...(chatRef ? { chat_ref: chatRef } : {}),
      ...(episode != null ? { episode_ref: reference('episode', chatRef ?? kind, episode) } : {}),
      ...(noticeId ? { notification_ref: reference('notification', noticeId) } : {})
    };
    record(s, at, event, { ...refs, ...details });
  }

  function identifyChat(s, rowId, chatId) {
    const index = s.notificationLogIndex;
    if (!index || !chatId || rowId === chatId) return;
    const rowKey = JSON.stringify(['chat', rowId]);
    if (!index[rowKey]) return;
    index[JSON.stringify(['chat', chatId])] ??= index[rowKey];
    delete index[rowKey];
  }

  function parsedTime(s, at, refs, surface, stamp) {
    if (!timeSources.includes(stamp?.source)) return;
    const utc = Number.isSafeInteger(stamp.at) && Math.abs(stamp.at) <= 8.64e15 ? new Date(stamp.at).toISOString() : null;
    const rejected = [];
    for (const item of Array.isArray(stamp.rejected) ? stamp.rejected.slice(0, 2) : []) {
      if (!['datetime', 'title'].includes(item?.source) || !timeReasons.includes(item.reason)) continue;
      rejected.push({ source: item.source, reason: item.reason, delta_ms: Number.isSafeInteger(item.deltaMs) ? item.deltaMs : null });
    }
    diagnostic(s, at, 'message_time_parsed', refs, {
      surface, source: stamp.source, precision: ['exact', 'minute', 'day'].includes(stamp.precision) ? stamp.precision : null,
      timezone_source: ['explicit', 'assumed_local'].includes(stamp.timezone) ? stamp.timezone : null,
      offset_minutes: Number.isInteger(stamp.offsetMinutes) && Math.abs(stamp.offsetMinutes) < 1440 ? stamp.offsetMinutes : null,
      timestamp_utc: utc, ...(timeReasons.includes(stamp.reason) ? { reason: stamp.reason } : {}),
      ...(rejected.length ? { rejected_exact: rejected } : {})
    });
  }

  function reportReferences(events) {
    // Buffered hours can move to a different shift. Scope their references to the
    // actual report when it closes so exports cannot be linked across shifts.
    const scoped = new Map();
    return events.map(entry => {
      if (!entry.details || !referenceFields.some(field => entry.details[field])) return entry;
      const details = { ...entry.details };
      for (const field of referenceFields) {
        const original = details[field];
        if (!original) continue;
        if (!scoped.has(original)) scoped.set(original, crypto.randomUUID());
        details[field] = scoped.get(original);
      }
      return { ...entry, details };
    });
  }

  function begin(s, now, held) {
    if (!held) delete s.notificationLogIndex;
    const log = journal(s).active = {
      id: crypto.randomUUID(), openedAt: now, firstDutyPeriod: null, lastDutyPeriod: null,
      nextOnDuty: null, dutyMatchVersion: DUTY_MATCH_VERSION,
      initialChecked: s.checked || 0, initialNotified: s.notified || 0, events: [], omitted: 0,
      ...(held ? { held } : {})
    };
    record(s, now, 'monitor_started', { mode: s.scan.mode, pinnedInstant: s.scan.pinnedImmediate !== false });
    return log;
  }

  function start(s, now) {
    if (s.shiftLogs?.active || s.shiftLogs?.review) record(s, now, 'monitor_resumed');
    else begin(s, now);
  }

  function startFromReview(s, now) {
    const { review } = s.shiftLogs;
    const { period, held } = review;
    delete s.shiftLogs.review;
    const first = held.hours[period];
    const earliest = first?.firstAt ?? held.events.find(event => engine.calendarPeriodAt(event.at) === period)?.at ?? period;
    const log = begin(s, Math.min(now, earliest), held);
    for (const totals of Object.values(held.hours)) {
      log.initialChecked -= totals.checked;
      log.initialNotified -= totals.notified;
    }
    return log;
  }

  function finish(s, endedAt, reason, details, now = endedAt) {
    const logs = s.shiftLogs;
    const log = logs?.active ?? (logs?.review && reason !== 'schedule' ? startFromReview(s, endedAt) : null);
    if (!log) return;
    // A delayed schedule lookup can close an earlier session while monitoring is already awake again.
    acceptBefore(log, reason === 'schedule' ? endedAt : Infinity);
    const { held, ...resolved } = log;
    const unconfirmed = Object.values(held?.hours ?? {});
    const checked = (s.checked || 0) - log.initialChecked - unconfirmed.reduce((sum, hour) => sum + hour.checked, 0);
    const notified = (s.notified || 0) - log.initialNotified - unconfirmed.reduce((sum, hour) => sum + hour.notified, 0);
    append(resolved, { at: now, event: 'shift_finished', details: { reason, ...details } });
    logs.pending.push({
      ...resolved, events: reportReferences(resolved.events), endedAt, reason, checked, notified, retryAt: 0, downloadId: null
    });
    logs.active = null;
    if (reason !== 'schedule' || !held?.events.length) delete s.notificationLogIndex;
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

  function remainingHours(held, after) {
    if (!held) return null;
    held.events = held.events.filter(event => event.at >= after);
    for (const hour of Object.keys(held.hours)) {
      if (Number(hour) < after) delete held.hours[hour];
    }
    const period = Math.min(...Object.keys(held.hours).map(Number));
    return Number.isFinite(period) ? { period, held } : null;
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
    const logs = s.shiftLogs;
    migrateDutyMatch(logs?.active);
    while (logs?.active || logs?.review) {
      if (logs.review) {
        const { period, held, id } = logs.review;
        if (period > calendar) break;
        const duty = onDuty(rosterAt(period));
        if (duty === null) break;
        if (duty) {
          markDuty(startFromReview(s, now), period, now);
        } else {
          const remaining = remainingHours(held, period + HOUR);
          if (remaining) logs.review = { ...remaining, id };
          else delete logs.review;
        }
        continue;
      }

      const log = logs.active;
      if (!Number.isFinite(log.lastDutyPeriod)) break;
      const next = log.lastDutyPeriod + HOUR;
      const upcoming = rosterAt(next);
      if (upcoming) log.nextOnDuty = onDuty(upcoming);
      if (now < next || typeof log.nextOnDuty !== 'boolean') break;
      if (!log.nextOnDuty) {
        const remaining = remainingHours(finish(s, next, 'schedule', undefined, now), next + HOUR);
        if (remaining) logs.review = { ...remaining, id: crypto.randomUUID() };
      } else {
        markDuty(log, next, now);
      }
    }
    if (!logs?.review && currentDuty === true && (enabled || logs?.active) &&
        !Number.isFinite(logs?.active?.lastDutyPeriod)) {
      const log = logs?.active ?? begin(s, now);
      markDuty(log, calendar, now);
      log.nextOnDuty = onDuty(rosterAt(calendar + HOUR));
    }
    if (!logs?.active && !logs?.review) delete s.notificationLogIndex;
  }

  function missingHour(s, now) {
    const log = s.shiftLogs?.active;
    const last = log?.lastDutyPeriod;
    const next = s.shiftLogs?.review?.period ?? (Number.isFinite(last) ? last + HOUR : null);
    if (!Number.isFinite(next) || typeof log?.nextOnDuty === 'boolean') return null;
    const calendar = engine.calendarPeriodAt(now);
    return next < calendar || (!s.scan.enabled && next === calendar) ? next : null;
  }

  function lookupId(s) {
    return s.shiftLogs?.review?.id ?? s.shiftLogs?.active?.id;
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
    start, record, diagnostic, identifyChat, parsedTime, observe, missingHour, lookupId, confirmHour, finish, nextBoundary, filename, render
  });
})();
