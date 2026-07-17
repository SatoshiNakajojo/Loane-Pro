// ====== Base de données locale (IndexedDB) ======
const DB = (() => {
  const NAME = 'studio-vocal', VERSION = 1;
  const STORES = ['students', 'lessons', 'payments', 'notes', 'invoices', 'library', 'settings'];
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        for (const s of STORES) {
          if (!db.objectStoreNames.contains(s)) {
            const st = db.createObjectStore(s, { keyPath: 'id' });
            if (['lessons', 'payments', 'notes'].includes(s)) st.createIndex('studentId', 'studentId');
          }
        }
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return dbp;
  }

  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  return {
    uid,
    async put(store, obj) { if (!obj.id) obj.id = uid(); await tx(store, 'readwrite', s => s.put(obj)); return obj; },
    async get(store, id) {
      const db = await open();
      return new Promise((res, rej) => {
        const r = db.transaction(store).objectStore(store).get(id);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    },
    async all(store) {
      const db = await open();
      return new Promise((res, rej) => {
        const r = db.transaction(store).objectStore(store).getAll();
        r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
      });
    },
    async byStudent(store, studentId) {
      const db = await open();
      return new Promise((res, rej) => {
        const r = db.transaction(store).objectStore(store).index('studentId').getAll(studentId);
        r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
      });
    },
    async del(store, id) { return tx(store, 'readwrite', s => s.delete(id)); },
    // réglages clé/valeur
    async getSetting(key, fallback) {
      const row = await this.get('settings', key);
      return row ? row.value : fallback;
    },
    async setSetting(key, value) { return this.put('settings', { id: key, value }); },
    // export / import complet
    async exportAll() {
      const out = {};
      for (const s of STORES) out[s] = await this.all(s);
      return out;
    },
    async importAll(data) {
      for (const s of STORES) {
        if (!Array.isArray(data[s])) continue;
        for (const row of data[s]) await tx(s, 'readwrite', st => st.put(row));
      }
    }
  };
})();
