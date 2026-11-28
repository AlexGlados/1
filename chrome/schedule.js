// The public HTML view lists the sheets. Only a sheet named for the requested
// calendar week can supply assignments. No authenticated Google API is needed.
(() => {
  'use strict';
  const weekdays = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const day = 86400000;
  const codes = new WeakMap();

  function scheduleError(code, message) {
    const error = new Error(message);
    codes.set(error, code);
    return error;
  }

  function errorCode(error) {
    return codes.get(error) ?? 'schedule_unknown';
  }

  function utcDay(year, month, date) {
    const value = new Date(Date.UTC(year, month - 1, date));
    if (value.getUTCFullYear() !== year || value.getUTCMonth() + 1 !== month || value.getUTCDate() !== date) return NaN;
    return value.getTime();
  }

  function readRussianDate(label) {
    const [date, month, year] = label.split('.').map(Number);
    return utcDay(year < 100 ? 2000 + year : year, month, date);
  }

  function selectWeek(html, requestedDay, entryGid) {
    // Parse the public tab menu as data. Never evaluate script from the sheet.
    const items = [...html.matchAll(/items\.push\(\{\s*name:\s*"([^"]*)"\s*,\s*pageUrl:\s*"[^"]*"\s*,\s*gid:\s*"(\d+)"/g)];
    if (!items.some(item => item[2] === entryGid)) {
      throw scheduleError('schedule_tabs', 'Не удалось прочитать вкладки Google Таблицы');
    }
    const matches = [];
    for (const [, title, gid] of items) {
      const range = /^(\d{2}\.\d{2}\.(?:\d{4}|\d{2}))\s*[-–—]\s*(\d{2}\.\d{2}\.(?:\d{4}|\d{2}))$/.exec(title);
      if (!range) continue;
      const start = readRussianDate(range[1]);
      const end = readRussianDate(range[2]);
      if (end - start !== 6 * day || new Date(start).getUTCDay() !== 1) continue;
      if (start <= requestedDay && requestedDay <= end) matches.push({title, gid});
    }
    if (!matches.length) throw scheduleError('schedule_week_missing', 'Нет датированного листа на нужную неделю');
    if (matches.length !== 1) throw scheduleError('schedule_week_ambiguous', 'Найдены несколько листов на одну неделю');
    return matches[0];
  }

  function csvRows(csv) {
    // GViz quotes every cell, including blanks. Honour escaped quotes and
    // newlines inside a cell so malformed or shifted columns cannot look free.
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    let closed = false;
    const input = csv.replace(/^\uFEFF/, '');
    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      if (quoted) {
        if (char !== '"') cell += char;
        else if (input[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closed = true; }
      } else if (char === ',') {
        row.push(cell.trim()); cell = ''; closed = false;
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && input[i + 1] === '\n') i++;
        row.push(cell.trim()); rows.push(row); row = []; cell = ''; closed = false;
      } else if (char === '"' && !cell && !closed) {
        quoted = true;
      } else if (char === '"' || closed) {
        throw scheduleError('schedule_csv', 'Нарушен формат CSV расписания');
      } else cell += char;
    }
    if (quoted) throw scheduleError('schedule_csv', 'Неполные данные CSV расписания');
    if (row.length || cell || closed) { row.push(cell.trim()); rows.push(row); }
    return rows;
  }

  const { clean, key: nameKey } = globalThis.ShkolkovoIdentity;
  const fullName = /^\p{L}[\p{L}\p{M}]*(?:[-']\p{L}[\p{L}\p{M}]*)*(?: \p{L}[\p{L}\p{M}]*(?:[-']\p{L}[\p{L}\p{M}]*)*){1,2}$/u;
  const requiredColumns = ['день', 'час', 'итого'];
  const nonPersonalColumns = new Set([...requiredColumns, 'старший', 'веб', '']);
  function hourAssignments(csv, requestedDay, hour) {
    const [header, ...rows] = csvRows(csv);
    const headings = (header ?? []).map(value => clean(value).toLocaleLowerCase('ru'));
    const [dayColumn, hourColumn, totalColumn] = requiredColumns.map(name => {
      const index = headings.indexOf(name);
      return index === headings.lastIndexOf(name) ? index : -1;
    });
    if ([dayColumn, hourColumn, totalColumn].includes(-1)) {
      throw scheduleError('schedule_roster', 'Не распознаны столбцы недельного листа');
    }
    const weekday = weekdays[new Date(requestedDay).getUTCDay()];
    const selected = rows.filter(row => {
      const time = /^(\d{1,2}):00(?::00)?$/.exec(row[hourColumn]);
      return row[dayColumn]?.toLowerCase() === weekday && time && Number(time[1]) === hour;
    });
    if (!selected.length) throw scheduleError('schedule_hour_missing', 'В недельном листе нет строки на нужный час');
    if (selected.length !== 1) throw scheduleError('schedule_hour_ambiguous', 'В недельном листе несколько строк на один час');
    const row = selected[0];
    if (row.length !== header.length) throw scheduleError('schedule_roster', 'Неполная строка расписания');
    const assignments = new Map();
    const directory = new Map();
    for (let i = 0; i < row.length; i++) {
      if (nonPersonalColumns.has(headings[i])) continue;
      if (!fullName.test(clean(header[i]))) {
        throw scheduleError('schedule_roster', 'Не распознано имя в заголовке персонального столбца');
      }
      const headerKey = nameKey(header[i]);
      if (directory.has(headerKey)) {
        throw scheduleError('schedule_duplicate_curator', 'В расписании совпадают имена в заголовках персональных столбцов');
      }
      directory.set(headerKey, header[i]);
      if (!row[i]) continue;
      const key = nameKey(row[i]);
      if (!fullName.test(clean(row[i])) || key !== headerKey) {
        throw scheduleError('schedule_roster', 'В персональном столбце не распознано назначение');
      }
      assignments.set(key, header[i]);
    }
    if (!/^\d+$/.test(row[totalColumn]) || Number(row[totalColumn]) !== assignments.size) {
      throw scheduleError('schedule_roster', 'Число назначений расходится с итогом в строке');
    }
    return {names: [...assignments.values()], directory: [...directory.values()]};
  }

  async function readConfig() {
    try {
      const runtime = globalThis.browser?.runtime ?? globalThis.chrome?.runtime;
      const response = await fetch(runtime.getURL('schedule-config.json'), {cache: 'no-store'});
      if (response.ok) {
        const {spreadsheetId, entryGid} = await response.json();
        if (typeof spreadsheetId === 'string' && /^[A-Za-z0-9_-]+$/.test(spreadsheetId) &&
            typeof entryGid === 'string' && /^\d+$/.test(entryGid)) return {spreadsheetId, entryGid};
      }
    } catch { /* A missing resource or invalid JSON requires local setup. */ }
    throw scheduleError('schedule_config', 'Укажи spreadsheetId и entryGid в файле schedule-config.json');
  }

  async function getText(url) {
    let response;
    try {
      response = await fetch(url, {credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(12000)});
      if (response.ok) return await response.text();
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw scheduleError('schedule_timeout', 'Google Таблица не ответила вовремя');
      }
      throw scheduleError('schedule_network', 'Не удалось прочитать Google Таблицу по сети');
    }
    throw scheduleError('schedule_http', 'Google Таблица вернула HTTP ' + response.status);
  }

  async function read(date, hour) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw scheduleError('schedule_request', 'Неверная дата или час расписания');
    }
    const requestedDay = utcDay(...date.split('-').map(Number));
    if (!Number.isFinite(requestedDay)) throw scheduleError('schedule_request', 'Неверная дата расписания');
    const {spreadsheetId, entryGid} = await readConfig();
    const base = 'https://docs.google.com/spreadsheets/d/' + spreadsheetId;
    const index = await getText(base + '/htmlview?gid=' + entryGid);
    const sheet = selectWeek(index, requestedDay, entryGid);
    const csv = await getText(base + '/gviz/tq?gid=' + sheet.gid + '&headers=0&tqx=out:csv');
    return {...hourAssignments(csv, requestedDay, hour), sheet: sheet.title};
  }

  globalThis.ShSchedule = Object.freeze({read, errorCode});
})();
