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

/* Shared by the proxy and the alert cron so the credential handling, the
   allowlist and the URL shape live in exactly one place. */
function callSupabase(env, fn, qs, body) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}${qs ? '?' + qs : ''}`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SECRET_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body,
  });
}

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

  const upstream = await callSupabase(env, fn, qs, await request.text());

  // Status passes through so rpcWithRetry's existing !res.ok handling still works.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': 'no-store',
    },
  });
}


/* ──────────────────────────────────────────────────────────────────────────
   TELEGRAM ALERTS (cron)

   The dashboard only alerts while its tab is open, and a corporate network can
   block it outright. This path does not touch the browser at all: it runs
   server-side on a schedule, so it is unaffected by Access sessions, by which
   network you are on, or by whether anything is open.

   Deliberately NOT routed through Access - a scheduled handler has no request
   to authenticate, and adding an inbound trigger would mean opening a hole in
   the gate we just finished closing.
   ────────────────────────────────────────────────────────────────────────── */

const KV_LAST_ALERT = 'lastAlertedCandle';

/* Grades worth hearing about even when the strategy did not fire. A high-grade
   candle blocked only by the time window is useful to see; C and D are the bulk
   of a session and would turn the channel into noise you learn to ignore. */
const NOTIFY_GRADES = new Set(['A', 'B']);

// Bounds a burst if the KV cursor is ever lost or reset mid-session.
const MAX_PER_TICK = 5;

function candleKey(t) {
  // Normalised to YYYY-MM-DDTHH:MM so plain string comparison orders candles
  // correctly - the RPCs disagree about timestamp vs timestamptz, and a zone
  // suffix on one side would break a > comparison.
  return String(t == null ? '' : t).replace(' ', 'T')
    .replace(/(?:Z|[+-]\d{2}:?\d{2})$/, '').slice(0, 16);
}

function compact(n) {
  // 112200 -> 112.2k, matching how the dashboard renders these so the message
  // and the screen agree at a glance.
  if (n == null || n === '' || isNaN(+n)) return null;
  const v = +n, a = Math.abs(v), sign = v < 0 ? '-' : '';
  if (a >= 1e6) return sign + (a / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return sign + (a / 1e3).toFixed(1) + 'k';
  return sign + String(Math.round(a));
}

/* Volume lives in a different RPC from the signals, so it is joined on the
   normalised candle time exactly as the dashboard's modal does. Fetched only
   when there is something to send, and never allowed to block a send: volume
   is context, and a missing row must not cost you the alert itself. */
async function fetchVolumeMap(env) {
  try {
    const res = await callSupabase(env, 'v2_volume_enriched_today', '', '{}');
    if (!res.ok) { console.log('alerts: volume upstream', res.status); return null; }
    const rows = await res.json();
    if (!Array.isArray(rows)) return null;
    const m = new Map();
    for (const r of rows) m.set(candleKey(r.candle_time_ny), r);
    return m;
  } catch (err) {
    console.log('alerts: volume lookup failed, sending without it');
    return null;
  }
}

function volBlock(v) {
  if (!v) return '';
  const lines = [];

  const c = v.total_calls == null ? null : +v.total_calls;
  const p = v.total_puts == null ? null : +v.total_puts;
  if (c != null && p != null) {
    const net = c - p;
    // The total is the denominator that makes the net readable - +3.7k means
    // something different against 112k than against 12k.
    const side = net > 0 ? 'call-heavy' : (net < 0 ? 'put-heavy' : 'even');
    lines.push(`Volume   ${compact(c + p)} · C ${compact(c)} / P ${compact(p)}`);
    lines.push(`Net      ${net > 0 ? '+' : ''}${compact(net)} ${side}`);
  }

  const ratio = v.call_put_ratio == null ? null : +v.call_put_ratio;
  const dcp = v.dollar_cp_ratio == null ? null : +v.dollar_cp_ratio;
  const lean = r => (r > 1 ? 'call' : (r < 1 ? 'put' : 'even'));

  /* Contract count and dollars can point to opposite sides of parity: lots of
     cheap calls against fewer expensive puts reads call-heavy by headcount and
     put-heavy by money. Prefer the pipeline’s own cp_divergence flag, but
     derive it when absent so the warning never silently disappears. */
  const diverges = v.cp_divergence === true
    || (v.cp_divergence == null && ratio != null && dcp != null && (ratio > 1) !== (dcp > 1));

  if (ratio != null) lines.push(`C/P      ${ratio.toFixed(2)} ${lean(ratio)}-heavy`);
  if (dcp != null) {
    lines.push(`$ C/P    ${dcp.toFixed(2)} ${lean(dcp)}-heavy${diverges ? '  ⚠ money disagrees' : ''}`);
  }

  return lines.length ? '\n' + lines.join('\n') : '';
}

function qualifies(r) {
  return Boolean(r.has_signal) || NOTIFY_GRADES.has(r.grade);
}

function tgEscape(s) {
  // Telegram HTML parse_mode: only these three need escaping, and a stray "&"
  // in a reason string would otherwise make the whole message fail to send.
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function alertText(sig, vol) {
  const dir = sig.direction === 'PUT' ? '🔴 PUT' : '🟢 CALL';
  const time = String(sig.candle_time_ny || '').slice(11, 16);
  const head = sig.has_signal ? '🚨 <b>ALERTED</b>' : '👀 <b>Near miss</b>';
  // On a near miss the reason IS the message: it names the gate that blocked
  // an otherwise high-grade candle.
  const why = sig.has_signal ? '' : `
Why      ${tgEscape(String(sig.reason || '-').replace(/^no signal - /i, ''))}`;
  return `${head} · SPY ${dir} · Grade ${tgEscape(sig.grade)} · Score ${tgEscape(sig.score)}

Strike   <b>${tgEscape(sig.atm_strike)}</b>
Price    <b>${tgEscape(sig.price)}</b>
Flow     <b>${tgEscape(sig.flow)}</b>
Room     <b>${tgEscape(sig.room)}</b>
POC      ${tgEscape(sig.poc)}${volBlock(vol)}
Candle   ${tgEscape(time)} NY${why}

https://dashflow.trade/`;
}

async function sendTelegram(env, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  /* Telegram reports failure in the body as well as the status. Trust both:
     a 200 carrying {"ok":false} must not advance the cursor past an alert that
     was never delivered. */
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON: fall back to status */ }
  return body ? Boolean(body.ok) : res.ok;
}

/* Diagnostic for the alert path, reachable at /api/test-alert while signed in.
   Exists because the cron is unverifiable outside a live session: with no
   candles yet for today there is correctly nothing to send, which looks
   identical to a broken configuration. This sends unconditionally and reports
   exactly which half failed, so the answer arrives in the browser rather than
   requiring logs to be switched on.

   Safe to leave in place: it sits behind Access like everything else, it only
   ever sends to the configured chat, and it never echoes a secret back. */
async function testAlert(env) {
  const state = {
    supabase_url: Boolean(env.SUPABASE_URL),
    supabase_key: Boolean(env.SUPABASE_SECRET_KEY),
    kv_bound: Boolean(env.ALERTS),
    telegram_token: Boolean(env.TELEGRAM_BOT_TOKEN),
    telegram_chat_id: Boolean(env.TELEGRAM_CHAT_ID),
  };

  if (!state.telegram_token || !state.telegram_chat_id) {
    return json({ sent: false, reason: 'Telegram not configured', state }, 200);
  }

  let res, body;
  try {
    res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: 'Test alert from the Trade Flow dashboard. If you can read this, signal alerts will reach you.',
        disable_web_page_preview: true,
      }),
    });
    body = await res.json();
  } catch (err) {
    return json({ sent: false, reason: String((err && err.message) || err), state }, 200);
  }

  return json({
    sent: Boolean(body && body.ok),
    // Telegram's own wording is the useful part - "chat not found" means the
    // bot has never been messaged; "Unauthorized" means a bad token.
    telegram_error: body && body.ok ? null : (body && body.description) || ('HTTP ' + res.status),
    last_alerted_candle: state.kv_bound ? await env.ALERTS.get(KV_LAST_ALERT) : null,
    state,
  }, 200);
}

async function checkAndAlert(env) {
  // Missing bindings must not throw: the site has to keep serving even when
  // alerting is half-configured.
  if (!env.ALERTS || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log('alerts: not configured, skipping');
    return;
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) return;

  const res = await callSupabase(env, 'v2_dashboard_today', '', '{}');
  if (!res.ok) { console.log('alerts: upstream', res.status); return; }

  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return;

  const candidates = rows.filter(qualifies);   // rows arrive oldest-first
  if (!candidates.length) return;

  const raw = await env.ALERTS.get(KV_LAST_ALERT);
  const last = raw ? candleKey(raw) : null;    // normalised, so an old-format value still compares

  let pending;
  if (!last) {
    /* First tick of a session, or the cursor was cleared. Seed from the newest
       candidate rather than replaying the whole session into the chat - a
       deploy at 3pm should not dump every candle since the open. */
    pending = candidates.slice(-1);
  } else {
    pending = candidates.filter(r => candleKey(r.candle_time_ny) > last);
  }
  if (!pending.length) return;

  if (pending.length > MAX_PER_TICK) {
    console.log('alerts: ' + pending.length + ' pending, sending newest ' + MAX_PER_TICK);
    pending = pending.slice(-MAX_PER_TICK);
  }

  /* Oldest first so the chat reads in the order the session happened. The
     cursor advances only past candles that actually sent, so a Telegram
     outage mid-batch is retried next tick instead of being swallowed. */
  // Only now that we know something is going out.
  const volMap = await fetchVolumeMap(env);

  let lastOk = null;
  for (const sig of pending) {
    const vol = volMap ? volMap.get(candleKey(sig.candle_time_ny)) : null;
    const ok = await sendTelegram(env, alertText(sig, vol));
    if (!ok) { console.log('alerts: telegram send failed, will retry next tick'); break; }
    lastOk = candleKey(sig.candle_time_ny);
  }
  if (lastOk) await env.ALERTS.put(KV_LAST_ALERT, lastOk);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // Diagnostic, gated by Access like the rest of the origin.
    if (pathname === '/api/test-alert') {
      try {
        return await testAlert(env);
      } catch (err) {
        return json({ sent: false, reason: String((err && err.message) || err) }, 500);
      }
    }

    if (pathname.startsWith('/api/rpc/')) {
      try {
        return await proxyRpc(request, env, pathname.slice('/api/rpc/'.length));
      } catch (err) {
        /* Without this, an unhandled throw (Supabase unreachable, upstream
           timeout) lets Cloudflare serve its own HTML error page - Error 1101.
           index.html sniffs for HTML to detect an Access login redirect, so an
           HTML body here would be read as an expired session and reload the
           page instead of reporting the outage. Always answer JSON. */
        return json({ error: 'Upstream request failed', detail: String((err && err.message) || err) }, 502);
      }
    }

    // Everything else is the static site (index.html and friends).
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    // waitUntil so a slow Telegram call cannot be cut off mid-send.
    ctx.waitUntil(checkAndAlert(env).catch(err => {
      // A throw here would retry the whole tick; the next cron is a minute
      // away and will pick the signal up anyway, so just record it.
      console.log('alerts: ' + ((err && err.message) || err));
    }));
  },
};
