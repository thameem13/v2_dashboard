/* v2_pin_series_by_strategy — the per-candle series the Pin/Chop detector needs.
 *
 * Why this function exists: no existing RPC exposes call_wall/put_wall per
 * candle. v2_dashboard_by_strategy returns poc/val/vah only, and
 * v2_regime_context_by_strategy has the walls but returns a single latest row.
 * The detector has to see the whole session to know whether the walls held
 * still and whether both of them were tested, so it needs the series.
 *
 * It returns data and computes no rules. The thresholds live as constants at
 * the top of js/pin.js so they can be tuned in one place, and the same
 * evalPin() then serves the live card, the history table and the backtest.
 * Putting the rules in SQL would mean two implementations drifting apart.
 *
 * One range function rather than the _today/_range pair the other RPCs use:
 * the logic is identical for one day and twenty, and rpcPage() already pages
 * past PostgREST's 1000-row cap (20 sessions x 78 candles is about 1560 rows).
 * Call it with p_start = p_end for the live card.
 *
 * Remember to add the name to ALLOWED in worker.js, or the proxy returns 403.
 */
CREATE OR REPLACE FUNCTION public.v2_pin_series_by_strategy(
  p_start    date DEFAULT NULL,
  p_end      date DEFAULT NULL,
  p_strategy text DEFAULT 'two_tier_divergence_spy'
)
RETURNS TABLE(
  trade_date      date,
  candle_time_ny  timestamp without time zone,
  price           numeric,
  call_wall       numeric,
  put_wall        numeric,
  poc             numeric,
  vah             numeric,
  val             numeric,
  impl_move       numeric,
  vix1d           numeric,
  tick            numeric,
  volume          numeric,
  divergence_flow numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
with sym as (
  select coalesce((select s.symbol from strategies s where s.id = p_strategy), 'SPY') as symbol
),
/* Mirrors the fallback in v2_regime_context_by_strategy so the card cannot
   disagree with the flow table about which day "today" is: before the first
   candle of a session lands, both fall back to the last session that has one. */
bounds as (
  select
    coalesce(
      p_start,
      case
        when exists (select 1 from bucket_v2_all b
                     where b.symbol = (select symbol from sym)
                       and b.candle_time_ny::date = (current_timestamp at time zone 'America/New_York')::date)
        then (current_timestamp at time zone 'America/New_York')::date
        else (select max(b.candle_time_ny::date) from bucket_v2_all b where b.symbol = (select symbol from sym))
      end
    ) as d0,
    coalesce(p_end, p_start, (current_timestamp at time zone 'America/New_York')::date) as d1
),
i as (
  select (l.candle_time_ts at time zone 'America/New_York') as ny, l.*
  from intraday_all l
  cross join bounds b
  where l.symbol = (select symbol from sym)
    and (l.candle_time_ts at time zone 'America/New_York')::date between b.d0 and b.d1
),
/* NYSE TICK and VIX1D are market-wide, and only the SPY feed carries them -
   on QQQ rows both columns are null for every candle. Joined in on the NY
   wall-clock minute rather than left blank, because the detector's chop
   diagnostics and the card's context line are the same readings either way. */
mkt as (
  select (l.candle_time_ts at time zone 'America/New_York') as ny, l.tick, l.vix1d
  from intraday_all l
  cross join bounds b
  where l.symbol = 'SPY'
    and (l.candle_time_ts at time zone 'America/New_York')::date between b.d0 and b.d1
),
flow as (
  select bk.candle_time_ny as ny, bk.divergence_flow
  from bucket_v2_all bk
  cross join bounds b
  where bk.symbol = (select symbol from sym)
    and bk.candle_time_ny::date between b.d0 and b.d1
)
select
  i.ny::date      as trade_date,
  i.ny            as candle_time_ny,
  i.price,
  i.call_wall,
  i.put_wall,
  i.poc,
  i.vah,
  i.val,
  i.impl_move,
  coalesce(i.vix1d, m.vix1d) as vix1d,
  coalesce(i.tick,  m.tick)  as tick,
  i.volume,
  f.divergence_flow
from i
left join mkt  m on m.ny = i.ny
left join flow f on f.ny = i.ny
order by i.ny;
$function$;

grant execute on function public.v2_pin_series_by_strategy(date, date, text) to anon, authenticated, service_role;
