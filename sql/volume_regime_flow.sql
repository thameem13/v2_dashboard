/* volume_regime_flow - one row per 30-minute bucket, volume and outcome side
 * by side. Backs the Session Flow table at the head of the Volume Regime tab.
 *
 * Step 4 of the volume-regime work. Run sql/volume_regime.sql and
 * sql/volume_regime_rpcs.sql first; this reads v2_volume_regime,
 * v2_signal_enriched and v2_vol_regime_config.
 *
 * Why a fifth RPC rather than widening the profile one: the profile answers
 * "what share of a session trades in this half hour" and is per-symbol and
 * clean-days-only. This answers "and what did the signals that fired on those
 * bars actually do", which is SPY-only and has to count every signal. Two
 * different populations behind one row, so the row has to say which n belongs
 * to which - every signal column here is NULL, not 0, for a non-SPY strategy.
 *
 * -- Bucketing --------------------------------------------------------------
 * Signals are bucketed on the SAME shifted stamp as the volume bars: bars are
 * stamped end-of-interval, so the 10:00 bar covers 09:55-10:00, and a signal
 * stamped 10:00 is the signal that fired off that bar. Shifting both back one
 * bar width keeps a signal in the same row as the volume it fired on. Flooring
 * the signal clock instead would put it one row below its own bar's volume,
 * and the whole point of the table is that the two columns line up.
 *
 * -- Bad sessions -----------------------------------------------------------
 * The volume columns are clean sessions only, as everywhere else here - a
 * frozen feed would bend the shape of the curve. The signal columns are NOT,
 * and that is deliberate: a frozen OPTION feed says nothing about the price
 * log the returns come from, so dropping those signals would discard real
 * outcomes for an unrelated fault. n_bad rides along so the client can say how
 * many of a bucket's signals fell on an excluded session. Bad days are
 * excluded from baselines, not from P&L.
 *
 * Returns are measured from spy_intraday_log, which is historical - a
 * 15-minute delay on the live feed has no bearing on any number in this
 * result. The status panel is the only part of the tab that reads the current
 * bar.
 */


/* --------------------------------------------------------------------------
   1. A per-bucket reliability threshold
   --------------------------------------------------------------------------
   min_n_reliable is 100, which is the right order of magnitude for three
   regime buckets over 250 signals and impossible for thirteen time buckets
   over 179. A separate column rather than a constant in the JavaScript, for
   the same reason as every other cutoff in this schema: retuning it is an
   UPDATE, and the page shows the number it is actually using instead of a
   copy that can drift. */
ALTER TABLE public.v2_vol_regime_config
  ADD COLUMN IF NOT EXISTS min_n_bucket integer NOT NULL DEFAULT 10;


/* --------------------------------------------------------------------------
   2. The flow RPC
   --------------------------------------------------------------------------
   FULL OUTER JOIN, not LEFT: the volume side is clean sessions only and the
   signal side is every session, so in principle a bucket can hold signals
   with no clean-session bars behind it. Today none does. A LEFT JOIN would
   silently drop those signals and the table's own total would stop matching
   the signal log, which is exactly the class of quiet loss this tab exists to
   make visible.

   DROP first: the function is new, but naming it here keeps a later
   return-type change from failing with 42P13 the way (c) did. */
DROP FUNCTION IF EXISTS public.v2_vol_regime_flow_by_strategy(text);

CREATE OR REPLACE FUNCTION public.v2_vol_regime_flow_by_strategy(
  p_strategy text DEFAULT 'two_tier_divergence_spy'
)
RETURNS TABLE(
  bucket_start  time without time zone,
  bucket_label  text,
  avg_pct       numeric,   -- avg share of a session's option volume
  days_n        integer,   -- clean sessions behind avg_pct
  n             integer,   -- signals that fired on this bucket's bars
  n_bad         integer,   -- of those, how many on an excluded session
  n_30          integer,
  n_60          integer,
  n_eod         integer,
  win_30        integer,   -- winners, not a rate: the client needs W and L
  win_60        integer,
  win_eod       integer,
  avg_bp_30     numeric,
  avg_bp_60     numeric,
  avg_bp_eod    numeric,
  sum_bp_30     numeric,   -- summed, not n * avg: rounding an average and
  sum_bp_60     numeric,   -- multiplying it back up drifts by whole bps
  sum_bp_eod    numeric,
  min_n_bucket  integer,
  has_signals   boolean    -- false for a non-SPY strategy, so the client can
)                          -- tell "none in this bucket" from "not applicable"
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH sym AS (
    SELECT coalesce((SELECT s.symbol FROM strategies s WHERE s.id = p_strategy), 'SPY') AS symbol
  ),
  cfg AS (SELECT * FROM v2_vol_regime_config),

  /* -- volume side: clean sessions only, shares averaged per day ---------- */
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
    SELECT bucket_start,
           round(avg(pct), 2) AS avg_pct,
           count(*)::integer  AS days_n
    FROM shares
    GROUP BY bucket_start
  ),

  /* -- signal side: every session, SPY only ------------------------------- */
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
    FROM v2_signal_enriched e
    /* SPY-only, for the reason in the header of volume_regime_rpcs.sql:
       v2_signal_log has no symbol column. */
    WHERE (SELECT symbol FROM sym) = 'SPY'
    GROUP BY 1
  )
  SELECT
    coalesce(v.bucket_start, g.bucket_start)                     AS bucket_start,
    to_char(coalesce(v.bucket_start, g.bucket_start), 'HH24:MI') AS bucket_label,
    v.avg_pct,
    coalesce(v.days_n, 0)                                        AS days_n,
    g.n, g.n_bad, g.n_30, g.n_60, g.n_eod,
    g.win_30, g.win_60, g.win_eod,
    g.avg_bp_30, g.avg_bp_60, g.avg_bp_eod,
    g.sum_bp_30, g.sum_bp_60, g.sum_bp_eod,
    cfg.min_n_bucket,
    ((SELECT symbol FROM sym) = 'SPY')                           AS has_signals
  FROM vol v
  FULL OUTER JOIN sig g ON g.bucket_start = v.bucket_start
  CROSS JOIN cfg
  ORDER BY 1;
$function$;


/* --------------------------------------------------------------------------
   GRANTS
   --------------------------------------------------------------------------
   service_role only, and the revoke runs first because CREATE OR REPLACE
   keeps the privileges already on the function. See the foot of
   sql/v2_pin_series_by_strategy.sql for why that matters here. */
REVOKE EXECUTE ON FUNCTION public.v2_vol_regime_flow_by_strategy(text) FROM anon, authenticated, public;
GRANT  EXECUTE ON FUNCTION public.v2_vol_regime_flow_by_strategy(text) TO service_role;


/* Add this to ALLOWED in worker.js or the proxy answers 403:
     v2_vol_regime_flow_by_strategy
*/
