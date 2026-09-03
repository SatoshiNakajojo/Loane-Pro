// ====== Worker Cloudflare — Google Agenda + sauvegarde cloud ======
// Ce worker garde le "client secret" Google côté serveur.
// Secrets à configurer : GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
// Variables : ALLOWED_ORIGIN (une ou plusieurs URLs séparées par des virgules)
//             GOOGLE_SCOPE   (optionnel, voir plus bas)

// Portée demandée à Google. Par défaut l'accès complet aux événements, pour rester
// compatible avec les autorisations déjà accordées. L'app ne fait que LIRE :
// on peut passer la variable GOOGLE_SCOPE à
//   https://www.googleapis.com/auth/calendar.events.readonly
// (il faudra alors se reconnecter une fois depuis l'app).
const SCOPE_PAR_DEFAUT = 'https://www.googleapis.com/auth/calendar.events';

// On archive une version antérieure au maximum toutes les 6 h : sans ça, la sauvegarde
// automatique (déclenchée à chaque modification) remplirait l'historique avec six
// versions prises à quelques minutes d'intervalle — inutile en cas de fausse manœuvre.
const INTERVALLE_ARCHIVE = 6 * 3600 * 1000;
const VERSIONS_CONSERVEES = 6;

// --- CORS ---------------------------------------------------------------
// ALLOWED_ORIGIN accepte plusieurs origines ("https://a.github.io, https://b.fr").
// On tolère un / final ou une URL complète avec chemin : seule l'origine compte.
function originesAutorisees(env) {
  return (env.ALLOWED_ORIGIN || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => { try { return new URL(s).origin; } catch (e) { return s.replace(/\/+$/, ''); } });
}

function cors(request, env, extra = {}) {
  const liste = originesAutorisees(env);
  const demandeur = request.headers.get('Origin') || '';
  // Aucune origine configurée : on laisse tout passer (mise en route).
  // Sinon on renvoie l'origine exacte du demandeur si elle est autorisée.
  const autorise = !liste.length ? '*' : (liste.includes(demandeur) ? demandeur : liste[0]);
  return {
    'Access-Control-Allow-Origin': autorise,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    // X-Force est indispensable : sans lui le navigateur bloque « forcer l'envoi »
    'Access-Control-Allow-Headers': 'Content-Type, X-Backup-Key, X-Force',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
    ...extra
  };
}

const json = (request, env, obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: cors(request, env, { 'Content-Type': 'application/json' }) });

const texte = (request, env, msg, status = 200) =>
  new Response(msg, { status, headers: cors(request, env, { 'Content-Type': 'text/plain; charset=utf-8' }) });

// --- base64url (sans +, / ni =) : un « + » dans une URL est lu comme une espace,
// ce qui cassait le retour de Google pour certaines adresses de site.
const b64urlEncode = s =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = s => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - b.length % 4) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
};

// Transforme la phrase secrète en clé de stockage (jamais stockée en clair)
async function backupKey(pass) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('studio-vocal:' + pass));
  return 'bk_' + [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(request, env) });
    }

    // 0) Diagnostic : permet à l'app de dire précisément ce qui manque
    if (url.pathname === '/health') {
      return json(request, env, {
        ok: true,
        google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
        kv: !!env.BACKUPS,
        origines: originesAutorisees(env)
      });
    }

    // 1) Démarrage : redirige vers l'écran de connexion Google
    if (url.pathname === '/auth/start') {
      if (!env.GOOGLE_CLIENT_ID) return texte(request, env, 'GOOGLE_CLIENT_ID non configuré sur le worker', 500);
      const appRedirect = url.searchParams.get('redirect') || originesAutorisees(env)[0] || '';
      if (!appRedirect) return texte(request, env, 'Adresse de retour inconnue (ALLOWED_ORIGIN non configuré)', 400);
      const params = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: url.origin + '/auth/callback',
        response_type: 'code',
        scope: env.GOOGLE_SCOPE || SCOPE_PAR_DEFAUT,
        access_type: 'offline',
        include_granted_scopes: 'true',
        prompt: 'consent',
        state: b64urlEncode(appRedirect)
      });
      return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params, 302);
    }

    // 2) Retour de Google : échange le code contre des jetons, puis renvoie vers l'app
    if (url.pathname === '/auth/callback') {
      // Google peut renvoyer une erreur (consentement refusé, application non autorisée…)
      const erreur = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      let appRedirect = '';
      try { appRedirect = b64urlDecode(url.searchParams.get('state') || ''); } catch (e) { appRedirect = ''; }
      if (!appRedirect) appRedirect = originesAutorisees(env)[0] || '';

      // On renvoie toujours vers l'app : elle sait afficher un message clair.
      const versApp = (frag) => appRedirect
        ? Response.redirect(appRedirect + '#gc=' + encodeURIComponent(b64urlEncode(JSON.stringify(frag))), 302)
        : texte(request, env, frag.error || 'Erreur', 400);

      if (erreur) return versApp({ error: erreur });
      if (!code) return versApp({ error: 'code_manquant' });

      let tok;
      try {
        const r = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: url.origin + '/auth/callback',
            grant_type: 'authorization_code'
          })
        });
        tok = await r.json();
        if (!r.ok) return versApp({ error: tok.error || 'echange_jeton', detail: tok.error_description || '' });
      } catch (e) {
        return versApp({ error: 'reseau_google' });
      }

      // Les jetons repartent vers l'app dans le fragment d'URL (jamais loggé côté serveur)
      return versApp({
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        expires_in: tok.expires_in
      });
    }

    // 3) Rafraîchissement du jeton d'accès
    if (url.pathname === '/auth/refresh') {
      if (request.method !== 'POST') return texte(request, env, 'Méthode non autorisée', 405);
      let refresh_token;
      try { ({ refresh_token } = await request.json()); } catch (e) { refresh_token = null; }
      if (!refresh_token) return json(request, env, { error: 'refresh_token_manquant' }, 400);

      let tok, r;
      try {
        r = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            refresh_token,
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            grant_type: 'refresh_token'
          })
        });
        tok = await r.json();
      } catch (e) {
        // panne réseau côté worker : 503, l'app saura qu'il ne faut PAS déconnecter
        return json(request, env, { error: 'reseau_google' }, 503);
      }
      // 400 invalid_grant = autorisation révoquée / expirée : l'app doit reconnecter
      return json(request, env, tok, r.ok ? 200 : (r.status === 400 || r.status === 401 ? 401 : 502));
    }

    // 4) Sauvegarde cloud — avec historique et protection contre l'écrasement
    if (url.pathname === '/backup') {
      if (!env.BACKUPS) return texte(request, env, 'Stockage KV non configuré (binding BACKUPS)', 501);
      const pass = request.headers.get('X-Backup-Key');
      if (!pass || pass.length < 6) return texte(request, env, 'Phrase secrète manquante (6 caractères min.)', 401);
      const key = await backupKey(pass);

      const compter = (txt) => {
        try {
          const o = JSON.parse(txt);
          if (!o || typeof o !== 'object') return -1;
          let n = 0;
          for (const k of Object.keys(o)) if (Array.isArray(o[k]) && k !== 'settings') n += o[k].length;
          return n;
        } catch (e) { return -1; }
      };

      // --- lecture ---
      if (request.method === 'GET') {
        // liste de l'historique
        if (url.searchParams.get('list')) {
          const idx = await env.BACKUPS.get(key + ':index');
          return new Response(idx || '[]', { headers: cors(request, env, { 'Content-Type': 'application/json' }) });
        }
        // date / taille de la dernière sauvegarde, sans télécharger tout le contenu
        if (url.searchParams.get('meta')) {
          const m = await env.BACKUPS.get(key + ':meta');
          if (!m) return json(request, env, { vide: true });
          return new Response(m, { headers: cors(request, env, { 'Content-Type': 'application/json' }) });
        }
        // une sauvegarde précise de l'historique
        const ts = url.searchParams.get('ts');
        const data = ts ? await env.BACKUPS.get(key + ':hist:' + ts) : await env.BACKUPS.get(key);
        if (!data) return texte(request, env, 'Aucune sauvegarde trouvée', 404);
        return new Response(data, { headers: cors(request, env, { 'Content-Type': 'application/json' }) });
      }

      // --- écriture ---
      if (request.method === 'PUT' || request.method === 'POST') {
        const body = await request.text();
        if (body.length > 20 * 1024 * 1024) return texte(request, env, 'Sauvegarde trop volumineuse (max 20 Mo)', 413);

        const nouveauNb = compter(body);
        if (nouveauNb < 0) return texte(request, env, 'Contenu illisible', 400);

        const actuel = await env.BACKUPS.get(key);
        const actuelNb = actuel ? compter(actuel) : 0;
        const force = request.headers.get('X-Force') === '1';

        // garde-fou : on refuse d'écraser une sauvegarde pleine par une base vide ou très amputée
        if (!force && actuel && actuelNb > 0 && nouveauNb < Math.max(1, actuelNb * 0.5)) {
          return json(request, env, {
            error: 'refus_ecrasement', cloud: actuelNb, envoye: nouveauNb,
            message: 'La sauvegarde envoyée contient beaucoup moins de données que celle du cloud.'
          }, 409);
        }

        // Rien n'a changé : on ne consomme pas une écriture KV pour rien.
        if (actuel === body) {
          return json(request, env, { ok: true, count: nouveauNb, inchange: true });
        }

        // On archive la version actuelle, mais au plus une fois toutes les 6 h,
        // pour que l'historique couvre une vraie période et pas les 10 dernières minutes.
        let idx = [];
        try { idx = JSON.parse(await env.BACKUPS.get(key + ':index') || '[]'); } catch (e) { idx = []; }
        if (!Array.isArray(idx)) idx = [];
        const dernierArchive = idx.length ? +idx[0].ts : 0;
        if (actuel && Date.now() - dernierArchive > INTERVALLE_ARCHIVE) {
          const ts = Date.now().toString();
          await env.BACKUPS.put(key + ':hist:' + ts, actuel);
          idx.unshift({ ts, count: actuelNb, size: actuel.length, date: new Date().toISOString() });
          for (const vieux of idx.slice(VERSIONS_CONSERVEES)) await env.BACKUPS.delete(key + ':hist:' + vieux.ts);
          idx = idx.slice(0, VERSIONS_CONSERVEES);
          await env.BACKUPS.put(key + ':index', JSON.stringify(idx));
        }

        const meta = { date: new Date().toISOString(), size: body.length, count: nouveauNb };
        await env.BACKUPS.put(key, body);
        await env.BACKUPS.put(key + ':meta', JSON.stringify(meta));
        return json(request, env, { ok: true, count: nouveauNb, ...meta });
      }

      return texte(request, env, 'Méthode non autorisée', 405);
    }

    return texte(request, env, 'Loane Pro — worker Google Agenda & sauvegardes');
  }
};
