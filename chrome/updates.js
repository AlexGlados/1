(() => {
  'use strict';

  const KEY = 'shkolkovo.githubUpdate.v1';
  const ALARM = 'shkolkovo.github-update';
  const NOTICE_ID = 'shkolkovo-github-update';
  const INTERVAL_MINUTES = 15;
  const MANIFEST_URL = 'https://raw.githubusercontent.com/AlexGlados/1/refs/heads/chrome/chrome/manifest.json';
  const VERSION = /^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/u;
  let inFlight;

  function versionParts(value) {
    if (typeof value !== 'string' || !VERSION.test(value)) return null;
    const parts = value.split('.').map(Number);
    return parts.some(part => part > 0) && parts.every(part => part <= 65_535) ? parts : null;
  }

  function newer(candidate, base) {
    const left = versionParts(candidate);
    const right = versionParts(base);
    if (!left || !right) return false;
    for (let index = 0; index < 4; index++) {
      const difference = (left[index] ?? 0) - (right[index] ?? 0);
      if (difference) return difference > 0;
    }
    return false;
  }

  async function read() {
    const values = await chrome.storage.local.get(KEY);
    return values[KEY] ?? {};
  }

  async function checkDue(scheduled) {
    const previous = await read();
    const now = Date.now();
    const elapsed = now - previous.attemptedAt;
    // A repeating alarm has its own cadence. Only suppress a near-simultaneous startup check.
    const minimumElapsed = scheduled ? 30_000 : INTERVAL_MINUTES * 60_000;
    if (elapsed >= 0 && elapsed < minimumElapsed) return;
    const state = { ...previous, attemptedAt: now };
    await chrome.storage.local.set({ [KEY]: state });

    const response = await fetch(MANIFEST_URL, {
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return;
    const data = await response.json();
    const version = data?.version;
    if (!versionParts(version)) return;

    state.latestVersion = version;
    const installed = chrome.runtime.getManifest().version;
    const announce = newer(version, installed) &&
      (!versionParts(state.announcedVersion) || newer(version, state.announcedVersion));
    if (announce) state.announcedVersion = version;
    // Persist the offer before attempting delivery so a worker restart cannot repeat it.
    await chrome.storage.local.set({ [KEY]: state });
    if (announce) {
      await chrome.notifications.create(NOTICE_ID, {
        type: 'basic', iconUrl: 'icon.png', title: 'Доступно обновление расширения Школково',
        message: `Версия ${version} для Chrome. Нажми, чтобы открыть ветку обновления на GitHub.`
      });
    }
  }

  function check({ scheduled = false } = {}) {
    inFlight ??= checkDue(scheduled).catch(() => {}).finally(() => { inFlight = null; });
    return inFlight;
  }

  async function initialize() {
    const alarm = await chrome.alarms.get(ALARM);
    if (!alarm || alarm.periodInMinutes !== INTERVAL_MINUTES) {
      await chrome.alarms.create(ALARM, { periodInMinutes: INTERVAL_MINUTES });
    }
    await check();
  }

  async function status() {
    const { latestVersion } = await read().catch(() => ({}));
    const installed = chrome.runtime.getManifest().version;
    return newer(latestVersion, installed) ? { version: latestVersion } : null;
  }

  globalThis.ShkolkovoUpdates = Object.freeze({ ALARM, NOTICE_ID, initialize, check, status });
})();
