import { normalizeAccount } from './engine.js';

let connection;
function open() {
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open('talking-tom-parody', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('account');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return connection;
}

async function transaction(mode, change) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('account', mode);
    const store = tx.objectStore('account');
    const request = store.get('current');
    let result;
    request.onsuccess = () => {
      try {
        const current = normalizeAccount(request.result);
        if (change) {
          const update = change(current);
          store.put(update.account, 'current');
          result = update.response;
        } else result = current;
      } catch (error) { tx.abort(); reject(error); }
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('存储事务已取消。'));
  });
}

export const browserStore = {
  read: () => transaction('readonly'),
  update: change => transaction('readwrite', change),
};
