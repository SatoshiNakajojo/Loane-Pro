// ====== Base de données locale (IndexedDB) ======
const DB = (() => {
  const NAME = 'studio-vocal', VERSION = 2;
  // Magasins sauvegardés / exportés
  const STORES = ['students', 'lessons', 'payments', 'notes', 'invoices', 'library', 'settings'];
  // Magasin purement local : jetons Google, phrase secrète, cache de l'agenda Google.
  // Il n'est JAMAIS exporté ni envoyé dans le cloud (sinon le fichier de sauvegarde
  // contiendrait les identifiants), mais il survit au nettoyage de localStorage par iOS.
  const LOCAL = 'local';
  const TOUS = [...STORES, LOCAL];
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        for (const s of TOUS) {
          if (!db.objectStoreNames.contains(s)) {
            const st = db.createObjectStore(s, { keyPath: 'id' });
            if (['lessons', 'payments', 'notes'].includes(s)) st.createIndex('studentId', 'studentId');
          }
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Une autre fenêtre veut mettre la base à niveau : on libère la connexion,
        // sinon c'est elle qui resterait bloquée.
        db.onversionchange = () => { db.close(); dbp = null; };
        res(db);
      };
      req.onerror = () => { dbp = null; rej(req.error); };
      // Mise à niveau impossible car l'app est ouverte ailleurs (autre onglet Safari,
      // ou l'app installée en parallèle). Sans ce cas, ni onsuccess ni onerror ne se
      // déclenchaient : la promesse restait en attente et toute l'app se figeait.
      req.onblocked = () => {
        dbp = null;
        rej(new Error('base_bloquee'));
      };
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

  // ---- Marques de suppression ----------------------------------------------
  // La sauvegarde cloud ne transporte que ce qui EXISTE : un enregistrement
  // supprimé sur un appareil réapparaissait donc à la restauration suivante,
  // ressuscité par la copie de l'autre appareil. On note chaque suppression
  // dans une marque, rangée avec les réglages pour voyager avec la sauvegarde.
  const TOMBES = 'suppressions';
  const DUREE_TOMBE = 180 * 864e5;            // au-delà, la marque n'a plus d'utilité
  const SANS_TOMBE = new Set(['settings', LOCAL]);
  const cle = (store, id) => store + '\u0000' + id;

  function lire(store, id) {
    return open().then(db => new Promise((res, rej) => {
      const r = db.transaction(store).objectStore(store).get(id);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
  }

  async function tombes() {
    try {
      const row = await lire('settings', TOMBES);
      return (row && Array.isArray(row.value)) ? row.value.filter(t => t && t.s && t.i) : [];
    } catch (e) { return []; }
  }

  async function ecrireTombes(liste) {
    const limite = Date.now() - DUREE_TOMBE;
    const vues = new Set(), propre = [];
    for (const t of liste) {
      if (!t || !t.s || !t.i || !(t.t > limite)) continue;
      const k = cle(t.s, t.i);
      if (vues.has(k)) continue;
      vues.add(k); propre.push(t);
    }
    await tx('settings', 'readwrite', st => st.put({ id: TOMBES, value: propre }));
    return propre;
  }

  async function marquer(store, id) {
    if (SANS_TOMBE.has(store)) return;
    await ecrireTombes([{ s: store, i: id, t: Date.now() }, ...(await tombes())]);
  }

  // Un enregistrement réécrit existe de nouveau : sa marque n'a plus lieu d'être.
  async function demarquer(store, id) {
    if (SANS_TOMBE.has(store)) return;
    const liste = await tombes();
    const k = cle(store, id);
    if (!liste.some(t => cle(t.s, t.i) === k)) return;
    await ecrireTombes(liste.filter(t => cle(t.s, t.i) !== k));
  }

  return {
    uid,
    async put(store, obj) {
      if (!obj.id) obj.id = uid();
      await tx(store, 'readwrite', s => s.put(obj));
      await demarquer(store, obj.id);
      return obj;
    },
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
    async del(store, id) {
      const r = await tx(store, 'readwrite', s => s.delete(id));
      await marquer(store, id);
      return r;
    },
    // valeurs locales (jamais exportées) : identifiants, cache Google
    async getLocal(key, fallback) {
      try { const row = await this.get(LOCAL, key); return row ? row.value : fallback; }
      catch (e) { return fallback; }
    },
    async setLocal(key, value) {
      try { await tx(LOCAL, 'readwrite', s => s.put({ id: key, value })); } catch (e) { }
    },
    async delLocal(key) { try { await tx(LOCAL, 'readwrite', s => s.delete(key)); } catch (e) { } },
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
    // Combien d'enregistrements la sauvegarde retirerait-elle ici ?
    // Sert à l'annoncer AVANT de restaurer, car c'est irréversible.
    async compterSuppressions(data) {
      const entrantes = ((data.settings || []).find(r => r && r.id === TOMBES) || {}).value;
      if (!Array.isArray(entrantes)) return 0;
      const presentes = new Set();
      for (const s of STORES) if (!SANS_TOMBE.has(s)) for (const r of await this.all(s)) presentes.add(cle(s, r.id));
      const vivants = new Set();
      for (const s of STORES) if (Array.isArray(data[s])) for (const r of data[s]) vivants.add(cle(s, r.id));
      let n = 0;
      for (const t of entrantes) {
        if (!t || !t.s || !t.i || SANS_TOMBE.has(t.s)) continue;
        const k = cle(t.s, t.i);
        if (presentes.has(k) && !vivants.has(k)) n++;      // la sauvegarde ne le contient plus
      }
      return n;
    },

    // options.suppressions :
    //   true  → fusion entre appareils : les suppressions faites ailleurs sont
    //           appliquées ici, et ce qu'on a supprimé ici n'est pas ressuscité.
    //   false → retour en arrière sur une version d'archive : on veut justement
    //           récupérer ce qui a été supprimé, donc aucune marque ne bloque.
    async importAll(data, options) {
      const avecTombes = !!(options && options.suppressions);
      const bilan = { importes: 0, ignores: 0, supprimes: 0 };

      const locales = await tombes();
      const entrantes = avecTombes
        ? (((data.settings || []).find(r => r && r.id === TOMBES) || {}).value || [])
        : [];
      const fusion = [...locales, ...(Array.isArray(entrantes) ? entrantes : [])];
      const bloquees = new Set(avecTombes
        ? fusion.filter(t => t && t.s && t.i && !SANS_TOMBE.has(t.s)).map(t => cle(t.s, t.i))
        : []);

      // 1) écriture des enregistrements de la sauvegarde
      const ecrits = new Set();
      for (const s of STORES) {
        if (!Array.isArray(data[s])) continue;
        for (const row of data[s]) {
          if (!row || row.id === undefined) continue;
          if (s === 'settings' && row.id === TOMBES) continue;   // géré à part, plus bas
          const k = cle(s, row.id);
          if (bloquees.has(k)) { bilan.ignores++; continue; }    // supprimé ici volontairement
          await tx(s, 'readwrite', st => st.put(row));
          ecrits.add(k);
          bilan.importes++;
        }
      }

      // 2) suppressions venues d'un autre appareil
      if (avecTombes) {
        for (const t of fusion) {
          if (!t || !t.s || !t.i || SANS_TOMBE.has(t.s)) continue;
          const k = cle(t.s, t.i);
          if (ecrits.has(k)) continue;                           // réécrit : la marque est périmée
          if (await lire(t.s, t.i)) {
            await tx(t.s, 'readwrite', st => st.delete(t.i));
            bilan.supprimes++;
          }
        }
      }

      // 3) mise à jour des marques
      if (avecTombes) await ecrireTombes(fusion.filter(t => t && !ecrits.has(cle(t.s, t.i))));
      else if (ecrits.size) await ecrireTombes(locales.filter(t => t && !ecrits.has(cle(t.s, t.i))));

      return bilan;
    }
  };
})();
