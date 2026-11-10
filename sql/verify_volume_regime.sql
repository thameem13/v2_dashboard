/* verify_volume_regime - does the regime view reproduce the earlier findings?
 *
 * Read-only. Creates nothing, changes nothing. Safe to run any time.
 *
 * Step 2 of the volume-regime work. The brief was: check the views against the
 * earlier hand analysis, which reported roughly
 *
 *     ~229 clean signals over ~40 days
 *     low-volume third:  about -2 bp at +60 min, about 42% win
 *     high-volume third: about +4 bp at +60 min, about 63% win
 *
 * and if the numbers differ a lot, say why rather than tuning until they match.
 *
 * They do differ, and the why is reproducible. This script prints four
 * variants of the same calculation side by side. Only the baseline rule and
 * the day filter change between them; the volume definition, the 30-minute
 * window and the forward returns are identical throughout.
 *
 *   A  prior clean days only, bad days excluded   <- what v2_volume_regime does
 *   B  same, but terciles instead of 0.80/1.10    <- "third" as the brief says
 *   C  look-ahead baseline, bad days excluded
 *   D  look-ahead baseline, no day filter         <- the earlier analysis
 *
 * Expected output, as of 2026-11-09:
 *
 *   variant  bucket  n    bp_60  win_60
 *   A        LOW     32   -3.1   45%
 *   A        NORMAL  100  +0.9   56%
 *   A        HIGH    47   +0.2   50%
 *   B        bottom  59   -0.9   47%
 *   B        middle  59   -1.3   56%
 *   B        top     59   +2.2   54%
 *   C        bottom  65   -1.4   45%
 *   C        top     65   +2.8   58%
 *   D        bottom  76   -3.7   38%
 *   D        top     76   +4.5   61%
 *
 * Confirmed against the live objects on 2026-11-09.
 *
 * D is the earlier finding, near enough: 228 signals, +4.5 bp and 61% on the
 * top third against the remembered ~229, +4 bp and 63%. So the earlier
 * analysis averaged each time slot over the WHOLE sample including the day
 * being scored, and left the frozen-feed days in. Removing the look-ahead
 * alone (C) takes the top third from +4.5 to +2.8 bp. Removing the bad days as
 * well (A) leaves +0.2 bp. The high-volume edge was mostly the two biases.
 *
 * The low-volume side is the result that survives: -3.1 bp at 45% win, against
 * a remembered -2 bp at 42%. That one is worth keeping an eye on.
 *
 * The signal count also differs and should: the brief expected ~229 over ~40
 * days, and the rules as written flag 10 of 45 days bad rather than the 3 that
 * were known, which leaves 35 clean days and 179 classified signals.
 * sql/volume_regime.sql explains each exclusion.
 *
 * If a future run of this script stops reproducing D, that is not a bug in the
 * script - it means the underlying data changed, and the comparison to the
 * earlier analysis no longer holds.
 */

WITH
/* Variants A and B read the shipped view, so this script is a genuine test of
   what is deployed rather than a parallel reimplementation of it. */
enriched AS (
  SELECT * FROM public.v2_signal_enriched
),

/* ---- A: the shipped rules, fixed cutoffs ------------------------------- */
variant_a AS (
  SELECT 'A  prior-days baseline, bad days out'::text AS variant,
         vol_regime                                   AS bucket,
         count(*)                                     AS n,
         round(avg(bp_60), 1)                         AS bp_60,
         round(100.0 * avg(CASE WHEN bp_60 > 0 THEN 1.0 ELSE 0 END)
               FILTER (WHERE bp_60 IS NOT NULL), 0)   AS win_60
  FROM enriched
  WHERE vol_regime IN ('LOW','NORMAL','HIGH')
  GROUP BY vol_regime
),

/* ---- B: the shipped rules, but cut into thirds -------------------------
   The brief says "third", the config says 0.80/1.10. Those are different
   partitions of the same vratio, so this is the like-for-like comparison. */
ranked_b AS (
  SELECT bp_60, ntile(3) OVER (ORDER BY vratio) AS third
  FROM enriched
  WHERE vratio IS NOT NULL AND bp_60 IS NOT NULL
),
variant_b AS (
  SELECT 'B  prior-days baseline, terciles'::text AS variant,
         CASE third WHEN 1 THEN 'bottom' WHEN 2 THEN 'middle' ELSE 'top' END AS bucket,
         count(*)             AS n,
         round(avg(bp_60), 1) AS bp_60,
         round(100.0 * avg(CASE WHEN bp_60 > 0 THEN 1.0 ELSE 0 END), 0) AS win_60
  FROM ranked_b GROUP BY third
),

/* ---- C and D: the biased baselines, rebuilt from source -----------------
   These cannot come from the view: the view is deliberately incapable of
   producing a look-ahead baseline. Everything below the baseline line is the
   same arithmetic the view uses. */
cfg AS (SELECT * FROM public.v2_vol_regime_config),
bars AS (
  SELECT b.candle_time_ny                       AS ts,
         b.candle_time_ny::date                 AS ny_date,
         b.candle_time_ny::time                 AS tod,
           coalesce(b.calls_otm,0) + coalesce(b.puts_otm,0)
         + coalesce(b.calls_itm,0) + coalesce(b.puts_itm,0)
         + coalesce(b.calls_atm,0) + coalesce(b.puts_atm,0) AS cum_vol
  FROM public.spy_bucket_log_v2 b
  WHERE b.candle_time_ny IS NOT NULL
),
win30 AS (
  SELECT b.ts, b.ny_date, b.tod, b.cum_vol - p.cum_vol AS vol_30m
  FROM bars b JOIN bars p ON p.ny_date = b.ny_date AND p.ts = b.ts - interval '30 minutes'
),
/* Day quality is read back off the view rather than recomputed, so C and D
   cannot drift from A on which days are bad. */
day_q AS (
  SELECT DISTINCT ny_date, day_quality FROM public.spy_volume_regime
),
/* The whole point of C and D: no frame clause, so the partition average spans
   every row including the current day. This is the bug, written deliberately. */
la AS (
  SELECT w.ts, w.ny_date, w.vol_30m, q.day_quality,
         avg(w.vol_30m) FILTER (WHERE q.day_quality = 'CLEAN')
           OVER (PARTITION BY w.tod) AS base_clean,
         avg(w.vol_30m) OVER (PARTITION BY w.tod) AS base_all
  FROM win30 w JOIN day_q q ON q.ny_date = w.ny_date
),
sig AS (
  SELECT e.ts, e.bp_60, la.day_quality,
         e.vol_30m / nullif(la.base_clean, 0) AS vr_c,
         e.vol_30m / nullif(la.base_all,   0) AS vr_d
  FROM enriched e JOIN la ON la.ts = e.ts
  WHERE e.bp_60 IS NOT NULL
),
ranked_c AS (
  SELECT bp_60, ntile(3) OVER (ORDER BY vr_c) AS third
  FROM sig WHERE day_quality = 'CLEAN' AND vr_c IS NOT NULL
),
variant_c AS (
  SELECT 'C  look-ahead baseline, bad days out'::text AS variant,
         CASE third WHEN 1 THEN 'bottom' WHEN 2 THEN 'middle' ELSE 'top' END AS bucket,
         count(*) AS n, round(avg(bp_60), 1) AS bp_60,
         round(100.0 * avg(CASE WHEN bp_60 > 0 THEN 1.0 ELSE 0 END), 0) AS win_60
  FROM ranked_c GROUP BY third
),
ranked_d AS (
  SELECT bp_60, ntile(3) OVER (ORDER BY vr_d) AS third
  FROM sig WHERE vr_d IS NOT NULL
),
variant_d AS (
  SELECT 'D  look-ahead baseline, all days  <- the earlier analysis'::text AS variant,
         CASE third WHEN 1 THEN 'bottom' WHEN 2 THEN 'middle' ELSE 'top' END AS bucket,
         count(*) AS n, round(avg(bp_60), 1) AS bp_60,
         round(100.0 * avg(CASE WHEN bp_60 > 0 THEN 1.0 ELSE 0 END), 0) AS win_60
  FROM ranked_d GROUP BY third
),
/* The UNION is wrapped in a subquery because Postgres will not take an
   expression in ORDER BY on a set operation - only output column names. */
all_variants AS (
  SELECT * FROM variant_a
  UNION ALL SELECT * FROM variant_b
  UNION ALL SELECT * FROM variant_c
  UNION ALL SELECT * FROM variant_d
)
SELECT variant, bucket, n, bp_60, win_60
FROM all_variants
ORDER BY variant,
         CASE bucket WHEN 'LOW' THEN 1 WHEN 'bottom' THEN 1
                     WHEN 'NORMAL' THEN 2 WHEN 'middle' THEN 2 ELSE 3 END;


/* ---------------------------------------------------------------------------
   Supporting counts. Run separately.
   --------------------------------------------------------------------------- */

-- How many days were excluded, and why.
-- SELECT day_quality, count(DISTINCT ny_date) AS days
-- FROM public.spy_volume_regime GROUP BY 1 ORDER BY 1;

-- Where the 250 signals went.
-- SELECT vol_regime, count(*) FROM public.v2_signal_enriched GROUP BY 1 ORDER BY 1;

-- The guard that matters: must return 0.
-- SELECT count(*) FROM public.v2_volume_regime
-- WHERE day_quality <> 'CLEAN' AND baseline IS NOT NULL;
