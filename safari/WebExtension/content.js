(() => {
  'use strict';
  if (location.origin !== 'https://1.shkolkovo.online' || !/^\/chat\/?$/u.test(location.pathname)) return;

  const getRuntime = () => (globalThis.browser ?? globalThis.chrome)?.runtime;
  const runtime = getRuntime();
  if (typeof runtime?.sendMessage !== 'function') return;
  const runtimeId = runtime.id;
  const documentToken = crypto.randomUUID();
  const dom = globalThis.ShkolkovoDom;
  const minute = 60_000;
  const retryGapDelay = 7_000;
  const headRetryDelay = 5_000;
  const latestPossibleAt = ({ at, precision }) => precision === 'day' ? new Date(at).setHours(24, 0, 0, 0) - 1
    : at + (precision === 'minute' ? minute - 1 : 0);
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
  let lastStartupBlock = '';
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
    const current = getRuntime();
    if (typeof current?.sendMessage === 'function' && (!runtimeId || current.id === runtimeId)) return true;
    detach();
    return false;
  }

  async function send(message) {
    if (!contextActive()) return null;
    try {
      const reply = await runtime.sendMessage({ ...message, documentToken });
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
    const ambiguousFallbacks = new Map();
    const rows = dom.getRows(virtual || (listRoot?.isConnected ? listRoot : document), observedAt,
      virtual ? null : ambiguousFallbacks);
    listRoot = virtual || dom.getListRoot(rows);
    connection.setListRoot(listRoot);
    const parsed = rows.filter(row => Number.isFinite(row.at));
    const busy = listRoot?.closest?.('[aria-busy="true"]') || Array.from(listRoot?.querySelectorAll(
      '[aria-busy="true"], [role="progressbar"], .ant-spin-spinning') || []).some(el => el.getClientRects().length);
    // A missing list is normal during reload, filtering or login. Do not mark it as the shift baseline.
    const layout = virtual ? dom.getListLayout(virtual, rows, true) : null;
    const ready = Boolean(validPage() && !busy &&
      (rows.length || layout?.positions.length || ambiguousFallbacks.size || (!virtual && dom.hasLoadedEmptyList())));
    const selected = parsed.find(row => row.selected === true);
    const panel = selected && !/^\d+__\d+__\d+$/u.test(selected.rowId || '') && dom.getChat();
    const selectedId = selected && panelMatches(panel, selected) ? panel.id : null;
    const ordered = layout ? parsed.filter(row => Number.isSafeInteger(row.position))
      .map(row => ({ position: row.position, at: row.at, precision: row.precision }))
      .sort((a, b) => a.position - b.position) : [];
    const fallbackConflicts = new Set(ambiguousFallbacks.keys());
    const snapshot = { ready, observedAt, partial: true, layout, ordered, ambiguousFallbacks, fallbackConflicts,
      unrecognized: rows.filter(row => !Number.isFinite(row.at)).map(row => row.key),
      rows: ready ? parsed.map(({ key, label, fallbackKey, at, precision, timeParse, pinned, signal, assignedToSelf, unread, position }) => ({
      id: key, title: label, at, precision, pinned, ...(signal ? { signal } : {}),
      ...(timeParse ? { timeParse } : {}),
      ...(fallbackKey ? { fallbackKey } : {}), ...(selectedId && selected.key === key ? { identity: selectedId } : {}),
      ...(Number.isSafeInteger(position) ? { position } : {}), ...(typeof unread === 'boolean' ? { unread } : {}),
      ...(typeof assignedToSelf === 'boolean' ? { assignedToSelf } : {}),
    })) : [] };
    if (ready) {
      const keys = new Set();
      const identified = new Set();
      for (const { position, key } of layout?.positions ?? []) {
        if (!key) continue;
        if (!key.startsWith('id:') && keys.has(key)) fallbackConflicts.add(key);
        keys.add(key);
        identified.add(position);
      }
      const fullList = !layout || (rowsHavePositions(snapshot) && layout.positions.length === layout.total &&
        coversPrefix(identified, layout.total));
      refreshAmbiguity(snapshot.rows, snapshot.fallbackConflicts, fullList);
    }
    return snapshot;
  }

  function refreshAmbiguity(rows, conflicts, confirmed) {
    for (const key of conflicts) ambiguous.add(key);
    if (!confirmed) return;
    for (const row of rows) {
      if (!conflicts.has(row.id)) ambiguous.delete(row.id);
    }
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
        ? (limit === null || coverage?.complete) && rowsHavePositions(snapshot) &&
          rememberRowOrder(snapshot, new Map(), new Map()) && coversPrefix(timed, coverage?.last)
        : snapshot.unrecognized.length === 0 && snapshot.ambiguousFallbacks.size === 0;
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
    const byPosition = new Map();
    const byKey = new Map();
    const duplicates = new Map();
    let stable = true;
    let positioned = true;
    let complete = false;
    let last = 0;
    try {
      if (limit !== null) {
        const deadline = startedAt + 15_000;
        const outcome = await walkList(root, controller.signal, () => current() && Date.now() < deadline,
          frame => {
            rememberRows(found, conflicts, frame);
            for (const row of frame.ordered) timed.add(row.position);
            positioned &&= rowsHavePositions(frame);
            stable &&= rememberRowOrder(frame, byPosition, byKey, duplicates);
            return !stable;
          }, row => latestPossibleAt(row) < limit);
        complete = outcome.complete && positioned;
        last = outcome.last;
      }
      if (!current()) return;
      await moveList(root, 0, controller.signal);
      if (!current() || dom.getVirtualList?.() !== root || root.scrollTop >= 1) return;
      const snapshot = scan();
      if (!snapshot.ready) return;
      if (limit === null) {
        const coverage = listCoverage(snapshot, 0, () => false);
        for (const row of snapshot.ordered) timed.add(row.position);
        complete = rowsHavePositions(snapshot);
        last = coverage?.last;
      }
      rememberRows(found, conflicts, snapshot);
      complete = complete && stable && rememberRowOrder(snapshot, byPosition, byKey, duplicates);
      if ([...duplicates.values()].some(places => [...places].some(position => position <= last))) complete = false;
      complete &&= coversPrefix(timed, last);
      for (const key of duplicates.keys()) conflicts.add(key);
      const rows = [...found.values()].filter(row => !conflicts.has(row.id));
      refreshAmbiguity(rows, conflicts, complete && last === snapshot.layout?.total);
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

  function rememberRowOrder(frame, byPosition, byKey, duplicates) {
    const rowIds = new Map(frame.rows.map(row => [row.position, row.id]));
    const rendered = (frame.layout?.positions ?? []).map(({ position, key }) =>
      ({ position, key: key || rowIds.get(position) })).filter(({ position, key }) =>
      Number.isSafeInteger(position) && position > 0 && key);
    if (duplicates) {
      const observed = new Map();
      for (const { position, key } of rendered) {
        if (key.startsWith('id:')) continue;
        const previous = observed.get(key) ?? byKey.get(key);
        if (duplicates.has(key) || (previous !== undefined && previous !== position)) {
          const places = duplicates.get(key) ?? new Set([previous]);
          if (byPosition.get(previous) === key) byPosition.delete(previous);
          byKey.delete(key);
          places.add(position);
          duplicates.set(key, places);
        } else observed.set(key, position);
      }
    }
    for (const { position, key } of rendered) {
      if (duplicates?.has(key)) continue;
      if ((byPosition.has(position) && byPosition.get(position) !== key) ||
          (byKey.has(key) && byKey.get(key) !== position)) return false;
      byPosition.set(position, key);
      byKey.set(key, position);
    }
    return true;
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
      if (row && pastLimit(row)) return { last, complete: true, timeBoundary: true };
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

  function startupBlockReason() {
    return inspectionBlock() || (activeRead || navigation ? 'read_busy' : '');
  }

  function reportStartupBlock(reason) {
    if (lastStartupBlock === reason) return;
    const sendingSession = session;
    lastStartupBlock = reason;
    void send({ type: 'monitor:startup-block', session, reason }).then(reply => {
      if (session === sendingSession && lastStartupBlock === reason && !reply?.ok) lastStartupBlock = null;
    });
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
      if (coverage.complete) return coverage;
      const offset = root.scrollTop;
      if (root.clientHeight <= 0) break;
      await moveList(root, offset + root.clientHeight * 0.75, signal);
      if (root.scrollTop <= offset) break;
    }
    return { complete: false, last };
  }

  function rememberRows(found, conflicts, snapshot) {
    for (const key of snapshot.fallbackConflicts) conflicts.add(key);
    for (const row of snapshot.rows) {
      const previous = found.get(row.id);
      if (previous && previous.position !== row.position && previous.at === row.at && !row.id.startsWith('id:')) conflicts.add(row.id);
      if (!previous || row.at >= previous.at) found.set(row.id, row);
    }
  }

  function recordGaps(last, timed, keys, unrecognized, ambiguousPositions) {
    if (!last) return { skipped: unrecognized.size, ranges: [...unrecognized].map(key => ({ key })) };
    const positions = [...new Set([...timed, ...keys.keys(), ...ambiguousPositions.keys()])]
      .filter(position => position > 0 && position <= last).sort((a, b) => a - b);
    const ranges = [];
    let skipped = 0;
    let prior = 0;
    for (const position of [...positions, last + 1]) {
      if (position > prior + 1) {
        const before = keys.get(prior);
        const after = keys.get(position);
        ranges.push({ first: prior + 1, last: position - 1,
          ...(before ? { before: { position: prior, key: before } } : {}),
          ...(after ? { after: { position, key: after } } : {}) });
        skipped += position - prior - 1;
      }
      if (position <= last && !timed.has(position)) {
        ranges.push({ first: position, last: position, key: ambiguousPositions.get(position) ?? keys.get(position) });
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

  async function recoverTarget(root, target, signal, available, capture) {
    const deadline = Date.now() + 1_200;
    const allowed = () => available() && Date.now() < deadline;
    const byPosition = new Map();
    const byKey = new Map();
    let stable = true;
    const inspect = () => {
      if (!allowed()) return null;
      const frame = capture();
      if (frame) stable &&= rememberRowOrder(frame, byPosition, byKey);
      return frame;
    };
    const atPosition = async position => {
      if (root && Number.isSafeInteger(position) && position > 0) await showPosition(root, position, signal, allowed);
      return inspect();
    };
    const nearby = async (position, done = () => false) => {
      const frame = await atPosition(position);
      if (!frame || !root || done(frame)) return;
      const center = root.scrollTop;
      for (const direction of [-1, 1]) {
        if (!allowed()) break;
        await moveList(root, center + direction * root.clientHeight * 0.75, signal);
        if (done(inspect())) break;
      }
    };

    const initial = await atPosition(target.position);
    if (target.key) {
      const initialMatch = initial?.rows.find(row => row.id === target.key);
      if (initialMatch || !root) return initialMatch;
      let match;
      await nearby(target.position, frame => {
        match = frame?.rows.find(row => row.id === target.key);
        return Boolean(match);
      });
      return match;
    }
    if (!root || !initial || !Number.isSafeInteger(target.position)) return null;

    const anchors = [target.before, target.after].filter(Boolean);
    for (const anchor of anchors) {
      if (!byKey.has(anchor.key)) await nearby(anchor.position, () => byKey.has(anchor.key));
    }
    const shifts = anchors.map(anchor => byKey.get(anchor.key) - anchor.position);
    const shift = shifts[0];
    const verified = stable && Number.isSafeInteger(shift) && shifts.every(value => value === shift) &&
      (anchors.length === 2 || shift === 0);
    if (!verified) {
      // Preserve observations from the affected area, but leave the original position unresolved.
      await nearby(target.position);
      return null;
    }
    const position = target.position + shift;
    const frame = position === target.position && initial.rows.some(row => row.position === position)
      ? initial : await atPosition(position);
    return stable ? frame?.rows.find(row => row.position === position) : null;
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
    const rows = new Map();
    const tentative = new Set();
    const capture = () => {
      if (!current()) return null;
      const snapshot = scan();
      if (!snapshot.ready) return null;
      for (const row of snapshot.rows) {
        if (row.precision === 'day' || latestPossibleAt(row) <= batch.cutoff) continue;
        if (ambiguous.has(row.id)) tentative.add(row.id);
        else rows.set(row.id, row);
      }
      return snapshot;
    };
    try {
      if (batch.resurvey) {
        const survey = await surveyInitial(batch.cutoff, controller, current, (frame, observedRows) =>
          reportCoverage(false, observedRows.length, '', {
            recovery: true, recoveryId: batch.id, resurvey: true, observedAt: frame.observedAt, rows: observedRows
          }));
        if (!survey || !current() || !Array.isArray(survey.rows)) return;
        await reportCoverage(survey.complete, survey.rows.length, '', {
          recovery: true, recoveryId: batch.id, resurvey: true, observedAt: survey.observedAt,
          rows: survey.rows, recoveryRanges: survey.ranges, skipped: survey.skipped
        });
        return;
      }
      // Persisted fallback targets need fresh evidence after a document reload too.
      for (const { key } of batch.targets) {
        if (key && !key.startsWith('id:')) {
          ambiguous.add(key);
          tentative.add(key);
        }
      }
      const targets = [];
      for (const target of batch.targets) {
        if (!current()) return;
        const row = await recoverTarget(root, target, controller.signal, current, capture);
        targets.push({ target, row });
      }
      if (root && [...tentative].some(key => ambiguous.has(key)) && current()) {
        // One viewport can hide another row with the same name. Recheck the
        // original time range before publishing an isolated fallback row.
        const survey = await surveyInitial(batch.cutoff, controller, current);
        if (!survey || !current()) return;
        for (const row of survey.rows) if (tentative.has(row.id)) rows.set(row.id, row);
      }
      if (root) await moveList(root, 0, controller.signal);
      if (!current()) return;
      scan();
      const results = targets.map(({ target: { position, key }, row }) => {
        const rowId = row?.id ?? key;
        const resolved = rows.has(rowId) && !ambiguous.has(rowId);
        return { ...(Number.isSafeInteger(position) ? { position } : {}), ...(key ? { key } : {}),
          resolved, ...(resolved ? { rowId } : {}) };
      });
      await reportCoverage(true, null, '', {
        recovery: true, recoveryId: batch.id, results, observedAt: Date.now(),
        rows: [...rows.values()].filter(row => !ambiguous.has(row.id))
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

  async function surveyInitial(cutoff, controller, current, publishRows = () => {}) {
    const startedAt = Date.now();
    const deadline = startedAt + 45_000;
    const alive = () => current() && Date.now() < deadline;
    const snapshot = scan();
    if (!snapshot.ready) {
      return { complete: false, rows: [], skipped: 0, ranges: [], ambiguousKeys: [], observedAt: startedAt, startedAt,
        reason: 'Список чатов ещё не загружен.' };
    }
    const found = new Map();
    const conflicts = new Set();
    const timed = new Set();
    const keys = new Map();
    const rowPositions = new Map();
    const duplicates = new Map();
    const unrecognized = new Set();
    let stable = true;
    let positioned = true;
    let timeBoundary;
    const inScope = row => row.precision !== 'day' && latestPossibleAt(row) > cutoff;
    const capture = async frame => {
      rememberRows(found, conflicts, frame);
      for (const row of frame.ordered) timed.add(row.position);
      stable &&= rememberRowOrder(frame, keys, rowPositions, duplicates);
      if (frame.layout) positioned &&= rowsHavePositions(frame) && frame.layout.total === snapshot.layout.total;
      for (const key of frame.unrecognized) unrecognized.add(key);
      timeBoundary ??= frame.rows.find(row => latestPossibleAt(row) <= cutoff);
      const rows = frame.rows.filter(row => inScope(row) && !ambiguous.has(row.id) &&
        !conflicts.has(row.id) && !duplicates.has(row.id));
      if (rows.length) await publishRows(frame, rows);
      return !stable;
    };
    let complete = true;
    let last = 0;
    if (snapshot.layout) {
      const root = listRoot;
      const available = () => alive() && root.isConnected;
      const outcome = await walkList(root, controller.signal, available,
        capture, row => latestPossibleAt(row) <= cutoff);
      if (!current() || !root.isConnected) return null;
      await moveList(root, 0, controller.signal);
      if (!current() || dom.getVirtualList?.() !== root) return null;
      complete = outcome.complete;
      last = outcome.last;
      const latest = scan();
      if (latest.ready && latest.layout?.total === snapshot.layout.total) await capture(latest);
      else complete = false;
    } else {
      await capture(snapshot);
    }
    if (!current()) return null;
    complete &&= stable;
    let ambiguousCount = 0;
    for (const [key, count] of snapshot.ambiguousFallbacks) {
      conflicts.add(key);
      unrecognized.add(key);
      ambiguousCount += count - 1;
    }
    const ambiguousPositions = new Map();
    for (const [key, places] of duplicates) {
      conflicts.add(key);
      unrecognized.delete(key);
      for (const position of places) {
        timed.delete(position);
        ambiguousPositions.set(position, key);
      }
    }
    const candidates = [...found.values()].filter(row => !conflicts.has(row.id) && inScope(row));
    const identified = new Set([...keys.keys(), ...ambiguousPositions.keys()]);
    refreshAmbiguity(candidates.filter(row => !snapshot.layout || row.position <= last), conflicts,
      complete && (!snapshot.layout || (positioned && coversPrefix(identified, last))));
    const rows = candidates.filter(row => !ambiguous.has(row.id));
    for (const row of candidates) {
      if (ambiguous.has(row.id) && Number.isSafeInteger(row.position)) {
        timed.delete(row.position);
        ambiguousPositions.set(row.position, row.id);
      }
    }
    const { skipped, ranges } = stable ? recordGaps(last, timed, keys, unrecognized, ambiguousPositions)
      : { skipped: null, ranges: [] };
    return { complete, rows, skipped: skipped === null ? null : skipped + ambiguousCount,
      ranges, ambiguousKeys: [...conflicts], observedAt: Date.now(), startedAt,
      ...(complete && timeBoundary?.timeParse && !conflicts.has(timeBoundary.id) ? {
        timeBoundary: { id: timeBoundary.id, identity: timeBoundary.identity, at: timeBoundary.at, timeParse: timeBoundary.timeParse }
      } : {}),
      reason: complete ? '' : 'Не удалось завершить начальный просмотр чатов.' };
  }

  async function sweepList() {
    if (!session || !Number.isFinite(startupCutoff)) return;
    const block = startupBlockReason();
    reportStartupBlock(block);
    if (block) {
      scheduleSweep(3_000);
      return;
    }
    const controller = new AbortController();
    activeSweep = controller;
    const startedSession = session;
    const cutoff = startupCutoff;
    const current = () => session === startedSession && startupCutoff === cutoff && !controller.signal.aborted && canInspect();
    try {
      const result = await surveyInitial(cutoff, controller, current, (frame, rows) => publish({ ...frame, rows }));
      if (!result || !current()) return;
      const { complete, rows, skipped, ranges, observedAt, startedAt, reason, timeBoundary } = result;
      positions.clear();
      for (const row of rows) if (Number.isSafeInteger(row.position)) positions.set(row.id, row.position);
      const reply = await reportCoverage(complete, rows.length, reason,
        { observedAt, rows, skipped, ...(complete ? { headThrough: startedAt, recoveryRanges: ranges, timeBoundary } : {}) });
      if (complete && reply?.ok && session === startedSession) {
        startupCutoff = null;
        headThrough = Math.max(headThrough ?? -Infinity, startedAt);
        recoveryNeeded = ranges.length > 0;
        scheduleRecovery();
      }
    } finally {
      if (activeSweep === controller) activeSweep = null;
      if (session !== startedSession) return;
      if (Number.isFinite(startupCutoff)) reportStartupBlock(startupBlockReason());
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
      lastStartupBlock = '';
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
    const conflicts = new Map();
    const rows = dom.getRows(dom.getVirtualList?.() || (listRoot?.isConnected ? listRoot : document), Date.now(), conflicts);
    for (const key of conflicts.keys()) ambiguous.add(key);
    return rows.find(row => row.key === id);
  }

  async function inspectMissingPosition(root, position, signal, allowed, inspect) {
    await showPosition(root, position, signal, allowed);
    if (!allowed() || inspect()) return;
    // A sparse render can advertise indices on both sides of an absent row.
    // Probe overlapping viewports around that gap before accepting the boundary.
    const center = root.scrollTop;
    const offsets = [0.5, -0.5, 0.75, -0.75];
    for (const offset of offsets) {
      if (!allowed()) return;
      await moveList(root, center + offset * root.clientHeight, signal);
      if (allowed() && inspect()) return;
    }
  }

  async function seekRow(id, position, signal, allowed, expiresAt, minActivityAt = -Infinity, targetAt = minActivityAt, search = null) {
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
    const inspected = new Set();
    const byPosition = new Map();
    const byKey = new Map();
    const duplicates = new Map();
    let prefix = 0;
    let total;
    let stable = true;
    const visit = frame => {
      match = matchingRow();
      if (match) return true;
      total ??= frame.layout?.total;
      stable &&= total === frame.layout?.total && rememberRowOrder(frame, byPosition, byKey, duplicates);
      if (!stable) return true;
      for (const { position, key } of frame.layout?.positions ?? []) {
        if (Number.isSafeInteger(position) && position > 0 && key && key !== id) inspected.add(position);
      }
      while (inspected.has(prefix + 1)) prefix++;
      return false;
    };
    const outcome = await walkList(root, signal, alive, visit, row => latestPossibleAt(row) < targetAt);
    while (!match && stable && outcome.complete && prefix < outcome.last && alive()) {
      const missing = prefix + 1;
      await inspectMissingPosition(root, missing, signal, alive, () => {
        const frame = scan();
        return (frame.ready && visit(frame)) || prefix >= missing;
      });
      if (prefix < missing) break;
    }
    if (!match && search) {
      if (!stable || prefix < outcome.last) search.reasonCode = 'row_range_unavailable';
      else if (outcome.timeBoundary) search.reasonCode = 'row_time_boundary';
    }
    return match;
  }

  const normalizeName = name => String(name ?? '').normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е')
    .trim().split(/\s+/u).sort().join(' ');
  function panelMatches(chat, row, identity, selectedAfterClick = false, recordTime) {
    if (!chat || chat.course !== row.course || !chat.messages.length) return false;
    if (identity && chat.id !== identity) return false;
    if (/^\d+__\d+__\d+$/u.test(row.rowId ?? '')) {
      if (chat.id !== row.rowId) return false;
    } else if (!identity && (chat.studentName ? normalizeName(chat.studentName) !== normalizeName(row.label) : !selectedAfterClick)) {
      return false;
    }
    const last = chat.messages.at(-1);
    recordTime?.(last.timeParse);
    if (row.signal && last.id && row.signal !== last.id) return false;
    if (row.precision === 'day') {
      return last.time >= row.at && last.time <= latestPossibleAt(row);
    }
    return Math.floor(last.time / minute) === Math.floor(row.at / minute);
  }

  // Once the selected panel has the right identity, tail and timestamp, allow its rendering
  // to settle. New jobs can abort this wait immediately when the shift ends or the user clicks.
  function waitPanel(row, identity, controller, previous = null, switchedFrom = null, allowed = canInspect, recordTime) {
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
        const chat = dom.getChat(recordTime);
        if (!chat || (switchedFrom && chat.id === switchedFrom.id &&
            chat.messages.at(-1)?.id === switchedFrom.messages.at(-1)?.id)) return null;
        if (!panelMatches(chat, row, identity, current?.selected === true && Boolean(switchedFrom?.id !== chat.id), recordTime)) return null;
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
          const mark = JSON.stringify([chat.id, chat.messages.length, last.time, last.precision, last.author, last.id]);
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
        attributeFilter: ['aria-busy', 'aria-selected', 'data-message-id', 'data-last-message-id', 'datetime', 'title'] });
      controller.signal.addEventListener('abort', abort, { once: true });
      deadline = setTimeout(() => finish(null), 4_500);
      sample();
    });
  }

  const role = { student: 'student', curator: 'staff', own: 'own', service: 'service', unknown: 'unknown' };
  function metadata(chat) {
    const counts = new Map();
    return chat.messages.map(({ id, author, time, precision, kind, requiresReply }) => {
      const key = JSON.stringify([normalizeName(author), time]);
      const ordinal = (counts.get(key) || 0) + 1;
      counts.set(key, ordinal);
      return { ...(id ? { id } : {}), author, at: time, precision, role: role[kind] || 'unknown', ordinal,
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
    const timeDiagnostics = {};
    let expectedIdentity;
    const recordTime = (stamp, identity) => {
      if (stamp && (identity === undefined || identity === expectedIdentity)) timeDiagnostics.history = stamp;
    };
    const fail = (reasonCode, reason, blocked = false) => {
      const tabBlock = blocked ? inspectionBlock() : '';
      return { id, ready: false, reasonCode, reason, blocked, complete: false, messages: [],
        timeDiagnostics, ...(tabBlock ? { tabBlock } : {}) };
    };
    const expiresAt = Math.min(request.expiresAt ?? Date.now() + 25_000, job.expiresAt ?? Infinity);
    const minActivityAt = job.minActivityAt ?? Date.now() - dom.recentWindow;
    const allowed = () => session === request.session && canInspect() && Date.now() < expiresAt;
    if (!session || request.session !== session || Date.now() >= expiresAt) {
      return fail('read_error', 'Сеанс или допустимое время запроса изменились.', true);
    }
    if (activeRead || navigation) return { ...fail('read_error', 'Вкладка занята чтением.', true), tabBlock: 'read_busy' };
    if (!allowed()) return fail('read_error', 'Вкладка недоступна для чтения.', true);
    if (activeSweep) return { ...fail('read_error', 'Обновляется список чатов.', true), tabBlock: 'list_scan' };
    const controller = new AbortController();
    activeRead = controller;
    try {
      const search = {};
      const row = lookup(rowKey) || await seekRow(rowKey, job.position, controller.signal, allowed,
        Math.min(expiresAt - 750, Date.now() + 10_000), minActivityAt, Math.max(minActivityAt, job.at ?? minActivityAt), search);
      if (row?.timeParse) timeDiagnostics.list = row.timeParse;
      if (!row || !row.element.isConnected) {
        const reasonCode = search.reasonCode ?? 'row_unavailable';
        const reason = reasonCode === 'row_time_boundary' ? 'Достигнута граница времени поиска.' :
          reasonCode === 'row_range_unavailable' ? 'Не удалось проверить непрерывность участка списка.' : 'Строка чата недоступна.';
        return fail(reasonCode, reason, controller.signal.aborted || !allowed());
      }
      if (controller.signal.aborted || !allowed() || !Number.isFinite(row.at) ||
          latestPossibleAt(row) < minActivityAt) return fail('row_unavailable', 'Чат вышел из окна проверки или вкладка занята.', true);
      const expected = request.identity || job.identity;
      expectedIdentity = expected || row.rowId;
      const previousPanel = dom.getChat(recordTime);
      const switchChat = !panelMatches(previousPanel, row, expected, false, recordTime) || row.selected === false;
      if (switchChat) row.element.click();
      let chat = await waitPanel(row, expected, controller, null, switchChat ? previousPanel : null, allowed, recordTime);
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
        const more = await waitPanel(row, chat.id, controller, chat, null, allowed, recordTime);
        if (!more) break;
        chat = more;
      }
      if (controller.signal.aborted || !allowed()) return fail('read_error', 'Чтение прервано.', true);
      const latestRow = lookup(rowKey);
      const latest = dom.getChat(recordTime);
      if (ambiguous.has(rowKey) || latestRow?.selected === false || !panelMatches(latest, row, chat.id, false, recordTime)) {
        return fail('panel_changed', 'Вкладка или переписка изменилась.');
      }
      const messages = metadata(latest);
      if (messages.at(-1).at >= minActivityAt) watchMinute(latestRow || row, latest.id, job, messages);
      return { id, ready: true, identity: latest.id, startReached: latest.historyComplete,
        ...(typeof latest.assignedToSelf === 'boolean' ? { assignedToSelf: latest.assignedToSelf } : {}),
        complete: coveredEpisode(latest), sinceCovered: coveredPin(latest), messages, timeDiagnostics };
    } finally {
      if (activeRead === controller) {
        const root = dom.getVirtualList?.();
        if (root && !controller.signal.aborted && session === request.session && canInspect()) {
          await moveList(root, 0, controller.signal).catch(() => {});
        }
        activeRead = null;
        wakeReadQueue();
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
      if (navigation === controller) {
        navigation = null;
        wakeReadQueue();
      }
      scheduleCapture();
      scheduleSweep();
    }
  }

  function wakeReadQueue() {
    if (session && !activeRead && !navigation) void send({ type: 'monitor:wake', session, readReady: true });
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
    if (!contextActive() || (request?.documentToken !== undefined && request.documentToken !== documentToken)) return false;
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
