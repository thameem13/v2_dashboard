# Architecture and data layer

Supabase project: **`egsgycizhssexstjrsqi`** ("SPY 0 DTE"), Postgres 17,
`us-west-2`. Pinned read-only in `.mcp.json`.

## End to end

```
TradingView alert
      | webhook
      v
Make.com (team 1174049, outside this repo)        <-- the ingestion
      |
      |  OVP Bucket Sync V2   -> spy_bucket_log_v2
      |  QQQ OVP Bucket V2    -> qqq_bucket_log_v2
      |  TV to Supabase       -> spy_intraday_log
      |  QQQ to Supabase      -> qqq_intraday_log
      v
Supabase Postgres
      |  bucket_v2_all  (view: SPY UNION ALL QQQ, adds a literal symbol column)
      |  session_levels_all, intraday_all, option_premium_all
      |  v2_volume_regime (MATERIALIZED, refreshed every 5 min by pg_cron)
      |
      |  v2_*_by_strategy RPCs - SECURITY DEFINER, search_path pinned,
      |  no anon/authenticated EXECUTE grant
      v
Cloudflare Worker (worker.js)
      |  /api/rpc/<fn>  - holds SUPABASE_SECRET_KEY, allowlists ~30 fn names
      |  /api/test-alert - diagnostic
      |  everything else -> static assets (env.ASSETS)
      v
Browser (js/rpc.js) - same-origin fetch, no key, behind Cloudflare Access
```

Nothing in the browser holds a credential. Nothing in the browser knows which
table a strategy reads: every RPC takes `p_strategy` and resolves it to a
symbol in SQL. **That is the property to preserve** when adding anything.

## The proxy

`worker.js` is the only thing holding `SUPABASE_SECRET_KEY`, which **bypasses
RLS**. Therefore:

- `ALLOWED` is a hardcoded `Set` of permitted function names. Without it the
  proxy would relay to every function in the database, including the
  `set_bucket_candle_ts` trigger function. **A new RPC must be added to
  `ALLOWED` or the proxy answers 403.**
- Only `limit` and `offset` are forwarded from the query string. Nothing else -
  PostgREST honours `select`/`order` on RPC POSTs, and there is no reason to
  let a caller reshape the response.
- Errors always answer JSON, never HTML. `js/rpc.js` sniffs for HTML to detect
  an Access login redirect, so an HTML error body would be misread as an
  expired session and trigger a reload instead of reporting the outage.

## Paging

PostgREST caps every response at 1000 rows and **drops the rest silently** -
no error, no warning. The `Range` header is ignored on RPC POSTs. Because these
RPCs order by `candle_time_ny ASC`, the rows lost were the *newest* ones.

`rpc()` in `js/rpc.js` therefore pages with `?limit=1000&offset=N` until a
short page returns, with a 50-iteration guard. Any new list-returning RPC must
go through `rpc()` / `rpcWithRetry()` to inherit this.

## Refresh and polling

| | |
|---|---|
| Live (today) | 10s poll by default, selectable in the UI |
| Historical range | no poll; the interval select is disabled |
| In-flight calls | aborted via `AbortController` on each new load |
| Retries | `rpcWithRetry`, 3 attempts, 2s/4s/8s backoff; never retries `AbortError` or `AuthError` |
| Build check | separate 5-minute HTML fetch, plus on `visibilitychange` |
| News | 5-minute interval |
| Access session | an auth challenge triggers one reload, rate-limited to one per 30s via `sessionStorage` |

Non-critical data (anomalies, regime context, pin series) is fetched with
`retries = 1` and `.catch(...)` returning an empty value, so its failure
degrades one card instead of blanking the dashboard.

The "Today's Alerts" aggregate view (`currentStrategy === '__all__'`) fans the
flow RPC out over the registry with `Promise.allSettled` and `retries = 1` -
N strategies each backing off 2s/4s/8s would outlast the 10s poll tick.

## Tables the dashboard reads

Only ever through the RPCs - the browser cannot reach a table or view directly.

### `spy_bucket_log_v2` / `qqq_bucket_log_v2` (identical shape)

```
id                  uuid
created_at          timestamptz
candle_time         text
candle_time_ts      timestamptz
trade_date          date
candle_time_ny      timestamp          <-- what everything reads
underlying_price    numeric
atm_strike          numeric
lowest_strike       numeric
highest_strike      numeric
in_grid             boolean
calls_otm  puts_otm  calls_itm  puts_itm  calls_atm  puts_atm             numeric  (cumulative)
calls_otm_inc  puts_otm_inc  calls_itm_inc  puts_itm_inc
calls_atm_inc  puts_atm_inc                                               numeric  (per-bar)
calls_otm_notional  puts_otm_notional
calls_itm_notional  puts_itm_notional                                     numeric  (no ATM notional)
divergence_flow     numeric
```

Row counts: SPY 3,798 / QQQ 2,178. Neither has a `symbol` column - the symbol
is implied by which table the row is in, and `bucket_v2_all` adds it as a
literal. A unique constraint here must therefore key on `candle_time_ny`
alone, not `(symbol, candle_time_ny)`.

### `strategies` - the registry

```
id          text     e.g. 'two_tier_divergence_spy'
name        text     'Two-Tier Divergence'
symbol      text     'SPY' | 'QQQ'
status      text     'live'; 'retired' is filtered out everywhere
sort_order  integer  dropdown order
params      jsonb    see bucket-model.md
created_at  timestamptz
```

Two rows today. This table is the seam that makes new strategies additive.

### Supporting views

| View | Contents |
|---|---|
| `bucket_v2_all` | SPY `UNION ALL` QQQ, plus `symbol` |
| `session_levels_all` | POC / VAL / VAH per candle. `qqq_session_view` carries 3 duplicate `candle_time_ny`, so every consumer must `DISTINCT ON` |
| `intraday_all` | VIX1D, TICK, vw_dim, walls, implied move. NYSE TICK is market-wide, so every strategy reads the SPY copy |
| `option_premium_all` | option premium feed for the backtest tab |
| `v2_volume_regime` | **materialized.** Must stay materialized - as a plain view the planner estimated 72.8M rows from a 250-row log and ran over two minutes. Its unique index is required for `REFRESH CONCURRENTLY`, without which the refresh takes an `AccessExclusiveLock` and blocks the dashboard every five minutes |

### Legacy, not read by the dashboard

`v2_signal_log` (stale since 2026-11-06), `v2_anomaly_log` (2026-10-19),
`spy_bucket_log` (v1 - the only table carrying the `set_bucket_candle_ts`
trigger; the v2 tables do not have it).

## RPCs

All `SECURITY DEFINER`, `search_path` pinned to `public, pg_temp`, and **no**
`anon`/`authenticated` EXECUTE grant - reachable only through the proxy.

| RPC | Args | Returns |
|---|---|---|
| `list_strategies` | - | the registry |
| `v2_dashboard_by_strategy` | `p_date, p_strategy` | the Flow tab: one row per bar with score, grade, gates, reason |
| `v2_dashboard_range_by_strategy` | `p_start, p_end, p_strategy` | same over a range |
| `v2_volume_enriched_today_by_strategy` | `p_date, p_strategy` | per-bar volume, C/P ratios, rVOL |
| `v2_volume_enriched_range_by_strategy` | `p_start, p_end, p_strategy` | same over a range |
| `v2_anomalies_today_by_strategy` | `p_date, p_strategy` | volume surges (derived, not from `v2_anomaly_log`) |
| `v2_anomalies_range_by_strategy` | `p_start, p_end, p_strategy` | same over a range |
| `v2_regime_context_by_strategy` | `p_date, p_strategy` | at most one row: VIX1D, TICK, vw_dim, walls |
| `v2_signal_performance_by_strategy` | `p_start, p_end, p_strategy` | forward returns per signal |
| `v2_pin_series_by_strategy` | `p_start, p_end, p_strategy` | per-candle `call_wall` / `put_wall` |
| `v2_premium_sources` | - | which strategies have a premium feed |
| `v2_premium_backtest_by_strategy` | `p_start, p_end, p_strategy, p_tp, p_sl, p_grades, p_entry_lag_min, p_entry_window_min` | the trade ledger |
| `v2_vol_regime_profile_by_strategy` | `p_strategy` | |
| `v2_vol_regime_perf_by_strategy` | `p_strategy` | signal performance by regime |
| `v2_vol_regime_status_by_strategy` | `p_strategy` | current regime + the cutoffs actually used |
| `v2_vol_regime_days_by_strategy` | `p_strategy` | per-session quality |
| `v2_vol_regime_flow_by_strategy` | `p_strategy` | the Session Flow table |

Plus one internal helper, **not** in `ALLOWED` and not callable from the
browser: `v2_signal_enriched_by_strategy(p_strategy)` derives the signal set
(symbol, ts, direction, grade, regime, and signed `bp_30`/`bp_60`/`bp_eod`
forward returns) and backs the three regime RPCs above. A function the browser
cannot name is one less thing to audit.

Plus the original SPY-only set (`v2_dashboard_today`, `v2_dashboard_range`,
`v2_volume_enriched_today/_range`, `v2_anomalies_today/_range`,
`v2_regime_context`, `v2_signal_performance`), still allowlisted so a page
cached from before the strategy switch keeps working.

### `v2_dashboard_by_strategy` return columns

```
candle_time_ny timestamp     price numeric        atm_strike numeric
flow numeric                 is_flip boolean      direction text ('CALL'|'PUT'|'none')
poc val vah numeric          room numeric
sf sv_ si sr sc integer      score integer        grade text ('A'|'B'|'C'|'D')
poc_aligned boolean          room_ok boolean      in_window boolean
has_signal boolean           reason text
s_flow s_vol s_inst s_clean integer               tick numeric
```

Note the duplicated score columns (`sf` and `s_flow` etc.) - the short names
came first, the `s_*` aliases were added for the frontend. Both are populated.

### Three quirks that have caused real bugs

1. **`v2_dashboard_by_strategy` does not mean "today".** With no candles yet
   for the current session it returns the **last** session instead. The
   dashboard carries a "Showing last session" banner for this; the alert cron
   filters on `nyToday()` because without that it replayed Friday afternoon's
   near misses into Telegram on a Sunday.
2. **On the "All" preset both dates are null**, and the range RPCs read that as
   all of history - but `v2_pin_series_by_strategy` reads it as the latest
   session. Deliberate: the pin card describes one session.
3. **The volume-regime signal RPCs work for both symbols** as of 2026-11-12.
   They used to be SPY-only, going through `v2_signal_enriched` ->
   `v2_signal_log` (no symbol column). They now call
   `v2_signal_enriched_by_strategy`, which derives the signal set from
   `v2_dashboard_range_by_strategy` - so the regime tab and the flow tab share
   one definition of "what is a signal" and cannot disagree. Do not point
   anything new at `v2_signal_log`.

## Scheduled work

| Where | Schedule (UTC) | What |
|---|---|---|
| `wrangler.jsonc` cron | `*/1 13-21 * * 1-5` | Telegram alerts via `worker.js` `scheduled()` |
| pg_cron job 1 | `*/2 13-21 * * 1-5` | `spy-option-premium` edge function |
| pg_cron job 2 | `1-59/2 13-21 * * 1-5` | `qqq-option-premium` edge function |
| pg_cron job 5 | `*/5 13-21 * * 1-5` | `REFRESH MATERIALIZED VIEW CONCURRENTLY v2_volume_regime` |

Weekday market hours only, with margin either side to cover EDT and EST
without a twice-yearly edit.

**The cron expression in `wrangler.jsonc` is not a guarantee.** It has been out
of sync with the deployed Worker before (deployed `*/30 * * * *` while the file
said weekday hours), which is why `alertForStrategy` checks the session date
itself rather than trusting the schedule.

## Telegram alerting

Server-side in `worker.js`, deliberately independent of the browser - the
dashboard only alerts while its tab is open, and a corporate network can block
it outright.

- **One KV cursor per strategy**: `lastAlertedCandle:<strategy-id>` in the
  `ALERTS` namespace. A single shared cursor let whichever symbol ran first
  move it past the other's candles, and the loser went silently quiet.
- Sends grade A/B **and** near misses (a high-grade candle blocked only by a
  gate is worth seeing). C and D are the bulk of a session and would become
  noise.
- `MAX_PER_TICK = 5` bounds a burst if the cursor is lost mid-session.
- The cursor advances only past candles that **actually sent**, and a Telegram
  200 carrying `{"ok":false}` counts as a failure.
- Volume and wall context are fetched lazily, only when something is going
  out, and never block a send - missing context must not cost the alert.
- `/api/test-alert?quiet=1` reports what the cron sees (row counts, grades,
  cursors, staleness) per strategy without sending. Use it to answer "why no
  alert today"; the send path can be healthy while the selection finds
  nothing, and from outside those look identical.

## Edge functions

| Slug | `verify_jwt` | Purpose |
|---|---|---|
| `spy-option-premium` | true | premium feed, driven by pg_cron |
| `qqq-option-premium` | true | premium feed, driven by pg_cron |

The `dashboard` function - an obsolete standalone copy of the whole dashboard,
`verify_jwt: false`, reachable by anyone outside Cloudflare Access - was
**deleted on 2026-11-12**. Do not recreate anything like it; see
[security.md](security.md).
