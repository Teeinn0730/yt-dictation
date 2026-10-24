// 存放比較大的檔案（例如自訂打字音效），用 IndexedDB，不佔 localStorage 的 5MB 空間
const DB = 'ytel-files';
const STORE = 'files';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const putFile = (key, value) => run('readwrite', s => s.put(value, key));
export const getFile = key => run('readonly', s => s.get(key));
export const deleteFile = key => run('readwrite', s => s.delete(key));
