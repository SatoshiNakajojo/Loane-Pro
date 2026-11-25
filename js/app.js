// ====== Loane Pro ======
const APP_VERSION = '3.11.0';

const $ = sel => document.querySelector(sel);
const view = $('#view');
const esc = s => (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = name => name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const fmtDate = d => new Date(d).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDateFull = d => new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtTime = d => new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

let CURRENCY = 'XPF';
function fmtMoney(n) {
  n = n || 0;
  if (CURRENCY === 'EUR') return n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
  return Math.round(n).toLocaleString('fr-FR') + ' F';
}
function fmtHours(minutes) {
  const h = Math.floor(minutes / 60), m = Math.round(minutes % 60);
  if (!h) return m + ' min';
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

// Effets de verre et scintillement : coûteux en continu sur un téléphone.
// Désactivés par défaut ; la classe « riche » les rétablit tous.
function appliquerApparence() {
  document.documentElement.classList.toggle('riche', localStorage.getItem('effets') === '1');
}
appliquerApparence();

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => t.hidden = true, 2400);
}

// ---------- Feuille modale ----------
function openSheet(html) {
  $('#sheet').innerHTML = '<div class="handle"></div>' + html;
  $('#sheet').hidden = false; $('#sheet-backdrop').hidden = false;
}
function closeSheet() { $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true; }
$('#sheet-backdrop').addEventListener('click', closeSheet);

// ====== Types de séances ======
const KINDS = {
  cours: { label: 'Cours', icon: '🎤', student: true, paid: true, travail: true },
  repetition: { label: 'Répétition', icon: '🎹', student: false, paid: false, travail: true },
  concert: { label: 'Concert', icon: '🎭', student: false, paid: true, travail: true },
  autre: { label: 'Autre (travail)', icon: '📌', student: false, paid: false, travail: true },
  perso: { label: 'Perso (hors travail)', icon: '🏡', student: false, paid: false, travail: false }
};
const estTravail = l => (KINDS[l.kind || 'cours'] || {}).travail !== false;

// --- Rapprochement d'un événement Google avec un élève ---
// Accents retirés, ponctuation ignorée : « Cours Léa B. » et « lea » se rejoignent.
const sansAccent = x => (x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const motsDe = x => sansAccent(x).split(/[^a-z0-9]+/).filter(m => m.length >= 3);
// --- Couleurs Google ---
// C'est la couleur de l'événement, et elle seule, qui dit si c'est un cours et où
// il a lieu : un titre est trop incertain. Identifiants officiels de la palette
// « événement » de Google Agenda.
const COULEURS_GOOGLE = {
  '1': 'Lavande', '2': 'Sauge', '3': 'Raisin', '4': 'Flamant rose',
  '5': 'Banane', '6': 'Mandarine', '7': 'Paon', '8': 'Graphite',
  '9': 'Myrtille', '10': 'Basilic', '11': 'Tomate'
};
const COULEURS_DEFAUT = { domicile: '1', ecole: '3' };   // lavande / raisin
function couleursCours() {
  try {
    const v = JSON.parse(localStorage.getItem('gc_couleurs') || 'null');
    return (v && typeof v === 'object') ? { ...COULEURS_DEFAUT, ...v } : { ...COULEURS_DEFAUT };
  } catch (e) { return { ...COULEURS_DEFAUT }; }
}
// Un événement sans couleur attribuée prend celle de l'agenda : Google ne renvoie
// alors aucun colorId, et l'événement n'est donc jamais pris pour un cours.
function lieuDeCouleur(colorId) {
  const id = String(colorId || '');
  if (!id) return null;
  for (const [lieu, c] of Object.entries(couleursCours())) if (c && c === id) return lieu;
  return null;
}
const estCoursGoogle = ev => !!lieuDeCouleur(ev && ev.colorId);

// --- Reconnaître un cours déjà rattaché ---
// Se fier au seul identifiant Google est fragile : il change dès qu'une série
// est modifiée ou recréée. L'app croyait alors avoir affaire à des événements
// neufs — elle redemandait de rattacher ce qui l'était déjà, et dupliquait en
// silence ce qu'elle savait reconnaître. Le créneau horaire, lui, ne bouge pas.
const TOLERANCE_CRENEAU = 5;                       // minutes
const minuteDe = d => Math.round(+new Date(d) / 60000);
// Créneaux déjà occupés par un cours issu de Google, à la minute près.
function creneauxGoogle(lecons) {
  const set = new Set();
  for (const l of lecons) if (l.gcalEventId) set.add(minuteDe(l.date));
  return set;
}
function creneauPris(set, date) {
  const m = minuteDe(date);
  for (let d = -TOLERANCE_CRENEAU; d <= TOLERANCE_CRENEAU; d++) if (set.has(m + d)) return true;
  return false;
}
// Par défaut on ne montre que les cours : les rendez-vous personnels d'un autre
// coloris n'encombrent ni l'agenda ni la liste « à rattacher ».
const seulementCours = () => localStorage.getItem('gc_seulement_cours') !== '0';
const evenementsAffichables = () => seulementCours() ? gcalCache.filter(estCoursGoogle) : gcalCache;

// Renvoie l'élève UNIQUEMENT si la correspondance est certaine.
// Dans le doute (homonymes, plusieurs élèves cités), on ne devine pas :
// l'événement reste dans « à rattacher », où il sera traité à la main.
function eleveDeLEvenement(titre, eleves) {
  const mots = new Set(motsDe(titre));
  if (!mots.size) return null;
  // 1) nom complet : tous les mots du nom de l'élève figurent dans le titre
  const complets = eleves.filter(e => {
    const n = motsDe(e.name);
    return n.length && n.every(m => mots.has(m));
  });
  if (complets.length === 1) return complets[0];
  if (complets.length > 1) return null;                 // plusieurs élèves cités
  // 2) prénom seul, à condition qu'un seul élève puisse correspondre
  const parPrenom = eleves.filter(e => {
    const n = motsDe(e.name);
    return n.length && mots.has(n[0]);
  });
  return parPrenom.length === 1 ? parPrenom[0] : null;   // homonymes : on s'abstient
}
// Les séances créées à l'avance attendent une validation ; les anciennes sont considérées faites
const estValide = l => (l.status || 'done') === 'done';
const enAttente = l => !estValide(l) && new Date(l.date) <= Date.now();

// Lieux possibles pour un cours
const LIEUX = { ecole: "À l\u2019école", domicile: 'À domicile' };

// ====== Réglages par défaut ======
const DEFAULT_FORFAITS = [
  { label: "Cours à l\u2019unité (1 h)", hours: 1, price: 5000, validity: 2, from: 'first' },
  { label: "Forfait 4 h ancien élève", hours: 4, price: 18000, validity: 2, from: 'first' },
  { label: "Forfait 4 h nouvel élève Do", hours: 4, price: 20000, validity: 2, from: 'first' },
  { label: "Cours à l\u2019unité hors forfait Do (1 h)", hours: 1, price: 6000, validity: 2, from: 'first' },
  { label: "Bon cadeau 1 h", hours: 1, price: 5000, validity: 6, from: 'purchase' },
  { label: "Bon cadeau 4 h", hours: 4, price: 18000, validity: 6, from: 'purchase' },
  { label: "Bon cadeau 8 h", hours: 8, price: 36000, validity: 6, from: 'purchase' }
];

// compatibilité : anciens forfaits/paiements exprimés en nombre de cours (1 cours = 1 h)
const forfaitHeures = f => f.hours != null ? f.hours : (f.lessons || 1);
const paiementMinutes = p => Math.round((p.hoursCovered != null ? p.hoursCovered : (p.lessonsCovered || 1)) * 60);
const estCollectif = l => /collectif/i.test(l.type || '');
const DEFAULT_TYPES = ['Cours de chant individuel', 'Cours collectif', 'Coaching scénique', 'Atelier découverte'];
const DEFAULT_COLLECTORS = ['Loane', 'École de chant'];

async function getConfig() {
  const courseTypes = await DB.getSetting('courseTypes', DEFAULT_TYPES);
  const forfaits = await DB.getSetting('forfaits', DEFAULT_FORFAITS);
  const business = await DB.getSetting('business', { name: '', address: '', siret: '', email: '', phone: '', iban: '', footer: '' });
  const collectors = await DB.getSetting('collectors', DEFAULT_COLLECTORS);
  return { courseTypes, forfaits, business, collectors };
}

// ====== Verrouillage ======
const Lock = {
  async hash(code) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('loane:' + code));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  },
  get enabled() { return !!localStorage.getItem('lock_hash'); },
  get delay() { return +(localStorage.getItem('lock_delay') ?? 300000); }, // 5 min par défaut
  set delay(v) { localStorage.setItem('lock_delay', v); },
  touch() { localStorage.setItem('lock_seen', Date.now()); },
  // au retour d'arrière-plan : on applique le délai choisi
  shouldLock() {
    if (!this.enabled) return false;
    if (this.delay < 0) return false;                       // « jamais »
    const seen = +(localStorage.getItem('lock_seen') || 0);
    return Date.now() - seen > this.delay;
  },
  // au lancement de l'app : on demande toujours le code (sauf réglage « jamais »)
  shouldLockAtStart() {
    return this.enabled && this.delay >= 0;
  },
  buffer: '',
  show() {
    if (!this.enabled) { this.hide(); return; }   // aucun code défini : jamais de blocage
    this.buffer = '';
    document.body.classList.add('locked');
    $('#lock').hidden = false;
    this.drawDots();
  },
  hide() {
    document.body.classList.remove('locked');
    $('#lock').hidden = true;
    this.touch();
  },
  drawDots() {
    $('#lock-dots').innerHTML = Array.from({ length: 4 }, (_, i) => `<i class="${i < this.buffer.length ? 'on' : ''}"></i>`).join('');
  },
  async press(d) {
    if (d === 'del') { this.buffer = this.buffer.slice(0, -1); this.drawDots(); return; }
    if (this.buffer.length >= 4) return;
    this.buffer += d; this.drawDots();
    if (this.buffer.length === 4) {
      const ok = (await this.hash(this.buffer)) === localStorage.getItem('lock_hash');
      if (ok) { $('#lock-msg').textContent = ''; this.hide(); }
      else {
        $('#lock-msg').textContent = 'Code incorrect';
        this.buffer = ''; this.drawDots();
        if (navigator.vibrate) navigator.vibrate(120);
      }
    }
  },
  init() {
    $('#keypad').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      this.press(b.hasAttribute('data-del') ? 'del' : b.textContent.trim());
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.touch();
      else if (this.shouldLock()) this.show();
    });
    setInterval(() => this.touch(), 30000);
    if (this.shouldLockAtStart()) this.show(); else this.touch();
  }
};

// ====== Identifiants (jetons Google, phrase secrète) ======
// iOS efface localStorage au bout de quelques jours sans ouvrir l'app : la connexion
// Google sautait et la phrase secrète du cloud disparaissait, arrêtant les sauvegardes
// sans le moindre message. On garde donc une copie dans IndexedDB (non exportée).
const Creds = {
  CLES: ['gc_refresh', 'cloud_pass'],
  async charger() {
    for (const k of this.CLES) {
      const local = localStorage.getItem(k);
      const garde = await DB.getLocal(k, null);
      if (local && local !== garde) await DB.setLocal(k, local);     // localStorage fait foi
      else if (!local && garde) localStorage.setItem(k, garde);      // restauration après purge
    }
    // demande au navigateur de ne pas effacer nos données (accordé si l'app est installée)
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { }
  },
  set(k, v) { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); DB.setLocal(k, v || null); },
  oublier(k) { localStorage.removeItem(k); DB.delLocal(k); }
};

// ====== Google Agenda ======
const GC_DEPUIS_DEFAUT = '2026-05-25';

// Un événement Google peut être horaire (start.dateTime) ou sur la journée (start.date).
// Les événements « journée entière » étaient purement et simplement ignorés.
const gcJournee = e => !!(e.start && !e.start.dateTime && e.start.date);
const gcDebut = e => (e.start && e.start.dateTime) || ((e.start && e.start.date) ? e.start.date + 'T09:00:00' : null);
const gcFin = e => (e.end && e.end.dateTime) || null;

class ErreurGoogle extends Error {
  constructor(cause) { super(cause); this.cause = cause; }
}
const MESSAGE_GOOGLE = {
  reconnecter: 'Autorisation Google expirée — reconnecte le compte',
  reseau: 'Google injoignable (réseau ?)',
  worker: 'Worker Cloudflare injoignable',
  api: 'Google a refusé la demande'
};

const GC = {
  probleme: '',          // '' | 'reconnecter' | 'reseau' | 'worker' | 'api'
  _refreshEnCours: null,
  derniereSync: 0,

  get connected() { return !!localStorage.getItem('gc_refresh'); },
  get aReconnecter() { return this.connected && this.probleme === 'reconnecter'; },

  connect() {
    if (!WORKER_URL) { toast('Configure d’abord WORKER_URL'); return; }
    location.href = WORKER_URL + '/auth/start?redirect=' + encodeURIComponent(location.origin + location.pathname);
  },

  async disconnect() {
    Creds.oublier('gc_refresh');
    ['gc_access', 'gc_expiry'].forEach(k => localStorage.removeItem(k));
    this.probleme = '';
    gcalCache = [];
    await DB.setLocal('gc_cache', null);
  },

  // Retour de Google : les jetons arrivent dans le fragment d'URL (#gc=...)
  handleCallback() {
    if (!location.hash.startsWith('#gc=')) return;
    let tok = null;
    try {
      const brut = decodeURIComponent(location.hash.slice(4)).replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(brut + '='.repeat((4 - brut.length % 4) % 4));
      tok = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
    } catch (e) { console.error('callback Google', e); }
    history.replaceState(null, '', location.pathname);
    if (!tok) { toast('Retour de Google illisible'); return; }
    // le worker renvoie maintenant aussi les erreurs, au lieu d'une page blanche
    if (tok.error) {
      toast(tok.error === 'access_denied' ? 'Connexion Google annulée' : 'Erreur Google : ' + tok.error);
      console.error('OAuth', tok);
      return;
    }
    if (!tok.access_token) { toast('Google n’a pas renvoyé de jeton'); return; }
    if (tok.refresh_token) Creds.set('gc_refresh', tok.refresh_token);
    const duree = Number(tok.expires_in) > 0 ? Number(tok.expires_in) : 3600;
    localStorage.setItem('gc_access', tok.access_token);
    localStorage.setItem('gc_expiry', Date.now() + (duree - 120) * 1000);
    this.probleme = '';
    toast('Google Agenda connecté ✓');
  },

  // Jeton d'accès valide, renouvelé au besoin. Une seule demande à la fois :
  // plusieurs appels simultanés déclenchaient autant de rafraîchissements.
  token() {
    const acc = localStorage.getItem('gc_access');
    if (acc && Date.now() < +(localStorage.getItem('gc_expiry') || 0)) return Promise.resolve(acc);
    if (!this._refreshEnCours) {
      this._refreshEnCours = this._refresh().finally(() => { this._refreshEnCours = null; });
    }
    return this._refreshEnCours;
  },

  async _refresh() {
    const rt = localStorage.getItem('gc_refresh');
    if (!rt) { this.probleme = 'reconnecter'; throw new ErreurGoogle('reconnecter'); }
    let r;
    try {
      r = await fetch(WORKER_URL + '/auth/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt })
      });
    } catch (e) { this.probleme = 'worker'; throw new ErreurGoogle('worker'); }

    const tok = await r.json().catch(() => ({}));
    if (r.status === 401 || tok.error === 'invalid_grant') {
      // Autorisation révoquée, mot de passe Google changé, ou application encore en
      // mode « Test » côté Google : dans ce cas le jeton expire au bout de 7 jours.
      // On garde le compte affiché mais on demande explicitement une reconnexion.
      ['gc_access', 'gc_expiry'].forEach(k => localStorage.removeItem(k));
      this.probleme = 'reconnecter';
      throw new ErreurGoogle('reconnecter');
    }
    if (!r.ok || !tok.access_token) { this.probleme = 'reseau'; throw new ErreurGoogle('reseau'); }

    const duree = Number(tok.expires_in) > 0 ? Number(tok.expires_in) : 3600;
    localStorage.setItem('gc_access', tok.access_token);
    localStorage.setItem('gc_expiry', Date.now() + (duree - 120) * 1000);
    this.probleme = '';
    return tok.access_token;
  },

  async api(path, essai = 0) {
    const t = await this.token();
    let r;
    try {
      r = await fetch('https://www.googleapis.com/calendar/v3' + path, {
        headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }
      });
    } catch (e) { this.probleme = 'reseau'; throw new ErreurGoogle('reseau'); }

    // jeton refusé alors qu'il semblait valide : on force un renouvellement, une fois
    if (r.status === 401 && essai === 0) {
      localStorage.removeItem('gc_expiry');
      return this.api(path, 1);
    }
    if (r.status === 401) { this.probleme = 'reconnecter'; throw new ErreurGoogle('reconnecter'); }
    if (r.status === 204) return null;
    if (!r.ok) {
      console.error('Google API', r.status, await r.text().catch(() => ''));
      this.probleme = 'api';
      throw new ErreurGoogle('api');
    }
    return r.json();
  },

  // Récupère les événements du calendrier principal.
  // Avant : une seule page de 800 événements, les journées entières exclues.
  async pullEvents() {
    if (!this.connected) return [];
    let min = new Date((localStorage.getItem('gc_since') || GC_DEPUIS_DEFAUT) + 'T00:00:00');
    if (isNaN(min)) min = new Date(Date.now() - 180 * 864e5);
    const max = new Date(Date.now() + 365 * 864e5);
    const avecJournees = localStorage.getItem('gc_journees') !== '0';
    const base = '/calendars/primary/events'
      + '?timeMin=' + encodeURIComponent(min.toISOString())
      + '&timeMax=' + encodeURIComponent(max.toISOString())
      + '&singleEvents=true&orderBy=startTime&maxResults=250';

    const out = [];
    let page = '';
    for (let i = 0; i < 20; i++) {                       // 20 pages = 5000 événements
      const data = await this.api(base + (page ? '&pageToken=' + encodeURIComponent(page) : ''));
      for (const e of (data && data.items) || []) {
        if (e.status === 'cancelled') continue;          // instance supprimée d'une série
        if (!e.start || (!e.start.dateTime && !e.start.date)) continue;
        if (!avecJournees && gcJournee(e)) continue;
        out.push(e);
      }
      page = (data && data.nextPageToken) || '';
      if (!page) break;
    }
    this.probleme = '';
    this.derniereSync = Date.now();
    // conservé en local : l'agenda reste complet au redémarrage et hors ligne
    await DB.setLocal('gc_cache', { date: this.derniereSync, events: out });
    return out;
  },

  // Cache relu au lancement, pour ne pas afficher un agenda amputé le temps de la synchro
  async chargerCache() {
    const c = await DB.getLocal('gc_cache', null);
    if (c && Array.isArray(c.events)) { this.derniereSync = c.date || 0; return c.events; }
    return [];
  },

  // Vérifie la chaîne complète, étape par étape, et dit laquelle casse.
  async diagnostic() {
    const etapes = [];
    const ajout = (nom, ok, detail) => etapes.push({ nom, ok, detail: detail || '' });

    if (!WORKER_URL) { ajout('Adresse du worker', false, 'WORKER_URL vide dans js/config.js'); return etapes; }
    ajout('Adresse du worker', true, WORKER_URL);

    // 1) le worker répond-il, et est-il complet ?
    let sante = null, statutSante = '', repond = false;
    try {
      const r = await fetch(WORKER_URL + '/health');
      repond = true;
      statutSante = 'HTTP ' + r.status;
      if (r.ok) sante = await r.json().catch(() => null);
    } catch (e) { statutSante = 'requête bloquée — worker injoignable, adresse erronée, ou pas de réseau'; }

    if (!sante) {
      // Le worker qui répond sans /health est l'ancienne version, encore déployée.
      ajout('Worker joignable', repond, repond ? statutSante : statutSante);
      ajout('Code du worker à jour', false, repond
        ? 'Le worker répond mais ne connaît pas /health : c\u2019est l\u2019ancienne version. Recolle worker/worker.js dans Cloudflare → Deploy.'
        : 'Impossible de le vérifier tant que le worker ne répond pas.');
    } else {
      ajout('Worker joignable', true, 'code à jour');
      ajout('Identifiants Google configurés', !!sante.google, sante.google ? '' : 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET manquants sur le worker');
      const origineOk = !sante.origines.length || sante.origines.includes(location.origin);
      ajout('ALLOWED_ORIGIN du worker', origineOk,
        origineOk ? (sante.origines.join(', ') || 'aucune (tout autorisé)')
          : 'le worker autorise ' + (sante.origines.join(', ') || '—') + ' mais l\u2019app est sur ' + location.origin);
    }

    // 2) autorisation Google
    const rt = localStorage.getItem('gc_refresh');
    ajout('Compte Google connecté', !!rt, rt ? '' : 'jamais connecté, ou autorisation effacée par iOS');
    if (!rt) return etapes;

    let jeton = null;
    try {
      const r = await fetch(WORKER_URL + '/auth/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt })
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.access_token) { jeton = d.access_token; ajout('Autorisation Google valide', true); }
      else ajout('Autorisation Google valide', false,
        'HTTP ' + r.status + (d.error ? ' · ' + d.error : '') + (r.status === 401 ? ' — reconnecte le compte Google' : ''));
    } catch (e) { ajout('Autorisation Google valide', false, 'requête bloquée (CORS : ALLOWED_ORIGIN ?)'); }
    if (!jeton) return etapes;

    // 3) l'API Agenda répond-elle ?
    try {
      const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1',
        { headers: { Authorization: 'Bearer ' + jeton } });
      if (r.ok) ajout('Lecture de l\u2019agenda', true);
      else {
        const d = await r.json().catch(() => ({}));
        const m = d.error && d.error.message ? d.error.message : '';
        ajout('Lecture de l\u2019agenda', false, 'HTTP ' + r.status + (m ? ' · ' + m : '')
          + (r.status === 403 ? ' — API Google Calendar non activée, ou portée insuffisante' : ''));
      }
    } catch (e) { ajout('Lecture de l\u2019agenda', false, 'requête bloquée'); }

    return etapes;
  },

  // Synchro complète avec message d'erreur explicite (au lieu de « Échec de la synchro »)
  async synchroniser(silencieux) {
    try {
      gcalCache = await this.pullEvents();
      // Les cours reconnus à leur couleur sont rattachés dans la foulée ;
      // seul le reste demandera une intervention.
      let bilan = null;
      try { bilan = await rattacherAuto(); }
      catch (e) { console.error('rattachement auto', e); }
      if (bilan) {
        const n = bilan.crees + bilan.lies;
        toast(n + ' cours rattaché' + (n > 1 ? 's' : '') + ' automatiquement — à valider');
      } else if (!silencieux) {
        const cours = gcalCache.filter(estCoursGoogle).length;
        toast(gcalCache.length + ' événement(s) · ' + cours + ' cours ✓');
      }
      return true;
    } catch (e) {
      const msg = MESSAGE_GOOGLE[e && e.cause] || 'Échec de la synchro';
      if (!silencieux || e.cause === 'reconnecter') toast(msg);
      console.error('synchro Google', e);
      return false;
    }
  }
};

// ====== Sauvegarde cloud ======
const Cloud = {
  get pass() { return localStorage.getItem('cloud_pass') || ''; },
  set pass(v) { Creds.set('cloud_pass', v || ''); },
  get lastBackup() { return +(localStorage.getItem('cloud_last') || 0); },
  derniereErreur: '',

  // nombre d'enregistrements réels (hors réglages)
  async localCount() {
    let n = 0;
    for (const k of ['students', 'lessons', 'payments', 'notes', 'invoices', 'library']) n += (await DB.all(k)).length;
    return n;
  },

  // Empreinte du dernier envoi réussi : inutile de renvoyer 3 Mo si rien n'a changé
  // (les écritures KV de Cloudflare sont limitées à 1000 par jour).
  async empreinte(txt) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
    return [...new Uint8Array(b)].slice(0, 12).map(x => x.toString(16).padStart(2, '0')).join('');
  },

  async backup(silent, force) {
    if (!WORKER_URL) { if (!silent) toast('WORKER_URL non configuré'); return false; }
    if (!this.pass) { if (!silent) toast('Configure la phrase secrète'); return false; }
    const n = await this.localCount();
    // sécurité locale : on n'envoie jamais une base vide par-dessus une sauvegarde existante
    if (n === 0 && this.lastBackup && !force) {
      this.derniereErreur = 'Base locale vide : envoi bloqué';
      if (!silent) toast('Base vide : envoi bloqué pour protéger le cloud');
      console.warn('sauvegarde annulée : base locale vide');
      return false;
    }
    if (!navigator.onLine) { this.derniereErreur = 'Hors ligne'; if (!silent) toast('Hors ligne'); return false; }

    let corps;
    try { corps = JSON.stringify(await DB.exportAll()); }
    catch (e) { this.derniereErreur = 'Lecture locale impossible'; if (!silent) toast('Lecture des données impossible'); return false; }

    const sig = await this.empreinte(corps);
    if (!force && sig === localStorage.getItem('cloud_sig')) {
      this.derniereErreur = '';
      if (!silent) toast('Déjà à jour dans le cloud ✓');
      return true;                                   // rien à envoyer
    }

    try {
      const entetes = { 'Content-Type': 'application/json', 'X-Backup-Key': this.pass };
      if (force) entetes['X-Force'] = '1';
      const r = await fetch(WORKER_URL + '/backup', { method: 'PUT', headers: entetes, body: corps });

      if (r.status === 409) {
        const d = await r.json().catch(() => ({}));
        this.derniereErreur = `Envoi refusé : ${d.envoye} enregistrement(s) contre ${d.cloud} dans le cloud`;
        if (!silent) toast(this.derniereErreur);
        return false;
      }
      if (r.status === 401) { this.derniereErreur = 'Phrase secrète refusée'; if (!silent) toast(this.derniereErreur); return false; }
      if (r.status === 501) { this.derniereErreur = 'Stockage KV absent sur le worker'; if (!silent) toast(this.derniereErreur); return false; }
      if (r.status === 413) { this.derniereErreur = 'Sauvegarde trop volumineuse (max 20 Mo)'; if (!silent) toast(this.derniereErreur); return false; }
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + await r.text().catch(() => ''));

      localStorage.setItem('cloud_last', Date.now());
      localStorage.setItem('cloud_sig', sig);
      this.derniereErreur = '';
      if (!silent) toast('Sauvegardé dans le cloud ✓');
      return true;
    } catch (e) {
      console.error('sauvegarde cloud', e);
      if (!navigator.onLine) this.derniereErreur = 'Hors ligne';
      else if (force) {
        // L'ancien worker n'autorise pas l'en-tête X-Force : le navigateur bloque
        // la requête avant même de l'envoyer. Rien à voir avec la phrase secrète.
        const w = await this.sonderWorker();
        this.derniereErreur = w.ajour
          ? 'Cloud injoignable (worker / CORS ?)'
          : 'Forçage impossible : le worker Cloudflare doit être mis à jour (en-tête X-Force refusé)';
      } else this.derniereErreur = 'Cloud injoignable (worker / CORS ?)';
      if (!silent) toast(this.derniereErreur);
      return false;
    }
  },

  async lire(ts) {
    const url = WORKER_URL + '/backup' + (ts ? '?ts=' + encodeURIComponent(ts) : '');
    const r = await fetch(url, { headers: { 'X-Backup-Key': this.pass } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('lecture impossible');
    return r.json();
  },

  async historique() {
    if (!WORKER_URL || !this.pass) return [];
    try {
      const r = await fetch(WORKER_URL + '/backup?list=1', { headers: { 'X-Backup-Key': this.pass } });
      return r.ok ? await r.json() : [];
    } catch (e) { return []; }
  },

  // L'ancienne version du worker ne connaît ni /health, ni ?meta=1, ni l'en-tête
  // X-Force. Tant qu'elle n'est pas remplacée, l'app doit fonctionner quand même :
  // on sonde une fois pour savoir à quoi on parle.
  _worker: null,
  async sonderWorker(refaire) {
    if (this._worker && !refaire) return this._worker;
    if (!WORKER_URL) return (this._worker = { joignable: false, ajour: false, raison: 'WORKER_URL vide' });
    try {
      const r = await fetch(WORKER_URL + '/health');
      if (!r.ok) return (this._worker = { joignable: true, ajour: false, raison: 'HTTP ' + r.status });
      const j = await r.json().catch(() => null);
      this._worker = (j && j.ok)
        ? { joignable: true, ajour: true, kv: !!j.kv, google: !!j.google, origines: j.origines || [] }
        : { joignable: true, ajour: false, raison: 'réponse inattendue' };
    } catch (e) {
      this._worker = { joignable: false, ajour: false, raison: 'requête bloquée (réseau ou CORS)' };
    }
    return this._worker;
  },

  // Date/volume de la dernière sauvegarde sans télécharger tout le contenu
  async meta() {
    if (!WORKER_URL || !this.pass) return null;
    try {
      const r = await fetch(WORKER_URL + '/backup?meta=1', { headers: { 'X-Backup-Key': this.pass } });
      if (!r.ok) return null;
      const m = await r.json().catch(() => null);
      if (!m || m.vide) return null;
      if (typeof m.count === 'number' && m.date) return m;
      // Ancien worker : il ignore ?meta=1 et renvoie la sauvegarde entière.
      // On en tire quand même le nombre d'enregistrements.
      let n = 0;
      for (const k of Object.keys(m)) if (Array.isArray(m[k]) && k !== 'settings') n += m[k].length;
      return { count: n, date: null, ancien: true };
    } catch (e) { return null; }
  },

  async restore(ts) {
    if (!WORKER_URL) { toast('WORKER_URL non configuré'); return; }
    if (!this.pass) { toast('Renseigne la phrase secrète'); return; }
    let data;
    try {
      const url = WORKER_URL + '/backup' + (ts ? '?ts=' + encodeURIComponent(ts) : '');
      const r = await fetch(url, { headers: { 'X-Backup-Key': this.pass } });
      if (r.status === 404) { toast('Aucune sauvegarde pour cette phrase secrète'); return; }
      if (r.status === 401) { toast('Phrase secrète refusée (6 car. min.)'); return; }
      if (!r.ok) { toast('Erreur cloud ' + r.status); return; }
      const txt = await r.text();
      if (!txt || txt.length < 2) { toast('Sauvegarde cloud vide'); return; }
      try { data = JSON.parse(txt); }
      catch (e) { toast('Sauvegarde illisible (JSON invalide)'); console.error('restore parse', e); return; }
    } catch (e) {
      // vraie cause : réseau, CORS, ou domaine bloqué par le worker
      console.error('restore fetch', e);
      toast('Connexion au cloud impossible (réseau ?)');
      return;
    }
    let n = 0;
    for (const k of Object.keys(data)) if (Array.isArray(data[k]) && k !== 'settings') n += data[k].length;
    if (n === 0) { toast('La sauvegarde ne contient aucune donnée'); return; }

    // Restaurer la sauvegarde courante, c'est se remettre au même état que le cloud :
    // les suppressions faites sur l'autre appareil s'appliquent ici aussi.
    // Restaurer une version d'archive, c'est revenir en arrière après une fausse
    // manœuvre : là, au contraire, on veut récupérer ce qui a été supprimé.
    const fusion = !ts;
    let aSupprimer = 0;
    if (fusion) {
      try { aSupprimer = await DB.compterSuppressions(data); } catch (e) { aSupprimer = 0; }
    }
    const question = fusion
      ? `Restaurer ${n} enregistrement(s) ?\n\nIls seront fusionnés avec ce qui est déjà sur l’appareil.`
        + (aSupprimer ? `\n\n⚠️ ${aSupprimer} enregistrement(s) supprimé(s) depuis un autre appareil seront aussi retirés d’ici. C’est définitif.` : '')
      : `Revenir à cette version antérieure ?\n\n${n} enregistrement(s) seront remis en place, y compris ceux supprimés depuis. Rien ne sera effacé.`;
    if (!confirm(question)) return;

    try {
      const bilan = await DB.importAll(data, { suppressions: fusion });
      localStorage.removeItem('cloud_sig');       // la base a changé : prochain envoi réel
      let msg = 'Restauré : ' + bilan.importes + ' enregistrement(s)';
      if (bilan.supprimes) msg += ' · ' + bilan.supprimes + ' retiré(s)';
      if (bilan.ignores) msg += ' · ' + bilan.ignores + ' ignoré(s)';
      toast(msg + ' ✓');
      refreshView();
    } catch (e) {
      console.error('restore import', e);
      toast('Erreur pendant l’écriture locale');
    }
  },

  auto() {
    if (WORKER_URL && this.pass && Date.now() - this.lastBackup > 24 * 3600 * 1000) setTimeout(() => this.backup(true), 5000);
  }
};

// --- Sauvegarde automatique déclenchée par toute écriture ---
Cloud.pending = false;
Cloud.timer = null;
Cloud.essais = 0;
Cloud.enCours = false;

Cloud.schedule = function (delai) {
  if (!WORKER_URL) return;
  if (!this.pass) {
    // Phrase secrète absente. Si le cloud a déjà servi sur cet appareil, c'est une
    // anomalie (localStorage purgé par iOS) : on la signale au lieu de ne rien faire.
    if (this.lastBackup) { this.derniereErreur = 'Phrase secrète perdue — à ressaisir'; cloudBadge('absent'); }
    return;
  }
  this.pending = true;
  cloudBadge('en attente');
  clearTimeout(this.timer);
  this.timer = setTimeout(() => this.envoyer(), delai || 3500);
};

Cloud._debutEnvoi = 0;
Cloud.envoyer = async function () {
  // verrou daté : si l'app a été gelée en plein envoi, on ne reste pas bloqué à vie
  if (this.enCours && Date.now() - this._debutEnvoi < 120000) return;
  this.enCours = true; this._debutEnvoi = Date.now();
  clearTimeout(this.timer);
  cloudBadge('envoi');
  let ok = false;
  try { ok = await this.backup(true); } finally { this.enCours = false; }
  this.pending = !ok;
  cloudBadge(ok ? 'ok' : 'erreur');
  if (ok) { this.essais = 0; return; }
  // Nouvelle tentative avec un délai croissant (1, 2, 4, 8, 15 min) au lieu
  // d'un rappel toutes les minutes qui resérialisait toute la base à chaque fois.
  this.essais = Math.min(this.essais + 1, 5);
  if (this.essais < 5 || navigator.onLine) {
    this.schedule(Math.min(60000 * Math.pow(2, this.essais - 1), 15 * 60000));
  }
};

// Envoi immédiat quand l'app passe en arrière-plan : sur iPhone, la page est gelée
// quelques secondes après, et la sauvegarde en attente était tout simplement perdue.
Cloud.flush = function () {
  if (!this.pending || !WORKER_URL || !this.pass || !navigator.onLine) return;
  clearTimeout(this.timer);
  this.envoyer();
};
document.addEventListener('visibilitychange', () => { if (document.hidden) Cloud.flush(); });
window.addEventListener('pagehide', () => Cloud.flush());
// Retour du réseau : on rattrape tout de suite au lieu d'attendre le prochain essai
window.addEventListener('online', () => { if (Cloud.pending) { Cloud.essais = 0; Cloud.schedule(1500); } });

// petit témoin discret dans la barre du haut
function cloudBadge(etat) {
  const el = document.getElementById('cloud-state');
  if (!el) return;
  const t = { 'en attente': '☁︎', 'envoi': '☁︎…', 'ok': '☁︎✓', 'erreur': '☁︎!', 'absent': '☁︎✕' }[etat] || '';
  el.textContent = t;
  el.className = 'cloud-state ' + (etat === 'erreur' || etat === 'absent' ? 'err' : etat === 'ok' ? 'ok' : 'wait');
  el.hidden = false;
  el.title = etat === 'absent' ? 'Sauvegarde cloud non configurée' : (Cloud.derniereErreur || '');
  el.onclick = () => {
    if (etat === 'erreur' || etat === 'absent') { switchTab('settings'); settingsPage = 'data'; renderSettings(); }
  };
  if (etat === 'ok') setTimeout(() => { el.hidden = true; }, 2500);
}

// ====== Annulation des 5 dernières actions ======
const Undo = {
  pile: [],
  // Pendant un traitement par lot, on n'empile pas chaque écriture : la pile ne
  // garde que 5 entrées et serait noyée. Le lot pose UNE entrée qui l'annule en bloc.
  silence: false,
  libelles: { students: 'élève', lessons: 'séance', payments: 'paiement', notes: 'note', invoices: 'document', library: 'morceau' },
  ajouter(libelle, inverse) {
    this.pile.push({ libelle, inverse });
    if (this.pile.length > 5) this.pile.shift();
    this.maj();
  },
  maj() {
    const b = document.getElementById('topbar-undo');
    if (b) { b.hidden = this.pile.length === 0; b.title = this.pile.length ? 'Annuler : ' + this.pile[this.pile.length - 1].libelle : ''; }
  },
  async annuler() {
    const action = this.pile.pop();
    if (!action) return;
    try {
      await action.inverse();
      toast('Annulé : ' + action.libelle);
    } catch (e) { toast('Annulation impossible'); }
    this.maj();
    Cloud.schedule();
    refreshView();
  }
};

// On enrobe les écritures de la base : sauvegarde cloud + mémorisation pour l'annulation
(() => {
  const brut = { put: DB.put.bind(DB), del: DB.del.bind(DB), get: DB.get.bind(DB), setSetting: DB.setSetting.bind(DB), importAll: DB.importAll.bind(DB) };
  const sansHistorique = new Set(['settings']);

  DB.put = async function (store, obj) {
    let avant = null, existait = false;
    if (!sansHistorique.has(store) && obj && obj.id) {
      avant = await brut.get(store, obj.id);
      existait = !!avant;
    }
    const r = await brut.put(store, obj);
    if (!sansHistorique.has(store) && !Undo.silence) {
      const quoi = Undo.libelles[store] || 'élément';
      if (existait) Undo.ajouter('modification ' + quoi, () => brut.put(store, avant));
      else Undo.ajouter('ajout ' + quoi, () => brut.del(store, r.id));
    }
    Cloud.schedule();
    return r;
  };

  DB.del = async function (store, id) {
    const avant = sansHistorique.has(store) ? null : await brut.get(store, id);
    const r = await brut.del(store, id);
    if (avant && !Undo.silence) Undo.ajouter('suppression ' + (Undo.libelles[store] || 'élément'), () => brut.put(store, avant));
    Cloud.schedule();
    return r;
  };

  DB.setSetting = async function (...a) { const r = await brut.setSetting(...a); Cloud.schedule(); return r; };
  DB.importAll = async function (...a) { const r = await brut.importAll(...a); Cloud.schedule(); return r; };
})();

// ====== Utilitaires métier ======
async function lessonsOf(studentId) {
  const ls = await DB.byStudent('lessons', studentId);
  return ls.sort((a, b) => new Date(a.date) - new Date(b.date));
}
function addMonths(d, m) { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; }

// État des paiements + validité des forfaits
// Marque chaque cours décomptable comme payé ou non, dans l'ordre chronologique.
// Chaque paiement crédite un capital d'heures que les cours suivants consomment.
// inclureAttente : prend aussi en compte les cours passés non encore validés,
// pour pouvoir afficher leur couverture à titre prévisionnel dans la fiche.
async function coverageMap(student, inclureAttente) {
  const retenu = l => inclureAttente ? (estValide(l) || enAttente(l)) : estValide(l);
  const seances = (await lessonsOf(student.id))
    .filter(l => (l.kind || 'cours') === 'cours' && l.paid !== false && !estCollectif(l) && retenu(l))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const tous = (await DB.byStudent('payments', student.id)).sort((a, b) => new Date(a.date) - new Date(b.date));

  // Un paiement ordinaire ne couvre que les cours POSTÉRIEURS à sa date : un
  // chèque encaissé aujourd'hui ne rattrapait donc jamais les cours déjà
  // donnés et non réglés. Les paiements marqués « 1er cours impayé » servent
  // précisément à cela : ils ne s'appliquent pas à leur date, mais au plus
  // ancien cours encore découvert.
  const chrono = tous.filter(p => p.validityFrom !== 'unpaid');
  const rattrapage = tous.filter(p => p.validityFrom === 'unpaid');

  const map = {};
  const premierCouvert = {};        // paiement de rattrapage → date du 1er cours couvert
  let credit = 0, ip = 0, ir = 0;
  for (const l of seances) {
    while (ip < chrono.length && new Date(chrono[ip].date) <= new Date(l.date)) {
      credit += paiementMinutes(chrono[ip]); ip++;
    }
    const besoin = l.duration || 60;
    while (credit < besoin && ir < rattrapage.length) {
      if (!premierCouvert[rattrapage[ir].id]) premierCouvert[rattrapage[ir].id] = l.date;
      credit += paiementMinutes(rattrapage[ir]); ir++;
    }
    if (credit >= besoin) { map[l.id] = true; credit -= besoin; }
    else map[l.id] = false;
  }
  // ce qui n'a pas encore servi reste disponible
  while (ir < rattrapage.length) { credit += paiementMinutes(rattrapage[ir]); ir++; }
  while (ip < chrono.length) { credit += paiementMinutes(chrono[ip]); ip++; }
  return { map, credit, premierCouvert };
}

async function paymentStatus(student) {
  const seances = (await lessonsOf(student.id)).filter(l => (l.kind || 'cours') === 'cours');
  const payments = (await DB.byStudent('payments', student.id)).sort((a, b) => new Date(b.date) - new Date(a.date));
  const now = Date.now();

  // les cours collectifs et les cours offerts ne consomment pas le forfait
  const decomptables = seances.filter(l => l.paid !== false && !estCollectif(l));
  const faits = decomptables.filter(l => new Date(l.date) <= now && estValide(l));   // en attente = pas encore décompté
  const dureeTotale = l => l.duration || 60;

  const last = payments[0];
  const aucuneActivite = seances.length === 0 && payments.length === 0;

  if (!last) {
    const dus = faits.reduce((a, l) => a + dureeTotale(l), 0);
    return { last: null, due: dus > 0, remainingMin: -dus, expiry: null, expired: false, aucuneActivite };
  }

  // Un paiement de rattrapage couvre des cours ANTÉRIEURS à sa date : le solde
  // ne peut pas se déduire des seuls cours qui le suivent. On s'appuie alors
  // sur la répartition réelle, qui fait foi.
  const rattrapage = last.validityFrom === 'unpaid';
  let remainingMin, premierCouvert = null;
  if (rattrapage) {
    const c = await coverageMap(student);
    remainingMin = c.credit;
    premierCouvert = c.premierCouvert[last.id] || null;
  } else {
    const consomme = faits.filter(l => new Date(l.date) > new Date(last.date)).reduce((a, l) => a + dureeTotale(l), 0);
    remainingMin = paiementMinutes(last) - consomme;
  }

  let expiry = null;
  const mois = last.validityMonths || 0;
  if (mois) {
    if (last.validityFrom === 'purchase') expiry = addMonths(last.date, mois);
    else if (rattrapage) expiry = addMonths(premierCouvert || last.date, mois);
    else {
      const premier = decomptables.find(l => new Date(l.date) > new Date(last.date));
      expiry = premier ? addMonths(premier.date, mois) : null;
    }
  }
  const expired = expiry ? Date.now() > expiry.getTime() : false;
  return { last, due: remainingMin <= 0 || expired, remainingMin, expiry, expired, aucuneActivite, notStarted: mois && !expiry };
}

// ====== Navigation ======
let currentTab = 'agenda';
let currentStudent = null;   // fiche élève affichée, pour y revenir après modification
// Avec plusieurs centaines de cours, tout afficher d'un coup crée autant de
// cartes dans la page : le téléphone peine et chauffe. On n'en pose qu'une
// tranche, le reste à la demande.
let limiteFiche = 25;        // cours passés affichés dans une fiche élève
let limiteHeures = 60;       // séances affichées dans le détail des heures
let studentQuery = '';       // texte saisi dans la recherche d'élèves

// Rafraîchit l'écran réellement affiché (et non l'onglet en général)
function refreshView() {
  if (currentTab === 'students' && currentStudent) return renderStudentDetail(currentStudent);
  return TABS[currentTab].render();
}
const TABS = {
  agenda: { title: 'Agenda', render: renderAgenda, action: () => sheetLesson() },
  students: { title: 'Élèves', render: renderStudents, action: () => sheetStudent() },
  hours: { title: 'Heures effectuées', render: renderHours, action: () => sheetLesson(null, null, 'repetition') },
  billing: { title: 'Factures & devis', render: renderBilling, action: () => sheetInvoice() },
  library: { title: 'Chants & cours', render: renderLibrary, action: () => sheetPiece() },
  settings: { title: 'Réglages', render: renderSettings, action: null }
};
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
function switchTab(tab) {
  if (tab !== 'settings') settingsPage = null;
  if (tab !== 'students') { currentStudent = null; studentQuery = ''; }
  if (tab !== 'hours') hoursQuery = '';
  limiteFiche = 25; limiteHeures = 60;
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const t = TABS[tab];
  $('#page-title').textContent = t.title;
  const act = $('#topbar-action');
  act.hidden = !t.action; act.onclick = t.action;
  Undo.maj();
  t.render();
}

// ====== AGENDA ======
// Événements Google que l'on ne veut pas voir (ils restent intacts dans Google Agenda)
let ignores = new Set();
async function chargerIgnores() {
  ignores = new Set(await DB.getSetting('gcalIgnores', []));
}
async function ignorer(id) {
  ignores.add(id);
  await DB.setSetting('gcalIgnores', [...ignores]);
}
async function reafficherIgnores() {
  ignores = new Set();
  await DB.setSetting('gcalIgnores', []);
}

let gcalCache = [];
let agendaView = 'list';          // list | week | month
let agendaAnchor = new Date();    // date de référence pour les vues semaine/mois
let selectedDay = null;

// Numéro de semaine ISO 8601
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 864e5 + 1) / 7);
}
function mondayOf(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

// Toutes les entrées (séances + événements Google non rattachés)
async function agendaItems() {
  const lessons = await DB.all('lessons');
  const linked = new Set(lessons.map(l => l.gcalEventId).filter(Boolean));
  const occupes = creneauxGoogle(lessons);
  const students = Object.fromEntries((await DB.all('students')).map(s => [s.id, s]));
  const items = lessons.map(l => ({
    date: l.date, lesson: l, kind: l.kind || 'cours',
    label: (students[l.studentId] ? students[l.studentId].name : (l.title || KINDS[l.kind || 'cours'].label))
  }));
  for (const e of evenementsAffichables()) {
    if (linked.has(e.id) || ignores.has(e.id)) continue;
    // même créneau qu'un cours déjà rattaché : c'est le même, avec un nouvel identifiant
    if (creneauPris(occupes, gcDebut(e))) continue;
    items.push({ date: gcDebut(e), gcal: e, kind: 'gcal', label: e.summary || '(sans titre)' });
  }
  return items.sort((a, b) => new Date(a.date) - new Date(b.date));
}

function itemCard(it) {
  if (it.gcal) return `<div class="swipe"><button class="swipe-del ignorer" data-ignore="${it.gcal.id}">Ignorer</button>
      <div class="card tappable row swipe-item" data-gcal="${it.gcal.id}">
      <div class="lesson-time">${gcJournee(it.gcal) ? 'journée' : fmtTime(it.date)}</div>
      <div class="grow"><div class="title">${esc(it.label)}</div>
      <div class="sub"><span class="gcal-dot">●</span> Google · toucher pour rattacher</div></div>
      <div class="chev">›</div></div></div>`;
  const l = it.lesson, k = KINDS[it.kind];
  return `<div class="swipe"><button class="swipe-del" data-del-lesson="${l.id}">Supprimer</button>
    <div class="card tappable row swipe-item" data-lesson="${l.id}">
      <div class="lesson-time">${fmtTime(it.date)}</div>
      <div class="grow"><div class="title">${k.icon} ${esc(it.label)}</div>
      <div class="sub">${esc(l.type || k.label)} · ${l.duration || 60} min${l.lieu === 'domicile' ? ' · à domicile' : ''} ${l.paid === false ? '· <span style="color:var(--gold)">offert</span>' : ''} ${l.gcalEventId ? '<span class="gcal-dot">● Google</span>' : ''}</div></div>
      <div class="chev">›</div></div></div>`;
}

async function renderAgenda() {
  const items = await agendaItems();
  // événements Google passés qui ne sont rattachés à aucune séance
  const debutJour = new Date(new Date().toDateString());
  const gPast = items.filter(i => i.gcal && new Date(i.date) < debutJour).map(i => i.gcal);
  const isToday = agendaView === 'list' ||
    (agendaView === 'week' && mondayOf(agendaAnchor).getTime() === mondayOf(new Date()).getTime()) ||
    (agendaView === 'month' && agendaAnchor.getMonth() === new Date().getMonth() && agendaAnchor.getFullYear() === new Date().getFullYear());

  let html = `<div class="seg">
      <button data-view="list" class="${agendaView === 'list' ? 'on' : ''}">Liste</button>
      <button data-view="week" class="${agendaView === 'week' ? 'on' : ''}">Semaine</button>
      <button data-view="month" class="${agendaView === 'month' ? 'on' : ''}">Mois</button>
    </div>`;

  if (agendaView !== 'list') {
    const lab = agendaView === 'week'
      ? `Semaine ${isoWeek(mondayOf(agendaAnchor))} · ${mondayOf(agendaAnchor).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} — ${new Date(mondayOf(agendaAnchor).getTime() + 6 * 864e5).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`
      : agendaAnchor.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    html += `<div class="cal-nav">
        <button class="nav-btn" data-nav="-1">‹</button>
        <div class="cal-label">${esc(lab)}</div>
        <button class="nav-btn" data-nav="1">›</button>
      </div>`;
  }
  if (!isToday) html += `<button class="btn gold" id="btn-today" style="margin-top:0">📍 Aujourd\u2019hui</button>`;

  const aValider = (await DB.all('lessons')).filter(enAttente);
  if (aValider.length) html += `<div class="card accent tappable" id="a-valider">
      <div class="title">✓ ${aValider.length} cours en attente de validation</div>
      <div class="sub">Passés mais pas encore confirmés : ils ne sont comptés ni en heures ni sur les forfaits.</div></div>`;

  if (GC.connected) {
    // L'app ne disait rien quand l'autorisation Google avait expiré : elle affichait
    // « Échec de la synchro » et l'agenda restait figé sans qu'on sache pourquoi.
    if (GC.aReconnecter) html += `<div class="card accent">
        <div class="title">⚠️ Autorisation Google expirée</div>
        <div class="sub">Google a révoqué l’accès (cela arrive tous les 7 jours tant que l’application Google est en mode « Test »). Les événements affichés datent de la dernière synchro.</div>
        <button class="btn" id="btn-gc-relink">Reconnecter Google Agenda</button></div>`;
    html += `<button class="btn secondary" id="btn-sync">🔄 Synchroniser Google Agenda</button>`;
    if (gPast.length) html += `<div class="card accent tappable" id="past-import" style="margin-top:12px">
        <div class="title">📥 ${gPast.length} événement${gPast.length > 1 ? 's' : ''} passé${gPast.length > 1 ? 's' : ''} à rattacher</div>
        <div class="sub">Toucher pour les affecter à un élève ou les compter en heures.</div></div>`;
  } else if (WORKER_URL) {
    html += `<div class="card"><div class="sub">Google Agenda non connecté.</div><button class="btn secondary" id="btn-gc-connect">Connecter Google Agenda</button></div>`;
  }

  html += agendaView === 'list' ? viewList(items) : agendaView === 'week' ? viewWeek(items) : viewMonth(items);
  view.innerHTML = html;

  view.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
    agendaView = b.dataset.view; selectedDay = null; renderAgenda();
  });
  view.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => {
    const step = +b.dataset.nav;
    if (agendaView === 'week') agendaAnchor = new Date(agendaAnchor.getTime() + step * 7 * 864e5);
    else agendaAnchor = new Date(agendaAnchor.getFullYear(), agendaAnchor.getMonth() + step, 1);
    selectedDay = null; renderAgenda();
  });
  const today = $('#btn-today');
  if (today) today.onclick = () => { agendaAnchor = new Date(); selectedDay = new Date(); renderAgenda(); };
  view.querySelectorAll('[data-day]').forEach(el => el.onclick = () => {
    selectedDay = new Date(el.dataset.day); renderAgenda();
  });

  const sync = $('#btn-sync');
  if (sync) sync.onclick = async () => {
    sync.disabled = true; sync.textContent = 'Synchronisation…';
    await GC.synchroniser();
    renderAgenda();
  };
  const relink = $('#btn-gc-relink'); if (relink) relink.onclick = () => GC.connect();
  activerGlissement(view);
  const conn = $('#btn-gc-connect'); if (conn) conn.onclick = () => GC.connect();
  const av = $('#a-valider');
  if (av) av.onclick = () => sheetAValider(aValider);
  const pastBtn = $('#past-import');
  if (pastBtn) pastBtn.onclick = () => sheetGroupes(gPast);   // uniquement ceux qui ne sont pas encore rattachés
}

// --- Vue liste (à venir) ---
function viewList(items) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const up = items.filter(i => new Date(i.date) >= today);
  if (!up.length) return `<div class="empty"><div class="big">🎶</div><div class="empty-title">Aucun cours à venir</div>Touche ＋ pour en ajouter.</div>`;
  let html = '', cur = '';
  for (const it of up) {
    const key = new Date(it.date).toDateString();
    if (key !== cur) {
      cur = key;
      html += `<div class="day-head">${fmtDate(it.date)} ${sameDay(it.date, new Date()) ? '<span class="today">· aujourd\u2019hui</span>' : ''}</div>`;
    }
    html += itemCard(it);
  }
  return html;
}

// --- Vue semaine ---
function viewWeek(items) {
  const mon = mondayOf(agendaAnchor);
  let html = '<div class="week-list">';
  for (let i = 0; i < 7; i++) {
    const day = new Date(mon.getTime() + i * 864e5);
    const dayItems = items.filter(x => sameDay(x.date, day));
    const isNow = sameDay(day, new Date());
    html += `<div class="week-day ${isNow ? 'now' : ''}">
        <div class="week-head">
          <span class="week-dow">${day.toLocaleDateString('fr-FR', { weekday: 'long' })}</span>
          <span class="week-num">${day.getDate()}/${day.getMonth() + 1}</span>
        </div>
        ${dayItems.length ? dayItems.map(itemCard).join('') : '<div class="week-empty">—</div>'}
      </div>`;
  }
  return html + '</div>';
}

// --- Vue mois ---
function viewMonth(items) {
  const y = agendaAnchor.getFullYear(), m = agendaAnchor.getMonth();
  const first = new Date(y, m, 1);
  const startGrid = mondayOf(first);
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) days.push(new Date(startGrid.getTime() + (w * 7 + d) * 864e5));
    weeks.push(days);
    if (days[6].getMonth() !== m && days[6] > first) break;
  }

  let html = `<div class="cal-grid">
    <div class="cal-corner">S</div>
    ${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map(d => `<div class="cal-dow">${d}</div>`).join('')}`;
  for (const days of weeks) {
    html += `<div class="cal-week">${isoWeek(days[0])}</div>`;
    for (const day of days) {
      const dayItems = items.filter(x => sameDay(x.date, day));
      const out = day.getMonth() !== m;
      const isNow = sameDay(day, new Date());
      const sel = selectedDay && sameDay(day, selectedDay);
      html += `<div class="cal-cell ${out ? 'out' : ''} ${isNow ? 'now' : ''} ${sel ? 'sel' : ''}" data-day="${day.toISOString()}">
          <span>${day.getDate()}</span>
          <div class="dots">${dayItems.slice(0, 3).map(i => `<i class="k-${i.kind}"></i>`).join('')}</div>
        </div>`;
    }
  }
  html += '</div>';

  const day = selectedDay || new Date();
  const dayItems = items.filter(x => sameDay(x.date, day));
  html += `<div class="day-head">${fmtDate(day)} ${sameDay(day, new Date()) ? '<span class="today">· aujourd\u2019hui</span>' : ''}</div>`;
  html += dayItems.length ? dayItems.map(itemCard).join('')
    : `<div class="sub" style="padding:8px 4px">Aucune séance ce jour-là.</div>`;
  return html;
}

// Glissement latéral pour révéler le bouton Supprimer
function activerGlissement(racine) {
  racine.querySelectorAll('.swipe-item').forEach(el => {
    if (el.dataset.swipeOn) return;
    el.dataset.swipeOn = '1';
    let x0 = 0, y0 = 0, dx = 0, actif = false;
    el.addEventListener('touchstart', e => {
      const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; dx = 0; actif = false;
      // on referme les autres
      racine.querySelectorAll('.swipe-item.ouvert').forEach(o => { if (o !== el) { o.classList.remove('ouvert'); o.style.transform = ''; } });
    }, { passive: true });
    el.addEventListener('touchmove', e => {
      const t = e.touches[0];
      const ex = t.clientX - x0, ey = t.clientY - y0;
      if (!actif && Math.abs(ex) > 12 && Math.abs(ex) > Math.abs(ey) * 1.6) {
        actif = true;
        el.parentElement.classList.add('glisse');   // on ne révèle le bouton qu'à ce moment
      }
      if (!actif) return;
      dx = Math.max(-96, Math.min(0, ex + (el.classList.contains('ouvert') ? -96 : 0)));
      el.style.transform = `translateX(${dx}px)`;
    }, { passive: true });
    el.addEventListener('touchend', () => {
      if (!actif) return;
      const ouvert = dx < -48;
      el.classList.toggle('ouvert', ouvert);
      el.style.transform = ouvert ? 'translateX(-96px)' : '';
      if (!ouvert) setTimeout(() => el.parentElement.classList.remove('glisse'), 240);
      if (ouvert) el.dataset.ignoreClic = '1';
      setTimeout(() => delete el.dataset.ignoreClic, 60);
    });
  });
}

// Délégation : fiable même après re-rendu
view.addEventListener('click', async e => {
  const ign = e.target.closest('[data-ignore]');
  if (ign) {
    await ignorer(ign.dataset.ignore);
    toast('Événement ignoré (conservé dans Google Agenda)');
    refreshView();
    return;
  }
  const supp = e.target.closest('[data-del-lesson]');
  if (supp) {
    const l = await DB.get('lessons', supp.dataset.delLesson);
    await DB.del('lessons', supp.dataset.delLesson);
    toast('Séance supprimée · touche ↺ pour annuler');
    refreshView();
    return;
  }
  const item = e.target.closest('.swipe-item');
  if (item && (item.dataset.ignoreClic || item.classList.contains('ouvert'))) {
    item.classList.remove('ouvert'); item.style.transform = '';
    setTimeout(() => item.parentElement.classList.remove('glisse'), 240);
    return;   // on referme au lieu d'ouvrir la fiche
  }
  const gEl = e.target.closest('[data-gcal]');
  if (gEl) {
    const ev = gcalCache.find(x => x.id === gEl.dataset.gcal);
    if (ev) sheetImportGcal(ev); else toast('Événement introuvable, resynchronise');
    return;
  }
  const lEl = e.target.closest('[data-lesson]');
  if (lEl) sheetLesson(lEl.dataset.lesson);
});

// Cours passés en attente de confirmation
async function sheetAValider(liste) {
  const eleves = Object.fromEntries((await DB.all('students')).map(s => [s.id, s]));
  openSheet(`<h3>Cours en attente</h3>
    <div class="sub" style="margin-bottom:12px">Valide les cours qui ont bien eu lieu. Ils rejoindront les cours effectués et seront décomptés du forfait.</div>
    ${liste.length > 40 ? `<div class="sub" style="margin-bottom:10px">Les 40 plus récents sont affichés. « Tout valider » porte bien sur les ${liste.length}.</div>` : ''}
    ${liste.slice().reverse().slice(0, 40).map(l => `<div class="card">
      <div class="row"><div class="lesson-time">${fmtDate(l.date)}<br><span class="sub">${fmtTime(l.date)}</span></div>
      <div class="grow"><div class="title">${esc(eleves[l.studentId] ? eleves[l.studentId].name : (l.title || KINDS[l.kind || 'cours'].label))}</div>
      <div class="sub">${esc(l.type || '')} · ${fmtHours(l.duration || 60)}</div></div></div>
      <div class="field-row" style="margin-top:10px">
        <button class="btn gold" style="margin:0" data-ok="${l.id}">✓ Valider</button>
        <button class="btn secondary" style="margin:0" data-edit="${l.id}">Modifier</button>
      </div></div>`).join('')}
    <button class="btn" id="tout-valider">Tout valider (${liste.length})</button>`);

  $('#sheet').querySelectorAll('[data-ok]').forEach(b => b.onclick = async () => {
    const l = await DB.get('lessons', b.dataset.ok);
    l.status = 'done'; await DB.put('lessons', l);
    const reste = liste.filter(x => x.id !== l.id);
    closeSheet(); toast('Cours validé ✓'); refreshView();
    if (reste.length) sheetAValider(reste);
  });
  $('#sheet').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => sheetLesson(b.dataset.edit));
  $('#tout-valider').onclick = async () => {
    for (const l of liste) { const x = await DB.get('lessons', l.id); if (x) { x.status = 'done'; await DB.put('lessons', x); } }
    closeSheet(); toast(liste.length + ' cours validés ✓'); refreshView();
  };
}

// ---- Rattachement groupé ----------------------------------------------------
// Avec plusieurs centaines d'événements, les traiter un par un est hors de
// portée. On les regroupe par intitulé : « Cecile » revient 30 fois, on choisit
// l'élève une seule fois et les 30 suivent.
const cleTitre = t => sansAccent(t || '').replace(/[^a-z0-9]+/g, ' ').trim();
// « Cours Léa » doit proposer de créer l'élève « Léa », pas « Cours Léa ».
const nomDepuisTitre = t => (t || '').replace(/^\s*(cours|s[ée]ance|chant)\s+(de\s+chant\s+)?/i, '').trim() || (t || '').trim();

function grouperEvenements(events) {
  const groupes = new Map();
  for (const e of events) {
    const k = cleTitre(e.summary) || '(sans titre)';
    if (!groupes.has(k)) groupes.set(k, { cle: k, titre: (e.summary || '(sans titre)').trim(), events: [] });
    groupes.get(k).events.push(e);
  }
  const liste = [...groupes.values()];
  for (const g of liste) {
    g.events.sort((a, b) => new Date(gcDebut(a)) - new Date(gcDebut(b)));
    g.debut = gcDebut(g.events[0]);
    g.fin = gcDebut(g.events[g.events.length - 1]);
  }
  return liste.sort((a, b) => b.events.length - a.events.length);
}

async function sheetGroupes(events) {
  const eleves = (await DB.all('students')).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const groupes = grouperEvenements(events);
  const { courseTypes } = await getConfig();

  openSheet(`<h3>Rattacher par intitulé</h3>
    <div class="sub" style="margin-bottom:12px">${events.length} événement(s) regroupés en ${groupes.length} intitulé(s).
      Choisis l\u2019élève une seule fois : tous les événements du même intitulé suivent.</div>
    <label class="switch"><input type="checkbox" id="g-done">
      <span class="track"></span>
      <span class="lbl">Marquer les cours passés comme déjà effectués<small>Décoché, ils partent en « à valider » dans la fiche de chaque élève. Coché, ils comptent immédiatement dans les heures et les forfaits.</small></span></label>
    ${groupes.map((g, i) => {
      const devine = eleveDeLEvenement(g.titre, eleves);
      return `<div class="card">
        <div class="row"><div class="grow"><div class="title">${esc(g.titre)}</div>
          <div class="sub">${g.events.length} séance(s) · du ${fmtDateFull(g.debut)} au ${fmtDateFull(g.fin)}</div></div>
          <span class="badge ghost">${g.events.length}</span></div>
        <label class="field" style="margin-top:10px"><span>Rattacher à</span>
          <select data-grp="${i}">
            <option value="">— laisser de côté —</option>
            <option value="__new">＋ Créer l\u2019élève « ${esc(nomDepuisTitre(g.titre))} »</option>
            ${eleves.map(e => `<option value="${e.id}" ${devine && devine.id === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
          </select></label>
        <button class="btn ghost" style="margin-top:6px" data-ign-grp="${i}">Ignorer cet intitulé</button>
      </div>`;
    }).join('')}
    <button class="btn" id="g-go">Rattacher les intitulés choisis</button>`);

  $('#sheet').querySelectorAll('[data-ign-grp]').forEach(b => b.onclick = async () => {
    const g = groupes[+b.dataset.ignGrp];
    if (!confirm(`Ignorer les ${g.events.length} séance(s) « ${g.titre} » ?\n\nElles restent intactes dans Google Agenda, mais l\u2019app cessera de les proposer.`)) return;
    for (const e of g.events) ignores.add(e.id);
    await DB.setSetting('gcalIgnores', [...ignores]);
    toast(g.events.length + ' séance(s) ignorée(s)');
    closeSheet(); refreshView();
  });

  $('#g-go').onclick = async () => {
    const choix = [];
    $('#sheet').querySelectorAll('[data-grp]').forEach(sel => {
      if (sel.value) choix.push({ groupe: groupes[+sel.dataset.grp], valeur: sel.value });
    });
    if (!choix.length) { toast('Aucun intitulé choisi'); return; }
    const marquerFait = $('#g-done').checked;
    const total = choix.reduce((n, c) => n + c.groupe.events.length, 0);
    if (!confirm(`Rattacher ${total} séance(s) réparties sur ${choix.length} intitulé(s) ?`)) return;

    const bouton = $('#g-go');
    bouton.disabled = true; bouton.textContent = 'Rattachement…';
    const bilan = await rattacherGroupes(choix, marquerFait, courseTypes);
    closeSheet();
    toast(`${bilan.crees} séance(s) rattachée(s)` + (bilan.lies ? ` · ${bilan.lies} rapprochée(s)` : '') + (bilan.eleves ? ` · ${bilan.eleves} élève(s) créé(s)` : ''));
    refreshView();
  };
}

// Applique les choix du rattachement groupé, avec les mêmes garde-fous que le
// rattachement automatique : pas de doublon, et une seule entrée d'annulation.
async function rattacherGroupes(choix, marquerFait, courseTypes) {
  const typeParDefaut = courseTypes[0] || 'Cours de chant individuel';
  const typeCollectif = courseTypes.find(t => /collectif/i.test(t));
  const lecons = await DB.all('lessons');
  // Un événement déjà rattaché ne doit jamais l'être une seconde fois : sans ce
  // garde-fou, relancer l'écran recréait tout en double.
  const dejaLies = new Set(lecons.map(l => l.gcalEventId).filter(Boolean));
  const PROXIMITE = 120 * 60000;
  const crees = [], lies = [], elevesCrees = [];

  Undo.silence = true;
  try {
    for (const { groupe, valeur } of choix) {
      let eleveId = valeur;
      if (valeur === '__new') {
        const nouvel = { id: DB.uid(), name: nomDepuisTitre(groupe.titre), lieu: 'ecole' };
        await DB.put('students', nouvel);
        elevesCrees.push(nouvel.id);
        eleveId = nouvel.id;
      }
      const eleve = await DB.get('students', eleveId);
      if (!eleve) continue;

      for (const ev of groupe.events) {
        if (dejaLies.has(ev.id)) continue;
        const debut = new Date(gcDebut(ev));
        if (isNaN(debut)) continue;
        const existant = lecons.find(l => l.studentId === eleveId
          && Math.abs(new Date(l.date) - debut) < PROXIMITE);
        if (existant) {
          dejaLies.add(ev.id);
          if (existant.gcalEventId === ev.id) continue;
          existant.gcalEventId = ev.id;
          await DB.put('lessons', existant);
          lies.push(existant.id);
          continue;
        }
        const fin = gcFin(ev);
        const duree = (!gcJournee(ev) && fin)
          ? Math.min(600, Math.max(15, Math.round((new Date(fin) - debut) / 60000))) : 60;
        const passe = debut <= new Date();
        const cours = {
          id: DB.uid(), kind: 'cours', studentId: eleveId, title: '',
          date: debut.toISOString(), duration: duree,
          type: (/collectif|^col\b/i.test(groupe.titre) && typeCollectif) ? typeCollectif : typeParDefaut,
          lieu: lieuDeCouleur(ev.colorId) || eleve.lieu || 'ecole',
          status: (passe && marquerFait) ? 'done' : 'planned',
          paid: true, fee: 0, note: ev.description || '',
          gcalEventId: ev.id, auto: true
        };
        await DB.put('lessons', cours);
        lecons.push(cours);
        dejaLies.add(ev.id);
        crees.push(cours.id);
      }
    }
  } finally { Undo.silence = false; }

  const total = crees.length + lies.length;
  if (total || elevesCrees.length) {
    Undo.ajouter(`rattachement de ${total} séance(s)`, async () => {
      Undo.silence = true;
      try {
        for (const id of crees) await DB.del('lessons', id);
        for (const id of lies) {
          const l = await DB.get('lessons', id);
          if (l) { delete l.gcalEventId; await DB.put('lessons', l); }
        }
        for (const id of elevesCrees) await DB.del('students', id);
      } finally { Undo.silence = false; }
    });
  }
  return { crees: crees.length, lies: lies.length, eleves: elevesCrees.length };
}

// Liste des événements Google passés non rattachés
function sheetPastList(events) {
  openSheet(`<h3>Événements passés à rattacher</h3>
    <div class="sub" style="margin-bottom:10px">Rattache-les pour les compter dans les heures effectuées et dans le profil des élèves.</div>
    ${events.slice().reverse().map(e => `<div class="swipe"><button class="swipe-del ignorer" data-ignore-p="${e.id}">Ignorer</button>
      <div class="card tappable row swipe-item" data-past="${e.id}">
      <div class="grow"><div class="title">${esc(e.summary || '(sans titre)')}</div>
      <div class="sub">${fmtDate(gcDebut(e))}${gcJournee(e) ? ' · journée' : ' · ' + fmtTime(gcDebut(e))}</div></div>
      <div class="chev">›</div></div></div>`).join('')}`);
  activerGlissement($('#sheet'));
  $('#sheet').querySelectorAll('[data-ignore-p]').forEach(b => b.onclick = async () => {
    await ignorer(b.dataset.ignoreP);
    toast('Événement ignoré');
    const restants = events.filter(x => !ignores.has(x.id));
    closeSheet(); refreshView();
    if (restants.length) sheetPastList(restants);
  });
  $('#sheet').querySelectorAll('[data-past]').forEach(el => el.onclick = () => {
    if (el.dataset.ignoreClic || el.classList.contains('ouvert')) {
      el.classList.remove('ouvert'); el.style.transform = '';
      setTimeout(() => el.parentElement.classList.remove('glisse'), 240);
      return;
    }
    const ev = events.find(x => x.id === el.dataset.past);
    if (ev) sheetImportGcal(ev);
  });
}

// Rattache automatiquement aux élèves les événements Google qui sont des cours.
// Deux conditions, toutes deux nécessaires :
//   - la COULEUR de l'événement est une de celles réservées aux cours (elle donne
//     aussi le lieu) : c'est ce qui distingue un cours d'un rendez-vous perso ;
//   - le titre désigne UN SEUL élève existant, sans ambiguïté.
// Les cours créés sont « en attente » : ils ne comptent ni dans les heures ni dans
// les forfaits tant qu'ils n'ont pas été validés depuis la fiche de l'élève.
// Ne restent « à rattacher » que les événements sans élève identifiable (nouveaux
// élèves) ou d'une autre couleur (séances qui ne sont pas des cours).
async function rattacherAuto() {
  if (localStorage.getItem('gc_auto') === '0') return null;
  if (!gcalCache.length) return null;

  const eleves = await DB.all('students');
  if (!eleves.length) return null;
  const lecons = await DB.all('lessons');
  const dejaLies = new Set(lecons.map(l => l.gcalEventId).filter(Boolean));
  const { courseTypes } = await getConfig();
  const typeParDefaut = courseTypes[0] || 'Cours de chant individuel';
  const typeCollectif = courseTypes.find(t => /collectif/i.test(t));

  // Un cours déjà saisi à la main pour cet élève, au même moment, ne doit pas être
  // dupliqué : on se contente de lui accrocher l'identifiant de l'événement Google.
  const PROXIMITE = 120 * 60000;
  // On ne réclame plus l'absence d'identifiant Google : un cours déjà rattaché
  // dont l'événement a changé d'identifiant doit être RÉUTILISÉ, pas dupliqué.
  const dejaPresent = (eleveId, debut) => lecons.find(l =>
    l.studentId === eleveId && Math.abs(new Date(l.date) - debut) < PROXIMITE);

  const crees = [], lies = [];
  Undo.silence = true;
  try {
    for (const ev of gcalCache) {
      if (dejaLies.has(ev.id) || ignores.has(ev.id)) continue;
      if (gcJournee(ev)) continue;                       // une journée entière n'est pas un cours

      const lieu = lieuDeCouleur(ev.colorId);
      if (!lieu) continue;                               // couleur non réservée aux cours

      const titre = ev.summary || '';
      const eleve = eleveDeLEvenement(titre, eleves);
      if (!eleve) continue;                              // nouvel élève, ou homonymes

      const debut = new Date(gcDebut(ev));
      if (isNaN(debut)) continue;

      const existant = dejaPresent(eleve.id, debut);
      if (existant) {                                    // rapprochement, pas de doublon
        dejaLies.add(ev.id);
        if (existant.gcalEventId === ev.id) continue;    // rien à changer
        existant.gcalEventId = ev.id;                    // identifiant renouvelé côté Google
        await DB.put('lessons', existant);
        lies.push(existant.id);
        continue;
      }

      const fin = gcFin(ev);
      const duree = fin ? Math.min(600, Math.max(15, Math.round((new Date(fin) - debut) / 60000))) : 60;
      const cours = {
        id: DB.uid(), kind: 'cours', studentId: eleve.id, title: '',
        date: debut.toISOString(), duration: duree,
        type: (/collectif/i.test(titre) && typeCollectif) ? typeCollectif : typeParDefaut,
        lieu,
        status: 'planned',                               // à confirmer depuis la fiche élève
        paid: true, fee: 0,
        note: ev.description || '',
        gcalEventId: ev.id, auto: true
      };
      await DB.put('lessons', cours);
      lecons.push(cours);
      dejaLies.add(ev.id);
      crees.push(cours.id);
    }
  } finally { Undo.silence = false; }

  if (!crees.length && !lies.length) return null;
  const total = crees.length + lies.length;
  Undo.ajouter(`rattachement automatique de ${total} cours`, async () => {
    Undo.silence = true;
    try {
      for (const id of crees) await DB.del('lessons', id);
      for (const id of lies) {
        const l = await DB.get('lessons', id);
        if (l) { delete l.gcalEventId; await DB.put('lessons', l); }
      }
    } finally { Undo.silence = false; }
  });
  return { crees: crees.length, lies: lies.length };
}

// Convertir un événement Google en séance
async function sheetImportGcal(ev) {
  const students = await DB.all('students');
  const { courseTypes } = await getConfig();
  const start = new Date(gcDebut(ev));
  const fin = gcFin(ev);
  // un événement « journée entière » n'a pas de durée exploitable : 1 h par défaut
  const end = (!gcJournee(ev) && fin) ? new Date(fin) : new Date(start.getTime() + 3600000);
  const dur = Math.min(600, Math.max(15, Math.round((end - start) / 60000)));
  const t = (ev.summary || '').toLowerCase();
  const guess = students.find(s => t.includes(s.name.toLowerCase().split(' ')[0]));
  const kindGuess = /rep|répét|repet/.test(t) ? 'repetition' : /concert|spectacle|scène/.test(t) ? 'concert' : 'cours';

  openSheet(`
    <h3>Rattacher cet événement</h3>
    <div class="card"><div class="title">${esc(ev.summary || '(sans titre)')}</div>
      <div class="sub">${fmtDate(start)} · ${gcJournee(ev) ? 'journée entière' : fmtTime(start)} — ${fmtHours(dur)}</div></div>
    <label class="field"><span>Nature</span>
      <select id="f-kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${k === kindGuess ? 'selected' : ''}>${v.icon} ${v.label}</option>`).join('')}</select></label>
    <div id="student-box">
      <label class="field"><span>Élève</span>
        <select id="f-student">${students.map(s => `<option value="${s.id}" ${guess && guess.id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        ${students.length ? '' : '<option value="">(aucun élève créé)</option>'}</select></label>
      <label class="field"><span>Type de cours</span>
        <select id="f-type">${courseTypes.map(x => `<option>${esc(x)}</option>`).join('')}</select></label>
    </div>
    <label class="switch">
      <input type="checkbox" id="f-paid" checked>
      <span class="track"></span>
      <span class="lbl">Séance payante<small id="paid-hint"></small></span>
    </label>
    <div id="fee-box" hidden><label class="field"><span>Cachet perçu</span><input type="number" id="f-fee" value="0"></label></div>
    <label class="switch">
      <input type="checkbox" id="f-done" ${start <= new Date() ? 'checked' : ''}>
      <span class="track"></span>
      <span class="lbl">Séance confirmée<small>Décochée, elle passera en « cours en attente » à valider</small></span>
    </label>
    <button class="btn" id="f-import">Rattacher</button>
  `);
  const refresh = () => {
    const k = $('#f-kind').value;
    const payant = $('#f-paid').checked;
    $('#student-box').hidden = k !== 'cours';
    $('#fee-box').hidden = !(payant && k !== 'cours');
    $('#paid-hint').textContent = payant ? 'Comptée comme rémunérée' : 'Non rémunérée (répétition, essai…)';
  };
  $('#f-kind').onchange = refresh;
  $('#f-paid').onchange = refresh;
  refresh();

  $('#f-import').onclick = async () => {
    const kind = $('#f-kind').value;
    if (kind === 'cours' && !students.length) { toast('Crée d\u2019abord un élève'); return; }
    await DB.put('lessons', {
      id: DB.uid(), kind,
      studentId: kind === 'cours' ? $('#f-student').value : '',
      title: kind === 'cours' ? '' : (ev.summary || KINDS[kind].label),
      date: start.toISOString(), duration: dur,
      type: kind === 'cours' ? $('#f-type').value : KINDS[kind].label,
      status: $('#f-done').checked ? 'done' : 'planned',
      paid: $('#f-paid').checked,
      fee: ($('#f-paid').checked && kind !== 'cours') ? (+$('#f-fee').value || 0) : 0,
      note: ev.description || '', gcalEventId: ev.id
    });
    gcalCache = gcalCache.filter(x => x.id !== ev.id);
    closeSheet(); toast('Rattaché ✓'); refreshView();
  };
}

// Créer / modifier une séance
async function sheetLesson(id, presetStudent, presetKind, presetType) {
  const students = await DB.all('students');
  const { courseTypes } = await getConfig();
  // pré-sélection d'un type (ex. « collectif » depuis la fiche élève)
  const typeVoulu = presetType ? (courseTypes.find(t => new RegExp(presetType, 'i').test(t)) || presetType) : null;
  const l = id ? await DB.get('lessons', id) : null;
  const kind = l ? (l.kind || 'cours') : (presetKind || 'cours');
  const d = l ? new Date(l.date) : (() => { const x = new Date(); x.setMinutes(0, 0, 0); x.setHours(x.getHours() + 1); return x; })();

  openSheet(`
    <h3>${l ? 'Modifier' : 'Nouvelle séance'}</h3>
    <label class="field"><span>Nature</span>
      <select id="f-kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${v.icon} ${v.label}</option>`).join('')}</select></label>
    <div id="student-box">
      <label class="field"><span>Élève</span>
        <select id="f-student">${students.map(s => `<option value="${s.id}" ${(l && l.studentId === s.id) || presetStudent === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Type de cours</span>
        <select id="f-type">${courseTypes.map(t => `<option ${(l && l.type === t) || (!l && typeVoulu === t) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <label class="field" id="lieu-box"><span>Lieu du cours</span>
        <select id="f-lieu">${Object.entries(LIEUX).map(([v, t]) => `<option value="${v}" ${l && l.lieu === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    </div>
    <div id="title-box" hidden><label class="field"><span>Intitulé</span><input id="f-title" value="${esc(l ? l.title : '')}" placeholder="Répétition, concert…"></label></div>
    <div class="field-row">
      <label class="field"><span>Date</span><input type="date" id="f-date" value="${d.toISOString().slice(0, 10)}"></label>
      <label class="field"><span>Heure</span><input type="time" id="f-time" value="${d.toTimeString().slice(0, 5)}"></label>
    </div>
    <label class="field"><span>Durée (min)</span><input type="number" id="f-dur" value="${l ? l.duration : 60}"></label>
    <label class="switch" id="paid-box">
      <input type="checkbox" id="f-paid" ${!l || l.paid !== false ? 'checked' : ''}>
      <span class="track"></span>
      <span class="lbl">Séance payante<small id="paid-hint"></small></span>
    </label>
    <label class="field" id="fee-box"><span>Cachet perçu</span><input type="number" id="f-fee" value="${l ? (l.fee || 0) : 0}"></label>
    <label class="field"><span>Note</span><input id="f-note" value="${esc(l ? l.note : '')}"></label>
    <button class="btn" id="f-save">${l ? 'Enregistrer' : 'Ajouter'}</button>
    ${l ? '<button class="btn danger" id="f-del">Supprimer</button>' : ''}
  `);
  // le lieu suit la préférence de l'élève, sauf en collectif (toujours à l'école)
  const majLieu = async () => {
    const collectif = /collectif/i.test($('#f-type').value || '');
    $('#lieu-box').style.display = ($('#f-kind').value === 'cours' && !collectif) ? '' : 'none';
    if (collectif) { $('#f-lieu').value = 'ecole'; return; }
    if (!l) {
      const el = await DB.get('students', $('#f-student').value);
      if (el && el.lieu) $('#f-lieu').value = el.lieu;
    }
  };

  const refresh = () => {
    const k = $('#f-kind').value;
    const perso = k === 'perso';
    if (perso) $('#f-paid').checked = false;          // le perso n'est jamais payant
    const payant = $('#f-paid').checked;
    $('#paid-box').hidden = perso;
    $('#student-box').hidden = k !== 'cours';
    $('#title-box').hidden = k === 'cours';
    majLieu();
    // le cachet ne concerne que les séances payantes hors cours (concert, prestation…)
    $('#fee-box').style.display = (payant && k !== 'cours') ? '' : 'none';
    $('#paid-hint').textContent = payant
      ? (k === 'cours' ? 'Décompte du temps sur le forfait de l\u2019élève' : 'Comptée comme rémunérée')
      : (k === 'cours' ? 'Cours offert : ne décompte rien du forfait' : 'Non rémunérée (répétition, essai…)');
  };
  $('#f-kind').onchange = refresh;
  $('#f-paid').onchange = refresh;
  $('#f-type').onchange = majLieu;
  $('#f-student').onchange = majLieu;
  refresh();

  $('#f-save').onclick = async () => {
    const k = $('#f-kind').value;
    if (k === 'cours' && !students.length) { toast('Crée d\u2019abord un élève'); return; }
    const item = l || { id: DB.uid() };
    item.kind = k;
    item.studentId = k === 'cours' ? $('#f-student').value : '';
    item.title = k === 'cours' ? '' : ($('#f-title').value || KINDS[k].label);
    item.date = new Date($('#f-date').value + 'T' + $('#f-time').value).toISOString();
    item.type = k === 'cours' ? $('#f-type').value : KINDS[k].label;
    item.duration = +$('#f-dur').value || 60;
    if (!l) item.status = new Date(item.date) > Date.now() ? 'planned' : 'done';
    item.lieu = k === 'cours' ? (/collectif/i.test($('#f-type').value) ? 'ecole' : $('#f-lieu').value) : '';
    item.paid = k === 'perso' ? false : $('#f-paid').checked;
    item.fee = (item.paid && k !== 'cours') ? (+$('#f-fee').value || 0) : 0;
    item.note = $('#f-note').value;
    await DB.put('lessons', item);   // l'app n'écrit jamais dans Google Agenda
    closeSheet(); toast('Enregistré ✓'); refreshView();
  };
  if (l) $('#f-del').onclick = async () => {
    await DB.del('lessons', l.id);   // l'événement Google d'origine est conservé intact
    closeSheet(); toast('Supprimé'); refreshView();
  };
}

// ====== HEURES EFFECTUÉES ======
let hoursRange = 'month';
let hoursQuery = '';
async function renderHours() {
  const all = (await DB.all('lessons'))
    .filter(l => new Date(l.date) <= Date.now() && estTravail(l) && estValide(l))   // ni le perso ni les séances non validées
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  const students = Object.fromEntries((await DB.all('students')).map(s => [s.id, s]));

  const now = new Date();
  const startWeek = new Date(now); const dow = (startWeek.getDay() + 6) % 7;
  startWeek.setDate(startWeek.getDate() - dow); startWeek.setHours(0, 0, 0, 0);
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const mins = arr => arr.reduce((s, l) => s + (l.duration || 60), 0);
  const weekMin = mins(all.filter(l => new Date(l.date) >= startWeek));
  const monthMin = mins(all.filter(l => new Date(l.date) >= startMonth));

  // moyennes depuis la première séance enregistrée
  let avgWeek = 0, avgMonth = 0;
  if (all.length) {
    const first = new Date(all[all.length - 1].date);
    const weeks = Math.max(1, (now - first) / (7 * 864e5));
    const months = Math.max(1, (now.getFullYear() - first.getFullYear()) * 12 + now.getMonth() - first.getMonth() + 1);
    avgWeek = mins(all) / weeks; avgMonth = mins(all) / months;
  }

  const inRange = hoursRange === 'week' ? all.filter(l => new Date(l.date) >= startWeek)
    : hoursRange === 'month' ? all.filter(l => new Date(l.date) >= startMonth) : all;
  const byKind = {};
  for (const l of inRange) { const k = l.kind || 'cours'; byKind[k] = (byKind[k] || 0) + (l.duration || 60); }
  const revenue = inRange.reduce((s, l) => s + (l.fee || 0), 0);
  const offertMin = mins(inRange.filter(l => l.paid === false));

  const finSemaine = new Date(startWeek.getTime() + 6 * 864e5);
  const jm = d => new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  const premiere = all.length ? new Date(all[all.length - 1].date) : null;

  let html = `
    <div class="stat-grid">
      <div class="stat hi"><b>${fmtHours(weekMin)}</b><span>cette semaine</span>
        <div class="stat-dates">sem. ${isoWeek(startWeek)} · ${jm(startWeek)} → ${jm(finSemaine)}</div></div>
      <div class="stat hi"><b>${fmtHours(monthMin)}</b><span>ce mois-ci</span>
        <div class="stat-dates">${startMonth.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}</div></div>
      <div class="stat"><b>${fmtHours(avgWeek)}</b><span>moyenne / semaine</span>
        <div class="stat-dates">${premiere ? 'depuis le ' + fmtDateFull(premiere) : '—'}</div></div>
      <div class="stat"><b>${fmtHours(avgMonth)}</b><span>moyenne / mois</span>
        <div class="stat-dates">${premiere ? 'sur ' + Math.max(1, (now.getFullYear() - premiere.getFullYear()) * 12 + now.getMonth() - premiere.getMonth() + 1) + ' mois' : '—'}</div></div>
    </div>
    <div class="sub" style="text-align:center;margin:-8px 0 14px">
      ${premiere ? `Statistiques calculées sur ${all.length} séance${all.length > 1 ? 's' : ''} validée${all.length > 1 ? 's' : ''}, du ${fmtDateFull(premiere)} à aujourd\u2019hui.` : 'Aucune séance enregistrée.'}
    </div>
    <div class="seg">
      <button data-range="week" class="${hoursRange === 'week' ? 'on' : ''}">Semaine</button>
      <button data-range="month" class="${hoursRange === 'month' ? 'on' : ''}">Mois</button>
      <button data-range="all" class="${hoursRange === 'all' ? 'on' : ''}">Tout</button>
    </div>`;

  if (Object.keys(byKind).length) {
    const libPeriode = hoursRange === 'week' ? `semaine ${isoWeek(startWeek)} (${jm(startWeek)} → ${jm(finSemaine)})`
      : hoursRange === 'month' ? startMonth.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
        : premiere ? `depuis le ${fmtDateFull(premiere)}` : 'tout l\u2019historique';
    html += `<div class="card"><div class="sub" style="margin-bottom:6px">Répartition · ${esc(libPeriode)} · total ${fmtHours(mins(inRange))}</div>
      ${Object.keys(KINDS).filter(k => KINDS[k].travail !== false).map(k => `<div class="row" style="padding:3px 0">
        <div class="grow"${byKind[k] ? '' : ' style="opacity:.5"'}>${KINDS[k].icon} ${KINDS[k].label}</div>
        <div class="title"${byKind[k] ? '' : ' style="opacity:.5"'}>${fmtHours(byKind[k] || 0)}</div></div>`).join('')}
      ${offertMin ? `<hr class="staff"><div class="row"><div class="grow">Dont séances offertes</div><div class="title" style="color:var(--gold)">${fmtHours(offertMin)}</div></div>` : ''}
      ${revenue ? `<div class="row" style="padding:3px 0"><div class="grow title">Cachets encaissés</div><div class="title" style="color:var(--orange)">${fmtMoney(revenue)}</div></div>` : ''}
    </div>`;
  }

  const aValider = (await DB.all('lessons')).filter(enAttente);
  if (aValider.length) html += `<div class="card accent tappable" id="a-valider-h">
      <div class="title">✓ ${aValider.length} séance${aValider.length > 1 ? 's' : ''} à valider</div>
      <div class="sub">Non comptée${aValider.length > 1 ? 's' : ''} dans les statistiques tant qu\u2019elle${aValider.length > 1 ? 's ne sont' : ' n\u2019est'} pas confirmée${aValider.length > 1 ? 's' : ''}.</div></div>`;

  // les événements Google non rattachés ne sont comptés nulle part : on le signale
  const toutesLecons = await DB.all('lessons');
  const lies = new Set(toutesLecons.map(l => l.gcalEventId).filter(Boolean));
  const occupesH = creneauxGoogle(toutesLecons);
  const bornes = hoursRange === 'week' ? startWeek : hoursRange === 'month' ? startMonth : new Date(0);
  const orphelins = evenementsAffichables().filter(e => !lies.has(e.id) && !ignores.has(e.id)
    && !creneauPris(occupesH, gcDebut(e))
    && new Date(gcDebut(e)) <= now && new Date(gcDebut(e)) >= bornes);
  if (orphelins.length) html += `<div class="card accent tappable" id="orphelins">
      <div class="title">📥 ${orphelins.length} événement${orphelins.length > 1 ? 's' : ''} Google non rattaché${orphelins.length > 1 ? 's' : ''}</div>
      <div class="sub">Ces heures ne sont pas comptées. Toucher pour les rattacher (cours, répétition, concert…).</div></div>`;

  html += `<button class="btn secondary" id="add-act">＋ Ajouter une répétition / un concert</button>`;
  html += `<div class="search" style="margin-top:14px">
      <input id="h-search" type="search" placeholder="Rechercher un élève, un concert…" value="${esc(hoursQuery)}" autocomplete="off">
    </div>`;

  // filtre de recherche sur le détail
  const mots = hoursQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const cle = l => [students[l.studentId] ? students[l.studentId].name : '', l.title, l.type,
    (KINDS[l.kind || 'cours'] || {}).label, l.note].filter(Boolean).join(' ').toLowerCase();
  const vus = mots.length ? inRange.filter(l => mots.every(m => cle(l).includes(m))) : inRange;

  if (!vus.length) html += `<div class="empty"><div class="big">${mots.length ? '🔎' : '⏱️'}</div>
      <div class="empty-title">${mots.length ? 'Aucun résultat' : 'Aucune séance'}</div>
      ${mots.length ? 'Essaie un autre mot.' : 'Rien sur la période choisie.'}</div>`;
  else {
    const totalVus = mins(vus);
    html += `<h2 class="section">Détail (${vus.length})</h2>`;
    if (mots.length) html += `<div class="search-count">${fmtHours(totalVus)} sur ${fmtHours(mins(inRange))} pour la période</div>`;
    let curDay = '';
    for (const l of vus.slice(0, limiteHeures)) {
      const key = new Date(l.date).toDateString();
      if (key !== curDay) { curDay = key; html += `<div class="day-head">${fmtDate(l.date)}</div>`; }
      const k = KINDS[l.kind || 'cours'];
      const s = students[l.studentId];
      html += `<div class="swipe"><button class="swipe-del" data-del-lesson="${l.id}">Supprimer</button>
        <div class="card tappable row swipe-item" data-lesson="${l.id}">
        <div class="lesson-time">${fmtTime(l.date)}</div>
        <div class="grow"><div class="title">${k.icon} ${esc(s ? s.name : (l.title || k.label))}</div>
        <div class="sub">${fmtHours(l.duration || 60)}${l.fee ? ' · ' + fmtMoney(l.fee) : ''}${l.paid === false ? ' · offert' : ''}</div></div>
        <div class="chev">›</div></div></div>`;
    }
    if (vus.length > limiteHeures)
      html += `<button class="btn ghost" id="plus-heures">Afficher les ${vus.length - limiteHeures} séances suivantes</button>`;
  }
  view.innerHTML = html;
  view.querySelectorAll('[data-range]').forEach(b => b.onclick = () => { hoursRange = b.dataset.range; limiteHeures = 60; renderHours(); });
  activerGlissement(view);
  $('#add-act').onclick = () => sheetLesson(null, null, 'repetition');
  const hs = $('#h-search');
  if (hs) hs.oninput = e => {
    hoursQuery = e.target.value; limiteHeures = 60;
    clearTimeout(hs._t); hs._t = setTimeout(() => { renderHours(); const n = $('#h-search'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 220);
  };
  const plusH = $('#plus-heures');
  if (plusH) plusH.onclick = () => { limiteHeures += 150; renderHours(); };
  const orph = $('#orphelins'); if (orph) orph.onclick = () => sheetGroupes(orphelins);
  const avh = $('#a-valider-h'); if (avh) avh.onclick = () => sheetAValider(aValider);
}

// ====== ÉLÈVES ======
async function renderStudents() {
  currentStudent = null;
  const students = (await DB.all('students')).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  if (!students.length) {
    view.innerHTML = `<div class="empty"><div class="big">🎤</div><div class="empty-title">Aucun élève</div>Touche ＋ pour créer un profil.</div>`;
    return;
  }

  // on prépare une fois les cartes (avec l'état des paiements), puis on filtre à la volée
  const cartes = [];
  for (const s of students) {
    const st = await paymentStatus(s);
    let badge = '';
    if (st.aucuneActivite) badge = '<span class="badge ghost">Nouvel élève</span>';
    else if (st.expired) badge = '<span class="badge due">Forfait expiré</span>';
    else if (st.remainingMin < 0) badge = `<span class="badge due">${fmtHours(-st.remainingMin)} à régler</span>`;
    else if (st.remainingMin > 0) badge = `<span class="badge ok">${fmtHours(st.remainingMin)}</span>`;
    // remainingMin === 0 : rien à afficher
    cartes.push({
      cle: [s.name, s.phone, s.email, s.level, descriptionOf(s)].filter(Boolean).join(' ').toLowerCase(),
      html: `<div class="card tappable row" data-student="${s.id}">
        ${s.photo ? `<img class="avatar" src="${s.photo}">` : `<div class="avatar">${initials(s.name)}</div>`}
        <div class="grow"><div class="title">${esc(s.name)}</div>
        <div class="sub">${st.aucuneActivite ? 'Aucun cours enregistré'
          : st.last ? (st.expiry ? 'Valable jusqu\u2019au ' + fmtDateFull(st.expiry) : 'Forfait non démarré') : 'Aucun paiement'}</div></div>
        <div class="right">${badge}</div><div class="chev">›</div></div>`
    });
  }

  view.innerHTML = `<div class="search">
      <input id="stu-search" type="search" placeholder="Rechercher un élève…" value="${esc(studentQuery)}" autocomplete="off">
    </div>
    <div id="stu-count" class="search-count" hidden></div>
    <div id="stu-list"></div>`;

  const dessine = q => {
    const mots = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const vus = mots.length ? cartes.filter(c => mots.every(m => c.cle.includes(m))) : cartes;
    $('#stu-list').innerHTML = vus.length ? vus.map(c => c.html).join('')
      : `<div class="empty"><div class="big">🔎</div><div class="empty-title">Aucun résultat</div>Essaie un autre nom.</div>`;
    const cpt = $('#stu-count');
    cpt.hidden = !mots.length;
    cpt.textContent = `${vus.length} élève${vus.length > 1 ? 's' : ''} sur ${cartes.length}`;
    $('#stu-list').querySelectorAll('[data-student]').forEach(el => el.onclick = () => renderStudentDetail(el.dataset.student));
  };
  dessine(studentQuery);
  $('#stu-search').oninput = e => { studentQuery = e.target.value; dessine(studentQuery); };
}

async function renderStudentDetail(id) {
  const s = await DB.get('students', id);
  if (!s) return renderStudents();
  if (currentStudent !== id) limiteFiche = 25;      // nouvelle fiche : on repart court
  currentStudent = id;
  const allItems = await lessonsOf(id);
  const lessons = allItems.filter(l => (l.kind || 'cours') === 'cours');
  const now = Date.now();
  const individuels = lessons.filter(l => !estCollectif(l));
  const collectifs = lessons.filter(l => estCollectif(l));
  const attente = individuels.filter(l => enAttente(l)).reverse();
  const past = individuels.filter(l => new Date(l.date) <= now && estValide(l)).reverse();
  const next = individuels.filter(l => new Date(l.date) > now);
  const collPast = collectifs.filter(l => new Date(l.date) <= now).reverse();
  const collNext = collectifs.filter(l => new Date(l.date) > now);
  const payments = (await DB.byStudent('payments', id)).sort((a, b) => new Date(b.date) - new Date(a.date));
  const notes = (await DB.byStudent('notes', id)).sort((a, b) => new Date(b.date) - new Date(a.date));
  const st = await paymentStatus(s);
  const couverture = (await coverageMap(s)).map;
  // Les cours rattachés depuis Google arrivent « en attente » : sans cette
  // seconde carte, la fiche d'un élève n'affichait plus aucune pastille.
  const couvertureAttente = (await coverageMap(s, true)).map;
  const totalMin = lessons.filter(l => new Date(l.date) <= now).reduce((a, l) => a + (l.duration || 60), 0);
  const collMin = collPast.reduce((a, l) => a + (l.duration || 60), 0);

  view.innerHTML = `
    <button class="btn-inline" id="back">‹ Élèves</button>
    <div class="card" style="text-align:center;margin-top:12px">
      ${s.photo ? `<img class="avatar big" src="${s.photo}" style="margin:0 auto">` : `<div class="avatar big" style="margin:0 auto">${initials(s.name)}</div>`}
      <h3 style="margin-top:8px;font-size:1.3rem">${esc(s.name)}</h3>
      <div class="sub">${esc([s.phone, s.email].filter(Boolean).join(' · '))}</div>
      <div style="margin-top:8px">
        ${st.aucuneActivite ? '<span class="badge ghost">Nouvel élève</span>'
      : st.expired ? '<span class="badge due">Forfait expiré</span>'
        : st.remainingMin < 0 ? `<span class="badge due">${fmtHours(-st.remainingMin)} à régler</span>`
          : st.remainingMin > 0 ? `<span class="badge ok">${fmtHours(st.remainingMin)} restante${st.remainingMin > 60 ? 's' : ''}</span>` : ''}
        ${st.expiry && !st.expired ? `<span class="badge warn">jusqu\u2019au ${fmtDateFull(st.expiry)}</span>` : ''}
        ${st.notStarted ? '<span class="badge info">démarre au 1er cours</span>' : ''}
      </div>
      <button class="btn secondary" id="edit-student">Modifier le profil</button>
    </div>

    <div class="stat-grid">
      <div class="stat"><b>${past.length}</b><span>cours faits</span></div>
      <div class="stat"><b>${fmtHours(totalMin)}</b><span>heures cumulées</span></div>
    </div>

    <h2 class="section">Suivi pédagogique</h2>
    <div class="card">
      ${s.level ? `<div style="margin-bottom:8px"><span class="tag g">Niveau</span> ${esc(s.level)}</div>` : ''}
      <div style="margin-bottom:8px"><span class="tag">Lieu habituel</span> ${LIEUX[s.lieu || 'ecole']}</div>
      ${descriptionOf(s) ? `<p style="white-space:pre-wrap">${esc(descriptionOf(s))}</p>` : ''}
      ${!s.level && !descriptionOf(s) ? '<div class="sub">À renseigner via « Modifier le profil ».</div>' : ''}
    </div>

    <h2 class="section">Notes de cours</h2>
    <button class="btn secondary" id="add-note" style="margin-top:0">＋ Ajouter une note</button>
    ${notes.map(n => `<div class="card note" data-note="${n.id}"><div class="sub">${fmtDateFull(n.date)}</div><p>${esc(n.text)}</p></div>`).join('') || '<div class="sub" style="padding:6px">Aucune note.</div>'}

    <h2 class="section">Paiements</h2>
    <button class="btn secondary" id="add-pay" style="margin-top:0">＋ Enregistrer un paiement</button>
    ${payments.map(p => `<div class="card tappable row" data-pay="${p.id}"><div class="grow"><div class="title">${fmtMoney(p.amount)} — ${fmtHours(paiementMinutes(p))}</div>
      <div class="sub">${esc(p.label || '')} · ${fmtDateFull(p.date)}${p.method ? ' · ' + esc(p.method) : ''}</div></div>
      ${p.collectedBy ? `<span class="badge ghost">${esc(p.collectedBy)}</span>` : ''}<div class="chev">›</div></div>`).join('')}

    ${attente.length ? `<h2 class="section">Cours en attente (${attente.length})</h2>
    <div class="sub" style="margin-bottom:10px">Ces cours sont passés mais pas encore confirmés. Ils ne décomptent rien du forfait tant qu\u2019ils ne sont pas validés.</div>
    ${attente.length > 1 ? `<button class="btn gold" id="valider-tout" style="margin-top:0">✓ Valider les ${attente.length} cours en attente</button>` : ''}
    ${attente.length > 20 ? `<div class="sub" style="margin-bottom:10px">Les 20 plus récents sont détaillés ci-dessous.</div>` : ''}
    ${attente.slice(0, 20).map(l => `<div class="card accent">
        <div class="row"><div class="lesson-time">${fmtDate(l.date)}<br><span class="sub">${fmtTime(l.date)}</span></div>
        <div class="grow"><div class="title">${esc(l.type || '')}</div>
        <div class="sub">${fmtHours(l.duration || 60)}${l.lieu === 'domicile' ? ' · à domicile' : ''}</div></div>
        ${pastillePaiement(l, couvertureAttente[l.id], true)}</div>
        <div class="field-row" style="margin-top:10px">
          <button class="btn gold" style="margin:0" data-valider="${l.id}">✓ Valider</button>
          <button class="btn secondary" style="margin:0" data-modifier="${l.id}">Modifier</button>
        </div></div>`).join('')}` : ''}

    <h2 class="section">Prochains cours</h2>
    <button class="btn secondary" id="add-lesson" style="margin-top:0">＋ Planifier un cours</button>
    ${next.map(l => `<div class="card tappable row" data-lesson="${l.id}"><div class="lesson-time">${fmtDate(l.date)}<br><span class="sub">${fmtTime(l.date)}</span></div><div class="grow sub">${esc(l.type || '')}</div><div class="chev">›</div></div>`).join('') || '<div class="sub" style="padding:6px">Aucun cours planifié.</div>'}

    <h2 class="section">Cours individuels effectués (${past.length})</h2>
    ${past.slice(0, limiteFiche).map(l => {
      const pastille = pastillePaiement(l, couverture[l.id], false);
      return `<div class="card tappable row" data-lesson="${l.id}"><div class="lesson-time">${fmtDate(l.date)}</div>
      <div class="grow sub">${esc(l.type || '')}${l.lieu === 'domicile' ? ' · à domicile' : ''}${l.note ? ' — ' + esc(l.note) : ''}</div>
      ${pastille}</div>`;
    }).join('') || '<div class="sub" style="padding:6px">Aucun cours passé.</div>'}
    ${past.length > limiteFiche ? `<button class="btn ghost" id="plus-cours">Afficher les ${past.length - limiteFiche} cours précédents</button>` : ''}

    <h2 class="section">Cours collectifs (${collectifs.length})</h2>
    <div class="sub" style="margin-bottom:10px">Les cours collectifs ont toujours lieu à l\u2019école et ne décomptent rien du forfait individuel.
      ${collMin ? '<b>' + fmtHours(collMin) + '</b> suivies à ce jour.' : ''}</div>
    <button class="btn secondary" id="add-coll" style="margin-top:0">＋ Ajouter un cours collectif</button>
    ${collNext.map(l => `<div class="card tappable row" data-lesson="${l.id}">
        <div class="lesson-time">${fmtDate(l.date)}<br><span class="sub">${fmtTime(l.date)}</span></div>
        <div class="grow"><div class="title">À venir</div><div class="sub">${esc(l.type || '')} · ${fmtHours(l.duration || 60)}</div></div>
        <div class="chev">›</div></div>`).join('')}
    ${collPast.map(l => `<div class="card tappable row" data-lesson="${l.id}">
        <div class="lesson-time">${fmtDate(l.date)}</div>
        <div class="grow sub">${esc(l.type || '')} · ${fmtHours(l.duration || 60)}${l.note ? ' — ' + esc(l.note) : ''}</div></div>`).join('')}
    ${!collectifs.length ? '<div class="sub" style="padding:6px">Aucun cours collectif pour cet élève.</div>' : ''}
  `;
  $('#back').onclick = renderStudents;
  const plusCours = $('#plus-cours');
  if (plusCours) plusCours.onclick = () => { limiteFiche += 100; renderStudentDetail(id); };
  $('#edit-student').onclick = () => sheetStudent(id);
  $('#add-lesson').onclick = () => sheetLesson(null, id);
  $('#add-coll').onclick = () => sheetLesson(null, id, null, 'collectif');
  $('#add-pay').onclick = () => sheetPayment(id);
  $('#add-note').onclick = () => sheetNote(id);
  view.querySelectorAll('[data-note]').forEach(el => el.onclick = () => sheetNote(id, el.dataset.note));
  const vTout = $('#valider-tout');
  if (vTout) vTout.onclick = async () => {
    if (!confirm(`Valider les ${attente.length} cours en attente de ${s.name} ?\n\nIls compteront alors dans les heures effectuées et décompteront le forfait.`)) return;
    vTout.disabled = true; vTout.textContent = 'Validation…';
    // Un seul geste à annuler, pas une entrée par cours.
    Undo.silence = true;
    try {
      for (const l of attente) { const x = await DB.get('lessons', l.id); if (x) { x.status = 'done'; await DB.put('lessons', x); } }
    } finally { Undo.silence = false; }
    const ids = attente.map(l => l.id);
    Undo.ajouter(`validation de ${ids.length} cours`, async () => {
      Undo.silence = true;
      try { for (const id of ids) { const x = await DB.get('lessons', id); if (x) { x.status = 'planned'; await DB.put('lessons', x); } } }
      finally { Undo.silence = false; }
    });
    toast(ids.length + ' cours validés ✓');
    renderStudentDetail(id);
  };
  view.querySelectorAll('[data-valider]').forEach(b => b.onclick = async () => {
    const l = await DB.get('lessons', b.dataset.valider);
    l.status = 'done'; await DB.put('lessons', l);
    toast('Cours validé ✓'); renderStudentDetail(id);
  });
  view.querySelectorAll('[data-modifier]').forEach(b => b.onclick = () => sheetLesson(b.dataset.modifier));
  view.querySelectorAll('[data-pay]').forEach(el => el.onclick = () => sheetPayment(id, el.dataset.pay));
}

// Récupère la description, en reprenant les anciens champs s'ils existent
// Pastille de règlement : ✦ offert, ✓ couvert par un paiement, ○ reste dû.
function pastillePaiement(l, couvert, provisoire) {
  if (l.paid === false) return '<span class="paye offert" title="Cours offert">✦</span>';
  const p = provisoire ? ' provisoire' : '';
  return couvert
    ? `<span class="paye oui${p}" title="${provisoire ? 'Couvert par le forfait — à valider' : 'Payé'}">✓</span>`
    : `<span class="paye non${p}" title="${provisoire ? 'Pas encore couvert — à valider' : 'En attente de règlement'}"></span>`;
}

function descriptionOf(s) {
  if (s.description !== undefined && s.description !== null) return s.description;
  const vieux = [
    s.strengths ? 'Points forts : ' + s.strengths : '',
    s.difficulties ? 'Difficultés : ' + s.difficulties : ''
  ].filter(Boolean).join('\n');
  return vieux;
}

function fileToDataURL(file, maxSize = 800) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = img.width * scale; c.height = img.height * scale;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      res(c.toDataURL('image/jpeg', 0.82));
    };
    img.src = URL.createObjectURL(file);
  });
}

async function sheetStudent(id) {
  const s = id ? await DB.get('students', id) : {};
  openSheet(`
    <h3>${id ? 'Modifier le profil' : 'Nouvel élève'}</h3>
    <div style="text-align:center;margin-bottom:12px">
      ${s.photo ? `<img class="avatar big" id="photo-preview" src="${s.photo}" style="margin:0 auto">` : `<div class="avatar big" id="photo-preview" style="margin:0 auto">📷</div>`}
      <input type="file" id="f-photo" accept="image/*" hidden>
      <button class="btn-inline" id="pick-photo" style="margin-top:8px">${s.photo ? 'Changer la photo' : 'Ajouter une photo'}</button>
    </div>
    <label class="field"><span>Nom et prénom *</span><input id="f-name" value="${esc(s.name || '')}"></label>
    <div class="field-row">
      <label class="field"><span>Téléphone</span><input id="f-phone" type="tel" value="${esc(s.phone || '')}"></label>
      <label class="field"><span>E-mail</span><input id="f-email" type="email" value="${esc(s.email || '')}"></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Niveau</span><input id="f-level" value="${esc(s.level || '')}"></label>
      <label class="field"><span>Lieu habituel</span>
        <select id="f-lieu">${Object.entries(LIEUX).map(([v, t]) => `<option value="${v}" ${(s.lieu || 'ecole') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    </div>
    <label class="field"><span>Description</span><textarea id="f-desc" style="min-height:130px" placeholder="Parcours, objectifs, remarques…">${esc(descriptionOf(s))}</textarea></label>
    <button class="btn" id="f-save">${id ? 'Enregistrer' : 'Créer le profil'}</button>
    ${id ? '<button class="btn danger" id="f-del">Supprimer cet élève</button>' : ''}
  `);
  let photo = s.photo || null;
  $('#pick-photo').onclick = () => $('#f-photo').click();
  $('#f-photo').onchange = async e => {
    if (!e.target.files[0]) return;
    photo = await fileToDataURL(e.target.files[0]);
    $('#photo-preview').outerHTML = `<img class="avatar big" id="photo-preview" src="${photo}" style="margin:0 auto">`;
  };
  $('#f-save').onclick = async () => {
    const name = $('#f-name').value.trim();
    if (!name) { toast('Le nom est obligatoire'); return; }
    const obj = { ...(s.id ? s : {}), name, photo, phone: $('#f-phone').value, email: $('#f-email').value,
                  level: $('#f-level').value, lieu: $('#f-lieu').value, description: $('#f-desc').value };
    delete obj.strengths; delete obj.difficulties;      // anciens champs, désormais fusionnés
    const saved = await DB.put('students', obj);
    closeSheet(); toast('Profil enregistré ✓'); renderStudentDetail(saved.id);
  };
  if (id) $('#f-del').onclick = async () => {
    if (!confirm('Supprimer cet élève et tout son historique ?')) return;
    for (const st of ['lessons', 'payments', 'notes']) for (const r of await DB.byStudent(st, id)) await DB.del(st, r.id);
    await DB.del('students', id); closeSheet(); renderStudents();
  };
}

async function sheetPayment(studentId, payId) {
  const { forfaits, collectors } = await getConfig();
  const p = payId ? await DB.get('payments', payId) : null;
  const f0 = forfaits[0] || { price: 0, lessons: 1, validity: 2, from: 'first' };
  const d = p ? new Date(p.date) : new Date();

  openSheet(`
    <h3>${p ? 'Modifier le paiement' : 'Enregistrer un paiement'}</h3>
    <label class="field"><span>Forfait</span>
      <select id="f-forfait">
        <option value="">${p ? esc(p.label || 'Montant libre') : '— choisir —'}</option>
        ${forfaits.map((f, i) => `<option value="${i}">${esc(f.label)} — ${fmtMoney(f.price)}</option>`).join('')}
      </select></label>
    <div class="field-row">
      <label class="field"><span>Montant</span><input type="number" id="f-amount" value="${p ? p.amount : f0.price}"></label>
      <label class="field"><span>Heures achetées</span><input type="number" id="f-count" step="0.5" value="${p ? (p.hoursCovered != null ? p.hoursCovered : (p.lessonsCovered || 1)) : forfaitHeures(f0)}"></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Validité (mois)</span><input type="number" id="f-valid" value="${p ? (p.validityMonths || 0) : (f0.validity || 2)}"></label>
      <label class="field"><span>Départ validité</span>
        <select id="f-from">
          <option value="first" ${!p || !['purchase', 'unpaid'].includes(p.validityFrom) ? 'selected' : ''}>1er cours</option>
          <option value="purchase" ${p && p.validityFrom === 'purchase' ? 'selected' : ''}>date d\u2019achat</option>
          <option value="unpaid" ${p && p.validityFrom === 'unpaid' ? 'selected' : ''}>1er cours impayé</option>
        </select></label>
    </div>
    <div class="sub" id="from-aide" style="margin:-6px 0 12px"></div>
    <div class="field-row">
      <label class="field"><span>Date</span><input type="date" id="f-date" value="${d.toISOString().slice(0, 10)}"></label>
      <label class="field"><span>Moyen</span>
        <select id="f-method">${['Chèque', 'Espèces', 'Virement', 'Bon cadeau'].map(m => `<option ${p && p.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
    </div>
    <label class="field"><span>Encaissé par</span>
      <select id="f-by">${collectors.map(c => `<option ${p && p.collectedBy === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
    <button class="btn" id="f-save">${p ? 'Enregistrer les modifications' : 'Enregistrer'}</button>
    ${p ? '<button class="btn danger" id="f-del">Supprimer ce paiement</button>' : ''}
  `);

  // La portée de chaque choix n'est pas devinable : on l'écrit sous le champ.
  const AIDE_FROM = {
    first: 'La validité démarre au 1er cours qui suit ce paiement. Il ne couvre que les cours postérieurs à sa date.',
    purchase: 'La validité démarre à la date ci-dessous. Le paiement ne couvre que les cours postérieurs à cette date.',
    unpaid: 'Le paiement rattrape les cours déjà donnés et non réglés, du plus ancien au plus récent. La validité démarre au premier d\u2019entre eux.'
  };
  const majAide = () => { const b = $('#from-aide'); if (b) b.textContent = AIDE_FROM[$('#f-from').value] || ''; };
  $('#f-from').onchange = majAide;
  majAide();

  $('#f-forfait').onchange = e => {
    const f = forfaits[+e.target.value];
    if (!f) return;
    $('#f-amount').value = f.price; $('#f-count').value = forfaitHeures(f);
    $('#f-valid').value = f.validity || 0; $('#f-from').value = f.from || 'first';
    majAide();
  };

  $('#f-save').onclick = async () => {
    const idx = $('#f-forfait').value;
    const f = idx === '' ? null : forfaits[+idx];
    await DB.put('payments', {
      id: p ? p.id : DB.uid(), studentId,
      amount: +$('#f-amount').value,
      hoursCovered: +$('#f-count').value || 1,
      validityMonths: +$('#f-valid').value || 0,
      validityFrom: $('#f-from').value,
      label: f ? f.label : (p ? p.label : ''),
      date: new Date($('#f-date').value).toISOString(),
      method: $('#f-method').value,
      collectedBy: $('#f-by').value
    });
    closeSheet(); toast(p ? 'Paiement modifié ✓' : 'Paiement enregistré ✓'); renderStudentDetail(studentId);
  };

  if (p) $('#f-del').onclick = async () => {
    if (!confirm('Supprimer ce paiement ?')) return;
    await DB.del('payments', p.id);
    closeSheet(); toast('Paiement supprimé'); renderStudentDetail(studentId);
  };
}

async function sheetNote(studentId, noteId) {
  const n = noteId ? await DB.get('notes', noteId) : null;
  openSheet(`
    <h3>${n ? 'Modifier la note' : 'Nouvelle note'}</h3>
    <label class="field"><span>Date</span><input type="date" id="f-date" value="${(n ? new Date(n.date) : new Date()).toISOString().slice(0, 10)}"></label>
    <label class="field"><span>Contenu</span><textarea id="f-text" style="min-height:140px">${esc(n ? n.text : '')}</textarea></label>
    <button class="btn" id="f-save">Enregistrer</button>
    ${n ? '<button class="btn danger" id="f-del">Supprimer</button>' : ''}
  `);
  $('#f-save').onclick = async () => {
    await DB.put('notes', { id: n ? n.id : DB.uid(), studentId, date: new Date($('#f-date').value).toISOString(), text: $('#f-text').value });
    closeSheet(); renderStudentDetail(studentId);
  };
  if (n) $('#f-del').onclick = async () => { await DB.del('notes', n.id); closeSheet(); renderStudentDetail(studentId); };
}

// ====== FACTURES & DEVIS ======
async function renderBilling() {
  const invoices = (await DB.all('invoices')).sort((a, b) => new Date(b.date) - new Date(a.date));
  const students = Object.fromEntries((await DB.all('students')).map(s => [s.id, s]));
  const { collectors } = await getConfig();

  if (!invoices.length) {
    view.innerHTML = `<div class="empty"><div class="big">🧾</div>
      <div class="empty-title">Aucune facture ni devis</div>Touche ＋ pour en créer.</div>`;
    return;
  }

  // Totaux : encaissé par qui, et reste à encaisser
  const facts = invoices.filter(i => i.kind !== 'devis');
  const parEncaisseur = {};
  let attente = 0;
  for (const f of facts) {
    if (f.paid) parEncaisseur[f.paidBy || '—'] = (parEncaisseur[f.paidBy || '—'] || 0) + f.total;
    else attente += f.total;
  }

  let html = '';
  if (facts.length) {
    html += `<div class="card"><div class="sub" style="margin-bottom:8px">Encaissements</div>
      ${Object.entries(parEncaisseur).map(([who, amt]) => `<div class="row" style="padding:3px 0">
        <div class="grow">${esc(who)}</div><div class="title">${fmtMoney(amt)}</div></div>`).join('') || '<div class="sub">Rien d\u2019encaissé pour l\u2019instant.</div>'}
      ${attente ? `<hr class="staff"><div class="row"><div class="grow title">Reste à encaisser</div>
        <div class="title" style="color:var(--danger)">${fmtMoney(attente)}</div></div>` : ''}
    </div>`;
  }

  html += invoices.map(inv => {
    const st = inv.kind === 'devis' ? '<span class="badge gold">Devis</span>'
      : inv.paid ? `<span class="badge ok">Encaissé · ${esc(inv.paidBy || '')}</span>`
        : '<span class="badge due">À encaisser</span>';
    return `<div class="card tappable row" data-inv="${inv.id}">
      <div class="grow"><div class="title">${inv.kind === 'devis' ? 'Devis' : 'Facture'} ${esc(inv.number)}</div>
      <div class="sub">${esc(students[inv.studentId] ? students[inv.studentId].name : '—')} · ${fmtDateFull(inv.date)}</div></div>
      <div class="right"><div class="title">${fmtMoney(inv.total)}</div>${st}</div>
      <div class="chev">›</div></div>`;
  }).join('');

  view.innerHTML = html;
  view.querySelectorAll('[data-inv]').forEach(el => el.onclick = () => sheetInvoiceView(el.dataset.inv));
}

async function sheetInvoice() {
  const students = await DB.all('students');
  if (!students.length) { toast('Crée d\u2019abord un élève'); switchTab('students'); return; }
  const { courseTypes, forfaits } = await getConfig();
  openSheet(`
    <h3>Nouvelle facture / devis</h3>
    <label class="field"><span>Document</span><select id="f-kind"><option value="facture">Facture</option><option value="devis">Devis</option></select></label>
    <label class="field"><span>Élève</span><select id="f-student">${students.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
    <label class="field"><span>Type de cours</span><select id="f-type">${courseTypes.map(t => `<option>${esc(t)}</option>`).join('')}</select></label>
    <label class="field"><span>Forfait</span><select id="f-forfait">${forfaits.map((f, i) => `<option value="${i}">${esc(f.label)} — ${fmtMoney(f.price)}</option>`).join('')}</select></label>
    <div class="field-row">
      <label class="field"><span>Quantité</span><input type="number" id="f-qty" value="1"></label>
      <label class="field"><span>Prix unitaire</span><input type="number" id="f-price" value="${forfaits[0].price}"></label>
    </div>
    <button class="btn" id="f-save">Créer le document</button>
  `);
  $('#f-forfait').onchange = e => { const f = forfaits[+e.target.value]; if (f) $('#f-price').value = f.price; };
  $('#f-save').onclick = async () => {
    const kind = $('#f-kind').value;
    const counterKey = kind === 'devis' ? 'devisCounter' : 'invoiceCounter';
    const n = (await DB.getSetting(counterKey, 0)) + 1;
    await DB.setSetting(counterKey, n);
    const f = forfaits[+$('#f-forfait').value];
    const qty = +$('#f-qty').value || 1, price = +$('#f-price').value || 0;
    const inv = await DB.put('invoices', {
      id: DB.uid(), kind, number: `${new Date().getFullYear()}-${String(n).padStart(3, '0')}`,
      studentId: $('#f-student').value, date: new Date().toISOString(),
      items: [{ label: `${$('#f-type').value} — ${f.label}`, qty, unitPrice: price }], total: qty * price
    });
    closeSheet(); toast('Document créé ✓'); sheetInvoiceView(inv.id);
  };
}

async function sheetInvoiceView(id) {
  const inv = await DB.get('invoices', id);
  const student = await DB.get('students', inv.studentId);
  const { collectors } = await getConfig();
  renderBilling();
  openSheet(`
    <h3>${inv.kind === 'devis' ? 'Devis' : 'Facture'} ${esc(inv.number)}</h3>
    <div class="card"><div class="title">${esc(student ? student.name : '—')}</div>
      <div class="sub">${fmtDateFull(inv.date)}</div><hr class="staff">
      ${inv.items.map(i => `<div class="row"><div class="grow sub">${esc(i.label)} × ${i.qty}</div><div class="title">${fmtMoney(i.qty * i.unitPrice)}</div></div>`).join('')}
      <div class="row" style="margin-top:8px"><div class="grow title">Total</div><div class="title" style="color:var(--green)">${fmtMoney(inv.total)}</div></div></div>

    ${inv.kind === 'devis' ? '' : `
    <h2 class="section">Encaissement</h2>
    <div class="card">
      ${inv.paid ? `<div class="row"><div class="grow">
          <div class="title">Encaissé par ${esc(inv.paidBy || '—')}</div>
          <div class="sub">${inv.paidDate ? 'le ' + fmtDateFull(inv.paidDate) : ''}${inv.paidMethod ? ' · ' + esc(inv.paidMethod) : ''}</div></div>
          <span class="badge ok">Réglé</span></div>
        <button class="btn ghost" id="f-unpaid">Annuler l\u2019encaissement</button>`
      : `<div class="sub">Pas encore encaissée.</div>
        <label class="field" style="margin-top:10px"><span>Encaissé par</span>
          <select id="f-by">${collectors.map(c => `<option>${esc(c)}</option>`).join('')}</select></label>
        <div class="field-row">
          <label class="field"><span>Date</span><input type="date" id="f-paiddate" value="${new Date().toISOString().slice(0, 10)}"></label>
          <label class="field"><span>Moyen</span>
            <select id="f-paidmethod"><option>Chèque</option><option>Espèces</option><option>Virement</option><option>Bon cadeau</option></select></label>
        </div>
        <button class="btn" id="f-paid">Marquer comme encaissée</button>`}
    </div>`}

    <button class="btn gold" id="f-print">Imprimer / PDF</button>
    <button class="btn danger" id="f-del">Supprimer</button>
  `);

  const paidBtn = $('#f-paid');
  if (paidBtn) paidBtn.onclick = async () => {
    inv.paid = true;
    inv.paidBy = $('#f-by').value;
    inv.paidDate = new Date($('#f-paiddate').value).toISOString();
    inv.paidMethod = $('#f-paidmethod').value;
    await DB.put('invoices', inv);
    toast('Encaissement enregistré ✓'); sheetInvoiceView(id);
  };
  const unpaidBtn = $('#f-unpaid');
  if (unpaidBtn) unpaidBtn.onclick = async () => {
    inv.paid = false; delete inv.paidBy; delete inv.paidDate; delete inv.paidMethod;
    await DB.put('invoices', inv);
    toast('Encaissement annulé'); sheetInvoiceView(id);
  };
  $('#f-print').onclick = () => printInvoice(inv, student);
  $('#f-del').onclick = async () => {
    if (!confirm('Supprimer ce document ?')) return;
    await DB.del('invoices', id); closeSheet(); renderBilling();
  };
}

async function printInvoice(inv, student) {
  const { business } = await getConfig();
  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>${inv.kind} ${inv.number}</title>
  <style>
    body{font-family:-apple-system,Helvetica,Arial,sans-serif;color:#1E2A22;padding:40px;max-width:700px;margin:auto}
    h1{font-size:1.6rem;color:#0E5A34} .head{display:flex;justify-content:space-between;margin-bottom:26px}
    .rule{height:3px;background:linear-gradient(90deg,#E2761B,#0E5A34);margin:16px 0 28px;border-radius:2px}
    table{width:100%;border-collapse:collapse;margin:20px 0}
    th{text-align:left;font-size:.8rem;text-transform:uppercase;color:#69756D;border-bottom:2px solid #0E5A34;padding:8px 4px}
    td{padding:10px 4px;border-bottom:1px solid #EBE3D8} .num{text-align:right}
    .total{font-size:1.2rem;font-weight:800;color:#0E5A34}
    .footer{margin-top:44px;font-size:.8rem;color:#69756D}
  </style></head><body>
  <div class="head"><div><h1>${inv.kind === 'devis' ? 'DEVIS' : 'FACTURE'} ${esc(inv.number)}</h1>
    <div>Date : ${fmtDateFull(inv.date)}</div></div>
  <div style="text-align:right"><strong>${esc(business.name || '')}</strong><br>
    ${esc(business.address || '').replace(/\n/g, '<br>')}<br>
    ${business.siret ? 'N° : ' + esc(business.siret) + '<br>' : ''}
    ${esc(business.email || '')} ${esc(business.phone || '')}</div></div>
  <div class="rule"></div>
  <div><strong>Adressé à :</strong> ${esc(student ? student.name : '—')}<br>${esc(student && student.email || '')}</div>
  <table><tr><th>Prestation</th><th class="num">Qté</th><th class="num">P.U.</th><th class="num">Total</th></tr>
  ${inv.items.map(i => `<tr><td>${esc(i.label)}</td><td class="num">${i.qty}</td><td class="num">${fmtMoney(i.unitPrice)}</td><td class="num">${fmtMoney(i.qty * i.unitPrice)}</td></tr>`).join('')}
  <tr><td colspan="3" class="total">TOTAL</td><td class="num total">${fmtMoney(inv.total)}</td></tr></table>
  ${inv.paid ? '<div style="margin-top:14px"><strong>Réglée le ' + fmtDateFull(inv.paidDate) + '</strong> — encaissement : ' + esc(inv.paidBy || '') + (inv.paidMethod ? ' (' + esc(inv.paidMethod) + ')' : '') + '</div>' : ''}
  ${business.iban ? '<div>Règlement : ' + esc(business.iban) + '</div>' : ''}
  <div class="footer">${esc(business.footer || '')}${inv.kind === 'devis' ? '<br>Devis valable 30 jours.' : ''}</div>
  <script>setTimeout(()=>window.print(),300)<\/script></body></html>`);
  w.document.close();
}

// ====== RÉPERTOIRE ======
async function renderLibrary() {
  const pieces = (await DB.all('library')).sort((a, b) => a.title.localeCompare(b.title, 'fr'));
  let html = `<input id="lib-search" placeholder="🔍 Rechercher un morceau, un artiste, un tag…" style="margin-bottom:12px">`;
  if (!pieces.length) html += `<div class="empty"><div class="big">🎼</div><div class="empty-title">Répertoire vide</div>Touche ＋ pour ajouter un morceau.</div>`;
  html += `<div id="lib-list"></div>`;
  view.innerHTML = html;
  const list = $('#lib-list');
  const draw = q => {
    const f = q ? pieces.filter(p => (p.title + ' ' + (p.artist || '') + ' ' + (p.tags || '')).toLowerCase().includes(q.toLowerCase())) : pieces;
    list.innerHTML = f.map(p => `<div class="card tappable row" data-piece="${p.id}">
      <div class="avatar">🎵</div>
      <div class="grow"><div class="title">${esc(p.title)}</div>
      <div class="sub">${esc(p.artist || '')} ${(p.files || []).length ? '· 📎 ' + p.files.length : ''}</div>
      <div>${(p.tags || '').split(',').filter(t => t.trim()).map(t => `<span class="tag">${esc(t.trim())}</span>`).join('')}</div></div>
      <div class="chev">›</div></div>`).join('');
    list.querySelectorAll('[data-piece]').forEach(el => el.onclick = () => renderPiece(el.dataset.piece));
  };
  draw(''); $('#lib-search').oninput = e => draw(e.target.value);
}

async function renderPiece(id) {
  const p = await DB.get('library', id);
  if (!p) return renderLibrary();
  view.innerHTML = `
    <button class="btn-inline" id="back">‹ Répertoire</button>
    <div class="card" style="margin-top:12px"><h3 style="font-size:1.25rem">${esc(p.title)}</h3>
      <div class="sub">${esc(p.artist || '')}</div>
      <div style="margin-top:4px">${(p.tags || '').split(',').filter(t => t.trim()).map(t => `<span class="tag">${esc(t.trim())}</span>`).join('')}</div>
      <button class="btn secondary" id="edit-piece">Modifier</button></div>
    ${(p.files || []).length ? `<h2 class="section">Partitions & fichiers</h2><div class="card">${p.files.map((f, i) => `<a class="filelink" href="#" data-file="${i}">📎 ${esc(f.name)}</a>`).join('')}</div>` : ''}
    ${p.lyrics ? `<h2 class="section">Paroles / contenu</h2><div class="card"><p style="white-space:pre-wrap">${esc(p.lyrics)}</p></div>` : ''}`;
  $('#back').onclick = renderLibrary;
  $('#edit-piece').onclick = () => sheetPiece(id);
  view.querySelectorAll('[data-file]').forEach(el => el.onclick = e => {
    e.preventDefault();
    fetch(p.files[+el.dataset.file].data).then(r => r.blob()).then(b => window.open(URL.createObjectURL(b), '_blank'));
  });
}

async function sheetPiece(id) {
  const p = id ? await DB.get('library', id) : { files: [] };
  openSheet(`
    <h3>${id ? 'Modifier' : 'Nouveau morceau'}</h3>
    <label class="field"><span>Titre *</span><input id="f-title" value="${esc(p.title || '')}"></label>
    <label class="field"><span>Artiste</span><input id="f-artist" value="${esc(p.artist || '')}"></label>
    <label class="field"><span>Tags (virgules)</span><input id="f-tags" value="${esc(p.tags || '')}"></label>
    <label class="field"><span>Paroles / notes</span><textarea id="f-lyrics" style="min-height:150px">${esc(p.lyrics || '')}</textarea></label>
    <label class="field"><span>Partitions (PDF, images)</span><input type="file" id="f-files" accept="application/pdf,image/*" multiple></label>
    <div id="file-list"></div>
    <button class="btn" id="f-save">Enregistrer</button>
    ${id ? '<button class="btn danger" id="f-del">Supprimer</button>' : ''}
  `);
  const files = [...(p.files || [])];
  const redraw = () => {
    $('#file-list').innerHTML = files.map((f, i) => `<div class="row" style="padding:4px 0"><div class="grow sub">📎 ${esc(f.name)}</div><button class="btn-inline" data-rm="${i}">Retirer</button></div>`).join('');
    $('#file-list').querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { files.splice(+b.dataset.rm, 1); redraw(); });
  };
  redraw();
  $('#f-files').onchange = async e => {
    for (const f of e.target.files) {
      if (f.size > 8 * 1024 * 1024) { toast(f.name + ' : trop lourd (max 8 Mo)'); continue; }
      files.push({ name: f.name, type: f.type, data: await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); }) });
    }
    redraw();
  };
  $('#f-save').onclick = async () => {
    const title = $('#f-title').value.trim();
    if (!title) { toast('Le titre est obligatoire'); return; }
    const saved = await DB.put('library', { ...(p.id ? p : {}), title, artist: $('#f-artist').value, tags: $('#f-tags').value, lyrics: $('#f-lyrics').value, files });
    closeSheet(); toast('Enregistré ✓'); renderPiece(saved.id);
  };
  if (id) $('#f-del').onclick = async () => { await DB.del('library', id); closeSheet(); renderLibrary(); };
}

// ====== RÉGLAGES ======
const STORES = [
  { key: 'students', label: 'Élèves', sum: r => r.name },
  { key: 'lessons', label: 'Séances', sum: r => `${fmtDateFull(r.date)} · ${(KINDS[r.kind || 'cours'] || {}).label || ''}` },
  { key: 'payments', label: 'Paiements', sum: r => `${fmtMoney(r.amount)} · ${fmtHours(paiementMinutes(r))} · ${fmtDateFull(r.date)}` },
  { key: 'notes', label: 'Notes de cours', sum: r => `${fmtDateFull(r.date)} · ${(r.text || '').slice(0, 40)}` },
  { key: 'invoices', label: 'Factures & devis', sum: r => `${r.kind === 'devis' ? 'Devis' : 'Facture'} ${r.number} · ${fmtMoney(r.total)}` },
  { key: 'library', label: 'Répertoire', sum: r => r.title },
  { key: 'settings', label: 'Réglages', sum: r => r.id }
];

let settingsPage = null;   // null = accueil des réglages
let cloudSnapshot = null;  // dernier contenu lu depuis le cloud

async function renderSettings() {
  if (settingsPage === 'profil') return settingsProfil();
  if (settingsPage === 'tarifs') return settingsTarifs();
  if (settingsPage === 'google') return settingsGoogle();
  if (settingsPage === 'data') return settingsData();
  if (settingsPage === 'apparence') return settingsApparence();
  if (settingsPage === 'securite') return settingsSecurite();
  if (settingsPage === 'apropos') return settingsApropos();

  const cats = [
    ['profil', '🏷️', 'Profil & facturation', 'Coordonnées, monnaie, mentions'],
    ['tarifs', '💶', 'Cours, forfaits & encaissement', 'Types de cours, tarifs, qui encaisse'],
    ['google', '📅', 'Google Agenda', GC.aReconnecter ? '⚠️ Autorisation expirée — reconnecter' : GC.connected ? 'Connecté' : 'Non connecté'],
    ['data', '☁️', 'Données & sauvegarde', Cloud.lastBackup ? 'Dernière sauvegarde : ' + new Date(Cloud.lastBackup).toLocaleString('fr-FR') : 'Sauvegarde cloud à configurer'],
    ['apparence', '🎨', 'Apparence', localStorage.getItem('effets') === '1' ? 'Effets complets' : 'Mode léger (batterie)'],
    ['securite', '🔒', 'Sécurité', Lock.enabled ? 'Code actif' : 'Aucun code'],
    ['apropos', 'ℹ️', 'À propos', 'Version ' + APP_VERSION]
  ];
  view.innerHTML = cats.map(([k, ico, t, sub]) => `<button class="cat" data-cat="${k}">
      <span class="cat-ico">${ico}</span>
      <span class="grow"><span class="title">${t}</span><div class="sub">${esc(sub)}</div></span>
      <span class="chev">›</span></button>`).join('');
  view.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { settingsPage = b.dataset.cat; renderSettings(); });
}

function settingsBack(titre) {
  return `<button class="btn-inline" id="s-back">‹ Réglages</button>
          <h2 class="section">${titre}</h2>`;
}
function bindBack() { $('#s-back').onclick = () => { settingsPage = null; renderSettings(); }; }

// --- Profil & facturation ---
async function settingsProfil() {
  const { business } = await getConfig();
  view.innerHTML = settingsBack('Profil & facturation') + `
    <div class="card">
      <label class="field"><span>Nom</span><input id="b-name" value="${esc(business.name)}"></label>
      <label class="field"><span>Adresse</span><textarea id="b-address">${esc(business.address)}</textarea></label>
      <div class="field-row">
        <label class="field"><span>N° RIDET / SIRET</span><input id="b-siret" value="${esc(business.siret)}"></label>
        <label class="field"><span>Téléphone</span><input id="b-phone" value="${esc(business.phone)}"></label>
      </div>
      <label class="field"><span>E-mail</span><input id="b-email" value="${esc(business.email)}"></label>
      <label class="field"><span>Coordonnées bancaires</span><input id="b-iban" value="${esc(business.iban)}"></label>
      <label class="field"><span>Mention bas de facture</span><input id="b-footer" value="${esc(business.footer)}"></label>
      <label class="field"><span>Monnaie</span><select id="b-cur">
        <option value="XPF" ${CURRENCY === 'XPF' ? 'selected' : ''}>Franc Pacifique (F)</option>
        <option value="EUR" ${CURRENCY === 'EUR' ? 'selected' : ''}>Euro (€)</option></select></label>
      <button class="btn" id="b-save">Enregistrer</button>
    </div>`;
  bindBack();
  $('#b-save').onclick = async () => {
    await DB.setSetting('business', {
      name: $('#b-name').value, address: $('#b-address').value, siret: $('#b-siret').value,
      phone: $('#b-phone').value, email: $('#b-email').value, iban: $('#b-iban').value, footer: $('#b-footer').value
    });
    CURRENCY = $('#b-cur').value; await DB.setSetting('currency', CURRENCY);
    toast('Enregistré ✓');
  };
}

// --- Cours, forfaits, encaissement ---
async function settingsTarifs() {
  view.innerHTML = settingsBack('Types de cours') + `<div class="card" id="types-box"></div>
    <h2 class="section">Forfaits & tarifs</h2><div class="card" id="forfaits-box"></div>
    <h2 class="section">Qui encaisse</h2><div class="card" id="collectors-box"></div>`;
  bindBack();
  await drawTypes(); await drawForfaits(); await drawCollectors();
}

// --- Google Agenda ---
async function settingsGoogle() {
  view.innerHTML = settingsBack('Google Agenda') + `<div class="card">
    ${GC.connected ? `${GC.aReconnecter ? '<span class="badge warn">Autorisation expirée</span>' : '<span class="badge ok">Connecté</span>'}
        <div class="sub" style="margin-top:8px"><b>Lecture seule :</b> l\u2019app récupère les événements de Google Agenda mais n\u2019y écrit jamais. Rien n\u2019y est ajouté, modifié ni supprimé.</div>
        ${GC.aReconnecter ? `<div class="sub" style="margin-top:8px">Google a révoqué l\u2019accès. Tant que le projet Google reste en mode « Test », l\u2019autorisation expire tous les 7 jours : publie l\u2019application dans la console Google pour ne plus avoir à reconnecter.</div>
          <button class="btn" id="gc-on">Reconnecter Google Agenda</button>` : ''}
        <div class="sub" style="margin-top:8px">${GC.derniereSync ? 'Dernière synchro : ' + new Date(GC.derniereSync).toLocaleString('fr-FR') + ' · ' + gcalCache.length + ' événement(s) dont ' + gcalCache.filter(estCoursGoogle).length + ' cours' : 'Jamais synchronisé sur cet appareil'}</div>
        <label class="field" style="margin-top:12px"><span>Récupérer les événements depuis le</span>
          <input type="date" id="gc-since" value="${localStorage.getItem('gc_since') || GC_DEPUIS_DEFAUT}"></label>
        <label class="switch"><input type="checkbox" id="gc-journees" ${localStorage.getItem('gc_journees') !== '0' ? 'checked' : ''}>
          <span class="track"></span>
          <span class="lbl">Événements sur la journée entière<small>Les afficher aussi dans l\u2019agenda</small></span></label>

        <h2 class="section" style="margin-top:18px">Reconnaissance des cours</h2>
        <div class="sub">C\u2019est la <b>couleur</b> de l\u2019événement dans Google Agenda qui dit s\u2019il s\u2019agit d\u2019un cours, et où il a lieu. Les autres couleurs sont ignorées.</div>
        ${Object.entries(LIEUX).map(([cle, libelle]) => `
          <label class="field" style="margin-top:10px"><span>Couleur des cours « ${esc(libelle)} »</span>
            <select data-couleur="${cle}">
              <option value="">— aucune —</option>
              ${Object.entries(COULEURS_GOOGLE).map(([id, nom]) =>
                `<option value="${id}" ${couleursCours()[cle] === id ? 'selected' : ''}>${nom}</option>`).join('')}
            </select></label>`).join('')}
        <label class="switch"><input type="checkbox" id="gc-auto" ${localStorage.getItem('gc_auto') !== '0' ? 'checked' : ''}>
          <span class="track"></span>
          <span class="lbl">Rattacher les cours automatiquement<small>Quand le titre désigne un seul élève existant. Le cours reste « en attente » : tu le confirmes depuis sa fiche.</small></span></label>
        <label class="switch"><input type="checkbox" id="gc-seulement" ${seulementCours() ? 'checked' : ''}>
          <span class="track"></span>
          <span class="lbl">N\u2019afficher que les cours<small>Décoche pour voir aussi tes rendez-vous personnels dans l\u2019agenda.</small></span></label>
        <button class="btn secondary" id="gc-resync">Resynchroniser maintenant</button>
        ${GC.aReconnecter ? '' : `<button class="btn secondary" id="gc-reconnect">🔁 Reconnecter le compte Google</button>
          <div class="sub" style="margin-top:-4px">À faire après avoir publié l\u2019application dans la console Google : le jeton actuel garde sinon la limite de 7 jours du mode « Test ».</div>`}
        <button class="btn ghost" id="gc-diag">🔍 Diagnostic de la synchro</button>
        <div id="gc-diag-res"></div>
        ${ignores.size ? `<div class="sub" style="margin-top:10px">${ignores.size} événement(s) ignoré(s).</div>
          <button class="btn ghost" id="gc-unignore">Réafficher les événements ignorés</button>` : ''}
        <button class="btn danger" id="gc-off">Déconnecter</button>`
      : WORKER_URL ? `<div class="sub">Connecte le compte Google pour récupérer les événements.</div>
        <button class="btn" id="gc-on">Connecter Google Agenda</button>
        <button class="btn ghost" id="gc-diag">🔍 Diagnostic de la synchro</button>
        <div id="gc-diag-res"></div>`
        : `<div class="sub">Renseigne WORKER_URL dans js/config.js.</div>`}
    </div>`;
  bindBack();
  const on = $('#gc-on'); if (on) on.onclick = () => GC.connect();
  // Reconnexion volontaire : Google redemande le consentement et renvoie un jeton
  // neuf, qui remplace l'ancien. Inutile de se déconnecter d'abord.
  const re = $('#gc-reconnect'); if (re) re.onclick = () => GC.connect();
  const off = $('#gc-off'); if (off) off.onclick = async () => {
    if (!confirm('Déconnecter Google Agenda ?\n\nLes séances déjà rattachées sont conservées.')) return;
    await GC.disconnect(); renderSettings();
  };
  const jrs = $('#gc-journees');
  if (jrs) jrs.onchange = async e => {
    localStorage.setItem('gc_journees', e.target.checked ? '1' : '0');
    await GC.synchroniser(true); renderSettings();
  };
  view.querySelectorAll('[data-couleur]').forEach(sel => sel.onchange = async () => {
    const c = couleursCours();
    c[sel.dataset.couleur] = sel.value;
    // Deux lieux ne peuvent pas partager la même couleur : on libère l'autre.
    for (const k of Object.keys(c)) if (k !== sel.dataset.couleur && c[k] === sel.value && sel.value) c[k] = '';
    localStorage.setItem('gc_couleurs', JSON.stringify(c));
    toast('Couleur enregistrée ✓');
    await GC.synchroniser(true); renderSettings();
  });
  const auto = $('#gc-auto');
  if (auto) auto.onchange = async e => {
    localStorage.setItem('gc_auto', e.target.checked ? '1' : '0');
    if (e.target.checked) await GC.synchroniser(true);
    renderSettings();
  };
  const seul = $('#gc-seulement');
  if (seul) seul.onchange = e => {
    localStorage.setItem('gc_seulement_cours', e.target.checked ? '1' : '0');
    renderSettings();
  };
  const since = $('#gc-since');
  if (since) since.onchange = e => { localStorage.setItem('gc_since', e.target.value); toast('Date enregistrée ✓'); };
  const unign = $('#gc-unignore');
  if (unign) unign.onclick = async () => { await reafficherIgnores(); toast('Événements réaffichés ✓'); renderSettings(); };
  const diag = $('#gc-diag');
  if (diag) diag.onclick = async () => {
    diag.disabled = true; diag.textContent = 'Analyse…';
    const etapes = await GC.diagnostic();
    $('#gc-diag-res').innerHTML = `<div class="card" style="margin-top:10px">`
      + etapes.map(e => `<div style="margin-bottom:8px">
          <div class="title">${e.ok ? '✅' : '❌'} ${esc(e.nom)}</div>
          ${e.detail ? `<div class="sub">${esc(e.detail)}</div>` : ''}</div>`).join('')
      + `<div class="sub" style="margin-top:10px">La première ligne ❌ est la cause : c\u2019est celle-là qu\u2019il faut corriger.</div></div>`;
    diag.disabled = false; diag.textContent = '🔍 Diagnostic de la synchro';
  };

  const resync = $('#gc-resync');
  if (resync) resync.onclick = async () => {
    resync.disabled = true; resync.textContent = 'Synchronisation…';
    await GC.synchroniser();
    renderSettings();
  };
}

// --- Apparence ---
async function settingsApparence() {
  const riche = localStorage.getItem('effets') === '1';
  view.innerHTML = settingsBack('Apparence') + `<div class="card">
      <label class="switch"><input type="checkbox" id="ap-effets" ${riche ? 'checked' : ''}>
        <span class="track"></span>
        <span class="lbl">Effets de verre et scintillement<small>Flou derrière chaque carte et paillettes animées en continu. Très joli, mais le téléphone chauffe et la batterie descend plus vite, même quand tu ne fais que lire.</small></span></label>
      <div class="sub" style="margin-top:10px">En mode léger, le flou est conservé sur la barre du haut, la barre d\u2019onglets et les fenêtres : l\u2019aspect général ne change presque pas.</div>
    </div>`;
  bindBack();
  $('#ap-effets').onchange = e => {
    localStorage.setItem('effets', e.target.checked ? '1' : '0');
    appliquerApparence();
    toast(e.target.checked ? 'Effets complets ✓' : 'Mode léger ✓');
    renderSettings();
  };
}

// --- Sécurité ---
async function settingsSecurite() {
  const delays = [[0, 'Immédiat'], [60000, '1 minute'], [300000, '5 minutes'], [900000, '15 minutes'], [3600000, '1 heure'], [-1, 'Jamais']];
  view.innerHTML = settingsBack('Verrouillage') + `<div class="card">
      ${Lock.enabled ? '<span class="badge ok">Code actif</span>' : '<span class="badge warn">Aucun code</span>'}
      <label class="field" style="margin-top:12px"><span>Verrouiller après</span>
        <select id="lk-delay">${delays.map(([v, t]) => `<option value="${v}" ${Lock.delay === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <div class="sub">Le code est demandé à chaque lancement de l\u2019app. Le délai ci-dessus s\u2019applique aux retours depuis l\u2019arrière-plan.</div>
      <button class="btn secondary" id="lk-set">${Lock.enabled ? 'Changer le code' : 'Définir un code à 4 chiffres'}</button>
      ${Lock.enabled ? '<button class="btn secondary" id="lk-now">Verrouiller maintenant</button><button class="btn danger" id="lk-off">Désactiver le code</button>' : ''}
    </div>`;
  bindBack();
  $('#lk-delay').onchange = e => { Lock.delay = +e.target.value; toast('Délai enregistré ✓'); };
  $('#lk-set').onclick = () => sheetSetCode();
  const now = $('#lk-now'); if (now) now.onclick = () => Lock.show();
  const off = $('#lk-off'); if (off) off.onclick = () => { localStorage.removeItem('lock_hash'); toast('Code désactivé'); renderSettings(); };
}

// --- À propos ---
async function settingsApropos() {
  view.innerHTML = settingsBack('À propos') + `<div class="card" style="text-align:center">
      <img src="icons/bird.png" alt="" style="width:78px;margin:6px auto 10px;display:block">
      <div class="title" style="font-family:var(--serif);font-size:1.2rem">Loane Pro</div>
      <div class="sub">Version ${APP_VERSION}</div>
      <hr class="staff">
      <div class="sub">Agenda, élèves, heures effectuées, factures et répertoire.<br>
      Données stockées sur l\u2019appareil et sauvegardées dans le cloud.</div>
    </div>`;
  bindBack();
}

// --- Données & sauvegarde ---
async function settingsData() {
  const locales = {};
  for (const st of STORES) locales[st.key] = (await DB.all(st.key)).length;

  const lignes = STORES.map(st => {
    const loc = locales[st.key];
    const dist = cloudSnapshot ? (cloudSnapshot[st.key] || []).length : null;
    const etat = dist === null ? '<span class="sub">—</span>'
      : dist === loc ? '<span class="egal">=</span>'
        : `<span class="ecart">${dist > loc ? '+' : ''}${dist - loc}</span>`;
    return `<tr class="tap" data-store="${st.key}">
        <td>${st.label}</td><td class="num">${loc}</td>
        <td class="num">${dist === null ? '—' : dist}</td><td class="num">${etat}</td>
        <td class="chev">›</td></tr>`;
  }).join('');

  view.innerHTML = settingsBack('Sauvegarde cloud') + `
    <div class="card">
      ${WORKER_URL ? `
        <div class="sub">Phrase secrète (6 caractères min.). La sauvegarde part automatiquement à chaque modification.</div>
        <label class="field" style="margin-top:10px"><span>Phrase secrète</span>
          <input id="cl-pass" type="password" value="${esc(Cloud.pass)}"></label>
        <div class="row"><div class="grow sub">${Cloud.lastBackup ? 'Dernière sauvegarde : ' + new Date(Cloud.lastBackup).toLocaleString('fr-FR') : 'Jamais sauvegardé'}</div>
          ${Cloud.pending ? '<span class="badge warn">en attente</span>' : Cloud.lastBackup ? '<span class="badge ok">à jour</span>' : ''}</div>
        ${Cloud.derniereErreur ? `<div class="sub" style="color:var(--danger);margin-top:6px">⚠️ ${esc(Cloud.derniereErreur)}</div>` : ''}
        ${!Cloud.pass ? `<div class="sub" style="margin-top:6px">⚠️ Aucune phrase secrète : <b>rien n\u2019est sauvegardé dans le cloud</b>.</div>` : ''}
        ${Cloud.pass && Cloud.lastBackup && Date.now() - Cloud.lastBackup > 7 * 864e5 ? `<div class="sub" style="margin-top:6px">⚠️ Plus de 7 jours sans sauvegarde réussie.</div>` : ''}
        <button class="btn" id="cl-save">Sauvegarder maintenant</button>
        <button class="btn secondary" id="cl-restore">Restaurer depuis le cloud</button>`
      : `<div class="sub">Nécessite le Worker Cloudflare (WORKER_URL dans js/config.js).</div>`}
    </div>

    <h2 class="section">Contenu des données</h2>
    <div class="card">
      <table class="dtable">
        <tr><th>Catégorie</th><th class="num">Appareil</th><th class="num">Cloud</th><th class="num">Écart</th><th></th></tr>
        ${lignes}
      </table>
    </div>
    <div id="worker-etat"></div>
    <button class="btn secondary" id="cl-check">🔍 Comparer avec le cloud</button>
    <button class="btn ghost" id="cl-test">Tester l\u2019accès au cloud</button>
    ${cloudSnapshot ? '<div class="sub" style="text-align:center;margin-top:6px">Comparaison faite à l\u2019instant.</div>' : ''}

    <h2 class="section">Historique cloud</h2>
    <div class="card" id="hist-box"><div class="sub">Chargement…</div></div>

    <h2 class="section">Entretien</h2>
    <div class="card">
      <div class="sub">Un cours enregistré deux fois fausse les heures effectuées et le décompte des forfaits. Deux séances du même élève sur le même créneau sont forcément la même.</div>
      <button class="btn secondary" id="dbl-check">🧹 Chercher les doublons</button>
      <div id="dbl-res"></div>
    </div>

    <h2 class="section">Fichier de sauvegarde</h2>
    <div class="card">
      <button class="btn secondary" id="bk-export">Exporter (JSON)</button>
      <input type="file" id="bk-file" accept="application/json" hidden>
      <button class="btn secondary" id="bk-import">Restaurer un fichier</button>
    </div>`;
  bindBack();

  view.querySelectorAll('[data-store]').forEach(tr => tr.onclick = () => sheetStoreList(tr.dataset.store));
  dessineHistorique();
  etatWorker();

  const clSave = $('#cl-save');
  if (clSave) {
    clSave.onclick = async () => {
      const p = $('#cl-pass').value.trim();
      if (p.length < 6) { toast('6 caractères minimum'); return; }
      Cloud.pass = p; clSave.disabled = true; clSave.textContent = 'Sauvegarde…';
      const ok = await Cloud.backup(false);
      if (ok) { Cloud.pending = false; Cloud.essais = 0; }
      else if (Cloud.derniereErreur.startsWith('Envoi refusé') || Cloud.derniereErreur.startsWith('Base locale vide')) {
        if (confirm(Cloud.derniereErreur + '.\n\nForcer l\u2019envoi de la base de cet appareil (écrase le cloud) ?')) {
          if (await Cloud.backup(false, true)) { Cloud.pending = false; Cloud.essais = 0; }
        }
      }
      renderSettings();
    };
    $('#cl-restore').onclick = async () => {
      const p = $('#cl-pass').value.trim();
      if (p.length < 6) { toast('6 caractères minimum'); return; }
      Cloud.pass = p; await Cloud.restore();
    };
  }
  const test = $('#cl-test');
  if (test) test.onclick = async () => {
    if (!WORKER_URL) { toast('WORKER_URL manquant dans js/config.js'); return; }
    test.disabled = true; test.textContent = 'Test en cours…';
    const fini = m => { toast(m); test.disabled = false; test.textContent = 'Tester l\u2019accès au cloud'; };
    // 1) le worker répond-il, et dans quelle version ?
    const w = await Cloud.sonderWorker(true);
    if (!w.joignable) return fini('Worker injoignable (' + w.raison + ') — vérifie WORKER_URL et ALLOWED_ORIGIN');
    if (w.ajour) {
      if (!w.kv) return fini('Worker OK, mais le stockage KV (binding BACKUPS) manque');
      if (w.origines.length && !w.origines.includes(location.origin))
        return fini('ALLOWED_ORIGIN du worker ne contient pas ' + location.origin);
    }
    if (!Cloud.pass) return fini('Worker joignable · renseigne maintenant la phrase secrète');
    // 2) la phrase secrète donne-t-elle bien accès à une sauvegarde ?
    try {
      const r = await fetch(WORKER_URL + '/backup?meta=1', { headers: { 'X-Backup-Key': Cloud.pass } });
      if (r.status === 401) return fini('Phrase secrète refusée (6 caractères min.)');
      if (r.status === 404) return fini('Connexion OK, mais aucune sauvegarde pour cette phrase');
      if (r.status === 501) return fini('Stockage KV (binding BACKUPS) absent du worker');
      if (!r.ok) return fini('Réponse cloud : ' + r.status);
      const m = await Cloud.meta();
      if (!m) return fini('Connexion OK, mais aucune sauvegarde pour cette phrase');
      fini('Connexion OK · ' + m.count + ' enregistrement(s)'
        + (m.date ? ', le ' + new Date(m.date).toLocaleString('fr-FR') : '')
        + (w.ajour ? '' : ' · worker en ancienne version'));
    } catch (e) { console.error(e); fini('Connexion impossible (réseau / CORS)'); }
  };
  const check = $('#cl-check');
  if (check) check.onclick = async () => {
    if (!WORKER_URL || !Cloud.pass) { toast('Configure la phrase secrète'); return; }
    check.textContent = 'Lecture du cloud…';
    try {
      const r = await fetch(WORKER_URL + '/backup', { headers: { 'X-Backup-Key': Cloud.pass } });
      if (r.status === 404) { toast('Aucune sauvegarde dans le cloud'); cloudSnapshot = null; }
      else if (!r.ok) throw new Error();
      else { cloudSnapshot = await r.json(); toast('Comparaison effectuée ✓'); }
    } catch (e) { toast('Lecture impossible'); }
    renderSettings();
  };
  const dbl = $('#dbl-check');
  if (dbl) dbl.onclick = async () => {
    dbl.disabled = true; dbl.textContent = 'Analyse…';
    const lots = await trouverDoublons();
    const enTrop = lots.reduce((n, l) => n + l.length - 1, 0);
    const boite = $('#dbl-res');
    if (!enTrop) {
      boite.innerHTML = '<div class="sub" style="margin-top:10px">✅ Aucun doublon.</div>';
      dbl.disabled = false; dbl.textContent = '🧹 Chercher les doublons';
      return;
    }
    const eleves = Object.fromEntries((await DB.all('students')).map(e => [e.id, e.name]));
    boite.innerHTML = `<div class="sub" style="margin-top:10px;color:var(--danger)">⚠️ ${enTrop} séance(s) en double sur ${lots.length} créneau(x).</div>`
      + lots.slice(0, 5).map(l => `<div class="sub">· ${esc(eleves[l[0].studentId] || l[0].title || 'séance')} — ${fmtDateFull(l[0].date)} ${fmtTime(l[0].date)} (${l.length}×)</div>`).join('')
      + (lots.length > 5 ? `<div class="sub">· … et ${lots.length - 5} autre(s)</div>` : '')
      + `<button class="btn danger" id="dbl-go">Fusionner les ${enTrop} doublon(s)</button>`;
    $('#dbl-go').onclick = async () => {
      if (!confirm(`Fusionner ${enTrop} séance(s) en double ?\n\nLa plus complète est conservée (validée de préférence, avec sa note et son lien Google). Annulable avec ↺.`)) return;
      const n = await fusionnerDoublons(lots);
      toast(n + ' doublon(s) fusionné(s) ✓');
      renderSettings();
    };
    dbl.disabled = false; dbl.textContent = '🧹 Chercher les doublons';
  };
  $('#bk-export').onclick = async () => {
    const blob = new Blob([JSON.stringify(await DB.exportAll())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'loane-pro-sauvegarde-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
  };
  $('#bk-import').onclick = () => $('#bk-file').click();
  $('#bk-file').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      // Fichier choisi à la main : on remet tout en place, sans appliquer de suppression.
      const b = await DB.importAll(JSON.parse(await f.text()), { suppressions: false });
      localStorage.removeItem('cloud_sig');
      toast('Restauré : ' + b.importes + ' enregistrement(s) ✓'); renderSettings();
    }
    catch (err) { toast('Fichier invalide'); }
  };
}

// Signale une ancienne version du worker : la sauvegarde marche, mais le forçage
// et l'historique daté ne sont pas disponibles tant qu'il n'est pas remplacé.
async function etatWorker() {
  const box = $('#worker-etat'); if (!box || !WORKER_URL) return;
  const w = await Cloud.sonderWorker();
  if (w.ajour) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="card"><div class="title">${w.joignable ? '⚠️ Worker en ancienne version' : '⛔ Worker injoignable'}</div>
      <div class="sub">${w.joignable
        ? 'Les sauvegardes fonctionnent. Pour retrouver le forçage d\u2019envoi et l\u2019historique daté, recolle <b>worker/worker.js</b> dans Cloudflare → <b>Deploy</b>.'
        : esc(w.raison || '') + ' — vérifie WORKER_URL dans js/config.js et ALLOWED_ORIGIN côté worker.'}</div></div>`;
}

// ---- Doublons de séances -----------------------------------------------
// Un même cours a pu être enregistré deux fois si l'événement Google a changé
// d'identifiant entre deux synchros. Deux séances du même élève sur le même
// créneau sont forcément la même.
async function trouverDoublons() {
  const lecons = await DB.all('lessons');
  const paquets = new Map();
  for (const l of lecons) {
    const k = (l.studentId || l.title || '?') + '|' + (l.kind || 'cours');
    if (!paquets.has(k)) paquets.set(k, []);
    paquets.get(k).push(l);
  }
  const lots = [];
  for (const groupe of paquets.values()) {
    groupe.sort((a, b) => new Date(a.date) - new Date(b.date));
    let lot = [groupe[0]];
    for (let i = 1; i < groupe.length; i++) {
      if (Math.abs(new Date(groupe[i].date) - new Date(lot[0].date)) < TOLERANCE_CRENEAU * 60000) lot.push(groupe[i]);
      else { if (lot.length > 1) lots.push(lot); lot = [groupe[i]]; }
    }
    if (lot.length > 1) lots.push(lot);
  }
  return lots;
}

// On garde la séance la plus « riche » : validée de préférence, puis celle qui
// porte un identifiant Google, puis celle qui a une note.
function meilleureSeance(lot) {
  return lot.slice().sort((a, b) =>
    (estValide(b) - estValide(a))
    || ((b.gcalEventId ? 1 : 0) - (a.gcalEventId ? 1 : 0))
    || ((b.note || '').length - (a.note || '').length)
  )[0];
}

async function fusionnerDoublons(lots) {
  const supprimes = [];
  Undo.silence = true;
  try {
    for (const lot of lots) {
      const garde = meilleureSeance(lot);
      // on ne perd ni l'identifiant Google ni la note au passage
      let modifie = false;
      for (const l of lot) {
        if (l.id === garde.id) continue;
        if (!garde.gcalEventId && l.gcalEventId) { garde.gcalEventId = l.gcalEventId; modifie = true; }
        if (!garde.note && l.note) { garde.note = l.note; modifie = true; }
      }
      if (modifie) await DB.put('lessons', garde);
      for (const l of lot) {
        if (l.id === garde.id) continue;
        supprimes.push(l);
        await DB.del('lessons', l.id);
      }
    }
  } finally { Undo.silence = false; }
  if (supprimes.length) {
    Undo.ajouter(`fusion de ${supprimes.length} doublon(s)`, async () => {
      Undo.silence = true;
      try { for (const l of supprimes) await DB.put('lessons', l); }
      finally { Undo.silence = false; }
    });
  }
  return supprimes.length;
}

// Les 6 dernières versions conservées dans le cloud
async function dessineHistorique() {
  const box = $('#hist-box'); if (!box) return;
  if (!WORKER_URL || !Cloud.pass) { box.innerHTML = '<div class="sub">Phrase secrète non renseignée.</div>'; return; }
  const list = await Cloud.historique();
  if (!list.length) { box.innerHTML = '<div class="sub">Aucune version antérieure archivée pour l\u2019instant.</div>'; return; }
  box.innerHTML = `<div class="sub" style="margin-bottom:8px">Versions précédentes conservées automatiquement. En cas de fausse manœuvre, tu peux revenir à l\u2019une d\u2019elles.</div>`
    + list.map(h => `<div class="editrow">
        <div class="grow"><div class="title">${h.count} enregistrement(s)</div>
        <div class="sub">${new Date(h.date).toLocaleString('fr-FR')}</div></div>
        <button class="btn-inline" data-hist="${h.ts}">Restaurer</button></div>`).join('');
  box.querySelectorAll('[data-hist]').forEach(b => b.onclick = () => Cloud.restore(b.dataset.hist));
}

// Liste des enregistrements d'une catégorie
async function sheetStoreList(key) {
  const st = STORES.find(x => x.key === key);
  const rows = await DB.all(key);
  const dist = cloudSnapshot ? (cloudSnapshot[key] || []) : null;
  const distIds = dist ? new Set(dist.map(r => r.id)) : null;
  const locIds = new Set(rows.map(r => r.id));
  const manquants = dist ? dist.filter(r => !locIds.has(r.id)) : [];

  openSheet(`<h3>${st.label} (${rows.length})</h3>
    ${manquants.length ? `<div class="card accent"><div class="title">${manquants.length} présent(s) dans le cloud seulement</div>
      <div class="sub">Utilise « Restaurer depuis le cloud » pour les récupérer.</div></div>` : ''}
    ${rows.length ? rows.map(r => `<div class="card tappable row" data-rec="${r.id}">
        <div class="grow"><div class="title">${esc(String(st.sum(r) || r.id))}</div>
        <div class="sub">${esc(r.id)}${distIds && !distIds.has(r.id) ? ' · pas encore dans le cloud' : ''}</div></div>
        <div class="chev">›</div></div>`).join('')
      : '<div class="sub">Aucun enregistrement.</div>'}`);
  $('#sheet').querySelectorAll('[data-rec]').forEach(el => el.onclick = () => sheetRecord(key, el.dataset.rec));
}

// Fiche technique d'un enregistrement : contrôle et correction
async function sheetRecord(key, id) {
  const st = STORES.find(x => x.key === key);
  const rec = await DB.get(key, id);
  if (!rec) { toast('Introuvable'); return; }
  const court = JSON.parse(JSON.stringify(rec));
  if (court.photo) court.photo = '(photo)';
  if (court.files) court.files = `(${court.files.length} fichier(s))`;

  openSheet(`<h3>${st.label}</h3>
    <div class="sub" style="margin-bottom:10px">Modifie les valeurs si tu constates une erreur, puis enregistre. Le format doit rester du JSON valide.</div>
    <textarea id="rec-json" class="json-edit">${esc(JSON.stringify(court, null, 2))}</textarea>
    <button class="btn" id="rec-save">Enregistrer</button>
    <button class="btn danger" id="rec-del">Supprimer cet enregistrement</button>`);

  $('#rec-save').onclick = async () => {
    let obj;
    try { obj = JSON.parse($('#rec-json').value); }
    catch (e) { toast('JSON invalide : vérifie les virgules'); return; }
    if (obj.photo === '(photo)') obj.photo = rec.photo;                 // on ne perd pas la photo
    if (typeof obj.files === 'string') obj.files = rec.files;           // ni les partitions
    obj.id = rec.id;
    await DB.put(key, obj);
    closeSheet(); toast('Modifié ✓'); renderSettings();
  };
  $('#rec-del').onclick = async () => {
    if (!confirm('Supprimer définitivement cet enregistrement ?')) return;
    await DB.del(key, id);
    closeSheet(); toast('Supprimé'); renderSettings();
  };
}

async function drawCollectors() {
  const list = await DB.getSetting('collectors', DEFAULT_COLLECTORS);
  const box = $('#collectors-box'); if (!box) return;
  box.innerHTML = `<div class="sub" style="margin-bottom:6px">Personnes ou structures pouvant encaisser un règlement.</div>`
    + list.map((c, i) => `<div class="editrow"><div class="grow">${esc(c)}</div>
        <button class="icon-btn" data-del-c="${i}">✕</button></div>`).join('')
    + `<button class="btn secondary" id="add-collector">＋ Ajouter</button>`;
  box.querySelectorAll('[data-del-c]').forEach(b => b.onclick = async () => {
    if (list.length <= 1) { toast('Il en faut au moins un'); return; }
    const l2 = [...list]; l2.splice(+b.dataset.delC, 1);
    await DB.setSetting('collectors', l2); toast('Supprimé'); drawCollectors();
  });
  $('#add-collector').onclick = async () => {
    const name = prompt('Nom (ex. : Loane, École de chant) :');
    if (!name || !name.trim()) return;
    await DB.setSetting('collectors', [...list, name.trim()]);
    toast('Ajouté ✓'); drawCollectors();
  };
}

// --- Listes éditables : types de cours & forfaits ---
async function drawTypes() {
  const types = await DB.getSetting('courseTypes', DEFAULT_TYPES);
  const box = $('#types-box'); if (!box) return;
  box.innerHTML = types.map((t, i) => `<div class="editrow">
      <div class="grow">${esc(t)}</div>
      <button class="icon-btn" data-del-type="${i}" title="Supprimer">✕</button></div>`).join('')
    + `<button class="btn secondary" id="add-type">＋ Ajouter un type de cours</button>`;
  box.querySelectorAll('[data-del-type]').forEach(b => b.onclick = async () => {
    const list = [...types]; const removed = list.splice(+b.dataset.delType, 1)[0];
    await DB.setSetting('courseTypes', list); toast('« ' + removed + ' » supprimé'); drawTypes();
  });
  $('#add-type').onclick = () => {
    const name = prompt('Nom du type de cours :');
    if (!name || !name.trim()) return;
    DB.setSetting('courseTypes', [...types, name.trim()]).then(() => { toast('Ajouté ✓'); drawTypes(); });
  };
}

async function drawForfaits() {
  const forfaits = await DB.getSetting('forfaits', DEFAULT_FORFAITS);
  const box = $('#forfaits-box'); if (!box) return;
  box.innerHTML = forfaits.map((f, i) => `<div class="editrow">
      <div class="grow"><div class="title">${esc(f.label)}</div>
        <div class="sub">${forfaitHeures(f)} h · ${fmtMoney(f.price)}${f.validity ? ' · valable ' + f.validity + ' mois ' + (f.from === 'purchase' ? 'dès l\u2019achat' : f.from === 'unpaid' ? 'dès le 1er cours impayé' : 'dès le 1er cours') : ''}</div></div>
      <button class="icon-btn edit" data-edit-f="${i}" title="Modifier">✎</button>
      <button class="icon-btn" data-del-f="${i}" title="Supprimer">✕</button></div>`).join('')
    + `<button class="btn secondary" id="add-forfait">＋ Ajouter un forfait</button>
       <button class="btn secondary" id="reset-forfaits">Rétablir les tarifs par défaut</button>`;

  box.querySelectorAll('[data-del-f]').forEach(b => b.onclick = async () => {
    const f = forfaits[+b.dataset.delF];
    if (!confirm('Supprimer le forfait « ' + f.label + ' » ?\n\nLes paiements déjà enregistrés avec ce forfait ne sont pas modifiés.')) return;
    const list = [...forfaits]; list.splice(+b.dataset.delF, 1);
    await DB.setSetting('forfaits', list); toast('Forfait supprimé'); drawForfaits();
  });
  box.querySelectorAll('[data-edit-f]').forEach(b => b.onclick = () => sheetForfait(+b.dataset.editF));
  $('#add-forfait').onclick = () => sheetForfait(null);
  $('#reset-forfaits').onclick = async () => {
    if (!confirm('Rétablir la liste de tarifs par défaut ?')) return;
    await DB.setSetting('forfaits', DEFAULT_FORFAITS); toast('Tarifs rétablis ✓'); drawForfaits();
  };
}

async function sheetForfait(index) {
  const forfaits = await DB.getSetting('forfaits', DEFAULT_FORFAITS);
  const f = index === null ? { label: '', hours: 1, price: 0, validity: 2, from: 'first' } : forfaits[index];
  openSheet(`
    <h3>${index === null ? 'Nouveau forfait' : 'Modifier le forfait'}</h3>
    <label class="field"><span>Libellé</span><input id="ff-label" value="${esc(f.label)}"></label>
    <div class="field-row">
      <label class="field"><span>Heures incluses</span><input type="number" step="0.5" id="ff-hours" value="${forfaitHeures(f)}"></label>
      <label class="field"><span>Prix</span><input type="number" id="ff-price" value="${f.price}"></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Validité (mois)</span><input type="number" id="ff-valid" value="${f.validity || 0}"></label>
      <label class="field"><span>Départ validité</span>
        <select id="ff-from">
          <option value="first" ${!['purchase', 'unpaid'].includes(f.from) ? 'selected' : ''}>1er cours</option>
          <option value="purchase" ${f.from === 'purchase' ? 'selected' : ''}>date d\u2019achat</option>
          <option value="unpaid" ${f.from === 'unpaid' ? 'selected' : ''}>1er cours impayé</option>
        </select></label>
    </div>
    <button class="btn" id="ff-save">Enregistrer</button>
    ${index === null ? '' : '<button class="btn danger" id="ff-del">Supprimer ce forfait</button>'}
  `);
  $('#ff-save').onclick = async () => {
    const label = $('#ff-label').value.trim();
    if (!label) { toast('Le libellé est obligatoire'); return; }
    const item = { label, hours: +$('#ff-hours').value || 1, price: +$('#ff-price').value || 0,
                   validity: +$('#ff-valid').value || 0, from: $('#ff-from').value };
    const list = [...forfaits];
    if (index === null) list.push(item); else list[index] = item;
    await DB.setSetting('forfaits', list);
    closeSheet(); toast('Forfait enregistré ✓'); drawForfaits();
  };
  if (index !== null) $('#ff-del').onclick = async () => {
    const list = [...forfaits]; list.splice(index, 1);
    await DB.setSetting('forfaits', list);
    closeSheet(); toast('Forfait supprimé'); drawForfaits();
  };
}

function sheetSetCode() {
  openSheet(`<h3>Code d\u2019accès</h3>
    <label class="field"><span>Nouveau code (4 chiffres)</span><input id="pc1" type="tel" inputmode="numeric" maxlength="4" placeholder="••••"></label>
    <label class="field"><span>Confirmer</span><input id="pc2" type="tel" inputmode="numeric" maxlength="4" placeholder="••••"></label>
    <button class="btn" id="pc-save">Enregistrer le code</button>
    <div class="sub" style="text-align:center;margin-top:8px">Note-le : sans lui, l\u2019app se réinstalle mais la sauvegarde cloud reste accessible.</div>`);
  $('#pc-save').onclick = async () => {
    const a = $('#pc1').value.trim(), b = $('#pc2').value.trim();
    if (!/^\d{4}$/.test(a)) { toast('4 chiffres attendus'); return; }
    if (a !== b) { toast('Les codes diffèrent'); return; }
    localStorage.setItem('lock_hash', await Lock.hash(a));
    Lock.touch(); closeSheet(); toast('Code enregistré ✓'); renderSettings();
  };
}

// ====== Démarrage ======
function ecranPanne(msg, detail) {
  const sp = document.getElementById('splash'); if (sp) sp.remove();
  document.getElementById('view').innerHTML = `<div class="card accent" style="margin-top:20px">
      <div class="title">${msg}</div><div class="sub">${detail}</div></div>`;
}

(async function start() {
  $('#splash-version').textContent = 'v' + APP_VERSION;
  // Si la base ne s'ouvre pas, mieux vaut le dire que rester bloqué sur l'écran de lancement.
  try { await DB.all('settings'); }
  catch (e) {
    console.error('ouverture base', e);
    return ecranPanne('Base de données inaccessible',
      e && e.message === 'base_bloquee'
        ? 'L\u2019app est ouverte dans une autre fenêtre ou un autre onglet. Ferme-les toutes, puis rouvre l\u2019app.'
        : 'Le navigateur refuse l\u2019accès au stockage (navigation privée ?).');
  }
  // Les identifiants d'abord : sans eux la synchro Google et le cloud restent muets.
  await Creds.charger();
  CURRENCY = await DB.getSetting('currency', 'XPF');
  await chargerIgnores();
  // Événements Google de la dernière synchro : l'agenda est complet dès l'ouverture,
  // même hors ligne (avant, il fallait attendre le réseau et tout était vide sans lui).
  gcalCache = await GC.chargerCache();
  GC.handleCallback();
  Lock.init();
  $('#topbar-undo').onclick = () => Undo.annuler();
  switchTab('agenda');
  Cloud.auto();

  setTimeout(() => {
    $('#splash').classList.add('hide');
    setTimeout(() => $('#splash').remove(), 500);
  }, 1250);

  // rappel discret s'il reste des séances à confirmer
  setTimeout(async () => {
    const n = (await DB.all('lessons')).filter(enAttente).length;
    if (n) toast(n + ' séance' + (n > 1 ? 's' : '') + ' à valider');
  }, 2600);

  if (GC.connected) {
    GC.synchroniser(true).then(() => { if (currentTab === 'agenda' || currentTab === 'hours') refreshView(); });
  }

  // Retour au premier plan : on rafraîchit l'agenda Google au plus une fois par heure
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !GC.connected) return;
    if (Date.now() - GC.derniereSync < 3600 * 1000) return;
    if (await GC.synchroniser(true)) { if (currentTab === 'agenda' || currentTab === 'hours') refreshView(); }
  });
})();
