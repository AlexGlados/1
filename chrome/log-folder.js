(() => {
  'use strict';

  const DB = 'shkolkovo.log-folder';
  const STORE = 'settings';
  const FOLDER = 'folder';
  const access = { mode: 'readwrite' };

  function openSettings() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function settings(mode, operation) {
    const db = await openSettings();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = operation(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  }

  const get = () => settings('readonly', store => store.get(FOLDER));
  const set = folder => settings('readwrite', store => store.put(folder, FOLDER));
  const status = folder => folder?.queryPermission(access) ?? 'prompt';
  const grant = folder => folder.requestPermission(access);

  async function write(filename, text) {
    if (!/^shkolkovo-shift-[a-z0-9][a-z0-9._-]{0,119}\.log$/i.test(filename)) {
      throw new TypeError('Invalid shift log filename');
    }
    const folder = await get();
    if (await status(folder) !== 'granted') return false;
    const logs = await folder.getDirectoryHandle('logs', { create: true });
    const file = await logs.getFileHandle(filename, { create: true });
    const stream = await file.createWritable();
    try {
      await stream.write(text);
      await stream.close();
    } catch (error) {
      await stream.abort().catch(() => {});
      throw error;
    }
    return true;
  }

  globalThis.ShkolkovoLogFolder = Object.freeze({ get, set, status, grant, write });
})();
