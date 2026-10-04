/* config.js - build stamp, shared state, sort config
   Split from index.html. These are CLASSIC scripts, not modules:
   top-level let/const share one global lexical scope, so the 29
   mutable state variables and the inline onclick handlers keep
   working exactly as before. Load order is load-bearing. */

    /* ══════════════════════════════════════════════════════
       TRADE FLOW DASHBOARD — ENHANCED
       ══════════════════════════════════════════════════════
       NOTE (#1): There is no Supabase key in this file. The browser calls
       the same-origin /api/rpc/<fn> proxy (worker.js), which holds a secret
       key in Cloudflare Worker secrets and allowlists the eight RPC names.
       A credential shipped to a browser can never be secret, so it is not
       shipped. Cloudflare Access gates the hostname, including /api.
       ══════════════════════════════════════════════════════ */

    /* Bump BUILD on every push. It is rendered in the footer and mirrored in
       a <meta name="build"> tag so the deployed version can be confirmed from
       the browser or with curl - GitHub Pages caches HTML for 10 minutes, so
       "is my change live?" is otherwise unanswerable. */
    const BUILD = '1.10.1';
    const BUILD_TS = '2026-10-04T02:10Z';

    /* ── STATE ── */
    let soundEnabled = true;
    let pushEnabled = false;
    let stickyAlertsEnabled = true;   // persisted as 'v2-sticky-alerts'
    let alertSeq = 0;
    const MAX_STICKY_ALERTS = 8;
    let pollTimer = null;
    let isFetching = false;
    let activeTab = 'flow';
    let lastAlertTimestamp = null;
    let lastSyncTime = null;
    let abortController = null;    // #16 AbortController
    let audioCtx = null;           // #19 Reused AudioContext
    let priceHistory = [];         // #9 Sparkline data
    let flowHistory = [];          // #9 Sparkline data
    let pinnedFlow = new Set();    // Pinned Flow rows
    let pinnedVol = new Set();     // Pinned Vol rows
    let hiddenCols = new Set();    // Hidden Flow columns
    let currentJournalSignal = null;
    let anomalyMap = {};           // Volume anomalies keyed by candle_time_ny
    let volMap = {};               // Enriched volume rows keyed by candle_time_ny
    let lastAnomalyTimestamp = null;
    let volSurgeOnly = false;      // "Surge Only" preset on the volume tab
    let volRowsCache = null;       // Raw enriched volume rows, for CSV export
    let regimeCtx = null;          // Latest row from v2_regime_context
    let perfRows = null;           // Rows from v2_signal_performance
    let perfKey = null;            // Date-range key the perfRows were loaded for
    let perfLoading = false;

    const sortConfig = {
      flow: { col: null, asc: true },
      vol: { col: null, asc: true }
    };

