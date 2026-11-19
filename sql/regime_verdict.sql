/* regime_verdict.sql - "Today's Regime" advisory verdict card
   ==========================================================================
   SOURCE, NOT A MIGRATION. Nothing records which sql/ files have been
   applied. Applying this is a separate act from committing it.

   What this is: one advisory read per session on whether today's opening
   conditions have historically suited the strategy. It is ADVISORY ONLY.
   Nothing here feeds signal generation, grading, or alerting; no view or
   function the signal path reads is touched.

   Three design decisions worth stating before the DDL.

   1. THE OPEN IS FROZEN, THE OUTCOME IS NOT.
      open_vix1d, the band, the verdict and the confidence label are written
      once per trade_date and never rewritten. Everything filled after the
      close (candles_logged .. data_complete) is recomputed on every
      snapshot call. A verdict that silently restated itself as the data
      grew would make the historical strip worthless - the strip's whole job
      is to score what the card actually said at 09:35.

      The confidence label is frozen with the verdict for the same reason,
      even though the sample behind a band grows over time. The strip
      records what was claimed on the day.

   2. THE POST_EVENT DOWNGRADE IS APPLIED AT READ TIME, NOT STORED.
      event_context is tagged by hand, usually after the open. If the
      downgrade were baked into the stored verdict, tagging a day would
      rewrite a frozen verdict. So `verdict` stays the band's verdict, and
      the read functions return `effective_verdict` alongside it. Both are
      visible on the card.

   3. VIX1D IS SPY-ONLY, AND SO IS THIS.
      vix1d and impl_move exist only in spy_intraday_log. Like
      v2_vol_regime_perf_by_strategy, these functions take p_strategy for
      call-site consistency and read the SPY tables regardless. The card
      says so rather than implying a QQQ reading exists.

   A WARNING ABOUT THE INPUTS, which the card surfaces and which should not
   be forgotten here: spy_intraday_log suffers candle loss (2026-11-05
   logged 2 rows for the whole session). vix1d and the opening impl_move
   have nowhere else to come from, so the verdict's two inputs come from the
   lossy table even though every price-derived figure below comes from
   spy_bucket_log_v2. intraday_rows and open_vix1d_captured_ny are stored so
   a thin day is visible rather than implied to be solid.

   Never CURRENT_DATE anywhere in this file. It evaluates in UTC and rolls
   over around 8 PM ET, which would hand the dashboard tomorrow's empty
   verdict during the after-hours session. Every function takes an explicit
   date.
   ========================================================================== */


/* --------------------------------------------------------------------------
   1. v2_regime_config - every threshold, in one row
   --------------------------------------------------------------------------
   A table rather than constants inlined in the functions, matching
   v2_vol_regime_config: retuning a cutoff is an UPDATE with no migration and
   no deploy, and the card can show the cutoffs it is actually using instead
   of a hardcoded copy in JS that can drift.

   The COARSE bands are what the card renders. The FINE bands are what the
   strip tallies. They are deliberately separate: the 48-day sample does not
   distinguish 10-13 from 13-17 on any statistic at any hit cutoff, so the
   card merges them - but collapsing the stored resolution too would mean a
   backfill when that stops being true. Re-splitting the card later is an
   UPDATE to coarse_green_min.

   On the numbers behind these defaults, verified over 48 complete sessions
   (2026-09-08 .. 2026-11-18), deduplicated, candles >= 70:

     fine band   n    median r/i   avg net   efficiency   hit rate
     <10         30   0.664        $2.46     11.0%        23%
     10-13       10   0.678        $3.11     10.4%        50%
     13-17        7   0.780        $8.48     17.2%        43%
     >=17         1   0.389        $3.18      6.0%         0%

   Median r/i and net move rank monotonically with the opening level.
   Efficiency does not quite: 10-13 sits marginally below <10 (10.4 against
   11.0). Hit rate does not either - the ordering of 10-13 against 13-17
   flips at every cutoff tried (0.7 / 0.8 / 0.9 / 1.0), which is why
   hit_threshold is a named value here and not a literal.

   The merged coarse bands separate cleanly, which the fine bands do not:

     verdict      n    median r/i   avg net   efficiency   hit rate
     THIN        30   0.664        $2.46     11.0%        23%
     FAVOURABLE  17   0.780        $5.32     13.2%        47%
     CAUTION      1   0.389        $3.18      6.0%         0%

   The one cut the sample earns is that below 10 is too thin to clear decay.
   The 17 line is the least defensible number in this table: it rests on a
   single session, and 2026-11-16 (15.90) and 2026-11-17 (15.92) sit just
   under it while 2026-11-18 (18.73) sits just over. It is kept because the
   costs are asymmetric - a wrong CAUTION costs a skipped trade, a wrong
   FAVOURABLE costs a loss - not because one day is evidence. */

CREATE TABLE IF NOT EXISTS public.v2_regime_config (
  id                   boolean PRIMARY KEY DEFAULT true,

  /* Coarse bands - what the verdict card renders.
     open < thin_max            -> THIN      (amber)
     thin_max .. caution_min    -> FAVOURABLE(green)
     >= caution_min             -> CAUTION   (red)
     null                       -> NO DATA   (grey) */
  thin_max             numeric NOT NULL DEFAULT 10.0,
  caution_min          numeric NOT NULL DEFAULT 17.0,

  /* Fine bands - stored for the strip's tally and for re-splitting later.
     Only fine_mid_max subdivides the green band today. */
  fine_mid_max         numeric NOT NULL DEFAULT 13.0,

  /* Confidence ladder, on the day count behind the verdict's coarse band. */
  supported_min_days   integer NOT NULL DEFAULT 25,
  provisional_min_days integer NOT NULL DEFAULT 10,

  /* realized_vs_implied at or above this counts the day as delivered.
     Arbitrary, and the band ordering is sensitive to it - a dial, not a fact. */
  hit_threshold        numeric NOT NULL DEFAULT 0.80,

  /* A session needs this many deduplicated bucket candles before its outcome
     is allowed into any statistic. */
  min_candles          integer NOT NULL DEFAULT 70,

  /* The opening vix1d is the first non-null reading of the session. If that
     reading did not arrive until after this time, the card flags it: vix1d
     rose more than 15% intraday on 71 of 81 logged sessions (mean rise to
     session high 40.1%), so a late first reading is an inflated "open" and
     can place the day in the wrong band. */
  open_capture_latest  time    NOT NULL DEFAULT '09:45',

  /* How many sessions the historical strip shows. */
  history_sessions     integer NOT NULL DEFAULT 15,

  CONSTRAINT v2_regime_config_one_row CHECK (id),
  CONSTRAINT v2_regime_config_bands   CHECK (thin_max < fine_mid_max
                                         AND fine_mid_max < caution_min)
);

INSERT INTO public.v2_regime_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;


/* --------------------------------------------------------------------------
   2. v2_regime_day - one row per session
   --------------------------------------------------------------------------
   Keyed on trade_date, so every write is naturally idempotent: the snapshot
   function is an upsert and may be called any number of times a day.

   The open_* / band / verdict / confidence columns are write-once (see the
   header). The outcome columns are recomputed. event_context is the only
   column a human writes. */

CREATE TABLE IF NOT EXISTS public.v2_regime_day (
  trade_date               date PRIMARY KEY,

  /* --- decided at the open, then frozen --- */
  open_vix1d               numeric,
  open_impl_move           numeric,
  /* Which candle the opening vix1d actually came from, NY wall clock, and how
     many intraday rows the session logged in total. Both exist so a thin or
     late feed is visible on the card rather than inferred. */
  open_vix1d_captured_ny   timestamp,
  intraday_rows            integer,
  regime_band              text,      -- coarse: THIN | FAVOURABLE | CAUTION | NO_DATA
  regime_band_fine         text,      -- LT10 | MID_10_13 | MID_13_17 | GTE17 | NONE
  verdict                  text,      -- the band's verdict, never rewritten
  confidence_label         text,      -- as claimed on the day
  band_sample_days         integer,   -- the n the confidence label was read off
  frozen_at                timestamptz DEFAULT now(),

  /* --- tagged by hand, any time --- */
  event_context            text NOT NULL DEFAULT 'UNSET',

  /* --- filled after the close, recomputed on every snapshot --- */
  candles_logged           integer,
  realized_range           numeric,
  path                     numeric,
  net_move                 numeric,
  efficiency_pct           numeric,
  realized_vs_implied      numeric,
  data_complete            boolean,
  scored_at                timestamptz,

  CONSTRAINT v2_regime_day_event_context CHECK
    (event_context IN ('PRE_EVENT', 'POST_EVENT', 'CLEAN', 'UNSET')),
  CONSTRAINT v2_regime_day_verdict CHECK
    (verdict IN ('FAVOURABLE', 'THIN', 'CAUTION', 'NO DATA'))
);

COMMENT ON TABLE public.v2_regime_day IS
  'Advisory per-session regime verdict. Open values frozen; outcome recomputed. Never feeds signal generation.';


/* --------------------------------------------------------------------------
   3. v2_regime_source - the per-session facts, from the right tables
   --------------------------------------------------------------------------
   One row per trade_date. The split of sources is the point:

   - vix1d and the opening impl_move come from spy_intraday_log, which is the
     only place they exist.
   - every price-derived figure comes from spy_bucket_log_v2, deduplicated on
     (trade_date, candle_time_ts).

   The dedupe is not optional. Raw candle counts run 28-142 per session
   (2026-10-29 logs 142, 2026-10-23 logs 107) against 78 real 5-minute bars,
   so a raw count >= 70 admits duplicate-inflated sessions.

   Collapsing them leaves n, mean and median r/i untouched but does move the
   path-derived figures, because a duplicate final timestamp changes which
   candle counts as the session's last: the 10-13 band's average net move
   falls from $4.36 to $3.11 and its efficiency from 14.1% to 10.4%. The
   deduplicated figures are the correct ones, and they are what the table
   above reports.

   realized_range is high-minus-low of a 5-minute SNAPSHOT series, not the
   true session high and low. It understates the real range, consistently
   across every session, so it is comparable day to day but is not a
   true range - hence the column name rather than "high_low".

   Rows with a null trade_date are excluded: spy_bucket_log_v2 carries 45 of
   them, orphans rather than bars. */

CREATE OR REPLACE VIEW public.v2_regime_source AS
WITH buckets AS (
  SELECT DISTINCT ON (trade_date, candle_time_ts)
         trade_date, candle_time_ts, underlying_price
  FROM public.spy_bucket_log_v2
  WHERE trade_date IS NOT NULL
    AND candle_time_ts IS NOT NULL
    AND underlying_price IS NOT NULL
  ORDER BY trade_date, candle_time_ts, id
),
seq AS (
  SELECT trade_date, underlying_price,
         lag(underlying_price) OVER w          AS prev,
         first_value(underlying_price) OVER w  AS first_px,
         last_value(underlying_price) OVER (
           PARTITION BY trade_date ORDER BY candle_time_ts
           ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
         )                                      AS last_px
  FROM buckets
  WINDOW w AS (PARTITION BY trade_date ORDER BY candle_time_ts)
),
price AS (
  SELECT trade_date,
         count(*)                                      AS candles_logged,
         max(underlying_price) - min(underlying_price)  AS realized_range,
         /* Total distance travelled: the denominator of efficiency. */
         coalesce(sum(abs(underlying_price - prev)), 0) AS path,
         abs(max(last_px) - max(first_px))              AS net_move
  FROM seq
  GROUP BY trade_date
),
intra AS (
  SELECT trade_date,
         count(*)                                                      AS intraday_rows,
         (array_agg(vix1d ORDER BY candle_time_ts)
            FILTER (WHERE vix1d IS NOT NULL))[1]                       AS open_vix1d,
         (array_agg(candle_time_ts ORDER BY candle_time_ts)
            FILTER (WHERE vix1d IS NOT NULL))[1]                       AS open_vix1d_ts,
         (array_agg(impl_move ORDER BY candle_time_ts)
            FILTER (WHERE impl_move IS NOT NULL))[1]                   AS open_impl_move,
         /* The live value the card shows beside the open, so the intraday
            drift is visible rather than asserted. */
         (array_agg(vix1d ORDER BY candle_time_ts DESC)
            FILTER (WHERE vix1d IS NOT NULL))[1]                       AS last_vix1d
  FROM public.spy_intraday_log
  WHERE trade_date IS NOT NULL
  GROUP BY trade_date
)
SELECT
  COALESCE(p.trade_date, i.trade_date)                   AS trade_date,
  i.open_vix1d,
  i.last_vix1d,
  i.open_impl_move,
  (i.open_vix1d_ts AT TIME ZONE 'America/New_York')      AS open_vix1d_captured_ny,
  i.intraday_rows,
  p.candles_logged,
  p.realized_range,
  p.path,
  p.net_move,
  CASE WHEN p.path > 0
       THEN round(100 * p.net_move / p.path, 1) END      AS efficiency_pct,
  CASE WHEN i.open_impl_move > 0
       THEN round(p.realized_range / (i.open_impl_move * 2), 3) END
                                                         AS realized_vs_implied
FROM price p
FULL JOIN intra i ON i.trade_date = p.trade_date;

COMMENT ON VIEW public.v2_regime_source IS
  'Per-session regime inputs. Price math from deduplicated spy_bucket_log_v2; vix1d/impl_move from spy_intraday_log.';


/* --------------------------------------------------------------------------
   4. Classification helpers
   -------------------------------------------------------------------------- */

CREATE OR REPLACE FUNCTION public.v2_regime_band(p_open_vix1d numeric)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN p_open_vix1d IS NULL        THEN 'NO_DATA'
           WHEN p_open_vix1d < c.thin_max   THEN 'THIN'
           WHEN p_open_vix1d >= c.caution_min THEN 'CAUTION'
           ELSE 'FAVOURABLE'
         END
  FROM public.v2_regime_config c WHERE c.id;
$$;

CREATE OR REPLACE FUNCTION public.v2_regime_band_fine(p_open_vix1d numeric)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN p_open_vix1d IS NULL          THEN 'NONE'
           WHEN p_open_vix1d < c.thin_max     THEN 'LT10'
           WHEN p_open_vix1d < c.fine_mid_max THEN 'MID_10_13'
           WHEN p_open_vix1d < c.caution_min  THEN 'MID_13_17'
           ELSE 'GTE17'
         END
  FROM public.v2_regime_config c WHERE c.id;
$$;

/* The band's verdict. Distinct from the EFFECTIVE verdict, which applies the
   POST_EVENT downgrade at read time. */
CREATE OR REPLACE FUNCTION public.v2_regime_verdict(p_band text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE p_band
           WHEN 'FAVOURABLE' THEN 'FAVOURABLE'
           WHEN 'THIN'       THEN 'THIN'
           WHEN 'CAUTION'    THEN 'CAUTION'
           ELSE 'NO DATA'
         END;
$$;

/* How many scored, complete sessions sit behind a coarse band. This is the
   number the card must display next to the verdict. */
CREATE OR REPLACE FUNCTION public.v2_regime_band_days(p_band text, p_asof date)
RETURNS integer
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::integer
  FROM public.v2_regime_source s, public.v2_regime_config c
  WHERE c.id
    AND s.trade_date <= p_asof
    AND s.candles_logged >= c.min_candles
    AND s.realized_vs_implied IS NOT NULL
    AND public.v2_regime_band(s.open_vix1d) = p_band;
$$;

CREATE OR REPLACE FUNCTION public.v2_regime_confidence(p_days integer)
RETURNS text
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN p_days IS NULL THEN 'no sample'
           /* 0 is not a small sample, it is no evidence, and
              "hypothesis - 0 days only" reads as the former. */
           WHEN p_days = 0     THEN 'untested - no prior session in this band'
           WHEN p_days >= c.supported_min_days   THEN 'supported'
           WHEN p_days >= c.provisional_min_days THEN 'provisional'
           ELSE 'hypothesis - ' || p_days || ' days only'
         END
  FROM public.v2_regime_config c WHERE c.id;
$$;


/* --------------------------------------------------------------------------
   5. v2_regime_snapshot - the idempotent upsert
   --------------------------------------------------------------------------
   Safe to call repeatedly for the same date. Freezes the open on first
   write; refreshes the outcome columns every time.

   COALESCE on the frozen columns rather than a DO NOTHING on the whole row:
   the row is usually created at 09:35 when there is an open but no outcome,
   and must later gain its outcome without losing its verdict. Where an open
   genuinely was not available at first write (open_vix1d null, verdict
   'NO DATA'), COALESCE lets a later call fill it in - a null was never a
   claim, so filling it rewrites nothing. */

CREATE OR REPLACE FUNCTION public.v2_regime_snapshot(p_date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s     record;
  v_band      text;
  v_fine      text;
  v_days      integer;
BEGIN
  IF p_date IS NULL THEN RETURN; END IF;

  SELECT * INTO s FROM public.v2_regime_source WHERE trade_date = p_date;
  IF NOT FOUND THEN RETURN; END IF;

  v_band := public.v2_regime_band(s.open_vix1d);
  v_fine := public.v2_regime_band_fine(s.open_vix1d);
  /* Scored strictly BEFORE p_date: today's own outcome is not evidence for
     today's verdict, and including it would make the morning's sample count
     differ from the evening's. */
  v_days := CASE WHEN v_band = 'NO_DATA' THEN NULL
                 ELSE public.v2_regime_band_days(v_band, p_date - 1) END;

  INSERT INTO public.v2_regime_day AS d (
    trade_date, open_vix1d, open_impl_move, open_vix1d_captured_ny,
    intraday_rows, regime_band, regime_band_fine, verdict,
    confidence_label, band_sample_days,
    candles_logged, realized_range, path, net_move,
    efficiency_pct, realized_vs_implied, data_complete, scored_at
  )
  VALUES (
    p_date, s.open_vix1d, s.open_impl_move, s.open_vix1d_captured_ny,
    s.intraday_rows, v_band, v_fine, public.v2_regime_verdict(v_band),
    public.v2_regime_confidence(v_days), v_days,
    s.candles_logged, s.realized_range, s.path, s.net_move,
    s.efficiency_pct, s.realized_vs_implied,
    (s.candles_logged >= (SELECT min_candles FROM public.v2_regime_config WHERE id)),
    now()
  )
  ON CONFLICT (trade_date) DO UPDATE SET
    /* frozen - only ever filled in, never overwritten */
    open_vix1d             = COALESCE(d.open_vix1d, EXCLUDED.open_vix1d),
    open_impl_move         = COALESCE(d.open_impl_move, EXCLUDED.open_impl_move),
    open_vix1d_captured_ny = COALESCE(d.open_vix1d_captured_ny, EXCLUDED.open_vix1d_captured_ny),
    regime_band            = CASE WHEN d.regime_band IS NULL OR d.regime_band = 'NO_DATA'
                                  THEN EXCLUDED.regime_band ELSE d.regime_band END,
    regime_band_fine       = CASE WHEN d.regime_band_fine IS NULL OR d.regime_band_fine = 'NONE'
                                  THEN EXCLUDED.regime_band_fine ELSE d.regime_band_fine END,
    verdict                = CASE WHEN d.verdict IS NULL OR d.verdict = 'NO DATA'
                                  THEN EXCLUDED.verdict ELSE d.verdict END,
    confidence_label       = CASE WHEN d.verdict IS NULL OR d.verdict = 'NO DATA'
                                  THEN EXCLUDED.confidence_label ELSE d.confidence_label END,
    band_sample_days       = CASE WHEN d.verdict IS NULL OR d.verdict = 'NO DATA'
                                  THEN EXCLUDED.band_sample_days ELSE d.band_sample_days END,
    /* recomputed every call */
    intraday_rows          = EXCLUDED.intraday_rows,
    candles_logged         = EXCLUDED.candles_logged,
    realized_range         = EXCLUDED.realized_range,
    path                   = EXCLUDED.path,
    net_move               = EXCLUDED.net_move,
    efficiency_pct         = EXCLUDED.efficiency_pct,
    realized_vs_implied    = EXCLUDED.realized_vs_implied,
    data_complete          = EXCLUDED.data_complete,
    scored_at              = now();
END;
$$;


/* --------------------------------------------------------------------------
   6. v2_regime_today_by_strategy - what the card reads
   --------------------------------------------------------------------------
   Snapshots p_date first, so the card is self-maintaining: no cron, and the
   row for today exists from the first morning load. p_strategy is accepted
   for call-site consistency and validated against the registry, but the
   reading is SPY's (see the header).

   Returns the effective verdict alongside the frozen one. A POST_EVENT tag
   downgrades to CAUTION: the day is priced off uncertainty that has already
   resolved, which a bare vol threshold cannot see. 2026-11-17 opened 15.92
   and delivered 0.78 of implied; 2026-11-18 opened HIGHER at 18.73 and
   delivered 0.39. NVDA reported after Tuesday's close. Two of the seven days
   in the original FAVOURABLE band were pre-NVDA, so that band may be reading
   event proximity rather than volatility. */

CREATE OR REPLACE FUNCTION public.v2_regime_today_by_strategy(
  p_date date,
  p_strategy text DEFAULT NULL
)
RETURNS TABLE (
  trade_date              date,
  open_vix1d              numeric,
  live_vix1d              numeric,
  vix1d_drift_pct         numeric,
  open_impl_move          numeric,
  open_vix1d_captured_ny  timestamp,
  open_capture_late       boolean,
  intraday_rows           integer,
  regime_band             text,
  regime_band_fine        text,
  verdict                 text,
  effective_verdict       text,
  downgrade_reason        text,
  confidence_label        text,
  band_sample_days        integer,
  event_context           text,
  candles_logged          integer,
  realized_range          numeric,
  net_move                numeric,
  efficiency_pct          numeric,
  realized_vs_implied     numeric,
  data_complete           boolean,
  hit_threshold           numeric,
  min_candles             integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.v2_regime_snapshot(p_date);

  RETURN QUERY
  SELECT
    d.trade_date,
    d.open_vix1d,
    s.last_vix1d,
    CASE WHEN d.open_vix1d > 0
         THEN round(100 * (s.last_vix1d / d.open_vix1d - 1), 1) END,
    d.open_impl_move,
    d.open_vix1d_captured_ny,
    (d.open_vix1d_captured_ny::time > c.open_capture_latest),
    d.intraday_rows,
    d.regime_band,
    d.regime_band_fine,
    d.verdict,
    CASE WHEN d.event_context = 'POST_EVENT' AND d.verdict <> 'NO DATA'
         THEN 'CAUTION' ELSE d.verdict END,
    CASE WHEN d.event_context = 'POST_EVENT' AND d.verdict <> 'NO DATA'
         THEN 'priced off resolved uncertainty' END,
    d.confidence_label,
    d.band_sample_days,
    d.event_context,
    d.candles_logged,
    d.realized_range,
    d.net_move,
    d.efficiency_pct,
    d.realized_vs_implied,
    d.data_complete,
    c.hit_threshold,
    c.min_candles
  FROM public.v2_regime_day d
  CROSS JOIN public.v2_regime_config c
  LEFT JOIN public.v2_regime_source s ON s.trade_date = d.trade_date
  WHERE c.id AND d.trade_date = p_date;
END;
$$;


/* --------------------------------------------------------------------------
   7. v2_regime_history_by_strategy - the strip
   --------------------------------------------------------------------------
   The last N sessions ending at p_date: what was said, and what the day did.
   `hit` is null rather than false where the session is incomplete or has no
   implied move to measure against - an unscoreable day must not read as a
   miss. */

CREATE OR REPLACE FUNCTION public.v2_regime_history_by_strategy(
  p_date date,
  p_days integer DEFAULT NULL,
  p_strategy text DEFAULT NULL
)
RETURNS TABLE (
  trade_date           date,
  open_vix1d           numeric,
  verdict              text,
  effective_verdict    text,
  event_context        text,
  realized_vs_implied  numeric,
  hit                  boolean,
  data_complete        boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT * FROM (
    SELECT
      d.trade_date,
      d.open_vix1d,
      d.verdict,
      CASE WHEN d.event_context = 'POST_EVENT' AND d.verdict <> 'NO DATA'
           THEN 'CAUTION' ELSE d.verdict END                       AS effective_verdict,
      d.event_context,
      d.realized_vs_implied,
      CASE WHEN d.data_complete AND d.realized_vs_implied IS NOT NULL
           THEN d.realized_vs_implied >= c.hit_threshold END        AS hit,
      d.data_complete
    FROM public.v2_regime_day d
    CROSS JOIN public.v2_regime_config c
    WHERE c.id AND d.trade_date <= p_date
    ORDER BY d.trade_date DESC
    LIMIT COALESCE(p_days, (SELECT history_sessions FROM public.v2_regime_config WHERE id))
  ) t
  ORDER BY trade_date;
$$;


/* --------------------------------------------------------------------------
   8. v2_regime_tally_by_strategy - does the thing work
   --------------------------------------------------------------------------
   Running record per verdict over every scored session, not just the strip's
   window. Both the coarse verdict and the fine band are returned, because
   the coarse FAVOURABLE band is a merge of two fine bands the data could not
   separate - and the only way that decision gets revisited is if this tally
   eventually separates them. */

CREATE OR REPLACE FUNCTION public.v2_regime_tally_by_strategy(
  p_date date,
  p_strategy text DEFAULT NULL
)
RETURNS TABLE (
  grouping_kind  text,
  label          text,
  days           integer,
  hits           integer,
  hit_rate_pct   numeric,
  median_rvi     numeric,
  avg_net_move   numeric,
  avg_efficiency numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH scored AS (
    SELECT d.*, c.hit_threshold
    FROM public.v2_regime_day d
    CROSS JOIN public.v2_regime_config c
    WHERE c.id
      AND d.trade_date <= p_date
      AND d.data_complete
      AND d.realized_vs_implied IS NOT NULL
  )
  SELECT 'verdict'::text, verdict,
         count(*)::integer,
         sum((realized_vs_implied >= hit_threshold)::int)::integer,
         round(100.0 * sum((realized_vs_implied >= hit_threshold)::int) / count(*), 0),
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY realized_vs_implied)::numeric, 3),
         round(avg(net_move), 2),
         round(avg(efficiency_pct), 1)
  FROM scored GROUP BY verdict
  UNION ALL
  SELECT 'fine_band'::text, regime_band_fine,
         count(*)::integer,
         sum((realized_vs_implied >= hit_threshold)::int)::integer,
         round(100.0 * sum((realized_vs_implied >= hit_threshold)::int) / count(*), 0),
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY realized_vs_implied)::numeric, 3),
         round(avg(net_move), 2),
         round(avg(efficiency_pct), 1)
  FROM scored GROUP BY regime_band_fine
  ORDER BY 1, 2;
$$;


/* --------------------------------------------------------------------------
   9. v2_regime_set_event_by_strategy - the ONLY write from the browser
   --------------------------------------------------------------------------
   This is a real change in the dashboard's character: until now it wrote
   nothing at all. The surface is kept as narrow as it can be - one row per
   date, one column, four permitted values, enforced here as well as by the
   table constraint so a bad argument is a clean error rather than a
   constraint violation surfaced through the proxy.

   It cannot touch a verdict, an open, or an outcome. It cannot create a row
   for a date that has no session (the snapshot has to have run), which also
   means it cannot be used to insert arbitrary dates. */

CREATE OR REPLACE FUNCTION public.v2_regime_set_event_by_strategy(
  p_date date,
  p_context text,
  p_strategy text DEFAULT NULL
)
RETURNS TABLE (trade_date date, event_context text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_context IS NULL OR p_context NOT IN ('PRE_EVENT','POST_EVENT','CLEAN','UNSET') THEN
    RAISE EXCEPTION 'event_context must be PRE_EVENT, POST_EVENT, CLEAN or UNSET, got %', p_context
      USING ERRCODE = '22023';
  END IF;
  IF p_date IS NULL THEN
    RAISE EXCEPTION 'p_date is required' USING ERRCODE = '22023';
  END IF;

  PERFORM public.v2_regime_snapshot(p_date);

  UPDATE public.v2_regime_day d
     SET event_context = p_context
   WHERE d.trade_date = p_date;

  RETURN QUERY
    SELECT d.trade_date, d.event_context
    FROM public.v2_regime_day d WHERE d.trade_date = p_date;
END;
$$;


/* --------------------------------------------------------------------------
   10. Grants
   --------------------------------------------------------------------------
   Same posture as the rest of the v2_* surface: no anon or authenticated
   EXECUTE. The Cloudflare Worker holds the secret key and allowlists the
   function names, so the browser reaches these four and nothing else.
   REVOKE first because CREATE FUNCTION grants EXECUTE to PUBLIC by default -
   without this the SECURITY DEFINER functions would be callable by anon. */

REVOKE ALL ON FUNCTION public.v2_regime_snapshot(date)                              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v2_regime_today_by_strategy(date, text)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v2_regime_history_by_strategy(date, integer, text)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v2_regime_tally_by_strategy(date, text)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v2_regime_set_event_by_strategy(date, text, text)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v2_regime_band(numeric)                               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v2_regime_band_fine(numeric)                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v2_regime_verdict(text)                               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v2_regime_band_days(text, date)                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v2_regime_confidence(integer)                         FROM PUBLIC, anon, authenticated;

REVOKE ALL ON public.v2_regime_day    FROM anon, authenticated;
REVOKE ALL ON public.v2_regime_config FROM anon, authenticated;
REVOKE ALL ON public.v2_regime_source FROM anon, authenticated;

ALTER TABLE public.v2_regime_day    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v2_regime_config ENABLE ROW LEVEL SECURITY;


/* --------------------------------------------------------------------------
   11. Backfill
   --------------------------------------------------------------------------
   Snapshots every session the source view knows about, so the historical
   strip and the tally have a record on the first load rather than filling up
   one day at a time.

   Order does not matter. band_sample_days is counted off v2_regime_source,
   not off v2_regime_day, so each session's "as of the day before" sample is
   the same whichever order the rows are written in - which is also what makes
   the backfill safe to re-run. */

DO $backfill$
DECLARE d date;
BEGIN
  FOR d IN SELECT trade_date FROM public.v2_regime_source
           WHERE trade_date IS NOT NULL ORDER BY trade_date
  LOOP
    PERFORM public.v2_regime_snapshot(d);
  END LOOP;
END;
$backfill$;

/* Sessions snapshotted before v2_regime_confidence handled a zero sample were
   labelled "hypothesis - 0 days only", which reads as a small sample rather
   than as no evidence. Frozen labels are not recomputed by the snapshot, so
   they are corrected here. A no-op on a fresh install. */
UPDATE public.v2_regime_day
   SET confidence_label = 'untested - no prior session in this band'
 WHERE band_sample_days = 0;


/* --------------------------------------------------------------------------
   APPLIED. Unlike the other files in sql/, this one has been run against
   the live project (egsgycizhssexstjrsqi) via apply_migration, in these
   migrations:

     regime_verdict_config          regime_verdict_day_table
     regime_verdict_source_view     regime_verdict_classifiers
     regime_verdict_snapshot        regime_verdict_read_fns
     regime_verdict_grants          regime_verdict_backfill
     regime_verdict_confidence_zero regime_verdict_selftest

   regime_verdict_selftest is assertions only and left no state behind: it
   checks that a repeat snapshot changes nothing, that a frozen open survives
   a re-snapshot, that POST_EVENT downgrades the read without rewriting the
   stored verdict, that a bad event_context is rejected with 22023, and that
   an unlogged date cannot be made to create a row. It restores what it
   touches. Worth re-running after any change to section 5.
   -------------------------------------------------------------------------- */
