(() => {
  'use strict';

  const offlineDelay = 2_000;
  const connectingDelay = 30_000;
  const failedAlertRetry = 30_000;

  function create({ dom, send, onChange = () => {} }) {
    let active = false;
    let episode = 0;
    let status = null;
    let visibleStatus = null;
    let onlineSeen = false;
    let failed = false;
    let sent = false;
    let sending = false;
    let due = Infinity;
    let timer = null;
    let observedRoot = null;
    let listRoot = null;
    let refreshQueued = false;

    const observer = new MutationObserver(records => {
      if (!active || refreshQueued) return;
      if (listRoot?.isConnected && records.length && records.every(record => listRoot.contains(record.target))) return;
      refreshQueued = true;
      queueMicrotask(() => {
        refreshQueued = false;
        refresh();
      });
    });

    function clearTimer() {
      clearTimeout(timer);
      timer = null;
    }

    function schedule(now) {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, Math.max(0, due - now));
    }

    function transition(next, now) {
      clearTimer();
      episode += 1;
      status = next;
      failed = false;
      sent = false;
      sending = false;
      due = now + alertDelay(next);
    }

    function alertDelay(next) {
      if (next === 'offline' && onlineSeen) return offlineDelay;
      return next === 'connecting' ? connectingDelay : Infinity;
    }

    function refresh() {
      if (!active) return;
      const badge = dom.getConnectionBadge(listRoot?.isConnected ? listRoot : undefined);
      const root = badge?.root ?? document.body;
      if (root !== observedRoot) {
        observer.disconnect();
        observedRoot = root;
        if (root) observer.observe(root, {
          subtree: true, childList: true, characterData: true, attributes: true,
          attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
        });
      }

      const next = navigator.onLine === false ? 'offline' : badge?.status ?? null;
      const now = Date.now();
      const previousVisible = visibleStatus;
      visibleStatus = next;
      if (previousVisible !== next) onChange(next);
      if (!next) {
        clearTimer();
        return;
      }
      if (next === 'online') onlineSeen = true;
      if (next !== status) transition(next, now);
      else if (!previousVisible && !sent && !sending && !failed) due = now + alertDelay(next);
      if (sent || sending || !Number.isFinite(due)) return;
      if (now < due) schedule(now);
      else {
        clearTimer();
        void deliver(status, episode);
      }
    }

    async function deliver(currentStatus, currentEpisode) {
      sending = true;
      let ok = false;
      try {
        ok = (await send(currentStatus))?.ok === true;
      } catch {
        // Keep observing and retry if the background script did not accept the alert.
      }
      if (!active || currentEpisode !== episode) return;
      sending = false;
      sent = ok;
      failed = !ok;
      if (!ok) {
        const now = Date.now();
        due = now + failedAlertRetry;
        if (visibleStatus) schedule(now);
      }
    }

    function start() {
      if (active) return;
      active = true;
      window.addEventListener('offline', refresh);
      window.addEventListener('online', refresh);
      refresh();
    }

    function stop() {
      active = false;
      window.removeEventListener('offline', refresh);
      window.removeEventListener('online', refresh);
      onlineSeen = false;
      transition(null, Date.now());
      visibleStatus = null;
      observer.disconnect();
      observedRoot = null;
      listRoot = null;
    }

    function setListRoot(root) {
      if (root === listRoot) return;
      listRoot = root;
      refresh();
    }

    function details() {
      return { connection: visibleStatus, connectionAlertFailed: Boolean(visibleStatus) && failed };
    }

    return { start, stop, setListRoot, refresh, details };
  }

  globalThis.ShkolkovoConnection = { create };
})();
