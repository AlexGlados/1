'use strict';

(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  // Safari routes native messages to this extension's bundled macOS handler.
  const application = 'local.shkolkovo.monitor.safari';
  const permissionError = 'Разреши уведомления для «Школково для Safari» в Системных настройках macOS.';
  const permissionFailure = code => Object.assign(new Error(permissionError), { code });
  async function request(action, fields = {}) {
    let reply;
    try {
      reply = await api.runtime.sendNativeMessage(application, { version: 1, action, ...fields });
    } catch {
      throw new Error('Safari не связался с приложением «Школково для Safari». Открой установленное приложение.');
    }
    if (reply?.ok) return reply;
    if (reply?.code === 'notAuthorized' || reply?.code === 'notificationsDisabled') throw permissionFailure(reply.code);
    throw new Error('Не удалось выполнить действие с уведомлением macOS.');
  }

  globalThis.ShkolkovoNotifications = {
    async authorize() {
      const { status } = await request('authorize');
      if (status !== 'authorized') throw permissionFailure(status === 'disabled' ? 'notificationsDisabled' : 'notAuthorized');
    },
    async create(id, { title, message }) {
      return (await request('create', { id, title, message })).id;
    },
    async getAll() {
      const { ids } = await request('getAll');
      return Object.fromEntries(ids.map(id => [id, true]));
    },
    async clear(id) {
      return (await request('clear', { id })).cleared;
    },
  };
})();
