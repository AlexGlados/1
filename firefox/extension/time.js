(() => {
  'use strict';

  let cached;

  function local() {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (cached?.zone === zone) return cached;

    const date = new Intl.DateTimeFormat('ru-RU', {
      timeZone: zone, day: '2-digit', month: '2-digit', year: 'numeric'
    }).format;
    const time = new Intl.DateTimeFormat('ru-RU', {
      timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format;
    const offsets = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
    const offset = value => offsets.formatToParts(value).find(part => part.type === 'timeZoneName').value.replace('GMT', 'UTC');
    const label = value => `${date(value)} ${time(value)} ${offset(value)}`;
    const stamp = (value, now) => date(value) === date(now) ? `${time(value)} ${offset(value)}` : label(value);
    const zoneLabel = value => zone === 'UTC' ? zone : `${zone} (${offset(value)})`;

    function range(start, end) {
      const differentDate = date(start) !== date(end);
      const first = differentDate ? `${date(start)} ${time(start)}` : time(start);
      const last = differentDate ? `${date(end)} ${time(end)}` : time(end);
      const firstOffset = offset(start);
      const lastOffset = offset(end);
      if (firstOffset === lastOffset) return `${first}–${last} ${firstOffset}`;
      return `${first} ${firstOffset} – ${last} ${lastOffset}`;
    }

    cached = Object.freeze({ zone, date, time, offset, label, stamp, range, zoneLabel });
    return cached;
  }

  const api = Object.freeze({ local });
  globalThis.ShkolkovoTime = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
