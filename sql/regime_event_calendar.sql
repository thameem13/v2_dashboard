/* regime_event_calendar.sql - the event calendar behind the regime tag
   ==========================================================================
   SOURCE, NOT A MIGRATION - but unlike most of sql/, this one HAS been
   applied. See the APPLIED note at the foot.

   Companion to sql/regime_verdict.sql. That file classifies a day by its
   opening VIX1D; this one answers the question VIX1D cannot: was the day's
   volatility about news still ahead, or news already resolved?

   The motivating pair, from the logged data:

     2026-11-17  open 15.92  delivered 0.78   NVDA reports after the close
     2026-11-18  open 18.73  delivered 0.39   NVDA already reported

   Higher expected movement, less actual movement. The difference is not the
   vol level, it is which side of the catalyst the session sat on.

   HAND-SEEDED, NOT SCRAPED. Deliberate. The hard part was never fetching
   dates - it was deciding which events count, and an economic calendar
   pulled wholesale would mark nearly every session as an event day, which
   is the same as marking none. The shortlist lives in rows, so revising it
   is an INSERT or a DELETE rather than a code change and a deploy.
   ========================================================================== */


/* --------------------------------------------------------------------------
   1. v2_market_event - what happened, and when
   --------------------------------------------------------------------------
   occurs_at is NY wall clock with no zone: the market's own clock, which is
   what the session windows below are expressed in. Storing it as timestamptz
   would invite exactly the UTC-rollover class of bug the rest of this
   feature goes out of its way to avoid.

   source is not decoration. These dates are entered by hand and will
   eventually be wrong; recording where each came from is what makes a
   suspect row checkable rather than an article of faith. */

CREATE TABLE IF NOT EXISTS public.v2_market_event (
  id          bigserial PRIMARY KEY,
  occurs_at   timestamp NOT NULL,
  kind        text NOT NULL,
  label       text NOT NULL,
  symbol      text,
  source      text,
  added_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT v2_market_event_kind CHECK (kind IN ('econ', 'earnings')),
  CONSTRAINT v2_market_event_uniq UNIQUE (occurs_at, label)
);


/* --------------------------------------------------------------------------
   2. v2_market_event_coverage - where silence means something
   --------------------------------------------------------------------------
   THE MOST IMPORTANT TABLE IN THIS FILE, and the easiest to leave out.

   Without it, every date the calendar happens not to know about derives to
   CLEAN - "no scheduled catalyst either side" - and that is a positive
   claim. It would then reach the tally as an observation, and a bucket of
   unchecked days would masquerade as a bucket of quiet ones.

   A missing row is ignorance. It is not evidence of quiet.

   So CLEAN is only asserted inside a window somebody has declared complete.
   Outside one, an uneventful date derives to UNSET, which claims nothing and
   renders as "no calendar entry" rather than as a quiet day.

   At the time of writing NO window is declared, because the seeded calendar
   has CPI, FOMC, the jobs report and NVDA but NOT the other mega-cap
   earnings or PCE. Nothing derives to CLEAN yet, and that is correct. */

CREATE TABLE IF NOT EXISTS public.v2_market_event_coverage (
  id            bigserial PRIMARY KEY,
  window_start  date NOT NULL,
  window_end    date NOT NULL,
  note          text,
  added_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT v2_market_event_coverage_order CHECK (window_start <= window_end)
);

COMMENT ON TABLE public.v2_market_event IS
  'Hand-seeded market event calendar driving the regime card event tag. Advisory only.';
COMMENT ON TABLE public.v2_market_event_coverage IS
  'Date ranges whose event calendar is declared complete. Only inside these can a day derive to CLEAN.';


/* --------------------------------------------------------------------------
   3. Seed
   --------------------------------------------------------------------------
   Only dates verified against an official or primary source. Nothing is
   inferred from a pattern: the "first Friday" rule for the jobs report and
   the "last business day" rule for PCE are close enough to be dangerous. A
   wrong event date is worse than a missing one - a missing one derives to
   UNSET and claims nothing, while a wrong one produces a confident wrong
   label that silently pollutes the tally.

   Known gaps, left empty rather than guessed:
     - mega-cap earnings other than NVDA (AAPL, MSFT, GOOGL, AMZN, META, TSLA)
     - PCE
     - the September-data Employment Situation release
   -------------------------------------------------------------------------- */

INSERT INTO public.v2_market_event (occurs_at, kind, label, symbol, source) VALUES
  ('2026-09-11 08:30', 'econ', 'CPI (August data)',    NULL, 'bls.gov release schedule'),
  ('2026-10-14 08:30', 'econ', 'CPI (September data)', NULL, 'bls.gov release schedule'),
  ('2026-11-10 08:30', 'econ', 'CPI (October data)',   NULL, 'bls.gov release schedule'),
  ('2026-09-16 14:00', 'econ', 'FOMC decision + SEP',  NULL, 'Federal Reserve calendar'),
  ('2026-10-28 14:00', 'econ', 'FOMC decision',        NULL, 'Federal Reserve calendar'),
  ('2026-11-06 08:30', 'econ', 'Employment Situation (October data)', NULL, 'bls.gov release schedule'),
  ('2026-11-17 16:20', 'earnings', 'NVIDIA Q3 FY2027', 'NVDA', 'SEC 8-K 000104581026000088')
ON CONFLICT (occurs_at, label) DO NOTHING;


/* --------------------------------------------------------------------------
   4. v2_regime_event_derive - calendar to context
   --------------------------------------------------------------------------
   Windows are defined against the SESSION clock, taken from the trade dates
   actually logged, so weekends and holidays fall out of the data instead of
   being hand-coded:

     POST_EVENT  landed after the previous session's close and before this
                 session's open - the news is out, the open has repriced it
     PRE_EVENT   lands from this session's open to the next session's open -
                 the uncertainty is still ahead of you

   An 08:30 CPI is therefore POST for its own day and PRE for the day before.
   NVDA at 16:20 on the 17th is PRE for the 17th and POST for the 18th -
   exactly the pair that motivated the feature, reproduced without anyone
   tagging anything by hand.

   FOMC at 14:00 is intraday and fits neither description cleanly. It is
   treated as PRE for its own day, on the grounds that what matters to a
   verdict frozen at 09:35 is whether the catalyst is still ahead - and at
   the open it is. That widens the original "after today's close". It is the
   one judgement in this function worth arguing with.

   POST wins when a day is both. A day carrying resolved news and pending
   news is the more cautious of the two readings, and POST is the one that
   downgrades.
   -------------------------------------------------------------------------- */

CREATE OR REPLACE FUNCTION public.v2_regime_event_derive(p_date date)
RETURNS TABLE (context text, detail text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_prev_close timestamp;
  v_open       timestamp;
  v_next_open  timestamp;
  v_next_date  date;
  v_prev_date  date;
  v_post       text;
  v_pre        text;
  v_covered    boolean;
BEGIN
  IF p_date IS NULL THEN RETURN; END IF;

  SELECT max(trade_date) INTO v_prev_date
    FROM public.v2_regime_source WHERE trade_date < p_date;
  SELECT min(trade_date) INTO v_next_date
    FROM public.v2_regime_source WHERE trade_date > p_date;

  v_open       := p_date + time '09:30';
  v_prev_close := COALESCE(v_prev_date, p_date - 1) + time '16:00';
  /* No next session logged means this is the latest day. Fall back to the
     next weekday so tonight's after-close events are still seen. */
  v_next_open  := COALESCE(
    v_next_date,
    CASE extract(dow FROM p_date)
      WHEN 5 THEN p_date + 3
      WHEN 6 THEN p_date + 2
      ELSE p_date + 1
    END
  ) + time '09:30';

  SELECT string_agg(label, '; ' ORDER BY occurs_at) INTO v_post
    FROM public.v2_market_event
   WHERE occurs_at > v_prev_close AND occurs_at < v_open;

  SELECT string_agg(label, '; ' ORDER BY occurs_at) INTO v_pre
    FROM public.v2_market_event
   WHERE occurs_at >= v_open AND occurs_at < v_next_open;

  SELECT EXISTS (
    SELECT 1 FROM public.v2_market_event_coverage c
     WHERE p_date BETWEEN c.window_start AND c.window_end
  ) INTO v_covered;

  IF v_post IS NOT NULL THEN
    RETURN QUERY SELECT 'POST_EVENT'::text, v_post;
  ELSIF v_pre IS NOT NULL THEN
    RETURN QUERY SELECT 'PRE_EVENT'::text, v_pre;
  ELSIF v_covered THEN
    RETURN QUERY SELECT 'CLEAN'::text, 'no scheduled catalyst either side'::text;
  ELSE
    RETURN QUERY SELECT 'UNSET'::text,
      'calendar not confirmed complete for this date'::text;
  END IF;
END;
$fn$;


/* --------------------------------------------------------------------------
   5. Event-aware read RPCs
   --------------------------------------------------------------------------
   NEW NAMES RATHER THAN DROP AND RECREATE.

   v2_regime_card_by_strategy supersedes v2_regime_today_by_strategy, and
   v2_regime_strip_by_strategy supersedes v2_regime_history_by_strategy. Both
   needed extra return columns, which CREATE OR REPLACE cannot do - and
   dropping a function the deployed dashboard is actively polling leaves a
   window where its RPC does not exist, with no way back if the CREATE then
   fails. The superseded pair is left in place and still allowlisted: a
   cached page keeps working, and they are the rollback path.

   v2_regime_tally_by_strategy keeps its name because its signature and
   return columns are unchanged - only the body gains the 'event' grouping -
   so it goes through CREATE OR REPLACE with no window at all.

   The manual tag still wins where set. v2_regime_day.event_context is the
   override, the calendar is the default, and event_source says which is in
   force. Nothing stored is rewritten - derivation happens at read time - so
   correcting a calendar row re-derives every past day with it.

   The function bodies live in the migrations listed at the foot and are not
   duplicated here: a second copy of a 60-line body in a file nothing
   executes is a copy that will drift from the database.
   -------------------------------------------------------------------------- */


/* --------------------------------------------------------------------------
   6. Grants - same posture as the rest of the v2_* surface
   -------------------------------------------------------------------------- */

REVOKE ALL ON FUNCTION public.v2_regime_event_derive(date)                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v2_regime_card_by_strategy(date, text)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v2_regime_strip_by_strategy(date, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.v2_market_event, public.v2_market_event_coverage          FROM anon, authenticated;
ALTER TABLE public.v2_market_event          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v2_market_event_coverage ENABLE ROW LEVEL SECURITY;


/* --------------------------------------------------------------------------
   APPLIED to egsgycizhssexstjrsqi via apply_migration, in order:

     regime_market_event_tables      regime_market_event_seed
     regime_event_derive_fn          regime_event_card_and_strip_fns
     regime_tally_add_event_grouping

   TO EXTEND THE CALENDAR, which is the normal maintenance of this feature:

     INSERT INTO public.v2_market_event (occurs_at, kind, label, symbol, source)
     VALUES ('2026-12-10 08:30', 'econ', 'CPI (November data)', NULL, 'bls.gov');

   TO LET A DATE RANGE DERIVE TO CLEAN, once the calendar is believed
   complete across it:

     INSERT INTO public.v2_market_event_coverage (window_start, window_end, note)
     VALUES ('2026-12-01', '2026-12-31', 'CPI/FOMC/NFP/PCE + top-7 earnings checked');

   Do that second one only when it is true. It is the single assertion in
   this feature that turns absence into evidence.
   -------------------------------------------------------------------------- */
