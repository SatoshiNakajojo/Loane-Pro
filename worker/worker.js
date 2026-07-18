// ====== Worker Cloudflare — authentification Google Agenda ======
// Ce worker garde le "client secret" Google côté serveur.
// Secrets à configurer (wrangler secret put) : GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
// Variable : ALLOWED_ORIGIN (URL de ton site GitHub Pages)

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

function cors(env, extra = {}) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Backup-Key',
    ...extra
  };
}

// Transforme la phrase secrète en clé de stockage (jamais stockée en clair)
async function backupKey(pass) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('studio-vocal:' + pass));
  return 'bk_' + [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors(env) });
    }

    // 1) Démarrage : redirige vers l'écran de connexion Google
    if (url.pathname === '/auth/start') {
      const appRedirect = url.searchParams.get('redirect') || env.ALLOWED_ORIGIN;
      const state = btoa(appRedirect);
      const params = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: url.origin + '/auth/callback',
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        state
      });
      return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params, 302);
    }

    // 2) Retour de Google : échange le code contre des jetons, puis renvoie vers l'app
    if (url.pathname === '/auth/callback') {
      const code = url.searchParams.get('code');
      const appRedirect = atob(url.searchParams.get('state') || '');
      if (!code || !appRedirect) return new Response('Paramètres manquants', { status: 400 });

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
      const tok = await r.json();
      if (!r.ok) return new Response('Erreur Google : ' + JSON.stringify(tok), { status: 500 });

      // Les jetons repartent vers l'app dans le fragment d'URL (jamais loggé côté serveur)
      const payload = encodeURIComponent(btoa(JSON.stringify({
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        expires_in: tok.expires_in
      })));
      return Response.redirect(appRedirect + '#gc=' + payload, 302);
    }

    // 3) Rafraîchissement du jeton d'accès
    if (url.pathname === '/auth/refresh' && request.method === 'POST') {
      const { refresh_token } = await request.json();
      if (!refresh_token) return new Response('refresh_token manquant', { status: 400, headers: cors(env) });
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          grant_type: 'refresh_token'
        })
      });
      const tok = await r.json();
      return new Response(JSON.stringify(tok), {
        status: r.ok ? 200 : 401,
        headers: cors(env, { 'Content-Type': 'application/json' })
      });
    }

    // 4) Sauvegarde cloud — avec historique et protection contre l'écrasement
    if (url.pathname === '/backup') {
      if (!env.BACKUPS) return new Response('Stockage KV non configuré (binding BACKUPS)', { status: 501, headers: cors(env) });
      const pass = request.headers.get('X-Backup-Key');
      if (!pass || pass.length < 6) return new Response('Phrase secrète manquante (6 caractères min.)', { status: 401, headers: cors(env) });
      const key = await backupKey(pass);

      const compter = (txt) => {
        try {
          const o = JSON.parse(txt); let n = 0;
          for (const k of Object.keys(o)) if (Array.isArray(o[k]) && k !== 'settings') n += o[k].length;
          return n;
        } catch (e) { return -1; }
      };

      // --- lecture ---
      if (request.method === 'GET') {
        // liste de l'historique
        if (url.searchParams.get('list')) {
          const idx = await env.BACKUPS.get(key + ':index');
          return new Response(idx || '[]', { headers: cors(env, { 'Content-Type': 'application/json' }) });
        }
        // une sauvegarde précise de l'historique
        const ts = url.searchParams.get('ts');
        const data = ts ? await env.BACKUPS.get(key + ':hist:' + ts) : await env.BACKUPS.get(key);
        if (!data) return new Response('Aucune sauvegarde trouvée', { status: 404, headers: cors(env) });
        return new Response(data, { headers: cors(env, { 'Content-Type': 'application/json' }) });
      }

      // --- écriture ---
      if (request.method === 'PUT' || request.method === 'POST') {
        const body = await request.text();
        if (body.length > 20 * 1024 * 1024) return new Response('Sauvegarde trop volumineuse (max 20 Mo)', { status: 413, headers: cors(env) });

        const nouveauNb = compter(body);
        if (nouveauNb < 0) return new Response('Contenu illisible', { status: 400, headers: cors(env) });

        const actuel = await env.BACKUPS.get(key);
        const actuelNb = actuel ? compter(actuel) : 0;
        const force = request.headers.get('X-Force') === '1';

        // garde-fou : on refuse d'écraser une sauvegarde pleine par une base vide ou très amputée
        if (!force && actuel && actuelNb > 0 && nouveauNb < Math.max(1, actuelNb * 0.5)) {
          return new Response(JSON.stringify({
            error: 'refus_ecrasement', cloud: actuelNb, envoye: nouveauNb,
            message: 'La sauvegarde envoyée contient beaucoup moins de données que celle du cloud.'
          }), { status: 409, headers: cors(env, { 'Content-Type': 'application/json' }) });
        }

        // on archive la version actuelle avant de la remplacer (6 dernières conservées)
        if (actuel) {
          const ts = Date.now().toString();
          await env.BACKUPS.put(key + ':hist:' + ts, actuel);
          let idx = [];
          try { idx = JSON.parse(await env.BACKUPS.get(key + ':index') || '[]'); } catch (e) { }
          idx.unshift({ ts, count: actuelNb, size: actuel.length, date: new Date().toISOString() });
          for (const vieux of idx.slice(6)) await env.BACKUPS.delete(key + ':hist:' + vieux.ts);
          idx = idx.slice(0, 6);
          await env.BACKUPS.put(key + ':index', JSON.stringify(idx));
        }

        await env.BACKUPS.put(key, body);
        await env.BACKUPS.put(key + ':meta', JSON.stringify({ date: new Date().toISOString(), size: body.length, count: nouveauNb }));
        return new Response(JSON.stringify({ ok: true, count: nouveauNb }), { headers: cors(env, { 'Content-Type': 'application/json' }) });
      }
    }

    return new Response('Studio Vocal — worker d\u2019authentification Google & sauvegardes', { headers: cors(env) });
  }
};
