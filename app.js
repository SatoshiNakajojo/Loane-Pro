// ====== Studio Vocal — application ======
const $ = sel => document.querySelector(sel);
const view = $('#view');
const fmtEUR = n => (n || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const fmtDate = d => new Date(d).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDateFull = d => new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtTime = d => new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const esc = s => (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = name => name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => t.hidden = true, 2200);
}

// ---------- Feuille modale ----------
function openSheet(html) {
  $('#sheet').innerHTML = '<div class="handle"></div>' + html;
  $('#sheet').hidden = false; $('#sheet-backdrop').hidden = false;
}
function closeSheet() { $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true; }
$('#sheet-backdrop').addEventListener('click', closeSheet);

// ---------- Réglages par défaut ----------
async function getConfig() {
  const courseTypes = await DB.getSetting('courseTypes', ['Cours de chant individuel', 'Cours collectif', 'Coaching scénique', 'Atelier découverte']);
  const forfaits = await DB.getSetting('forfaits', [
    { label: 'Cours à l\u2019unité', lessons: 1, price: 40 },
    { label: 'Forfait 5 cours', lessons: 5, price: 190 },
    { label: 'Forfait 10 cours', lessons: 10, price: 360 }
  ]);
  const business = await DB.getSetting('business', { name: '', address: '', siret: '', email: '', phone: '', iban: '', footer: 'TVA non applicable, art. 293 B du CGI.' });
  return { courseTypes, forfaits, business };
}

// ====== Google Agenda ======
const GC = {
  get connected() { return !!localStorage.getItem('gc_refresh'); },
  connect() {
    if (!WORKER_URL) { toast('Configure d\u2019abord WORKER_URL (voir README)'); return; }
    const back = location.origin + location.pathname;
    location.href = WORKER_URL + '/auth/start?redirect=' + encodeURIComponent(back);
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
      ...opts,
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    if (r.status === 204) return null;
    if (!r.ok) throw new Error('Google API ' + r.status);
    return r.json();
  },
  async pushLesson(lesson, student) {
    if (!this.connected) return lesson;
    const start = new Date(lesson.date);
    const end = new Date(start.getTime() + (lesson.duration || 60) * 60000);
    const body = {
      summary: '🎤 ' + (student ? student.name : 'Cours') + ' — ' + (lesson.type || 'Cours de chant'),
      description: lesson.note || '',
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() }
    };
    try {
      if (lesson.gcalEventId) {
        await this.api('/calendars/primary/events/' + lesson.gcalEventId, { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        const ev = await this.api('/calendars/primary/events', { method: 'POST', body: JSON.stringify(body) });
        lesson.gcalEventId = ev.id;
      }
    } catch (e) { console.warn('sync gcal', e); toast('Synchro Google impossible (hors ligne ?)'); }
    return lesson;
  },
  async deleteLesson(lesson) {
    if (!this.connected || !lesson.gcalEventId) return;
    try { await this.api('/calendars/primary/events/' + lesson.gcalEventId, { method: 'DELETE' }); } catch (e) { }
  },
  async pullEvents() {
    if (!this.connected) return [];
    const min = new Date(Date.now() - 7 * 864e5).toISOString();
    const max = new Date(Date.now() + 60 * 864e5).toISOString();
    const data = await this.api(`/calendars/primary/events?timeMin=${min}&timeMax=${max}&singleEvents=true&orderBy=startTime&maxResults=200`);
    return (data.items || []).filter(e => e.start && e.start.dateTime);
  }
};

// ====== Utilitaires métier ======
async function lessonsOf(studentId) {
  const ls = await DB.byStudent('lessons', studentId);
  return ls.sort((a, b) => new Date(a.date) - new Date(b.date));
}
async function paymentStatus(student) {
  const [lessons, payments] = [await lessonsOf(student.id), (await DB.byStudent('payments', student.id)).sort((a, b) => new Date(b.date) - new Date(a.date))];
  const now = Date.now();
  const done = lessons.filter(l => new Date(l.date) <= now);
  const last = payments[0];
  if (!last) return { last: null, sinceLast: done.length, due: done.length > 0, remaining: -done.length };
  const sinceLast = done.filter(l => new Date(l.date) > new Date(last.date)).length;
  const remaining = (last.lessonsCovered || 1) - sinceLast;
  return { last, sinceLast, due: remaining <= 0, remaining };
}

// ====== Navigation ======
let currentTab = 'agenda';
const TABS = {
  agenda: { title: 'Agenda', render: renderAgenda, action: () => sheetLesson() },
  students: { title: 'Élèves', render: renderStudents, action: () => sheetStudent() },
  billing: { title: 'Factures & devis', render: renderBilling, action: () => sheetInvoice() },
  library: { title: 'Répertoire', render: renderLibrary, action: () => sheetPiece() },
  settings: { title: 'Réglages', render: renderSettings, action: null }
};
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const t = TABS[tab];
  $('#page-title').textContent = t.title;
  const act = $('#topbar-action');
  act.hidden = !t.action;
  act.onclick = t.action;
  t.render();
}

// ====== AGENDA ======
let gcalCache = [];
async function renderAgenda() {
  const lessons = (await DB.all('lessons')).sort((a, b) => new Date(a.date) - new Date(b.date));
  const students = Object.fromEntries((await DB.all('students')).map(s => [s.id, s]));
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const upcoming = lessons.filter(l => new Date(l.date) >= now);
  const linkedIds = new Set(lessons.map(l => l.gcalEventId).filter(Boolean));
  const gEvents = gcalCache.filter(e => !linkedIds.has(e.id) && new Date(e.start.dateTime) >= now);

  const items = [
    ...upcoming.map(l => ({ date: l.date, lesson: l })),
    ...gEvents.map(e => ({ date: e.start.dateTime, gcal: e }))
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  let html = '';
  if (GC.connected) html += `<button class="btn secondary" id="btn-sync" style="margin-top:0">🔄 Synchroniser avec Google Agenda</button>`;
  else if (WORKER_URL) html += `<div class="card"><div class="sub">Google Agenda non connecté.</div><button class="btn secondary" id="btn-gc-connect">Connecter Google Agenda</button></div>`;

  if (!items.length) {
    html += `<div class="empty"><div class="big">🎶</div>Aucun cours à venir.<br>Touche ＋ pour ajouter un cours.</div>`;
  } else {
    let curDay = '';
    for (const it of items) {
      const d = new Date(it.date);
      const key = d.toDateString();
      if (key !== curDay) {
        curDay = key;
        const isToday = key === new Date().toDateString();
        html += `<div class="day-head">${fmtDate(d)} ${isToday ? '<span class="today">· aujourd\u2019hui</span>' : ''}</div>`;
      }
      if (it.lesson) {
        const s = students[it.lesson.studentId];
        html += `<div class="card tappable row" data-lesson="${it.lesson.id}">
          <div class="lesson-time">${fmtTime(it.date)}</div>
          <div class="grow"><div class="title">${esc(s ? s.name : 'Élève supprimé')}</div>
          <div class="sub">${esc(it.lesson.type || 'Cours de chant')} · ${it.lesson.duration || 60} min ${it.lesson.gcalEventId ? '<span class="gcal-dot">● Google</span>' : ''}</div></div>
          <div class="chev">›</div></div>`;
      } else {
        html += `<div class="card tappable row" data-gcal="${it.gcal.id}">
          <div class="lesson-time">${fmtTime(it.date)}</div>
          <div class="grow"><div class="title">${esc(it.gcal.summary || '(sans titre)')}</div>
          <div class="sub"><span class="gcal-dot">●</span> Google Agenda · toucher pour rattacher</div></div>
          <div class="chev">›</div></div>`;
      }
    }
  }
  view.innerHTML = html;
  const sync = $('#btn-sync');
  if (sync) sync.onclick = async () => {
    sync.textContent = 'Synchronisation…';
    try { gcalCache = await GC.pullEvents(); toast('Agenda synchronisé ✓'); } catch (e) { toast('Échec de la synchro'); }
    renderAgenda();
  };
  const conn = $('#btn-gc-connect'); if (conn) conn.onclick = () => GC.connect();
  view.querySelectorAll('[data-lesson]').forEach(el => el.onclick = () => sheetLesson(el.dataset.lesson));
  view.querySelectorAll('[data-gcal]').forEach(el => el.onclick = () => {
    const ev = gcalCache.find(e => e.id === el.dataset.gcal);
    if (ev) sheetImportGcal(ev);
  });
}

// Convertir un événement Google en cours rattaché à un élève
async function sheetImportGcal(ev) {
  const students = await DB.all('students');
  const { courseTypes } = await getConfig();
  const start = new Date(ev.start.dateTime);
  const end = ev.end && ev.end.dateTime ? new Date(ev.end.dateTime) : new Date(start.getTime() + 60 * 60000);
  const dur = Math.max(15, Math.round((end - start) / 60000));

  // Devine l'élève à partir du titre de l'événement (ex. "🎤 Marie — Cours")
  const cleanTitle = (ev.summary || '').replace(/🎤/g, '').toLowerCase();
  const guess = students.find(s => cleanTitle.includes(s.name.toLowerCase().split(' ')[0]));

  openSheet(`
    <h3>Rattacher ce cours</h3>
    <div class="card"><div class="title">${esc(ev.summary || '(sans titre)')}</div>
      <div class="sub">${fmtDate(start)} · ${fmtTime(start)} — ${dur} min</div></div>
    ${students.length ? `
    <label class="field"><span>Élève</span>
      <select id="f-student">${students.map(s => `<option value="${s.id}" ${guess && guess.id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
    <label class="field"><span>Type de cours</span>
      <select id="f-type">${courseTypes.map(t => `<option>${esc(t)}</option>`).join('')}</select></label>
    <button class="btn" id="f-import">Ajouter comme cours de cet élève</button>
    <div class="sub" style="text-align:center;margin-top:8px">Le cours restera lié à cet événement Google (pas de doublon).</div>
    ` : `<div class="sub">Crée d\u2019abord un élève pour pouvoir rattacher ce cours.</div>`}
  `);
  if (students.length) $('#f-import').onclick = async () => {
    await DB.put('lessons', {
      id: DB.uid(),
      studentId: $('#f-student').value,
      date: start.toISOString(),
      type: $('#f-type').value,
      duration: dur,
      note: ev.description || '',
      gcalEventId: ev.id           // lien avec Google : évite tout doublon d'affichage
    });
    // on le retire du cache pour qu'il n'apparaisse plus comme "événement Google" brut
    gcalCache = gcalCache.filter(e => e.id !== ev.id);
    closeSheet(); toast('Cours rattaché ✓'); renderAgenda();
  };
}

async function sheetLesson(id, presetStudent) {
  const students = await DB.all('students');
  if (!students.length) { toast('Crée d\u2019abord un élève 🙂'); switchTab('students'); return; }
  const { courseTypes } = await getConfig();
  const l = id ? await DB.get('lessons', id) : null;
  const d = l ? new Date(l.date) : (() => { const x = new Date(); x.setMinutes(0, 0, 0); x.setHours(x.getHours() + 1); return x; })();
  const dateVal = d.toISOString().slice(0, 10), timeVal = d.toTimeString().slice(0, 5);

  openSheet(`
    <h3>${l ? 'Modifier le cours' : 'Nouveau cours'}</h3>
    <label class="field"><span>Élève</span>
      <select id="f-student">${students.map(s => `<option value="${s.id}" ${(l && l.studentId === s.id) || presetStudent === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
    <div class="field-row">
      <label class="field"><span>Date</span><input type="date" id="f-date" value="${dateVal}"></label>
      <label class="field"><span>Heure</span><input type="time" id="f-time" value="${timeVal}"></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Type de cours</span>
        <select id="f-type">${courseTypes.map(t => `<option ${l && l.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <label class="field"><span>Durée (min)</span><input type="number" id="f-dur" value="${l ? l.duration : 60}"></label>
    </div>
    <label class="field"><span>Note (optionnel)</span><input id="f-note" value="${esc(l ? l.note : '')}"></label>
    <button class="btn" id="f-save">${l ? 'Enregistrer' : 'Ajouter le cours'}</button>
    ${l ? '<button class="btn danger" id="f-del">Supprimer ce cours</button>' : ''}
  `);
  $('#f-save').onclick = async () => {
    const lesson = l || { id: DB.uid() };
    lesson.studentId = $('#f-student').value;
    lesson.date = new Date($('#f-date').value + 'T' + $('#f-time').value).toISOString();
    lesson.type = $('#f-type').value;
    lesson.duration = +$('#f-dur').value || 60;
    lesson.note = $('#f-note').value;
    const student = await DB.get('students', lesson.studentId);
    await GC.pushLesson(lesson, student);
    await DB.put('lessons', lesson);
    closeSheet(); toast('Cours enregistré ✓'); TABS[currentTab].render();
  };
  if (l) $('#f-del').onclick = async () => {
    await GC.deleteLesson(l);
    await DB.del('lessons', l.id);
    closeSheet(); toast('Cours supprimé'); TABS[currentTab].render();
  };
}

// ====== ÉLÈVES ======
async function renderStudents() {
  const students = (await DB.all('students')).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  if (!students.length) {
    view.innerHTML = `<div class="empty"><div class="big">🎤</div>Aucun élève pour l\u2019instant.<br>Touche ＋ pour créer un profil.</div>`;
    return;
  }
  let html = '';
  for (const s of students) {
    const st = await paymentStatus(s);
    html += `<div class="card tappable row" data-student="${s.id}">
      ${s.photo ? `<img class="avatar" src="${s.photo}">` : `<div class="avatar">${initials(s.name)}</div>`}
      <div class="grow"><div class="title">${esc(s.name)}</div>
      <div class="sub">${st.last ? 'Dernier paiement : ' + fmtDateFull(st.last.date) : 'Aucun paiement enregistré'}</div></div>
      <div class="right">${st.due ? '<span class="badge due">À encaisser</span>' : `<span class="badge ok">${st.remaining} cours resta${st.remaining > 1 ? 'nts' : 'nt'}</span>`}</div>
      <div class="chev">›</div></div>`;
  }
  view.innerHTML = html;
  view.querySelectorAll('[data-student]').forEach(el => el.onclick = () => renderStudentDetail(el.dataset.student));
}

async function renderStudentDetail(id) {
  const s = await DB.get('students', id);
  if (!s) return renderStudents();
  const lessons = await lessonsOf(id);
  const now = Date.now();
  const past = lessons.filter(l => new Date(l.date) <= now).reverse();
  const next = lessons.filter(l => new Date(l.date) > now);
  const payments = (await DB.byStudent('payments', id)).sort((a, b) => new Date(b.date) - new Date(a.date));
  const notes = (await DB.byStudent('notes', id)).sort((a, b) => new Date(b.date) - new Date(a.date));
  const st = await paymentStatus(s);

  view.innerHTML = `
    <button class="btn-inline" id="back">‹ Élèves</button>
    <div class="card" style="text-align:center;margin-top:12px">
      ${s.photo ? `<img class="avatar big" src="${s.photo}" style="margin:0 auto">` : `<div class="avatar big" style="margin:0 auto">${initials(s.name)}</div>`}
      <h3 style="margin-top:8px;font-size:1.3rem">${esc(s.name)}</h3>
      <div class="sub">${esc([s.phone, s.email].filter(Boolean).join(' · '))}</div>
      <div style="margin-top:8px">${st.due ? '<span class="badge due">Paiement attendu</span>' : `<span class="badge ok">${st.remaining} cours payé${st.remaining > 1 ? 's' : ''} restant${st.remaining > 1 ? 's' : ''}</span>`}</div>
      <button class="btn secondary" id="edit-student">Modifier le profil</button>
    </div>

    <div class="stat-grid">
      <div class="stat"><b>${past.length}</b><span>cours effectués</span></div>
      <div class="stat"><b>${next.length}</b><span>cours à venir</span></div>
    </div>

    <h2 class="section">Suivi pédagogique</h2>
    <div class="card">
      ${s.level ? `<div><span class="tag">Niveau</span> ${esc(s.level)}</div>` : ''}
      ${s.strengths ? `<div style="margin-top:6px"><span class="tag">Points forts</span> ${esc(s.strengths)}</div>` : ''}
      ${s.difficulties ? `<div style="margin-top:6px"><span class="tag">Difficultés</span> ${esc(s.difficulties)}</div>` : ''}
      ${!s.level && !s.strengths && !s.difficulties ? '<div class="sub">Renseigne le niveau, les points forts et les difficultés via « Modifier le profil ».</div>' : ''}
    </div>

    <h2 class="section">Notes de cours</h2>
    <button class="btn secondary" id="add-note" style="margin-top:0">＋ Ajouter une note</button>
    ${notes.map(n => `<div class="card note" data-note="${n.id}"><div class="sub">${fmtDateFull(n.date)}</div><p>${esc(n.text)}</p></div>`).join('') || '<div class="sub" style="padding:6px">Aucune note pour l\u2019instant.</div>'}

    <h2 class="section">Paiements</h2>
    <button class="btn secondary" id="add-pay" style="margin-top:0">＋ Enregistrer un paiement</button>
    ${payments.map(p => `<div class="card row"><div class="grow"><div class="title">${fmtEUR(p.amount)} — ${p.lessonsCovered} cours</div><div class="sub">${fmtDateFull(p.date)}${p.method ? ' · ' + esc(p.method) : ''}</div></div></div>`).join('')}

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
  view.querySelectorAll('[data-lesson]').forEach(el => el.onclick = () => sheetLesson(el.dataset.lesson));
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
    <label class="field"><span>Niveau</span><input id="f-level" placeholder="Débutante, intermédiaire…" value="${esc(s.level || '')}"></label>
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
    const obj = { ...(s.id ? s : {}), name, photo, phone: $('#f-phone').value, email: $('#f-email').value, level: $('#f-level').value, strengths: $('#f-strong').value, difficulties: $('#f-diff').value };
    const saved = await DB.put('students', obj);
    closeSheet(); toast('Profil enregistré ✓');
    renderStudentDetail(saved.id);
  };
  if (id) $('#f-del').onclick = async () => {
    if (!confirm('Supprimer cet élève et tout son historique ?')) return;
    for (const st of ['lessons', 'payments', 'notes']) for (const r of await DB.byStudent(st, id)) await DB.del(st, r.id);
    await DB.del('students', id);
    closeSheet(); renderStudents();
  };
}

async function sheetPayment(studentId) {
  const { forfaits } = await getConfig();
  openSheet(`
    <h3>Enregistrer un paiement</h3>
    <label class="field"><span>Forfait</span>
      <select id="f-forfait">${forfaits.map((f, i) => `<option value="${i}">${esc(f.label)} — ${fmtEUR(f.price)}</option>`).join('')}<option value="custom">Autre montant…</option></select></label>
    <div class="field-row">
      <label class="field"><span>Montant (€)</span><input type="number" id="f-amount" value="${forfaits[0].price}"></label>
      <label class="field"><span>Nb de cours couverts</span><input type="number" id="f-count" value="${forfaits[0].lessons}"></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Date</span><input type="date" id="f-date" value="${new Date().toISOString().slice(0, 10)}"></label>
      <label class="field"><span>Moyen</span><select id="f-method"><option>Espèces</option><option>Virement</option><option>Chèque</option><option>Lydia / PayPal</option></select></label>
    </div>
    <button class="btn" id="f-save">Enregistrer le paiement</button>
  `);
  $('#f-forfait').onchange = e => {
    const f = forfaits[+e.target.value];
    if (f) { $('#f-amount').value = f.price; $('#f-count').value = f.lessons; }
  };
  $('#f-save').onclick = async () => {
    await DB.put('payments', {
      id: DB.uid(), studentId, amount: +$('#f-amount').value,
      lessonsCovered: +$('#f-count').value || 1,
      date: new Date($('#f-date').value).toISOString(), method: $('#f-method').value
    });
    closeSheet(); toast('Paiement enregistré ✓'); renderStudentDetail(studentId);
  };
}

async function sheetNote(studentId, noteId) {
  const n = noteId ? await DB.get('notes', noteId) : null;
  openSheet(`
    <h3>${n ? 'Modifier la note' : 'Nouvelle note de cours'}</h3>
    <label class="field"><span>Date</span><input type="date" id="f-date" value="${(n ? new Date(n.date) : new Date()).toISOString().slice(0, 10)}"></label>
    <label class="field"><span>Contenu</span><textarea id="f-text" style="min-height:140px" placeholder="Travail effectué, exercices, morceaux, remarques…">${esc(n ? n.text : '')}</textarea></label>
    <button class="btn" id="f-save">Enregistrer</button>
    ${n ? '<button class="btn danger" id="f-del">Supprimer la note</button>' : ''}
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
  if (!invoices.length) {
    view.innerHTML = `<div class="empty"><div class="big">🧾</div>Aucune facture ni devis.<br>Touche ＋ pour en créer.</div>`;
    return;
  }
  view.innerHTML = invoices.map(inv => `
    <div class="card tappable row" data-inv="${inv.id}">
      <div class="grow"><div class="title">${inv.kind === 'devis' ? 'Devis' : 'Facture'} ${esc(inv.number)}</div>
      <div class="sub">${esc(students[inv.studentId] ? students[inv.studentId].name : '—')} · ${fmtDateFull(inv.date)}</div></div>
      <div class="right"><div class="title">${fmtEUR(inv.total)}</div>
      <span class="badge ${inv.kind === 'devis' ? 'gold' : 'info'}">${inv.kind === 'devis' ? 'Devis' : 'Facture'}</span></div>
      <div class="chev">›</div></div>`).join('');
  view.querySelectorAll('[data-inv]').forEach(el => el.onclick = () => sheetInvoiceView(el.dataset.inv));
}

async function sheetInvoice() {
  const students = await DB.all('students');
  if (!students.length) { toast('Crée d\u2019abord un élève 🙂'); switchTab('students'); return; }
  const { courseTypes, forfaits } = await getConfig();
  openSheet(`
    <h3>Nouvelle facture / devis</h3>
    <label class="field"><span>Document</span>
      <select id="f-kind"><option value="facture">Facture</option><option value="devis">Devis</option></select></label>
    <label class="field"><span>Élève</span>
      <select id="f-student">${students.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
    <label class="field"><span>Type de cours</span>
      <select id="f-type">${courseTypes.map(t => `<option>${esc(t)}</option>`).join('')}</select></label>
    <label class="field"><span>Forfait</span>
      <select id="f-forfait">${forfaits.map((f, i) => `<option value="${i}">${esc(f.label)} — ${fmtEUR(f.price)}</option>`).join('')}</select></label>
    <div class="field-row">
      <label class="field"><span>Quantité</span><input type="number" id="f-qty" value="1"></label>
      <label class="field"><span>Prix unitaire (€)</span><input type="number" id="f-price" value="${forfaits[0].price}"></label>
    </div>
    <button class="btn" id="f-save">Créer le document</button>
  `);
  $('#f-forfait').onchange = e => { const f = forfaits[+e.target.value]; if (f) $('#f-price').value = f.price; };
  $('#f-save').onclick = async () => {
    const kind = $('#f-kind').value;
    const counterKey = kind === 'devis' ? 'devisCounter' : 'invoiceCounter';
    const n = (await DB.getSetting(counterKey, 0)) + 1;
    await DB.setSetting(counterKey, n);
    const year = new Date().getFullYear();
    const f = forfaits[+$('#f-forfait').value];
    const qty = +$('#f-qty').value || 1, price = +$('#f-price').value || 0;
    const inv = await DB.put('invoices', {
      id: DB.uid(), kind,
      number: `${year}-${String(n).padStart(3, '0')}`,
      studentId: $('#f-student').value, date: new Date().toISOString(),
      items: [{ label: `${$('#f-type').value} — ${f.label}`, qty, unitPrice: price }],
      total: qty * price
    });
    closeSheet(); toast((kind === 'devis' ? 'Devis' : 'Facture') + ' créé(e) ✓');
    sheetInvoiceView(inv.id);
  };
}

async function sheetInvoiceView(id) {
  const inv = await DB.get('invoices', id);
  const student = await DB.get('students', inv.studentId);
  renderBilling();
  openSheet(`
    <h3>${inv.kind === 'devis' ? 'Devis' : 'Facture'} ${esc(inv.number)}</h3>
    <div class="card">
      <div class="title">${esc(student ? student.name : '—')}</div>
      <div class="sub">${fmtDateFull(inv.date)}</div>
      <hr class="staff">
      ${inv.items.map(i => `<div class="row"><div class="grow sub">${esc(i.label)} × ${i.qty}</div><div class="title">${fmtEUR(i.qty * i.unitPrice)}</div></div>`).join('')}
      <div class="row" style="margin-top:8px"><div class="grow title">Total</div><div class="title" style="color:var(--primary)">${fmtEUR(inv.total)}</div></div>
    </div>
    <button class="btn gold" id="f-print">Imprimer / Enregistrer en PDF</button>
    <button class="btn danger" id="f-del">Supprimer</button>
  `);
  $('#f-print').onclick = () => printInvoice(inv, student);
  $('#f-del').onclick = async () => { await DB.del('invoices', id); closeSheet(); renderBilling(); };
}

async function printInvoice(inv, student) {
  const { business } = await getConfig();
  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>${inv.kind} ${inv.number}</title>
  <style>
    body{font-family:-apple-system,Helvetica,Arial,sans-serif;color:#12352A;padding:40px;max-width:700px;margin:auto}
    h1{font-size:1.6rem;color:#14735A} .head{display:flex;justify-content:space-between;margin-bottom:30px}
    .staff{height:9px;background:repeating-linear-gradient(to bottom,#F26B1D 0 1px,transparent 1px 3px);margin:16px 0 30px}
    table{width:100%;border-collapse:collapse;margin:20px 0}
    th{text-align:left;font-size:.8rem;text-transform:uppercase;color:#5E7268;border-bottom:2px solid #14735A;padding:8px 4px}
    td{padding:10px 4px;border-bottom:1px solid #EAE2D4} .num{text-align:right}
    .total{font-size:1.2rem;font-weight:800;color:#14735A}
    .footer{margin-top:50px;font-size:.8rem;color:#5E7268}
  </style></head><body>
  <div class="head"><div>
    <h1>${inv.kind === 'devis' ? 'DEVIS' : 'FACTURE'} ${esc(inv.number)}</h1>
    <div>Date : ${fmtDateFull(inv.date)}</div>
  </div><div style="text-align:right">
    <strong>${esc(business.name || 'Professeure de chant')}</strong><br>
    ${esc(business.address || '').replace(/\n/g, '<br>')}<br>
    ${business.siret ? 'SIRET : ' + esc(business.siret) + '<br>' : ''}
    ${esc(business.email || '')} ${esc(business.phone || '')}
  </div></div>
  <div class="staff"></div>
  <div><strong>Adressé à :</strong> ${esc(student ? student.name : '—')}<br>${esc(student && student.email || '')}</div>
  <table><tr><th>Prestation</th><th class="num">Qté</th><th class="num">P.U.</th><th class="num">Total</th></tr>
  ${inv.items.map(i => `<tr><td>${esc(i.label)}</td><td class="num">${i.qty}</td><td class="num">${fmtEUR(i.unitPrice)}</td><td class="num">${fmtEUR(i.qty * i.unitPrice)}</td></tr>`).join('')}
  <tr><td colspan="3" class="total">TOTAL</td><td class="num total">${fmtEUR(inv.total)}</td></tr></table>
  ${business.iban ? '<div>Règlement par virement : ' + esc(business.iban) + '</div>' : ''}
  <div class="footer">${esc(business.footer || '')}${inv.kind === 'devis' ? '<br>Devis valable 30 jours.' : ''}</div>
  <script>setTimeout(()=>window.print(),300)<\/script></body></html>`);
  w.document.close();
}

// ====== RÉPERTOIRE ======
async function renderLibrary() {
  const pieces = (await DB.all('library')).sort((a, b) => a.title.localeCompare(b.title, 'fr'));
  let html = `<input id="lib-search" placeholder="🔍 Rechercher un morceau, un artiste, un tag…" style="margin-bottom:12px">`;
  if (!pieces.length) html += `<div class="empty"><div class="big">🎼</div>Ton répertoire est vide.<br>Touche ＋ pour ajouter un morceau, ses paroles et ses partitions.</div>`;
  html += `<div id="lib-list"></div>`;
  view.innerHTML = html;
  const list = $('#lib-list');
  const draw = q => {
    const filtered = q ? pieces.filter(p => (p.title + ' ' + (p.artist || '') + ' ' + (p.tags || '')).toLowerCase().includes(q.toLowerCase())) : pieces;
    list.innerHTML = filtered.map(p => `
      <div class="card tappable row" data-piece="${p.id}">
        <div class="avatar">🎵</div>
        <div class="grow"><div class="title">${esc(p.title)}</div>
        <div class="sub">${esc(p.artist || '')} ${(p.files || []).length ? '· 📎 ' + p.files.length : ''}</div>
        <div>${(p.tags || '').split(',').filter(t => t.trim()).map(t => `<span class="tag">${esc(t.trim())}</span>`).join('')}</div></div>
        <div class="chev">›</div></div>`).join('');
    list.querySelectorAll('[data-piece]').forEach(el => el.onclick = () => renderPiece(el.dataset.piece));
  };
  draw('');
  $('#lib-search').oninput = e => draw(e.target.value);
}

async function renderPiece(id) {
  const p = await DB.get('library', id);
  if (!p) return renderLibrary();
  view.innerHTML = `
    <button class="btn-inline" id="back">‹ Répertoire</button>
    <div class="card" style="margin-top:12px">
      <h3 style="font-size:1.25rem">${esc(p.title)}</h3>
      <div class="sub">${esc(p.artist || '')}</div>
      <div style="margin-top:4px">${(p.tags || '').split(',').filter(t => t.trim()).map(t => `<span class="tag">${esc(t.trim())}</span>`).join('')}</div>
      <button class="btn secondary" id="edit-piece">Modifier</button>
    </div>
    ${(p.files || []).length ? `<h2 class="section">Partitions & fichiers</h2><div class="card">${p.files.map((f, i) => `<a class="filelink" href="#" data-file="${i}">📎 ${esc(f.name)}</a>`).join('')}</div>` : ''}
    ${p.lyrics ? `<h2 class="section">Paroles / contenu du cours</h2><div class="card"><p style="white-space:pre-wrap">${esc(p.lyrics)}</p></div>` : ''}
  `;
  $('#back').onclick = renderLibrary;
  $('#edit-piece').onclick = () => sheetPiece(id);
  view.querySelectorAll('[data-file]').forEach(el => el.onclick = e => {
    e.preventDefault();
    const f = p.files[+el.dataset.file];
    fetch(f.data).then(r => r.blob()).then(b => window.open(URL.createObjectURL(b), '_blank'));
  });
}

async function sheetPiece(id) {
  const p = id ? await DB.get('library', id) : { files: [] };
  openSheet(`
    <h3>${id ? 'Modifier le morceau' : 'Nouveau morceau / cours'}</h3>
    <label class="field"><span>Titre *</span><input id="f-title" value="${esc(p.title || '')}"></label>
    <label class="field"><span>Artiste / compositeur</span><input id="f-artist" value="${esc(p.artist || '')}"></label>
    <label class="field"><span>Tags (séparés par des virgules)</span><input id="f-tags" placeholder="jazz, débutant, échauffement…" value="${esc(p.tags || '')}"></label>
    <label class="field"><span>Paroles / notes de cours</span><textarea id="f-lyrics" style="min-height:150px">${esc(p.lyrics || '')}</textarea></label>
    <label class="field"><span>Partitions / fichiers (PDF, images)</span>
      <input type="file" id="f-files" accept="application/pdf,image/*" multiple></label>
    <div id="file-list">${(p.files || []).map((f, i) => `<div class="row" style="padding:4px 0"><div class="grow sub">📎 ${esc(f.name)}</div><button class="btn-inline" data-rm="${i}">Retirer</button></div>`).join('')}</div>
    <button class="btn" id="f-save">Enregistrer</button>
    ${id ? '<button class="btn danger" id="f-del">Supprimer ce morceau</button>' : ''}
  `);
  const files = [...(p.files || [])];
  const redrawFiles = () => {
    $('#file-list').innerHTML = files.map((f, i) => `<div class="row" style="padding:4px 0"><div class="grow sub">📎 ${esc(f.name)}</div><button class="btn-inline" data-rm="${i}">Retirer</button></div>`).join('');
    $('#file-list').querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { files.splice(+b.dataset.rm, 1); redrawFiles(); });
  };
  redrawFiles();
  $('#f-files').onchange = async e => {
    for (const f of e.target.files) {
      if (f.size > 8 * 1024 * 1024) { toast(f.name + ' : fichier trop lourd (max 8 Mo)'); continue; }
      const data = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
      files.push({ name: f.name, type: f.type, data });
    }
    redrawFiles();
  };
  $('#f-save').onclick = async () => {
    const title = $('#f-title').value.trim();
    if (!title) { toast('Le titre est obligatoire'); return; }
    const saved = await DB.put('library', { ...(p.id ? p : {}), title, artist: $('#f-artist').value, tags: $('#f-tags').value, lyrics: $('#f-lyrics').value, files });
    closeSheet(); toast('Morceau enregistré ✓'); renderPiece(saved.id);
  };
  if (id) $('#f-del').onclick = async () => { await DB.del('library', id); closeSheet(); renderLibrary(); };
}

// ====== Sauvegarde cloud ======
const Cloud = {
  get pass() { return localStorage.getItem('cloud_pass') || ''; },
  set pass(v) { v ? localStorage.setItem('cloud_pass', v) : localStorage.removeItem('cloud_pass'); },
  get lastBackup() { return +(localStorage.getItem('cloud_last') || 0); },
  async backup(silent) {
    if (!WORKER_URL || !this.pass) { if (!silent) toast('Configure d\u2019abord la phrase secrète'); return false; }
    try {
      const data = JSON.stringify(await DB.exportAll());
      const r = await fetch(WORKER_URL + '/backup', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Backup-Key': this.pass },
        body: data
      });
      if (!r.ok) throw new Error(await r.text());
      localStorage.setItem('cloud_last', Date.now());
      if (!silent) toast('Sauvegardé dans le cloud ✓');
      return true;
    } catch (e) {
      console.warn('cloud backup', e);
      if (!silent) toast('Échec : ' + (e.message || 'hors ligne ?'));
      return false;
    }
  },
  async restore() {
    if (!WORKER_URL || !this.pass) { toast('Renseigne d\u2019abord la phrase secrète'); return; }
    if (!confirm('Restaurer la sauvegarde cloud ? Les données du téléphone seront fusionnées avec celles du cloud.')) return;
    try {
      const r = await fetch(WORKER_URL + '/backup', { headers: { 'X-Backup-Key': this.pass } });
      if (r.status === 404) { toast('Aucune sauvegarde pour cette phrase secrète'); return; }
      if (!r.ok) throw new Error(await r.text());
      await DB.importAll(await r.json());
      toast('Sauvegarde cloud restaurée ✓');
      TABS[currentTab].render();
    } catch (e) { toast('Échec de la restauration'); console.warn(e); }
  },
  auto() {
    // sauvegarde silencieuse une fois par jour, quelques secondes après l'ouverture
    if (WORKER_URL && this.pass && Date.now() - this.lastBackup > 24 * 3600 * 1000) {
      setTimeout(() => this.backup(true), 4000);
    }
  }
};

// ====== RÉGLAGES ======
async function renderSettings() {
  const { courseTypes, forfaits, business } = await getConfig();
  view.innerHTML = `
    <h2 class="section">Google Agenda</h2>
    <div class="card">
      ${GC.connected
        ? `<div class="row"><div class="grow"><span class="badge ok">Connecté</span></div></div><button class="btn danger" id="gc-off">Déconnecter</button>`
        : WORKER_URL
          ? `<div class="sub">Connecte ton compte Google pour synchroniser tes cours avec ton agenda.</div><button class="btn" id="gc-on">Connecter Google Agenda</button>`
          : `<div class="sub">Pour activer la synchro, configure le Worker Cloudflare puis renseigne <b>WORKER_URL</b> dans <b>js/config.js</b> (voir le README du projet).</div>`}
    </div>

    <h2 class="section">Mes informations (factures)</h2>
    <div class="card">
      <label class="field"><span>Nom / raison sociale</span><input id="b-name" value="${esc(business.name)}"></label>
      <label class="field"><span>Adresse</span><textarea id="b-address">${esc(business.address)}</textarea></label>
      <div class="field-row">
        <label class="field"><span>SIRET</span><input id="b-siret" value="${esc(business.siret)}"></label>
        <label class="field"><span>Téléphone</span><input id="b-phone" value="${esc(business.phone)}"></label>
      </div>
      <label class="field"><span>E-mail</span><input id="b-email" value="${esc(business.email)}"></label>
      <label class="field"><span>IBAN (optionnel)</span><input id="b-iban" value="${esc(business.iban)}"></label>
      <label class="field"><span>Mention en bas de facture</span><input id="b-footer" value="${esc(business.footer)}"></label>
      <button class="btn" id="b-save">Enregistrer mes informations</button>
    </div>

    <h2 class="section">Types de cours</h2>
    <div class="card">
      <label class="field"><span>Un type par ligne</span><textarea id="c-types">${esc(courseTypes.join('\n'))}</textarea></label>
    </div>

    <h2 class="section">Forfaits & tarifs</h2>
    <div class="card">
      <label class="field"><span>Un forfait par ligne : libellé ; nb de cours ; prix</span>
      <textarea id="c-forfaits">${esc(forfaits.map(f => `${f.label} ; ${f.lessons} ; ${f.price}`).join('\n'))}</textarea></label>
      <button class="btn" id="c-save">Enregistrer types & forfaits</button>
    </div>

    <h2 class="section">Sauvegarde cloud ☁️</h2>
    <div class="card">
      ${WORKER_URL ? `
      <div class="sub">Choisis une phrase secrète (6 caractères min.) : elle protège ta sauvegarde et permet de la retrouver sur un autre téléphone. Une sauvegarde automatique est faite chaque jour à l\u2019ouverture de l\u2019app.</div>
      <label class="field" style="margin-top:10px"><span>Phrase secrète</span>
        <input id="cl-pass" type="password" placeholder="Ex. : mimosa-vocalise-1987" value="${esc(Cloud.pass)}"></label>
      ${Cloud.lastBackup ? `<div class="sub">Dernière sauvegarde cloud : ${new Date(Cloud.lastBackup).toLocaleString('fr-FR')}</div>` : ''}
      <button class="btn" id="cl-save">Sauvegarder dans le cloud maintenant</button>
      <button class="btn secondary" id="cl-restore">Restaurer depuis le cloud</button>
      ` : `<div class="sub">La sauvegarde cloud utilise le Worker Cloudflare : configure-le (README) puis renseigne <b>WORKER_URL</b> dans <b>js/config.js</b>.</div>`}
    </div>

    <h2 class="section">Sauvegarde locale</h2>
    <div class="card">
      <div class="sub">Tu peux aussi exporter un fichier de sauvegarde à ranger dans iCloud / Fichiers.</div>
      <button class="btn secondary" id="bk-export">Exporter une sauvegarde (JSON)</button>
      <input type="file" id="bk-file" accept="application/json" hidden>
      <button class="btn secondary" id="bk-import">Restaurer une sauvegarde</button>
    </div>
  `;
  const on = $('#gc-on'); if (on) on.onclick = () => GC.connect();
  const off = $('#gc-off'); if (off) off.onclick = () => { GC.disconnect(); renderSettings(); };
  const clSave = $('#cl-save');
  if (clSave) {
    clSave.onclick = async () => {
      const p = $('#cl-pass').value.trim();
      if (p.length < 6) { toast('Phrase secrète : 6 caractères minimum'); return; }
      Cloud.pass = p;
      clSave.textContent = 'Sauvegarde en cours…';
      await Cloud.backup(false);
      renderSettings();
    };
    $('#cl-restore').onclick = async () => {
      const p = $('#cl-pass').value.trim();
      if (p.length < 6) { toast('Phrase secrète : 6 caractères minimum'); return; }
      Cloud.pass = p;
      await Cloud.restore();
    };
  }
  $('#b-save').onclick = async () => {
    await DB.setSetting('business', {
      name: $('#b-name').value, address: $('#b-address').value, siret: $('#b-siret').value,
      phone: $('#b-phone').value, email: $('#b-email').value, iban: $('#b-iban').value, footer: $('#b-footer').value
    });
    toast('Informations enregistrées ✓');
  };
  $('#c-save').onclick = async () => {
    await DB.setSetting('courseTypes', $('#c-types').value.split('\n').map(s => s.trim()).filter(Boolean));
    const forfs = $('#c-forfaits').value.split('\n').map(l => {
      const [label, lessons, price] = l.split(';').map(s => s.trim());
      return label ? { label, lessons: +lessons || 1, price: +price || 0 } : null;
    }).filter(Boolean);
    await DB.setSetting('forfaits', forfs);
    toast('Types & forfaits enregistrés ✓');
  };
  $('#bk-export').onclick = async () => {
    const data = await DB.exportAll();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'studio-vocal-sauvegarde-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
  };
  $('#bk-import').onclick = () => $('#bk-file').click();
  $('#bk-file').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      await DB.importAll(JSON.parse(await f.text()));
      toast('Sauvegarde restaurée ✓'); renderSettings();
    } catch (err) { toast('Fichier de sauvegarde invalide'); }
  };
}

// ====== Démarrage ======
GC.handleCallback();
switchTab('agenda');
Cloud.auto();

// Synchro Google → app automatique à l'ouverture (silencieuse)
if (GC.connected) {
  GC.pullEvents().then(ev => {
    gcalCache = ev;
    if (currentTab === 'agenda') renderAgenda();
  }).catch(() => { });
}
