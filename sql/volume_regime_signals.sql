/* volume_regime_signals - derive the signal set instead of reading the log.
 *
 * Step 5 of the volume-regime work. Run sql/volume_regime.sql,
 * sql/volume_regime_rpcs.sql and sql/volume_regime_flow.sql first; this
 * replaces three of those RPCs and adds one function.
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 * Every signal number on the tab came from v2_signal_log, which has columns
 * (signal_time, direction, grade, atm_strike, logged_at) and NO symbol. Two
 * consequences, one known and one not:
 *
 *   1. QQQ could never have signal numbers. The tab said "n/a" and a banner
 *      explained why, which was honest but permanent.
 *   2. The log is written by something outside this repo - not worker.js, not
 *      pg_cron - and it stopped on 2026-11-06. On 2026-11-12 the tab was
 *      scoring 250 signals while the rule actually fired 277. Six days and 27
 *      signals of silent drift, with nothing on the page to show it.
 *
 * (2) is the real argument. A log maintained by an external writer is a
 * dependency that can die quietly, and a tab built to make quiet losses
 * visible should not rest on one.
 *
 * The signal rule is already in SQL, in v2_dashboard_range_by_strategy, which
 * the Flow Signal tab reads and which works for both symbols. So this derives
 * the signal set from that function rather than duplicating the rule: one
 * definition of "what is a signal", and the regime tab and the flow tab can
 * never disagree about it.
 *
 * ── Validation before the switch (2026-11-12) ──────────────────────────────
 * Derived SPY signals vs the log, over the log's whole life:
 *
 *     derived 277 | logged 250 | matched on timestamp 250
 *     direction mismatches 0 | grade 0 | atm_strike 0
 *     logged rows NOT in the derived set: 0
 *
 * The derived set reproduces the log exactly and is a strict superset of it.
 * Day for day the two agree through 2026-11-06; the extra 27 are that day's
 * last signal plus every signal on 11-10, 11-11 and 11-12, when the writer was
 * already dead. So this is not a change of definition, it is the same set
 * brought up to date and extended to QQQ (153 signals over 29 sessions).
 *
 * ── Cost ───────────────────────────────────────────────────────────────────
 * Deriving the whole history costs ~117 ms (277 signals out of 3,798 bars).
 * Three RPCs call it per tab load, in parallel, so no materialized view is
 * warranted. Revisit if the history grows an order of magnitude.
 *
 * v2_signal_enriched, the old log-reading view, is deliberately left in place
 * and no longer read by this tab. It is the last thing that can still show
 * what the log itself contains, which is the only way to notice the writer has
 * come back.
 */


/* --------------------------------------------------------------------------
   1. The derived, enriched signal set - per strategy, either symbol
   --------------------------------------------------------------------------
   Same shape as v2_signal_enriched plus a symbol column, so the three RPCs
   below change their FROM and almost nothing else.

   The price CTE is DISTINCT ON (ny) and that is not defensive dressing: QQQ
   carries four duplicated timestamps in intraday_all (5,937 rows, 5,933
   distinct). They are exact duplicates - same price to the cent, checked - so
   taking one loses nothing, but leaving them in would double-count any signal
   landing on one of those four bars, and a doubled trade is invisible in every
   column except n. */

CREATE OR REPLACE FUNCTION public.v2_signal_enriched_by_strategy(
  p_strategy text DEFAULT 'two_tier_divergence_spy'
)
RETURNS TABLE(
  symbol      text,
  ts          timestamp without time zone,
  ny_date     date,
  direction   text,
  grade       text,
  atm_strike  numeric,
  vol_30m     numeric,
  baseline    numeric,
  baseline_n  integer,
  vratio      numeric,
  vol_regime  text,
  day_quality text,
  px_0        numeric,
  bp_30       numeric,
  bp_60       numeric,
  bp_eod      numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH sym AS (
    SELECT coalesce((SELECT s.symbol FROM strategies s WHERE s.id = p_strategy), 'SPY') AS symbol
  ),
  /* The one definition of "signal", borrowed rather than copied. */
  sig AS (
    SELECT d.candle_time_ny AS ts,
           d.direction,
           d.grade,
           d.atm_strike,
           CASE d.direction WHEN 'CALL' THEN 1 WHEN 'PUT' THEN -1 ELSE NULL END AS sgn
    FROM v2_dashboard_range_by_strategy(NULL, NULL, p_strategy) d
    WHERE d.has_signal
  ),
  px AS (
    SELECT DISTINCT ON (ny) ny, price FROM (
      SELECT (i.candle_time_ts AT TIME ZONE 'America/New_York') AS ny, i.price
      FROM intraday_all i
      WHERE i.symbol = (SELECT symbol FROM sym)
        AND i.price IS NOT NULL
    ) z ORDER BY ny, price
  ),
  eod AS (
    SELECT DISTINCT ON (ny::date) ny::date AS ny_date, price
    FROM px ORDER BY ny::date, ny DESC
  )
  SELECT
    (SELECT symbol FROM sym)          AS symbol,
    s.ts,
    s.ts::date                        AS ny_date,
    s.direction,
    s.grade,
    s.atm_strike,
    r.vol_30m,
    r.baseline,
    r.baseline_n,
    r.vratio,
    /* A signal on a bad session gets DATA_BAD instead of a regime; NO_BAR
       covers a signal with no matching bucket bar at all. Neither goes null,
       which would read as "not yet classified". */
    coalesce(r.regime, 'NO_BAR')      AS vol_regime,
    coalesce(r.day_quality, 'NO_BAR') AS day_quality,
    p0.price                          AS px_0,
    /* Signed: positive means the signal's direction was right. A missing
       forward bar yields NULL, never 0, so it cannot be averaged in as a flat
       trade. */
    round((s.sgn * (p30.price - p0.price) / nullif(p0.price, 0) * 10000)::numeric, 2) AS bp_30,
    round((s.sgn * (p60.price - p0.price) / nullif(p0.price, 0) * 10000)::numeric, 2) AS bp_60,
    round((s.sgn * (e.price   - p0.price) / nullif(p0.price, 0) * 10000)::numeric, 2) AS bp_eod
  FROM sig s
  LEFT JOIN px  p0  ON p0.ny  = s.ts
  LEFT JOIN px  p30 ON p30.ny = s.ts + interval '30 minutes'
  LEFT JOIN px  p60 ON p60.ny = s.ts + interval '60 minutes'
  LEFT JOIN eod e   ON e.ny_date = s.ts::date
  LEFT JOIN v2_volume_regime r
    ON r.symbol = (SELECT symbol FROM sym) AND r.ts = s.ts;
$function$;


/* --------------------------------------------------------------------------
   2. Flow, repointed - and no longer half SPY-only
   -------------------------------------------------------------------------- */
DROP FUNCTION IF EXISTS public.v2_vol_regime_flow_by_strategy(text);

CREATE OR REPLACE FUNCTION public.v2_vol_regime_flow_by_strategy(
  p_strategy text DEFAULT 'two_tier_divergence_spy'
)
RETURNS TABLE(
  bucket_start  time without time zone,
  bucket_label  text,
  avg_pct       numeric,
  days_n        integer,
  n             integer,
  n_bad         integer,
  n_30          integer,
  n_60          integer,
  n_eod         integer,
  win_30        integer,
  win_60        integer,
  win_eod       integer,
  avg_bp_30     numeric,
  avg_bp_60     numeric,
  avg_bp_eod    numeric,
  sum_bp_30     numeric,
  sum_bp_60     numeric,
  sum_bp_eod    numeric,
  min_n_bucket  integer,
  /* Retained, and now always true. The client distinguishes "no signals in
     this bucket" from "not applicable to this strategy", and nothing is
     not-applicable any more - but the distinction is real and the column is
     what carries it, so removing it would bake today's situation in. */
  has_signals   boolean
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH sym AS (
    SELECT coalesce((SELECT s.symbol FROM strategies s WHERE s.id = p_strategy), 'SPY') AS symbol
  ),
  cfg AS (SELECT * FROM v2_vol_regime_config),
  bucketed AS (
    SELECT r.ny_date,
           (date_trunc('hour', (r.tod - interval '5 minutes')::interval)
             + floor(extract(minute FROM (r.tod - interval '5 minutes')) / 30)
               * interval '30 minutes')::time AS bucket_start,
           sum(r.bar_vol) AS bucket_vol
    FROM v2_volume_regime r
    WHERE r.symbol = (SELECT symbol FROM sym)
      AND r.day_quality = 'CLEAN'
    GROUP BY 1, 2
  ),
  shares AS (
    SELECT ny_date, bucket_start,
           100.0 * bucket_vol / nullif(sum(bucket_vol) OVER (PARTITION BY ny_date), 0) AS pct
    FROM bucketed
  ),
  vol AS (
    SELECT bucket_start, round(avg(pct), 2) AS avg_pct, count(*)::integer AS days_n
    FROM shares GROUP BY bucket_start
  ),
  sig AS (
    SELECT
      (date_trunc('hour', (e.ts::time - interval '5 minutes')::interval)
        + floor(extract(minute FROM (e.ts::time - interval '5 minutes')) / 30)
          * interval '30 minutes')::time AS bucket_start,
      count(*)::integer                                         AS n,
      count(*) FILTER (WHERE e.day_quality <> 'CLEAN')::integer AS n_bad,
      count(e.bp_30)::integer                                   AS n_30,
      count(e.bp_60)::integer                                   AS n_60,
      count(e.bp_eod)::integer                                  AS n_eod,
      count(*) FILTER (WHERE e.bp_30  > 0)::integer             AS win_30,
      count(*) FILTER (WHERE e.bp_60  > 0)::integer             AS win_60,
      count(*) FILTER (WHERE e.bp_eod > 0)::integer             AS win_eod,
      round(avg(e.bp_30),  2)                                   AS avg_bp_30,
      round(avg(e.bp_60),  2)                                   AS avg_bp_60,
      round(avg(e.bp_eod), 2)                                   AS avg_bp_eod,
      round(sum(e.bp_30),  2)                                   AS sum_bp_30,
      round(sum(e.bp_60),  2)                                   AS sum_bp_60,
      round(sum(e.bp_eod), 2)                                   AS sum_bp_eod
    FROM v2_signal_enriched_by_strategy(p_strategy) e
    GROUP BY 1
  )
  SELECT
    coalesce(v.bucket_start, g.bucket_start)                     AS bucket_start,
    to_char(coalesce(v.bucket_start, g.bucket_start), 'HH24:MI') AS bucket_label,
    v.avg_pct,
    coalesce(v.days_n, 0)                                        AS days_n,
    coalesce(g.n, 0), coalesce(g.n_bad, 0),
    coalesce(g.n_30, 0), coalesce(g.n_60, 0), coalesce(g.n_eod, 0),
    coalesce(g.win_30, 0), coalesce(g.win_60, 0), coalesce(g.win_eod, 0),
    g.avg_bp_30, g.avg_bp_60, g.avg_bp_eod,
    g.sum_bp_30, g.sum_bp_60, g.sum_bp_eod,
    cfg.min_n_bucket,
    true AS has_signals
  FROM vol v
  FULL OUTER JOIN sig g ON g.bucket_start = v.bucket_start
  CROSS JOIN cfg
  ORDER BY 1;
$function$;


/* --------------------------------------------------------------------------
   3. Performance by regime, repointed - QQQ now has one
   -------------------------------------------------------------------------- */
CREATE OR REPLACE FUNCTION public.v2_vol_regime_perf_by_strategy(
  p_strategy text DEFAULT 'two_tier_divergence_spy'
)
RETURNS TABLE(
  vol_regime      text,
  n               integer,
  n_30            integer,
  n_60            integer,
  win_30          numeric,
  win_60          numeric,
  avg_bp_30       numeric,
  avg_bp_60       numeric,
  avg_bp_eod      numeric,
  min_n_reliable  integer,
  is_reliable     boolean
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH cfg AS (SELECT * FROM v2_vol_regime_config)
  SELECT
    e.vol_regime,
    count(*)::integer       AS n,
    count(e.bp_30)::integer AS n_30,
    count(e.bp_60)::integer AS n_60,
    round(100.0 * avg(CASE WHEN e.bp_30 > 0 THEN 1.0 ELSE 0 END)
          FILTER (WHERE e.bp_30 IS NOT NULL), 0) AS win_30,
    round(100.0 * avg(CASE WHEN e.bp_60 > 0 THEN 1.0 ELSE 0 END)
          FILTER (WHERE e.bp_60 IS NOT NULL), 0) AS win_60,
    round(avg(e.bp_30),  2) AS avg_bp_30,
    round(avg(e.bp_60),  2) AS avg_bp_60,
    round(avg(e.bp_eod), 2) AS avg_bp_eod,
    cfg.min_n_reliable,
    (count(*) >= cfg.min_n_reliable) AS is_reliable
  FROM v2_signal_enriched_by_strategy(p_strategy) e
  CROSS JOIN cfg
  GROUP BY e.vol_regime, cfg.min_n_reliable
  ORDER BY CASE e.vol_regime
             WHEN 'LOW' THEN 1 WHEN 'NORMAL' THEN 2 WHEN 'HIGH' THEN 3
             WHEN 'NO_BASELINE' THEN 4 WHEN 'NO_WINDOW' THEN 5 ELSE 6 END;
$function$;


/* --------------------------------------------------------------------------
   4. Excluded sessions, repointed - signals_lost is real for both symbols
   --------------------------------------------------------------------------
   It used to be NULL for anything but SPY, so the client could tell "none"
   from "not applicable". Both symbols now have a signal set, so it is always a
   number. */
CREATE OR REPLACE FUNCTION public.v2_vol_regime_days_by_strategy(
  p_strategy text DEFAULT 'two_tier_divergence_spy'
)
RETURNS TABLE(
  ny_date       date,
  day_quality   text,
  reason_detail text,
  first_bar     time without time zone,
  last_bar      time without time zone,
  bars          integer,
  signals_lost  integer
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH sym AS (
    SELECT coalesce((SELECT s.symbol FROM strategies s WHERE s.id = p_strategy), 'SPY') AS symbol
  ),
  days AS (
    SELECT r.ny_date, r.day_quality, r.frozen_components, r.first_bar, r.last_bar,
           count(*)::integer AS bars
    FROM v2_volume_regime r
    WHERE r.symbol = (SELECT symbol FROM sym)
      AND r.day_quality <> 'CLEAN'
    GROUP BY r.ny_date, r.day_quality, r.frozen_components, r.first_bar, r.last_bar
  ),
  lost AS (
    SELECT e.ny_date, count(*)::integer AS n
    FROM v2_signal_enriched_by_strategy(p_strategy) e
    GROUP BY e.ny_date
  )
  SELECT
    d.ny_date,
    d.day_quality,
    CASE d.day_quality
      WHEN 'BAD_FROZEN'     THEN 'feed frozen: ' || coalesce(d.frozen_components, 'unknown')
      WHEN 'BAD_SHORT_END'  THEN 'session ended ' || to_char(d.last_bar, 'HH24:MI')
      WHEN 'BAD_LATE_START' THEN 'session started ' || to_char(d.first_bar, 'HH24:MI')
      ELSE d.day_quality
    END AS reason_detail,
    d.first_bar, d.last_bar, d.bars,
    coalesce(l.n, 0) AS signals_lost
  FROM days d
  LEFT JOIN lost l ON l.ny_date = d.ny_date
  ORDER BY d.ny_date;
$function$;


/* --------------------------------------------------------------------------
   GRANTS
   --------------------------------------------------------------------------
   service_role only; the revoke runs first because CREATE OR REPLACE keeps
   the privileges already on a function. v2_signal_enriched_by_strategy is NOT
   granted to anything the proxy can reach and is NOT added to ALLOWED in
   worker.js - it is an internal building block for the three RPCs above, and
   a function the browser cannot name is one less thing to audit. */
REVOKE EXECUTE ON FUNCTION public.v2_signal_enriched_by_strategy(text) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.v2_vol_regime_flow_by_strategy(text)  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.v2_vol_regime_perf_by_strategy(text)  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.v2_vol_regime_days_by_strategy(text)  FROM anon, authenticated, public;

GRANT EXECUTE ON FUNCTION public.v2_signal_enriched_by_strategy(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.v2_vol_regime_flow_by_strategy(text)  TO service_role;
GRANT EXECUTE ON FUNCTION public.v2_vol_regime_perf_by_strategy(text)  TO service_role;
GRANT EXECUTE ON FUNCTION public.v2_vol_regime_days_by_strategy(text)  TO service_role;


/* No new names for ALLOWED in worker.js: the three RPCs the browser calls are
   already there, and the function behind them is not callable from it. */
