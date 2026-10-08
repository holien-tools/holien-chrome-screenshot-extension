// Hands finished screenshots from the service worker to the result page.
// Images can be far larger than chrome.storage allows, so they go in IndexedDB.

const DB_NAME = 'stw-full-page-capture';
const STORE = 'captures';
export const KEEP_LATEST = 3;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function committed(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
}

// Saves a capture, drops all but the latest few, and returns the new id.
export async function saveCapture(capture) {
  const db = await openDb();
  try {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const id = await done(store.add(capture));
    const keys = await done(store.getAllKeys());
    for (const key of keys.slice(0, -KEEP_LATEST)) store.delete(key);
    await committed(transaction);
    return id;
  } finally {
    db.close();
  }
}

export async function loadCapture(id) {
  const db = await openDb();
  try {
    return (await done(db.transaction(STORE).objectStore(STORE).get(id))) ?? null;
  } finally {
    db.close();
  }
}
