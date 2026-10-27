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
    const BUILD = '2.6.3';
    const BUILD_TS = '2026-10-26T22:30Z';

    /* ── STATE ── */
    let soundEnabled = true;
    let pushEnabled = false;
    let stickyAlertsEnabled = true;   // persisted as 'v2-sticky-alerts'
    let alertSeq = 0;
    const MAX_STICKY_ALERTS = 8;
    /* Above this many rendered rows the row-count badge warns that the range,
       not the page, is what is slow. A whole session is ~78 rows, so this is
       about twenty of them. */
    const LARGE_RANGE_ROWS = 1500;
    let pollTimer = null;
    let isFetching = false;
    let activeTab = 'flow';
    let lastAlertTimestamp = null;
    /* Aggregate view only: the newest alerted candle already announced, per
       strategy. One scalar cursor cannot serve N strategies - the loudest
       strategy would swallow every other one's alert. */
    let lastAlertByStrategy = {};
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
    /* The merged view carries several symbols at once, and volMap's key has no
       strategy in it - so volume for those rows lives here instead, one map per
       strategy per range, fetched when a row is opened rather than on the poll.
       '' means a fetch is in flight; null means it failed. */
    let volByStrategy = {};
    let lastAnomalyTimestamp = null;
    let volSurgeOnly = false;      // "Surge Only" preset on the volume tab
    /* Grades lit in the flow filter row. Empty means no grade constraint, so
       an untouched filter shows everything - the same default the single
       <select> had with "All" selected. */
    let gradeFilter = new Set();
    /* Aggregate view only: the symbol the flow table is narrowed to, '' for
       all of them. State rather than the <select>'s value because the phone
       renders a second set of chips for it, and two views cannot share a value
       that lives inside one of them. */
    let symFilter = '';
    let volRowsCache = null;       // Raw enriched volume rows, for CSV export
    let regimeCtx = null;          // Latest row from v2_regime_context
    let perfRows = null;           // Rows from v2_signal_performance
    let perfKey = null;            // Date-range key the perfRows were loaded for
    let perfLoading = false;

    /* Premium backtest tab. premTP/premSL are RPC parameters rather than a
       browser-side filter: they decide which bar a trade exits on, which
       cannot be recovered from an already-resolved row set. premSources is
       the per-strategy premium-feed registry, fetched once - it is a property
       of the strategy list, not of the selected strategy, so it survives a
       strategy switch. */
    let premRows = null;
    let premKey = null;
    let premLoading = false;
    let premSources = null;
    let premTP = 0.50;
    let premSL = 0.50;
    let premGrades = ['A', 'B'];

    /* The strategy the dashboard is showing. Every RPC takes it and resolves
       it to a symbol in SQL, so the browser never needs to know which table a
       strategy reads. Seeded with the SPY default so the first render before
       list_strategies() returns is still correct rather than blank. */
    /* The newest build seen on the server, and the one the user has waved away.
       Deliberately NOT persisted: a dismissal should not outlive the problem,
       and the next build must be able to speak up again. */
    let latestBuildSeen = null;
    let buildNoticeDismissed = null;

    const DEFAULT_STRATEGY = 'two_tier_divergence_spy';
    /* Not a strategy id but a view: "Today's Alerts" fans out to every
       registered strategy and shows their graded candles in one table. It
       rides in currentStrategy so the dropdown, localStorage and every
       isAggregate() branch stay on one piece of state. Double-underscored so
       it can never collide with a real registry id. */
    const ALL_STRATEGIES = '__all__';
    let currentStrategy = DEFAULT_STRATEGY;
    let strategyList = [];

    function isAggregate() { return currentStrategy === ALL_STRATEGIES; }

    const sortConfig = {
      flow: { col: null, asc: true },
      vol: { col: null, asc: true }
    };

