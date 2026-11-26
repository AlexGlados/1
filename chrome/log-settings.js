'use strict';

const folders = globalThis.ShkolkovoLogFolder;
const selectButton = document.getElementById('select-log-folder');
const grantButton = document.getElementById('grant-log-folder');
const folderStatus = document.getElementById('log-folder-status');
const folderError = document.getElementById('log-folder-error');
const exportStatus = document.getElementById('log-export-status');
const canSelect = typeof globalThis.showDirectoryPicker === 'function';
let folder;

async function showExportStatus() {
  const status = await chrome.runtime.sendMessage({ type: 'monitor:log-status' }).catch(() => null);
  const last = status?.lastExport;
  const location = last?.where === 'folder' ? 'Выбранная папка' : 'Папка загрузок Chrome';
  const saved = last ? `${location} · logs/${last.filename}` : '';
  const pending = status?.pending ? `Ожидают сохранения · ${status.pending}` : '';
  exportStatus.textContent = [saved, pending].filter(Boolean).join(' · ');
  exportStatus.hidden = !exportStatus.textContent;
}

function showError(text) {
  folderError.hidden = !text;
  folderError.textContent = text;
}

function showStatus(permission) {
  const granted = permission === 'granted';
  folderStatus.textContent = folder
    ? `${folder.name}/logs — ${granted ? 'запись разрешена' : 'требуется доступ'}`
    : 'Папка для журналов не выбрана.';
  grantButton.hidden = !folder || granted;
}

async function updateFolder(action) {
  selectButton.disabled = true;
  grantButton.disabled = true;
  showError('');
  try {
    const permission = await action();
    showStatus(permission);
    if (permission === 'granted') {
      await chrome.runtime.sendMessage({ type: 'monitor:log-export' });
    }
  } catch (error) {
    if (error?.name !== 'AbortError') {
      showError('Не удалось настроить запись. Проверь доступ к папке и повтори попытку.');
    }
  } finally {
    selectButton.disabled = !canSelect;
    grantButton.disabled = false;
  }
}

selectButton.addEventListener('click', () => void updateFolder(async () => {
  const selected = await showDirectoryPicker({
    id: 'shkolkovo-shift-logs', mode: 'readwrite', startIn: folder ?? 'documents'
  });
  const permission = await folders.status(selected);
  if (permission === 'granted') await selected.getDirectoryHandle('logs', { create: true });
  await folders.set(selected);
  folder = selected;
  return permission;
}));

grantButton.addEventListener('click', () => void updateFolder(async () => {
  const permission = await folders.grant(folder);
  if (permission === 'granted') await folder.getDirectoryHandle('logs', { create: true });
  return permission;
}));

async function load() {
  try {
    folder = await folders.get();
    showStatus(await folders.status(folder));
  } catch {
    folderStatus.textContent = 'Не удалось прочитать сохранённую папку.';
  }
  if (!canSelect) showError('В этом браузере выбор папки недоступен.');
  selectButton.disabled = !canSelect;
  await showExportStatus();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const oldLogs = changes['shkolkovo.monitor.v2']?.oldValue?.shiftLogs;
  const newLogs = changes['shkolkovo.monitor.v2']?.newValue?.shiftLogs;
  if (oldLogs?.pending.length !== newLogs?.pending.length ||
      oldLogs?.lastExport?.filename !== newLogs?.lastExport?.filename) void showExportStatus();
});

void load();
