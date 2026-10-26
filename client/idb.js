'use strict';
/*
 * IndexedDB для клиента конкурса «Лазурный берег».
 * Хранит: meta (deviceToken, профиль судьи), cache (снимок состояния), outbox
 * (оценки, ожидающие отправки). Если IndexedDB недоступен (приватный режим,
 * старый WebView), автоматически используется память процесса — приложение
 * продолжает работать, но данные не переживают перезагрузку.
 */
(function (global) {
  const DB_NAME = 'lazurny_jury';
  const DB_VERSION = 1;
  const STORES = ['meta', 'cache', 'outbox'];
  let dbPromise = null;
  let memory = null;

  function memoryDb() {
    if (!memory) {
      memory = { meta: new Map(), cache: new Map(), outbox: new Map() };
    }
    return memory;
  }

  function req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Ошибка IndexedDB'));
    });
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB недоступен'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of STORES) {
          if (db.objectStoreNames.contains(name)) continue;
          if (name === 'outbox') db.createObjectStore(name, { keyPath: 'changeId' });
          else db.createObjectStore(name);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Не удалось открыть IndexedDB'));
    });
    return dbPromise;
  }

  async function get(store, key) {
    try {
      const db = await openDb();
      return await req(db.transaction(store, 'readonly').objectStore(store).get(key));
    } catch (err) {
      console.warn('[idb] чтение из памяти:', err && err.message);
      return memoryDb()[store].get(key);
    }
  }

  async function put(store, value, key) {
    try {
      const db = await openDb();
      const os = db.transaction(store, 'readwrite').objectStore(store);
      if (store === 'outbox') return await req(os.put(value));
      return await req(os.put(value, key));
    } catch (err) {
      console.warn('[idb] запись в память:', err && err.message);
      if (store === 'outbox') memoryDb()[store].set(value.changeId, value);
      else memoryDb()[store].set(key, value);
      return key;
    }
  }

  async function del(store, key) {
    try {
      const db = await openDb();
      return await req(db.transaction(store, 'readwrite').objectStore(store).delete(key));
    } catch (err) {
      console.warn('[idb] удаление из памяти:', err && err.message);
      memoryDb()[store].delete(key);
      return undefined;
    }
  }

  async function getAll(store) {
    try {
      const db = await openDb();
      return await req(db.transaction(store, 'readonly').objectStore(store).getAll());
    } catch (err) {
      console.warn('[idb] список из памяти:', err && err.message);
      return Array.from(memoryDb()[store].values());
    }
  }

  async function clear(store) {
    try {
      const db = await openDb();
      return await req(db.transaction(store, 'readwrite').objectStore(store).clear());
    } catch (err) {
      console.warn('[idb] очистка памяти:', err && err.message);
      memoryDb()[store].clear();
      return undefined;
    }
  }

  global.LazurnyIdb = {
    getMeta: key => get('meta', key),
    setMeta: (key, value) => put('meta', value, key),
    deleteMeta: key => del('meta', key),

    getCache: key => get('cache', key),
    setCache: (key, value) => put('cache', value, key),
    deleteCache: key => del('cache', key),

    outboxAll: () => getAll('outbox'),
    outboxPut: change => put('outbox', change),
    outboxDelete: changeId => del('outbox', changeId),
    outboxClear: () => clear('outbox'),

    clearAll: async () => {
      await clear('meta');
      await clear('cache');
      await clear('outbox');
    },
  };
})(window);
