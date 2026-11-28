'use strict';
importScripts('identity.js', 'engine.js', 'schedule.js', 'notifications.js', 'time.js', 'shift-log.js');

const api = globalThis.browser ?? globalThis.chrome;
const notifications = globalThis.ShkolkovoNotifications;

const E = globalThis.ChatEngine;
const identity = globalThis.ShkolkovoIdentity;
const shiftLog = globalThis.ShkolkovoShiftLog;
const clock = globalThis.ShkolkovoTime;
const MIN = 60_000;
const TAB_RETRY = 10_000;
const PAGE_CHECK_INTERVAL = 30_000;
const JOURNAL_RETRY = 5 * MIN;
const RECOVERY_BATCH_SIZE = 8;
const TAB_BLOCKS = new Set(['in_use', 'draft', 'connection', 'loading', 'frozen', 'discarded', 'page', 'missing', 'list_scan', 'read_busy']);
const KEY = 'shkolkovo.monitor.v2';
const BOOT = 'shkolkovo.browserSession';
const HOUR_ALARM = 'shkolkovo.period';
const PREFETCH_ALARM = 'shkolkovo.prefetch';
const TASK_ALARM = 'shkolkovo.tasks';
const LOG_ALARM = 'shkolkovo.log-export';
const chatOrigin = 'https://1.shkolkovo.online';
const popupUrl = api.runtime.getURL('popup.html');
const shiftUrl = api.runtime.getURL('shift.html');
const timeLabel = value => clock.local().label(value);
const token = state => String(state.scan.generation);
const monitoring = state => state.tabSelection === 'manual' && Number.isSafeInteger(state.tab) &&
  state.scan.enabled && Boolean(state.scan.curatorName);
const curatorRequiredMessage = 'Введи имя и фамилию куратора в меню расширения.';
const selectChatTabMessage = 'Открой вкладку чатов Школково и запусти мониторинг из её меню расширения.';
const commandTimeout = { 'monitor:read': 28_000, 'monitor:open': 17_000 };
const blankConnection = () => ({ status: 'unknown', episode: '', since: 0, alerted: false, onlineSeen: false });
function blank() {
  return { scan: E.fresh(), tab: null, lastWatchTab: null, boot: null, tabSelection: 'manual', doc: null, ready: false, capturedHandoff: null,
    coverage: null, connection: blankConnection(), syncAt: 0, curatorSyncAt: null,
    tabBlock: null, startupBlock: '', pageIssue: '', pageCheckAt: 0, journalRosterRetry: null,
    outbox: {}, routes: {}, checked: 0, notified: 0, error: '', result: '' };
}

let db;
let snapshot;
let bootId;
let curatorFile;
let writes = Promise.resolve();
async function readCuratorFile() {
  try {
    const response = await fetch(api.runtime.getURL('curator.json'), {
      cache: 'no-store', signal: AbortSignal.timeout(4_000)
    });
    return response.ok ? identity.parse(await response.json()) : null;
  } catch { return null; }
}
function useCurator(s, name) {
  if (s.scan.curatorName === name) return;
  if (!identity.matches(s.scan.curatorName, name)) shiftLog.finish(s, Date.now(), 'curator_changed');
  s.scan.curatorName = name;
  if (!s.scan.enabled) return;
  s.scan.generation++;
  s.curatorSyncAt = Date.now();
  s.doc = null;
  s.ready = false;
  s.tabBlock = null;
  s.startupBlock = '';
  s.pageIssue = '';
  s.pageCheckAt = 0;
  s.connection = blankConnection();
  for (const notice of Object.values(s.outbox)) notice.session = token(s);
}
// All state and alarm writes have one owner. Network requests and DOM reads happen outside this lock.
function tx(fn, rollback) {
  const action = writes.then(async () => {
    if (!db) {
      curatorFile ??= readCuratorFile();
      const [local, session] = await Promise.all([api.storage.local.get(KEY), api.storage.session.get(BOOT)]);
      bootId = session[BOOT] || crypto.randomUUID();
      if (!session[BOOT]) await api.storage.session.set({ [BOOT]: bootId });
      db = local[KEY] || blank();
      snapshot = JSON.stringify(db);
    }
    try {
      if (db.boot !== bootId || db.tabSelection !== 'manual') {
        // A browser restart or a legacy automatic session requires a fresh user selection.
        if (db.scan.enabled) pause(db, 'browser_session_changed');
        Object.assign(db, { tab: null, lastWatchTab: null, doc: null, ready: false, coverage: null,
          connection: blankConnection(), boot: bootId, tabSelection: 'manual', routes: {},
          tabBlock: null, startupBlock: '', pageIssue: '', pageCheckAt: 0 });
        delete db.ownedTab;
      }
      if (!Object.hasOwn(db.scan, 'startupCutoff')) {
        if (monitoring(db)) E.prepareStartup(db.scan, Date.now());
        else db.scan.startupCutoff = null;
        db.coverage = null;
      }
      const fileName = await curatorFile;
      if (fileName) useCurator(db, fileName);
      const now = Date.now();
      if (monitoring(db) && !db.shiftLogs) shiftLog.start(db, now);
      shiftLog.observe(db, now, monitoring(db));
      if (monitoring(db)) E.advance(db.scan, now);
      const value = await fn(db);
      shiftLog.observe(db, Date.now(), monitoring(db));
      const next = JSON.stringify(db);
      if (snapshot !== next) {
        await api.storage.local.set({ [KEY]: db });
        snapshot = next;
      }
      return value;
    } catch (error) {
      db = JSON.parse(snapshot);
      await rollback?.();
      throw error;
    }
  });
  writes = action.catch(() => {});
  return action;
}

function pause(s, reason) {
  if (s.scan.enabled) shiftLog.record(s, Date.now(), 'monitor_paused', { reason });
  if (Number.isInteger(s.tab)) s.lastWatchTab = s.tab;
  E.stop(s.scan);
  Object.assign(s, { tab: null, doc: null, ready: false, syncAt: 0, curatorSyncAt: null,
    connection: blankConnection(), error: '', tabBlock: null, startupBlock: '', pageIssue: '', pageCheckAt: 0 });
}
async function openShiftChat(id) {
  const dest = await tx(s => {
    if (!s.scan.curatorName) return null;
    const row = E.navigation(s.scan, id);
    if (!row) return null;
    const tab = s.tab ?? s.lastWatchTab;
    if (s.boot !== bootId || !Number.isInteger(tab)) return null;
    return { tab, doc: s.doc, session: monitoring(s) ? token(s) : null, row };
  });
  if (!dest) return { ok: false, error: 'Чат или вкладка проверки недоступны в этой смене.' };
  try {
    const reply = await send(dest.tab, { type: 'monitor:open', ...dest.row, session: dest.session }, dest.doc);
    if (!reply?.ok) return { ok: false, error: reply?.reason || 'Не удалось открыть чат во вкладке проверки.' };
    await focusTab(dest.tab);
    return { ok: true };
  } catch { return { ok: false, error: 'Вкладка проверки закрыта или перезагружается.' }; }
}
function onChat(address) {
  try {
    const url = new URL(address);
    return url.origin === chatOrigin && /^\/chat\/?$/.test(url.pathname);
  } catch { return false; }
}
function sameExtensionPage(address, expected) {
  try {
    const actual = new URL(address);
    const page = new URL(expected);
    return actual.protocol === page.protocol && actual.host.toLowerCase() === page.host.toLowerCase() &&
      actual.pathname === page.pathname;
  } catch { return false; }
}
function fromTab(s, tab, session, doc) {
  return monitoring(s) && s.tab === tab && token(s) === session && (!s.doc || doc === s.doc);
}
function current(s, ref) {
  return monitoring(s) && s.tab === ref.tab && token(s) === ref.session && s.doc === ref.doc;
}
async function send(tab, message, doc) {
  let timerId;
  const request = api.tabs.sendMessage(tab, doc ? { ...message, documentToken: doc } : message, { frameId: 0 });
  const timeout = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error('Вкладка не ответила вовремя.')), commandTimeout[message.type] ?? 5000);
  });
  return Promise.race([request, timeout]).finally(() => clearTimeout(timerId));
}
async function focusTab(id) {
  const tab = await api.tabs.update(id, { active: true });
  if (Number.isSafeInteger(tab.windowId)) {
    try { await api.windows.update(tab.windowId, { focused: true }); }
    catch { /* Selecting the tab is still useful if Safari cannot focus its window. */ }
  }
}
async function syncCurator(ref) {
  const setup = await tx(s => monitoring(s) && s.tab === ref.tab && token(s) === ref.session ? {
    type: 'monitor:set', session: ref.session, generation: s.scan.generation, curatorName: s.scan.curatorName,
    startupCutoff: s.scan.startupCutoff, headThrough: s.scan.headThrough ?? null
  } : null);
  if (!setup) return;
  const reply = await send(ref.tab, setup).catch(() => null);
  if (reply?.ok) await tx(s => {
    if (monitoring(s) && s.tab === ref.tab && token(s) === ref.session) s.curatorSyncAt = null;
  });
}
async function tabBlockReason(id) {
  const tab = await api.tabs.get(id).catch(() => null);
  if (!tab) return 'missing';
  if (tab.discarded) return 'discarded';
  if (tab.frozen) return 'frozen';
  if (tab.status === 'loading') return 'loading';
  if ((tab.url && !onChat(tab.url)) || (tab.pendingUrl && !onChat(tab.pendingUrl))) return 'page';
  if (tab.active && (await api.windows.get(tab.windowId).catch(() => null))?.focused !== false) return 'in_use';
  return '';
}
function notification(title, message) {
  return { type: 'basic', iconUrl: 'icon.png', title, message };
}
function notificationError(error) {
  if (error?.code === 'notAuthorized' || error?.code === 'notificationsDisabled') {
    return 'Разреши уведомления Школково в настройках macOS и повтори отправку.';
  }
  return 'Не удалось отправить уведомление через приложение Школково.';
}
function trackedChat(s, id) {
  return id && Object.hasOwn(s.scan.chats, id) ? s.scan.chats[id] : null;
}
function decisionTimes(now, lastAt, waitSince, ageSource) {
  return {
    last_message_age_ms: Number.isFinite(lastAt) ? now - lastAt : null,
    wait_duration_ms: Number.isFinite(waitSince) ? now - waitSince : null,
    age_source: Number.isFinite(lastAt) ? ageSource : null
  };
}
function noticeTrace(s, now, event, id, item, details) {
  shiftLog.diagnostic(s, now, event, {
    chatId: item.id, episode: item.episode ?? item.since, noticeId: id, kind: item.kind
  }, { kind: item.kind, ...(item.phase ? { phase: item.phase } : {}), ...details });
}
const queuedReasons = {
  free: 'free_chat_confirmed', pinned: 'new_pinned_message', handover: 'handover_confirmed',
  offline: 'offline_confirmed', connecting: 'connecting_confirmed'
};
function addNotice(s, item, now = Date.now()) {
  const chat = trackedChat(s, item.id);
  const times = decisionTimes(now, chat?.lastMessageAt, chat?.waitSince, 'history');
  for (const [id, queued] of Object.entries(s.outbox)) {
    if (item.kind !== queued.kind || item.id !== queued.id) continue;
    if (item.key && item.key === queued.key) {
      noticeTrace(s, now, 'notification_decision', id, queued, { decision: 'skipped', reason: 'already_queued', ...times });
      return;
    }
    if (item.phase === 'reminder' && item.episode === queued.episode) removeNotice(s, id, 'superseded_by_reminder', now);
  }
  const id = 'shkolkovo-' + crypto.randomUUID();
  s.outbox[id] = { ...item, tab: s.tab, session: token(s), retryAt: 0 };
  const reason = item.phase === 'reminder' ? 'reminder_due' : queuedReasons[item.kind];
  noticeTrace(s, now, 'notification_decision', id, item, { decision: 'queued', reason, ...times });
}
function removeNotice(s, id, reason, now = Date.now()) {
  if (reason && s.outbox[id]) noticeTrace(s, now, 'notification_cancelled', id, s.outbox[id], { reason });
  delete s.outbox[id];
  if (!Object.values(s.outbox).some(n => n.retryAt > 0)) s.error = '';
}
function deferNotice(s, id, item, now, reason) {
  if (item.deferredReason === reason) return;
  item.deferredReason = reason;
  noticeTrace(s, now, 'notification_deferred', id, item, { reason });
}
function connectionDelay(connection) {
  if (connection.status === 'offline' && connection.onlineSeen) return 2_000;
  return connection.status === 'connecting' ? 30_000 : Infinity;
}
function connection(s, status, verified = false) {
  if (!['unknown', 'online', 'offline', 'connecting'].includes(status)) return;
  const c = s.connection;
  const previous = c.status;
  c.onlineSeen ??= previous === 'online' && s.ready;
  c.status = status;
  if (previous !== status) shiftLog.record(s, Date.now(), 'connection_changed', { status });
  if (status === 'online' && s.ready) c.onlineSeen = true;
  if (status === 'unknown') return;
  const now = Date.now();
  if (c.episode !== status) {
    c.episode = status;
    c.since = now;
    c.alerted = false;
  } else if (previous === 'unknown' && !c.alerted) c.since = now;
  if (!s.doc || c.alerted || !verified || now - c.since < connectionDelay(c)) return;
  addNotice(s, { kind: status, since: c.since, doc: s.doc }, now);
  c.alerted = true;
}

// A second wake-up source covers service worker suspension during short retries.
let timer;
let queued = false;
let runningRead;
let lastReadWake;
let runningSync;
let runningProbe;
let runningPageCheck;
let handoffCapture;
let captureRetryAt = 0;
let runningDelivery;
let runningLogExport = false;
let journalLookup;
const fetching = new Map(); // target roster hour -> shift generation
let retryWake = 0;
function kick() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    void plan().catch(failed);
  });
}
function failed(error) {
  console.warn('Школково: действие не завершилось', error?.name || 'Error');
  // Retry without logging any chat data.
  clearTimeout(timer);
  timer = setTimeout(kick, 5000);
}
async function alarm(name, when) {
  const existing = await api.alarms.get(name);
  if (!Number.isFinite(when)) {
    if (existing) await api.alarms.clear(name);
  } else if (!existing || Math.abs(existing.scheduledTime - when) > 900) {
    await api.alarms.create(name, { when });
  }
}
function noticeBlock(s, n, now) {
  if (!monitoring(s)) return 'monitoring_inactive';
  if (n.tab !== s.tab || n.session !== token(s)) return 'session_changed';
  if (n.kind === 'offline' || n.kind === 'connecting') {
    const c = s.connection;
    const sameEpisode = n.kind === c.status || (n.kind === 'offline' && c.status === 'unknown' && c.episode === 'offline');
    if (!s.doc || n.doc !== s.doc) return 'document_changed';
    return sameEpisode && n.since === c.since ? '' : 'connection_changed';
  }
  const reason = E.noticeIneligibleReason(s.scan, n, now);
  return reason && E.noticeNeedsRecheck(s.scan, n, now) ? 'recheck' : reason;
}
function noticeReady(s, id, item, now) {
  const reason = noticeBlock(s, item, now);
  if (reason === 'recheck') {
    deferNotice(s, id, item, now, 'new_activity_before_send');
    return false;
  }
  if (reason) {
    removeNotice(s, id, reason, now);
    return false;
  }
  if (item.deferredReason === 'new_activity_before_send') delete item.deferredReason;
  return true;
}

function addRows(s, result, startupCutoff = s.scan.startupCutoff) {
  const startup = Number.isFinite(startupCutoff);
  if (!Number.isFinite(result.observedAt) || !E.observe(s.scan, result.rows, Date.now(), result.observedAt,
    { partial: true, ...(startup ? { startupCutoff } : {}) })) return false;
  if (!startup) rememberHead(s.scan, result);
  return true;
}

function rememberHead(scan, result) {
  const { observedAt, headThrough } = result;
  if (Number.isFinite(headThrough) && headThrough <= observedAt && headThrough > (scan.headThrough ?? -Infinity)) {
    scan.headThrough = headThrough;
  }
}

function readRecoveryRanges(value) {
  if (!Array.isArray(value)) return null;
  const ranges = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const { first, last, key, before, after } = item;
    if (key !== undefined && (typeof key !== 'string' || !key)) return null;
    if (first === undefined && last === undefined && key) {
      if (before || after) return null;
      ranges.push({ key, tries: 0 });
    } else {
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first ||
          (key && first !== last)) return null;
      const anchors = {};
      for (const [side, anchor] of Object.entries({ before, after })) {
        if (anchor === undefined || anchor === null) continue;
        if (!Number.isSafeInteger(anchor.position) || anchor.position < 1 ||
            (side === 'before' ? anchor.position >= first : anchor.position <= last) ||
            typeof anchor.key !== 'string' || !anchor.key) return null;
        anchors[side] = { position: anchor.position, key: anchor.key };
      }
      ranges.push({ first, last, ...(key ? { key } : {}), ...anchors, tries: 0 });
    }
  }
  return ranges;
}

function recoveryRangeCount(ranges) {
  return ranges.reduce((total, range) => total + (range.first === undefined ? 1 : range.last - range.first + 1), 0);
}

function legacyResurvey(coverage, work) {
  if (work.anchored) return null;
  if (work.resurvey) return work.resurvey;
  const targets = work.batch?.targets ?? [];
  const lacksAnchors = target => !target.key && !target.before && !target.after;
  const hasUnanchoredPositions = work.ranges.some(lacksAnchors) || targets.some(lacksAnchors);
  const exhaustedPositions = coverage.skipped > recoveryRangeCount(work.ranges) + targets.length;
  if (Number.isFinite(coverage.cutoff) && (hasUnanchoredPositions || exhaustedPositions)) {
    work.resurvey = { id: crypto.randomUUID(), cutoff: coverage.cutoff, resurvey: true };
    return work.resurvey;
  }
  work.anchored = true;
  return null;
}

function nextRecoveryBatch(coverage) {
  const work = coverage?.recovery;
  if (!coverage?.complete || !work) return null;
  const resurvey = legacyResurvey(coverage, work);
  if (resurvey) return resurvey;
  if (work.batch) return work.batch;
  const targets = [];
  while (targets.length < RECOVERY_BATCH_SIZE && work.ranges.length) {
    const range = work.ranges[0];
    const { first, last, key, before, after, tries } = range;
    targets.push({ ...(first === undefined ? {} : { position: first }), ...(key ? { key } : {}),
      ...(before ? { before } : {}), ...(after ? { after } : {}), tries });
    if (first === last) work.ranges.shift();
    else range.first++;
  }
  if (!targets.length) return null;
  work.batch = { id: crypto.randomUUID(), cutoff: coverage.cutoff, targets };
  return work.batch;
}

function coverageIdentity(chats) {
  const aliases = new Map();
  for (const chat of Object.values(chats)) {
    if (!chat.id.startsWith('id:')) continue;
    for (const alias of [chat.rowKey, chat.fallbackKey, chat.nativeKey]) {
      if (!alias) continue;
      if (!aliases.has(alias)) aliases.set(alias, chat.id);
      else if (aliases.get(alias) !== chat.id) aliases.set(alias, null);
    }
  }
  return key => aliases.has(key) ? aliases.get(key) : key;
}

function countableRows(rows, cutoff, now, identify) {
  return rows.filter(row => row && typeof row.id === 'string' && row.id &&
    row.at <= now && E.isStartupActivity(row, cutoff))
    .map(row => identify(row.id)).filter(Boolean);
}

function retryRecoveryTarget(ranges, target) {
  const { position, key, before, after } = target;
  const tail = ranges.at(-1);
  const sameAnchor = (left, right) => left?.position === right?.position && left?.key === right?.key;
  if (position !== undefined && !key && tail?.tries === 1 && !tail.key && tail.last + 1 === position &&
      sameAnchor(tail.before, before) && sameAnchor(tail.after, after)) {
    tail.last = position;
  } else {
    ranges.push({ ...(position === undefined ? {} : { first: position, last: position }),
      ...(key ? { key } : {}), ...(before ? { before } : {}), ...(after ? { after } : {}), tries: 1 });
  }
}

function applyRecoverySurvey(s, message) {
  const coverage = s.coverage;
  const work = coverage.recovery;
  if (work.resurvey?.id !== message.recoveryId || typeof message.complete !== 'boolean' ||
      !Array.isArray(message.rows)) return false;
  const ranges = message.complete ? readRecoveryRanges(message.recoveryRanges) : null;
  if (message.complete && !ranges) return false;
  const startedKeys = Object.values(s.scan.chats)
    .filter(chat => chat.startupQueuedCutoff === coverage.cutoff).map(chat => chat.id);
  const earlierKeys = coverage.scannedKeys ?? startedKeys;
  const oldCount = new Set(earlierKeys).size;
  if (!addRows(s, message, coverage.cutoff)) return false;
  const identify = coverageIdentity(s.scan.chats);
  const counted = new Set(earlierKeys.map(identify).filter(Boolean));
  for (const key of countableRows(message.rows, coverage.cutoff, Date.now(), identify)) counted.add(key);
  coverage.scannedKeys = [...counted];
  coverage.scanned = Math.max(0, (coverage.scanned ?? 0) + counted.size - oldCount);
  if (message.complete) {
    const skipped = Number.isSafeInteger(message.skipped) && message.skipped >= 0 ? message.skipped : 0;
    coverage.skipped = Math.max(skipped, recoveryRangeCount(ranges));
    coverage.reason = '';
    coverage.retryAt = null;
    const known = [...counted, ...startedKeys, ...(work.originalKeys ?? [])].map(identify).filter(Boolean);
    coverage.recovery = { ranges, batch: null, acknowledged: message.recoveryId, anchored: true,
      originalKeys: ranges.length ? [...new Set(known)] : [] };
    if (!ranges.length) delete coverage.scannedKeys;
  }
  if (message.complete || counted.size !== oldCount) shiftLog.record(s, Date.now(), 'chat_list_reviewed', {
    complete: message.complete, partial: coverage.partial, scanned: coverage.scanned, total: coverage.total,
    skipped: coverage.skipped, resurvey: true
  });
  return true;
}

function applyRecoveryBatch(s, message) {
  const coverage = s.coverage;
  const work = coverage?.recovery;
  if (!coverage?.complete || !work || typeof message.recoveryId !== 'string') return false;
  if (work.acknowledged === message.recoveryId) return true;
  if (message.resurvey === true) return applyRecoverySurvey(s, message);
  if (work.resurvey) return false;
  const batch = work.batch;
  if (!batch || batch.id !== message.recoveryId || !Array.isArray(message.results) ||
      message.results.length !== batch.targets.length || !Array.isArray(message.rows)) return false;
  const results = new Map();
  const targetKey = ({ position, key }) => JSON.stringify([position ?? null, key ?? null]);
  for (const result of message.results) {
    if (!result || typeof result.resolved !== 'boolean' ||
        (result.resolved && (typeof result.rowId !== 'string' || !result.rowId))) return false;
    results.set(targetKey(result), result);
  }
  if (batch.targets.some(target => !results.has(targetKey(target)))) return false;
  const earlierKeys = coverage.scannedKeys ?? Object.values(s.scan.chats)
    .filter(chat => chat.startupQueuedCutoff === coverage.cutoff).map(chat => chat.id);
  if (!addRows(s, message, coverage.cutoff)) return false;
  const identify = coverageIdentity(s.scan.chats);
  const counted = new Set(earlierKeys.map(identify).filter(Boolean));
  work.originalKeys ??= earlierKeys;
  const known = new Set(work.originalKeys.map(identify).filter(Boolean));
  const oldCount = new Set(earlierKeys).size;
  const resolvedKeys = new Set((work.resolvedKeys ?? []).map(identify).filter(Boolean));
  let recovered = 0;
  for (const target of batch.targets) {
    const result = results.get(targetKey(target));
    const rowId = result.resolved ? identify(result.rowId) : null;
    const matches = rowId && (target.key ? identify(target.key) === rowId
      : (target.before || target.after) && !known.has(rowId));
    if (matches && !resolvedKeys.has(rowId)) {
      resolvedKeys.add(rowId);
      recovered++;
    } else {
      if (!target.tries) retryRecoveryTarget(work.ranges, target);
    }
  }
  for (const key of countableRows(message.rows, coverage.cutoff, Date.now(), identify)) counted.add(key);
  work.batch = null;
  work.acknowledged = message.recoveryId;
  work.resolvedKeys = [...resolvedKeys];
  coverage.scannedKeys = [...counted];
  coverage.skipped = Math.max(0, coverage.skipped - recovered);
  coverage.scanned = Math.max(0, (coverage.scanned ?? 0) + counted.size - oldCount);
  if (recovered || counted.size !== oldCount) shiftLog.record(s, Date.now(), 'chat_list_reviewed', {
    complete: true, partial: coverage.partial, scanned: coverage.scanned, total: coverage.total, skipped: coverage.skipped
  });
  if (!work.ranges.length) {
    delete work.originalKeys;
    delete work.resolvedKeys;
    delete coverage.scannedKeys;
  }
  return true;
}

async function planLogExport(s, now, actions, rollbacks) {
  const report = s.shiftLogs?.pending[0];
  let wake = shiftLog.nextBoundary(s, now);
  const ready = report && !runningLogExport && report.retryAt <= now;
  if (report) wake = Math.min(wake, report.retryAt > now ? report.retryAt : now + MIN);
  const period = shiftLog.missingHour(s, now);
  if (Number.isFinite(period)) {
    const logId = shiftLog.lookupId(s);
    const retry = s.journalRosterRetry;
    const delayed = retry?.logId === logId && retry.period === period && retry.at > now;
    if (delayed) wake = Math.min(wake, retry.at);
    else if (!journalLookup) {
      const request = { logId, period };
      journalLookup = request;
      rollbacks.push(() => { if (journalLookup === request) journalLookup = null; });
      actions.push(() => readJournalHour(request));
      wake = Math.min(wake, now + MIN);
    }
  }
  await alarm(LOG_ALARM, wake);
  if (ready) actions.push(() => exportShiftLog(report));
}

async function exportShiftLog(report) {
  if (runningLogExport) return;
  runningLogExport = true;
  try {
    const filename = shiftLog.filename(report);
    const text = shiftLog.render(report, api.runtime.getManifest().version);
    const written = await notifications.writeLog(filename, text).catch(() => false);
    await tx(s => {
      const logs = s.shiftLogs;
      const pending = logs?.pending[0];
      if (pending?.id !== report.id) return;
      if (written) {
        logs.pending.shift();
        logs.lastExport = { where: 'downloads', filename };
      } else {
        pending.retryAt = Date.now() + MIN;
      }
    });
  } finally {
    runningLogExport = false;
    kick();
  }
}

async function plan() {
  const rollbacks = [];
  const tasks = await tx(async s => {
    clearTimeout(timer);
    const now = Date.now();
    const actions = [];
    if (!monitoring(s)) {
      await Promise.all([HOUR_ALARM, PREFETCH_ALARM, TASK_ALARM].map(name => alarm(name, Infinity)));
      await planLogExport(s, now, actions, rollbacks);
      return actions;
    }
    const ref = { tab: s.tab, session: token(s), doc: s.doc };
    if (runningRead && !current(s, runningRead)) runningRead = null;
    if (runningProbe && !current(s, runningProbe)) runningProbe = null;
    if (runningPageCheck && !current(s, runningPageCheck)) runningPageCheck = null;
    if (handoffCapture && !current(s, handoffCapture)) {
      handoffCapture.done.resolve();
      handoffCapture = null;
      captureRetryAt = 0;
    }
    if (runningSync && (runningSync.session !== ref.session || runningSync.tab !== ref.tab)) runningSync = null;
    const boundary = E.boundary(now, s.scan);
    const preload = E.prefetchTime(now, s.scan);
    const nextPreload = preload > now ? preload : preload + 60 * MIN;
    const calendar = E.calendarSchedule(s.scan, now);
    const startupPending = Number.isFinite(s.scan.startupCutoff);
    const times = [now + MIN, boundary, nextPreload, calendar.period + 60 * MIN];
    if (Number.isFinite(s.curatorSyncAt)) {
      if (s.curatorSyncAt <= now) {
        s.curatorSyncAt = now + 15_000;
        actions.push(() => syncCurator(ref));
      }
      times.push(s.curatorSyncAt);
    }
    const handoffAt = s.scan.period - 5 * MIN;
    if (s.doc && now >= handoffAt && now < handoffAt + MIN && s.capturedHandoff !== handoffAt && !handoffCapture) {
      if (now >= captureRetryAt) {
        const request = { ...ref, handoffAt, done: Promise.withResolvers() };
        handoffCapture = request;
        rollbacks.push(() => {
          request.done.resolve();
          if (handoffCapture === request) handoffCapture = null;
        });
        actions.push(() => captureRows(request));
      } else times.push(captureRetryAt);
    }
    await Promise.all([alarm(HOUR_ALARM, boundary), alarm(PREFETCH_ALARM, nextPreload)]);
    const { generation } = s.scan;
    const inFlight = new Set([...fetching].filter(([, g]) => g === generation).map(([period]) => period));
    for (let period = E.scheduleTarget(s.scan, now, inFlight);
         Number.isFinite(period) && !inFlight.has(period); period = E.scheduleTarget(s.scan, now, inFlight)) {
      const target = period;
      fetching.set(target, generation);
      rollbacks.push(() => { if (fetching.get(target) === generation) fetching.delete(target); });
      inFlight.add(target);
      actions.push(() => readSchedule(generation, target));
    }
    for (const retry of [calendar.retryAt, s.scan.scheduleRetryAt, s.scan.prefetchRetryAt]) if (retry > now) times.push(retry);
    for (const item of E.dueNotices(s.scan, now)) addNotice(s, item, now);
    const noticeAt = E.nextNoticeAt(s.scan, now);
    if (noticeAt > now) times.push(noticeAt);
    for (const [id, item] of Object.entries(s.outbox)) {
      if (!noticeReady(s, id, item, now)) continue;
      if (item.retryAt > now) { times.push(item.retryAt); continue; }
      if (!runningDelivery) {
        runningDelivery = id;
        rollbacks.push(() => { if (runningDelivery === id) runningDelivery = null; });
        actions.push(() => deliver(id));
      }
    }
    if (runningRead && current(s, runningRead) && s.syncAt <= now) s.syncAt = now + MIN;
    if (!startupPending && s.doc && !runningSync && !runningRead && !handoffCapture && s.syncAt <= now) {
      runningSync = ref;
      rollbacks.push(() => { if (runningSync === ref) runningSync = null; });
      actions.push(() => sync(ref));
    }
    if (s.syncAt > now) times.push(s.syncAt);
    const c = s.connection;
    if (s.doc && !runningProbe && !c.alerted) {
      const due = Math.max(c.since + connectionDelay(c), retryWake);
      if (now >= due) {
        const probeRef = { ...ref, status: c.status, since: c.since };
        runningProbe = probeRef;
        rollbacks.push(() => { if (runningProbe === probeRef) runningProbe = null; });
        actions.push(() => probe(probeRef));
      } else times.push(due);
    }
    if (!runningPageCheck && (s.pageCheckAt ?? 0) <= now) {
      runningPageCheck = ref;
      rollbacks.push(() => { if (runningPageCheck === ref) runningPageCheck = null; });
      s.pageCheckAt = now + PAGE_CHECK_INTERVAL;
      actions.push(() => checkMonitorPage(ref));
    }
    if (s.pageCheckAt > now) times.push(s.pageCheckAt);
    if (s.tabBlock?.retryAt > now) times.push(s.tabBlock.retryAt);
    else if (s.ready && s.doc && !runningSync && !runningRead && !handoffCapture) {
      const job = E.next(s.scan, now);
      if (job) {
        runningRead = ref;
        rollbacks.push(() => { if (runningRead === ref) runningRead = null; });
        actions.push(() => readChat(ref, job));
      } else {
        const when = E.earliest(s.scan, now);
        if (when > now) times.push(when);
      }
    }
    const at = Math.min(...times);
    await alarm(TASK_ALARM, at);
    timer = setTimeout(kick, Math.max(25, at - Date.now()));
    await planLogExport(s, now, actions, rollbacks);
    return actions;
  }, async () => { for (const release of rollbacks) await release(); });
  for (const run of tasks) void run().catch(failed);
}

async function captureRows(request) {
  try {
    const reply = await send(request.tab, { type: 'monitor:handoff-rows', session: request.session }, request.doc);
    if (reply?.ready && Array.isArray(reply.rows) && reply.observedAt >= request.handoffAt) {
      await tx(s => {
        if (!current(s, request) || s.scan.period - 5 * MIN !== request.handoffAt) return;
        addRows(s, reply);
        s.capturedHandoff = request.handoffAt;
        s.ready = true;
      });
    }
  } catch { /* A loading document can be sampled again within the handoff minute. */ }
  finally {
    if (handoffCapture === request) {
      captureRetryAt = Date.now() + 2000;
      handoffCapture = null;
    }
    request.done.resolve();
    kick();
  }
}

// Keep a passive boundary read ahead of newer list reports from this document.
// A genuinely older frame, in either delivery order, is discarded by observe().
function pendingHandoffRows(tab, doc, session) {
  if (handoffCapture && handoffCapture.doc === doc && handoffCapture.tab === tab && handoffCapture.session === session) {
    return handoffCapture.done.promise;
  }
}

async function readSchedule(generation, period) {
  const moscow = clock.moscowHour(period);
  let result;
  let error;
  let reason;
  try { result = await ShSchedule.read(moscow.date, moscow.hour); }
  catch (e) {
    error = e?.message || 'Не удалось прочитать таблицу.';
    reason = ShSchedule.errorCode(e);
  }
  try {
    await tx(s => {
      const now = Date.now();
      if (monitoring(s) && E.installRoster(s.scan, { generation, period }, result?.names, error, now, result?.directory)) {
        shiftLog.record(s, now, result ? 'schedule_loaded' : 'schedule_failed', {
          hourMsk: `${moscow.date}T${moscow.time}:00${moscow.offset}`,
          ...(result ? { rosterSize: result.names.length } : { reason })
        });
      }
    });
  } finally {
    if (fetching.get(period) === generation) fetching.delete(period);
    kick();
  }
}

async function readJournalHour(request) {
  try {
    const moscow = clock.moscowHour(request.period);
    let reason;
    const roster = await ShSchedule.read(moscow.date, moscow.hour).catch(error => {
      reason = ShSchedule.errorCode(error);
      return null;
    });
    await tx(s => {
      if (shiftLog.lookupId(s) !== request.logId) return;
      const now = Date.now();
      if (shiftLog.missingHour(s, now) !== request.period) return;
      const confirmed = roster && shiftLog.confirmHour(s, now, request.period, roster.names, roster.directory);
      if (reason) shiftLog.record(s, now, 'schedule_failed', {
        hourMsk: `${moscow.date}T${moscow.time}:00${moscow.offset}`, reason, scope: 'journal'
      });
      s.journalRosterRetry = confirmed ? null : { ...request, at: now + JOURNAL_RETRY };
    });
  } finally {
    if (journalLookup === request) journalLookup = null;
    kick();
  }
}

async function checkMonitorPage(ref) {
  try {
    const tab = await api.tabs.get(ref.tab).catch(() => null);
    const address = tab?.pendingUrl || tab?.url;
    const leftPage = address && !onChat(address);
    let issue;
    if (!tab) issue = 'missing';
    else if (leftPage) issue = 'page';
    else if (tab.discarded) issue = 'discarded';
    else if (tab.frozen) issue = 'frozen';
    else if (tab.status === 'loading') issue = 'loading';
    else issue = (await send(ref.tab, { type: 'monitor:ping' }).catch(() => null))?.ok ? '' : 'page';
    await tx(s => {
      if (!current(s, ref)) return;
      if (!tab || leftPage) {
        pause(s, tab ? 'page_left' : 'tab_closed');
        s.lastWatchTab = null;
        s.result = 'Открой чаты Школково и запусти проверку из выбранной вкладки.';
        return;
      }
      s.pageIssue = issue;
      if (issue === 'page') {
        Object.assign(s, { doc: null, ready: false, tabBlock: null, startupBlock: '', connection: blankConnection() });
      } else if (!issue && !s.doc) {
        s.curatorSyncAt ??= Date.now();
      }
    });
  } finally {
    if (runningPageCheck === ref) runningPageCheck = null;
    kick();
  }
}

async function readChat(ref, job) {
  let history;
  let wakeBefore;
  try {
    const tabBlock = await tabBlockReason(ref.tab);
    if (tabBlock) history = { blocked: true, tabBlock };
    else {
      const valid = await tx(s => {
        if (!current(s, ref) || (!job.pinned && job.period !== s.scan.period)) return false;
        const next = E.next(s.scan, Date.now());
        return next?.id === job.id && next.serial === job.serial;
      });
      if (!valid) return;
      const expiresAt = Math.min(Date.now() + 28_000, job.expiresAt ?? Infinity,
        job.pinned ? Infinity : job.period + 55 * MIN);
      if (Date.now() >= expiresAt) return;
      wakeBefore = lastReadWake;
      history = await send(ref.tab, { type: 'monitor:read', session: ref.session,
        id: job.id, sinceAt: job.sinceAt, expiresAt, job }, ref.doc);
      if (!history) history = { ready: false, reasonCode: 'tab_no_response' };
    }
  } catch { history = { ready: false, reason: 'Вкладка не ответила на запрос истории.', reasonCode: 'tab_no_response' }; }
  finally {
    try {
      if (history) await tx(s => {
        if (!current(s, ref)) return;
        const now = Date.now();
        const check = {};
        let notices = [];
        if (history.blocked) {
          const reason = TAB_BLOCKS.has(history.tabBlock) ? history.tabBlock : 'job_changed';
          const chat = trackedChat(s, job.id);
          Object.assign(check, { chatId: job.id, episode: chat?.waitKey,
            lastAt: job.at, waitSince: chat?.waitSince, ageSource: 'list', noticeReason: reason });
          if (reason !== 'job_changed') {
            if (s.tabBlock?.reason !== history.tabBlock) {
              shiftLog.record(s, now, 'chat_check_deferred', { reason: history.tabBlock });
            }
            const wokeInFlight = history.tabBlock === 'read_busy' && lastReadWake !== wakeBefore &&
              lastReadWake?.tab === ref.tab && lastReadWake.doc === ref.doc && lastReadWake.session === ref.session;
            s.tabBlock = { reason: history.tabBlock, retryAt: wokeInFlight ? now : now + TAB_RETRY };
          } else {
            s.tabBlock = null;
            E.defer(s.scan, job, now, TAB_RETRY);
            shiftLog.record(s, now, 'chat_check_deferred', { reason: 'job_changed' });
          }
        } else {
          if (s.tabBlock) {
            shiftLog.record(s, now, 'chat_checks_resumed', { previousReason: s.tabBlock.reason });
            s.tabBlock = null;
          }
          notices = E.apply(s.scan, job, history, now, check);
          shiftLog.identifyChat(s, job.id, check.chatId);
        }
        const keys = { chatId: check.chatId, episode: check.episode };
        shiftLog.parsedTime(s, now, keys, 'list', history.timeDiagnostics?.list);
        shiftLog.parsedTime(s, now, keys, 'history', history.timeDiagnostics?.history);
        if (check.status) {
          s.checked = (s.checked || 0) + 1;
          shiftLog.diagnostic(s, now, 'chat_checked', keys, { status: check.status, pinned: job.pinned === true });
        } else if (check.reasonCode) {
          shiftLog.diagnostic(s, now, 'chat_check_failed', keys, { reason: check.reasonCode });
        }
        if (check.reasonCode || check.noticeReason) {
          shiftLog.diagnostic(s, now, 'notification_decision', keys, { decision: 'skipped',
            reason: check.reasonCode ?? check.noticeReason, ...decisionTimes(now, check.lastAt, check.waitSince, check.ageSource) });
        }
        for (const n of notices) addNotice(s, { ...n, period: job.period }, now);
      });
    } finally { if (runningRead === ref) runningRead = null; kick(); }
  }
}
async function sync(ref) {
  let result;
  try {
    if (!await tabBlockReason(ref.tab) && await tx(s => current(s, ref))) {
      result = await send(ref.tab, { type: 'monitor:reload', session: ref.session, expiresAt: Date.now() + 5000 }, ref.doc);
    }
  } catch { /* The document may already be reloading. */ }
  finally {
    try {
      if (result?.ready) await pendingHandoffRows(ref.tab, ref.doc, ref.session);
      await tx(s => {
        if (!monitoring(s) || s.tab !== ref.tab || token(s) !== ref.session ||
            (runningSync && runningSync !== ref)) return;
        if (current(s, ref) && result?.ready && Array.isArray(result.rows)) addRows(s, result);
        s.syncAt = Date.now() + (result?.ok ? 2.5 : 1) * MIN;
      });
    } finally { if (runningSync === ref) runningSync = null; kick(); }
  }
}
async function probe(ref) {
  try {
    const reply = await send(ref.tab, { type: 'monitor:snapshot', session: ref.session }, ref.doc);
    await tx(s => {
      if (current(s, ref) && s.connection.status === ref.status && s.connection.since === ref.since) {
        connection(s, reply?.connection || 'unknown', true);
      }
    });
  } catch { /* Keep the episode pending until the document is available. */ }
  finally {
    if (runningProbe === ref) { retryWake = Date.now() + 3000; runningProbe = null; }
    kick();
  }
}
const safeLabel = value => String(value ?? '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, 180);
function waitLabel(minutes) {
  const last = minutes % 10;
  const teens = minutes % 100 >= 11 && minutes % 100 <= 14;
  return minutes + (teens || last === 0 || last >= 5 ? ' минут' : last === 1 ? ' минуту' : ' минуты');
}
function noticeCopy(n) {
  switch (n.kind) {
    case 'offline': return ['Школково не в сети', 'У раздела «Чаты» появился статус offline.'];
    case 'connecting': return ['Платформа Школково зависла', 'Индикатор показывает connecting уже 30 секунд.'];
    case 'handover': return ['Передача чатов Школково', 'Чатов в ожидании нового куратора — ' + n.count + '.'];
    case 'senior': return ['Ученик ждёт ответа', 'Чат «' + safeLabel(n.title) + '» куратора ' + safeLabel(n.curator) +
      ' без ответа ' + waitLabel(n.minutes)];
    default: {
      const reminder = n.phase === 'reminder';
      const title = n.kind === 'free' ? 'Свободный чат в Школково' : reminder ?
        'Закреплённый чат ждёт ответа' : 'Ученик написал в закреплённом чате';
      return [title, safeLabel(n.title) + ' · ' + timeLabel(n.at) +
        (reminder ? ' · без ответа ' + waitLabel(n.minutes) : '')];
    }
  }
}
function handoverCount(scan, now) {
  return Object.values(scan.chats).filter(c => c.transferAt != null && E.isFree(c, now)).length;
}
function notificationErrorCode(error) {
  switch (error?.code) {
    case 'notAuthorized': return 'permission_denied';
    case 'notificationsDisabled': return 'notifications_disabled';
    case 'invalidRequest': return 'invalid_options';
    case 'nativeUnavailable': return 'native_unavailable';
    default: return 'macos_api_error';
  }
}
async function createLoggedNotification(s, id, item, options, reference = id) {
  try {
    await notifications.create(id, options);
  } catch (error) {
    noticeTrace(s, Date.now(), 'notification_api_result', reference, item,
      { provider: 'macos', operation: 'create', result: 'rejected', error_code: notificationErrorCode(error) });
    throw error;
  }
  noticeTrace(s, Date.now(), 'notification_api_result', reference, item, { provider: 'macos', operation: 'create', result: 'accepted' });
}
async function deliver(id) {
  try {
    await tx(async s => {
      const n = s.outbox[id];
      if (!n || !monitoring(s)) return;
      try {
        let existing;
        try {
          existing = await notifications.getAll();
        } catch (error) {
          noticeTrace(s, Date.now(), 'notification_api_result', id, n,
            { provider: 'macos', operation: 'get_all', result: 'rejected', error_code: notificationErrorCode(error) });
          throw error;
        }
        for (const routeId of Object.keys(s.routes)) {
          if (!Object.hasOwn(existing, routeId)) delete s.routes[routeId];
        }
        // Recheck the episode immediately before submitting, including after a delayed alarm.
        const now = Date.now();
        E.advance(s.scan, now);
        if (!noticeReady(s, id, n, now)) return;
        if (!Object.hasOwn(existing, id)) {
          if (n.kind === 'offline') {
            const tab = await api.tabs.get(n.tab).catch(() => null);
            const snapshot = tab && tab.status !== 'loading'
              ? await send(n.tab, { type: 'monitor:snapshot', session: n.session }, n.doc).catch(() => null) : null;
            const status = snapshot?.connection;
            if (status === 'online' || status === 'connecting') {
              connection(s, status);
              removeNotice(s, id, 'connection_recovered', now);
              return;
            }
            if (status !== 'offline') {
              deferNotice(s, id, n, now, 'connection_unconfirmed');
              n.retryAt = Date.now() + 5000;
              return;
            }
          }
          const latest = { ...n };
          if (n.kind === 'handover') latest.count = handoverCount(s.scan, now);
          if (n.phase === 'reminder' && Number.isFinite(n.at)) latest.minutes = Math.max(0, Math.floor((now - n.at) / MIN));
          const [title, message] = noticeCopy(latest);
          await createLoggedNotification(s, id, n, notification(title, message));
        } else noticeTrace(s, now, 'notification_api_result', id, n, { provider: 'macos', operation: 'get_all', result: 'already_present' });
        const deliveredAt = Date.now();
        E.noticeDelivered(s.scan, n, deliveredAt);
        s.routes[id] = { tab: n.tab, id: n.id || null, kind: n.kind, boot: bootId };
        if (n.kind !== 'offline' && n.kind !== 'connecting') s.notified = (s.notified || 0) + 1;
        noticeTrace(s, deliveredAt, 'notification_delivered', id, n, {});
        removeNotice(s, id);
      } catch (error) {
        n.retryAt = Date.now() + MIN;
        s.error = notificationError(error) + ' Следующая попытка через минуту.';
        noticeTrace(s, Date.now(), 'notification_retry', id, n, { retry_after_ms: MIN });
      }
    });
  } finally { runningDelivery = null; kick(); }
}

function setStartupBlock(s, reason) {
  const previous = s.startupBlock;
  if ((previous ?? '') === reason) return;
  s.startupBlock = reason;
  if (reason) shiftLog.record(s, Date.now(), 'chat_list_deferred', { reason });
  else shiftLog.record(s, Date.now(), 'chat_list_resumed', { previousReason: previous });
}

async function tabMessage(m, sender) {
  const tab = sender.tab.id;
  const doc = m.documentToken;
  let handshake;
  if (m.type === 'monitor:hello') {
    handshake = await tx(s => ({ session: monitoring(s) && s.tab === tab ? token(s) : null,
      doc: s.doc, generation: s.scan.generation }));
    if (!handshake.session) return { session: null, generation: handshake.generation };
    // Only the currently routed top frame can acknowledge this document's token.
    if (handshake.doc !== doc && !(await send(tab, { type: 'monitor:ping' }, doc).catch(() => null))?.ok) return null;
  }
  if (m.type === 'monitor:rows' || (m.type === 'monitor:coverage' && Array.isArray(m.rows))) {
    await pendingHandoffRows(tab, doc, m.session);
  }
  const result = await tx(s => {
    if (m.type === 'monitor:hello') {
      if (!monitoring(s) || s.tab !== tab) return { session: null, generation: s.scan.generation };
      if (token(s) !== handshake.session) return null;
      if (s.doc !== doc) {
        s.doc = doc;
        s.ready = false;
        s.connection = blankConnection();
        s.tabBlock = null;
        s.startupBlock = '';
      }
      s.pageIssue = '';
      return { session: token(s), generation: s.scan.generation, curatorName: s.scan.curatorName,
        startupCutoff: s.scan.startupCutoff, headThrough: s.scan.headThrough ?? null };
    }
    if (!fromTab(s, tab, m.session, doc)) return { ok: false };
    if (!s.doc) s.doc = doc;
    switch (m.type) {
      case 'monitor:rows':
        if (!Array.isArray(m.rows) || !addRows(s, m)) return { ok: false };
        s.ready = true;
        s.pageIssue = '';
        if (s.connection.status === 'online') s.connection.onlineSeen = true;
        break;
      case 'monitor:recovery-next':
        return { ok: true, recovery: nextRecoveryBatch(s.coverage) };
      case 'monitor:startup-block':
        if (m.reason !== '' && !TAB_BLOCKS.has(m.reason)) return { ok: false };
        if (Number.isFinite(s.scan.startupCutoff)) setStartupBlock(s, m.reason);
        break;
      case 'monitor:coverage': {
        if (m.recovery === true) return { ok: applyRecoveryBatch(s, m) };
        if (typeof m.complete !== 'boolean') return { ok: false };
        const startupCutoff = s.scan.startupCutoff;
        if (!Number.isFinite(startupCutoff)) return { ok: true };
        const ranges = m.complete ? readRecoveryRanges(m.recoveryRanges ?? []) : null;
        if (m.complete && !ranges) return { ok: false };
        const hasRows = Array.isArray(m.rows);
        if (m.complete && !hasRows) return { ok: false };
        if (hasRows) {
          if (!addRows(s, m, startupCutoff)) return { ok: false };
          s.ready = true;
          s.pageIssue = '';
          if (s.connection.status === 'online') s.connection.onlineSeen = true;
        }
        if (m.complete) {
          rememberHead(s.scan, m);
          s.scan.startupCutoff = null;
          setStartupBlock(s, '');
          s.scan.baseline = true;
          s.scan.coveragePending = false;
          s.syncAt = Math.max(s.syncAt ?? 0, Date.now() + MIN);
          const boundary = m.timeBoundary;
          const now = Date.now();
          if (typeof boundary?.id === 'string' && boundary.id && Number.isFinite(boundary.at) && boundary.at <= startupCutoff) {
            const chatId = /^\d+__\d+__\d+$/u.test(boundary.identity ?? '') ? 'id:' + boundary.identity : boundary.id;
            const keys = { chatId };
            shiftLog.parsedTime(s, now, keys, 'list', boundary.timeParse);
            shiftLog.diagnostic(s, now, 'notification_decision', keys, { decision: 'skipped',
              reason: 'outside_startup_window', ...decisionTimes(now, boundary.at, null, 'list') });
          }
        }
        const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
        const complete = m.complete;
        const reason = !complete && typeof m.reason === 'string' ? m.reason.slice(0, 200) : '';
        const trackedGaps = ranges ? recoveryRangeCount(ranges) : 0;
        const skipped = Math.max(count(m.skipped) ?? 0, trackedGaps ?? 0);
        const scannedKeys = hasRows
          ? [...new Set(countableRows(m.rows, startupCutoff, Date.now(), coverageIdentity(s.scan.chats)))] : null;
        const originalKeys = ranges?.length ? [...new Set([...scannedKeys, ...Object.values(s.scan.chats)
          .filter(chat => chat.startupQueuedCutoff === startupCutoff).map(chat => chat.id)])] : [];
        s.coverage = {
          complete, cutoff: startupCutoff, partial: m.partial === true || skipped > 0,
          scanned: scannedKeys?.length ?? count(m.scanned), total: count(m.total), skipped, reason,
          ...(complete ? { scannedKeys, recovery: {
            ranges, batch: null, acknowledged: null, originalKeys, anchored: true
          } } : {}),
          retryAt: Number.isFinite(m.retryAt) ? m.retryAt : null
        };
        shiftLog.record(s, Date.now(), 'chat_list_reviewed', {
          complete, partial: s.coverage.partial, scanned: s.coverage.scanned, total: s.coverage.total, skipped
        });
        break;
      }
      case 'monitor:connection':
        connection(s, m.status);
        if (m.status === 'online' && s.tabBlock?.reason === 'connection') s.tabBlock.retryAt = 0;
        break;
      case 'monitor:connection-alert':
        if (s.connection.status === m.status) connection(s, m.status, true);
        break;
      case 'monitor:wake':
        if (m.readReady === true) lastReadWake = { tab, doc, session: m.session };
        if (['in_use', 'list_scan'].includes(s.tabBlock?.reason) ||
            (s.tabBlock?.reason === 'read_busy' && m.readReady === true)) s.tabBlock.retryAt = 0;
        break;
      case 'monitor:panel-change':
        E.panelChanged(s.scan, m, Date.now());
        break;
      default: return { ok: false };
    }
    s.curatorSyncAt = null;
    return { ok: true };
  });
  kick();
  return result;
}

function summary(s) {
  const active = monitoring(s);
  const now = Date.now();
  const calendar = E.calendarSchedule(s.scan, now);
  const incoming = s.scan.period > calendar.period;
  const prefetchError = incoming ? s.scan.scheduleError : s.scan.prefetchError;
  const retryAt = calendar.error || !calendar.loaded ? calendar.retryAt
    : incoming ? s.scan.scheduleRetryAt : s.scan.prefetchRetryAt;
  return { active, curatorRequired: !s.scan.curatorName, mode: s.scan.mode || 'normal',
    scheduleHour: active ? calendar.period : null,
    period: active ? timeLabel(calendar.period) : '', lastRead: calendar.readAt ? timeLabel(calendar.readAt) : '',
    scheduleError: calendar.error || '', prefetchError: prefetchError || '',
    nextPeriod: active ? timeLabel(calendar.period + 60 * MIN) : '',
    retryAt: retryAt > now ? timeLabel(retryAt) : '',
    loading: active && !calendar.loaded, result: s.result };
}
function coverageLabel(s) {
  if (!monitoring(s)) return '';
  if (!s.coverage) return Number.isFinite(s.scan.startupCutoff) ? 'Начальный просмотр чатов за 45 минут.' : '';
  const { complete, reason, retryAt, skipped } = s.coverage;
  const missing = skipped ? 'Строк без подтверждённого времени — ' + skipped + '.' : '';
  if (complete) return ['Начальный просмотр чатов за 45 минут завершён.', missing].filter(Boolean).join(' ');
  return ['Начальный просмотр чатов за 45 минут ещё идёт.', missing, reason,
    retryAt > Date.now() ? 'Повтор в ' + timeLabel(retryAt) + '.' : 'Проверка продолжится.'].filter(Boolean).join(' ');
}
function waiting(c, now) {
  const since = E.waitingSince(c, now);
  return { waitingSince: since, waitMs: since === null ? null : Math.max(0, now - since) };
}
async function details(tabId) {
  const data = await tx(s => {
    const now = Date.now();
    const chats = Object.values(s.scan.chats);
    const checkable = chats.filter(c => E.isCheckableChat(c, now));
    const uncertain = checkable.filter(c => c.status === 'Не определено');
    const failedChat = uncertain.filter(c => c.reason).sort((a, b) => b.at - a.at)[0];
    const free = chats.filter(c => E.isFree(c, now)).map(c => ({
      id: c.id, title: c.title, version: E.freeVersion(c), ...waiting(c, now)
    })).sort((a, b) => (a.waitingSince ?? Infinity) - (b.waitingSince ?? Infinity) || a.title.localeCompare(b.title, 'ru'));
    return { ...summary(s), canStart: Boolean(s.scan.curatorName), supportsFreeDismissal: true, rulesVersion: 9,
      attached: Number.isSafeInteger(s.lastWatchTab),
      here: monitoring(s) && tabId === s.tab, ready: monitoring(s) && s.ready, pinnedInstant: s.scan.pinnedImmediate !== false,
      scanComplete: s.coverage?.complete ?? null, scanStatus: coverageLabel(s), free,
      bindings: chats.filter(c => c.binding).length,
      checked: s.checked || 0, notified: s.notified || 0,
      pending: checkable.filter(c => c.pending).length, uncertain: uncertain.length,
      reason: failedChat ? `Не удалось проверить «${failedChat.title}». ${failedChat.reason}` : '',
      connection: s.connection.status, tabBlock: s.pageIssue || s.startupBlock || (s.tabBlock?.retryAt > now ? s.tabBlock.reason : ''),
      logExport: { pending: s.shiftLogs?.pending.length ?? 0, lastExport: s.shiftLogs?.lastExport },
      error: s.error };
  });
  kick();
  return data;
}
async function showShift() {
  const tabs = await api.tabs.query({}).catch(() => []);
  const open = tabs.find(tab => sameExtensionPage(tab.url, shiftUrl));
  if (open) {
    try {
      await focusTab(open.id);
      return { ok: true };
    } catch { /* The user may have closed it since the lookup. */ }
  }
  await api.tabs.create({ url: shiftUrl });
  return { ok: true };
}
function occupiedActivity(c) {
  const stamps = [c.lastParticipantAt, c.lastStudentAt, c.lastReplyAt, c.binding.replyAt].filter(Number.isFinite);
  return stamps.length ? Math.max(...stamps) : null;
}
async function shiftMessage(m) {
  if (m.type === 'shift:open') return openShiftChat(m.id);
  if (m.type === 'shift:status') {
    const result = await tx(s => ({ ...summary(s), occupied: Object.values(s.scan.chats).filter(c => c.binding).map(c => ({
      id: c.id, title: c.title, curator: c.binding.curator, bindingPeriod: c.binding.period, activityAt: occupiedActivity(c),
      lastStudentAt: c.lastStudentAt ?? null, lastCuratorAt: c.lastReplyAt ?? c.binding.replyAt ?? null,
      ...waiting(c, Date.now()), muted: !!c.muted, available: Boolean(s.scan.curatorName && E.navigation(s.scan, c.id))
    })) }));
    kick();
    return result;
  }
  if (m.type !== 'shift:mute' && m.type !== 'shift:unbind') return { ok: false };
  const result = await tx(s => {
    const c = Object.hasOwn(s.scan.chats, m.id) && s.scan.chats[m.id];
    if (!monitoring(s) || s.scan.mode !== 'senior' || !c?.binding ||
        (m.expectedCurator !== undefined && m.expectedCurator !== c.binding.curator) ||
        (m.expectedPeriod !== undefined && m.expectedPeriod !== c.binding.period)) {
      return { ok: false, error: 'Привязка изменилась или режим старшего не активен.' };
    }
    if (m.type === 'shift:mute') {
      if (typeof m.muted !== 'boolean') return { ok: false };
      E.setChatMute(s.scan, m.id, m.muted);
    } else E.unbind(s.scan, m.id, Date.now());
    return { ok: true };
  });
  kick();
  return result;
}
async function dismissFree(id, version) {
  const removed = await tx(s => {
    const now = Date.now();
    const wasTransfer = Object.hasOwn(s.scan.chats, id) && s.scan.chats[id].transferAt != null;
    if (!E.dismissFree(s.scan, id, version, now)) return null;
    const lastTransfer = wasTransfer && handoverCount(s.scan, now) === 0;
    const matches = item => item.id === id || (lastTransfer && item.kind === 'handover');
    const noticeIds = new Set();
    for (const [key, item] of Object.entries(s.outbox)) {
      if (!matches(item)) continue;
      noticeIds.add(key);
      removeNotice(s, key, 'chat_dismissed', now);
    }
    for (const [key, item] of Object.entries(s.routes)) {
      if (!matches(item)) continue;
      noticeIds.add(key);
      delete s.routes[key];
    }
    return [...noticeIds];
  });
  if (!removed) return { ok: false, error: 'Чат уже изменился. Обнови список.' };
  kick();
  await Promise.allSettled(removed.map(id => notifications.clear(id)));
  return { ok: true };
}
async function popupMessage(m) {
  if (m.type === 'ui:test') {
    if (!await tx(s => Boolean(s.scan.curatorName))) return { ok: false, error: curatorRequiredMessage };
    const ref = crypto.randomUUID();
    const test = { kind: 'test' };
    try {
      await notifications.authorize();
    } catch (error) {
      await tx(s => noticeTrace(s, Date.now(), 'notification_api_result', ref, test, {
        provider: 'macos', operation: 'authorize', result: 'rejected', error_code: notificationErrorCode(error)
      }));
      return { ok: false, error: notificationError(error) };
    }
    return tx(async s => {
      try {
        await createLoggedNotification(s, 'shkolkovo-test', test,
          notification('Школково — тест', timeLabel(Date.now())), ref);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: notificationError(error) };
      }
    });
  }
  if (m.type === 'ui:status') return details(m.tabId);
  if (m.type === 'ui:set-curator') {
    const name = identity.parse(m);
    if (!name) return { ok: false, error: 'Проверь имя и фамилию куратора.' };
    const answer = await tx(s => {
      if (s.scan.curatorName && !identity.matches(s.scan.curatorName, name)) {
        return { ok: false, error: 'Имя и фамилия куратора уже сохранены.' };
      }
      if (!s.scan.curatorName) useCurator(s, name);
      return { ok: true };
    });
    kick();
    return answer;
  }
  if (m.type === 'ui:shift') return showShift();
  if (m.type === 'ui:export-logs') {
    await tx(s => {
      const report = s.shiftLogs?.pending[0];
      if (report) report.retryAt = 0;
    });
    kick();
    return { ok: true };
  }
  if (m.type === 'ui:dismiss-free') {
    if (typeof m.id !== 'string' || typeof m.version !== 'string') return { ok: false };
    return dismissFree(m.id, m.version);
  }
  if (m.type === 'ui:settings') {
    if ((m.mode !== undefined && m.mode !== 'normal' && m.mode !== 'senior') ||
        (m.pinnedInstant !== undefined && typeof m.pinnedInstant !== 'boolean')) return { ok: false };
    await tx(s => {
      if (m.mode !== undefined) {
        if (s.scan.curatorName) E.setMode(s.scan, m.mode, Date.now());
        else s.scan.mode = m.mode;
      }
      if (m.pinnedInstant !== undefined) E.setPinnedInstant(s.scan, m.pinnedInstant);
    });
    kick();
    return { ok: true };
  }
  if (m.type === 'ui:start') {
    if (!Number.isSafeInteger(m.tabId)) return { ok: false, error: selectChatTabMessage };
    const page = await send(m.tabId, { type: 'monitor:ping' }).catch(() => null);
    const answer = await tx(async s => {
      if (!s.scan.curatorName) return { ok: false, error: curatorRequiredMessage };
      const selected = await api.tabs.get(m.tabId).catch(() => null);
      const address = selected?.pendingUrl || selected?.url;
      if (!selected?.active || (address && !onChat(address))) return { ok: false, error: selectChatTabMessage };
      if (!page?.ok) return { ok: false, error: 'Открой чаты Школково. Если они уже открыты, обнови страницу и повтори запуск.' };
      if (monitoring(s) && s.tab !== m.tabId) {
        return { ok: false, error: 'Останови проверку перед запуском мониторинга в другой вкладке.' };
      }
      if (!monitoring(s)) {
        const now = Date.now();
        E.start(s.scan, now);
        shiftLog.start(s, now);
        Object.assign(s, { tab: m.tabId, lastWatchTab: m.tabId, doc: null, ready: false, coverage: null,
          connection: blankConnection(), tabBlock: null, startupBlock: '', pageIssue: '', pageCheckAt: 0,
          syncAt: now + 2.5 * MIN, result: '', error: '' });
        for (const notice of Object.values(s.outbox)) {
          notice.tab = m.tabId;
          notice.session = token(s);
        }
      }
      s.curatorSyncAt = Date.now() + 15_000;
      return { ok: true, tab: s.tab, session: token(s) };
    });
    if (!answer.ok) return answer;
    kick();
    await syncCurator(answer);
    return answer;
  }
  if (m.type === 'ui:stop' || m.type === 'ui:finish') {
    const answer = await tx(s => {
      const old = s.tab;
      const curatorName = s.scan.curatorName;
      const notices = m.type === 'ui:finish' ? [...Object.keys(s.routes), ...Object.keys(s.outbox)] : [];
      if (m.type === 'ui:finish') {
        const now = Date.now();
        for (const id of Object.keys(s.outbox)) removeNotice(s, id, 'shift_finished', now);
        const count = E.finish(s.scan);
        shiftLog.finish(s, now, 'manual', { clearedBindings: count });
        const scan = s.scan;
        const lastWatchTab = s.lastWatchTab;
        Object.assign(s, blank(), { scan, boot: bootId, lastWatchTab, result: 'Смена завершена. Удалено привязок — ' + count });
      } else pause(s, 'manual');
      return { old, notices, message: s.result, generation: s.scan.generation, curatorName };
    });
    await plan();
    await Promise.allSettled(answer.notices.map(id => notifications.clear(id)));
    if (Number.isInteger(answer.old)) await send(answer.old, { type: 'monitor:set', session: null, generation: answer.generation,
      curatorName: answer.curatorName }).catch(() => {});
    return { ok: true, message: answer.message };
  }
  return { ok: false };
}
api.runtime.onMessage.addListener((m, sender, respond) => {
  if (!m || (sender.id != null && sender.id !== api.runtime.id)) return false;
  const address = sender.url ?? sender.tab?.url;
  let action;
  if (sameExtensionPage(address, popupUrl)) action = popupMessage(m);
  else if (sameExtensionPage(address, shiftUrl)) action = shiftMessage(m);
  else if (Number.isSafeInteger(sender.tab?.id) && (sender.frameId ?? 0) === 0 && onChat(address) &&
           (!sender.documentLifecycle || sender.documentLifecycle === 'active') &&
           typeof m.documentToken === 'string' && /^[0-9a-f-]{36}$/iu.test(m.documentToken)) action = tabMessage(m, sender);
  if (!action) return false;
  action.then(respond, () => respond({ ok: false, error: 'Фоновый скрипт Safari не смог выполнить запрос.' }));
  return true;
});
api.alarms.onAlarm.addListener(a => {
  if ([HOUR_ALARM, PREFETCH_ALARM, TASK_ALARM, LOG_ALARM].includes(a.name)) kick();
});
api.tabs.onRemoved.addListener((id, info) => {
  void tx(s => {
    if (s.tab === id) {
      pause(s, info?.isWindowClosing ? 'window_closed' : 'tab_closed');
      s.result = 'Вкладка проверки закрылась. Запусти проверку из выбранной вкладки чатов.';
    }
    if (s.lastWatchTab === id) s.lastWatchTab = null;
  }).then(kick, failed);
});
api.tabs.onUpdated.addListener((id, change, tab) => {
  if (!change.status && !change.url) return;
  void tx(s => {
    if (s.tab !== id && s.lastWatchTab !== id) return false;
    const address = change.url || tab?.pendingUrl || tab?.url;
    if (address && !onChat(address)) {
      if (s.tab === id) {
        pause(s, 'page_left');
        s.result = 'Открой чаты Школково и запусти проверку из выбранной вкладки.';
      }
      if (s.lastWatchTab === id) s.lastWatchTab = null;
    } else if (s.tab === id) {
      if (change.status === 'loading') {
        Object.assign(s, { ready: false, doc: null, connection: blankConnection(), tabBlock: null,
          startupBlock: '', pageIssue: 'loading' });
      }
      s.pageCheckAt = 0;
    }
    return true;
  }).then(changed => { if (changed) kick(); }, failed);
});
api.runtime.onInstalled.addListener(kick);
api.runtime.onStartup.addListener(kick);
kick();
