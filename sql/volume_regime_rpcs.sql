/* volume_regime_rpcs - the four RPCs behind the Volume Regime tab.
 *
 * Step 3 of the volume-regime work. Run sql/volume_regime.sql first; these
 * all read v2_volume_regime and v2_signal_enriched.
 *
 * Why RPCs at all, when the views already exist: the browser holds no Supabase
 * key by design (js/config.js:10-15). It calls /api/rpc/<fn> same-origin and
 * worker.js rejects anything not in its ALLOWED set. A view is not reachable
 * from the client at all - only a function is, and only once its name is added
 * to ALLOWED in worker.js. Four names, listed at the bottom of this file.
 *
 * They take p_strategy and resolve it to a symbol the same way
 * sql/v2_pin_series_by_strategy.sql does, so the strategy selector drives this
 * tab like every other.
 *
 * One asymmetry to know about: v2_signal_log is SPY-only - it has no symbol
 * column - so v2_vol_regime_perf_by_strategy returns zero rows for QQQ. That
 * is deliberate, and the tab shows a banner rather than an empty table that
 * would read as "no trades won". The other three RPCs work for both symbols.
 *
 * All four are SECURITY DEFINER and all four are revoked from anon. See the
 * note at the foot of sql/v2_pin_series_by_strategy.sql for why that revoke is
 * load-bearing rather than belt-and-braces.
 */


/* --------------------------------------------------------------------------
   (a) Daily profile - average share of a day's volume per 30-minute bucket
   --------------------------------------------------------------------------
   Clean days only: a frozen feed would drag whichever buckets it spans toward
   zero and bend the whole curve. Shares are computed per day and then
   averaged, not summed-then-divided, so one very heavy session cannot
   dominate the shape. */

CREATE OR REPLACE FUNCTION public.v2_vol_regime_profile_by_strategy(
  p_strategy text DEFAULT 'two_tier_divergence_spy'
)
RETURNS TABLE(
  bucket_start time without time zone,
  bucket_label text,
  avg_pct      numeric,
  days_n       integer
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH sym AS (
    SELECT coalesce((SELECT s.symbol FROM strategies s WHERE s.id = p_strategy), 'SPY') AS symbol
  ),
  bucketed AS (
    SELECT r.ny_date,
           /* Bucket on the bar's INTERVAL START, not its stamp. Bars are
              stamped end-of-interval, so the 10:00 bar covers 09:55-10:00 and
              belongs with the opening half hour. Flooring the stamp instead
              put it in the 10:00 bucket, which left the first bucket holding
              5 bars, every middle bucket 6, and a spurious 1-bar 16:00 bucket
              reading 0.76% - an opening that looked lighter than it was and a
              close that looked like a collapse. Subtracting one bar width
              gives 13 buckets of 6 bars each. */
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
  )
  SELECT bucket_start,
         to_char(bucket_start, 'HH24:MI') AS bucket_label,
         round(avg(pct), 2)               AS avg_pct,
         count(*)::integer                AS days_n
  FROM shares
  GROUP BY bucket_start
  ORDER BY bucket_start;
$function$;


/* --------------------------------------------------------------------------
   (b) Performance by regime, plus the n that every number rests on
   --------------------------------------------------------------------------
   n, n_30 and n_60 are returned separately on purpose. They are not the same
   number: a signal late in the session has no +60 bar, and 2026-11-05 has two
   price bars all day. Reporting a win rate against n rather than n_60 would
   quietly overstate how much evidence is behind it.

   min_n_reliable rides along so the tab's warning threshold comes from the
   config table rather than a copy hardcoded in JavaScript that can drift. */

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
  WITH sym AS (
    SELECT coalesce((SELECT s.symbol FROM strategies s WHERE s.id = p_strategy), 'SPY') AS symbol
  ),
  cfg AS (SELECT * FROM v2_vol_regime_config)
  SELECT
    e.vol_regime,
    count(*)::integer      AS n,
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
  FROM v2_signal_enriched e
  CROSS JOIN cfg
  /* SPY-only: v2_signal_log has no symbol, so anything else returns nothing
     and the tab says why. */
  WHERE (SELECT symbol FROM sym) = 'SPY'
  GROUP BY e.vol_regime, cfg.min_n_reliable
  ORDER BY CASE e.vol_regime
             WHEN 'LOW' THEN 1 WHEN 'NORMAL' THEN 2 WHEN 'HIGH' THEN 3
             WHEN 'NO_BASELINE' THEN 4 WHEN 'NO_WINDOW' THEN 5 ELSE 6 END;
$function$;


/* --------------------------------------------------------------------------
   (c) Current status - the latest bar, and the cutoffs it was judged against
   --------------------------------------------------------------------------
   Returns a row even when the day is bad and there is no vratio to show. The
   tab needs to render "no regime: feed frozen" as a first-class state, not as
   an empty panel - on 2026-11-09 that is exactly what it shows, and a blank
   box would read as "nothing wrong".

   stale_min lets the client say how old the reading is. The matview refreshes
   every five minutes, so a couple of bars of lag is normal and only a large
   number means something is wrong.

   market_open rides along because stale_min on its own is useless outside
   trading hours: at 23:00 the last bar is legitimately 428 minutes old, and a
   client warning on stale_min alone would cry stale every evening and all
   weekend. The warning is only meaningful while bars should be arriving.

   DROP first: CREATE OR REPLACE FUNCTION cannot change a function's return
   type, and this gained a column. */

DROP FUNCTION IF EXISTS public.v2_vol_regime_status_by_strategy(text);

CREATE OR REPLACE FUNCTION public.v2_vol_regime_status_by_strategy(
  p_strategy text DEFAULT 'two_tier_divergence_spy'
)
RETURNS TABLE(
  symbol            text,
  ts                timestamp without time zone,
  ny_date           date,
  vol_30m           numeric,
  baseline          numeric,
  baseline_n        integer,
  vratio            numeric,
  regime            text,
  day_quality       text,
  frozen_components text,
  first_bar         time without time zone,
  last_bar          time without time zone,
  stale_min         integer,
  market_open       boolean,
  low_max           numeric,
  normal_max        numeric,
  min_baseline_days integer,
  min_n_reliable    integer
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH sym AS (
    SELECT coalesce((SELECT s.symbol FROM strategies s WHERE s.id = p_strategy), 'SPY') AS symbol
  ),
  latest AS (
    SELECT r.*
    FROM v2_volume_regime r
    WHERE r.symbol = (SELECT symbol FROM sym)
    ORDER BY r.ts DESC
    LIMIT 1
  )
  SELECT
    l.symbol, l.ts, l.ny_date, l.vol_30m, l.baseline, l.baseline_n,
    l.vratio, l.regime, l.day_quality, l.frozen_components,
    l.first_bar, l.last_bar,
    greatest(0, round(extract(epoch FROM
      ((current_timestamp AT TIME ZONE 'America/New_York') - l.ts)) / 60))::integer AS stale_min,
    /* Regular session only, and weekdays only. Holidays are not modelled -
       there is no calendar table here - so a holiday reads as open and the
       client may show one spurious staleness note per holiday. That is the
       cheap failure; the expensive one was warning every night. */
    (   extract(dow  FROM (current_timestamp AT TIME ZONE 'America/New_York')) BETWEEN 1 AND 5
    AND (current_timestamp AT TIME ZONE 'America/New_York')::time >= time '09:30'
    AND (current_timestamp AT TIME ZONE 'America/New_York')::time <= time '16:00'
    ) AS market_open,
    c.low_max, c.normal_max, c.min_baseline_days, c.min_n_reliable
  FROM latest l CROSS JOIN v2_vol_regime_config c;
$function$;


/* --------------------------------------------------------------------------
   (d) Excluded days, with the reason and what each one cost
   --------------------------------------------------------------------------
   signals_lost is the point of this list. "2026-10-16 was excluded" is a
   footnote; "2026-09-08 was excluded and took 11 signals with it" is the
   number that tells you whether the exclusions are quietly doing the work.
   SPY-only, for the same reason as (b) - it is null for other symbols rather
   than 0, so the client can tell "none" from "not applicable". */

CREATE OR REPLACE FUNCTION public.v2_vol_regime_days_by_strategy(
  p_strategy text DEFAULT 'two_tier_divergence_spy'
)
RETURNS TABLE(
  ny_date           date,
  day_quality       text,
  reason_detail     text,
  first_bar         time without time zone,
  last_bar          time without time zone,
  bars              integer,
  signals_lost      integer
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
  )
  SELECT
    d.ny_date,
    d.day_quality,
    CASE d.day_quality
      WHEN 'BAD_FROZEN'    THEN 'feed frozen: ' || coalesce(d.frozen_components, 'unknown')
      WHEN 'BAD_SHORT_END' THEN 'session ended ' || to_char(d.last_bar, 'HH24:MI')
      WHEN 'BAD_LATE_START' THEN 'session started ' || to_char(d.first_bar, 'HH24:MI')
      ELSE d.day_quality
    END AS reason_detail,
    d.first_bar, d.last_bar, d.bars,
    CASE WHEN (SELECT symbol FROM sym) = 'SPY'
         THEN (SELECT count(*)::integer FROM v2_signal_log l
               WHERE l.signal_time::date = d.ny_date)
         ELSE NULL
    END AS signals_lost
  FROM days d
  ORDER BY d.ny_date;
$function$;


/* --------------------------------------------------------------------------
   GRANTS
   --------------------------------------------------------------------------
   service_role only. worker.js authenticates with SUPABASE_SECRET_KEY, which
   is service_role; the browser never holds a key. The revoke runs before the
   grant because CREATE OR REPLACE FUNCTION keeps the privileges already on the
   function, so re-running this file without it would silently leave an old
   anon grant in place. */

REVOKE EXECUTE ON FUNCTION public.v2_vol_regime_profile_by_strategy(text) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.v2_vol_regime_perf_by_strategy(text)    FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.v2_vol_regime_status_by_strategy(text)  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.v2_vol_regime_days_by_strategy(text)    FROM anon, authenticated, public;

GRANT EXECUTE ON FUNCTION public.v2_vol_regime_profile_by_strategy(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.v2_vol_regime_perf_by_strategy(text)    TO service_role;
GRANT EXECUTE ON FUNCTION public.v2_vol_regime_status_by_strategy(text)  TO service_role;
GRANT EXECUTE ON FUNCTION public.v2_vol_regime_days_by_strategy(text)    TO service_role;


/* Add these four to ALLOWED in worker.js or the proxy answers 403:
     v2_vol_regime_profile_by_strategy
     v2_vol_regime_perf_by_strategy
     v2_vol_regime_status_by_strategy
     v2_vol_regime_days_by_strategy
*/
