/* volume_regime - 30-minute option-volume regime, and the signal log enriched
 * with it.
 *
 * STEP 1 OF 4. Nothing here has been applied. Review first.
 *
 * Why this exists: we want to know whether the v2 signal's edge depends on how
 * busy the option tape is when it fires. No existing object answers that.
 * v2_volume_enriched_* already carries rvol_tod / rvol_tod_z / tod_samples, but
 * that is a per-bar time-of-day rVOL; this is a 30-minute rolling window whose
 * baseline is built from PRIOR CLEAN DAYS ONLY. Different measure, so it gets
 * its own objects rather than overloading the volume tab's.
 *
 * READ THIS BEFORE CHANGING THE BASELINE WINDOW. The earlier hand analysis of
 * this question reported the top volume third at about +4 bp / 63% win at
 * +60 min over ~229 signals. That number came from averaging each time slot
 * over the WHOLE sample, including the day being scored, with the frozen-feed
 * days left in. Reproduced exactly: 228 signals, +4.5 bp, 61%. Take the
 * look-ahead out and it falls to +2.8 bp / 58%; take the bad days out as well
 * and it is +0.2 bp / 47%. The edge was mostly the bias. The
 * "ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING" in baseline_calc is the
 * line that keeps it honest - it is not a stylistic choice.
 *
 * Source is bucket_v2_all, not spy_bucket_log_v2: it already unions SPY and
 * QQQ, carries symbol, and exposes candle_time_ny. The signal side stays
 * SPY-only because v2_signal_log has no symbol column.
 *
 * Remember to add the RPC names to ALLOWED in worker.js, or the proxy
 * returns 403. The views themselves are never called from the browser.
 */


/* --------------------------------------------------------------------------
   1. CONFIG
   -------------------------------------------------------------------------- */

/* A table rather than constants inlined in the view, so retuning a cutoff is
   an UPDATE with no migration and no deploy, and so the dashboard can show the
   cutoffs it is actually using instead of a hardcoded copy that can drift. */
CREATE TABLE IF NOT EXISTS public.v2_vol_regime_config (
  id                 boolean PRIMARY KEY DEFAULT true,
  low_max            numeric NOT NULL DEFAULT 0.80,  -- vratio below this is LOW
  normal_max         numeric NOT NULL DEFAULT 1.10,  -- at or below this NORMAL, above HIGH
  frozen_bars_min    integer NOT NULL DEFAULT 3,     -- consecutive zero-inc bars = frozen component
  day_start_latest   time    NOT NULL DEFAULT '09:45',
  day_end_earliest   time    NOT NULL DEFAULT '15:55',
  min_baseline_days  integer NOT NULL DEFAULT 5,     -- fewer prior clean days, no vratio
  min_n_reliable     integer NOT NULL DEFAULT 100,   -- below this n the tab warns
  CONSTRAINT v2_vol_regime_config_one_row CHECK (id)
);

INSERT INTO public.v2_vol_regime_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;


/* --------------------------------------------------------------------------
   2. v2_volume_regime - one row per deduplicated 5-minute bar, both symbols
   -------------------------------------------------------------------------- */

CREATE OR REPLACE VIEW public.v2_volume_regime AS
WITH cfg AS (
  SELECT * FROM public.v2_vol_regime_config
),

/* The dedupe tie-breaks on candle_time_ny IS NOT NULL FIRST, before the
   largest cumulative total. On 2026-11-09 SPY carries 150 rows with
   candle_time_ts AND candle_time_ny both null and every _inc null - orphans,
   not duplicate bars. Ordering on the cumulative alone could hand the row
   number to an orphan, whose null date then drops it from every downstream
   filter, silently losing a real bar. There are no true duplicate timestamps
   in either symbol today; this clause is what keeps that true if any return. */
dedup AS (
  SELECT b.*,
         row_number() OVER (
           PARTITION BY b.symbol, b.candle_time_ts
           ORDER BY (b.candle_time_ny IS NOT NULL) DESC,
                    ( coalesce(b.calls_otm,0) + coalesce(b.puts_otm,0)
                    + coalesce(b.calls_itm,0) + coalesce(b.puts_itm,0)
                    + coalesce(b.calls_atm,0) + coalesce(b.puts_atm,0) ) DESC
         ) AS rn
  FROM public.bucket_v2_all b
),

/* Volume is all six buckets: "calls + puts" across OTM, ITM and ATM. */
bars AS (
  SELECT
    d.symbol,
    d.candle_time_ny                        AS ts,
    d.candle_time_ny::date                  AS ny_date,
    d.candle_time_ny::time                  AS tod,
      coalesce(d.calls_otm,0) + coalesce(d.puts_otm,0)
    + coalesce(d.calls_itm,0) + coalesce(d.puts_itm,0)
    + coalesce(d.calls_atm,0) + coalesce(d.puts_atm,0) AS cum_vol,
      coalesce(d.calls_otm_inc,0) + coalesce(d.puts_otm_inc,0)
    + coalesce(d.calls_itm_inc,0) + coalesce(d.puts_itm_inc,0)
    + coalesce(d.calls_atm_inc,0) + coalesce(d.puts_atm_inc,0) AS tot_inc,
    d.calls_otm_inc, d.puts_otm_inc,
    d.calls_itm_inc, d.puts_itm_inc,
    d.calls_atm_inc, d.puts_atm_inc
  FROM dedup d
  WHERE d.rn = 1
    AND d.candle_time_ny IS NOT NULL
),

/* -- day quality ----------------------------------------------------------
   A component is frozen when its increment is 0 while the bar as a whole is
   still growing - the table already stores the increments, so no differencing
   is needed. The two row_number()s make the classic gaps-and-islands group id:
   within one component, consecutive frozen bars share a constant difference. */
comp AS (
  SELECT b.symbol, b.ny_date, b.ts, b.tot_inc, v.comp, v.inc
  FROM bars b
  CROSS JOIN LATERAL (VALUES
    ('calls_otm', b.calls_otm_inc), ('puts_otm', b.puts_otm_inc),
    ('calls_itm', b.calls_itm_inc), ('puts_itm', b.puts_itm_inc),
    ('calls_atm', b.calls_atm_inc), ('puts_atm', b.puts_atm_inc)
  ) AS v(comp, inc)
),
comp_flagged AS (
  SELECT symbol, ny_date, comp, ts,
         (coalesce(inc,0) = 0 AND tot_inc > 0) AS frozen,
         row_number() OVER (PARTITION BY symbol, ny_date, comp ORDER BY ts)
       - row_number() OVER (PARTITION BY symbol, ny_date, comp,
                            (coalesce(inc,0) = 0 AND tot_inc > 0) ORDER BY ts) AS island
  FROM comp
),
frozen_runs AS (
  SELECT symbol, ny_date, comp, count(*) AS run_len
  FROM comp_flagged
  WHERE frozen
  GROUP BY symbol, ny_date, comp, island
),
frozen_days AS (
  SELECT r.symbol, r.ny_date,
         max(r.run_len) AS max_frozen_run,
         string_agg(DISTINCT r.comp, ', ') AS frozen_components
  FROM frozen_runs r CROSS JOIN cfg
  WHERE r.run_len >= cfg.frozen_bars_min
  GROUP BY r.symbol, r.ny_date
),
day_bounds AS (
  SELECT symbol, ny_date, min(tod) AS first_bar, max(tod) AS last_bar, count(*) AS bar_count
  FROM bars GROUP BY symbol, ny_date
),
day_quality AS (
  SELECT db.symbol, db.ny_date, db.first_bar, db.last_bar, db.bar_count,
         fd.max_frozen_run, fd.frozen_components,
         CASE
           WHEN fd.ny_date IS NOT NULL              THEN 'BAD_FROZEN'
           WHEN db.last_bar  < cfg.day_end_earliest THEN 'BAD_SHORT_END'
           WHEN db.first_bar > cfg.day_start_latest THEN 'BAD_LATE_START'
           ELSE 'CLEAN'
         END AS day_quality
  FROM day_bounds db
  CROSS JOIN cfg
  LEFT JOIN frozen_days fd ON fd.symbol = db.symbol AND fd.ny_date = db.ny_date
),

/* -- the 30-minute window -------------------------------------------------
   The self-join is the rule "only if both bars exist exactly 30 minutes apart
   on the same NY date". Where a bar is missing - there are 22 such intraday
   gaps - no row is produced, rather than a window silently spanning 35 or 40
   minutes and reading as a volume surge. */
win30 AS (
  SELECT b.symbol, b.ts, b.ny_date, b.tod, b.cum_vol - p.cum_vol AS vol_30m
  FROM bars b
  JOIN bars p
    ON  p.symbol  = b.symbol
    AND p.ny_date = b.ny_date
    AND p.ts      = b.ts - interval '30 minutes'
),

/* -- the baseline ---------------------------------------------------------
   Clean days only, and ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING so a
   day can never contribute to its own baseline. See the header. */
baseline_calc AS (
  SELECT w.symbol, w.ts, w.ny_date, w.tod, w.vol_30m,
         avg(w.vol_30m) OVER bl AS baseline,
         count(*)       OVER bl AS baseline_n
  FROM win30 w
  JOIN day_quality q ON q.symbol = w.symbol AND q.ny_date = w.ny_date
  WHERE q.day_quality = 'CLEAN'
  WINDOW bl AS (PARTITION BY w.symbol, w.tod ORDER BY w.ny_date
                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
)

/* Every bar is emitted, not only the clean ones: the signal view needs a bar
   on a bad day in order to label it DATA_BAD, and the status box needs the
   latest bar whatever shape the day is in. day_quality is the discriminator. */
SELECT
  b.symbol,
  b.ts,
  b.ny_date,
  b.tod,
  b.cum_vol,
  w.vol_30m,
  bc.baseline,
  coalesce(bc.baseline_n, 0) AS baseline_n,
  CASE
    WHEN q.day_quality <> 'CLEAN'                          THEN NULL
    WHEN bc.baseline IS NULL OR bc.baseline = 0            THEN NULL
    WHEN coalesce(bc.baseline_n,0) < cfg.min_baseline_days THEN NULL
    ELSE round((w.vol_30m / bc.baseline)::numeric, 4)
  END AS vratio,
  CASE
    WHEN q.day_quality <> 'CLEAN'                            THEN 'DATA_BAD'
    WHEN w.vol_30m IS NULL                                   THEN 'NO_WINDOW'
    WHEN bc.baseline IS NULL OR bc.baseline = 0
      OR coalesce(bc.baseline_n,0) < cfg.min_baseline_days   THEN 'NO_BASELINE'
    WHEN w.vol_30m / bc.baseline <  cfg.low_max              THEN 'LOW'
    WHEN w.vol_30m / bc.baseline <= cfg.normal_max           THEN 'NORMAL'
    ELSE 'HIGH'
  END AS regime,
  q.day_quality,
  q.frozen_components,
  q.first_bar,
  q.last_bar
FROM bars b
CROSS JOIN cfg
JOIN      day_quality   q  ON q.symbol  = b.symbol AND q.ny_date = b.ny_date
LEFT JOIN win30         w  ON w.symbol  = b.symbol AND w.ts      = b.ts
LEFT JOIN baseline_calc bc ON bc.symbol = b.symbol AND bc.ts     = b.ts;


/* The name the spec asks for. One symbol, same columns. */
CREATE OR REPLACE VIEW public.spy_volume_regime AS
  SELECT * FROM public.v2_volume_regime WHERE symbol = 'SPY';


/* --------------------------------------------------------------------------
   3. v2_signal_enriched - the signal log, plus regime and forward returns
   --------------------------------------------------------------------------
   v2_signal_log stores signal_time, direction, grade, atm_strike and nothing
   else - no price, no symbol - so the forward returns are joined from
   spy_intraday_log. All 250 signals land exactly on a 5-minute bar in both the
   bucket log and the price log, so every join here is an equality join.
   Coverage is not total: 249/250 at +30, 243/250 at +60 (2026-11-05 has two
   price bars all day). Those come back NULL, never 0, so a missing bar cannot
   be averaged in as a flat trade. */

CREATE OR REPLACE VIEW public.v2_signal_enriched AS
WITH px AS (
  SELECT (candle_time_ts AT TIME ZONE 'America/New_York') AS ny, price
  FROM public.spy_intraday_log
  WHERE price IS NOT NULL
),
eod AS (
  SELECT DISTINCT ON (ny::date) ny::date AS ny_date, price
  FROM px ORDER BY ny::date, ny DESC
),
s AS (
  SELECT
    l.signal_time                AS ts,
    l.signal_time::date          AS ny_date,
    l.direction,
    l.grade,
    l.atm_strike,
    CASE l.direction WHEN 'CALL' THEN 1 WHEN 'PUT' THEN -1 ELSE NULL END AS sgn,
    p0.price  AS px_0,
    p30.price AS px_30,
    p60.price AS px_60,
    e.price   AS px_eod
  FROM public.v2_signal_log l
  LEFT JOIN px  p0  ON p0.ny  = l.signal_time
  LEFT JOIN px  p30 ON p30.ny = l.signal_time + interval '30 minutes'
  LEFT JOIN px  p60 ON p60.ny = l.signal_time + interval '60 minutes'
  LEFT JOIN eod e   ON e.ny_date = l.signal_time::date
)
SELECT
  s.ts,
  s.ny_date,
  s.direction,
  s.grade,
  s.atm_strike,
  r.vol_30m,
  r.baseline,
  r.baseline_n,
  r.vratio,
  /* A signal on a bad day gets DATA_BAD instead of a regime. NO_BAR covers a
     signal with no matching bucket bar at all - none today, but the column
     should not go null and read as "not yet classified". */
  coalesce(r.regime, 'NO_BAR')      AS vol_regime,
  coalesce(r.day_quality, 'NO_BAR') AS day_quality,
  s.px_0,
  /* Signed: positive means the signal's direction was right. */
  round((s.sgn * (s.px_30  - s.px_0) / nullif(s.px_0, 0) * 10000)::numeric, 2) AS bp_30,
  round((s.sgn * (s.px_60  - s.px_0) / nullif(s.px_0, 0) * 10000)::numeric, 2) AS bp_60,
  round((s.sgn * (s.px_eod - s.px_0) / nullif(s.px_0, 0) * 10000)::numeric, 2) AS bp_eod
FROM s
LEFT JOIN public.spy_volume_regime r ON r.ts = s.ts;


/* --------------------------------------------------------------------------
   4. GRANTS
   --------------------------------------------------------------------------
   Same posture as sql/hotfix_revoke_anon_views.sql: the browser holds no
   Supabase key, worker.js authenticates with SUPABASE_SECRET_KEY, and nothing
   here should be readable by a publishable key. The revoke runs before the
   grant because CREATE OR REPLACE VIEW keeps privileges already on the view,
   so re-running this file without it would leave an old grant in place. */
REVOKE ALL ON public.v2_vol_regime_config FROM anon, authenticated;
REVOKE ALL ON public.v2_volume_regime     FROM anon, authenticated;
REVOKE ALL ON public.spy_volume_regime    FROM anon, authenticated;
REVOKE ALL ON public.v2_signal_enriched   FROM anon, authenticated;

GRANT SELECT ON public.v2_vol_regime_config TO service_role;
GRANT SELECT ON public.v2_volume_regime     TO service_role;
GRANT SELECT ON public.spy_volume_regime    TO service_role;
GRANT SELECT ON public.v2_signal_enriched   TO service_role;
