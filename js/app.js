// ====== Loane Pro ======
const APP_VERSION = '2.6.0';

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
  cours: { label: 'Cours', icon: '🎤', student: true, paid: true },
  repetition: { label: 'Répétition', icon: '🎹', student: false, paid: false },
  concert: { label: 'Concert', icon: '🎭', student: false, paid: true },
  autre: { label: 'Autre', icon: '📌', student: false, paid: false }
};

// ====== Réglages par défaut ======
const DEFAULT_FORFAITS = [
  { label: "Cours à l\u2019unité", lessons: 1, price: 5000, validity: 2, from: 'first' },
  { label: "Forfait 4 cours ancien élève", lessons: 4, price: 18000, validity: 2, from: 'first' },
  { label: "Forfait 4 cours nouvel élève Do", lessons: 4, price: 20000, validity: 2, from: 'first' },
  { label: "Cours à l\u2019unité hors forfait Do", lessons: 1, price: 6000, validity: 2, from: 'first' },
  { label: "Bon cadeau 1 cours", lessons: 1, price: 5000, validity: 6, from: 'purchase' },
  { label: "Bon cadeau 4 cours", lessons: 4, price: 18000, validity: 6, from: 'purchase' },
  { label: "Bon cadeau 8 cours", lessons: 8, price: 36000, validity: 6, from: 'purchase' }
];
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
  shouldLock() {
    if (!this.enabled) return false;
    if (this.delay < 0) return false;                       // jamais
    const seen = +(localStorage.getItem('lock_seen') || 0);
    return Date.now() - seen > this.delay;
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
    if (this.shouldLock()) this.show(); else this.touch();
  }
};

// ====== Google Agenda ======
const GC = {
  get connected() { return !!localStorage.getItem('gc_refresh'); },
  connect() {
    if (!WORKER_URL) { toast('Configure d\u2019abord WORKER_URL'); return; }
    location.href = WORKER_URL + '/auth/start?redirect=' + encodeURIComponent(location.origin + location.pathname);
  },
  disconnect() { ['gc_refresh', 'gc_access', 'gc_expiry'].forEach(k => localStorage.removeItem(k)); },
  handleCallback() {
    if (location.hash.startsWith('#gc=')) {
      try {
        const tok = JSON.parse(atob(decodeURIComponent(location.hash.slice(4))));
        if (tok.refresh_token) localStorage.setItem('gc_refresh', tok.refresh_token);
        localStorage.setItem('gc_access', tok.access_token);
        localStorage.setItem('gc_expiry', Date.now() + (tok.expires_in - 60) * 1000);
        toast('Google Agenda connecté ✓');
      } catch (e) { console.error(e); }
      history.replaceState(null, '', location.pathname);
    }
  },
  async token() {
    if (Date.now() < +(localStorage.getItem('gc_expiry') || 0)) return localStorage.getItem('gc_access');
    const r = await fetch(WORKER_URL + '/auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: localStorage.getItem('gc_refresh') })
    });
    if (!r.ok) throw new Error('refresh failed');
    const tok = await r.json();
    localStorage.setItem('gc_access', tok.access_token);
    localStorage.setItem('gc_expiry', Date.now() + (tok.expires_in - 60) * 1000);
    return tok.access_token;
  },
  async api(path, opts = {}) {
    const t = await this.token();
    const r = await fetch('https://www.googleapis.com/calendar/v3' + path, {
      ...opts, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    if (r.status === 204) return null;
    if (!r.ok) throw new Error('Google API ' + r.status);
    return r.json();
  },
  async pushLesson(item, student) {
    if (!this.connected) return item;
    const start = new Date(item.date);
    const end = new Date(start.getTime() + (item.duration || 60) * 60000);
    const k = KINDS[item.kind || 'cours'];
    const who = student ? student.name : (item.title || k.label);
    const body = {
      summary: k.icon + ' ' + who + (item.kind === 'cours' || !item.kind ? ' — ' + (item.type || 'Cours de chant') : ''),
      description: item.note || '',
      start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() }
    };
    try {
      if (item.gcalEventId) await this.api('/calendars/primary/events/' + item.gcalEventId, { method: 'PATCH', body: JSON.stringify(body) });
      else {
        const ev = await this.api('/calendars/primary/events', { method: 'POST', body: JSON.stringify(body) });
        item.gcalEventId = ev.id;
      }
    } catch (e) { console.warn('sync gcal', e); toast('Synchro Google impossible'); }
    return item;
  },
  async deleteLesson(item) {
    if (!this.connected || !item.gcalEventId) return;
    try { await this.api('/calendars/primary/events/' + item.gcalEventId, { method: 'DELETE' }); } catch (e) { }
  },
  async pullEvents() {
    if (!this.connected) return [];
    const min = new Date(Date.now() - 120 * 864e5).toISOString();
    const max = new Date(Date.now() + 120 * 864e5).toISOString();
    const data = await this.api(`/calendars/primary/events?timeMin=${min}&timeMax=${max}&singleEvents=true&orderBy=startTime&maxResults=800`);
    return (data.items || []).filter(e => e.start && e.start.dateTime);
  }
};

// ====== Sauvegarde cloud ======
const Cloud = {
  get pass() { return localStorage.getItem('cloud_pass') || ''; },
  set pass(v) { v ? localStorage.setItem('cloud_pass', v) : localStorage.removeItem('cloud_pass'); },
  get lastBackup() { return +(localStorage.getItem('cloud_last') || 0); },
  async backup(silent) {
    if (!WORKER_URL || !this.pass) { if (!silent) toast('Configure la phrase secrète'); return false; }
    try {
      const r = await fetch(WORKER_URL + '/backup', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Backup-Key': this.pass },
        body: JSON.stringify(await DB.exportAll())
      });
      if (!r.ok) throw new Error(await r.text());
      localStorage.setItem('cloud_last', Date.now());
      if (!silent) toast('Sauvegardé dans le cloud ✓');
      return true;
    } catch (e) { if (!silent) toast('Échec de la sauvegarde'); return false; }
  },
  async restore() {
    if (!WORKER_URL || !this.pass) { toast('Renseigne la phrase secrète'); return; }
    if (!confirm('Restaurer la sauvegarde cloud ?')) return;
    try {
      const r = await fetch(WORKER_URL + '/backup', { headers: { 'X-Backup-Key': this.pass } });
      if (r.status === 404) { toast('Aucune sauvegarde trouvée'); return; }
      if (!r.ok) throw new Error();
      await DB.importAll(await r.json());
      toast('Sauvegarde restaurée ✓'); TABS[currentTab].render();
    } catch (e) { toast('Échec de la restauration'); }
  },
  auto() {
    if (WORKER_URL && this.pass && Date.now() - this.lastBackup > 24 * 3600 * 1000) setTimeout(() => this.backup(true), 5000);
  }
};

// ====== Utilitaires métier ======
async function lessonsOf(studentId) {
  const ls = await DB.byStudent('lessons', studentId);
  return ls.sort((a, b) => new Date(a.date) - new Date(b.date));
}
function addMonths(d, m) { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; }

// État des paiements + validité des forfaits
async function paymentStatus(student) {
  const lessons = (await lessonsOf(student.id)).filter(l => (l.kind || 'cours') === 'cours');
  const payments = (await DB.byStudent('payments', student.id)).sort((a, b) => new Date(b.date) - new Date(a.date));
  const now = Date.now();
  const done = lessons.filter(l => new Date(l.date) <= now);
  const last = payments[0];
  if (!last) return { last: null, due: done.length > 0, remaining: -done.length, expiry: null, expired: false };

  const used = done.filter(l => new Date(l.date) > new Date(last.date)).length;
  const remaining = (last.lessonsCovered || 1) - used;

  // Validité : depuis l'achat (bon cadeau) ou depuis le 1er cours du forfait
  let expiry = null;
  const months = last.validityMonths || 0;
  if (months) {
    if (last.validityFrom === 'purchase') expiry = addMonths(last.date, months);
    else {
      const first = lessons.find(l => new Date(l.date) > new Date(last.date));
      expiry = first ? addMonths(first.date, months) : null;   // null = pas encore démarré
    }
  }
  const expired = expiry ? Date.now() > expiry.getTime() : false;
  return { last, due: remaining <= 0 || expired, remaining, expiry, expired, notStarted: months && !expiry };
}

// ====== Navigation ======
let currentTab = 'agenda';
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
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const t = TABS[tab];
  $('#page-title').textContent = t.title;
  const act = $('#topbar-action');
  act.hidden = !t.action; act.onclick = t.action;
  t.render();
}

// ====== AGENDA ======
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
  const students = Object.fromEntries((await DB.all('students')).map(s => [s.id, s]));
  const items = lessons.map(l => ({
    date: l.date, lesson: l, kind: l.kind || 'cours',
    label: (students[l.studentId] ? students[l.studentId].name : (l.title || KINDS[l.kind || 'cours'].label))
  }));
  for (const e of gcalCache) {
    if (!linked.has(e.id)) items.push({ date: e.start.dateTime, gcal: e, kind: 'gcal', label: e.summary || '(sans titre)' });
  }
  return items.sort((a, b) => new Date(a.date) - new Date(b.date));
}

function itemCard(it) {
  if (it.gcal) return `<div class="card tappable row" data-gcal="${it.gcal.id}">
      <div class="lesson-time">${fmtTime(it.date)}</div>
      <div class="grow"><div class="title">${esc(it.label)}</div>
      <div class="sub"><span class="gcal-dot">●</span> Google · toucher pour rattacher</div></div>
      <div class="chev">›</div></div>`;
  const l = it.lesson, k = KINDS[it.kind];
  return `<div class="card tappable row" data-lesson="${l.id}">
      <div class="lesson-time">${fmtTime(it.date)}</div>
      <div class="grow"><div class="title">${k.icon} ${esc(it.label)}</div>
      <div class="sub">${esc(l.type || k.label)} · ${l.duration || 60} min ${l.gcalEventId ? '<span class="gcal-dot">● Google</span>' : ''}</div></div>
      <div class="chev">›</div></div>`;
}

async function renderAgenda() {
  const items = await agendaItems();
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

  if (GC.connected) {
    html += `<button class="btn secondary" id="btn-sync">🔄 Synchroniser Google Agenda</button>`;
    const past = gcalCache.filter(e => new Date(e.start.dateTime) < new Date(new Date().toDateString()))
      .filter(e => !items.some(i => i.lesson && i.lesson.gcalEventId === e.id));
    if (past.length) html += `<div class="card accent tappable" id="past-import" style="margin-top:12px">
        <div class="title">📥 ${past.length} événement${past.length > 1 ? 's' : ''} passé${past.length > 1 ? 's' : ''} à rattacher</div>
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
    sync.textContent = 'Synchronisation…';
    try { gcalCache = await GC.pullEvents(); toast('Agenda synchronisé ✓'); } catch (e) { toast('Échec de la synchro'); }
    renderAgenda();
  };
  const conn = $('#btn-gc-connect'); if (conn) conn.onclick = () => GC.connect();
  const pastBtn = $('#past-import');
  if (pastBtn) pastBtn.onclick = () => sheetPastList(gcalCache.filter(e => new Date(e.start.dateTime) < new Date(new Date().toDateString())));
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

// Délégation : fiable même après re-rendu
view.addEventListener('click', e => {
  const gEl = e.target.closest('[data-gcal]');
  if (gEl) {
    const ev = gcalCache.find(x => x.id === gEl.dataset.gcal);
    if (ev) sheetImportGcal(ev); else toast('Événement introuvable, resynchronise');
    return;
  }
  const lEl = e.target.closest('[data-lesson]');
  if (lEl) sheetLesson(lEl.dataset.lesson);
});

// Liste des événements Google passés non rattachés
function sheetPastList(events) {
  openSheet(`<h3>Événements passés à rattacher</h3>
    <div class="sub" style="margin-bottom:10px">Rattache-les pour les compter dans les heures effectuées et dans le profil des élèves.</div>
    ${events.slice().reverse().map(e => `<div class="card tappable row" data-past="${e.id}">
      <div class="grow"><div class="title">${esc(e.summary || '(sans titre)')}</div>
      <div class="sub">${fmtDate(e.start.dateTime)} · ${fmtTime(e.start.dateTime)}</div></div>
      <div class="chev">›</div></div>`).join('')}`);
  $('#sheet').querySelectorAll('[data-past]').forEach(el => el.onclick = () => {
    const ev = events.find(x => x.id === el.dataset.past);
    if (ev) sheetImportGcal(ev);
  });
}

// Convertir un événement Google en séance
async function sheetImportGcal(ev) {
  const students = await DB.all('students');
  const { courseTypes } = await getConfig();
  const start = new Date(ev.start.dateTime);
  const end = ev.end && ev.end.dateTime ? new Date(ev.end.dateTime) : new Date(start.getTime() + 3600000);
  const dur = Math.max(15, Math.round((end - start) / 60000));
  const t = (ev.summary || '').toLowerCase();
  const guess = students.find(s => t.includes(s.name.toLowerCase().split(' ')[0]));
  const kindGuess = /rep|répét|repet/.test(t) ? 'repetition' : /concert|spectacle|scène/.test(t) ? 'concert' : 'cours';

  openSheet(`
    <h3>Rattacher cet événement</h3>
    <div class="card"><div class="title">${esc(ev.summary || '(sans titre)')}</div>
      <div class="sub">${fmtDate(start)} · ${fmtTime(start)} — ${dur} min</div></div>
    <label class="field"><span>Nature</span>
      <select id="f-kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${k === kindGuess ? 'selected' : ''}>${v.icon} ${v.label}</option>`).join('')}</select></label>
    <div id="student-box">
      <label class="field"><span>Élève</span>
        <select id="f-student">${students.map(s => `<option value="${s.id}" ${guess && guess.id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        ${students.length ? '' : '<option value="">(aucun élève créé)</option>'}</select></label>
      <label class="field"><span>Type de cours</span>
        <select id="f-type">${courseTypes.map(x => `<option>${esc(x)}</option>`).join('')}</select></label>
    </div>
    <div id="fee-box" hidden><label class="field"><span>Cachet / rémunération</span><input type="number" id="f-fee" value="0"></label></div>
    <button class="btn" id="f-import">Rattacher</button>
  `);
  const refresh = () => {
    const k = $('#f-kind').value;
    $('#student-box').hidden = k !== 'cours';
    $('#fee-box').hidden = !(k === 'concert' || k === 'autre');
  };
  $('#f-kind').onchange = refresh; refresh();

  $('#f-import').onclick = async () => {
    const kind = $('#f-kind').value;
    if (kind === 'cours' && !students.length) { toast('Crée d\u2019abord un élève'); return; }
    await DB.put('lessons', {
      id: DB.uid(), kind,
      studentId: kind === 'cours' ? $('#f-student').value : '',
      title: kind === 'cours' ? '' : (ev.summary || KINDS[kind].label),
      date: start.toISOString(), duration: dur,
      type: kind === 'cours' ? $('#f-type').value : KINDS[kind].label,
      fee: $('#f-fee') ? +$('#f-fee').value || 0 : 0,
      note: ev.description || '', gcalEventId: ev.id
    });
    gcalCache = gcalCache.filter(x => x.id !== ev.id);
    closeSheet(); toast('Rattaché ✓'); TABS[currentTab].render();
  };
}

// Créer / modifier une séance
async function sheetLesson(id, presetStudent, presetKind) {
  const students = await DB.all('students');
  const { courseTypes } = await getConfig();
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
        <select id="f-type">${courseTypes.map(t => `<option ${l && l.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
    </div>
    <div id="title-box" hidden><label class="field"><span>Intitulé</span><input id="f-title" value="${esc(l ? l.title : '')}" placeholder="Répétition, concert…"></label></div>
    <div class="field-row">
      <label class="field"><span>Date</span><input type="date" id="f-date" value="${d.toISOString().slice(0, 10)}"></label>
      <label class="field"><span>Heure</span><input type="time" id="f-time" value="${d.toTimeString().slice(0, 5)}"></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Durée (min)</span><input type="number" id="f-dur" value="${l ? l.duration : 60}"></label>
      <label class="field" id="fee-box"><span>Cachet</span><input type="number" id="f-fee" value="${l ? (l.fee || 0) : 0}"></label>
    </div>
    <label class="field"><span>Note</span><input id="f-note" value="${esc(l ? l.note : '')}"></label>
    <button class="btn" id="f-save">${l ? 'Enregistrer' : 'Ajouter'}</button>
    ${l ? '<button class="btn danger" id="f-del">Supprimer</button>' : ''}
  `);
  const refresh = () => {
    const k = $('#f-kind').value;
    $('#student-box').hidden = k !== 'cours';
    $('#title-box').hidden = k === 'cours';
    $('#fee-box').style.display = (k === 'concert' || k === 'autre') ? '' : 'none';
  };
  $('#f-kind').onchange = refresh; refresh();

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
    item.fee = (k === 'concert' || k === 'autre') ? (+$('#f-fee').value || 0) : 0;
    item.note = $('#f-note').value;
    await GC.pushLesson(item, k === 'cours' ? await DB.get('students', item.studentId) : null);
    await DB.put('lessons', item);
    closeSheet(); toast('Enregistré ✓'); TABS[currentTab].render();
  };
  if (l) $('#f-del').onclick = async () => {
    await GC.deleteLesson(l); await DB.del('lessons', l.id);
    closeSheet(); toast('Supprimé'); TABS[currentTab].render();
  };
}

// ====== HEURES EFFECTUÉES ======
let hoursRange = 'month';
async function renderHours() {
  const all = (await DB.all('lessons')).filter(l => new Date(l.date) <= Date.now())
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

  let html = `
    <div class="stat-grid">
      <div class="stat hi"><b>${fmtHours(weekMin)}</b><span>cette semaine</span></div>
      <div class="stat hi"><b>${fmtHours(monthMin)}</b><span>ce mois-ci</span></div>
      <div class="stat"><b>${fmtHours(avgWeek)}</b><span>moyenne / semaine</span></div>
      <div class="stat"><b>${fmtHours(avgMonth)}</b><span>moyenne / mois</span></div>
    </div>
    <div class="seg">
      <button data-range="week" class="${hoursRange === 'week' ? 'on' : ''}">Semaine</button>
      <button data-range="month" class="${hoursRange === 'month' ? 'on' : ''}">Mois</button>
      <button data-range="all" class="${hoursRange === 'all' ? 'on' : ''}">Tout</button>
    </div>`;

  if (Object.keys(byKind).length) {
    html += `<div class="card"><div class="sub" style="margin-bottom:6px">Répartition · total ${fmtHours(mins(inRange))}</div>
      ${Object.entries(byKind).map(([k, m]) => `<div class="row" style="padding:3px 0">
        <div class="grow">${KINDS[k].icon} ${KINDS[k].label}</div><div class="title">${fmtHours(m)}</div></div>`).join('')}
      ${revenue ? `<hr class="staff"><div class="row"><div class="grow title">Cachets encaissés</div><div class="title" style="color:var(--orange)">${fmtMoney(revenue)}</div></div>` : ''}
    </div>`;
  }

  html += `<button class="btn secondary" id="add-act">＋ Ajouter une répétition / un concert</button>`;

  if (!inRange.length) html += `<div class="empty"><div class="big">⏱️</div><div class="empty-title">Aucune séance</div>Rien sur la période choisie.</div>`;
  else {
    html += `<h2 class="section">Détail (${inRange.length})</h2>`;
    let curDay = '';
    for (const l of inRange) {
      const key = new Date(l.date).toDateString();
      if (key !== curDay) { curDay = key; html += `<div class="day-head">${fmtDate(l.date)}</div>`; }
      const k = KINDS[l.kind || 'cours'];
      const s = students[l.studentId];
      html += `<div class="card tappable row" data-lesson="${l.id}">
        <div class="lesson-time">${fmtTime(l.date)}</div>
        <div class="grow"><div class="title">${k.icon} ${esc(s ? s.name : (l.title || k.label))}</div>
        <div class="sub">${fmtHours(l.duration || 60)}${l.fee ? ' · ' + fmtMoney(l.fee) : ''}</div></div>
        <div class="chev">›</div></div>`;
    }
  }
  view.innerHTML = html;
  view.querySelectorAll('[data-range]').forEach(b => b.onclick = () => { hoursRange = b.dataset.range; renderHours(); });
  $('#add-act').onclick = () => sheetLesson(null, null, 'repetition');
}

// ====== ÉLÈVES ======
async function renderStudents() {
  const students = (await DB.all('students')).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  if (!students.length) {
    view.innerHTML = `<div class="empty"><div class="big">🎤</div><div class="empty-title">Aucun élève</div>Touche ＋ pour créer un profil.</div>`;
    return;
  }
  let html = '';
  for (const s of students) {
    const st = await paymentStatus(s);
    let badge;
    if (!st.last) badge = '<span class="badge due">À encaisser</span>';
    else if (st.expired) badge = '<span class="badge due">Forfait expiré</span>';
    else if (st.remaining <= 0) badge = '<span class="badge due">À encaisser</span>';
    else badge = `<span class="badge ok">${st.remaining} cours</span>`;
    html += `<div class="card tappable row" data-student="${s.id}">
      ${s.photo ? `<img class="avatar" src="${s.photo}">` : `<div class="avatar">${initials(s.name)}</div>`}
      <div class="grow"><div class="title">${esc(s.name)}</div>
      <div class="sub">${st.last ? (st.expiry ? 'Valable jusqu\u2019au ' + fmtDateFull(st.expiry) : 'Forfait non démarré') : 'Aucun paiement'}</div></div>
      <div class="right">${badge}</div><div class="chev">›</div></div>`;
  }
  view.innerHTML = html;
  view.querySelectorAll('[data-student]').forEach(el => el.onclick = () => renderStudentDetail(el.dataset.student));
}

async function renderStudentDetail(id) {
  const s = await DB.get('students', id);
  if (!s) return renderStudents();
  const allItems = await lessonsOf(id);
  const lessons = allItems.filter(l => (l.kind || 'cours') === 'cours');
  const now = Date.now();
  const past = lessons.filter(l => new Date(l.date) <= now).reverse();
  const next = lessons.filter(l => new Date(l.date) > now);
  const payments = (await DB.byStudent('payments', id)).sort((a, b) => new Date(b.date) - new Date(a.date));
  const notes = (await DB.byStudent('notes', id)).sort((a, b) => new Date(b.date) - new Date(a.date));
  const st = await paymentStatus(s);
  const totalMin = lessons.filter(l => new Date(l.date) <= now).reduce((a, l) => a + (l.duration || 60), 0);

  view.innerHTML = `
    <button class="btn-inline" id="back">‹ Élèves</button>
    <div class="card" style="text-align:center;margin-top:12px">
      ${s.photo ? `<img class="avatar big" src="${s.photo}" style="margin:0 auto">` : `<div class="avatar big" style="margin:0 auto">${initials(s.name)}</div>`}
      <h3 style="margin-top:8px;font-size:1.3rem">${esc(s.name)}</h3>
      <div class="sub">${esc([s.phone, s.email].filter(Boolean).join(' · '))}</div>
      <div style="margin-top:8px">
        ${st.expired ? '<span class="badge due">Forfait expiré</span>'
      : st.remaining > 0 ? `<span class="badge ok">${st.remaining} cours restant${st.remaining > 1 ? 's' : ''}</span>`
        : '<span class="badge due">Paiement attendu</span>'}
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
      ${s.level ? `<div><span class="tag g">Niveau</span> ${esc(s.level)}</div>` : ''}
      ${s.strengths ? `<div style="margin-top:6px"><span class="tag">Points forts</span> ${esc(s.strengths)}</div>` : ''}
      ${s.difficulties ? `<div style="margin-top:6px"><span class="tag">Difficultés</span> ${esc(s.difficulties)}</div>` : ''}
      ${!s.level && !s.strengths && !s.difficulties ? '<div class="sub">À renseigner via « Modifier le profil ».</div>' : ''}
    </div>

    <h2 class="section">Notes de cours</h2>
    <button class="btn secondary" id="add-note" style="margin-top:0">＋ Ajouter une note</button>
    ${notes.map(n => `<div class="card note" data-note="${n.id}"><div class="sub">${fmtDateFull(n.date)}</div><p>${esc(n.text)}</p></div>`).join('') || '<div class="sub" style="padding:6px">Aucune note.</div>'}

    <h2 class="section">Paiements</h2>
    <button class="btn secondary" id="add-pay" style="margin-top:0">＋ Enregistrer un paiement</button>
    ${payments.map(p => `<div class="card row"><div class="grow"><div class="title">${fmtMoney(p.amount)} — ${p.lessonsCovered} cours</div>
      <div class="sub">${esc(p.label || '')} · ${fmtDateFull(p.date)}${p.method ? ' · ' + esc(p.method) : ''}</div></div>
      ${p.collectedBy ? `<span class="badge ghost">${esc(p.collectedBy)}</span>` : ''}</div>`).join('')}

    <h2 class="section">Prochains cours</h2>
    <button class="btn secondary" id="add-lesson" style="margin-top:0">＋ Planifier un cours</button>
    ${next.map(l => `<div class="card tappable row" data-lesson="${l.id}"><div class="lesson-time">${fmtDate(l.date)}<br><span class="sub">${fmtTime(l.date)}</span></div><div class="grow sub">${esc(l.type || '')}</div><div class="chev">›</div></div>`).join('') || '<div class="sub" style="padding:6px">Aucun cours planifié.</div>'}

    <h2 class="section">Cours effectués (${past.length})</h2>
    ${past.map(l => `<div class="card tappable row" data-lesson="${l.id}"><div class="lesson-time">${fmtDate(l.date)}</div><div class="grow sub">${esc(l.type || '')}${l.note ? ' — ' + esc(l.note) : ''}</div></div>`).join('') || '<div class="sub" style="padding:6px">Aucun cours passé.</div>'}
  `;
  $('#back').onclick = renderStudents;
  $('#edit-student').onclick = () => sheetStudent(id);
  $('#add-lesson').onclick = () => sheetLesson(null, id);
  $('#add-pay').onclick = () => sheetPayment(id);
  $('#add-note').onclick = () => sheetNote(id);
  view.querySelectorAll('[data-note]').forEach(el => el.onclick = () => sheetNote(id, el.dataset.note));
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
    <label class="field"><span>Niveau</span><input id="f-level" value="${esc(s.level || '')}"></label>
    <label class="field"><span>Points forts</span><textarea id="f-strong">${esc(s.strengths || '')}</textarea></label>
    <label class="field"><span>Difficultés</span><textarea id="f-diff">${esc(s.difficulties || '')}</textarea></label>
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
    const saved = await DB.put('students', { ...(s.id ? s : {}), name, photo, phone: $('#f-phone').value, email: $('#f-email').value, level: $('#f-level').value, strengths: $('#f-strong').value, difficulties: $('#f-diff').value });
    closeSheet(); toast('Profil enregistré ✓'); renderStudentDetail(saved.id);
  };
  if (id) $('#f-del').onclick = async () => {
    if (!confirm('Supprimer cet élève et tout son historique ?')) return;
    for (const st of ['lessons', 'payments', 'notes']) for (const r of await DB.byStudent(st, id)) await DB.del(st, r.id);
    await DB.del('students', id); closeSheet(); renderStudents();
  };
}

async function sheetPayment(studentId) {
  const { forfaits, collectors } = await getConfig();
  openSheet(`
    <h3>Enregistrer un paiement</h3>
    <label class="field"><span>Forfait</span>
      <select id="f-forfait">${forfaits.map((f, i) => `<option value="${i}">${esc(f.label)} — ${fmtMoney(f.price)}</option>`).join('')}</select></label>
    <div class="field-row">
      <label class="field"><span>Montant</span><input type="number" id="f-amount" value="${forfaits[0].price}"></label>
      <label class="field"><span>Nb de cours</span><input type="number" id="f-count" value="${forfaits[0].lessons}"></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Validité (mois)</span><input type="number" id="f-valid" value="${forfaits[0].validity || 2}"></label>
      <label class="field"><span>Départ validité</span>
        <select id="f-from"><option value="first">1er cours</option><option value="purchase">date d\u2019achat</option></select></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Date</span><input type="date" id="f-date" value="${new Date().toISOString().slice(0, 10)}"></label>
      <label class="field"><span>Moyen</span><select id="f-method"><option>Chèque</option><option>Espèces</option><option>Virement</option><option>Bon cadeau</option></select></label>
    </div>
    <label class="field"><span>Encaissé par</span>
      <select id="f-by">${collectors.map(c => `<option>${esc(c)}</option>`).join('')}</select></label>
    <button class="btn" id="f-save">Enregistrer</button>
  `);
  const apply = () => {
    const f = forfaits[+$('#f-forfait').value];
    if (!f) return;
    $('#f-amount').value = f.price; $('#f-count').value = f.lessons;
    $('#f-valid').value = f.validity || 2; $('#f-from').value = f.from || 'first';
  };
  $('#f-forfait').onchange = apply;
  $('#f-save').onclick = async () => {
    const f = forfaits[+$('#f-forfait').value];
    await DB.put('payments', {
      id: DB.uid(), studentId, amount: +$('#f-amount').value,
      lessonsCovered: +$('#f-count').value || 1,
      validityMonths: +$('#f-valid').value || 0,
      validityFrom: $('#f-from').value,
      label: f ? f.label : '',
      date: new Date($('#f-date').value).toISOString(), method: $('#f-method').value,
      collectedBy: $('#f-by').value
    });
    closeSheet(); toast('Paiement enregistré ✓'); renderStudentDetail(studentId);
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
async function renderSettings() {
  const { courseTypes, forfaits, business } = await getConfig();
  const delays = [[0, 'Immédiat'], [60000, '1 minute'], [300000, '5 minutes'], [900000, '15 minutes'], [3600000, '1 heure'], [-1, 'Jamais']];
  view.innerHTML = `
    <h2 class="section">Verrouillage</h2>
    <div class="card">
      ${Lock.enabled ? '<span class="badge ok">Code actif</span>' : '<span class="badge warn">Aucun code</span>'}
      <label class="field" style="margin-top:10px"><span>Verrouiller après</span>
        <select id="lk-delay">${delays.map(([v, t]) => `<option value="${v}" ${Lock.delay === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <button class="btn secondary" id="lk-set">${Lock.enabled ? 'Changer le code' : 'Définir un code à 4 chiffres'}</button>
      ${Lock.enabled ? '<button class="btn danger" id="lk-off">Désactiver le code</button>' : ''}
    </div>

    <h2 class="section">Google Agenda</h2>
    <div class="card">
      ${GC.connected ? `<span class="badge ok">Connecté</span><button class="btn danger" id="gc-off">Déconnecter</button>`
      : WORKER_URL ? `<div class="sub">Connecte le compte Google pour synchroniser les cours.</div><button class="btn" id="gc-on">Connecter Google Agenda</button>`
        : `<div class="sub">Renseigne WORKER_URL dans js/config.js.</div>`}
    </div>

    <h2 class="section">Sauvegarde cloud ☁️</h2>
    <div class="card">
      ${WORKER_URL ? `
      <div class="sub">Phrase secrète (6 caractères min.) pour protéger et retrouver la sauvegarde. Sauvegarde auto quotidienne.</div>
      <label class="field" style="margin-top:10px"><span>Phrase secrète</span><input id="cl-pass" type="password" value="${esc(Cloud.pass)}"></label>
      ${Cloud.lastBackup ? `<div class="sub">Dernière : ${new Date(Cloud.lastBackup).toLocaleString('fr-FR')}</div>` : ''}
      <button class="btn" id="cl-save">Sauvegarder maintenant</button>
      <button class="btn secondary" id="cl-restore">Restaurer depuis le cloud</button>` : `<div class="sub">Nécessite le Worker Cloudflare.</div>`}
    </div>

    <h2 class="section">Mes informations (factures)</h2>
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
    </div>

    <h2 class="section">Types de cours</h2>
    <div class="card" id="types-box"></div>

    <h2 class="section">Forfaits & tarifs</h2>
    <div class="card" id="forfaits-box"></div>

    <h2 class="section">Encaissement</h2>
    <div class="card" id="collectors-box"></div>

    <h2 class="section">Sauvegarde locale</h2>
    <div class="card">
      <button class="btn secondary" id="bk-export">Exporter un fichier (JSON)</button>
      <input type="file" id="bk-file" accept="application/json" hidden>
      <button class="btn secondary" id="bk-import">Restaurer un fichier</button>
    </div>

    <div style="text-align:center;color:var(--ink-soft);font-size:.8rem;margin:22px 0 6px">
      Loane Pro · version ${APP_VERSION}
    </div>`;

  $('#lk-delay').onchange = e => { Lock.delay = +e.target.value; toast('Délai enregistré ✓'); };
  $('#lk-set').onclick = () => sheetSetCode();
  const lkOff = $('#lk-off'); if (lkOff) lkOff.onclick = () => { localStorage.removeItem('lock_hash'); toast('Code désactivé'); renderSettings(); };

  const on = $('#gc-on'); if (on) on.onclick = () => GC.connect();
  const off = $('#gc-off'); if (off) off.onclick = () => { GC.disconnect(); renderSettings(); };

  const clSave = $('#cl-save');
  if (clSave) {
    clSave.onclick = async () => {
      const p = $('#cl-pass').value.trim();
      if (p.length < 6) { toast('6 caractères minimum'); return; }
      Cloud.pass = p; clSave.textContent = 'Sauvegarde…'; await Cloud.backup(false); renderSettings();
    };
    $('#cl-restore').onclick = async () => {
      const p = $('#cl-pass').value.trim();
      if (p.length < 6) { toast('6 caractères minimum'); return; }
      Cloud.pass = p; await Cloud.restore();
    };
  }

  $('#b-save').onclick = async () => {
    await DB.setSetting('business', {
      name: $('#b-name').value, address: $('#b-address').value, siret: $('#b-siret').value,
      phone: $('#b-phone').value, email: $('#b-email').value, iban: $('#b-iban').value, footer: $('#b-footer').value
    });
    CURRENCY = $('#b-cur').value; await DB.setSetting('currency', CURRENCY);
    toast('Enregistré ✓'); renderSettings();
  };
  await drawTypes(); await drawForfaits(); await drawCollectors();

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
    try { await DB.importAll(JSON.parse(await f.text())); toast('Restauré ✓'); renderSettings(); }
    catch (err) { toast('Fichier invalide'); }
  };
}


// --- Qui encaisse (Loane, l'école…) ---
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
        <div class="sub">${f.lessons} cours · ${fmtMoney(f.price)}${f.validity ? ' · valable ' + f.validity + ' mois ' + (f.from === 'purchase' ? 'dès l\u2019achat' : 'dès le 1er cours') : ''}</div></div>
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
  const f = index === null ? { label: '', lessons: 1, price: 0, validity: 2, from: 'first' } : forfaits[index];
  openSheet(`
    <h3>${index === null ? 'Nouveau forfait' : 'Modifier le forfait'}</h3>
    <label class="field"><span>Libellé</span><input id="ff-label" value="${esc(f.label)}"></label>
    <div class="field-row">
      <label class="field"><span>Nombre de cours</span><input type="number" id="ff-lessons" value="${f.lessons}"></label>
      <label class="field"><span>Prix</span><input type="number" id="ff-price" value="${f.price}"></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Validité (mois)</span><input type="number" id="ff-valid" value="${f.validity || 0}"></label>
      <label class="field"><span>Départ validité</span>
        <select id="ff-from">
          <option value="first" ${f.from !== 'purchase' ? 'selected' : ''}>1er cours</option>
          <option value="purchase" ${f.from === 'purchase' ? 'selected' : ''}>date d\u2019achat</option>
        </select></label>
    </div>
    <button class="btn" id="ff-save">Enregistrer</button>
    ${index === null ? '' : '<button class="btn danger" id="ff-del">Supprimer ce forfait</button>'}
  `);
  $('#ff-save').onclick = async () => {
    const label = $('#ff-label').value.trim();
    if (!label) { toast('Le libellé est obligatoire'); return; }
    const item = { label, lessons: +$('#ff-lessons').value || 1, price: +$('#ff-price').value || 0,
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
(async function start() {
  $('#splash-version').textContent = 'v' + APP_VERSION;
  CURRENCY = await DB.getSetting('currency', 'XPF');
  GC.handleCallback();
  Lock.init();
  switchTab('agenda');
  Cloud.auto();

  setTimeout(() => {
    $('#splash').classList.add('hide');
    setTimeout(() => $('#splash').remove(), 500);
  }, 1250);

  if (GC.connected) {
    GC.pullEvents()
      .then(ev => { gcalCache = ev; if (currentTab === 'agenda') renderAgenda(); })
      .catch(() => { });
  }
})();
