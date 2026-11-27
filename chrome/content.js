(() => {
  'use strict';
  if (location.origin !== 'https://1.shkolkovo.online' || !/^\/chat\/?$/u.test(location.pathname)) return;

  const runtime = globalThis.chrome?.runtime;
  if (typeof runtime?.sendMessage !== 'function') return;
  const runtimeId = runtime.id;
  const dom = globalThis.ShkolkovoDom;
  const minute = 60_000;
  const day = 24 * 60 * minute;
  const retryGapDelay = 7_000;
  const headRetryDelay = 5_000;
  const latestPossibleAt = row => row.precision === 'day' ? row.at + day - 1 : row.at;
  const validPage = () => /^\/chat\/?$/u.test(location.pathname);
  const pageListeners = new AbortController();
  let detached = false;
  let helloTimer = null;
  let session = null;
  let curatorName = null;
  let revision = 0;
  let generation = -1;
  let activeRead = null;
  let activeSweep = null;
  let sweepTimer = null;
  let recoveryTimer = null;
  let recoveryNeeded = false;
  let recovering = false;
  let startupCutoff = null;
  let headThrough = null;
  let headRetryAt = 0;
  let navigation = null;
  const positions = new Map();
  const ambiguous = new Set();
  let listRoot = null;
  let captureTimer = null;
  let fallback = null;
  let minuteCheck = null;
  let minuteWatch = null;
  let lastCapture = '';
  let lastInput = -Infinity;
  const connection = globalThis.ShkolkovoConnection.create({
    dom,
    onChange: status => { if (session) void send({ type: 'monitor:connection', session, status: status || 'unknown' }); },
    send: status => send({ type: 'monitor:connection-alert', session, status }),
  });

  function detach() {
    if (detached) return;
    detached = true;
    revision++;
    clearTimeout(helloTimer);
    // A message can fail inside a connection observer callback.
    queueMicrotask(() => {
      pageListeners.abort();
      setSession(null);
    });
  }

  function contextActive() {
    if (detached) return false;
    const current = globalThis.chrome?.runtime;
    if (typeof current?.sendMessage === 'function' && (!runtimeId || current.id === runtimeId)) return true;
    detach();
    return false;
  }

  async function send(message) {
    if (!contextActive()) return null;
    try {
      const reply = await runtime.sendMessage(message);
      return contextActive() ? reply : null;
    } catch (error) {
      if (/extension context invalidated/i.test(error?.message ?? '')) detach();
      return null;
    }
  }

  function userPresent() {
    return !document.hidden || document.hasFocus() || Date.now() - lastInput < 10_000;
  }

  function hasDraft() {
    const composer = document.getElementById('chat-text-input');
    return Boolean((composer?.value ?? composer?.textContent ?? '').trim() ||
      Array.from(document.querySelectorAll('input[type="file"]')).some(input => input.files?.length) ||
      Array.from(document.querySelectorAll('.ant-upload-list-item, [data-pending-attachment], [class*="ChatInput_editPreview__"]'))
        .some(el => el.getClientRects().length));
  }

  function protectionReason() {
    if (userPresent()) return 'in_use';
    if (hasDraft()) return 'draft';
    return validPage() ? '' : 'page';
  }

  function inspectionBlock() {
    if (!contextActive()) return 'page';
    const protectedBy = protectionReason();
    if (protectedBy) return protectedBy;
    if (!navigator.onLine || ['connecting', 'offline'].includes(connection.details().connection)) return 'connection';
    return '';
  }

  function canInspect() {
    return !inspectionBlock();
  }

  function scan() {
    const observedAt = Date.now();
    const virtual = dom.getVirtualList?.();
    const rows = dom.getRows(virtual || (listRoot?.isConnected ? listRoot : document));
    listRoot = virtual || dom.getListRoot(rows);
    connection.setListRoot(listRoot);
    const parsed = rows.filter(row => Number.isFinite(row.at));
    const busy = listRoot?.closest?.('[aria-busy="true"]') || Array.from(listRoot?.querySelectorAll(
      '[aria-busy="true"], [role="progressbar"], .ant-spin-spinning') || []).some(el => el.getClientRects().length);
    // A missing list is normal during reload, filtering or login. Do not mark it as the shift baseline.
    const layout = virtual ? dom.getListLayout(virtual, rows, true) : null;
    const ready = Boolean(validPage() && !busy &&
      (rows.length || layout?.positions.length || (!virtual && dom.hasLoadedEmptyList())));
    const selected = parsed.find(row => row.selected === true);
    const panel = selected && !/^\d+__\d+__\d+$/u.test(selected.rowId || '') && dom.getChat();
    const selectedId = selected && panelMatches(panel, selected) ? panel.id : null;
    const ordered = layout ? parsed.filter(row => Number.isSafeInteger(row.position))
      .map(row => ({ position: row.position, at: row.at, precision: row.precision }))
      .sort((a, b) => a.position - b.position) : [];
    return { ready, observedAt, partial: true, layout, ordered,
      unrecognized: rows.filter(row => !Number.isFinite(row.at)).map(row => row.key),
      rows: ready ? parsed.map(({ key, label, fallbackKey, at, precision, pinned, signal, assignedToSelf, unread, position }) => ({
      id: key, title: label, at, precision, pinned, ...(signal ? { signal } : {}),
      ...(fallbackKey ? { fallbackKey } : {}), ...(selectedId && selected.key === key ? { identity: selectedId } : {}),
      ...(Number.isSafeInteger(position) ? { position } : {}), ...(typeof unread === 'boolean' ? { unread } : {}),
      ...(typeof assignedToSelf === 'boolean' ? { assignedToSelf } : {}),
    })) : [] };
  }

  function publish({ ready, observedAt, rows, partial, headThrough: coveredThrough }, force = false) {
    rows = rows.filter(row => !ambiguous.has(row.id));
    const complete = Number.isFinite(coveredThrough);
    const capture = JSON.stringify([partial, complete, rows]);
    if (!ready || (!force && capture === lastCapture)) return;
    lastCapture = capture;
    const sendingSession = session;
    return send({ type: 'monitor:rows', session, observedAt, rows, partial,
      ...(complete ? { headThrough: coveredThrough } : {}) }).then(result => {
      if (session !== sendingSession) return;
      if (result?.ok && complete) {
        headThrough = Math.max(headThrough ?? -Infinity, coveredThrough);
      } else if (!result?.ok && lastCapture === capture) {
        lastCapture = '';
        scheduleCapture(2_000);
      }
    });
  }

  function report(force = false) {
    if (!session || !contextActive()) return;
    clearTimeout(captureTimer);
    captureTimer = null;
    if (Number.isFinite(startupCutoff) || activeSweep || activeRead || navigation) return;
    const root = dom.getVirtualList?.();
    const startedAt = Date.now();
    if (headRetryAt > startedAt) {
      scheduleCapture(headRetryAt - startedAt);
      return;
    }
    const limit = Number.isFinite(headThrough) ? Math.floor(headThrough / minute) * minute : null;
    if (!root || root.scrollTop < 1) {
      const snapshot = scan();
      const coverage = listCoverage(snapshot, 0, row => limit !== null && latestPossibleAt(row) < limit);
      const timed = new Set(snapshot.ordered.map(row => row.position));
      const complete = snapshot.layout
        ? (limit === null || coverage?.complete) && rowsHavePositions(snapshot) && coversPrefix(timed, coverage?.last)
        : snapshot.unrecognized.length === 0;
      if (!root || complete || !canInspect()) {
        void publish({ ...snapshot, headThrough: complete ? startedAt : null }, force);
        return;
      }
    }
    if (!root || !canInspect()) return;
    void reportHead(root, limit, startedAt, force).catch(() => {
      if (session) scheduleCapture(2_000);
    });
  }

  async function reportHead(root, limit, startedAt, force) {
    const controller = new AbortController();
    const startedSession = session;
    activeSweep = controller;
    const current = () => !controller.signal.aborted && session === startedSession && canInspect() && root.isConnected;
    const found = new Map();
    const conflicts = new Set();
    const timed = new Set();
    let positioned = true;
    let complete = false;
    try {
      if (limit !== null) {
        const deadline = startedAt + 15_000;
        const outcome = await walkList(root, controller.signal, () => current() && Date.now() < deadline,
          frame => {
            rememberRows(found, conflicts, frame);
            for (const row of frame.ordered) timed.add(row.position);
            positioned &&= rowsHavePositions(frame);
          }, row => latestPossibleAt(row) < limit);
        complete = outcome.complete && positioned && coversPrefix(timed, outcome.last);
      }
      if (!current()) return;
      await moveList(root, 0, controller.signal);
      if (!current() || dom.getVirtualList?.() !== root || root.scrollTop >= 1) return;
      const snapshot = scan();
      if (!snapshot.ready) return;
      if (limit === null) {
        const coverage = listCoverage(snapshot, 0, () => false);
        complete = rowsHavePositions(snapshot) && coversPrefix(new Set(snapshot.ordered.map(row => row.position)), coverage?.last);
      }
      rememberRows(found, conflicts, snapshot);
      const rows = [...found.values()].filter(row => !conflicts.has(row.id));
      for (const row of rows) if (Number.isSafeInteger(row.position)) positions.set(row.id, row.position);
      if (activeSweep === controller) activeSweep = null;
      await publish({ ...snapshot, rows, headThrough: complete ? startedAt : null }, force);
    } finally {
      if (activeSweep === controller) activeSweep = null;
      if (session === startedSession && canInspect()) {
        void send({ type: 'monitor:wake', session });
        if (!complete) {
          headRetryAt = Date.now() + headRetryDelay;
          scheduleCapture(headRetryDelay);
        }
      }
    }
  }

  function coversPrefix(timed, last) {
    if (!Number.isSafeInteger(last) || last < 1) return false;
    let covered = 0;
    for (const position of timed) if (position >= 1 && position <= last) covered++;
    return covered === last;
  }

  function rowsHavePositions(frame) {
    return frame.layout?.positions.every(({ position }) => Number.isSafeInteger(position) &&
      position > 0 && position <= frame.layout.total);
  }

  function listCoverage(frame, previousLast, pastLimit) {
    const total = frame.layout?.total;
    if (!total) return null;
    const timed = new Map(frame.ordered.map(row => [row.position, row]));
    const rendered = frame.layout.positions.map(row => row.position)
      .filter(position => Number.isSafeInteger(position) && position > 0 && position <= total)
      .sort((a, b) => a - b);
    if (!rendered.length) return null;
    let last = previousLast;
    for (const position of rendered) {
      if (position <= last) continue;
      last = position;
      const row = timed.get(position);
      // An unknown timestamp cannot establish the sorted time boundary.
      if (row && pastLimit(row)) return { last, complete: true };
    }
    return { last, complete: last === total };
  }

  function scheduleCapture(delay = 100) {
    if (!session || captureTimer !== null || !contextActive()) return;
    captureTimer = setTimeout(report, delay);
  }

  const observer = new MutationObserver(records => {
    if (!listRoot?.isConnected || records.some(record => listRoot.contains(record.target))) scheduleCapture();
    if (minuteWatch && records.some(record => minuteWatch.root?.contains(record.target))) minuteWatch.check();
  });

  function scheduleSweep(delay = 250) {
    if (!session || !Number.isFinite(startupCutoff) || sweepTimer !== null || activeSweep || !contextActive()) return;
    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      void sweepList().catch(() => {
        if (!session || !Number.isFinite(startupCutoff)) return;
        reportCoverage(false, 0, 'Не удалось определить свежие чаты в списке.');
        scheduleSweep(3_000);
      });
    }, delay);
  }

  function reportCoverage(complete, scanned, reason, snapshot) {
    return send({ type: 'monitor:coverage', session, complete, scanned, total: null, reason, partial: true,
      ...(!complete ? { retryAt: Date.now() + 3_000 } : {}), ...snapshot });
  }

  function moveList(root, offset, signal) {
    const top = Math.max(0, Math.min(offset, root.scrollHeight - root.clientHeight));
    if (signal.aborted || !root.isConnected || Math.abs(root.scrollTop - top) < 1) return Promise.resolve();
    return new Promise(resolve => {
      const range = () => dom.getListLayout(root, []).positions.map(item => item.position).join(',');
      const previousRange = range();
      const changes = new MutationObserver(() => {
        if (range() !== previousRange) done();
      });
      const deadline = setTimeout(done, 180);
      function done() {
        clearTimeout(deadline);
        changes.disconnect();
        signal.removeEventListener('abort', done);
        resolve();
      }
      changes.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['aria-posinset', 'aria-setsize', 'style'] });
      signal.addEventListener('abort', done, { once: true });
      root.scrollTop = top;
    });
  }

  function offsetFor(position, entries, root, total) {
    const before = entries.filter(entry => entry.top !== null && entry.position <= position).at(-1);
    const after = entries.find(entry => entry.top !== null && entry.position >= position);
    let estimate;
    if (before && after && before.position !== after.position) {
      estimate = before.top + (after.top - before.top) * (position - before.position) / (after.position - before.position);
    } else if (before && after) {
      estimate = before.top;
    } else {
      const closest = before || after;
      const average = root.scrollHeight / total;
      estimate = closest ? closest.top + (position - closest.position) * average : (position - 1) * average;
    }
    return estimate - root.clientHeight / 3;
  }

  // Jump to an index by bounding the scroll offset between rendered ranges.
  // Row heights vary, so use the estimated position only for the first jump.
  async function showPosition(root, position, signal, allowed) {
    let lowest = 0;
    let highest = Math.ceil(Math.max(0, root.scrollHeight - root.clientHeight));
    for (let attempt = 0; attempt < 16 && allowed() && !signal.aborted; attempt++) {
      const { total, positions: rendered } = dom.getListLayout(root, []);
      if (!total || position > total || !rendered.length) return false;
      if (rendered.some(row => row.position === position)) return true;
      const first = rendered[0].position;
      const last = rendered.at(-1).position;
      if (position < first) highest = Math.min(highest, Math.ceil(root.scrollTop) - 1);
      else if (position > last) lowest = Math.max(lowest, Math.floor(root.scrollTop) + 1);
      else return false;
      if (lowest > highest) return false;
      const estimate = Math.round(offsetFor(position, rendered, root, total));
      const target = attempt === 0 && estimate >= lowest && estimate <= highest
        ? estimate : Math.floor((lowest + highest) / 2);
      await moveList(root, target, signal);
    }
    return false;
  }

  async function walkList(root, signal, allowed, visit, pastLimit = () => false) {
    let last = 0;
    if (!allowed()) return { complete: false, last };
    await moveList(root, 0, signal);
    let total;
    while (allowed()) {
      const frame = scan();
      if (listRoot !== root || !frame.ready) break;
      if (await visit(frame)) return { complete: false, last };
      if (!frame.layout?.total) break;
      total ??= frame.layout.total;
      if (frame.layout.total !== total) break;
      const coverage = listCoverage(frame, last, pastLimit);
      if (!coverage) break;
      last = coverage.last;
      if (coverage.complete) return { complete: true, last };
      const offset = root.scrollTop;
      if (root.clientHeight <= 0) break;
      await moveList(root, offset + root.clientHeight * 0.75, signal);
      if (root.scrollTop <= offset) break;
    }
    return { complete: false, last };
  }

  function rememberRows(found, conflicts, snapshot) {
    for (const row of snapshot.rows) {
      const previous = found.get(row.id);
      if (previous && previous.position !== row.position && previous.at === row.at && !row.id.startsWith('id:')) conflicts.add(row.id);
      if (!previous || row.at >= previous.at) found.set(row.id, row);
    }
  }

  function recordGaps(last, timed, keys, unrecognized) {
    if (!last) return { skipped: unrecognized.size, ranges: [...unrecognized].map(key => ({ key })) };
    const positions = [...new Set([...timed, ...keys.keys()])]
      .filter(position => position > 0 && position <= last).sort((a, b) => a - b);
    const ranges = [];
    let skipped = 0;
    let prior = 0;
    for (const position of [...positions, last + 1]) {
      if (position > prior + 1) {
        ranges.push({ first: prior + 1, last: position - 1 });
        skipped += position - prior - 1;
      }
      if (position <= last && !timed.has(position)) {
        ranges.push({ first: position, last: position, key: keys.get(position) });
        skipped++;
      }
      prior = position;
    }
    const positioned = new Set(keys.values());
    for (const key of unrecognized) {
      if (!positioned.has(key)) {
        ranges.push({ key });
        skipped++;
      }
    }
    return { skipped, ranges };
  }

  function scheduleRecovery() {
    if (!session || !recoveryNeeded || recovering || recoveryTimer !== null || !contextActive()) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      recovering = true;
      void recoverSkipped().catch(() => {}).finally(() => {
        recovering = false;
        scheduleRecovery();
      });
    }, retryGapDelay);
  }

  async function recoverSkipped() {
    const available = () => !activeRead && !activeSweep && !navigation && canInspect();
    if (!recoveryNeeded || !available()) return;
    const startedSession = session;
    const reply = await send({ type: 'monitor:recovery-next', session });
    if (!reply?.ok || session !== startedSession) return;
    const batch = reply.recovery;
    if (!batch) {
      recoveryNeeded = false;
      return;
    }
    if (!available() || !scan().ready) return;
    const controller = new AbortController();
    activeSweep = controller;
    const root = dom.getVirtualList?.();
    const current = () => session === startedSession && !controller.signal.aborted && canInspect() &&
      (!root || (root.isConnected && dom.getVirtualList?.() === root));
    const results = [];
    const rows = new Map();
    try {
      for (const { position, key } of batch.targets) {
        if (!current()) return;
        if (root && Number.isSafeInteger(position)) {
          const deadline = Date.now() + 1_200;
          await showPosition(root, position, controller.signal, () => current() && Date.now() < deadline);
        }
        if (!current()) return;
        const snapshot = scan();
        if (!snapshot.ready) return;
        const row = snapshot.rows.find(item => key ? item.id === key : item.position === position);
        const resolved = Boolean(row && !ambiguous.has(row.id));
        results.push({ ...(Number.isSafeInteger(position) ? { position } : {}), ...(key ? { key } : {}), resolved });
        if (resolved && row.precision !== 'day' && row.at > batch.cutoff) rows.set(row.id, row);
      }
      if (root) await moveList(root, 0, controller.signal);
      if (!current()) return;
      await reportCoverage(true, null, '', {
        recovery: true, recoveryId: batch.id, results, observedAt: Date.now(), rows: [...rows.values()]
      });
    } finally {
      if (current() && root?.scrollTop >= 1) await moveList(root, 0, controller.signal).catch(() => {});
      if (activeSweep === controller) activeSweep = null;
      if (session === startedSession) {
        if (canInspect()) void send({ type: 'monitor:wake', session });
        scheduleCapture();
      }
    }
  }

  async function sweepList() {
    if (!session || !Number.isFinite(startupCutoff)) return;
    if (activeRead || navigation || !canInspect()) {
      scheduleSweep(3_000);
      return;
    }
    const controller = new AbortController();
    activeSweep = controller;
    const startedSession = session;
    const cutoff = startupCutoff;
    const startedAt = Date.now();
    const deadline = startedAt + 45_000;
    const current = () => session === startedSession && startupCutoff === cutoff && !controller.signal.aborted && canInspect();
    const alive = () => current() && Date.now() < deadline;
    try {
      const snapshot = scan();
      if (!snapshot.ready) {
        await reportCoverage(false, 0, 'Список чатов ещё не загружен.');
        return;
      }
      const found = new Map();
      const conflicts = new Set();
      const timed = new Set();
      const keys = new Map();
      const unrecognized = new Set();
      const capture = async frame => {
        rememberRows(found, conflicts, frame);
        for (const row of frame.ordered) timed.add(row.position);
        for (const { position, key } of frame.layout?.positions ?? []) {
          if (Number.isSafeInteger(position) && key) keys.set(position, key);
        }
        for (const key of frame.unrecognized) unrecognized.add(key);
        const rows = frame.rows.filter(row => row.precision !== 'day' && row.at > cutoff && !conflicts.has(row.id));
        if (rows.length) await publish({ ...frame, rows });
      };
      let complete = true;
      let last = 0;
      if (snapshot.layout) {
        const root = listRoot;
        const available = () => alive() && root.isConnected;
        const outcome = await walkList(root, controller.signal, available,
          capture, row => row.at <= cutoff);
        if (!current() || !root.isConnected) return;
        await moveList(root, 0, controller.signal);
        if (!current() || dom.getVirtualList?.() !== root) return;
        complete = outcome.complete;
        last = outcome.last;
        const latest = scan();
        if (latest.ready) await capture(latest);
      } else {
        await capture(snapshot);
      }
      if (!current()) return;
      ambiguous.clear();
      for (const key of conflicts) ambiguous.add(key);
      positions.clear();
      const observedAt = Date.now();
      const rows = [...found.values()].filter(row => !ambiguous.has(row.id) && row.precision !== 'day' && row.at > cutoff);
      for (const row of rows) if (Number.isSafeInteger(row.position)) positions.set(row.id, row.position);
      const { skipped, ranges } = recordGaps(last, timed, keys, unrecognized);
      const result = await reportCoverage(complete, rows.length, complete ? '' : 'Не удалось завершить начальный просмотр чатов.',
        { observedAt, rows, skipped, ...(complete ? { headThrough: startedAt, recoveryRanges: ranges } : {}) });
      if (complete && result?.ok && session === startedSession) {
        startupCutoff = null;
        headThrough = Math.max(headThrough ?? -Infinity, startedAt);
        recoveryNeeded = ranges.length > 0;
        scheduleRecovery();
      }
    } finally {
      if (activeSweep === controller) activeSweep = null;
      if (session !== startedSession) return;
      if (canInspect()) void send({ type: 'monitor:wake', session });
      scheduleCapture();
      scheduleSweep(3_000);
    }
  }

  function setSession(value, name, cutoff, coveredThrough) {
    const next = typeof value === 'string' && value ? value : null;
    const nextCurator = next && typeof name === 'string' ? name : null;
    if (session !== next || curatorName !== nextCurator) {
      revision++;
      activeRead?.abort();
      activeSweep?.abort();
      navigation?.abort();
      clearTimeout(captureTimer);
      clearInterval(fallback);
      clearTimeout(minuteCheck);
      clearTimeout(sweepTimer);
      clearTimeout(recoveryTimer);
      captureTimer = null;
      sweepTimer = null;
      recoveryTimer = null;
      recoveryNeeded = !!next && !Number.isFinite(cutoff);
      headRetryAt = 0;
      minuteWatch = null;
      positions.clear();
      ambiguous.clear();
      observer.disconnect();
      connection.stop();
      listRoot = null;
      lastCapture = '';
      session = next;
      startupCutoff = next && Number.isFinite(cutoff) ? cutoff : null;
      headThrough = next && Number.isFinite(coveredThrough) ? coveredThrough : null;
      curatorName = nextCurator;
      dom.setCuratorName?.(curatorName);
      if (session) {
        observer.observe(document.body, {
          subtree: true, childList: true, characterData: true, attributes: true,
          attributeFilter: ['aria-busy', 'aria-selected', 'aria-current', 'data-last-message-id', 'data-chat-id', 'data-conversation-id', 'class',
            'style', 'hidden', 'datetime', 'title', 'aria-label', 'aria-posinset', 'aria-setsize', 'data-assignee-name', 'data-responsible-name'],
        });
        connection.start();
        fallback = setInterval(() => { connection.refresh(); report(true); }, 30_000);
      }
    } else if (cutoff === null && startupCutoff !== null) {
      startupCutoff = null;
      recoveryNeeded = true;
      activeSweep?.abort();
      clearTimeout(sweepTimer);
      sweepTimer = null;
    }
    if (session) {
      if (Number.isFinite(coveredThrough)) headThrough = Math.max(headThrough ?? -Infinity, coveredThrough);
      lastCapture = '';
      scheduleCapture(250);
      scheduleSweep();
      scheduleRecovery();
    }
  }

  function rowsSnapshot() {
    const { ready, rows, observedAt, partial, layout } = scan();
    if (layout && listRoot.scrollTop >= 1) return { ready: false, rows: [], observedAt, partial };
    return { ready, rows: rows.filter(row => !ambiguous.has(row.id)), observedAt, partial };
  }

  function statusSnapshot() {
    connection.refresh();
    return { ...rowsSnapshot(), connection: connection.details().connection || 'unknown',
      protected: Boolean(protectionReason() || activeRead || navigation) };
  }

  function lookup(id) {
    if (ambiguous.has(id)) return null;
    const rows = dom.getRows(dom.getVirtualList?.() || (listRoot?.isConnected ? listRoot : document));
    return rows.find(row => row.key === id);
  }

  async function seekRow(id, position, signal, allowed, expiresAt, minActivityAt = -Infinity, targetAt = minActivityAt) {
    const root = dom.getVirtualList?.();
    if (!root || ambiguous.has(id)) return null;
    const alive = () => !signal.aborted && root.isConnected && allowed() && Date.now() < expiresAt;
    const matchingRow = () => {
      if (!alive() || dom.getVirtualList?.() !== root) return null;
      const row = lookup(id);
      if (!row || (Number.isFinite(minActivityAt) && (!Number.isFinite(row.at) ||
          latestPossibleAt(row) < minActivityAt))) return null;
      if (Number.isSafeInteger(row.position) && row.position > 0) positions.set(id, row.position);
      return row;
    };
    let match = matchingRow();
    if (match) return match;
    for (const hint of new Set([positions.get(id), position])) {
      if (!alive()) return null;
      if (!Number.isSafeInteger(hint) || hint < 1) continue;
      await showPosition(root, hint, signal, alive);
      match = matchingRow();
      if (match) return match;
    }
    await walkList(root, signal, alive, () => {
      match = matchingRow();
      return Boolean(match);
    }, row => latestPossibleAt(row) < targetAt);
    return match;
  }

  const normalizeName = name => String(name ?? '').normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е')
    .trim().split(/\s+/u).sort().join(' ');
  function panelMatches(chat, row, identity, selectedAfterClick = false) {
    if (!chat || chat.course !== row.course || !chat.messages.length) return false;
    if (identity && chat.id !== identity) return false;
    if (/^\d+__\d+__\d+$/u.test(row.rowId ?? '')) {
      if (chat.id !== row.rowId) return false;
    } else if (!identity && (chat.studentName ? normalizeName(chat.studentName) !== normalizeName(row.label) : !selectedAfterClick)) {
      return false;
    }
    const last = chat.messages.at(-1);
    if (row.signal && last.id && row.signal !== last.id) return false;
    if (row.precision === 'day') {
      return Math.floor((last.time + 10_800_000) / 86_400_000) === Math.floor((row.at + 10_800_000) / 86_400_000);
    }
    return Math.floor(last.time / minute) === Math.floor(row.at / minute);
  }

  // Once the selected panel has the right identity, tail and timestamp, allow its rendering
  // to settle. New jobs can abort this wait immediately when the shift ends or the user clicks.
  function waitPanel(row, identity, controller, previous = null, switchedFrom = null, allowed = canInspect) {
    return new Promise(resolve => {
      let settle;
      let deadline;
      let finished = false;
      let fingerprint = '';
      const changes = new MutationObserver(sample);
      const abort = () => finish(null);
      function finish(value) {
        if (finished) return;
        finished = true;
        clearTimeout(settle);
        clearTimeout(deadline);
        changes.disconnect();
        controller.signal.removeEventListener('abort', abort);
        resolve(value);
      }
      function candidate() {
        if (controller.signal.aborted || !allowed()) return null;
        const current = lookup(row.key);
        if (ambiguous.has(row.key) || current?.selected === false) return null;
        const chat = dom.getChat();
        if (!chat || (switchedFrom && chat.id === switchedFrom.id &&
            chat.messages.at(-1)?.id === switchedFrom.messages.at(-1)?.id)) return null;
        if (!panelMatches(chat, row, identity, current?.selected === true && Boolean(switchedFrom?.id !== chat.id))) return null;
        if (previous && !chat.historyComplete && previous.messages.length >= chat.messages.length &&
            previous.messages[0].time <= chat.messages[0].time) return null;
        return chat;
      }
      function sample() {
        if (controller.signal.aborted || !allowed()) return finish(null);
        const chat = candidate();
        if (!chat) {
          clearTimeout(settle);
          fingerprint = '';
        } else {
          const last = chat.messages.at(-1);
          const mark = JSON.stringify([chat.id, chat.messages.length, last.time, last.author, last.id]);
          if (mark === fingerprint) return;
          fingerprint = mark;
          clearTimeout(settle);
          settle = setTimeout(() => {
            const latest = candidate();
            if (latest) finish(latest);
            else fingerprint = '';
          }, 200);
        }
      }
      changes.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['aria-busy', 'aria-selected', 'data-message-id', 'data-last-message-id'] });
      controller.signal.addEventListener('abort', abort, { once: true });
      deadline = setTimeout(() => finish(null), 4_500);
      sample();
    });
  }

  const role = { student: 'student', curator: 'staff', own: 'own', service: 'service', unknown: 'unknown' };
  function metadata(chat) {
    const counts = new Map();
    return chat.messages.map(({ id, author, time, kind, requiresReply }) => {
      const key = JSON.stringify([normalizeName(author), time]);
      const ordinal = (counts.get(key) || 0) + 1;
      counts.set(key, ordinal);
      return { ...(id ? { id } : {}), author, at: time, role: role[kind] || 'unknown', ordinal,
        ...(typeof requiresReply === 'boolean' ? { requiresReply } : {}) };
    });
  }

  // A same-minute append in the still-open panel is new activity even when
  // the list timestamp is unchanged.
  function watchMinute(row, identity, job, before) {
    clearTimeout(minuteCheck);
    minuteWatch = null;
    const end = Math.floor(row.at / minute) * minute + minute;
    if (row.precision !== 'minute' || row.signal || Date.now() >= end) return;
    const keys = messages => messages.filter(m => Math.floor(m.at / minute) === Math.floor(row.at / minute))
      .map(m => JSON.stringify([m.id ?? null, m.author, m.at, m.ordinal]));
    const prefix = keys(before);
    if (!prefix.length) return;
    const watchSession = session;
    const check = () => {
      if (!session || session !== watchSession || !contextActive() || !validPage() || !navigator.onLine ||
          ['connecting', 'offline'].includes(connection.details().connection)) return;
      const current = lookup(row.key);
      if (!current || current.selected === false || current.at !== row.at || current.signal) return;
      const panel = dom.getChat();
      if (!panelMatches(panel, current, identity)) return;
      const after = keys(metadata(panel));
      if (after.length <= prefix.length || !prefix.every((v, i) => v === after[i])) return;
      minuteWatch = null;
      clearTimeout(minuteCheck);
      void send({ type: 'monitor:panel-change', session, id: job.id || row.key, identity, at: row.at,
        previous: job.signal ?? null, signal: 'panel:' + after.at(-1) });
    };
    minuteWatch = { root: document.getElementById('scroll'), check };
    minuteCheck = setTimeout(() => {
      check();
      minuteWatch = null;
    }, end - Date.now() + 150);
  }

  async function read(request) {
    const { id, job = {} } = request;
    const rowKey = job.rowKey || id;
    const fail = (reasonCode, reason, blocked = false) => {
      const tabBlock = blocked ? inspectionBlock() : '';
      return { id, ready: false, reasonCode, reason, blocked, complete: false, messages: [], ...(tabBlock ? { tabBlock } : {}) };
    };
    const expiresAt = Math.min(request.expiresAt ?? Date.now() + 25_000, job.expiresAt ?? Infinity);
    const minActivityAt = job.minActivityAt ?? Date.now() - dom.recentWindow;
    const allowed = () => session === request.session && canInspect() && Date.now() < expiresAt;
    if (!session || request.session !== session || activeRead || navigation || !allowed()) {
      return fail('read_error', 'Вкладка занята или время запроса истекло.', true);
    }
    if (activeSweep) return { ...fail('read_error', 'Обновляется список чатов.', true), tabBlock: 'list_scan' };
    const controller = new AbortController();
    activeRead = controller;
    try {
      const row = lookup(rowKey) || await seekRow(rowKey, job.position, controller.signal, allowed,
        Math.min(expiresAt - 750, Date.now() + 10_000), minActivityAt, Math.max(minActivityAt, job.at ?? minActivityAt));
      if (!row || !row.element.isConnected) {
        return fail('row_unavailable', 'Строка чата недоступна.', controller.signal.aborted || !allowed());
      }
      if (controller.signal.aborted || !allowed() || !Number.isFinite(row.at) ||
          latestPossibleAt(row) < minActivityAt) return fail('row_unavailable', 'Чат вышел из окна проверки или вкладка занята.', true);
      const expected = request.identity || job.identity;
      const previousPanel = dom.getChat();
      const switchChat = !panelMatches(previousPanel, row, expected) || row.selected === false;
      if (switchChat) row.element.click();
      let chat = await waitPanel(row, expected, controller, null, switchChat ? previousPanel : null, allowed);
      if (!chat) return fail('history_unconfirmed', 'Не удалось подтвердить переписку, её автора и время последнего сообщения.',
        controller.signal.aborted || !allowed());
      const sinceAt = request.sinceAt ?? job.sinceAt;
      const coveredPin = value => !row.pinned || !Number.isFinite(sinceAt) || value.historyComplete ||
        value.messages[0].time < sinceAt || value.messages.some(message => message.id &&
          (message.id === job.cursorSignal || 'id:' + message.id === job.cursorKeys?.at(-1)));
      const coveredEpisode = value => value.historyComplete || value.messages.some(message =>
        message.kind === 'curator' || message.kind === 'own' || (message.id && 'id:' + message.id === job.waitKey));
      const coveredStudent = value => value.historyComplete || value.messages.some(message => message.kind === 'student');
      for (let page = 0; !(coveredPin(chat) && coveredEpisode(chat) && coveredStudent(chat)) && page < 8; page++) {
        if (controller.signal.aborted || !allowed() || Date.now() >= expiresAt - 4_500 || !chat.loadMore?.isConnected) break;
        chat.loadMore.click();
        const more = await waitPanel(row, chat.id, controller, chat, null, allowed);
        if (!more) break;
        chat = more;
      }
      if (controller.signal.aborted || !allowed()) return fail('read_error', 'Чтение прервано.', true);
      const latestRow = lookup(rowKey);
      const latest = dom.getChat();
      if (ambiguous.has(rowKey) || latestRow?.selected === false || !panelMatches(latest, row, chat.id) ||
          latest.messages.at(-1).time < minActivityAt) {
        return fail('panel_changed', 'Вкладка или переписка изменилась.');
      }
      const messages = metadata(latest);
      watchMinute(latestRow || row, latest.id, job, messages);
      return { id, ready: true, identity: latest.id, startReached: latest.historyComplete,
        ...(typeof latest.assignedToSelf === 'boolean' ? { assignedToSelf: latest.assignedToSelf } : {}),
        complete: coveredEpisode(latest), sinceCovered: coveredPin(latest), messages };
    } finally {
      if (activeRead === controller) {
        const root = dom.getVirtualList?.();
        if (root && !controller.signal.aborted && session === request.session && canInspect()) {
          await moveList(root, 0, controller.signal).catch(() => {});
        }
        activeRead = null;
      }
      scheduleCapture();
      scheduleSweep();
    }
  }

  async function open(request) {
    const inSession = () => contextActive() && validPage() && (request.session === undefined || request.session === session);
    const allowed = () => inSession() && !hasDraft();
    if (!inSession()) {
      return { ok: false, reason: 'Вкладка или смена изменилась.' };
    }
    if (hasDraft()) return { ok: false, reason: 'Во вкладке Школково есть черновик или вложение.' };
    const unavailable = { ok: false, reason: 'Чат сейчас недоступен в списке.' };
    activeRead?.abort();
    activeSweep?.abort();
    navigation?.abort();
    const controller = new AbortController();
    navigation = controller;
    try {
      const row = lookup(request.id) || (!request.requireSelectedIdentity && await seekRow(request.id, request.position,
        controller.signal, allowed, Date.now() + 10_000));
      if (controller.signal.aborted || !allowed() || !row?.element?.isConnected ||
          (request.requireSelectedIdentity && (row.selected !== true || !panelMatches(dom.getChat(), row, request.identity))) ||
          (request.identity && /^\d+__\d+__\d+$/u.test(row.rowId ?? '') && request.identity !== row.rowId)) {
        return unavailable;
      }
      lastInput = Date.now();
      const previous = dom.getChat();
      if (row.selected !== true || !panelMatches(previous, row, request.identity)) {
        row.element.click();
        if (dom.getVirtualList?.() && request.identity &&
            !await waitPanel(row, request.identity, controller, null, previous, allowed)) return unavailable;
      }
      return { ok: true };
    } finally {
      if (navigation === controller) navigation = null;
      scheduleCapture();
      scheduleSweep();
    }
  }

  function canReload() {
    if (!session || !contextActive() || Number.isFinite(startupCutoff) || activeRead || activeSweep || navigation ||
        protectionReason() || !navigator.onLine) return false;
    connection.refresh();
    return !['connecting', 'offline'].includes(connection.details().connection);
  }

  for (const name of ['pointerdown', 'keydown', 'wheel', 'input']) {
    document.addEventListener(name, event => {
      if (!event.isTrusted) return;
      lastInput = Date.now();
      activeRead?.abort();
      activeSweep?.abort();
      navigation?.abort();
    }, { capture: true, passive: true, signal: pageListeners.signal });
  }
  function visibilityChanged() {
    if (!session || !contextActive()) return;
    connection.refresh();
    if (userPresent()) {
      activeRead?.abort();
      activeSweep?.abort();
    }
    if (document.hidden || !document.hasFocus()) {
      report();
      scheduleSweep();
      void send({ type: 'monitor:wake', session });
    }
  }
  document.addEventListener('visibilitychange', visibilityChanged, { signal: pageListeners.signal });
  window.addEventListener('blur', visibilityChanged, { signal: pageListeners.signal });

  runtime.onMessage.addListener((request, _sender, respond) => {
    if (!contextActive()) return false;
    const reply = value => { if (contextActive()) respond(value); };
    switch (request?.type) {
      case 'monitor:ping': reply({ ok: validPage() }); break;
      case 'monitor:set':
        if (Number.isSafeInteger(request.generation)) {
          if (request.generation < generation) { reply({ ok: false }); break; }
          generation = request.generation;
        }
        revision++; // An explicit stop wins over an older, in-flight hello response.
        clearTimeout(helloTimer);
        setSession(validPage() && request.session, request.curatorName, request.startupCutoff, request.headThrough);
        reply({ ok: true });
        break;
      case 'monitor:snapshot':
        if (!session || request.session !== session) reply({ ready: false, rows: [], protected: true });
        else reply(statusSnapshot());
        break;
      case 'monitor:handoff-rows':
        reply(session && request.session === session ? rowsSnapshot() : { ready: false });
        break;
      case 'monitor:read':
        void read(request).then(reply, () => reply({
          id: request.id, ready: false, complete: false, messages: [], reasonCode: 'read_error', reason: 'Ошибка чтения интерфейса.'
        }));
        return true;
      case 'monitor:open':
        void open(request).then(reply, () => reply({ ok: false, reason: 'Не удалось открыть чат.' }));
        return true;
      case 'monitor:reload': {
        const ok = request.session === session && Date.now() < (request.expiresAt ?? Infinity) && canReload();
        const snapshot = ok ? rowsSnapshot() : null;
        reply({ ok, ready: !!snapshot?.ready, ...(snapshot?.ready ? snapshot : {}) });
        if (ok && canReload()) {
          activeSweep?.abort();
          location.reload();
        }
        break;
      }
    }
    return false;
  });
  async function hello(expectedRevision) {
    if (revision !== expectedRevision || !validPage() || !contextActive()) return;
    const result = await send({ type: 'monitor:hello' });
    if (revision !== expectedRevision || !validPage() || !contextActive()) return;
    if (result && Object.hasOwn(result, 'session')) {
      if (Number.isSafeInteger(result.generation)) generation = result.generation;
      setSession(result.session, result.curatorName, result.startupCutoff, result.headThrough);
    } else {
      helloTimer = setTimeout(() => void hello(expectedRevision), 4_000);
    }
  }
  void hello(revision);
})();
