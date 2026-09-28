/* Cloudflare Worker — static dashboard + Supabase RPC proxy.
 *
 * Why this exists: index.html currently ships a Supabase key to the browser,
 * where it can never be secret. Here the secret key lives only in Worker
 * bindings, the client calls /api/rpc/<fn> same-origin, and Access gates the
 * whole hostname.
 *
 * Bindings (Settings -> Bindings, NOT Builds -> build variables):
 *   SUPABASE_URL         https://egsgycizhssexstjrsqi.supabase.co   (plaintext)
 *   SUPABASE_SECRET_KEY  sb_secret_...                              (secret)
 */

/* The secret key bypasses RLS, so without this allowlist the proxy would relay
   to every function in the database - including the set_bucket_candle_ts
   trigger. Adding a strategy later means adding its RPC name here. */
const ALLOWED = new Set([
  'v2_dashboard_today',
  'v2_dashboard_range',
  'v2_volume_enriched_today',
  'v2_volume_enriched_range',
  'v2_anomalies_today',
  'v2_anomalies_range',
  'v2_regime_context',
  'v2_signal_performance',
]);

/* rpcPage() pages with ?limit=&offset=. Those must survive the hop or every
   range silently truncates at PostgREST's 1000-row cap. Nothing else is
   forwarded - PostgREST honours select/order on RPC POSTs too, and there is no
   reason to let a caller reshape the response. */
const PASS_THROUGH_PARAMS = ['limit', 'offset'];

const json = (obj, status) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json' },
});

async function proxyRpc(request, env, fn) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!ALLOWED.has(fn)) return json({ error: 'Unknown function' }, 403);

  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    // Fail loudly rather than forwarding an unauthenticated request.
    return json({ error: 'Proxy not configured' }, 500);
  }

  const incoming = new URL(request.url).searchParams;
  const forwarded = new URLSearchParams();
  for (const p of PASS_THROUGH_PARAMS) {
    if (incoming.has(p)) forwarded.set(p, incoming.get(p));
  }
  const qs = forwarded.toString();

  const upstream = await fetch(
    `${env.SUPABASE_URL}/rest/v1/rpc/${fn}${qs ? '?' + qs : ''}`,
    {
      method: 'POST',
      headers: {
        'apikey': env.SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: await request.text(),
    }
  );

  // Status passes through so rpcWithRetry's existing !res.ok handling still works.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': 'no-store',
    },
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith('/api/rpc/')) {
      return proxyRpc(request, env, pathname.slice('/api/rpc/'.length));
    }

    // Everything else is the static site (index.html and friends).
    return env.ASSETS.fetch(request);
  },
};
