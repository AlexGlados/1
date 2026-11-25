'use strict';
(() => {
  const storageKey = 'shkolkovo.monitor.v2';
  const minute = 60_000;
  const hour = 60 * minute;
  const dates = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric'
  });
  const times = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });
  const nameKey = name => name.toLocaleLowerCase('ru').replaceAll('ё', 'е').trim().split(/\s+/).sort().join(' ');
  const stamp = (value, now) => dates.format(value) === dates.format(now)
    ? times.format(value) : dates.format(value) + ' · ' + times.format(value);
  // Moscow's whole-hour offset aligns its :00 boundaries with UTC epoch hours.
  const hourStart = now => Math.floor(now / hour) * hour;
  const activeInHour = (row, start) => Number.isFinite(row.activityAt) && row.activityAt >= start && row.activityAt < start + hour;

  function shiftGroups(occupied, now) {
    const groups = new Map();
    const start = hourStart(now);
    let refreshAt = start + hour;
    for (const row of occupied) {
      if (!row.curator || !activeInHour(row, start)) continue;
      const key = nameKey(row.curator);
      if (!groups.has(key)) groups.set(key, { title: row.curator, rows: [] });
      const waiting = Number.isFinite(row.waitingSince);
      const waitMinutes = waiting ? Math.max(0, Math.floor((now - row.waitingSince) / minute)) : null;
      if (waiting) refreshAt = Math.min(refreshAt, row.waitingSince + (waitMinutes + 1) * minute);
      groups.get(key).rows.push({ ...row, waitMinutes });
    }
    const sorted = Array.from(groups.values()).sort((a, b) => collator.compare(a.title, b.title));
    for (const group of sorted) {
      group.rows.sort((a, b) =>
        ((a.waitingSince ?? Infinity) - (b.waitingSince ?? Infinity)) ||
        ((b.lastStudentAt ?? 0) - (a.lastStudentAt ?? 0)) ||
        collator.compare(a.title, b.title) || collator.compare(a.id, b.id));
    }
    return { groups: sorted, refreshAt, start };
  }

  function observeStatus(extension, draw, onError) {
    let revision = 0;
    async function refresh() {
      const ticket = ++revision;
      try {
        const status = await extension.runtime.sendMessage({ type: 'shift:status' });
        if (ticket !== revision) return;
        if (!status || status.ok === false) throw new Error(status?.error || 'Не удалось получить список чатов.');
        draw(status);
      } catch (error) {
        if (ticket === revision) onError(error.message);
      }
    }
    extension.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && Object.hasOwn(changes, storageKey)) void refresh();
    });
    void refresh();
    return refresh;
  }
  if (typeof module !== 'undefined') module.exports = { shiftGroups, observeStatus, stamp };
  if (typeof document === 'undefined') return;

  const el = id => document.getElementById(id);
  function node(tag, value, className) {
    const element = document.createElement(tag);
    if (value !== undefined) element.textContent = value;
    if (className) element.className = className;
    return element;
  }
  const buttons = new Map();
  const buttonKey = (id, action) => JSON.stringify([id, action]);
  function actionButton(id, action, label, description, className, disabled = false) {
    const button = node('button', label, className);
    button.type = 'button';
    button.dataset.chat = id;
    button.dataset.action = action;
    if (description) button.setAttribute('aria-label', description);
    button.disabled = disabled;
    buttons.set(buttonKey(id, action), button);
    return button;
  }
  function timeCell(value, label, now) {
    const td = node('td');
    td.dataset.label = label;
    if (Number.isFinite(value)) {
      const time = node('time', stamp(value, now));
      time.dateTime = new Date(value).toISOString();
      td.append(time);
    } else td.textContent = '—';
    return td;
  }
  function formatWait(minutes) {
    if (!Number.isFinite(minutes)) return '—';
    return (minutes >= 60 ? Math.floor(minutes / 60) + ' ч ' : '') + minutes % 60 + ' мин';
  }
  function renderGroup(group, now, canManage) {
    const section = node('section');
    const heading = node('h2', group.title);
    heading.append(node('span', String(group.rows.length), 'count'));
    section.append(heading);
    const table = node('table');
    table.setAttribute('aria-label', group.title);
    const labels = ['Чат', 'Последнее сообщение ученика', 'Ответ куратора', 'Ожидание', 'Действия'];
    const header = table.createTHead().insertRow();
    for (const label of labels) {
      const th = node('th', label);
      th.scope = 'col';
      header.append(th);
    }
    const body = table.createTBody();
    for (const row of group.rows) {
      const line = body.insertRow();
      line.insertCell().append(actionButton(row.id, 'open', row.title, '', 'chat', row.available === false));
      line.append(timeCell(row.lastStudentAt, labels[1], now), timeCell(row.lastCuratorAt, labels[2], now));
      const waiting = line.insertCell();
      waiting.dataset.label = labels[3];
      waiting.className = 'duration';
      waiting.textContent = formatWait(row.waitMinutes);

      const actions = line.insertCell();
      actions.className = 'actions';
      const controls = node('div');
      const subject = ' для чата «' + row.title + '»';
      const mute = actionButton(row.id, 'mute', row.muted ? 'Уведомления выкл.' : 'Уведомления вкл.',
        'Уведомления' + subject, 'action', !canManage);
      mute.setAttribute('aria-pressed', String(!row.muted));
      controls.append(mute, actionButton(row.id, 'unbind', 'Снять привязку',
        'Снять привязку' + subject, 'action', !canManage));
      actions.append(controls);
    }
    section.append(table);
    return section;
  }

  const feed = el('feedback');
  const inFlight = new Set();
  let navigating = false;
  let lastSnapshot;
  let previous;
  let timer;
  function draw(status) {
    lastSnapshot = status;
    clearTimeout(timer);
    const now = Date.now();
    const { groups, refreshAt, start } = shiftGroups(status.occupied || [], now);
    timer = setTimeout(() => draw(lastSnapshot), Math.max(1, refreshAt - now));
    const { active, mode, period, result, scheduleError, prefetchError, loading, retryAt, nextPeriod, curatorRequired } = status;
    let scheduleStatus = active && (scheduleError || prefetchError) || '';
    if (scheduleStatus) {
      if (!scheduleStatus.includes('Не удалось обновить расписание')) {
        scheduleStatus = 'Не удалось обновить расписание. ' + scheduleStatus;
      }
      const schedulePeriod = scheduleError ? period : nextPeriod;
      if (schedulePeriod) scheduleStatus += ' · Состав на ' + schedulePeriod;
      if (retryAt) scheduleStatus += ' · Повтор в ' + retryAt;
    }
    const signature = JSON.stringify([groups, start, active, mode, period, result, scheduleStatus, loading, curatorRequired]);
    if (signature === previous) return;
    previous = signature;

    const canManage = active && mode === 'senior' && !curatorRequired;
    const monitor = el('monitor-state');
    monitor.dataset.running = String(Boolean(active));
    const monitorLabel = canManage ? 'Режим старшего включён'
      : active ? 'Обычный режим' : mode === 'senior' ? 'Режим старшего выбран · мониторинг остановлен' : 'Мониторинг остановлен';
    if (monitor.textContent !== monitorLabel) monitor.textContent = monitorLabel;
    el('activity-hour').textContent = 'Текущий час ' + times.format(start) + '–' + times.format(start + hour) + ' МСК';
    el('occupied-count').textContent = 'Чатов за час — ' + groups.reduce((total, group) => total + group.rows.length, 0);
    el('period').textContent = period ? (loading ? 'Ожидается состав на ' : 'Состав на ') + period : '';
    el('schedule-status').textContent = scheduleStatus;
    el('schedule-status').hidden = !scheduleStatus;
    const empty = el('empty');
    empty.hidden = groups.length > 0;
    empty.textContent = curatorRequired ? 'Укажи имя и фамилию куратора в меню расширения.'
      : result || (active ? 'Занятых чатов с активностью в текущем часе пока нет.'
        : 'Запусти мониторинг через меню расширения.');
    if (!active && groups.length === 0) feed.hidden = true;
    const focused = document.activeElement?.dataset;
    buttons.clear();
    el('groups').replaceChildren(...groups.map(group => renderGroup(group, now, canManage)));
    if (focused?.chat) buttons.get(buttonKey(focused.chat, focused.action))?.focus({ preventScroll: true });
  }

  const extension = globalThis.browser ?? globalThis.chrome;
  if (!extension?.runtime?.id || !extension.storage?.onChanged) {
    el('monitor-state').textContent = 'Открой вкладку старшего из меню расширения.';
    return;
  }
  const refresh = observeStatus(extension, draw, error => {
    el('monitor-state').textContent = 'Статус недоступен';
    feed.textContent = error;
    feed.hidden = false;
    previous = undefined;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (lastSnapshot) draw(lastSnapshot);
    void refresh();
  });
  el('groups').addEventListener('click', async event => {
    const button = event.target.closest('button[data-chat]');
    if (!button || button.disabled) return;
    const { chat: id, action } = button.dataset;
    if (inFlight.has(id) || (action === 'open' && navigating)) return;
    const row = lastSnapshot?.occupied?.find(chat => chat.id === id);
    if (!row || !activeInHour(row, hourStart(Date.now()))) return;
    const message = { type: 'shift:' + action, id };
    if (action !== 'open') {
      message.expectedCurator = row.curator;
      message.expectedPeriod = row.bindingPeriod;
    }
    if (action === 'mute') message.muted = !row.muted;
    inFlight.add(id);
    if (action === 'open') navigating = true;
    feed.hidden = true;
    try {
      const reply = await extension.runtime.sendMessage(message);
      if (!reply?.ok) throw new Error(reply?.error || 'Не удалось выполнить действие.');
      if (action !== 'open') await refresh();
    } catch (error) {
      feed.textContent = error.message;
      feed.hidden = false;
    } finally {
      inFlight.delete(id);
      if (action === 'open') navigating = false;
    }
  });
})();
