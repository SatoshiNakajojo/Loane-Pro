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

    // 4) Sauvegarde cloud (nécessite le stockage KV "BACKUPS", voir README)
    if (url.pathname === '/backup') {
      if (!env.BACKUPS) return new Response('Stockage KV non configuré (binding BACKUPS)', { status: 501, headers: cors(env) });
      const pass = request.headers.get('X-Backup-Key');
      if (!pass || pass.length < 6) return new Response('Phrase secrète manquante (6 caractères min.)', { status: 401, headers: cors(env) });
      const key = await backupKey(pass);

      if (request.method === 'PUT' || request.method === 'POST') {
        const body = await request.text();
        if (body.length > 20 * 1024 * 1024) return new Response('Sauvegarde trop volumineuse (max 20 Mo)', { status: 413, headers: cors(env) });
        await env.BACKUPS.put(key, body);
        await env.BACKUPS.put(key + ':meta', JSON.stringify({ date: new Date().toISOString(), size: body.length }));
        return new Response(JSON.stringify({ ok: true }), { headers: cors(env, { 'Content-Type': 'application/json' }) });
      }
      if (request.method === 'GET') {
        const data = await env.BACKUPS.get(key);
        if (!data) return new Response('Aucune sauvegarde trouvée pour cette phrase secrète', { status: 404, headers: cors(env) });
        return new Response(data, { headers: cors(env, { 'Content-Type': 'application/json' }) });
      }
    }

    return new Response('Studio Vocal — worker d\u2019authentification Google & sauvegardes', { headers: cors(env) });
  }
};
