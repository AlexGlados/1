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
      throw Object.assign(new Error('Safari не связался с приложением «Школково для Safari». Открой установленное приложение.'),
        { code: 'nativeUnavailable' });
    }
    if (reply?.ok) return reply;
    if (reply?.code === 'notAuthorized' || reply?.code === 'notificationsDisabled') throw permissionFailure(reply.code);
    const code = ['invalidRequest', 'nativeError', 'logWriteFailed'].includes(reply?.code) ? reply.code : 'nativeError';
    throw Object.assign(new Error('Не удалось выполнить действие в приложении macOS.'), { code });
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
    async writeLog(filename, text) {
      const reply = await request('exportLog', { filename, text });
      return reply.filename === filename;
    },
  };
})();
