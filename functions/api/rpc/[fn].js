/* Cloudflare Pages Function — Supabase RPC proxy.
 *
 * Exists so the browser never holds a Supabase credential. The secret key lives
 * only in Pages encrypted env vars; the client calls /api/rpc/<fn> same-origin,
 * and Cloudflare Access gates this path along with the rest of the site.
 *
 * Env vars (Pages dashboard -> Settings -> Environment variables, ENCRYPTED):
 *   SUPABASE_URL         https://egsgycizhssexstjrsqi.supabase.co
 *   SUPABASE_SECRET_KEY  sb_secret_...   (NEVER commit this)
 */

/* The secret key bypasses RLS entirely, so without this allowlist the proxy
   would be an open relay to every function in the database - including the
   set_bucket_candle_ts trigger. Strictly worse than the exposure it replaces.
   Adding a strategy later means adding its RPC name here. */
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

/* index.html pages with ?limit=&offset= (see rpcPage). Those must survive the
   hop or every range silently truncates at PostgREST's 1000-row cap. Nothing
   else is forwarded - PostgREST also honours select/order on RPC POSTs, and
   there is no reason to let a caller reshape the response. */
const PASS_THROUGH_PARAMS = ['limit', 'offset'];

const json = (obj, status) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json' },
});

export async function onRequestPost(context) {
  const { params, request, env } = context;
  const fn = params.fn;

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
  const target = `${env.SUPABASE_URL}/rest/v1/rpc/${fn}${qs ? '?' + qs : ''}`;

  const upstream = await fetch(target, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SECRET_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: await request.text(),
  });

  // Status passes through so rpcWithRetry's existing !res.ok handling still works.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': 'no-store',
    },
  });
}
