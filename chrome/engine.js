/* The worker serializes these transitions and saves the entire state after each one.
 * A job is only a ticket. The queue entry remains durable until its result commits. */
(() => {
  'use strict';
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const RECENT_MAX_AGE = 20 * MIN; // Matches the recent list limit in dom.js.
  const WAIT_MAX_AGE = 12 * HOUR;
  const minute = at => Math.floor(at / MIN) * MIN;
  // Moscow is UTC+3, an integral number of hours. Epoch-hour boundaries coincide.
  const periodAt = now => Math.floor((now + 5 * MIN) / HOUR) * HOUR;
  const nextHour = now => Math.floor(now / HOUR) * HOUR + HOUR;
  const boundary = (now, s) => (s?.period ?? periodAt(now)) + 55 * MIN;
  const prefetchTime = (now, s) => boundary(now, s) - MIN;
  const freshlyPrepared = (s, period) => s.prepared?.period === period && s.prepared.readAt >= period - 6 * MIN;
  function inWindow(c, now) {
    return c.precision !== 'day' && recent(c.at, now);
  }
  function recent(at, now) {
    return Number.isFinite(at) && at <= now && now - at < RECENT_MAX_AGE;
  }
  function tooOld(at, now) {
    return Number.isFinite(at) && now - at > WAIT_MAX_AGE;
  }
  function waitingSince(c, now) {
    return Number.isFinite(c.waitSince) && !tooOld(c.waitSince, now) ? c.waitSince : null;
  }
  const hasChecked = c => c.checked && c.checked.at === c.at && c.checked.signal === c.signal;

  function fresh() {
    return { enabled: false, generation: 0, baseline: false, rowsObservedAt: null, period: null,
      roster: null, directory: [], appliedPeriod: null, prepared: null,
      prefetchError: '', prefetchRetryAt: 0, scheduleError: '', scheduleRetryAt: 0, scheduleReadAt: null,
      mode: 'normal', pinnedImmediate: true, curatorName: '', startedAt: null, startTarget: null,
      coveragePending: false, handover: null, chats: {}, dismissedFree: {}, inactiveRows: {}, offDutyReviewQueued: true };
  }

  function start(s, now) {
    s.generation++;
    s.enabled = true;
    s.startedAt = now;
    s.coveragePending = false;
    s.startTarget = nextHour(now);
    s.prepared = null;
    s.prefetchError = '';
    s.prefetchRetryAt = 0;
    advance(s, now);
    if (s.period === s.startTarget) s.roster = null;
    s.scheduleError = '';
    s.scheduleRetryAt = now;
  }
  function stop(s) {
    s.enabled = false;
    s.generation++;
  }
  function finish(s) {
    const count = Object.values(s.chats).filter(c => c.binding || c.pinnedColleague).length;
    const generation = s.generation + 1;
    const { mode = 'normal', pinnedImmediate = true, curatorName = '' } = s;
    Object.assign(s, fresh(), { generation, mode, pinnedImmediate, curatorName });
    return count;
  }
  function enqueue(c, now, reason, reset = false, urgent = false) {
    if (!inWindow(c, now)) return;
    if (!c.pending || reset) {
      c.pending = { tries: 0, due: now, reason, urgent };
      c.serial++;
    } else if (urgent) c.pending.urgent = true;
  }
  function queueSeniorBackfill(s, now) {
    if (!s.enabled || s.mode !== 'senior' || !s.roster) return;
    for (const c of Object.values(s.chats)) {
      if (!c.binding && c.pinnedColleague) c.binding = { id: c.id, ...c.pinnedColleague };
      // Older bindings have an activity stamp but no confirmed history metadata.
      if (c.binding && !c.pending && !Number.isFinite(c.lastMessageAt)) enqueue(c, now, 'senior-backfill');
    }
  }
  function queueOffDutyReview(s, now) {
    if (s.offDutyReviewQueued || !Array.isArray(s.roster) || !s.roster.length || s.appliedPeriod !== s.period) return;
    s.offDutyReviewQueued = true;
    // Version 1.7.2 did not keep the reply author in ordinary chat records.
    // Read only recent, confirmed waits affected by the former two-hour rule.
    for (const c of Object.values(s.chats)) {
      if (c.status === 'Ожидает проверки' && !c.activityDirty && !c.binding && !c.pinnedColleague &&
          c.transferAt == null && c.transferReviewAt == null && !c.dismissedFree && !c.undoAnchor &&
          c.waitKey && c.lastReplyKey && Number.isFinite(c.lastReplyAt) && recent(c.lastMessageAt, now) && hasChecked(c)) {
        enqueue(c, now, 'off-duty-review', true, true);
      }
    }
  }
  function advance(s, now) {
    if (!s.enabled) return false;
    for (const [id, removed] of Object.entries(s.dismissedFree ?? {})) {
      if (removed.at <= now - RECENT_MAX_AGE) delete s.dismissedFree[id];
    }
    for (const [id, removed] of Object.entries(s.inactiveRows ?? {})) {
      if (Math.max(removed.at, removed.rowAt) <= now - RECENT_MAX_AGE) delete s.inactiveRows[id];
    }
    for (const c of Object.values(s.chats)) {
      if (tooOld(c.lastStudentAt, now) && tooOld(c.at, now) &&
          (!Number.isFinite(c.lastMessageAt) || tooOld(c.lastMessageAt, now))) {
        delete s.chats[c.id];
        continue;
      }
      if (c.transferAt != null && c.transferConfirmed !== true) {
        c.transferReviewAt = c.transferAt;
        c.transferAt = c.freeSince = null;
        c.status = 'Ожидает проверки';
        if (inWindow(c, now)) enqueue(c, now, 'handover', true, true);
      }
      if (c.transferAt != null && !recent(c.lastMessageAt, now)) {
        clearTransfer(c);
        c.freeSince = null;
        c.status = 'Ответ не требуется';
      }
      if (c.pending && (!inWindow(c, now) || !inWindow(c, c.pending.due))) {
        c.pending = null;
        c.serial++;
      }
      if (!c.pending && tooOld(c.waitSince, now) && (s.mode === 'senior' || !c.binding || canNotifyPinned(s, c))) {
        enqueue(c, now, 'waiting-review', false, true);
      }
      if (c.transferReviewAt != null && !inWindow(c, now)) clearTransfer(c);
    }
    if (!Object.hasOwn(s, 'appliedPeriod')) {
      s.appliedPeriod = s.roster ? s.period : null;
      for (const c of Object.values(s.chats)) {
        if (!c.binding && c.pinnedColleague) c.binding = { id: c.id, ...c.pinnedColleague };
        c.controlAt = c.pinDue = null;
        const checkedControl = c.pending?.reason === 'control' && hasChecked(c);
        if (checkedControl && c.status === 'Не определено') {
          // A failed periodic read in 1.5 could overwrite the original result.
          // Only restore a status that the remaining metadata actually proves.
          if (c.pinned || (c.signal != null && c.lastFree === 'id:' + c.signal)) {
            c.status = c.pinned ? 'Закреплённый' : 'Свободен';
            c.reason = '';
          } else c.reason = 'Предыдущая версия проверила активность, но не сохранила итоговый статус.';
        }
        if (checkedControl || c.pending?.reason === 'released' || (c.pending && !c.pending.tries && (hasChecked(c) || !inWindow(c, now)))) {
          c.pending = null;
          c.serial++;
          if (c.status === 'Ожидает пересмотра') {
            c.status = 'Не определено';
            c.reason = 'Владелец не был сохранён предыдущей версией.';
          }
        }
      }
    }
    if (s.period != null && s.period >= periodAt(now)) {
      queueSeniorBackfill(s, now);
      queueOffDutyReview(s, now);
      return false;
    }
    const previous = s.period;
    if (s.appliedPeriod == null && s.roster) s.appliedPeriod = previous;
    s.period = periodAt(now);
    if (s.startTarget < s.period) s.startTarget = null;
    s.roster = null;
    s.scheduleError = previous != null ? s.prefetchError || 'Не удалось обновить расписание: ожидается состав на новый час.' : '';
    s.scheduleRetryAt = now;
    s.prefetchRetryAt = 0;
    s.prefetchError = '';
    const prepared = freshlyPrepared(s, s.period) ? s.prepared : null;
    s.prepared = null;
    for (const c of Object.values(s.chats)) {
      if (!c.binding && c.pinnedColleague) c.binding = { id: c.id, ...c.pinnedColleague };
      if (!c.binding) continue;
      c.controlAt = s.period - 5 * MIN;
    }
    if (prepared?.period === s.period) activateRoster(s, prepared, now);
    return true;
  }
  function scheduleTarget(s, now, skip = new Set()) {
    if (!s.enabled) return null;
    const explicit = s.startTarget;
    if (explicit != null && !skip.has(explicit) && (explicit === s.period
      ? s.scheduleRetryAt <= now : s.prefetchRetryAt <= now)) return explicit;
    if (!s.roster && s.scheduleRetryAt <= now && !skip.has(s.period)) return s.period;
    const next = s.period + HOUR;
    if (now >= prefetchTime(now, s) && !freshlyPrepared(s, next) &&
        (s.prefetchRetryAt || 0) <= now && !skip.has(next)) return next;
    return null;
  }
  function admit(c, now, reset = false, urgent = false) {
    if (!inWindow(c, now)) return;
    if (!c.checked && !c.binding && !c.transferAt) c.status = 'Новые чаты';
    const reason = c.pending?.reason === 'control' ? 'control' : 'activity';
    enqueue(c, now, reason, reset, urgent);
  }
  function activateRoster(s, data, now) {
    const transition = s.appliedPeriod !== s.period;
    s.roster = data.names;
    s.directory = data.directory;
    s.appliedPeriod = s.period;
    s.scheduleReadAt = data.readAt;
    s.scheduleError = '';
    s.scheduleRetryAt = 0;
    if (!handoverAllowed(s, now)) s.handover = null;
    const boundaryAt = s.period - 5 * MIN;
    for (const c of Object.values(s.chats)) {
      if (!c.binding && c.pinnedColleague) c.binding = { id: c.id, ...c.pinnedColleague };
      if (c.binding && transition) {
        const name = s.roster.find(n => normal(n) === normal(c.binding.curator));
        if (name) {
          c.binding.curator = name;
          c.binding.period = s.period;
          c.binding.until = boundary(now, s);
          c.pinnedColleague = c.pinned ? c.binding : null;
          if (c.controlAt != null) enqueue(c, now, 'control', true, true);
        } else {
          c.transferReplyAt = c.lastReplyAt ?? c.binding.replyAt;
          c.binding = c.pinnedColleague = null;
          c.transferReviewAt = inWindow(c, now) ? boundaryAt : null;
          c.transferReplyKey = c.lastReplyKey ?? null;
          c.transferAt = c.freeSince = null;
          c.status = c.transferReviewAt == null ? 'Ответ не требуется' : 'Ожидает проверки';
          c.reason = '';
          c.pending = c.controlAt = null;
          c.serial++;
          if (c.transferReviewAt != null) enqueue(c, now, 'handover', true, true);
        }
      } else if (!c.binding && c.pinned && c.transferAt == null && c.transferReviewAt == null && !c.undoAnchor && c.cachedPinReply) {
        const { curator, uncertain } = rosterMatch(c.cachedPinReply, s);
        if (curator && recentReply(c.cachedPinReply, now)) {
          bind(c, s, curator, c.cachedPinReply.at, now);
          if (!c.activityDirty && c.pending?.reason !== 'minute') c.pending = null;
          c.serial++;
        } else if (uncertain || c.status === 'Ожидает расписания') admit(c, now, true, true);
      } else if (c.pinned && c.status === 'Ожидает расписания') {
        admit(c, now, true, true);
      }
    }
    queueSeniorBackfill(s, now);
    queueOffDutyReview(s, now);
  }
  function installRoster(s, ticket, names, error, now, directory = []) {
    advance(s, now);
    const ahead = ticket.period === s.period + HOUR && (ticket.period === s.startTarget || now >= prefetchTime(now, s));
    if (!s.enabled || ticket.generation !== s.generation || (ticket.period !== s.period && !ahead)) return false;
    if (error || !Array.isArray(names) || !names.length || names.some(n => typeof n !== 'string' || !words(n).length)) {
      const why = 'Не удалось обновить расписание: ' + (error || 'на нужный час не удалось прочитать состав.');
      if (ahead && !freshlyPrepared(s, ticket.period)) {
        s.prefetchError = why;
        s.prefetchRetryAt = Math.min(boundary(now, s), now + MIN);
      } else if (!ahead && !s.roster) {
        s.scheduleError = why;
        s.scheduleRetryAt = now + 5 * MIN;
      }
      return true;
    }
    if (ticket.period === s.startTarget) s.startTarget = null;
    const roster = [...new Map(names.map(n => [normal(n), n.trim()])).values()];
    const data = { period: ticket.period, names: roster, readAt: now,
      directory: [...new Map([...roster, ...directory].map(n => [normal(n), n])).values()] };
    if (ahead) {
      s.prepared = data;
      s.prefetchError = '';
      s.prefetchRetryAt = 0;
      s.scheduleReadAt = now;
    } else {
      activateRoster(s, data, now);
    }
    return true;
  }

  // Roles and spelling are presentation details. Abbreviations are accepted only
  // if exactly one member of the roster (including the operator) matches.
  const nicknames = {
    аня: ['анна'], артемка: ['артем'], ваня: ['иван'], вова: ['владимир'],
    гоша: ['григорий', 'георгий'], гриша: ['григорий'], даша: ['дарья'],
    дима: ['дмитрий'], женя: ['евгений', 'евгения'], леша: ['алексей'],
    люба: ['любовь'], макс: ['максим'], настя: ['анастасия'], оля: ['ольга'],
    петя: ['петр'], рома: ['роман'], сева: ['всеволод'], сема: ['семен'],
    соня: ['софья', 'софия'], тоня: ['антонина'], юля: ['юлия', 'юлиана'],
    саша: ['александр', 'александра'], влад: ['владислав', 'владимир'], даня: ['даниил', 'данил'],
  };
  function words(name) {
    return String(name ?? '').normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е')
      .replace(/^\s*(?:(?:(?:старший|орг|организационный|предметный)[\s-]+)?куратор|эксперт|ментор)(?=$|[\s:–—-])[\s:–—-]*/u, '')
      .replace(/[‐‑‒–—−]/gu, '-').replace(/’/gu, "'")
      .match(/[\p{L}]+(?:[-'][\p{L}]+)*\.?/gu) ?? [];
  }
  const bare = w => w.replace(/\.$/u, '');
  const normal = n => words(n).map(bare).sort().join(' ');
  function sameCurator(a, b) {
    const key = globalThis.ShkolkovoIdentity?.key ?? normal;
    const aKey = key(a ?? '');
    return aKey !== '' && aKey === key(b ?? '');
  }
  function handoverAllowed(s, now) {
    if (s.appliedPeriod !== s.period || s.period !== periodAt(now) || !Array.isArray(s.roster)) return false;
    const ownName = configuredCurator(s);
    return s.roster.some(name => sameCurator(name, ownName));
  }
  function compatible(a, b) {
    const x = bare(a), y = bare(b);
    if (x === y) return true;
    if ((x.length === 1 || a.endsWith('.')) && y.startsWith(x)) return true;
    if ((y.length === 1 || b.endsWith('.')) && x.startsWith(y)) return true;
    return (Object.hasOwn(nicknames, x) && nicknames[x].includes(y)) ||
      (Object.hasOwn(nicknames, y) && nicknames[y].includes(x));
  }
  function nameMatch(name, names, canPair = compatible) {
    const candidates = [...new Map(names.map(n => [normal(n), n])).values()];
    const w = words(name);
    if (!w.length) return { uncertain: true };
    const exact = candidates.find(n => normal(name) === normal(n));
    if (exact) return { name: exact };
    const possible = candidates.filter(n => {
      const t = words(n);
      const [short, long] = w.length <= t.length ? [w, t] : [t, w];
      // Match distinct words in either order, also when the source includes a patronymic.
      function pair(i, rest) {
        if (i === short.length) return true;
        return rest.some((v, k) => canPair(short[i], v) && pair(i + 1, rest.filter((_, j) => j !== k)));
      }
      return pair(0, long);
    });
    if (possible.length === 1) return { name: possible[0] };
    if (possible.length > 1 || w.length < 2 || w.some(a => bare(a).length < 2)) return { uncertain: true };
    return {}; // A fully named, explicitly identified staff author is off the current roster.
  }
  function knownCurators(s) {
    return [...(s.roster || []), ...(s.directory || [])];
  }
  function configuredCurator(s) {
    // Prefer the same registered name. When the settings omit a patronymic,
    // both recorded name parts must identify exactly one directory entry.
    return nameMatch(s.curatorName, knownCurators(s), (a, b) => bare(a) === bare(b)).name;
  }

  function getChat(s, id) {
    return Object.hasOwn(s.chats, id) ? s.chats[id] : null;
  }
  function isFree(c, now) {
    return c?.status === 'Свободен' && !c.binding && !c.pinnedColleague && !c.activityDirty &&
      Boolean(c.waitKey) && waitingSince(c, now) !== null && Number.isFinite(c.freeSince) && recent(c.lastMessageAt, now) &&
      (c.transferAt == null || c.transferConfirmed === true);
  }
  function freeVersion(c) {
    return JSON.stringify([c.lastMessageAt, c.lastMessageKey, c.waitKey, c.transferAt ?? null]);
  }
  function dismissFree(s, id, version, now) {
    const c = getChat(s, id);
    if (!isFree(c, now) || freeVersion(c) !== version) return false;
    s.dismissedFree ??= {};
    rememberRemoved(s.dismissedFree, c, c.lastMessageAt, c.lastMessageKey, c.lastCheckedMessageId);
    delete s.chats[id];
    return true;
  }
  function rememberRemoved(markers, c, at, key, signal) {
    Object.defineProperty(markers, c.id, { enumerable: true, writable: true, configurable: true, value: {
      at, rowAt: c.at, key, signal,
      unread: c.unread === true, serial: c.serial,
      aliases: [...new Set([c.rowKey, c.nativeKey, c.fallbackKey].filter(Boolean))]
    } });
  }
  function dismissal(s, id) {
    return Object.hasOwn(s.dismissedFree ?? {}, id) ? s.dismissedFree[id] : null;
  }
  function observedMarker(markers, row, canonical) {
    if (!markers) return null;
    const id = canonical || row.id;
    if (Object.hasOwn(markers, id)) return markers[id];
    if (canonical) return null;
    const matches = Object.values(markers).filter(marker => marker.aliases.includes(row.id));
    return matches.length === 1 ? matches[0] : null;
  }
  function mayHaveNewActivity(marker, row) {
    const unread = row.unread === true;
    const newlyUnread = unread && !marker.unread;
    marker.unread = unread;
    const knownAt = Math.max(marker.at, marker.rowAt);
    return row.at > knownAt || (row.at === knownAt && (newlyUnread ||
      (row.signal != null && row.signal !== marker.signal && 'id:' + row.signal !== marker.key)));
  }
  const platformId = value => /^\d+__\d+__\d+$/u.test(value || '');
  const fallbackId = value => /^\d+:/u.test(value || '');
  function put(s, c) {
    Object.defineProperty(s.chats, c.id, { enumerable: true, writable: true, configurable: true, value: c });
  }
  // Only a matching platform ID can collapse records. Preserve a confirmed
  // colleague, the newest checked result and the latest independently observed activity.
  function identify(s, c, identity) {
    if (!platformId(identity) || !(fallbackId(c.id) || c.id.startsWith('id:'))) return c;
    const canonical = 'id:' + identity;
    c.identity = identity;
    if (c.id === canonical) return c;
    c.rowKey ??= c.id;
    if (fallbackId(c.id)) c.fallbackKey ??= c.id;
    else c.nativeKey ??= c.id;
    const old = getChat(s, canonical);
    delete s.chats[c.id];
    if (old) {
      const inspected = (old.lastViewedAt || 0) >= (c.lastViewedAt || 0) ? old : c;
      const latest = old.at > c.at ? old : c;
      const undoAnchor = old.undoAnchor || c.undoAnchor;
      const muted = old.muted ?? c.muted;
      const binding = undoAnchor ? null : old.binding || c.binding || old.pinnedColleague || c.pinnedColleague;
      const aliases = { rowKey: c.rowKey, rowPosition: c.rowPosition, fallbackKey: c.fallbackKey || old.fallbackKey,
        nativeKey: c.nativeKey || old.nativeKey };
      Object.assign(old, inspected, { at: latest.at, signal: latest.signal, precision: latest.precision,
        visible: old.visible || c.visible, pinned: latest.pinned, binding, pinnedColleague: latest.pinned ? binding : null,
        undoAnchor, muted }, aliases);
      if (binding || hasChecked(old)) old.pending = null;
      else old.pending = latest.pending || c.pending || old.pending;
      old.serial++;
      c = old;
    }
    c.id = canonical;
    if (c.binding) c.binding.id = canonical;
    if (c.pinnedColleague) c.pinnedColleague.id = canonical;
    put(s, c);
    return c;
  }
  function rowIndex(s) {
    const index = new Map();
    for (const c of Object.values(s.chats)) {
      const verifiedFallback = platformId(c.identity) ? c.fallbackKey : null;
      for (const id of new Set([c.id, c.nativeKey, verifiedFallback].filter(Boolean))) {
        if (!index.has(id)) index.set(id, []);
        index.get(id).push(c);
      }
    }
    return index;
  }
  function observationId(row) {
    const explicit = row.id.startsWith('id:') && row.id.slice(3);
    return platformId(explicit) ? explicit : platformId(row.identity) ? row.identity : null;
  }
  function navigation(s, id) {
    if (typeof id !== 'string') return null;
    let c = getChat(s, id);
    if (!c) {
      const matches = rowIndex(s).get(id);
      if (matches?.length === 1) [c] = matches;
    }
    if (!c?.visible) return null;
    const rowKey = c.rowKey || c.id;
    const ambiguous = fallbackId(rowKey) && rowIndex(s).get(rowKey)?.length > 1;
    return { id: rowKey, identity: c.identity, ...(c.rowPosition ? { position: c.rowPosition } : {}),
      ...(ambiguous ? { requireSelectedIdentity: true } : {}) };
  }
  function cursor(at, signal, precision, now) {
    // A date-only list row bounds the old tail somewhere within that Moscow day.
    const floor = precision === 'day' ? Math.min(now, at + 24 * HOUR - 1) : at;
    return { at: floor, keys: null, signal };
  }
  function observeAssignment(c, value, source) {
    // Lists and conversation headers may expose different metadata. A missing
    // badge only withdraws evidence from the surface that was just inspected.
    c[source] = value === true;
    if (value === false) c.rowAssignment = c.panelAssignment = false;
    c.assignedToSelf = Boolean(c.rowAssignment || c.panelAssignment);
  }
  function track(s, row, now, removed) {
    const arrived = row.precision !== 'day' && row.at >= minute(s.startedAt ?? now);
    const occurredSinceStart = Number.isFinite(s.startedAt) && (row.precision === 'exact'
      ? row.at >= s.startedAt : row.at > minute(s.startedAt));
    const c = { id: row.id, title: row.title, at: row.at, signal: row.signal ?? null,
      pinned: !!row.pinned, visible: true,
      binding: null, pinnedColleague: null, lastViewedAt: null, serial: removed ? removed.serial + 1 : 0, pending: null,
      checked: null, controlAt: null, pinDue: null, lastFree: null, status: '', reason: '',
      cutoff: null,
      precision: row.precision ?? 'minute', identity: null, unread: row.unread === true };
    if (c.pinned && removed) c.cutoff = { at: removed.at, keys: [removed.key], signal: removed.signal };
    else if (c.pinned && !c.unread && !occurredSinceStart && !(s.baseline && arrived)) {
      c.cutoff = cursor(row.at, row.signal ?? null, row.precision, now);
    }
    observeAssignment(c, row.assignedToSelf, 'rowAssignment');
    put(s, c);
    admit(c, now, false, c.unread || arrived);
    return c;
  }
  function observe(s, rows, now, observedAt = now, { partial = false } = {}) {
    if (!s.enabled) return;
    advance(s, now);
    if (!Number.isFinite(observedAt) || observedAt > now || observedAt < (s.rowsObservedAt ?? 0)) return;
    s.rowsObservedAt = observedAt;
    for (const c of Object.values(s.chats)) {
      if (!partial) c.visible = false;
      identify(s, c, c.identity); // Includes checked fallback keys from version 1.5.
    }
    const index = rowIndex(s);
    const namedNativeRows = new Set(rows.filter(row => typeof row?.id === 'string' && row.id.startsWith('id:'))
      .map(row => row.fallbackKey));
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !row.id || !Number.isFinite(row.at) || row.at > now) continue;
      const identity = observationId(row);
      const canonical = identity && 'id:' + identity;
      if (!identity && fallbackId(row.id) && namedNativeRows.has(row.id)) continue;
      const candidates = index.get(row.id) || [];
      const matching = identity ? candidates.filter(c => !c.identity || c.identity === identity) : candidates;
      if (matching.length > 1 && !canonical) continue; // A name shared by two known IDs cannot identify a row.
      if (identity && matching.length === 1 && matching[0].id !== canonical) identify(s, matching[0], identity);
      const prior = (canonical && getChat(s, canonical)) || matching[0];
      const dismissed = prior ? null : observedMarker(s.dismissedFree, row, canonical);
      const inactive = prior ? null : observedMarker(s.inactiveRows, row, canonical);
      if (!prior && (!inWindow(row, now) || (dismissed && !mayHaveNewActivity(dismissed, row)) ||
          (inactive && !mayHaveNewActivity(inactive, row)))) continue;
      let c = prior || track(s, { ...row, id: canonical || row.id }, now, inactive || dismissed);
      if (identity) c = identify(s, c, identity);
      c.rowKey = row.id; // Navigation always uses the current document's row key.
      if (Number.isInteger(row.position) && row.position > 0) c.rowPosition = row.position;
      if (row.fallbackKey) c.fallbackKey = row.fallbackKey;
      if (row.id.startsWith('id:') && row.id !== c.id) c.nativeKey = row.id;
      if (!prior) continue;
      c.visible = true;
      c.title = row.title;
      // Upgrade records produced by the version that kept pinned ownership separately.
      if (!c.binding && c.pinnedColleague) c.binding = { id: c.id, ...c.pinnedColleague };
      observeAssignment(c, row.assignedToSelf, 'rowAssignment');
      const unread = row.unread === true;
      const newlyUnread = unread && !c.unread;
      c.unread = unread;
      const signal = row.signal ?? null;
      const adoptedCheckedId = signal && hasChecked(c) && c.lastCheckedMessageId === signal &&
        (c.signal == null || String(c.signal).startsWith('panel:'));
      const changed = row.at > c.at || (row.at === c.at && signal !== null && signal !== c.signal && !adoptedCheckedId);
      if (!!row.pinned !== c.pinned) {
        // The star itself is never evidence of activity. If the timestamp advanced as
        // well, use the old stamp as the floor so independent messages can still pass.
        c.pinned = !!row.pinned;
        c.pinnedColleague = c.pinned ? c.binding : null;
        c.serial++;
        c.cutoff = c.pinned ? c.checkpoint || cursor(c.at, c.signal, c.precision, now) : null;
      }
      if (changed) {
        c.at = row.at;
        c.signal = signal;
        c.precision = row.precision ?? 'minute';
        c.activityDirty = true;
        if (inWindow(c, now)) admit(c, now, true, true);
        else { c.pending = null; c.serial++; }
      } else if (row.at === c.at && signal !== null && (c.signal === null || adoptedCheckedId)) {
        if (adoptedCheckedId) c.checked.signal = signal;
        c.signal = signal;
      }
      if (newlyUnread && !changed) {
        c.activityDirty = true;
        admit(c, now, !c.pending, true);
      }
      const needsReview = !hasChecked(c) || (c.checked && !Object.hasOwn(c, 'waitSince'));
      if (!c.binding && !c.pending && needsReview) admit(c, now, false, unread);
    }
    if (!partial) {
      s.baseline = true;
      s.coveragePending = false;
    }
  }

  function reconcileRows(s, keys) {
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string')) return;
    const present = new Set(keys);
    for (const c of Object.values(s.chats)) {
      c.visible = [c.id, c.rowKey, c.nativeKey, c.fallbackKey].some(key => present.has(key));
    }
    s.baseline = true;
    s.coveragePending = false;
  }

  // The content script may see a new tail on a panel that is already open even
  // when the list publishes neither message IDs nor seconds. No navigation is
  // requested to obtain this evidence; a verified, changed tail becomes work.
  function panelChanged(s, event, now) {
    advance(s, now);
    if (!s.enabled || !event || typeof event.signal !== 'string' || !event.signal.startsWith('panel:') ||
        !event.identity || event.signal === event.previous) return false;
    const c = getChat(s, 'id:' + event.identity) || getChat(s, event.id);
    if (!c || !c.visible || c.at !== event.at || c.identity !== event.identity || !hasChecked(c) || !inWindow(c, now)) return false;
    if (c.signal != null && (!String(c.signal).startsWith('panel:') || c.signal !== event.previous)) return false;
    c.signal = event.signal;
    c.activityDirty = true;
    admit(c, now, true, true);
    return true;
  }

  function deadline(s, c, now) {
    if (!c.visible || (!c.pinned && !s.roster) || !c.pending || !inWindow(c, now) || !inWindow(c, c.pending.due)) return Infinity;
    if (c.binding && (!s.roster || (s.mode !== 'senior' && c.pending.reason !== 'control' && !canNotifyPinned(s, c)))) {
      return Infinity;
    }
    return c.pending.due;
  }
  function earliest(s, now) {
    if (!s.enabled) return Infinity;
    let due = Infinity;
    for (const c of Object.values(s.chats)) {
      due = Math.min(due, deadline(s, c, now));
    }
    return due;
  }
  function next(s, now) {
    if (!s.enabled) return null;
    advance(s, now);
    let best = null;
    for (const c of Object.values(s.chats)) {
      if (deadline(s, c, now) > now) continue;
      const priority = Number(!!c.pending.urgent);
      const current = Number(!!best?.pending.urgent);
      if (!best || priority > current || (priority === current && (c.at > best.at ||
          (c.at === best.at && c.pinned && !best.pinned)))) best = c;
    }
    if (!best) return null;
    const needsReplyAuthor = best.status === 'Ожидает проверки' && best.transferReviewAt == null;
    return { id: best.id, rowKey: best.rowKey || best.id, title: best.title, at: best.at, signal: best.signal, identity: best.identity, startedAt: now,
      expiresAt: best.at + RECENT_MAX_AGE,
      position: best.rowPosition, waitKey: needsReplyAuthor ? undefined : best.waitKey, waitSince: best.waitSince,
      cursorSignal: best.cutoff?.signal, cursorKeys: best.cutoff?.keys,
      sinceAt: best.pinned ? best.cutoff?.at : undefined,
      pinned: best.pinned, serial: best.serial, generation: s.generation, period: s.period };
  }
  function valid(s, job, now) {
    advance(s, now);
    if (!s.enabled || !job || s.generation !== job.generation || s.period !== job.period || (!job.pinned && !s.roster)) return null;
    const c = getChat(s, job.id);
    return c?.visible && c.serial === job.serial && c.pinned === job.pinned && c.at === job.at && c.signal === job.signal &&
      deadline(s, c, now) <= now ? c : null;
  }
  function defer(s, job, now, delayMs = MIN) {
    const c = valid(s, job, now);
    if (c) { c.pending.due = now + delayMs; c.serial++; }
  }

  function retry(c, reason, now) {
    if (!c.checked && !c.binding && !c.transferAt) c.status = 'Не определено';
    c.reason = reason;
    const p = c.pending;
    p.tries = Math.min(3, p.tries + 1);
    p.due = now + (p.tries < 3 ? 4000 : 5 * MIN);
    c.serial++;
    return [];
  }

  function keyed(messages) {
    const counts = new Map();
    return messages.map(m => {
      const base = JSON.stringify([normal(m.author), m.at]);
      const seq = (counts.get(base) || 0) + 1;
      counts.set(base, seq);
      const key = m.id != null ? 'id:' + m.id : JSON.stringify([base, m.ordinal ?? seq]);
      return { ...m, key };
    });
  }
  function cursorIndex(messages, floor) {
    const key = floor.keys?.at(-1) ?? (floor.signal == null ? null : 'id:' + floor.signal);
    // DOM history may omit seconds that the list publishes. The ID is the anchor.
    return key == null ? -1 : messages.findIndex(m => m.key === key);
  }
  function checkpoint(messages) {
    const at = messages.at(-1).at;
    return { at, keys: messages.filter(m => m.at === at).map(m => m.key), signal: null };
  }
  const isReply = m => m.role === 'staff' || m.role === 'own';
  const knownRole = m => ['student', 'staff', 'own', 'service'].includes(m.role);
  const asks = m => m.role === 'student' && m.requiresReply !== false;
  const recentReply = (m, now) => m.at >= now - 2 * HOUR;
  function normalPinNotices(s, c) {
    const binding = c.binding || c.pinnedColleague;
    return c.pinned && c.transferAt == null && (!binding || sameCurator(binding.curator, configuredCurator(s)));
  }
  function canNotifyPinned(s, c) {
    if (s.pinnedImmediate === false) return false;
    return s.mode === 'senior' ? c.pinned && c.transferAt == null && !c.muted : normalPinNotices(s, c);
  }

  function rosterMatch(message, s) {
    if (!message || !s.roster) return {};
    const match = nameMatch(message.author, knownCurators(s));
    if (match.uncertain) return match;
    const curator = match.name && s.roster.find(name => normal(name) === normal(match.name));
    if (curator || message.role !== 'staff' || sameCurator(match.name, configuredCurator(s))) return { curator };
    // An exact directory entry can differ from an abbreviated active roster entry.
    // Leave ownership unresolved when the abbreviation could refer to this author.
    const active = nameMatch(message.author, s.roster);
    if (active.uncertain || (active.name && s.roster.some(name => normal(name) === normal(active.name)))) {
      return { uncertain: true };
    }
    return { offDuty: Boolean(match.name) || words(message.author).every(word => !word.endsWith('.')) };
  }
  function clearTransfer(c) {
    c.transferAt = c.transferReviewAt = c.transferReplyKey = c.transferReplyAt = null;
    c.transferConfirmed = false;
  }
  function bind(c, s, curator, replyAt, now) {
    c.binding = { id: c.id, curator, replyAt, period: s.period, until: boundary(now, s) };
    c.pinnedColleague = c.pinned ? c.binding : null;
    clearTransfer(c);
    c.freeSince = null;
    c.status = 'Занят';
  }

  function historyFacts(c, h, messages, now) {
    const replyIndex = messages.findLastIndex(isReply);
    const reply = messages[replyIndex];
    const afterReply = messages.slice(replyIndex + 1);
    const waitIndex = c.waitKey ? messages.findIndex(m => m.key === c.waitKey) : -1;
    const continuing = waitIndex >= 0 && waitIndex > replyIndex;
    const atStart = h.startReached === true || (h.startReached === undefined && h.complete === true);
    const last = messages.at(-1);
    if (afterReply.some(m => !knownRole(m))) return { reason: 'Не удалось однозначно определить автора сообщения.' };
    const first = afterReply.find(asks);
    const needsHistory = (first || c.waitKey) && !reply && !atStart && !continuing;
    let wait = continuing && !reply && !atStart ? messages[waitIndex] : first;
    if (needsHistory) {
      if (c.waitKey && Number.isFinite(c.lastMessageAt) && tooOld(c.waitSince, now)) {
        // The previous check established an outlier. A known recent question
        // in an otherwise verified tail gives a conservative new baseline.
        wait = afterReply.find(message => asks(message) && now - message.at <= RECENT_MAX_AGE);
      } else wait = null;
      if (!wait) return { reason: 'Не подтверждено начало истории или последний ответ куратора.' };
    } else if (tooOld(wait?.at, now)) {
      const confirmed = continuing && messages[waitIndex];
      // Keep a replacement already confirmed for this unanswered episode.
      wait = confirmed && asks(confirmed) && !tooOld(confirmed.at, now) ? confirmed
        : afterReply.find(message => asks(message) && now - message.at <= RECENT_MAX_AGE);
    }
    return { reply, last, wait, continuing,
      lastReplyAt: reply?.at ?? (atStart ? null : c.lastReplyAt ?? null),
      lastReplyKey: reply?.key ?? (atStart ? null : c.lastReplyKey ?? null) };
  }
  function newPinnedMessages(c, h, messages) {
    if (!c.pinned) return [];
    const floor = c.cutoff;
    const last = messages.at(-1);
    if (!floor) return last.role === 'student' ? [last] : [];
    const anchor = cursorIndex(messages, floor);
    const baselineOnly = !floor.keys && last.at <= floor.at && anchor < 0;
    if (messages[0].at >= floor.at && !baselineOnly && anchor < 0 && !h.startReached && !h.sinceCovered &&
        !(h.complete && h.startReached === undefined)) {
      return { reason: 'Не загрузились сообщения до предыдущей проверки закреплённого чата.' };
    }
    const freshMessages = anchor >= 0 ? messages.slice(anchor + 1) : messages.filter(m => m.at > floor.at);
    if (freshMessages.some(m => !knownRole(m))) return { reason: 'Не удалось определить автора сообщения в закреплённом чате.' };
    return freshMessages.filter(m => m.role === 'student');
  }
  function canRebind(c, messages) {
    if (!c.undoAnchor) return true;
    const { lastKey, lastAt, studentKey } = c.undoAnchor;
    const anchor = messages.findIndex(m => m.key === lastKey);
    const later = anchor >= 0 ? messages.slice(anchor + 1) : messages.filter(m => m.at > lastAt);
    if (!later.some(m => m.role === 'student' && m.key !== studentKey)) return false;
    c.undoAnchor = null;
    return true;
  }
  function actionableAfterDismissal(marker, last, messages, job) {
    if (!asks(last) || last.at < marker.at || last.key === marker.key) return false;
    if (last.at > marker.at) return true;
    if (messages.slice(0, -1).some(message => message.key === marker.key)) return true;
    return last.id != null && job.signal === last.id && last.id !== marker.signal;
  }
  function notice(c, kind, phase, at, key, now) {
    return { kind, phase, id: c.id, title: c.title, at, key, episode: c.waitKey,
      minutes: Math.max(0, Math.floor((now - at) / MIN)), curator: c.binding?.curator };
  }
  function freeNotice(s, c, now) {
    if (!isFree(c, now) || c.transferAt != null || c.freeNotifiedEpisode === c.waitKey) return null;
    c.freeNotifiedEpisode = c.waitKey;
    const elapsed = Math.floor((now - c.waitSince) / MIN);
    c.remindedMinute = Math.max(c.remindedMinute || 0, dueMinute(policy(s, c, now), elapsed));
    return notice(c, 'free', 'now', c.waitSince, c.waitKey, now);
  }

  function apply(s, job, history, now) {
    const h = history;
    let c = valid(s, job, now);
    if (!c) return [];
    if (!h?.ready || h.id !== c.id || !Array.isArray(h.messages) || !h.messages.length ||
        (c.identity && c.identity !== h.identity) ||
        ((fallbackId(c.id) || c.id.startsWith('id:')) && !platformId(h.identity))) {
      return retry(c, h?.reason || 'Не подтверждены нужная переписка и загрузка истории.', now);
    }
    const messages = h.messages;
    if (messages.some((m, i) => !Number.isFinite(m.at) || m.at > now || (i && messages[i - 1].at > m.at)) ||
        minute(messages.at(-1).at) < minute(job.at)) return retry(c, 'История не соответствует последней активности.', now);
    if (platformId(h.identity) && messages.some(m => typeof m.id !== 'string' || !m.id)) {
      return retry(c, 'Не подтверждены идентификаторы сообщений.', now);
    }
    const list = keyed(messages);
    if (new Set(list.map(m => m.key)).size !== list.length) return retry(c, 'Идентификаторы сообщений повторяются.', now);
    const last = list.at(-1);
    if (!recent(last.at, now)) {
      c.pending = null;
      c.serial++;
      return [];
    }
    if (job.signal != null && !String(job.signal).startsWith('panel:') && last.id != null && minute(last.at) === minute(job.at) &&
        String(job.signal) !== String(last.id)) return retry(c, 'Идентификатор последнего сообщения ещё не совпал со списком.', now);
    if (h.identity) {
      c = identify(s, c, h.identity);
      if (c.identity == null) c.identity = h.identity;
      if (!c.pending) return [];
    }
    const participant = list.findLast(message => message.role === 'student' || isReply(message));
    if (participant && (!Number.isFinite(c.lastParticipantAt) || participant.at > c.lastParticipantAt)) {
      c.lastParticipantAt = participant.at;
    }
    const studentIndex = list.findLastIndex(message => message.role === 'student');
    const student = list[studentIndex];
    if (tooOld(student?.at, now) && list.slice(studentIndex + 1).every(knownRole)) {
      s.inactiveRows ??= {};
      rememberRemoved(s.inactiveRows, c, last.at, last.key, last.id == null ? c.signal : String(last.id));
      delete s.chats[c.id];
      return [];
    }
    if (student && !tooOld(student.at, now) && Object.hasOwn(s.inactiveRows ?? {}, c.id)) delete s.inactiveRows[c.id];
    const facts = historyFacts(c, h, list, now);
    const pinMessages = newPinnedMessages(c, h, list);
    if (facts.reason || pinMessages.reason) return retry(c, facts.reason || pinMessages.reason, now);
    const { reply, wait, lastReplyAt, lastReplyKey } = facts;
    if (student) {
      c.lastStudentKey = student.key;
      c.lastStudentAt = student.at;
    }
    if (c.pending.reason === 'off-duty-review' && !reply && h.startReached !== true) {
      return retry(c, 'Не подтверждён автор последнего ответа куратора.', now);
    }
    const { curator, uncertain, offDuty } = rosterMatch(reply, s);
    const transferAt = c.transferAt ?? c.transferReviewAt;
    if (uncertain && (recentReply(reply, now) || c.binding || transferAt != null)) {
      const notices = retry(c, 'Не удалось однозначно сопоставить куратора с расписанием.', now);
      // A known curator role establishes a reply even if the schedule cannot
      // distinguish two people by name. Retry ownership without reviving a wait.
      if (!wait || (c.waitKey && c.waitKey !== wait.key)) {
        clearTransfer(c);
        c.waitKey = c.waitSince = c.freeSince = null;
        c.activityDirty = true;
        c.status = c.binding ? 'Занят' : 'Последним ответил куратор';
      }
      return notices;
    }
    const take = canRebind(c, list);
    const removed = dismissal(s, c.id);
    c.dismissedFree = Boolean(removed && !actionableAfterDismissal(removed, last, list, job));
    if (removed && !c.dismissedFree) delete s.dismissedFree[c.id];
    const previousReplyKey = c.lastReplyKey;
    const keepFree = c.status === 'Свободен' && wait && c.waitKey === wait.key && previousReplyKey === lastReplyKey;
    const previousBinding = c.binding;
    const continuingBinding = previousBinding && (!reply ||
      (curator && normal(curator) === normal(previousBinding.curator) &&
        (previousReplyKey == null || previousReplyKey === lastReplyKey)));
    const positiveReply = transferAt != null && reply && reply.key !== c.transferReplyKey &&
      (reply.at >= transferAt || (Number.isFinite(c.transferReplyAt) && reply.at > c.transferReplyAt) ||
        list.findIndex(m => m.key === c.transferReplyKey) >= 0);
    const transferWaiting = transferAt != null && !positiveReply && Boolean(wait) && (asks(last) || keepFree);
    c.lastViewedAt = now;
    observeAssignment(c, h.assignedToSelf, 'panelAssignment');
    c.lastMessageAt = last.at;
    c.lastMessageKey = last.key;
    c.lastReplyAt = lastReplyAt;
    c.lastReplyKey = lastReplyKey;
    if (c.pinned && reply) c.cachedPinReply = { at: reply.at, role: reply.role, author: reply.author };
    if (c.waitKey !== wait?.key) c.remindedMinute = 0;
    c.waitKey = wait?.key ?? null;
    c.waitSince = wait?.at ?? null;
    c.checkpoint = checkpoint(list);
    c.cutoff = c.pinned ? c.checkpoint : null;
    c.checked = { at: c.at, signal: c.signal };
    c.activityDirty = false;
    c.lastCheckedMessageId = last.id == null ? null : String(last.id);
    c.reason = '';
    c.pending = c.controlAt = c.pinDue = null;
    c.serial++;

    if (take && curator && (transferAt == null || positiveReply) && (recentReply(reply, now) || continuingBinding || positiveReply)) {
      bind(c, s, curator, reply.at, now);
    } else if (take && continuingBinding) {
      c.status = 'Занят';
    } else {
      c.binding = c.pinnedColleague = null;
      const waiting = asks(last) && wait && s.roster;
      if (!c.dismissedFree && take && transferWaiting) {
        c.transferAt = transferAt;
        c.transferReviewAt = null;
        c.transferConfirmed = true;
        c.status = 'Свободен';
        c.freeSince = c.waitSince;
        const period = transferAt + 5 * MIN;
        if (handoverAllowed(s, now) && (!s.handover || s.handover.period < period)) {
          s.handover = { period, at: transferAt, noticed: false, repeatedAt: null };
        }
      } else if (!c.dismissedFree && take && (keepFree ||
          (waiting && (offDuty || lastReplyAt == null || lastReplyAt < now - 2 * HOUR)))) {
        clearTransfer(c);
        c.status = 'Свободен';
        c.freeSince = c.waitSince;
      } else {
        clearTransfer(c);
        c.freeSince = null;
        if (c.dismissedFree) c.status = 'Убрано';
        else if (!take) c.status = 'Привязка снята';
        else if (isReply(last)) c.status = 'Последним ответил куратор';
        else if (waiting) c.status = 'Ожидает проверки';
        else if (asks(last) && wait && !s.roster) c.status = 'Ожидает расписания';
        else c.status = c.pinned ? 'Закреплённый' : 'Ответ не требуется';
        if (!c.dismissedFree && take && waiting) enqueue(c, lastReplyAt + 2 * HOUR + 1, 'age');
      }
    }
    // A minute-only row may keep the same timestamp for a later message. Verify once
    // after that minute closes, even when the list publishes no new message key.
    const afterMinute = minute(last.at) + MIN;
    if ((job.signal == null || String(job.signal).startsWith('panel:')) && afterMinute > now &&
        (!c.binding || s.mode === 'senior' || canNotifyPinned(s, c)) && (!c.pending || afterMinute < c.pending.due)) {
      enqueue(c, afterMinute, 'minute', true);
    }
    const result = !c.dismissedFree && canNotifyPinned(s, c)
      ? pinMessages.filter(m => recent(m.at, now)).map(m => notice(c, 'pinned', 'now', m.at, m.key, now)) : [];
    const initial = freeNotice(s, c, now);
    if (initial) {
      // The same confirmation can establish a free chat and a new pinned message.
      // Keep its waiting timestamp and send a single alert for that message.
      const duplicate = result.findIndex(n => n.key === initial.key);
      if (duplicate >= 0) result.splice(duplicate, 1);
      result.push(initial);
    }
    return result;
  }

  function policy(s, c, now) {
    if (c.transferAt != null || c.activityDirty || c.dismissedFree || !c.waitKey || waitingSince(c, now) === null ||
        !recent(c.lastMessageAt, now)) return null;
    if (s.mode === 'senior') {
      if (c.binding && !c.muted) return { kind: 'senior', first: 6, every: 2 };
      if (isFree(c, now)) return { kind: 'free', first: 5, every: 2 };
    } else if (normalPinNotices(s, c) || isFree(c, now)) {
      return { kind: c.pinned ? 'pinned' : 'free', marks: [5, 7, 10] };
    }
    return null;
  }
  function dueMinute(rule, elapsed) {
    if (!rule) return 0;
    if (rule.marks) return rule.marks.findLast(mark => mark <= elapsed) || 0;
    return elapsed < rule.first ? 0 : rule.first + Math.floor((elapsed - rule.first) / rule.every) * rule.every;
  }
  function nextMinute(rule, sent) {
    if (!rule) return Infinity;
    if (rule.marks) return rule.marks.find(mark => mark > sent) || Infinity;
    return sent < rule.first ? rule.first : rule.first + (Math.floor((sent - rule.first) / rule.every) + 1) * rule.every;
  }
  const transfers = (s, now) => Object.values(s.chats).filter(c => c.transferAt != null && isFree(c, now));
  function transferDue(s, now) {
    const h = s.handover;
    if (!h || !handoverAllowed(s, now) || !transfers(s, now).length) return Infinity;
    if (!h.noticed) return now;
    return h.repeatedAt == null ? h.period : h.repeatedAt + 2 * MIN;
  }
  function nextNoticeAt(s, now) {
    if (!s.enabled) return Infinity;
    let at = transferDue(s, now);
    for (const c of Object.values(s.chats)) {
      const p = policy(s, c, now);
      if (p) at = Math.min(at, c.waitSince + nextMinute(p, c.remindedMinute || 0) * MIN);
    }
    return at;
  }
  function dueNotices(s, now) {
    if (!s.enabled) return [];
    advance(s, now);
    const out = [];
    const h = s.handover;
    const handing = transfers(s, now);
    if (h && handing.length && transferDue(s, now) <= now) {
      const phase = h.noticed ? 'reminder' : 'now';
      h.noticed = true;
      if (now >= h.period) h.repeatedAt = h.period + Math.floor((now - h.period) / (2 * MIN)) * 2 * MIN;
      out.push({ kind: 'handover', phase, at: h.at, episode: h.period, count: handing.length,
        key: ['handover', h.period, h.repeatedAt ?? phase].join(':') });
    }
    for (const c of Object.values(s.chats)) {
      const p = policy(s, c, now);
      if (!p) continue;
      const elapsed = Math.floor((now - c.waitSince) / MIN);
      const due = dueMinute(p, elapsed);
      if (due <= (c.remindedMinute || 0)) continue;
      c.remindedMinute = due;
      out.push(notice(c, p.kind, 'reminder', c.waitSince, c.waitKey + ':' + due, now));
    }
    return out;
  }
  function noticeEligible(s, n, now) {
    if (!s.enabled) return false;
    if (n.kind === 'handover') return handoverAllowed(s, now) && s.handover?.period === n.episode && transfers(s, now).length > 0;
    const c = getChat(s, n.id);
    if (!c || c.dismissedFree || !recent(c.lastMessageAt, now)) return false;
    if (n.phase === 'now' && n.kind === 'pinned') {
      return canNotifyPinned(s, c) && recent(n.at, now);
    }
    if (c.activityDirty) return false;
    if (n.phase === 'now' && n.kind === 'free') return c.transferAt == null && isFree(c, now) && c.waitKey === n.episode;
    return c.waitKey === n.episode && policy(s, c, now)?.kind === n.kind &&
      (n.kind !== 'senior' || c.binding?.curator === n.curator);
  }
  function setMode(s, mode, now) {
    if (!['normal', 'senior'].includes(mode)) return false;
    s.mode = mode;
    if (mode === 'senior' && s.enabled) {
      queueSeniorBackfill(s, now);
      for (const c of Object.values(s.chats)) if (c.binding && !hasChecked(c)) admit(c, now, false, true);
    }
    return true;
  }
  function setPinnedInstant(s, enabled) {
    s.pinnedImmediate = Boolean(enabled);
  }
  function setChatMute(s, id, muted) {
    const c = getChat(s, id);
    if (!c?.binding) return false;
    c.muted = Boolean(muted);
    return true;
  }
  function unbind(s, id, now) {
    const c = getChat(s, id);
    if (!c?.binding) return false;
    c.undoAnchor = { studentKey: c.lastStudentKey ?? null, lastKey: c.lastMessageKey ?? null, lastAt: c.lastMessageAt ?? c.at };
    clearTransfer(c);
    c.binding = c.pinnedColleague = c.freeSince = c.cachedPinReply = null;
    c.status = 'Привязка снята';
    c.serial++;
    if (c.pending) c.pending.due = now;
    return true;
  }

  const api = { fresh, start, stop, finish, advance, periodAt, boundary, prefetchTime, scheduleTarget, installRoster,
    observe, reconcileRows, panelChanged, earliest, next, defer, apply, navigation,
    setMode, setPinnedInstant, dueNotices, nextNoticeAt, noticeEligible, setChatMute, unbind, isFree, freeVersion, dismissFree,
    waitingSince, isRecentChat: inWindow };
  globalThis.ChatEngine = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
