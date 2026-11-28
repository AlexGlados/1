(() => {
  'use strict';

  const HOUR = 3_600_000;
  const moscowClock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset'
  });
  let cached;

  function moscowHour(value) {
    const parts = Object.fromEntries(moscowClock.formatToParts(value).map(({ type, value }) => [type, value]));
    const { year, month, day, hour, minute, timeZoneName } = parts;
    return {
      date: `${year}-${month}-${day}`, dateLabel: `${day}.${month}.${year}`,
      hour: Number(hour), time: `${hour}:${minute}`, offset: timeZoneName.slice(3) || '+00:00'
    };
  }

  function scheduleRange(start) {
    const end = start + HOUR;
    const first = moscowHour(start);
    const last = moscowHour(end);
    const moscow = first.date === last.date ? `${first.time}–${last.time} МСК`
      : `${first.dateLabel} ${first.time} – ${last.dateLabel} ${last.time} МСК`;
    const device = local();
    const sameOffsets = device.offset(start) === 'UTC' + first.offset && device.offset(end) === 'UTC' + last.offset;
    return { moscow, local: sameOffsets ? '' : device.range(start, end) };
  }

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

  const api = Object.freeze({ local, moscowHour, scheduleRange });
  globalThis.ShkolkovoTime = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
