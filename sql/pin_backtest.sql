/* pin_backtest.sql - does the Pin/Chop detector separate winning alerts from
 * losing ones? Run this before trusting the badge, and re-run it as sessions
 * accumulate. Read-only; safe against production.
 *
 *   psql "$DATABASE_URL" -f sql/pin_backtest.sql
 *
 * The P&L is NOT recomputed here. v2_premium_backtest_by_strategy already
 * prices exactly the trade this asks about - POC strike, next expiry, entry
 * from the premium table a couple of minutes after the signal candle, TP/SL,
 * and the last row before 16:00 as a fallback (its TP_EOD / SL_EOD outcomes).
 * Reimplementing it would be a second engine to keep in step with the one the
 * Performance tab reports from.
 *
 * Each section's preamble is repeated verbatim rather than factored into a
 * view, so any single section can be pasted into a read-only console on its
 * own. Keep the blocks identical if you change the thresholds.
 *
 * Thresholds mirror the constants at the top of js/pin.js:
 *   drift <= 1 strike since 09:55, gap <= 3 points, test tolerance 0.5,
 *   containment tolerance 0.75 (diagnostic only), INTO WALL distance 1.0.
 *
 * Alert universe: v2_signal_log, which is what actually fired. It is SPY-only
 * - section 4 covers QQQ off the graded has_signal candles instead, which is
 * what the dashboard shows for QQQ.
 */

\echo '=== 1. Pin-day classification, one row per session ==='

with s as (
  select trade_date, candle_time_ny, candle_time_ny::time t, price, call_wall, put_wall, impl_move
  from spy_session_view where trade_date >= '2026-10-02'
),
drift as (
  select trade_date,
    max(call_wall) filter (where t >= '09:55') - min(call_wall) filter (where t >= '09:55') cw_drift,
    max(put_wall)  filter (where t >= '09:55') - min(put_wall)  filter (where t >= '09:55') pw_drift,
    -- rule 2, per-candle walls as specified
    bool_or(t >= '09:35' and abs(price - call_wall) <= 0.5) tested_call,
    bool_or(t >= '09:35' and abs(price - put_wall)  <= 0.5) tested_put,
    -- rule 3, diagnostic only: false on 19 of 20 days because the wall gap
    -- (1-3 pts) is narrower than the day's range (2-8 pts)
    max(greatest(price - call_wall, put_wall - price)) max_breach,
    round(max(price) - min(price), 2) day_range,
    max(impl_move) impl_move
  from s group by 1
),
latest as (  -- the walls the card displays: the newest candle's pair
  select distinct on (trade_date) trade_date, call_wall cw, put_wall pw
  from s order by trade_date, candle_time_ny desc
),
flips as (   -- rule 4, diagnostic only: never once below the threshold of 4
  select trade_date, count(*) n from (
    select trade_date, divergence_flow,
           lag(divergence_flow) over (partition by trade_date order by candle_time_ny) prev
    from spy_bucket_log_v2
    where trade_date >= '2026-10-02' and candle_time_ny::time >= '10:00'
  ) z
  where prev is not null and sign(divergence_flow) <> 0 and sign(prev) <> 0
    and sign(divergence_flow) <> sign(prev)
  group by 1
),
pin as (
  select d.trade_date, l.cw, l.pw, (l.cw - l.pw) gap,
    d.cw_drift, d.pw_drift, d.tested_call, d.tested_put,
    round(d.max_breach, 2) max_breach, d.day_range, d.impl_move,
    coalesce(f.n, 0) flips,
    (d.cw_drift <= 1 and d.pw_drift <= 1 and (l.cw - l.pw) <= 3) walls_stable
  from drift d join latest l using (trade_date) left join flips f using (trade_date)
)
select trade_date, cw, pw, gap, cw_drift, pw_drift,
  tested_call, tested_put, max_breach, day_range, impl_move, flips,
  case when walls_stable and tested_call and tested_put then 'PIN CONFIRMED'
       when walls_stable and (tested_call or tested_put) then 'PIN FORMING'
       else 'NO PIN' end status
from pin order by trade_date;


\echo '=== 2. INTO WALL vs AWAY FROM WALL, all SPY alerts ==='

with s as (
  select trade_date, candle_time_ny, price, call_wall, put_wall
  from spy_session_view where trade_date >= '2026-10-02'
),
sig as (
  select signal_time, direction, grade from v2_signal_log
  where signal_time::date >= '2026-10-02'
),
flagged as (
  select g.signal_time, g.direction, g.grade,
    case when g.direction = 'CALL' and abs(v.price - v.call_wall) <= 1.0 then 'INTO WALL'
         when g.direction = 'PUT'  and abs(v.price - v.put_wall)  <= 1.0 then 'INTO WALL'
         else 'AWAY FROM WALL' end flag
  from sig g join s v on v.trade_date = g.signal_time::date and v.candle_time_ny = g.signal_time
),
pnl as (
  select candle_time_ny, direction, pnl, outcome
  from v2_premium_backtest_by_strategy('2026-10-02', '2026-10-29', 'two_tier_divergence_spy',
                                       1.50, 1.00, array['A','B','C','D','F'], 0, 30)
)
select f.flag,
  count(*) alerts, count(p.pnl) priced,
  count(*) filter (where p.pnl > 0) wins,
  count(*) filter (where p.pnl <= 0) losses,
  round(100.0 * count(*) filter (where p.pnl > 0) / nullif(count(p.pnl), 0), 1) win_pct,
  round(avg(p.pnl), 3) avg_pnl, round(sum(p.pnl), 2) total_pnl
from flagged f
left join pnl p on p.candle_time_ny = f.signal_time and p.direction = f.direction
group by 1 order by 1;


\echo '=== 3. The 2x2 that matters: flag x pin status AT SIGNAL TIME. ==='
\echo '    Watch the sample sizes - they are what this question turns on.'

with s as (
  select trade_date, candle_time_ny, candle_time_ny::time t, price, call_wall, put_wall
  from spy_session_view where trade_date >= '2026-10-02'
),
sig as (select signal_time, direction from v2_signal_log where signal_time::date >= '2026-10-02'),
/* Evaluated against the candles that existed when the alert fired, not the
   whole session. Classifying a 10:00 alert by the 16:00 reading would be
   lookahead, and it would flatter the very numbers used to decide whether to
   trust the badge. js/pin.js precomputes the same thing per candle. */
at_signal as (
  select g.signal_time, g.direction,
    max(c.call_wall) filter (where c.t >= '09:55') - min(c.call_wall) filter (where c.t >= '09:55') cw_drift,
    max(c.put_wall)  filter (where c.t >= '09:55') - min(c.put_wall)  filter (where c.t >= '09:55') pw_drift,
    bool_or(c.t >= '09:35' and abs(c.price - c.call_wall) <= 0.5) tested_call,
    bool_or(c.t >= '09:35' and abs(c.price - c.put_wall)  <= 0.5) tested_put,
    (array_agg(c.call_wall order by c.candle_time_ny desc))[1] cw_now,
    (array_agg(c.put_wall  order by c.candle_time_ny desc))[1] pw_now
  from sig g
  join s c on c.trade_date = g.signal_time::date and c.candle_time_ny <= g.signal_time
  group by 1, 2
),
flagged as (
  select a.signal_time, a.direction,
    (a.cw_drift <= 1 and a.pw_drift <= 1 and (a.cw_now - a.pw_now) <= 3
      and (a.tested_call or a.tested_put)) is_pin,
    case when a.direction = 'CALL' and abs(v.price - v.call_wall) <= 1.0 then 'INTO WALL'
         when a.direction = 'PUT'  and abs(v.price - v.put_wall)  <= 1.0 then 'INTO WALL'
         else 'AWAY FROM WALL' end flag
  from at_signal a
  join s v on v.trade_date = a.signal_time::date and v.candle_time_ny = a.signal_time
),
pnl as (
  select candle_time_ny, direction, pnl
  from v2_premium_backtest_by_strategy('2026-10-02', '2026-10-29', 'two_tier_divergence_spy',
                                       1.50, 1.00, array['A','B','C','D','F'], 0, 30)
)
select case when f.is_pin then 'PIN DAY' else 'normal day' end day_type, f.flag,
  count(*) alerts,
  count(*) filter (where p.pnl > 0) wins,
  count(*) filter (where p.pnl <= 0) losses,
  round(100.0 * count(*) filter (where p.pnl > 0) / nullif(count(p.pnl), 0), 1) win_pct,
  round(avg(p.pnl), 3) avg_pnl, round(sum(p.pnl), 2) total_pnl
from flagged f
left join pnl p on p.candle_time_ny = f.signal_time and p.direction = f.direction
group by 1, 2 order by 1, 2;


\echo '=== 3b. Status x flag, full breakdown. The status column is the finding. ==='
\echo '    On the first run, NO PIN alerts did WORSE than PIN CONFIRMED ones -'
\echo '    the opposite of the hypothesis. Nothing here was predicted ahead.'

with s as (
  select trade_date, candle_time_ny, candle_time_ny::time t, price, call_wall, put_wall
  from spy_session_view where trade_date >= '2026-10-02'
),
sig as (select signal_time, direction from v2_signal_log where signal_time::date >= '2026-10-02'),
at_signal as (
  select g.signal_time, g.direction,
    max(c.call_wall) filter (where c.t >= '09:55') - min(c.call_wall) filter (where c.t >= '09:55') cw_drift,
    max(c.put_wall)  filter (where c.t >= '09:55') - min(c.put_wall)  filter (where c.t >= '09:55') pw_drift,
    bool_or(c.t >= '09:35' and abs(c.price - c.call_wall) <= 0.5) tc,
    bool_or(c.t >= '09:35' and abs(c.price - c.put_wall)  <= 0.5) tp,
    (array_agg(c.call_wall order by c.candle_time_ny desc))[1] cw_now,
    (array_agg(c.put_wall  order by c.candle_time_ny desc))[1] pw_now
  from sig g
  join s c on c.trade_date = g.signal_time::date and c.candle_time_ny <= g.signal_time
  group by 1, 2
),
flagged as (
  select a.signal_time, a.direction,
    case when a.cw_drift <= 1 and a.pw_drift <= 1 and (a.cw_now - a.pw_now) <= 3 and a.tc and a.tp
           then 'PIN CONFIRMED'
         when a.cw_drift <= 1 and a.pw_drift <= 1 and (a.cw_now - a.pw_now) <= 3 and (a.tc or a.tp)
           then 'PIN FORMING'
         else 'NO PIN' end status,
    case when a.direction = 'CALL' and abs(v.price - v.call_wall) <= 1.0 then 'INTO WALL'
         when a.direction = 'PUT'  and abs(v.price - v.put_wall)  <= 1.0 then 'INTO WALL'
         else 'AWAY FROM WALL' end flag
  from at_signal a
  join s v on v.trade_date = a.signal_time::date and v.candle_time_ny = a.signal_time
),
pnl as (
  select candle_time_ny, direction, pnl
  from v2_premium_backtest_by_strategy('2026-10-02', '2026-10-29', 'two_tier_divergence_spy',
                                       1.50, 1.00, array['A','B','C','D','F'], 0, 30)
)
select f.status, f.flag, count(*) alerts,
  count(*) filter (where p.pnl > 0) wins,
  round(100.0 * count(*) filter (where p.pnl > 0) / nullif(count(p.pnl), 0), 1) win_pct,
  round(avg(p.pnl), 3) avg_pnl, round(sum(p.pnl), 2) total_pnl
from flagged f
left join pnl p on p.candle_time_ny = f.signal_time and p.direction = f.direction
group by 1, 2 order by 1, 2;


\echo '=== 4. Same 2x2 for QQQ, off graded has_signal candles (no QQQ signal log) ==='

with s as (
  select trade_date, candle_time_ny, candle_time_ny::time t, price, call_wall, put_wall
  from qqq_session_view where trade_date >= '2026-10-02'
),
drift as (
  select trade_date,
    max(call_wall) filter (where t >= '09:55') - min(call_wall) filter (where t >= '09:55') cw_drift,
    max(put_wall)  filter (where t >= '09:55') - min(put_wall)  filter (where t >= '09:55') pw_drift
  from s group by 1
),
latest as (
  select distinct on (trade_date) trade_date, call_wall cw, put_wall pw
  from s order by trade_date, candle_time_ny desc
),
pin as (
  select d.trade_date, (d.cw_drift <= 1 and d.pw_drift <= 1 and (l.cw - l.pw) <= 3) is_pin
  from drift d join latest l using (trade_date)
),
/* QQQ's alert universe is the graded candle, not a signal log. The dashboard
   renders QQQ alerts from exactly these rows. The wall gap is in QQQ points,
   so the 1.0 INTO WALL distance is not necessarily the right scale here -
   one more reason the badge ships off. */
trades as (
  select candle_time_ny, trade_date, direction, pnl
  from v2_premium_backtest_by_strategy('2026-10-02', '2026-10-29', 'two_tier_divergence_qqq',
                                       1.50, 1.00, array['A','B','C','D','F'], 0, 30)
  where has_signal
)
select case when p.is_pin then 'PIN DAY' else 'normal day' end day_type,
  case when t.direction = 'CALL' and abs(v.price - v.call_wall) <= 1.0 then 'INTO WALL'
       when t.direction = 'PUT'  and abs(v.price - v.put_wall)  <= 1.0 then 'INTO WALL'
       else 'AWAY FROM WALL' end flag,
  count(*) alerts,
  count(*) filter (where t.pnl > 0) wins,
  count(*) filter (where t.pnl <= 0) losses,
  round(100.0 * count(*) filter (where t.pnl > 0) / nullif(count(t.pnl), 0), 1) win_pct,
  round(avg(t.pnl), 3) avg_pnl, round(sum(t.pnl), 2) total_pnl
from trades t
join s v on v.trade_date = t.trade_date and v.candle_time_ny = t.candle_time_ny
join pin p on p.trade_date = t.trade_date
group by 1, 2 order by 1, 2;


\echo '=== 5. Threshold sweep. Judge a setting by P&L separation, not day count. ==='

with s as (
  select trade_date, candle_time_ny, candle_time_ny::time t, price, call_wall, put_wall
  from spy_session_view where trade_date >= '2026-10-02'
),
drift as (
  select trade_date,
    max(call_wall) filter (where t >= '09:55') - min(call_wall) filter (where t >= '09:55') cw_drift,
    max(put_wall)  filter (where t >= '09:55') - min(put_wall)  filter (where t >= '09:55') pw_drift,
    max(greatest(price - call_wall, put_wall - price)) max_breach
  from s group by 1
),
latest as (
  select distinct on (trade_date) trade_date, call_wall cw, put_wall pw
  from s order by trade_date, candle_time_ny desc
),
day as (
  select d.trade_date, d.cw_drift, d.pw_drift, d.max_breach, (l.cw - l.pw) gap
  from drift d join latest l using (trade_date)
),
grid as (
  select dm.v drift_max, gm.v gap_max, cm.v contain_tol
  from (values (0), (1), (2)) dm(v),
       (values (2), (3), (4), (5)) gm(v),
       (values (0.75), (1.50), (2.50), (99.0)) cm(v)
),
sig as (select signal_time, direction from v2_signal_log where signal_time::date >= '2026-10-02'),
flagged as (
  select g.signal_time, g.direction, g.signal_time::date d,
    case when g.direction = 'CALL' and abs(v.price - v.call_wall) <= 1.0 then 'INTO WALL'
         when g.direction = 'PUT'  and abs(v.price - v.put_wall)  <= 1.0 then 'INTO WALL'
         else 'AWAY FROM WALL' end flag
  from sig g join s v on v.trade_date = g.signal_time::date and v.candle_time_ny = g.signal_time
),
pnl as (
  select candle_time_ny, direction, pnl
  from v2_premium_backtest_by_strategy('2026-10-02', '2026-10-29', 'two_tier_divergence_spy',
                                       1.50, 1.00, array['A','B','C','D','F'], 0, 30)
),
matched as (
  select g.drift_max, g.gap_max, g.contain_tol, day.trade_date, f.flag, p.pnl,
    (day.cw_drift <= g.drift_max and day.pw_drift <= g.drift_max
     and day.gap <= g.gap_max and day.max_breach <= g.contain_tol) is_pin
  from grid g
  cross join day
  left join flagged f on f.d = day.trade_date
  left join pnl p on p.candle_time_ny = f.signal_time and p.direction = f.direction
)
select drift_max, gap_max, contain_tol,
  count(distinct trade_date) filter (where is_pin) pin_days,
  count(*) filter (where is_pin and flag = 'INTO WALL') into_alerts,
  round(avg(pnl) filter (where is_pin and flag = 'INTO WALL'), 3) into_avg_pnl,
  count(*) filter (where is_pin and flag = 'AWAY FROM WALL') away_alerts,
  round(avg(pnl) filter (where is_pin and flag = 'AWAY FROM WALL'), 3) away_avg_pnl
from matched
group by 1, 2, 3
order by 1, 2, 3;


/* ══════════════════════════════════════════════════════════════════════
 * 6. IS THE GAP LIMIT THE WRONG SHAPE?
 *
 * PIN_GAP_MAX is 3 points, an absolute count tuned on SPY. QQQ moves wider
 * - implied move averaged 6.03 against SPY's 4.01 over October - so the
 * question is whether the limit should be a fraction of the implied move
 * instead, which would be scale-free and let one constant serve both
 * symbols.
 *
 * ANSWER, on 2026-10-02 .. 10-29: no, or at least not on this evidence.
 *
 *   - Judged at the close, the proportional gap changes NOTHING. Pin-day
 *     counts are identical at ratio <= 0.60 and <= 0.80: SPY 3, QQQ 1. The
 *     gap was never the binding constraint.
 *   - The binding constraint is wall DRIFT. QQQ's walls move far more than
 *     SPY's: average spread since 09:55 was 3.79 / 4.00 strikes against
 *     SPY's 2.65 / 2.70, and QQQ fails rule 1 on 18 of 19 sessions on drift
 *     alone. No gap rule can reach that.
 *   - Loosening drift to a mode-share test (each wall sat at its dominant
 *     strike for >= 70% of candles since 09:55) does raise the counts - SPY
 *     3 -> 4, QQQ 1 -> 3 - but the days it adds are QQQ 10-08 and 10-20,
 *     whose ranges were 12.54 and 11.41 points. A pin day with a 12-point
 *     range is a false positive by any reading, so the strict min-max drift
 *     is doing real work and stays.
 *   - At SIGNAL time the proportional gap does differ, because impl_move
 *     decays through the session and the ratio tightens with it. It moves
 *     20 alerts out of PIN CONFIRMED, and those 20 were the weak ones
 *     (30.0% win, -0.279) against the 43 that stay (55.8%, +0.077). But
 *     most of that is time of day, not the rule: ALL afternoon alerts ran
 *     31.3% / -0.200 against the morning's 47.7% / +0.121. Split by half
 *     the rule still edges ahead - morning 51.6% / +0.193 on n=31 against
 *     the absolute rule's 45.7% / +0.078 on n=46 - but on samples that
 *     size, and with win rate and average P&L disagreeing in the
 *     afternoon, that is not a result to retune a constant on.
 *
 * So PIN_GAP_MAX stays absolute. Re-run this as sessions accumulate; the
 * morning split is the number to watch.
 * ══════════════════════════════════════════════════════════════════════ */

\echo '=== 6a. Wall behaviour by symbol: drift, gap, and gap as a share of implied ==='

with raw as (
  select 'SPY' sym, * from v2_pin_series_by_strategy('2026-10-02','2026-10-29','two_tier_divergence_spy')
  union all
  select 'QQQ' sym, * from v2_pin_series_by_strategy('2026-10-02','2026-10-29','two_tier_divergence_qqq')
),
s as (select sym, trade_date, candle_time_ny, candle_time_ny::time t,
             price, call_wall, put_wall, impl_move from raw),
d as (
  select sym, trade_date,
    max(call_wall) filter (where t>='09:55') - min(call_wall) filter (where t>='09:55') cw_drift,
    max(put_wall)  filter (where t>='09:55') - min(put_wall)  filter (where t>='09:55') pw_drift,
    max(impl_move) impl_open
  from s group by 1,2),
l as (select distinct on (sym, trade_date) sym, trade_date, call_wall - put_wall gap
      from s order by sym, trade_date, candle_time_ny desc)
select d.sym, count(*) days,
  round(avg(cw_drift),2) avg_cw_drift, max(cw_drift) max_cw_drift,
  round(avg(pw_drift),2) avg_pw_drift, max(pw_drift) max_pw_drift,
  round(avg(gap),2) avg_gap, max(gap) max_gap,
  round(avg(gap/nullif(impl_open,0)),3) avg_gap_ratio,
  round(avg(impl_open),2) avg_impl
from d join l using (sym, trade_date) group by 1 order by 1;


\echo '=== 6b. Pin-day counts under each candidate rule. Identical for the ratio. ==='

with raw as (
  select 'SPY' sym, * from v2_pin_series_by_strategy('2026-10-02','2026-10-29','two_tier_divergence_spy')
  union all
  select 'QQQ' sym, * from v2_pin_series_by_strategy('2026-10-02','2026-10-29','two_tier_divergence_qqq')
),
s as (select sym, trade_date, candle_time_ny, candle_time_ny::time t,
             price, call_wall, put_wall, impl_move from raw),
-- The dominant strike each wall held since 09:55, and how much of the
-- session it held it for. A min-max spread is blown up by one flicker
-- candle; this is the robust alternative, tested and rejected above.
m as (
  select sym, trade_date,
    mode() within group (order by call_wall) cw_mode,
    mode() within group (order by put_wall)  pw_mode,
    count(*) n
  from s where t >= '09:55' group by 1,2),
d as (
  select s.sym, s.trade_date, cw_mode, pw_mode, cw_mode - pw_mode mode_gap,
    max(call_wall) filter (where t>='09:55') - min(call_wall) filter (where t>='09:55') cw_drift,
    max(put_wall)  filter (where t>='09:55') - min(put_wall)  filter (where t>='09:55') pw_drift,
    round(count(*) filter (where t>='09:55' and call_wall = cw_mode)::numeric / n, 2) cw_share,
    round(count(*) filter (where t>='09:55' and put_wall  = pw_mode)::numeric / n, 2) pw_share,
    bool_or(t>='09:35' and abs(price - call_wall) <= 0.5) tc,
    bool_or(t>='09:35' and abs(price - put_wall ) <= 0.5) tp,
    round(max(price) - min(price), 2) day_range,
    max(impl_move) impl_open
  from s join m using (sym, trade_date) group by 1,2,cw_mode,pw_mode,n),
l as (select distinct on (sym, trade_date) sym, trade_date, call_wall - put_wall gap
      from s order by sym, trade_date, candle_time_ny desc),
j as (select d.*, l.gap from d join l using (sym, trade_date))
select sym, count(*) days,
  count(*) filter (where cw_drift<=1 and pw_drift<=1 and gap<=3 and tc and tp) shipped_rule,
  count(*) filter (where cw_drift<=1 and pw_drift<=1
                     and gap/nullif(impl_open,0)<=0.60 and tc and tp) ratio_60,
  count(*) filter (where cw_drift<=1 and pw_drift<=1
                     and gap/nullif(impl_open,0)<=0.80 and tc and tp) ratio_80,
  count(*) filter (where cw_share>=0.70 and pw_share>=0.70 and mode_gap<=3 and tc and tp) mode_70,
  -- The reason mode_70 is rejected: the range on the days it adds.
  round(max(day_range) filter (where cw_share>=0.70 and pw_share>=0.70 and mode_gap<=3
                                 and tc and tp
                                 and not (cw_drift<=1 and pw_drift<=1 and gap<=3)), 2) added_day_max_range
from j group by 1 order by 1;


\echo '=== 6c. SPY alerts: absolute vs proportional gap, scored AT SIGNAL TIME ==='
\echo '    Split morning/afternoon, because impl_move decays and the ratio'
\echo '    tightens with it - without the split this measures the clock.'

with s as (
  select trade_date, candle_time_ny, candle_time_ny::time t,
         price, call_wall, put_wall, impl_move
  from spy_session_view where trade_date >= '2026-10-02'),
sig as (select signal_time, direction from v2_signal_log
        where signal_time::date >= '2026-10-02'),
at_signal as (
  select g.signal_time, g.direction, g.signal_time::time st,
    max(c.call_wall) filter (where c.t>='09:55')-min(c.call_wall) filter (where c.t>='09:55') cw_drift,
    max(c.put_wall)  filter (where c.t>='09:55')-min(c.put_wall)  filter (where c.t>='09:55') pw_drift,
    bool_or(c.t>='09:35' and abs(c.price-c.call_wall)<=0.5) tc,
    bool_or(c.t>='09:35' and abs(c.price-c.put_wall )<=0.5) tp,
    (array_agg(c.call_wall order by c.candle_time_ny desc))[1] cw_now,
    (array_agg(c.put_wall  order by c.candle_time_ny desc))[1] pw_now,
    (array_agg(c.impl_move order by c.candle_time_ny desc))[1] impl_now
  from sig g join s c
    on c.trade_date = g.signal_time::date and c.candle_time_ny <= g.signal_time
  group by 1,2,3),
f as (
  select a.*,
    (cw_drift<=1 and pw_drift<=1 and (cw_now-pw_now)<=3 and tc and tp) abs_conf,
    (cw_drift<=1 and pw_drift<=1
      and (cw_now-pw_now)/nullif(impl_now,0)<=0.60 and tc and tp) ratio_conf
  from at_signal a),
pnl as (
  select candle_time_ny, direction, pnl
  from v2_premium_backtest_by_strategy('2026-10-02','2026-10-29','two_tier_divergence_spy',
                                       1.50, 1.00, array['A','B','C','D','F'], 0, 30))
select case when st < '12:00' then 'morning' else 'afternoon' end half,
  count(*) all_alerts,
  round(100.0*count(*) filter (where p.pnl>0)/nullif(count(p.pnl),0),1) all_win_pct,
  round(avg(p.pnl),3) all_avg_pnl,
  count(*) filter (where abs_conf) abs_n,
  round(100.0*count(*) filter (where abs_conf and p.pnl>0)
        /nullif(count(p.pnl) filter (where abs_conf),0),1) abs_win_pct,
  round(avg(p.pnl) filter (where abs_conf),3) abs_avg_pnl,
  count(*) filter (where ratio_conf) ratio_n,
  round(100.0*count(*) filter (where ratio_conf and p.pnl>0)
        /nullif(count(p.pnl) filter (where ratio_conf),0),1) ratio_win_pct,
  round(avg(p.pnl) filter (where ratio_conf),3) ratio_avg_pnl
from f left join pnl p
  on p.candle_time_ny = f.signal_time and p.direction = f.direction
group by 1 order by 1;
