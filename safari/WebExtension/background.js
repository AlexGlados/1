'use strict';
importScripts('identity.js', 'engine.js', 'schedule.js', 'notifications.js');

const api = globalThis.browser ?? globalThis.chrome;
const notifications = globalThis.ShkolkovoNotifications;
const E = globalThis.ChatEngine;
const identity = globalThis.ShkolkovoIdentity;
const MIN = 60_000;
const KEY = 'shkolkovo.monitor.v2';
const BOOT = 'shkolkovo.browserSession';
const HOUR_ALARM = 'shkolkovo.period';
const PREFETCH_ALARM = 'shkolkovo.prefetch';
const TASK_ALARM = 'shkolkovo.tasks';
const chatUrl = 'https://1.shkolkovo.online/chat';
const chatOrigin = new URL(chatUrl).origin;
const popupUrl = api.runtime.getURL('popup.html');
const shiftUrl = api.runtime.getURL('shift.html');
const stamp = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const timeLabel = value => stamp.format(value).replace(',', '') + ' МСК';
const token = state => String(state.scan.generation);
const monitoring = state => state.scan.enabled && Boolean(state.scan.curatorName);
const curatorRequiredMessage = 'Введи имя и фамилию куратора в меню расширения.';
const commandTimeout = { 'monitor:read': 28_000, 'monitor:open': 17_000 };
const blankConnection = () => ({ status: 'unknown', episode: '', since: 0, alerted: false });
function blank() {
  return { scan: E.fresh(), tab: null, lastWatchTab: null, boot: null, ownedTab: true, doc: null, ready: false, capturedHandoff: null,
    coverage: null, connection: blankConnection(), syncAt: 0, curatorSyncAt: null,
    outbox: {}, routes: {}, checked: 0, notified: 0, error: '', result: '' };
}

let db;
let snapshot;
let bootId;
let curatorFile;
let writes = Promise.resolve();
async function readCuratorFile() {
  try {
    const response = await fetch(api.runtime.getURL('curator.json'), { cache: 'no-store' });
    return response.ok ? identity.parse(await response.json()) : null;
  } catch { return null; }
}
function useCurator(s, name) {
  if (s.scan.curatorName === name) return;
  s.scan.curatorName = name;
  if (!s.scan.enabled) return;
  s.scan.generation++;
  s.curatorSyncAt = Date.now();
  s.doc = null;
  s.ready = false;
  s.connection = blankConnection();
  for (const notice of Object.values(s.outbox)) notice.session = token(s);
}
// All state and alarm writes have one owner. Network requests and DOM reads happen outside this lock.
function tx(fn) {
  const action = writes.then(async () => {
    if (!db) {
      curatorFile ??= readCuratorFile();
      const [local, session] = await Promise.all([
        api.storage.local.get(KEY), api.storage.session.get(BOOT)
      ]);
      bootId = session[BOOT] || crypto.randomUUID();
      if (!session[BOOT]) await api.storage.session.set({ [BOOT]: bootId });
      db = local[KEY] || blank();
      snapshot = JSON.stringify(db);
      if (db.boot !== bootId || db.ownedTab !== true) {
        // Older versions could use the operator's tab. Tab IDs also expire when Safari restarts.
        Object.assign(db, { tab: null, lastWatchTab: null, doc: null, ready: false, coverage: null,
          connection: blankConnection(), boot: bootId, ownedTab: true, routes: {} });
      }
    }
    try {
      const fileName = await curatorFile;
      if (fileName) useCurator(db, fileName);
      if (monitoring(db)) E.advance(db.scan, Date.now());
      const value = await fn(db);
      const next = JSON.stringify(db);
      if (snapshot !== next) {
        await api.storage.local.set({ [KEY]: db });
        snapshot = next;
      }
      return value;
    } catch (error) {
      db = JSON.parse(snapshot);
      throw error;
    }
  });
  writes = action.catch(() => {});
  return action;
}

function pause(s) {
  if (Number.isInteger(s.tab)) s.lastWatchTab = s.tab;
  E.stop(s.scan);
  Object.assign(s, { tab: null, doc: null, ready: false, syncAt: 0, curatorSyncAt: null,
    connection: blankConnection(), error: '' });
}
async function monitorTab(s) {
  if (Number.isSafeInteger(s.tab)) return s.tab;
  let tab;
  if (s.boot === bootId && Number.isSafeInteger(s.lastWatchTab)) {
    tab = await api.tabs.get(s.lastWatchTab).catch(() => null);
    if (tab) {
      const address = tab.pendingUrl || tab.url;
      const onMonitorPage = address ? onChat(address) : (await send(tab.id, { type: 'monitor:ping' }).catch(() => null))?.ok;
      if (!onMonitorPage) tab = null;
    }
  }
  if (!tab) tab = await api.tabs.create({ url: chatUrl, active: false });
  Object.assign(s, { tab: tab.id, lastWatchTab: tab.id, boot: bootId, doc: null, ready: false,
    coverage: null, connection: blankConnection() });
  for (const notice of Object.values(s.outbox)) notice.tab = tab.id;
  return tab.id;
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
  const reply = await send(ref.tab, { type: 'monitor:set', session: ref.session, generation: ref.generation,
    curatorName: ref.curatorName }).catch(() => null);
  if (reply?.ok) await tx(s => {
    if (monitoring(s) && s.tab === ref.tab && token(s) === ref.session) s.curatorSyncAt = null;
  });
}
async function backgroundTab(id) {
  const tab = await api.tabs.get(id);
  if (tab.status === 'loading' || (tab.url && !onChat(tab.url)) ||
      (tab.pendingUrl && !onChat(tab.pendingUrl))) return false;
  return !tab.active || (await api.windows.get(tab.windowId)).focused === false;
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
function addNotice(s, item) {
  for (const [id, queued] of Object.entries(s.outbox)) {
    if (item.kind !== queued.kind || item.id !== queued.id) continue;
    if (item.key && item.key === queued.key) return;
    if (item.phase === 'reminder' && item.episode === queued.episode) removeNotice(s, id);
  }
  const id = 'shkolkovo-' + crypto.randomUUID();
  s.outbox[id] = { ...item, tab: s.tab, session: token(s), retryAt: 0 };
}
function removeNotice(s, id) {
  delete s.outbox[id];
  if (!Object.values(s.outbox).some(n => n.retryAt > 0)) s.error = '';
}
function connection(s, status, verified = false) {
  if (!['unknown', 'online', 'offline', 'connecting'].includes(status)) return;
  const c = s.connection;
  const previous = c.status;
  c.status = status;
  if (status === 'unknown') return;
  if (c.episode !== status) {
    c.episode = status;
    c.since = Date.now();
    c.alerted = false;
  } else if (previous === 'unknown' && status === 'connecting' && !c.alerted) c.since = Date.now();
  if (c.alerted || (status !== 'offline' &&
      !(status === 'connecting' && verified && Date.now() - c.since >= 30_000))) return;
  addNotice(s, { kind: status, since: c.since });
  c.alerted = true;
}

// A second wake-up source covers service worker suspension during short retries.
let timer;
let queued = false;
let runningRead;
let runningSync;
let runningProbe;
let handoffCapture;
let captureRetryAt = 0;
let runningDelivery;
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
function eligible(s, n) {
  if (!monitoring(s) || n.tab !== s.tab || n.session !== token(s)) return false;
  if (n.kind === 'offline' || n.kind === 'connecting') {
    return n.kind === s.connection.episode && n.since === s.connection.since;
  }
  return E.noticeEligible(s.scan, n, Date.now());
}

function addRows(s, result) {
  E.observe(s.scan, result.rows, Date.now(), result.observedAt, { partial: result.partial === true });
}

async function plan() {
  const tasks = await tx(async s => {
    clearTimeout(timer);
    if (!monitoring(s)) {
      await Promise.all([HOUR_ALARM, PREFETCH_ALARM, TASK_ALARM].map(name => alarm(name, Infinity)));
      return [];
    }
    if (!Number.isSafeInteger(s.tab)) await monitorTab(s);
    const now = Date.now();
    const ref = { tab: s.tab, session: token(s), doc: s.doc };
    if (runningRead && !current(s, runningRead)) runningRead = null;
    if (runningProbe && !current(s, runningProbe)) runningProbe = null;
    if (handoffCapture && !current(s, handoffCapture)) {
      handoffCapture.done.resolve();
      handoffCapture = null;
      captureRetryAt = 0;
    }
    if (runningSync && (runningSync.session !== ref.session || runningSync.tab !== ref.tab)) runningSync = null;
    const actions = [];
    const boundary = E.boundary(now, s.scan);
    const preload = E.prefetchTime(now, s.scan);
    const nextPreload = preload > now ? preload : preload + 60 * MIN;
    const times = [now + MIN, boundary, nextPreload];
    if (Number.isFinite(s.curatorSyncAt)) {
      if (s.curatorSyncAt <= now) {
        const update = { ...ref, generation: s.scan.generation, curatorName: s.scan.curatorName };
        s.curatorSyncAt = now + 15_000;
        actions.push(() => syncCurator(update));
      }
      times.push(s.curatorSyncAt);
    }
    const handoffAt = s.scan.period - 5 * MIN;
    if (s.doc && now >= handoffAt && now < handoffAt + MIN && s.capturedHandoff !== handoffAt && !handoffCapture) {
      if (now >= captureRetryAt) {
        const request = { ...ref, handoffAt, done: Promise.withResolvers() };
        handoffCapture = request;
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
      inFlight.add(target);
      actions.push(() => readSchedule(generation, target));
    }
    for (const retry of [s.scan.scheduleRetryAt, s.scan.prefetchRetryAt]) if (retry > now) times.push(retry);
    for (const item of E.dueNotices(s.scan, now)) addNotice(s, item);
    const noticeAt = E.nextNoticeAt(s.scan, now);
    if (noticeAt > now) times.push(noticeAt);
    for (const [id, item] of Object.entries(s.outbox)) {
      if (!eligible(s, item)) {
        removeNotice(s, id);
        continue;
      }
      if (item.retryAt > now) { times.push(item.retryAt); continue; }
      if (!runningDelivery) {
        runningDelivery = id;
        actions.push(() => deliver(id));
      }
    }
    if (runningRead && current(s, runningRead) && s.syncAt <= now) s.syncAt = now + MIN;
    if (s.doc && !runningSync && !runningRead && !handoffCapture && s.syncAt <= now) {
      runningSync = ref;
      actions.push(() => sync(ref));
    }
    if (s.syncAt > now) times.push(s.syncAt);
    if (s.doc && !runningProbe && s.connection.status === 'connecting' && !s.connection.alerted) {
      const due = Math.max(s.connection.since + 30_000, retryWake);
      if (now >= due) {
        runningProbe = ref;
        actions.push(() => probe(ref));
      } else times.push(due);
    }
    if (s.ready && s.doc && !runningSync && !runningRead && !handoffCapture) {
      const job = E.next(s.scan, now);
      if (job) {
        runningRead = ref;
        actions.push(() => readChat(ref, job));
      } else {
        const when = E.earliest(s.scan, now);
        if (when > now) times.push(when);
      }
    }
    const at = Math.min(...times);
    await alarm(TASK_ALARM, at);
    timer = setTimeout(kick, Math.max(25, at - Date.now()));
    return actions;
  });
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
  const iso = new Date(period + 3 * 60 * MIN).toISOString();
  let result;
  let error;
  try { result = await ShSchedule.read(iso.slice(0, 10), Number(iso.slice(11, 13))); }
  catch (e) { error = e.message || 'Не удалось прочитать таблицу.'; }
  try {
    await tx(s => monitoring(s) && E.installRoster(s.scan, { generation, period }, result?.names, error, Date.now(), result?.directory));
  } finally {
    if (fetching.get(period) === generation) fetching.delete(period);
    kick();
  }
}
async function readChat(ref, job) {
  let history;
  try {
    if (!await backgroundTab(ref.tab)) history = { blocked: true };
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
      history = await send(ref.tab, { type: 'monitor:read', session: ref.session,
        id: job.id, sinceAt: job.sinceAt, expiresAt, job }, ref.doc);
    }
  } catch { history = { ready: false, reason: 'Вкладка не ответила на запрос истории.' }; }
  finally {
    try {
      if (history) await tx(s => {
        if (!current(s, ref)) return;
        if (history.blocked) { E.defer(s.scan, job, Date.now(), 10_000); return; }
        const c = s.scan.chats[job.id];
        const previousCheck = c?.checked;
        for (const n of E.apply(s.scan, job, history, Date.now())) addNotice(s, { ...n, period: job.period });
        if (c?.checked && c.checked !== previousCheck) s.checked = (s.checked || 0) + 1;
      });
    } finally { if (runningRead === ref) runningRead = null; kick(); }
  }
}
async function sync(ref) {
  let result;
  try {
    if (await backgroundTab(ref.tab) && await tx(s => current(s, ref))) {
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
    await tx(s => { if (current(s, ref)) connection(s, reply?.connection || 'unknown', true); });
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
async function deliver(id) {
  try {
    await tx(async s => {
      const n = s.outbox[id];
      if (!n || !monitoring(s)) return;
      try {
        const existing = await notifications.getAll();
        for (const routeId of Object.keys(s.routes)) {
          if (!Object.hasOwn(existing, routeId)) delete s.routes[routeId];
        }
        // Recheck the episode immediately before submitting, including after a delayed alarm.
        const now = Date.now();
        E.advance(s.scan, now);
        if (!eligible(s, n)) {
          removeNotice(s, id);
          return;
        }
        if (!Object.hasOwn(existing, id)) {
          const latest = { ...n };
          if (n.kind === 'handover') latest.count = handoverCount(s.scan, now);
          if (n.phase === 'reminder' && Number.isFinite(n.at)) latest.minutes = Math.max(0, Math.floor((now - n.at) / MIN));
          const [title, message] = noticeCopy(latest);
          await notifications.create(id, notification(title, message));
        }
        s.routes[id] = { tab: n.tab, id: n.id || null, kind: n.kind, boot: bootId };
        if (n.kind !== 'offline' && n.kind !== 'connecting') s.notified = (s.notified || 0) + 1;
        removeNotice(s, id);
      } catch (error) {
        n.retryAt = Date.now() + MIN;
        s.error = notificationError(error) + ' Следующая попытка через минуту.';
      }
    });
  } finally { runningDelivery = null; kick(); }
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
  if (m.type === 'monitor:rows') await pendingHandoffRows(tab, doc, m.session);
  const result = await tx(s => {
    if (m.type === 'monitor:hello') {
      if (!monitoring(s) || s.tab !== tab) return { session: null, generation: s.scan.generation };
      if (token(s) !== handshake.session) return null;
      if (s.doc !== doc) {
        s.doc = doc;
        s.ready = false;
        s.connection.status = 'unknown';
      }
      return { session: token(s), generation: s.scan.generation, curatorName: s.scan.curatorName };
    }
    if (!fromTab(s, tab, m.session, doc)) return { ok: false };
    if (!s.doc) s.doc = doc;
    switch (m.type) {
      case 'monitor:rows':
        if (!Array.isArray(m.rows)) return { ok: false };
        addRows(s, m);
        s.ready = true;
        break;
      case 'monitor:coverage': {
        if (typeof m.complete !== 'boolean') return { ok: false };
        const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
        const reason = !m.complete && typeof m.reason === 'string' ? m.reason.slice(0, 200) : '';
        s.coverage = {
          complete: m.complete, partial: m.partial === true, scanned: count(m.scanned), total: count(m.total), reason,
          retryAt: Number.isFinite(m.retryAt) ? m.retryAt : null
        };
        if (m.complete) {
          if (!s.coverage.partial && Array.isArray(m.keys) && m.keys.every(key => typeof key === 'string' && key.length > 0)) {
            E.reconcileRows(s.scan, m.keys);
          } else {
            s.scan.baseline = true;
            s.scan.coveragePending = false;
          }
        }
        break;
      }
      case 'monitor:connection':
        connection(s, m.status);
        break;
      case 'monitor:connection-alert':
        if (s.connection.status === m.status) connection(s, m.status, true);
        break;
      case 'monitor:wake': break;
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
  return { active, curatorRequired: !s.scan.curatorName, mode: s.scan.mode || 'normal',
    period: active ? timeLabel(s.scan.period) : '', lastRead: s.scan.scheduleReadAt ? timeLabel(s.scan.scheduleReadAt) : '',
    scheduleError: s.scan.scheduleError || '', prefetchError: s.scan.prefetchError || '',
    nextPeriod: active ? timeLabel(s.scan.period + 60 * MIN) : '',
    retryAt: s.scan.scheduleRetryAt > Date.now() ? timeLabel(s.scan.scheduleRetryAt) : '',
    loading: active && !Array.isArray(s.scan.roster), result: s.result };
}
function coverageLabel(s) {
  if (!monitoring(s) || !s.coverage) return '';
  const { complete, partial, scanned, total, reason, retryAt } = s.coverage;
  const count = total !== null && scanned !== null ? ` (${scanned}/${total})` : '';
  if (complete) return (partial ? 'Список недавних чатов просмотрен' : 'Обход списка завершён') + count + '.';
  const incomplete = partial ? 'Просмотр недавних чатов не завершён' : 'Обход списка неполный';
  return [incomplete + count + '.', reason,
    retryAt > Date.now() ? 'Повтор в ' + timeLabel(retryAt) + '.' : 'Проверка продолжится.'].filter(Boolean).join(' ');
}
function waiting(c, now) {
  const since = Number.isFinite(c.waitSince) ? c.waitSince : null;
  return { waitingSince: since, waitMs: since === null ? null : Math.max(0, now - since) };
}
async function details(tabId) {
  const data = await tx(s => {
    const now = Date.now();
    const chats = Object.values(s.scan.chats);
    const recent = chats.filter(c => E.isRecentChat(c, now));
    const uncertain = recent.filter(c => c.status === 'Не определено');
    const failedChat = uncertain.filter(c => c.reason).sort((a, b) => b.at - a.at)[0];
    const free = chats.filter(c => E.isFree(c, now)).map(c => ({
      id: c.id, title: c.title, version: E.freeVersion(c), ...waiting(c, now)
    })).sort((a, b) => (a.waitingSince ?? Infinity) - (b.waitingSince ?? Infinity) || a.title.localeCompare(b.title, 'ru'));
    return { ...summary(s), canStart: Boolean(s.scan.curatorName), supportsFreeDismissal: true, rulesVersion: 3,
      attached: Number.isSafeInteger(s.lastWatchTab),
      here: monitoring(s) && tabId === s.tab, ready: monitoring(s) && s.ready, pinnedInstant: s.scan.pinnedImmediate !== false,
      scanComplete: s.coverage?.complete ?? null, scanStatus: coverageLabel(s), free,
      bindings: chats.filter(c => c.binding).length,
      checked: s.checked || 0, notified: s.notified || 0,
      pending: recent.filter(c => c.pending).length, uncertain: uncertain.length,
      reason: failedChat ? `Не удалось проверить «${failedChat.title}». ${failedChat.reason}` : '',
      connection: s.connection.status,
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
      lastMessageAt: c.lastMessageAt ?? c.checked?.at ?? null, lastCuratorAt: c.lastReplyAt ?? c.binding.replyAt ?? null,
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
      removeNotice(s, key);
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
    try {
      await notifications.authorize?.();
      await notifications.create('shkolkovo-test', notification('Школково — тест', timeLabel(Date.now())));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: notificationError(error) };
    }
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
    const answer = await tx(async s => {
      if (!s.scan.curatorName) return { ok: false, error: curatorRequiredMessage };
      const tab = await monitorTab(s);
      if (!s.scan.enabled) {
        E.start(s.scan, Date.now());
        for (const notice of Object.values(s.outbox)) notice.session = token(s);
        Object.assign(s, { syncAt: Date.now() + 2.5 * MIN, result: '', error: '' });
      }
      s.curatorSyncAt = Date.now() + 15_000;
      return { ok: true, tab, session: token(s), generation: s.scan.generation, curatorName: s.scan.curatorName };
    });
    if (!answer.ok) return answer;
    kick();
    // A newly created content document will also request the session with monitor:hello.
    await syncCurator(answer);
    return answer;
  }
  if (m.type === 'ui:stop' || m.type === 'ui:finish') {
    const answer = await tx(s => {
      const old = s.tab;
      const curatorName = s.scan.curatorName;
      const notices = m.type === 'ui:finish' ? [...Object.keys(s.routes), ...Object.keys(s.outbox)] : [];
      if (m.type === 'ui:finish') {
        const count = E.finish(s.scan);
        const scan = s.scan;
        const lastWatchTab = s.lastWatchTab;
        Object.assign(s, blank(), { scan, boot: bootId, lastWatchTab, result: 'Смена завершена. Удалено привязок — ' + count });
      } else pause(s);
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
           typeof m.documentToken === 'string' && /^[0-9a-f-]{36}$/iu.test(m.documentToken)) action = tabMessage(m, sender);
  if (!action) return false;
  action.then(respond, () => respond({ ok: false, error: 'Safari не смогла выполнить действие. Проверь доступ расширения к сайтам.' }));
  return true;
});
api.alarms.onAlarm.addListener(a => { if ([HOUR_ALARM, PREFETCH_ALARM, TASK_ALARM].includes(a.name)) kick(); });
api.tabs.onRemoved.addListener(id => {
  void tx(s => {
    if (s.tab === id) pause(s);
    if (s.lastWatchTab === id) s.lastWatchTab = null;
  }).then(kick, failed);
});
api.tabs.onUpdated.addListener((id, change) => {
  if (change.status === 'loading') void tx(s => {
    if (s.tab === id) { s.ready = false; s.doc = null; s.connection.status = 'unknown'; }
  }).then(kick, failed);
});
notifications.onClosed?.addListener?.(id => { void tx(s => { delete s.routes[id]; }).catch(failed); });
notifications.onClicked?.addListener?.(id => {
  void (async () => {
    const target = await tx(s => {
      const route = s.routes[id];
      return s.scan.curatorName && route && { ...route, doc: s.doc, session: monitoring(s) ? token(s) : null,
        row: E.navigation(s.scan, route.id) };
    });
    if (!target || target.boot !== bootId || !(await send(target.tab, { type: 'monitor:ping' }))?.ok) return;
    if (target.row) {
      const result = await send(target.tab, { type: 'monitor:open', ...target.row, session: target.session }, target.doc);
      if (!result?.ok) return;
    }
    await focusTab(target.tab);
    await notifications.clear(id);
  })().catch(() => {});
});
api.runtime.onInstalled.addListener(kick);
api.runtime.onStartup.addListener(kick);
kick();
