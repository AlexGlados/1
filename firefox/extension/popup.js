'use strict';
const el = id => document.getElementById(id);
const extension = globalThis.browser;
const runtime = extension?.runtime;
const hasExtension = Boolean(runtime?.id && typeof runtime.sendMessage === 'function');
const connectionLabels = {
  online: 'Платформа в сети', connecting: 'Платформа подключается',
  offline: 'Платформа не в сети', unknown: 'Статус неизвестен'
};
const moscowTime = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
let tabId;
let state;
let changing = false;
let revision = 0;
let lastFreeList;
let dismissButtons = [];
function message(id, text) {
  el(id).textContent = text;
  el(id).hidden = !text;
}
function drawFreeList(free = []) {
  const rows = free.map(chat => {
    const identity = { id: chat.id, title: chat.title, version: chat.version };
    if (!Number.isFinite(chat.waitingSince)) {
      return { ...identity, label: 'Передача смены' };
    }
    const minutes = Math.max(0, Math.floor((chat.waitMs ?? Date.now() - chat.waitingSince) / 60_000));
    const wait = (minutes >= 60 ? Math.floor(minutes / 60) + ' ч ' : '') + minutes % 60 + ' мин';
    return { ...identity, at: chat.waitingSince,
      label: moscowTime.format(chat.waitingSince).replace(',', '') + ' МСК', wait };
  });
  const signature = JSON.stringify(rows);
  if (signature === lastFreeList) {
    for (const button of dismissButtons) button.setAttribute('aria-disabled', String(changing));
    return;
  }
  lastFreeList = signature;
  const focusedIndex = dismissButtons.indexOf(document.activeElement);
  const focusedId = dismissButtons[focusedIndex]?.dataset.chatId;
  dismissButtons = [];
  el('free-count').textContent = rows.length;
  el('free-empty').hidden = rows.length > 0;
  const list = el('free-list');
  list.hidden = rows.length === 0;
  list.replaceChildren(...rows.map(row => {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    const detail = document.createElement('span');
    title.textContent = row.title;
    if (Number.isFinite(row.at)) {
      const time = document.createElement('time');
      time.dateTime = new Date(row.at).toISOString();
      time.textContent = row.label;
      detail.append(time, ' · ждёт ' + row.wait);
    } else detail.textContent = row.label;
    item.append(title, detail);
    if (typeof row.version === 'string' && row.version) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dismiss-free';
      button.dataset.chatId = row.id;
      button.textContent = '×';
      button.title = 'Убрать из списка свободных';
      button.setAttribute('aria-label', 'Убрать чат «' + row.title + '» из списка свободных');
      button.setAttribute('aria-disabled', String(changing));
      button.addEventListener('click', () => {
        if (changing || !state?.free?.some(chat => chat.id === row.id && chat.version === row.version)) return;
        void command('ui:dismiss-free', { id: row.id, version: row.version });
      });
      dismissButtons.push(button);
      item.append(button);
    }
    return item;
  }));
  if (focusedIndex >= 0) {
    const focused = dismissButtons.find(button => button.dataset.chatId === focusedId) ||
      dismissButtons[Math.min(focusedIndex, dismissButtons.length - 1)] || list.parentElement.querySelector('summary');
    focused?.focus({ preventScroll: true });
  }
}
function draw(s) {
  state = s;
  const currentWorker = s?.rulesVersion === 3;
  const curatorRequired = currentWorker && s.curatorRequired === true;
  const canStart = s?.canStart ?? s?.attached;
  const status = !hasExtension ? 'Открой это меню через кнопку расширения в Firefox.'
    : !s ? 'Не удалось получить состояние расширения.'
    : !currentWorker ? 'Firefox использует прежний фоновый скрипт. Перезагрузи расширение, чтобы применить изменения.'
    : curatorRequired ? 'Укажи имя и фамилию куратора, как в расписании.'
    : s.active ? (s.ready ? 'Проверка запущена в отдельной вкладке' : 'Ожидаю загрузку списка чатов')
    : canStart ? 'Проверка остановлена' : 'Открой страницу чатов. После установки обнови вкладку.';
  el('status').textContent = status;
  el('reload-extension').hidden = currentWorker || !hasExtension || typeof runtime.reload !== 'function';
  el('curator-form').hidden = !curatorRequired;
  el('monitor-controls').hidden = curatorRequired;
  for (const id of ['curator-first-name', 'curator-last-name', 'save-curator']) el(id).disabled = changing || !curatorRequired;
  el('toggle').textContent = s?.active ? 'Остановить проверку' : 'Запустить мониторинг';
  el('toggle').disabled = changing || curatorRequired || !(s?.active || canStart);
  for (const id of ['test', 'finish']) el(id).disabled = changing || !s;
  for (const id of ['shift-chats', 'senior', 'pinned-instant']) el(id).disabled = changing || !currentWorker;
  const senior = s?.mode === 'senior';
  el('senior').checked = senior;
  message('mode-status', !senior ? '' : s.active ? 'Режим старшего включён.'
    : 'Режим старшего выбран. Запусти мониторинг, чтобы начать проверку чатов.');
  el('pinned-instant').checked = s?.pinnedInstant !== false;
  const conn = s?.active ? s.connection : 'unknown';
  el('connection').dataset.state = conn;
  el('connection').textContent = connectionLabels[conn] || connectionLabels.unknown;
  el('period').textContent = s?.period || '—';
  el('last-read').textContent = s?.lastRead || '—';
  for (const id of ['bindings', 'uncertain', 'pending', 'checked', 'notified']) el(id).textContent = s?.[id] ?? '—';
  drawFreeList(s?.free);
  let schedule = '';
  if (s?.active && s.scheduleError) {
    const reason = s.scheduleError.includes('Не удалось обновить расписание') ? s.scheduleError :
      'Не удалось обновить расписание. ' + s.scheduleError;
    schedule = reason + '. Нужен состав на ' + s.period + '. ' + (s.retryAt ? 'Повтор в ' + s.retryAt + '.' : 'Загружаю состав.');
  } else if (s?.active && s.prefetchError) {
    schedule = s.prefetchError + '. Нужен состав на ' + s.nextPeriod + '.';
  } else if (s?.loading) schedule = 'Загружаю состав на ' + s.period + '.';
  message('note', [s?.error, schedule, s?.scanStatus, s?.reason].filter(Boolean).join(' '));
  if (s?.result && !el('feedback').textContent) message('feedback', s.result);
}
async function refresh() {
  if (changing) return;
  const ticket = ++revision;
  const s = await runtime.sendMessage({ type: 'ui:status', tabId }).catch(() => null);
  if (ticket === revision && !changing) draw(s?.ok === false ? null : s);
}
async function command(type, fields = {}) {
  if (changing) return;
  changing = true;
  revision++;
  const settingCurator = type === 'ui:set-curator';
  const feedback = settingCurator ? 'curator-feedback' : 'feedback';
  draw(type === 'ui:settings' ? { ...state, ...fields } : state);
  message(feedback, '');
  try {
    const r = await runtime.sendMessage({ type, tabId, ...fields });
    const success = type === 'ui:test' ? 'Тестовое уведомление отправлено.'
      : type === 'ui:dismiss-free' ? 'Чат убран из списка.' : '';
    message(feedback, r?.ok ? r.message || success
      : r?.error || 'Не удалось выполнить действие.');
    if (settingCurator && r?.ok) {
      el('curator-form').reset();
      draw({ ...state, curatorRequired: false });
    }
  } catch { message(feedback, 'Расширение не ответило. Открой меню ещё раз.'); }
  finally { changing = false; await refresh(); }
}
el('curator-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!state?.curatorRequired) return;
  void command('ui:set-curator', {
    firstName: el('curator-first-name').value.trim(),
    lastName: el('curator-last-name').value.trim(),
  });
});
el('toggle').addEventListener('click', () => command(state?.active ? 'ui:stop' : 'ui:start'));
el('test').addEventListener('click', () => command('ui:test'));
el('finish').addEventListener('click', () => command('ui:finish'));
el('shift-chats').addEventListener('click', () => command('ui:shift'));
el('reload-extension').addEventListener('click', () => runtime.reload());
el('senior').addEventListener('change', event => command('ui:settings', {
  mode: event.currentTarget.checked ? 'senior' : 'normal'
}));
el('pinned-instant').addEventListener('change', event => command('ui:settings', {
  pinnedInstant: event.currentTarget.checked
}));
async function initialize() {
  if (!hasExtension) { draw(null); return; }
  try {
    const [tab] = await extension.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  } catch { /* The current worker accepts commands without an active tab. */ }
  void refresh();
  setInterval(refresh, 2000);
}
void initialize();
